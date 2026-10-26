# 健康、状态与日志

本页描述本机 HTTP 监听的所有权与启停位置、健康探针与管理路由（含扫码绑定等待接口）的判定与响应正文、core 与渠道状态机、结构化日志的事件与字段契约以及凭证脱敏边界；配置字段的定义见 [配置字段](config.md#config-fields)，固定行为常量的取值见 [固定行为常量](config.md#gateway-limits)，入站过滤规则见 [入站过滤](subsystems/inbound.md#inbound-filter)，投递报告状态见 [投递报告](subsystems/outbound.md#reply-port)，映射写事务的故障机制见 [写事务与故障](subsystems/session-state.md#write-transaction)，管理业务与管理路由的完整契约见 [channel 管理](subsystems/channel-admin.md)。源码：[`src/http/server.ts`](../src/http/server.ts)、[`src/http/routes.ts`](../src/http/routes.ts)、[`src/management/service.ts`](../src/management/service.ts)、[`src/management/binding.ts`](../src/management/binding.ts)、[`src/channels/qq/qr-connect.ts`](../src/channels/qq/qr-connect.ts)、[`src/management/status.ts`](../src/management/status.ts)、[`src/core/lifecycle.ts`](../src/core/lifecycle.ts)、[`src/core/index.ts`](../src/core/index.ts)、[`src/logging.ts`](../src/logging.ts) 与 [`src/channels/qq/index.ts`](../src/channels/qq/index.ts)。

<a id="readiness"></a>

## 健康探针与管理路由

本机 HTTP 监听由 runtime 组装并拥有（[`src/runtime.ts`](../src/runtime.ts) 创建 [`createHttpServer`](../src/http/server.ts) 与 [`createHttpRoutes`](../src/http/routes.ts)，不属于 core 或管理服务），默认绑定 `127.0.0.1:17890`。`GET` 探针只读，另有仅本机、无鉴权的 channel 管理路由：三个 `POST` 入口与扫码绑定的 `GET` 等待接口（见下表与 [管理路由](subsystems/channel-admin.md#admin-routes)）；不接受消息或其他控制请求。监听独占回环端口并兼作单实例占位：端口已被占用（例如已有实例在运行）时启动失败（runtime 记录 `manual_restart_required` 并回滚），不尝试结束占用进程；监听句柄会被 `unref`，不阻止进程退出。

| 请求 | 状态码 | 响应正文 | 条件 |
|---|---|---|---|
| `GET /livez` | 200 | `{"status":"ok"}` | 监听存在即返回，不检查 core、store 或渠道状态 |
| `GET /readyz` | 200 或 503 | 管理状态投影 JSON | 状态投影的 `ready` 为真返回 200，否则 503 |
| `POST /channels/qq`、`POST /channels/qq/enable` | 200/400/404/409/422/503/500 | 成功 `{"ok":...}` 或 `{"error":{"code","message"}}` | 仅 `POST` + `application/json`（否则 404/400）；契约见 [管理路由](subsystems/channel-admin.md#admin-routes) |
| `POST /channels/qq/bind` | 200/400/409/502/503 | `{"ok":true,"url":...}` 或错误正文 | 仅 `POST` + `application/json`（否则 404/400）；二维码在 URL 就绪前过期时 409；契约见 [扫码绑定](subsystems/channel-admin.md#qr-bind) |
| `GET /channels/qq/bind` | 200/409/500/502/503 | 成功同 `POST /channels/qq`，或错误正文 | 挂起等待绑定终态，无响应期限；契约见 [扫码绑定](subsystems/channel-admin.md#qr-bind) |
| 其他路径或方法 | 404 | `{"error":"not found"}` | 不区分路径是否存在，也不提供其他控制语义 |

查询串在匹配前被去掉，`/livez?probe=1` 与 `/livez` 等价；所有响应都带 `content-type: application/json`。管理请求 body 上限 64 KiB，坏 JSON、读取中断与非 JSON 内容类型按 400（`invalid_request`）拒绝；未命中路径或方法回 404 `{"error":"not found"}`；处理器抛出非管理异常时回 500（`internal_error`）并记一条 `state_warning`（`reason` 以 `admin request failed:` 开头）。

就绪谓词由 [`src/management/status.ts`](../src/management/status.ts) 的 `createStatusProjection` 计算，`/readyz` 与管理服务的 `getStatus()` 使用同一份结果，要求三项同时成立：core 状态为 `ready`、映射 store 未进入 failed、健康渠道表中除 `disabled` 与 `not_configured` 外的条目全部为 `online`。因此已启用实例处于 `connecting`/`reconnecting`/`blocked`（含"enabled 但未注册"的 `blocked` 铺底值）时整体 503；`not_configured` 与 `disabled` 条目不影响就绪，零渠道实例（空数组或全部 disabled）时 `/readyz` 返回 200。

扫码绑定会话不进入状态投影：绑定进行中、等待扫码或二维码过期都不改变上述判定与 `channels` 表；扫码成功并启动实例后，实例按常规渠道状态参与就绪判定。

`/readyz` 正文由状态投影的 `GatewayStatus` 投影成五个键，`channels` 由实例状态数组压平为按键索引的对象：

| 字段 | 类型 | 含义 |
|---|---|---|
| `coreState` | `CoreState` | core 状态：`starting`、`ready`、`stopping`、`stopped` 或 `failed` |
| `channels` | `Record<string, ChannelHealthState>` | 渠道状态表，实例粒度：键为 `<channelId>:<appId>`（QQ 下即 `qq:<AppID>`）；`qq` 类型零实例（配置与注册表皆空）时保留一条 `"qq": "not_configured"` |
| `pending` | number | 仍在 FIFO 等待、尚未出队的任务数 |
| `running` | number | 已占用全局执行槽的在飞任务数，含 `execute` 与 `queueExpired` 两类 |
| `startedAt` | string | core 进入 `ready` 时的 UTC ISO 8601 时间；进入 `ready` 之前为空字符串 |

`channels` 的值集合：已注册实例为 `connecting`、`online`、`reconnecting`、`blocked`（注册表实时状态）；配置派生值为 `disabled`（配置存在且 `enabled: false`、未注册）与 `not_configured`（类型零实例）。正文不含用户标识、`sessionId` 或错误原文；键中的 `AppID` 是实例标识，属正文合法内容。

监听在 runtime 启动链的第一步绑定，先于 core 启动：core 处于 `starting` 期间 `/livez` 已返回 200，`/readyz` 返回 503 且 `coreState` 为 `starting`、`startedAt` 为空字符串。绑定失败时 `http.start()` 拒绝、core 不启动，runtime 记录 `manual_restart_required`（`gateway startup failed: ...`）并回滚已创建资源；core 启动失败（如状态映射加载失败）时 core 状态保持 `starting` 且不自行清理资源，同样由 runtime 记录 `manual_restart_required` 后回滚（停止 core 与渠道实例、关闭 HTTP）。

停止链先关闭管理写入入口与新的实例启动，HTTP 监听最后关闭：停止期间 `/livez` 仍返回 200，管理写请求以 `gateway_stopping` 被拒（HTTP 503），进行中的扫码绑定等待请求同样以 503 收尾，已保存的配置保留但不启动实例；runtime 在总预算内并行等待启动任务收敛（若启动尚未完成）、管理在途操作落定、core 停止与全部实例停止，然后才关闭监听，因此 disposer 返回后不会再出现迟到监听。监听关闭时强制断开保持连接，避免探测客户端的 keep-alive 池拖住关闭，关闭后对该端口的连接被拒绝而不是返回 503。关闭失败只记 `state_warning`。监听创建后挂接的 `error` 事件（含启动期绑定失败）记一条 `state_warning`（`reason` 以 `http server error:` 开头），不改变任何状态。

<a id="state-machines"></a>

## 状态机

core 状态集合为 `starting`、`ready`、`stopping`、`stopped`、`failed`，由 core 独占维护，只通过状态机迁移；`stopped` 与 `failed` 是吸收态。

| 当前状态 | 允许迁移到 |
|---|---|
| `starting` | `ready`、`stopping`、`failed` |
| `ready` | `stopping`、`failed` |
| `stopping` | `stopped`、`failed` |
| `stopped` | 无 |
| `failed` | 无 |

迁移到当前状态是静默 no-op，不写日志；表外迁移被拒绝并记 `state_warning`，`reason` 形如 `rejected core state transition starting -> stopped`，状态保持不变。迁移函数返回本次调用是否真的改变了状态，拥有者据此执行一次性副作用。

`core.start()` 要求当前为 `starting`，否则直接抛错；成功路径依次为加载持久映射、启动会话回收器、迁移 `ready` 并记录 `startedAt`，不绑定或关闭任何监听。启动失败直接拒绝且不自行清理资源，由 runtime 记录 `manual_restart_required` 并回滚。正常停止把 `starting` 或 `ready` 迁到 `stopping`，清理完成后仅当状态仍为 `stopping` 才迁到 `stopped`；已经 `failed` 时停止清理照常执行但不改写状态，使 `/readyz` 持续暴露 `failed`。入站准入要求 core 为 `ready`：其他状态一律拒绝；`failed` 不自动恢复，需要结束旧进程、修复原因后按 [README](../README.md) 的步骤重启。

渠道状态集合为 `connecting`、`online`、`reconnecting`、`blocked`。注册渠道时初始为 `connecting`，此后由渠道适配器通过注册返回的 `setState` 写入；core 不校验渠道状态之间的迁移顺序，只丢弃已注销代次或已移出注册表的写入。只有 `online` 计入就绪：`reconnecting` 记 `channel_reconnecting`，`blocked` 记 `manual_restart_required` 并让 `/readyz` 返回 503。SDK 事件到这四个状态的映射见 [QQ 连接与生命周期](subsystems/inbound.md#qq-connection)；`disabled`/`not_configured` 是健康表的配置派生值，不进入注册表。

渠道只能在 `starting` 或 `ready` 时注册，其他状态注册抛错；`channelId` 与 `accountId` 同时相同的重复注册也抛错，错误消息只含 `channelId`，不含 `accountId`。同一账号注销（`disconnect`）后可用新实例重新注册。`manual_restart_required` 的处置是修复原因后调用 `POST /channels/qq/enable`（拉起新实例），不需要重启进程；冷重启同样有效。

`manual_restart_required` 标记需要人工介入的路径；记录该事件本身不改变 core 状态，也不必然进入 `failed`。触发点如下：

| 触发点 | 记录方 |
|---|---|
| QQ 认证失败、终局断连（`willReconnect` 为假）或 SDK 启动失败 | QQ 适配器，随后把渠道置 `blocked` |
| QQ 出站隔离（单次发送超过 `QQ_OUTBOUND_CALL_TIMEOUT_MS` 未结束） | QQ 适配器，随后把渠道置 `blocked` |
| 渠道注册失败（含管理请求拉起实例失败） | QQ 适配器 / 实例管理器 |
| 渠道进入 `blocked` | core |
| 映射持久化失败（store 转 failed），或 core 因持久状态不可用、释放未收敛进入 `failed` | core |
| LRU 逐出或陈旧 handle 的释放未收敛，以及 `releaseHandle` 返回后 session 仍在 live registry（条目转 stuck） | 会话管理器 |
| 停机预算内未完成的步骤 | 停止协调器 |
| runtime 异步启动失败，或停机总预算内启动任务、管理在途操作、core 停止与实例停止未全部收敛 | runtime |

同一次渠道故障通常产生两行：QQ 侧带具体 `reason` 的归因行，以及 core 对 `blocked` 的记录行；字段互补，不要按行数统计故障数。

<a id="log-events"></a>

## 日志事件

日志器把每条事件序列化为一个 JSON 对象并写一行到 `sink`，默认 `console.log`（stdout）。固定键为 `event` 与 `time`（`new Date().toISOString()` 形式的 UTC ISO 8601），其余字段与事件同级平铺，不嵌套；`JSON.stringify` 会转义换行，因此一个事件恒为一行。

字段集合由 `LogFields` 约束：值只允许 string 或 number，值为 `undefined` 的字段在序列化时省略；`logEvent` 写入的 `event` 只能是 `GatewayLogEvent` 联合中的事件名；`debugBody` 与 QQ SDK 适配器另写 `debug_body`、`sdk_log`，不在该联合内。`error` 与 `reason` 是自由文本，序列化前再过一次脱敏；其他字段原样输出。

事件名共 24 个，按类别列出触发点与常见字段：

| 事件 | 触发点 | 常见字段 |
|---|---|---|
| `startup_summary` | runtime 组装时、core 创建之前记录一次启动摘要 | `version`、`schemaVersion`、`configSchemaVersion`、`provider`、`model`、`policy`、`maxConcurrent`、`maxLiveAgents` |
| `config_template_created` | 首次启动创建了 v2 配置模板（零实例） | `reason`（含模板路径与添加机器人的指引） |
| `config_migrated` | 配置文件由 v1 自动迁移为 v2 并写回 | `reason`（含文件路径） |
| `channel_added` | 管理服务成功添加/更新一个 QQ 实例（含扫码绑定成功落盘） | `channelId`、`appId`、`outcome`（响应时状态） |
| `channel_enabled` | 管理服务启用（或幂等确认）一个 QQ 实例 | `channelId`、`appId`、`outcome` |
| `queued` | core 准入接受入站并同步入队 | `requestId`、`channelId`、`bindingId`、`messageId`、`inputLength` |
| `inbound_ignored` | 入站被过滤或忽略：渠道过滤失败、core 形态校验或身份键失败、出队前已过期、停机丢弃队列、出站隔离期间、入站处理器异常 | 渠道侧 `messageId`、`reason`、`outcome`、`attachmentCount`、`inputLength`；core 侧 `reason`，出队或丢队列路径另带 `requestId`、`bindingId`、`messageId`，形态校验路径带 `channelId`、`generation` |
| `inbound_rejected` | 准入拒绝（core 非 `ready`、代次失效、store failed、容量超限、入队时已过期），或拒绝提示未发出（回复窗口已过、独立发送槽已满） | core 侧 `channelId`、`generation`、`reason`，`admit` 拒绝附 `requestId`、`bindingId`、`messageId`；渠道侧 `messageId`、`reason`，提示未发出时另带 `outcome` |
| `session_created` | 新建会话并提交映射 | `bindingId`、`sessionId`、`generation` |
| `session_resumed` | 从映射恢复会话成功 | `bindingId`、`sessionId`、`generation` |
| `session_recreated` | 恢复失败或持久 cwd 不一致，重建之前 | `bindingId`、旧 `sessionId`、旧 `generation`、`reason` |
| `turn_completed` | turn 以成功终态结束 | `requestId`、`sessionId`、`turn`、`outputLength`、`runMs`、`outcome` |
| `turn_failed` | 执行失败、运行契约异常、flush 转 fatal、取消清理未收敛、渠道停止抛错等 | 至少含 `reason`；turn 内路径带 `requestId`、`sessionId`、`turn`、`runMs`，core 与调度器路径带 `requestId`、`bindingId`、`messageId`，会话管理器路径带 `bindingId`、`sessionId`，个别路径带 `error` |
| `turn_timeout` | 执行截止，或准备阶段耗尽执行预算 | 准备阶段 `requestId`、`bindingId`、`messageId`、`reason`；turn 执行阶段 `requestId`、`sessionId`、`turn`、`reason`、`runMs` |
| `late_result_dropped` | 截止后到达的结果，或终态之后到达的 `turn/end` | `requestId`、`sessionId`、`turn`、`reason` |
| `reply_sent`、`reply_partial`、`reply_unknown` | 投递报告分别为 `sent`、`partial`、`unknown` | 渠道投递报告 `messageId`、`deliveryMs`、`attempted`、`confirmed`；提示信封 `requestId`、`bindingId`、`messageId`、`attempted`、`confirmed`；turn 回复 `requestId`、`sessionId`、`turn`、`outputLength` |
| `reply_failed` | 报告为 `failed`、`expired` 或 `closed`，`deliver` 抛错，回复规划降级，或拒绝提示发送失败 | `reason` 加路径相关字段：报告路径带 `messageId`，或 `requestId`、`sessionId`、`turn`，个别带 `bindingId`、`attempted`、`confirmed`；规划降级与提示发送失败只带 `messageId` |
| `state_failed` | 映射 store 转 failed、core 进入 failed，或渠道 `setState` 抛错 | `error`（store）、`reason`（core 转 failed），或 `channelId`、`reason`（渠道） |
| `state_warning` | 非致命告警：非法状态迁移、HTTP 监听 `error` 事件（含启动期绑定失败与运行期错误）、管理请求处理器异常（`admin request failed:`）、停机步骤抛错、目录 `fsync` 失败、逐出 handle 已释放但 session 仍 live、`stop` 抛错（含启动失败后 core、实例与 HTTP 的清理失败）、释放或取消清理时 flush 报无持久化监听者 | `reason`，部分带 `channelId`、`bindingId`、`sessionId`、`requestId`、`turn` |
| `channel_reconnecting` | 渠道进入 `reconnecting` | `channelId`、`generation`；QQ 侧归因行另带 `reason` |
| `manual_restart_required` | 需要人工介入，触发点见[状态机](#state-machines) | `reason`；部分带 `channelId`、`generation`，或 `bindingId`、`sessionId` |
| `shutdown` | core 停止协调器结束，或 QQ SDK 的 `start()` 在未停止渠道的情况下 resolve | 正常结束只有 `event` 与 `time`；预算耗尽时 `reason` 为 `budget_exhausted`；QQ 场景带 `channelId` 与 `reason` |

扫码绑定不新增日志事件：成功落盘与启动复用 `channel_added`（字段相同），绑定会话自身的可预期失败只通过 HTTP 响应返回、不记日志事件；扫码成功后的实例启动失败仍走既有日志（`channel_added` 的 `outcome` 与 `manual_restart_required`）。二维码 URL 与 `task_id` 不主动写入日志。

渠道进入 `reconnecting` 或 `blocked` 时，渠道侧与 core 侧会各记一行：QQ 先记带原因的 `channel_reconnecting` 或 `manual_restart_required`，core 随后记状态行；释放未收敛等路径也可能由会话管理器与 core 各记一条 `manual_restart_required`。字段互补，按 `channelId`、`bindingId` 与时间聚合，不要按行数统计故障数。

`startup_summary` 字段的取值边界为：`version` 是插件版本（`package.json` 的 `version`），`schemaVersion` 是映射文件 schema 版本，`configSchemaVersion` 是配置文件 schema 版本，`provider` 与 `model` 取自启动时读取一次的默认模型选择，`policy` 是描述审批 `never`、sandbox `workspace-write` 与工作目录边界的固定摘要字符串，`maxConcurrent` 与 `maxLiveAgents` 是有效配置值。该事件不 dump 环境变量或完整配置。

| 字段 | 类型 | 含义与写入事件 |
|---|---|---|
| `requestId` | string | core 为每个通过形态校验的入站生成的请求标识；`queued`、容量拒绝、投递与 turn 事件 |
| `channelId` | string | 渠道标识，QQ 恒为 `qq` |
| `appId` | string | channel 管理事件携带的实例标识（QQ 机器人 AppID）；`appSecret` 恒不输出 |
| `bindingId` | string | 身份键，见[脱敏与敏感数据](#redaction) |
| `sessionId` | string | dsh 会话 id |
| `generation` | number | 会话事件中为映射 `generation`，渠道事件中为渠道代次 |
| `messageId` | string | 平台消息 id |
| `turn` | number | 目标 turn 序号，取自 `inbox/claimed` |
| `inputLength` | number | 正文字符数（UTF-16 code units）：`queued` 为 trim 后长度，`inbound_ignored` 为原始 `content` 长度 |
| `outputLength` | number | 最终正文长度（UTF-16 code units） |
| `queueWaitMs` | number | 毫秒字段；没有事件写入该字段，日志无法还原排队耗时 |
| `runMs` | number | turn 从开始到终态的耗时（ms） |
| `deliveryMs` | number | 首段发送到生成投递报告的耗时（ms），未发送为 0 |
| `outcome` | string | `turn_completed` 记录 `turn/end` 的 reason；渠道事件记录消息类型（`msgType=<n>` 或 `msgType-missing`）或拒绝提示类型 |
| `reason` | string | 自由文本原因，序列化前脱敏 |
| `error` | string | 错误摘要字符串，序列化前脱敏；不序列化 error 对象本身，避免夹带 prompt、工具参数或响应体 |
| `attempted` | number | 已消耗预算的发送次数 |
| `confirmed` | number | 平台确认成功的发送次数，与 `attempted` 成对出现 |
| `attachmentCount` | number | `inbound_ignored` 的附件个数；缺失或 `null` 记 0，非数组真值记 1 |
| `version` | string | `startup_summary`：插件版本 |
| `schemaVersion` | number | `startup_summary`：映射文件 schema 版本 |
| `configSchemaVersion` | number | `startup_summary`：配置文件 schema 版本 |
| `provider` | string | `startup_summary`：模型 provider |
| `model` | string | `startup_summary`：模型 id |
| `policy` | string | `startup_summary`：有效策略摘要 |
| `maxConcurrent` | number | `startup_summary`：并行任务上限 |
| `maxLiveAgents` | number | `startup_summary`：live handle 上限 |

<a id="redaction"></a>

## 脱敏与敏感数据

`redact(text)` 是纯函数，按固定顺序整体替换四类凭证形态，替换值统一为 `[REDACTED]`：

| 顺序 | 匹配内容 | 示例 |
|---|---|---|
| 1 | `authorization:` 头，值替换到行尾或引号前 | `Authorization: Bearer abc` → `Authorization: [REDACTED]` |
| 2 | 独立的 `Bearer` 令牌 | `Bearer abc.def` → `Bearer [REDACTED]` |
| 3 | JSON 字符串字段名含 `secret`、`token`、`api-key`、`password` 或 `credential` 的值 | `{"appSecret":"abc"}` → `{"appSecret":"[REDACTED]"}` |
| 4 | 名称含上述词的赋值形态（`=` 或 `:` 后接带引号或无引号的值） | `token=abc123&next=2` → `token=[REDACTED]&next=2` |

脱敏在序列化前执行：`logEvent` 只对 `error` 与 `reason` 两个字段调用 `redact`，其他字段原样输出；`debugBody` 对 `text` 脱敏；`sdk_log` 对 `message` 与序列化后的 `meta` 脱敏。

扫码绑定的二维码 URL 与其 `task_id` 只通过 `POST /channels/qq/bind` 的成功响应交给调用方，网关不主动写入日志；绑定失败时进入 `error`/`reason` 与错误正文的上游文本会先经过 `task_id` 参数值清洗与上述 `redact` 脱敏（见 [`src/management/binding.ts`](../src/management/binding.ts) 的 `describeFailure`）。扫码得到的 `appSecret` 按上述规则恒不输出。

`LogFields` 不提供原始 `user_openid` 字段；`appId` 字段携带实例标识（QQ 机器人 AppID，channel 管理事件使用，`appSecret` 恒不输出）。`bindingId` 在 QQ 下由 `qq_<AppID>_<user_openid>` 组成，会随 `queued`、会话事件、准入拒绝、提示投递与 core 的 turn 失败事件输出，日志文件与采集链路应按敏感数据保护。探针正文不含用户标识、`sessionId` 与错误原文；AppID 以实例键 `qq:<AppID>` 的形式出现在 `channels` 表中（见[健康探针与管理路由](#readiness)）。

默认不记录消息正文、工具参数或模型推理：事件字段集里没有正文字段，唯一能写出正文的 `debugBody` 在源码中没有调用点，因此即使配置 `debug: true` 也不会产生 `debug_body` 行。`debug` 在创建日志器时固定，切换需要重启；正文与 `error`/`reason` 的脱敏始终生效。

`debugBody(kind, text, fields)` 在 `debug` 关闭时完全 no-op（不输出空行）；开启时输出 `event: "debug_body"`、`kind`（`inbound` 或 `outbound`）、已脱敏的 `text` 与可选字段，`kind` 与 `text` 与普通事件同级。

QQ SDK 自身的日志由独立适配器写成 `sdk_log` JSON 行，默认 `console.error`（stderr），不经过结构化日志器的 `sink`。字段为 `event: "sdk_log"`、`level`（`info`、`error`、`warn`、`debug`）、`message`、`time`，有 `meta` 时附加经 `redact` 的 JSON 字符串而不是嵌套对象。`sdk_log` 不属于 `GatewayLogEvent` 联合，也不受 `debug` 开关控制；`message` 与 `meta` 可能带出 SDK 的 `Authorization` 或 token 形态，脱敏在转发前完成。

<a id="known-gaps"></a>

## 已知缺口

| 缺口 | 影响 |
|---|---|
| Windows 上父目录 `fsync` 可能以 `EPERM` 失败，只记一条 `state_warning`，事务仍判成功，且每个 store 实例只告警一次 | 写入成功不再蕴含父目录已同步；该告警是唯一信号，且每个 store 实例只出现一次，事务结果、store 健康与 `/readyz` 都不受影响 |
| LRU 逐出、陈旧 handle 释放超时，或 `dispose` 返回后 session 仍在 live registry，只记 `manual_restart_required`（部分路径为 `state_warning`），core 与就绪状态不变 | 存在这类不可复用 handle 时 `/readyz` 仍返回 200，就绪探针不能替代对告警日志的人工处理；turn 路径的释放超时除外，它经 `dispose_did_not_converge` 使 core 转 `failed` |
| 管理路由本期无鉴权，仅靠回环绑定限制为本机访问 | 同机任意本地进程可增改或扫码绑定 channel 实例；部署方需自行限制本机进程可信度 |
