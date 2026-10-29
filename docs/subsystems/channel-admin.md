# channel 管理

本页描述 QQ 与微信渠道实例的运行时管理、扫码绑定、本机管理路由和 HTTP 传输契约，以及 QQ 凭证在线校验；配置 schema 与热生效范围见 [配置文件](../config.md#config-fields) 与 [热生效范围与写冲突](../config.md#hot-reload-scope)，本机 HTTP 监听与探针判定见 [健康探针](../observability.md#readiness)，安装与运维步骤见 [README](../../README.md)。源码：[`src/management/service.ts`](../../src/management/service.ts)、[`src/management/binding.ts`](../../src/management/binding.ts)、[`src/management/status.ts`](../../src/management/status.ts)、[`src/http/routes.ts`](../../src/http/routes.ts)、[`src/channels/manager.ts`](../../src/channels/manager.ts)、[`src/channels/weixin/manager.ts`](../../src/channels/weixin/manager.ts)、[`src/channels/weixin/api.ts`](../../src/channels/weixin/api.ts) 与 [`src/runtime.ts`](../../src/runtime.ts)。

<a id="channel-manager"></a>

## 实例管理器

`createChannelManager` 维护两张表：配置实例清单（最近一次保存后的 `channels.qq` 视图，冷启动取自启动加载）与运行中的渠道实例（`appId` → channel 适配器）。启动链由 runtime 在 core 就绪后按启动配置顺序对每个 `enabled` 实例调用 `startInstance`（已在线的实例幂等跳过，不停旧起新——如循环等待期间管理请求已拉起该实例）；单个实例启动失败只影响该实例，其他实例与 core 继续运行，进程不退出。

实例工厂构造失败或 `channel.start()` 直接抛错时，管理器记录 `manual_restart_required`，尝试停止已创建实例以清理可能已完成的 core 注册，并从运行表移除该实例；配置中已启用但未注册的实例由健康表显示为 `blocked`。QQ 渠道在启动 SDK 前先注册到 core；SDK 的后台启动 Promise 拒绝时，渠道记录 `manual_restart_required` 并将已注册实例置为 `blocked`，保留 core 注册与运行表条目，后续通过替换实例重试。连接失败语义与就绪判定分别见 [QQ 连接与生命周期](inbound.md#qq-connection)和[健康探针](../observability.md#readiness)。

`startInstance(appId, appSecret)` 停掉该 `appId` 的旧运行实例（channel `stop()`，含 core 注销）后用新凭证建新实例并启动；重复 `add` 与 `enable` 重试都走"停旧 → 起新"的替换语义，同一 `appId` 的管理操作串行执行。实例状态经注入回调从 core 运行快照读取（未注册时按 `connecting`），启动成功后管理服务在一个有界窗口（`CHANNEL_START_SETTLE_MS`，3,000 ms）内轮询实例状态等待离开 `connecting`，使响应能反映 `online` 或 SDK 立即失败后的 `blocked`；超窗仍为 `connecting` 时按 `connecting` 返回。进程停止链调用 `stopAll()` 并行停止全部运行实例，失败逐个记 `state_warning`。

停机闸门由 `beginShutdown()` 设置（幂等）：之后 `startInstance` 与 `ensureOnline` 立即返回 `{ state: 'blocked', startError: 'the gateway is shutting down; the channel instance was not started' }`，不入队、不调用工厂、不停止或启动任何实例；停机前已排队但尚未执行的操作在真正执行时同样放弃，迟到的 `waitForSettled` 直接返回当前观察值（未注册时 `blocked`）。runtime 在停止链中先调用该闸门，再并行等待 `stopAll()` 收尾。

多实例共享全局并发限额（`maxConcurrent` 等）；会话按（渠道实例， 对端）隔离，bindingId 的 `accountId` 段即 `appId`，天然不串（见 [身份键](session-state.md#binding-id)）。

<a id="management-service"></a>

## 管理服务

`createManagementService` 拥有 add/enable 与扫码绑定的业务入口，输入是不可信 JSON：形状与业务字段校验在服务内完成，失败抛带稳定 `code` 的 `ManagementError`（[`src/management/contracts.ts`](../../src/management/contracts.ts)），不产生 HTTP 状态码；凭证校验错误消息的脱敏边界见 [QQ 凭证在线校验](#credential-check)。`getStatus()` 直接委托管理状态投影（[`src/management/status.ts`](../../src/management/status.ts)），与 `/readyz` 共用同一份计算。

`addQQ` 的顺序是：形状校验 → core 状态为 `ready` 检查 → 凭证在线校验（`force: true` 跳过）→ 写配置（漂移检测 + 串行原子写）→ 同步实例清单 → 启动或替换实例 → 等待状态离开 `connecting`。`appId` 已存在时用新 secret 更新该实例并保留原有 `enabled`，无论配置开关值都重启该实例；新 `appId` 追加 `enabled: true` 实例并启动。`appId` 须与配置文件同规则（`trim` 后非空、≤128 字符、仅 `[A-Za-z0-9-]`），`appSecret` `trim` 后非空且 ≤256 字符；实例启动凭证取保存后文档中该实例的 secret（非请求体原文），并发重复 `add` 同 `appId` 时最终运行实例与最后落盘的凭证一致。凭证校验失败时不写任何配置、不启动实例。

`enableQQ` 的顺序是：形状校验 → core 状态为 `ready` 检查 → 从 ConfigStore 最新配置选择实例（省略 `appId` 时仅当配置中恰好一个实例才合法，否则 400 `app_id_required`；指定但不在配置中时 404 `instance_not_found`）→ 写 `enabled: true` → 同步实例清单 → 对未在线实例立即启动，已在线幂等成功。

`bindQQStart` 与 `bindQQWait` 是扫码绑定的两个入口：启动入口做停机闸门与 core 检查后委托绑定会话状态机，等待入口直接等待终态；扫码成功后的落盘与启动复用 `applyCredentialsInternal`，跳过凭证在线校验（见[扫码绑定](#qr-bind)）。

启动失败不撤销已保存的配置：管理服务在 `add` 启动失败时返回 `saved: true`、`state: 'blocked'` 与 `detail`（`<脱敏后的启动错误>; the credentials were saved`），`enable` 的 detail 后缀为 `; the config was saved with enabled=true`；HTTP 响应为 200，只含 `ok`、`channel`、`state` 与可选的 `detail`，不暴露内部 `saved` 字段。

停机闸门：`beginShutdown()` 幂等置位后，新的管理写请求（add/enable 与扫码绑定启动）在入口即抛出 `gateway_stopping`；在途操作在凭证校验返回后、写队列真正执行时（`store.update` 的 mutate 回调内）与启动实例前重新检查，已进入停机则不再写盘、不再调用实例工厂。若配置已保存后才进入停机（add/enable）：保留配置、不启动实例，返回 `saved: true`、当前状态（状态缺失时 `blocked`）与 `detail: 'the gateway is shutting down; the configuration was saved but the instance was not started'`（扫码绑定的停机语义见[扫码绑定](#qr-bind)）。`settle(timeoutMs)` 有界等待全部在途操作落定，超时返回 `false`。`beginShutdown()` 同时作废进行中的扫码绑定会话，挂起的 `GET /channels/qq/bind` 以 `gateway_stopping` 收尾（等待入口本身不检查停机闸门，只在会话被作废时结束）。

<a id="admin-routes"></a>

## 管理路由与 HTTP 分层

管理能力分三层，全部由 runtime 组装：传输层 [`src/http/server.ts`](../../src/http/server.ts) 负责监听、路径去查询串、仅对 `POST` 读取并限制 body、解析 JSON、发送响应与关闭连接，不认识管理业务；路由层 [`src/http/routes.ts`](../../src/http/routes.ts) 负责路径/方法分派、`/livez` 与 `/readyz` 响应，并把 `ManagementError` 映射为 HTTP 状态码；业务层 [`src/management/service.ts`](../../src/management/service.ts) 负责输入校验、core 状态、凭证、持久化与实例生效。未命中路由返回 `undefined`，由传输层统一回 404 `{"error":"not found"}`；路由或业务抛出非 `ManagementError` 的异常由传输层记 `state_warning` 后回 500 `internal_error`。

| 路由 | 请求 body | 行为 | 成功响应 |
|---|---|---|---|
| `POST /channels/qq` | `{"appId","appSecret","force"?}` | 形状校验 → core ready 检查 → 凭证校验（`force` 跳过）→ 漂移检测 + 原子写 → 重启或启动实例 | `{"ok":true,"channel":"qq:<appId>","state"}`；启动失败时 `state:"blocked"` 并附 `detail`（凭证已保存） |
| `POST /channels/qq/enable` | `{"appId"?}` | 置配置 `enabled: true`（漂移检测 + 原子写）→ 未在线实例立即启动，已在线幂等成功 | 同上格式 |
| `POST /channels/qq/bind` | 内容忽略；`POST` 仍须带 JSON content-type | 停机闸门 → core `ready` 检查 → 启动或复用唯一绑定会话，等二维码 URL 就绪 | `{"ok":true,"url":"https://q.qq.com/qqbot/openclaw/connect.html?..."}` |
| `GET /channels/qq/bind` | 无 | 挂起等待绑定会话终态（无响应期限）：成功落盘并启动或替换实例，过期、失败或停机按错误码返回 | 同 `POST /channels/qq`（`state` 为扫码结果快照，可带 `detail`） |
| `POST /channels/weixin/bind` | 内容忽略 | 启动或复用微信扫码会话，返回二维码内容 URL | `{"ok":true,"url":...}` |
| `GET /channels/weixin/bind` | 无 | 等待绑定终态，成功后保存凭证并启动已启用实例 | `{"ok":true,"channel":"weixin:<botId>","state":...}` |
| `POST /channels/weixin/enable` | `{"botId"?}` | 启用指定实例；省略 ID 仅允许恰好一个实例 | 同微信绑定成功响应 |

传输契约：监听默认只绑定回环地址；所有 `POST` 在路由匹配前检查 `content-type` 并读取、解析 body，`content-type` 需含 `application/json`，否则返回 400 `invalid_request`；body 上限 64 KiB（超限 400，读取中断 400，空 body 视为 `{}`，坏 JSON 400）。通过传输校验后，未命中路径或不支持的方法返回 404；`GET` 不读取 body。扫码绑定 `POST` 的 body 内容被忽略，但仍受上述传输校验约束；所有响应 `content-type: application/json`；本期无鉴权。

监听由 runtime 在启动链先绑定、停止链最后关闭；在监听关闭前的停机窗口内，管理写请求得到 503 `gateway_stopping`，进行中的扫码绑定等待同样以 503 `gateway_stopping` 收尾，探针仍可访问。判定与正文细节见 [健康探针与管理路由](../observability.md#readiness)，调用示例见 [README](../../README.md#channel-admin-api)。

错误码与 HTTP 状态：

| 状态 | code | 触发 | 产生层 |
|---|---|---|---|
| 400 | `invalid_request` | body 非对象、字段缺失/类型错误/超长、未知字段 | 管理服务 |
| 400 | `invalid_request` | 非 JSON content-type、坏 JSON、body 超限、读取中断 | HTTP 传输层 |
| 400 | `app_id_required` | `enable` 省略 `appId` 且配置实例数不是 1 | 管理服务 |
| 404 | `instance_not_found` | `enable` 指定的 `appId` 不在配置中 | 管理服务 |
| 409 | `config_modified_externally` | 写前漂移检测发现配置文件被外部修改（add/enable 或扫码绑定落盘） | 管理服务（映射 store 错误） |
| 409 | `bind_expired` | 二维码过期，绑定会话终止；重新 `POST /channels/qq/bind` 换码。启动入口也可能返回（二维码在 URL 就绪前过期），等待入口在过期时返回 | 绑定服务（启动或等待接口） |
| 409 | `bind_not_started` | 未启动过绑定会话就调用 `GET /channels/qq/bind` | 绑定服务（等待接口） |
| 422 | `credential_validation_failed` | 凭证校验失败；网络不可达时 message 提示可在请求体传 `force: true` | 管理服务 |
| 500 | `config_write_failed` | 配置写回失败（含扫码绑定落盘），message 经 `redact` 脱敏 | 管理服务 |
| 500 | `internal_error` | 路由或管理服务抛出非 `ManagementError` 异常 | HTTP 传输层 |
| 502 | `bind_failed` | 扫码上游失败：创建绑定任务失败、扫码结果解密或解析失败、上游返回空或非法凭据、绑定流水线异常。轮询网络错误由连接器每 2 秒重试（不会转成 502）；持续失败时等待接口会一直挂起，直到二维码过期或停机 | 绑定服务（启动或等待接口） |
| 503 | `gateway_not_ready` | core 非 `ready`（`POST /channels/qq`、`/enable`、`/bind` 的启动入口）；message 按状态区分：`starting` 提示启动完成后重试，`failed` 提示查 `manual_restart_required` 日志并重启进程，`stopping`/`stopped` 提示正在关机 | 管理服务 |
| 503 | `gateway_stopping` | 停机闸门已关闭管理写入（入口或检查点），或停机作废进行中的扫码绑定会话 | 管理服务（含绑定会话） |

`POST /channels/qq`、`POST /channels/qq/enable` 与扫码等待的成功响应统一为 `{"ok":true,"channel":"qq:<appId>","state":...}`，`state` 是响应时观察到的实例状态，可选 `detail` 说明启动失败或停机中止；内部 `saved` 字段不进入响应。`POST /channels/qq/bind` 的成功响应为 `{"ok":true,"url":"https://q.qq.com/..."}`。管理动作成功记 `channel_added` / `channel_enabled`（字段 `channelId`、`appId`、`outcome`）；扫码绑定成功复用 `channel_added`，不新增日志事件。

<a id="qr-bind"></a>

## 扫码绑定

扫码绑定由 [`src/management/binding.ts`](../../src/management/binding.ts) 的会话状态机与 [`src/channels/qq/qr-connect.ts`](../../src/channels/qq/qr-connect.ts) 的连接器适配层实现；二维码协议（创建绑定任务、轮询与凭据解密）由腾讯官方依赖 `@tencent-connect/qqbot-connector@1.2.0` 承担。网关不打印终端二维码（`displayQrCodeToConsole: false`），来源标识固定 `source=dsh-gateway`。

两步流程：`POST /channels/qq/bind` 启动（或幂等复用）唯一会话并等待二维码 URL 就绪，成功返回 `{"ok":true,"url":"https://q.qq.com/qqbot/openclaw/connect.html?task_id=...&source=dsh-gateway&_wv=2"}`；调用方展示该 URL 后，`GET /channels/qq/bind` 挂起等待会话终态。POST 的检查顺序是停机闸门 → core 状态 → 上游启动：停机或 core 非 `ready` 分别返回 503 `gateway_stopping` / `gateway_not_ready`，上游启动失败返回 502 `bind_failed`；二维码在 URL 就绪前就过期时 POST 返回 409 `bind_expired`。等待入口不检查停机闸门。

GET 在会话进行中保持挂起，HTTP 服务器不设置响应期限，网关也不设会话总超时；终态响应固定为：扫码成功 200 `{"ok":true,"channel":"qq:<appId>","state":...,"detail"?}`；二维码过期 409 `bind_expired`；上游失败 502 `bind_failed`；停机作废 503 `gateway_stopping`；从未启动过会话 409 `bind_not_started`。扫码成功后的落盘失败沿用 add 的错误码：配置文件被外部修改 409 `config_modified_externally`、写回失败 500 `config_write_failed`、落盘前已进入停机 503 `gateway_stopping`。停机一律作废进行中的会话（包括落盘或启动进行中），挂起的 GET 以 503 `gateway_stopping` 收尾；若配置已写入则保留，进程重启后按配置启动实例。成功响应的 `state` 是扫码成功当次落盘/启动后的观察状态；实例同步启动失败时仍为 200，`state` 为 `blocked` 并附 `detail`；SDK 异步启动失败时 `state` 为 `blocked`、无 `detail`，按 `manual_restart_required` 日志处置。

扫码成功后凭据自动写入 `gateway.config.json` 并启动实例，跳过 `POST /channels/qq` 的在线凭证校验（扫码已由腾讯侧完成认证）；网关只按配置同规则校验上游返回的 `appId`（`trim` 后非空、≤128 字符、仅 `[A-Za-z0-9-]`）与 `appSecret`（`trim` 后非空、≤256 字符），不合法按 502 `bind_failed` 返回。绑定不新增配置字段，写入的仍是 `channels.qq` 现有的 `appId`、`appSecret` 与 `enabled`。新 `appId` 追加 `enabled: true` 实例并启动；已有 `appId` 更新 secret、保留原 `enabled` 并重启实例，包含已禁用实例。实例启动失败不回滚已保存的配置。

会话同一时间只有一个。进行中重复 `POST` 返回同一 URL，不创建新的上游任务；进入终态后，结果保留在内存，重复 `GET` 立即返回同一结果（不重新读取实例状态），直到下一次 `POST` 或进程重启。二维码过期即终止会话，网关不自动换码；刷新方式是重新 `POST`。网关不提供取消路由：会话只在扫码成功（含随后的落盘/启动结果）、二维码过期、上游失败或进程停机时结束。会话本身不持久化，进程重启后需要重新发起。

绑定不维护并发或互斥控制，约束与后果见[扫码绑定流程](../architecture.md#qr-bind-flow)。进程停机时 `management.beginShutdown()` 先作废进行中的会话，再取消上游；二维码 URL 尚未就绪的 POST 与等待终态的 GET 均以 503 `gateway_stopping` 收尾，不依赖连接器及时回调取消结果。上游迟到的二维码、成功或失败回调不会改变停机终态或触发凭据保存；已进入终态的会话保留原结果。

绑定会话不参与 `/readyz`：状态投影只读配置实例与 core 注册表，绑定进行中、等待扫码或二维码过期都不改变就绪判定；扫码成功并启动实例后，实例按常规状态进入状态表。扫码绑定不新增日志事件，成功落盘复用 `channel_added`；网关不主动记录二维码 URL 与 `task_id`，它们只通过 POST 成功响应返回调用方，绑定失败的错误消息经 `task_id` 值清洗与 `redact` 脱敏后才进入响应或日志。

<a id="credential-check"></a>

## QQ 凭证在线校验

`createQQTokenValidator` 用一次 `POST https://bots.qq.com/app/getAppAccessToken`（body `{"appId","clientSecret"}`）校验凭证：任意 2xx 响应且 JSON 含非空字符串 `access_token` 即有效，不建立 WebSocket。10 秒定时器覆盖等待响应头；`fetch` 返回后定时器即清除，读取响应正文不受该期限约束。非 2xx、缺 token 或无效 JSON 按 `rejected` 分类，不可达、请求超时或读取失败按 `network` 分类；两者均映射 422，`network` 消息提示重试或传 `force: true`。JSON 正文为 `null` 时访问 token 字段会抛出其他异常，管理服务同样映射为 422。

非 2xx 错误消息包含状态码与最多 200 字符的上游响应正文片段；片段经过 `redact`，该函数按凭证字段、赋值和 Bearer 等模式替换，不按请求中的实际 `appSecret` 值逐字屏蔽。上游若在普通文本中回显凭证，该值可能出现在管理响应；请求或读取失败的底层错误消息也会传递到管理响应。其他校验异常先经 `redact` 再包装。

<a id="weixin-management"></a>

## 微信管理

微信扫码与 QQ 扫码各自维护一个独立会话。微信 `POST /channels/weixin/bind` 幂等返回当前会话二维码 URL，`GET /channels/weixin/bind` 等待终态；重复等待复用终态，新 `POST` 在终态后开始新会话。二维码默认 120 秒过期，上游返回有效 `expires_in` 时使用该值；过期返回 `bind_expired`，验证码要求或缺少机器人 ID、扫码用户 ID、令牌时返回 `bind_failed`。

停机时先作废进行中的微信绑定会话，再取消上游请求；二维码 URL 尚未就绪的 POST 与等待终态的 GET 均以 503 `gateway_stopping` 收尾，不等待上游请求结束，也不会把停机取消归类为 `bind_failed`。`stopAll()` 在 HTTP 关闭前等待这些绑定请求对应的 Promise 落定；上游迟到结果不会发布二维码、保存凭据或启动实例，已进入终态的会话保留原结果。

扫码成功按 `botId` 添加或更新实例；更新保留原有 `enabled`，未启用的实例不会启动。`POST /channels/weixin/enable` 接受可选 `botId`；省略时必须恰有一个实例。启用和绑定都复用配置 store 的漂移检测与原子写入，写入成功后才启动实例，启动失败保留配置并返回 `blocked`。启用和扫码要求 core 处于 `ready`。

登录轮询与返回的 API 地址仅接受 `qq.com` 或其子域的 HTTPS origin；`scaned_but_redirect` 会切换到校验通过的地址。二维码、令牌与上下文令牌不写日志。微信启用响应中的 `connecting` 表示实例已注册但首次长轮询尚未返回。

<a id="known-gaps"></a>

## 已知缺口

- 管理路由本期无鉴权（含扫码绑定），仅靠绑定回环地址限制为本机访问；同机的任意本地进程都可调用。
- 无内置管理客户端：在线变更需要调用方自行发 HTTP 请求，凭证随请求体传递；也可以手工编辑配置文件后重启。
- 扫码绑定是单会话、纯内存的：同一时间只能处理一个绑定会话，终态保留到下次 `POST` 或进程重启；没有取消路由、自动换码或会话总超时，挂起的 `GET` 只能等待扫码、过期、上游失败或停机。
- QQ `add` 与扫码绑定对已 `disabled` 的实例更新 secret 时仍会启动该实例（配置保留 `enabled: false`），运行态与配置开关不一致，健康表以运行态覆盖；重启后按配置不再启动。
