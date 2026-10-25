# channel 管理

本页描述 QQ 渠道实例的运行时管理：实例管理器（冷启动按实例拉起、失败隔离、替换重启）、本机管理路由的请求/响应契约与错误码、CLI 的命令行为，以及 QQ 凭证在线校验；配置 schema 与热生效范围见 [配置文件](../config.md#config-fields) 与 [热生效范围与写冲突](../config.md#hot-reload-scope)，路由挂载的健康 server 见 [健康探针](../observability.md#readiness)，安装与运维步骤见 [README](../../README.md)。源码：[`src/channels.ts`](../../src/channels.ts)、[`src/admin.ts`](../../src/admin.ts)、[`src/cli.ts`](../../src/cli.ts)、[`src/qq/token.ts`](../../src/qq/token.ts) 与 [`src/index.ts`](../../src/index.ts)。

<a id="channel-manager"></a>

## 实例管理器

`createChannelManager` 维护两张表：配置实例清单（最近一次保存后的 `channels.qq` 视图，冷启动取自启动加载）与运行中的渠道实例（`appId` → channel 适配器）。启动链在 core 就绪后按配置顺序对每个 `enabled` 实例调用 `startInstance`（已在线的实例幂等跳过，不停旧起新——如循环等待期间管理路由已拉起该实例）；单个实例启动失败（注册被拒、工厂抛错、SDK 启动失败）只记 `manual_restart_required` 并继续，失败实例不进运行表——配置里 enabled 且未注册，健康表回落 `blocked`（见 [健康探针](../observability.md#readiness)），其他实例与 core 不受影响，进程不退出。

`startInstance(appId, appSecret)` 停掉该 `appId` 的旧运行实例（channel `stop()`，含 core 注销）后用新凭证建新实例并启动；因此重复 `add` 与 `enable` 重试都走"停旧 → 起新"的替换语义，同一 `appId` 的管理操作串行执行。启动成功后管理路由在一个有界窗口（`CHANNEL_START_SETTLE_MS`，3,000 ms）内轮询健康状态等待离开 `connecting`，使响应能反映 `online` 或 SDK 立即失败后的 `blocked`；超窗仍为 `connecting` 时按 `connecting` 返回。进程停止链并行停止全部运行实例。

多实例共享全局并发限额（`maxConcurrent` 等）；会话按（渠道实例， 对端）隔离，bindingId 的 `accountId` 段即 `appId`，天然不串（见 [身份键](session-state.md#binding-id)）。

<a id="admin-routes"></a>

## 管理路由

管理路由挂在健康 server（`127.0.0.1:17890`）上，仅接受本机连接的 `POST` + `application/json`（其余方法与内容类型分别按 404/400 拒绝，body 上限 64 KiB，超限 400 `request body is too large`、读取中断 400 `failed to read request body`）；本期无鉴权。错误响应统一 `{"error":{"code","message"}}`（message 英文），成功响应统一 `{"ok":true,"channel":"qq:<appId>","state":...}`；任何响应、日志与错误信息都不回显 `appSecret`。网关停止链开始时先摘除管理路由：停止期间到达的管理请求一律 404，不再在关机窗口内完成注册或写配置。

| 路由 | 请求 body | 行为 | 成功响应 |
|---|---|---|---|
| `POST /channels/qq` | `{"appId","appSecret","force"?}` | 形状校验 → core ready 检查 → 凭证校验（`force` 跳过）→ 漂移检测 + 原子写 → 重启/启动实例 | `{"ok":true,"channel":"qq:<appId>","state"}`；启动失败时 `state:"blocked"` 并附 `detail`（凭证已保存） |
| `POST /channels/qq/enable` | `{"appId"?}` | 置配置 `enabled: true`（漂移检测 + 原子写）→ 未在线实例立即启动，已在线幂等成功 | 同上格式 |

`add` 的规则：`appId` 已存在时更新该实例 secret 并保留其原有 `enabled`，重启该实例；新 `appId` 追加 `enabled: true` 实例并启动。`appId` 须满足与配置文件一致的字符集（`trim` 后非空、≤128 字符、仅 `[A-Za-z0-9-]`，即 bindingId 前缀段约束），否则 400 `invalid_request`。实例启动凭证取保存后文档中该实例的 secret（非请求体原文），并发重复 `add` 同 `appId` 时最终运行实例与最后落盘的凭证一致。凭证校验失败时不写任何配置、不启动实例。`enable` 省略 `appId` 时仅当配置中恰好一个实例才合法。

错误码与 HTTP 状态：

| 状态 | code | 触发 |
|---|---|---|
| 400 | `invalid_request` | body 非对象、字段缺失/类型错误/超长、未知字段、非 JSON content-type、坏 JSON、body 超限 |
| 400 | `app_id_required` | `enable` 省略 `appId` 且配置实例数不是 1 |
| 404 | `instance_not_found` | `enable` 指定的 `appId` 不在配置中 |
| 409 | `config_modified_externally` | 写前漂移检测发现配置文件被外部修改 |
| 422 | `credential_validation_failed` | 凭证校验失败；网络不可达时 message 提示可用 `--force` |
| 503 | `gateway_not_ready` | core 非 `ready`；message 按状态区分：`starting` 提示启动完成后重试，`failed` 提示查 `manual_restart_required` 日志并重启进程，`stopping`/`stopped` 提示正在关机 |
| 500 | `internal_error` / `config_write_failed` | 处理器异常 / 配置写回失败 |

管理动作成功记 `channel_added` / `channel_enabled`（字段 `channelId`、`appId`、`outcome`）。

<a id="credential-check"></a>

## QQ 凭证在线校验

`createQQTokenValidator` 用一次 `POST https://bots.qq.com/app/getAppAccessToken`（body `{"appId","clientSecret"}`，10 s 超时）校验凭证：HTTP 200 且响应含非空 `access_token` 即有效，不建立 WebSocket。失败分两类：`rejected`（非 200、缺 token、响应不可解析，message 含上游状态码与截断的错误正文）与 `network`（不可达/超时，message 提示重试或 `--force`）；两者都映射 422，错误消息不含 `appSecret`。

<a id="cli"></a>

## CLI

`dsh-gateway`（`package.json` bin，产物 `dist/cli.js`，可用 `node dist/cli.js ...` 直接运行）是瘦 HTTP 客户端：参数解析 → 缺参交互输入 → 打管理路由 → 按响应输出，不做业务判断、不做离线写配置，无新增依赖。默认端口 17890，`--port` 覆盖；连接被拒等网络错误输出 `start the gateway service first` 并以非零码退出。值参数（`--app-id`、`--app-secret`、`--port`）亦接受 `--flag=value` 形式（如 `--app-secret=xxx`、`--port=17890`），值本身以 `--` 开头时只能用该形式。

| 命令 | 参数 | 行为 |
|---|---|---|
| `channel add qq` | `--app-id`、`--app-secret`、`--force`、`--port` | 打 `POST /channels/qq`；缺 `--app-id`/`--app-secret` 时交互输入，secret 提示不回显（`--app-secret` 供脚本场景） |
| `channel enable qq` | `--app-id`、`--port` | 打 `POST /channels/qq/enable` |
| `channel add weixin` / `enable weixin` | — | 直接输出 "not supported yet"，退出码 1，不发请求 |

成功输出 `ok: qq:<appId> is <state>`；响应 `state: "blocked"` 视为明确报错（输出含 `detail` 的错误行，退出码 1）；HTTP 错误输出 `error: <message> [<code>]`。

<a id="known-gaps"></a>

## 已知缺口

- 管理路由本期无鉴权，仅靠绑定回环地址限制为本机访问；同机的任意本地进程都可调用。
- CLI 交互输入的 secret 回显抑制依赖终端模式（readline muted output）；非 TTY 管道输入时会回显或无提示缓冲，脚本场景应使用 `--app-secret`。
- `add` 对已 `disabled` 的实例更新 secret 时按规格仍会重启该实例（保留 `enabled: false` 的配置值），运行态与配置开关短暂不一致，以健康表实际状态为准。
