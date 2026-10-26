# channel 管理

本页描述 QQ 渠道实例的运行时管理：实例管理器（冷启动、失败隔离、替换重启与停机闸门）、管理服务（add/enable 业务流程、`ManagementError` 与停机检查点）、本机管理路由与 HTTP 传输契约、CLI 的命令行为，以及 QQ 凭证在线校验；配置 schema 与热生效范围见 [配置文件](../config.md#config-fields) 与 [热生效范围与写冲突](../config.md#hot-reload-scope)，本机 HTTP 监听与探针判定见 [健康探针](../observability.md#readiness)，安装与运维步骤见 [README](../../README.md)。源码：[`src/management/service.ts`](../../src/management/service.ts)、[`src/management/status.ts`](../../src/management/status.ts)、[`src/management/contracts.ts`](../../src/management/contracts.ts)、[`src/http/server.ts`](../../src/http/server.ts)、[`src/http/routes.ts`](../../src/http/routes.ts)、[`src/channels/manager.ts`](../../src/channels/manager.ts)、[`src/channels/qq/token.ts`](../../src/channels/qq/token.ts)、[`src/cli.ts`](../../src/cli.ts) 与 [`src/runtime.ts`](../../src/runtime.ts)。

<a id="channel-manager"></a>

## 实例管理器

`createChannelManager` 维护两张表：配置实例清单（最近一次保存后的 `channels.qq` 视图，冷启动取自启动加载）与运行中的渠道实例（`appId` → channel 适配器）。启动链由 runtime 在 core 就绪后按启动配置顺序对每个 `enabled` 实例调用 `startInstance`（已在线的实例幂等跳过，不停旧起新——如循环等待期间管理命令已拉起该实例）；单个实例启动失败只影响该实例，其他实例与 core 继续运行，进程不退出。

实例工厂构造失败或 `channel.start()` 直接抛错时，管理器记录 `manual_restart_required`，尝试停止已创建实例以清理可能已完成的 core 注册，并从运行表移除该实例；配置中已启用但未注册的实例由健康表显示为 `blocked`。QQ 渠道在启动 SDK 前先注册到 core；SDK 的后台启动 Promise 拒绝时，渠道记录 `manual_restart_required` 并将已注册实例置为 `blocked`，保留 core 注册与运行表条目，后续通过替换实例重试。连接失败语义与就绪判定分别见 [QQ 连接与生命周期](inbound.md#qq-connection)和[健康探针](../observability.md#readiness)。

`startInstance(appId, appSecret)` 停掉该 `appId` 的旧运行实例（channel `stop()`，含 core 注销）后用新凭证建新实例并启动；因此重复 `add` 与 `enable` 重试都走"停旧 → 起新"的替换语义，同一 `appId` 的管理操作串行执行。实例状态经注入回调从 core 运行快照读取（未注册时按 `connecting`），启动成功后管理服务在一个有界窗口（`CHANNEL_START_SETTLE_MS`，3,000 ms）内轮询实例状态等待离开 `connecting`，使响应能反映 `online` 或 SDK 立即失败后的 `blocked`；超窗仍为 `connecting` 时按 `connecting` 返回。进程停止链调用 `stopAll()` 并行停止全部运行实例，失败逐个记 `state_warning`。

停机闸门由 `beginShutdown()` 设置（幂等）：之后 `startInstance` 与 `ensureOnline` 立即返回 `{ state: 'blocked', startError: 'the gateway is shutting down; the channel instance was not started' }`，不入队、不调用工厂、不停止或启动任何实例；停机前已排队但尚未执行的操作在真正执行时同样放弃，迟到的 `waitForSettled` 直接返回当前观察值（未注册时 `blocked`）。runtime 在停止链中先调用该闸门，再并行等待 `stopAll()` 收尾。

多实例共享全局并发限额（`maxConcurrent` 等）；会话按（渠道实例， 对端）隔离，bindingId 的 `accountId` 段即 `appId`，天然不串（见 [身份键](session-state.md#binding-id)）。

<a id="management-service"></a>

## 管理服务

`createManagementService` 拥有 add/enable 的业务流程，输入是不可信 JSON：形状与业务字段校验只在服务内完成，失败一律抛带稳定 `code` 的 `ManagementError`（[`src/management/contracts.ts`](../../src/management/contracts.ts)），不产生 HTTP 状态码，message 不含 `appSecret`。`getStatus()` 直接委托管理状态投影（[`src/management/status.ts`](../../src/management/status.ts)），与 `/readyz` 共用同一份计算。

`addQQ` 的顺序是：形状校验 → core 状态为 `ready` 检查 → 凭证在线校验（`force: true` 跳过）→ 写配置（漂移检测 + 串行原子写）→ 同步实例清单 → 启动或替换实例 → 等待状态离开 `connecting`。`appId` 已存在时用新 secret 更新该实例并保留原有 `enabled`，重启该实例；新 `appId` 追加 `enabled: true` 实例并启动。`appId` 须与配置文件同规则（`trim` 后非空、≤128 字符、仅 `[A-Za-z0-9-]`），`appSecret` `trim` 后非空且 ≤256 字符；实例启动凭证取保存后文档中该实例的 secret（非请求体原文），并发重复 `add` 同 `appId` 时最终运行实例与最后落盘的凭证一致。凭证校验失败时不写任何配置、不启动实例。

`enableQQ` 的顺序是：形状校验 → core 状态为 `ready` 检查 → 从 ConfigStore 最新配置选择实例（省略 `appId` 时仅当配置中恰好一个实例才合法，否则 400 `app_id_required`；指定但不在配置中时 404 `instance_not_found`）→ 写 `enabled: true` → 同步实例清单 → 对未在线实例立即启动，已在线幂等成功。

启动失败不撤销已保存的配置：管理服务在 `add` 启动失败时返回 `saved: true`、`state: 'blocked'` 与 `detail`（`<脱敏后的启动错误>; the credentials were saved`），`enable` 的 detail 后缀为 `; the config was saved with enabled=true`；HTTP 响应为 200，只含 `ok`、`channel`、`state` 与可选的 `detail`，不暴露内部 `saved` 字段。

停机闸门：`beginShutdown()` 幂等置位后，新请求在入口即抛出 `gateway_stopping`；在途操作在凭证校验返回后、写队列真正执行时（`store.update` 的 mutate 回调内）与启动实例前重新检查，已进入停机则不再写盘、不再调用实例工厂。若配置已保存后才进入停机：保留配置、不启动实例，返回 `saved: true`、当前状态（状态缺失时 `blocked`）与 `detail: 'the gateway is shutting down; the configuration was saved but the instance was not started'`。`settle(timeoutMs)` 有界等待全部在途操作落定，超时返回 `false`。

<a id="admin-routes"></a>

## 管理路由与 HTTP 分层

管理能力分三层，全部由 runtime 组装：传输层 [`src/http/server.ts`](../../src/http/server.ts) 负责监听、路径去查询串、仅对 `POST` 读取并限制 body、解析 JSON、发送响应与关闭连接，不认识管理命令；路由层 [`src/http/routes.ts`](../../src/http/routes.ts) 负责路径/方法分派、`/livez` 与 `/readyz` 响应，并把 `ManagementError` 映射为 HTTP 状态码；业务层 [`src/management/service.ts`](../../src/management/service.ts) 负责输入校验、core 状态、凭证、持久化与实例生效。未命中路由返回 `undefined`，由传输层统一回 404 `{"error":"not found"}`；路由或业务抛出非 `ManagementError` 的异常由传输层记 `state_warning` 后回 500 `internal_error`。

| 路由 | 请求 body | 行为 | 成功响应 |
|---|---|---|---|
| `POST /channels/qq` | `{"appId","appSecret","force"?}` | 形状校验 → core ready 检查 → 凭证校验（`force` 跳过）→ 漂移检测 + 原子写 → 重启/启动实例 | `{"ok":true,"channel":"qq:<appId>","state"}`；启动失败时 `state:"blocked"` 并附 `detail`（凭证已保存） |
| `POST /channels/qq/enable` | `{"appId"?}` | 置配置 `enabled: true`（漂移检测 + 原子写）→ 未在线实例立即启动，已在线幂等成功 | 同上格式 |

传输契约：监听默认只绑定回环地址；管理请求必须是 `POST` 且 `content-type` 含 `application/json`（非 `POST` 或未命中路径按 404；`POST` 但 content-type 非 JSON 按 400 `invalid_request`），body 上限 64 KiB（超限 400 `request body is too large`，读取中断 400 `failed to read request body`，空 body 视为 `{}`，坏 JSON 400 `request body is not valid JSON`）；所有响应 `content-type: application/json`；本期无鉴权。任何响应、日志与错误信息都不回显 `appSecret`。

监听由 runtime 在启动链先绑定、停止链最后关闭；在监听关闭前的停机窗口内，管理写请求得到 503 `gateway_stopping`，探针仍可访问。判定与正文细节见 [健康探针与管理路由](../observability.md#readiness)。

错误码与 HTTP 状态：

| 状态 | code | 触发 | 产生层 |
|---|---|---|---|
| 400 | `invalid_request` | body 非对象、字段缺失/类型错误/超长、未知字段 | 管理服务 |
| 400 | `invalid_request` | 非 JSON content-type、坏 JSON、body 超限、读取中断 | HTTP 传输层 |
| 400 | `app_id_required` | `enable` 省略 `appId` 且配置实例数不是 1 | 管理服务 |
| 404 | `instance_not_found` | `enable` 指定的 `appId` 不在配置中 | 管理服务 |
| 409 | `config_modified_externally` | 写前漂移检测发现配置文件被外部修改 | 管理服务（映射 store 错误） |
| 422 | `credential_validation_failed` | 凭证校验失败；网络不可达时 message 提示可用 `--force` | 管理服务 |
| 503 | `gateway_not_ready` | core 非 `ready`；message 按状态区分：`starting` 提示启动完成后重试，`failed` 提示查 `manual_restart_required` 日志并重启进程，`stopping`/`stopped` 提示正在关机 | 管理服务 |
| 503 | `gateway_stopping` | 停机闸门已关闭管理写入（入口或检查点） | 管理服务 |
| 500 | `config_write_failed` | 配置写回失败，message 经 `redact` 脱敏 | 管理服务 |
| 500 | `internal_error` | 路由或管理服务抛出非 `ManagementError` 异常 | HTTP 传输层 |

成功响应统一为 `{"ok":true,"channel":"qq:<appId>","state":...}`，`state` 是响应时观察到的实例状态，可选 `detail` 说明启动失败或停机中止；内部 `saved` 字段不进入响应。管理动作成功记 `channel_added` / `channel_enabled`（字段 `channelId`、`appId`、`outcome`）。

<a id="credential-check"></a>

## QQ 凭证在线校验

`createQQTokenValidator` 用一次 `POST https://bots.qq.com/app/getAppAccessToken`（body `{"appId","clientSecret"}`，10 s 超时）校验凭证：HTTP 200 且响应含非空 `access_token` 即有效，不建立 WebSocket。失败分两类：`rejected`（非 200、缺 token、响应不可解析，message 含上游状态码与截断的错误正文）与 `network`（不可达/超时，message 提示重试或 `--force`）；两者都映射 422，错误消息不含 `appSecret`。校验器抛出的其他异常同样映射 422，message 经 `redact` 脱敏后包装。

<a id="cli"></a>

## CLI

`dsh-gateway`（`package.json` bin，产物 `dist/cli.js`，可用 `node dist/cli.js ...` 直接运行）是瘦 HTTP 客户端：参数解析 → 缺参交互输入 → 打管理路由 → 按响应输出，不做业务判断、不做离线写配置，无新增依赖。默认端口与管理路径来自 [`src/http/protocol.ts`](../../src/http/protocol.ts)（`DEFAULT_GATEWAY_HTTP_PORT` 为 17,890，`CHANNEL_ADD_PATH` / `CHANNEL_ENABLE_PATH` 为上述两条路由），`--port` 覆盖；连接被拒等网络错误输出 `start the gateway service first` 并以非零码退出。值参数（`--app-id`、`--app-secret`、`--port`）亦接受 `--flag=value` 形式（如 `--app-secret=xxx`、`--port=17890`），值本身以 `--` 开头时只能用该形式。

| 命令 | 参数 | 行为 |
|---|---|---|
| `channel add qq` | `--app-id`、`--app-secret`、`--force`、`--port` | 打 `POST /channels/qq`；缺 `--app-id`/`--app-secret` 时交互输入，secret 提示不回显（`--app-secret` 供脚本场景） |
| `channel enable qq` | `--app-id`、`--port` | 打 `POST /channels/qq/enable` |
| `channel add weixin` / `enable weixin` | — | 直接输出 "not supported yet"，退出码 1，不发请求 |

成功输出 `ok: qq:<appId> is <state>`；响应 `state: "blocked"` 视为明确报错（输出含 `detail` 的错误行，退出码 1）；HTTP 错误输出 `error: <message> [<code>]`，停机窗口内的 503 因此显示为带 `gateway_stopping` 的错误并非零退出。

<a id="known-gaps"></a>

## 已知缺口

- 管理路由本期无鉴权，仅靠绑定回环地址限制为本机访问；同机的任意本地进程都可调用。
- CLI 交互输入的 secret 回显抑制依赖终端模式（readline muted output）；非 TTY 管道输入时会回显或无提示缓冲，脚本场景应使用 `--app-secret`。
- `add` 对已 `disabled` 的实例更新 secret 时仍会启动该实例（配置保留 `enabled: false`），运行态与配置开关不一致，健康表以运行态覆盖；重启后按配置不再启动。
