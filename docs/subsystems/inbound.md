# 入站与 QQ 连接

本页描述 QQ 渠道的 SDK 组装、连接生命周期与状态映射、入站纯过滤、被动回复窗口，以及渠道侧拒绝提示的发送归属；实例的按配置拉起、替换重启与管理命令见 [channel 管理](channel-admin.md#channel-manager)，core 准入与排队见 [调度与 turn 控制](scheduling.md#ingress-admission)，提示文案、回复规划与投递见 [回复规划与投递](outbound.md#notice-order)，健康判定见 [健康探针与管理路由](../observability.md#readiness)，日志字段见 [日志事件](../observability.md#log-events)。源码：[`src/channels/qq/index.ts`](../../src/channels/qq/index.ts)、[`src/channels/qq/inbound.ts`](../../src/channels/qq/inbound.ts)、[`src/contracts.ts`](../../src/contracts.ts) 与 [`src/core/index.ts`](../../src/core/index.ts)。

<a id="qq-connection"></a>

## QQ 连接与生命周期

渠道实例由 runtime 启动链经实例管理器按配置构造（每个 `enabled` 实例一份，`accountId = appId`），并在 core 进入 `ready` 后调用 `qq.start()` 注册与连接；单个实例启动失败只记 `manual_restart_required` 并置 `blocked`，不影响其他实例与 core，恢复方式是重跑 `dsh-gateway channel enable qq`（替换为新实例）或重启进程。启动顺序与实例停止闸门见 [宿主接入](../architecture.md#host-integration) 与 [实例管理器](channel-admin.md#channel-manager)。

`start()` 首次调用按下列顺序装配；同一实例之后再次调用 `start()` 直接返回，无论前一次是成功、进行中还是失败终局，重启必须使用新实例。

```text
start()
  -> core.registerChannel({ channelId: 'qq', accountId: appId, stopReceiving })
  -> new QQBot(ctorOptions)
  -> bot.use(messageFilter())
  -> bind message / ready / resumed / error / disconnected
  -> ingress.setState('connecting')
  -> bot.start() 挂起直到 stop；渠道挂拒绝处理器后台化，start() 随即返回
```

注册渠道先于 SDK 构造：`channelId` 为 `qq`，`accountId` 为机器人 `AppID`。注册被 core 拒绝时（重复账号、core 状态、`channelId`/`accountId` 不符合路径安全字符集，或未提供 `stopReceiving` 函数），渠道记录 `manual_restart_required`、不构造 bot、不重试，并让 `qq.start()` 拒绝。

SDK 构造参数如下：

| 参数 | 取值 | 说明 |
|---|---|---|
| `appId` / `appSecret` | 配置实例的 `appId` / `appSecret`（`channels.qq[<i>]`） | 配置字段与校验见 [配置](../config.md#config-fields) |
| `intents` | `1 << 25` | SDK 中 C2C 与群消息共用的 intents 位；群消息在入站过滤第一步被拒 |
| `markdownSupport` | `true` | 启用 Markdown 发送 |
| `transport` | `'websocket'` | WebSocket 传输 |
| `tokenPrefetch` | `'sync'` | 同步预取 token |
| `logger` | SDK Logger 适配器 | SDK 内部日志经 `redact` 后写成独立 `sdk_log` JSON 行，默认输出到 stderr |

SDK 自身日志不进入 `GatewayLogEvent` 联合，也不受 `debug` 开关控制；行格式与脱敏规则见 [日志事件](../observability.md#log-events) 与 [脱敏与敏感数据](../observability.md#redaction)。

`bot.start()` 是挂起到 `stop()` 的长运行 Promise，渠道给它挂上拒绝处理器后立即返回。启动拒绝发生在 `start()` 返回之后，不会抛给调用方：渠道记录 `manual_restart_required` 并上报 `blocked`，`GatewayErrorCode.FATAL_CLOSE` 与 `GatewayErrorCode.RETRY_EXHAUSTED` 保留错误码，其他启动失败保留 SDK 错误消息；同实例不重试，core 保持运行而 readiness 因渠道非 `online` 返回 503（见 [健康探针](../observability.md#readiness)）。若 `bot.start()` 在渠道未进入停止流程时自行 resolve，渠道记录 `shutdown` 并把内部状态置 `stopped`。

`stop()` 幂等：首次调用把内部状态置 `stopping`，执行与注册时提供的 `stopReceiving()` 相同的停止流程，同步调用 `bot.stop()`（抛错只记 `state_warning`），再在 `DISPOSE_WAIT_MS`（5,000 ms）内等待在途入站处理；随后以同一上限等待后台 `bot.start()` 收敛，最后经 `ingress.disconnect()` 从 core 注销本实例（丢其排队任务、中断其运行中执行，不影响其他实例）。两个等待超时都只结束等待、不强制中断，剩余在途处理自行收尾。`stopReceiving()` 与 `stop()` 复用同一份 bot 停止与在途处理等待逻辑，重复调用幂等；注册失败、尚未构造 bot 时调用 `stop()` 不产生 bot 调用、不触发 disconnect。

SDK 事件与终止条件的映射如下；渠道只上报状态，不自行重连，重连由 SDK 负责。渠道状态集合与允许迁移见 [状态机](../observability.md#state-machines)。

| 来源 | 条件 | 渠道状态 | 附带动作 |
|---|---|---|---|
| `start()` 初始化 | — | `connecting` | 在 `bot.start()` 之前上报 |
| `ready` | — | `online` | — |
| `resumed` | — | `online` | — |
| `error` | 任意错误 | `reconnecting` | 记录 `channel_reconnecting`，reason 带 SDK 错误消息 |
| `disconnected` | `willReconnect === true` | `reconnecting` | 记录 `channel_reconnecting`，含 code 与 reason |
| `disconnected` | `willReconnect === false` | `blocked` | 记录 `manual_restart_required` |
| 出站隔离 | 出站调用超过 `QQ_OUTBOUND_CALL_TIMEOUT_MS` 未收敛 | `blocked` | 记录 `manual_restart_required`；此后状态事件不再改变状态 |
| `bot.start()` 拒绝 | 任意原因，含认证失败 | `blocked` | 记录 `manual_restart_required`；同实例不重启 |

出站隔离生效后，`ready`、`resumed`、`error` 与 `disconnected` 都不再改变状态，`blocked` 保持不变；隔离语义见 [出站隔离](outbound.md#outbound-isolation)。

`blocked` 的判定权在渠道：永久断连、`bot.start()` 失败与出站隔离记录 `manual_restart_required` 后上报该状态；这些异步失败由渠道消化，不会让 `qq.start()` 拒绝，注册失败则会使 `qq.start()` 拒绝并由实例管理器记录（只影响该实例）。core 收到 `blocked` 后同样记录该事件并保持 readiness 不可用，完整触发点与字段见 [日志事件](../observability.md#log-events)。恢复方式是重跑 `dsh-gateway channel enable qq`（替换为新实例）或重启进程，渠道实例自身不自动重建连接（SDK 内部重连除外）。

<a id="inbound-filter"></a>

## 入站过滤

入站过滤是 `normalizeC2CMessage` 纯函数：不读时钟、不做 IO、不导入 SDK，字段以 `unknown` 接收并逐项校验。只有全部检查通过才产出规范 C2C 消息；任一失败整条忽略，不把缺失字段补成默认值，也不保留部分内容。检查按表内顺序短路：

| 检查 | 拒绝原因 | 说明 |
|---|---|---|
| `kind === 'c2c'` | `not-c2c` | 群聊、频道与频道私信都拒绝，缺失 `kind` 同样拒绝 |
| `senderId`、`messageId` 均为非空字符串 | `incomplete-fields` | 缺失、空串或非字符串都拒绝 |
| `senderId` 匹配 `[A-Za-z0-9_-]+` | `invalid-identity` | 该值会进入 `bindingId` 与工作目录名，字符集规则见 [身份键](session-state.md#binding-id) |
| `replyTarget` 存在且 `replyTarget.msgId` 非空，并且 `targetId === senderId` | `incomplete-fields` / `target-mismatch` | 先查锚点 `msgId`，缺失或非法返回 `incomplete-fields`；再比较 `targetId`，不等返回 `target-mismatch` |
| `msgType === 0` | `non-text-type` | 缺失、字符串 `'0'` 与其他值都拒绝 |
| `attachments` 缺省、`null` 或空数组 | `has-attachments` | 有附件或字段为非数组结构时整条忽略，不保留文字 |
| `content` 为 trim 后非空字符串 | `empty-content` | 只去首尾空白，保留内部空白、换行与表情标记 |
| `timestamp` 可解析为有限正数 | `bad-timestamp` | `receivedAt` 取平台解析值，不延长窗口 |

通过过滤的字段映射为 `peerId = senderId`、`messageId`、`text = content.trim()`、`receivedAt`、`expiresAt` 与 `msgId = replyTarget.msgId`；`text` 只去首尾空白，内部空白、换行和表情标记原样保留。`msgId` 与 `messageId` 是独立字段，过滤器只要求 `msgId` 非空且其 `targetId` 与 `senderId` 一致，不要求 `msgId` 等于 `messageId`。

渠道为每条通过过滤的消息新建回复端口，携带锚点 `msgId`、目标 `peerId`、`expiresAt`、`maxMessages = QQ_MAX_MESSAGES_PER_INBOUND`（4）与发送函数，并把发送超时接到出站隔离；随后调用 `ingress.inbound`，提交 `peerId`、`messageId`、`text`、`receivedAt`、`replyPolicy { maxMessages, expiresAt }` 与回复端口。渠道只等待准入结果，不等待 turn 执行；准入判定与排队见 [调度与 turn 控制](scheduling.md#ingress-admission)。

core 的准入返回与渠道动作如下：

| core 返回 | 渠道动作 | 用户可见 |
|---|---|---|
| `accepted` | 返回；`queued` 由 core 记录 | 无即时消息 |
| `busy` | 记录 `inbound_rejected`，尝试 `busy` 提示 | 窗口与槽位允许时收到忙提示 |
| `stopping` | 记录 `inbound_rejected`，尝试 `service-stopping` 提示 | 窗口与槽位允许时收到服务停止提示 |
| `unavailable` | 记录 `inbound_rejected`，尝试 `state-unavailable` 提示 | 窗口与槽位允许时收到状态不可用提示 |
| `expired` | 只记录 `inbound_rejected` | 无 |

拒绝提示由渠道自己的独立发送槽发出，不经过 core 的回复信封：`busy`、`stopping`、`unavailable` 分别映射到 `busy`、`service-stopping`、`state-unavailable`。发送是尽力而为的：窗口已过或槽位占满时只记 `inbound_rejected`，不排队、不重试；发送失败只记 `reply_failed`，超时进入出站隔离。锚点用本条消息的 `msgId`、目标为其 `peerId`；槽位数量、总期限、提示文案与合并顺序见 [提示与顺序](outbound.md#notice-order)。

出站隔离生效后，渠道在过滤之前丢弃新入站并记录 `inbound_ignored`（reason `outbound-isolated`），也不再发送任何拒绝提示。提示文案、合并与排序规则见 [提示与顺序](outbound.md#notice-order)。

过滤拒绝的入站只记录 `inbound_ignored`：`reason`、非空时附 `messageId`、`outcome`（`msgType=<值>` 或 `msgType-missing`）、`attachmentCount`（缺省或 `null` 为 0，数组取长度，其他值按 1 记）与 `inputLength`（非字符串按 0 记），不记录正文，也不创建回复端口。入站处理函数意外异常时同样记录该事件（reason 为 `handler error: ...`），异常不抛回 SDK，也不影响其他入站。事件字段与序列化见 [日志事件](../observability.md#log-events)。

<a id="reply-window"></a>

## 回复窗口与时间

本节的时间常量都以毫秒计；完整常量表见 [配置与固定常量](../config.md#gateway-limits)。

`receivedAt` 是平台 `timestamp` 的 `Date.parse` 结果，`expiresAt = receivedAt + QQ_PASSIVE_REPLY_WINDOW_MS`，该常量为 3,600,000 ms（60 分钟）。窗口以平台入站时间为起点，不使用本地接收时钟；`timestamp` 不是字符串、不可解析或解析结果非有限正数时整条拒绝（`bad-timestamp`），不回退到本地时间，也不延长窗口。

渠道把 `expiresAt` 同时传给 core 的 `replyPolicy` 与回复端口；`replyPolicy.maxMessages` 为 `QQ_MAX_MESSAGES_PER_INBOUND`（4），core 与回复规划只能在该预算内取值，不得放大。回复端口在投递开始与每段发送前用墙钟比较 `now() >= expiresAt`：尚未发送时报告 `expired`，已发送部分时报告 `partial`，投递语义见 [投递](outbound.md#reply-port)。

core 在不同阶段使用同一窗口：入队时已过期直接返回 `expired` 并关闭回复端口；出队时已过期丢弃并记录 `expired before dequeue`；剩余窗口小于 `TURN_DEADLINE_MS + QQ_OUTBOUND_MARGIN_MS`（600,000 + 180,000 = 780,000 ms）时改发 `queue-expired` 信封。阈值与队列行为见 [调度](scheduling.md#scheduler)。

去重完全委托 SDK：渠道只装载不带参数的 `messageFilter()` 一个中间件，使用 SDK 默认去重窗口；网关不维护去重表，也不为去重持久化消息 ID，窗口外的重复推送可能再次执行完整 turn。

<a id="known-gaps"></a>

## 已知缺口

- 去重只依赖 SDK 默认窗口：网关不维护去重表，窗口外的重复推送可能再次执行完整 turn；自动测试只覆盖中间件数量，没有重复投递用例。
- 拒绝提示是尽力而为：回复窗口已过或 4 个独立发送槽全满时只记 `inbound_rejected`，不排队、不补发，用户可能收不到任何拒绝说明。
- 真实 QQ 平台路径未覆盖：WebSocket 握手、token 预取、SDK 重连与认证失败不在自动测试覆盖内，渠道测试使用替身 bot 且不建立连接（见 [README 的命令与覆盖说明](../../README.md)）。
