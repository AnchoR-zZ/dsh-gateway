# 健康、状态与日志

本页描述本机健康探针的判定与响应正文、core 与渠道状态机、结构化日志的事件与字段契约以及凭证脱敏边界；配置字段的定义见 [配置字段](config.md#config-fields)，固定行为常量的取值见 [固定行为常量](config.md#gateway-limits)，入站过滤规则见 [入站过滤](subsystems/inbound.md#inbound-filter)，投递报告状态见 [投递报告](subsystems/outbound.md#reply-port)，映射写事务的故障机制见 [写事务与故障](subsystems/session-state.md#write-transaction)。源码：[`src/core/lifecycle.ts`](../src/core/lifecycle.ts)、[`src/core/index.ts`](../src/core/index.ts)、[`src/logging.ts`](../src/logging.ts) 与 [`src/qq/index.ts`](../src/qq/index.ts)。

<a id="readiness"></a>

## 健康探针

探针是 core 在进程内启动的只读 HTTP server，默认绑定 `127.0.0.1:17890`，只处理 `GET`，不承担保活职责，也不接受消息、配置修改或控制请求。监听独占回环端口并兼作单实例占位：端口已被占用（例如已有实例在运行）时启动直接失败，不尝试结束占用进程；监听句柄会被 `unref`，不阻止进程退出。

| 请求 | 状态码 | 响应正文 | 条件 |
|---|---|---|---|
| `GET /livez` | 200 | `{"status":"ok"}` | 监听存在即返回，不检查 core、store 或渠道状态 |
| `GET /readyz` | 200 或 503 | 健康快照 JSON | 就绪谓词为真返回 200，为假返回 503 |
| 其他路径或非 `GET` 方法 | 404 | `{"error":"not found"}` | 不区分路径是否存在，也不提供控制语义 |

查询串在匹配前被去掉，`/livez?probe=1` 与 `/livez` 等价；所有响应都带 `content-type: application/json`。

就绪谓词要求三项同时成立：core 状态为 `ready`、映射 store 未进入 failed、所有已注册渠道状态为 `online`。已注册渠道集合为空时第三项为真，因此零渠道也判定就绪：启动窗口内 `/readyz` 可能先于 QQ 注册返回 200，渠道注册失败本身也不会让该谓词返回假，运维必须同时读取正文的 `channels`。

`/readyz` 正文与 core 内部健康快照的字段含义一致，但正文键名为 `channels`，core 内部的 `health()` 使用 `channelStates`：

| 字段 | 类型 | 含义 |
|---|---|---|
| `coreState` | `CoreState` | core 状态：`starting`、`ready`、`stopping`、`stopped` 或 `failed` |
| `channels` | `Record<string, ChannelState>` | 已注册渠道状态，键为 `channelId`（不含 `accountId`），值为 `connecting`、`online`、`reconnecting` 或 `blocked` |
| `pending` | number | 仍在 FIFO 等待、尚未出队的任务数 |
| `running` | number | 已占用全局执行槽的在飞任务数，含 `execute` 与 `queueExpired` 两类 |
| `startedAt` | string | core 进入 `ready` 时的 UTC ISO 8601 时间；进入 `ready` 之前为空字符串 |

正文不含用户标识、`sessionId`、AppID 或错误原文；同一 `channelId` 注册多个 `accountId` 时，表内只保留后写入条目的状态。

监听在 `core.start()` 的第一步绑定，先于映射加载与 `ready` 迁移：`starting` 期间 `/livez` 已返回 200，`/readyz` 返回 503 且 `coreState` 为 `starting`、`startedAt` 为空字符串。绑定失败时 `start()` 直接拒绝，此时 core 仍在 `starting`，插件入口记 `manual_restart_required` 并执行停止链；映射加载失败时先关闭已绑定的监听再把错误上抛。

停止链在关闭监听这一步强制断开保持连接，避免探测客户端的 keep-alive 池拖住关闭；关闭后对该端口的连接被拒绝，而不是返回 503。监听未关闭前 `/livez` 恒返回 200，包括 `failed` 与 `stopping` 期间。监听建立后的 `error` 事件记一条 `state_warning`（`reason` 以 `health server error:` 开头），不改变任何状态。

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

`core.start()` 要求当前为 `starting`，否则直接抛错；成功路径依次为绑定监听、加载映射、启动会话回收器、迁移 `ready` 并记录 `startedAt`。正常停止把 `starting` 或 `ready` 迁到 `stopping`，清理完成后仅当状态仍为 `stopping` 才迁到 `stopped`；已经 `failed` 时停止清理照常执行但不改写状态，使 `/readyz` 持续暴露 `failed`。入站准入要求 core 为 `ready`：其他状态一律拒绝；`failed` 不自动恢复，需要结束旧进程、修复原因后按 [README](../README.md) 的步骤重启。

渠道状态集合为 `connecting`、`online`、`reconnecting`、`blocked`。注册渠道时初始为 `connecting`，此后由渠道适配器通过注册返回的 `setState` 写入；core 不校验渠道状态之间的迁移顺序，只丢弃已注销代次或已移出注册表的写入。只有 `online` 计入就绪：`reconnecting` 记 `channel_reconnecting`，`blocked` 记 `manual_restart_required` 并让 `/readyz` 返回 503。SDK 事件到这四个状态的映射见 [QQ 连接与生命周期](subsystems/inbound.md#qq-connection)。

渠道只能在 `starting` 或 `ready` 时注册，其他状态注册抛错；`channelId` 与 `accountId` 同时相同的重复注册也抛错，错误消息只含 `channelId`，不含 `accountId`。

`manual_restart_required` 标记需要人工介入的路径；记录该事件本身不改变 core 状态，也不必然进入 `failed`。触发点如下：

| 触发点 | 记录方 |
|---|---|
| QQ 认证失败、终局断连（`willReconnect` 为假）或 SDK 启动失败 | QQ 适配器，随后把渠道置 `blocked` |
| QQ 出站隔离（单次发送超过 `QQ_OUTBOUND_CALL_TIMEOUT_MS` 未结束） | QQ 适配器，随后把渠道置 `blocked` |
| 渠道注册失败 | QQ 适配器 |
| 渠道进入 `blocked` | core |
| 映射持久化失败（store 转 failed），或 core 因持久状态不可用、释放未收敛进入 `failed` | core |
| LRU 逐出或陈旧 handle 的释放未收敛，以及 `releaseHandle` 返回后 session 仍在 live registry（条目转 stuck） | 会话管理器 |
| 停机预算内未完成的步骤 | 停止协调器 |
| 插件异步启动失败，或 core 与 QQ 的停止在有界等待内未同时收敛 | 插件入口 |

同一次渠道故障通常产生两行：QQ 侧带具体 `reason` 的归因行，以及 core 对 `blocked` 的记录行；字段互补，不要按行数统计故障数。

<a id="log-events"></a>

## 日志事件

日志器把每条事件序列化为一个 JSON 对象并写一行到 `sink`，默认 `console.log`（stdout）。固定键为 `event` 与 `time`（`new Date().toISOString()` 形式的 UTC ISO 8601），其余字段与事件同级平铺，不嵌套；`JSON.stringify` 会转义换行，因此一个事件恒为一行。

字段集合由 `LogFields` 约束：值只允许 string 或 number，值为 `undefined` 的字段在序列化时省略；`logEvent` 写入的 `event` 只能是 `GatewayLogEvent` 联合中的事件名；`debugBody` 与 QQ SDK 适配器另写 `debug_body`、`sdk_log`，不在该联合内。`error` 与 `reason` 是自由文本，序列化前再过一次脱敏；其他字段原样输出。

事件名共 20 个，按类别列出触发点与常见字段：

| 事件 | 触发点 | 常见字段 |
|---|---|---|
| `startup_summary` | 插件加载时、core 创建之前记录一次启动摘要 | `version`、`schemaVersion`、`configSchemaVersion`、`provider`、`model`、`policy`、`maxConcurrent`、`maxLiveAgents` |
| `queued` | core 准入接受入站并同步入队 | `requestId`、`channelId`、`bindingId`、`messageId`、`inputLength` |
| `inbound_ignored` | 入站被过滤或忽略：渠道过滤失败、core 形态校验或身份键失败、出队前已过期、停机丢弃队列、出站隔离期间、入站处理器异常 | 渠道侧 `messageId`、`reason`、`outcome`、`attachmentCount`、`inputLength`；core 侧 `reason`，出队或丢队列路径另带 `requestId`、`bindingId`、`messageId`，形态校验路径带 `channelId`、`generation` |
| `inbound_rejected` | 准入拒绝（core 非 `ready`、代次失效、store failed、容量超限），或拒绝提示未发出（回复窗口已过、独立发送槽已满） | core 侧 `channelId`、`generation`、`reason`，容量拒绝附 `requestId`、`bindingId`、`messageId`；渠道侧 `messageId`、`reason`，提示未发出时另带 `outcome` |
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
| `state_warning` | 非致命告警：非法状态迁移、探针运行期错误、停机步骤抛错、目录 `fsync` 失败、逐出 handle 已释放但 session 仍 live、`stop` 抛错 | `reason`，部分带 `channelId`、`bindingId`、`sessionId` |
| `channel_reconnecting` | 渠道进入 `reconnecting` | `channelId`、`generation`；QQ 侧归因行另带 `reason` |
| `manual_restart_required` | 需要人工介入，触发点见[状态机](#state-machines) | `reason`；部分带 `channelId`、`generation`，或 `bindingId`、`sessionId` |
| `shutdown` | 停止协调器结束，或 QQ SDK 的 `start()` 在未停止渠道的情况下 resolve | 正常结束只有 `event` 与 `time`；预算耗尽时 `reason` 为 `budget_exhausted`；QQ 场景带 `channelId` 与 `reason` |

渠道进入 `reconnecting` 或 `blocked` 时，渠道侧与 core 侧会各记一行：QQ 先记带原因的 `channel_reconnecting` 或 `manual_restart_required`，core 随后记状态行；释放未收敛等路径也可能由会话管理器与 core 各记一条 `manual_restart_required`。字段互补，按 `channelId`、`bindingId` 与时间聚合，不要按行数统计故障数。

`startup_summary` 字段的取值边界为：`version` 是插件版本（`package.json` 的 `version`），`schemaVersion` 是映射文件 schema 版本，`configSchemaVersion` 是配置文件 schema 版本，`provider` 与 `model` 取自启动时读取一次的默认模型选择，`policy` 是描述审批 `never`、sandbox `workspace-write` 与工作目录边界的固定摘要字符串，`maxConcurrent` 与 `maxLiveAgents` 是有效配置值。该事件不 dump 环境变量或完整配置。

| 字段 | 类型 | 含义与写入事件 |
|---|---|---|
| `requestId` | string | core 为每个通过形态校验的入站生成的请求标识；`queued`、容量拒绝、投递与 turn 事件 |
| `channelId` | string | 渠道标识，QQ 恒为 `qq` |
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

`LogFields` 不提供原始 `user_openid` 与 AppID 字段，但 `bindingId` 在 QQ 下由 `qq_<AppID>_<user_openid>` 组成，会随 `queued`、会话事件、准入拒绝、提示投递与 core 的 turn 失败事件输出；日志文件与采集链路应按敏感数据保护。探针正文不含用户标识、`sessionId`、AppID 与错误原文。

默认不记录消息正文、工具参数或模型推理：事件字段集里没有正文字段，唯一能写出正文的 `debugBody` 在源码中没有调用点，因此即使配置 `debug: true` 也不会产生 `debug_body` 行。`debug` 在创建日志器时固定，切换需要重启；正文与 `error`/`reason` 的脱敏始终生效。

`debugBody(kind, text, fields)` 在 `debug` 关闭时完全 no-op（不输出空行）；开启时输出 `event: "debug_body"`、`kind`（`inbound` 或 `outbound`）、已脱敏的 `text` 与可选字段，`kind` 与 `text` 与普通事件同级。

QQ SDK 自身的日志由独立适配器写成 `sdk_log` JSON 行，默认 `console.error`（stderr），不经过结构化日志器的 `sink`。字段为 `event: "sdk_log"`、`level`（`info`、`error`、`warn`、`debug`）、`message`、`time`，有 `meta` 时附加经 `redact` 的 JSON 字符串而不是嵌套对象。`sdk_log` 不属于 `GatewayLogEvent` 联合，也不受 `debug` 开关控制；`message` 与 `meta` 可能带出 SDK 的 `Authorization` 或 token 形态，脱敏在转发前完成。

<a id="known-gaps"></a>

## 已知缺口

| 缺口 | 影响 |
|---|---|
| Windows 上父目录 `fsync` 可能以 `EPERM` 失败，只记一条 `state_warning`，事务仍判成功，且每个 store 实例只告警一次 | 写入成功不再蕴含父目录已同步；该告警是唯一信号，且每个 store 实例只出现一次，事务结果、store 健康与 `/readyz` 都不受影响 |
| LRU 逐出、陈旧 handle 释放超时，或 `dispose` 返回后 session 仍在 live registry，只记 `manual_restart_required`（部分路径为 `state_warning`），core 与就绪状态不变 | 存在这类不可复用 handle 时 `/readyz` 仍返回 200，就绪探针不能替代对告警日志的人工处理；turn 路径的释放超时除外，它经 `dispose_did_not_converge` 使 core 转 `failed` |
| 健康正文的 `channels` 只按 `channelId` 聚合，同一渠道多个 `accountId` 可以同时注册，但表内后写覆盖 | 被覆盖账号进入 `blocked` 不会改变 `/readyz`，多账号部署需按渠道与账号另行采集状态 |
