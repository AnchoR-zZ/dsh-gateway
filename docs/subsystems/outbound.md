# 回复规划与投递

本页描述 QQ 渠道的回复规划、提示合并与投递语义，以及发送超时后的渠道出站隔离；入站过滤与被动回复窗口见 [入站过滤](inbound.md#inbound-filter)，turn 终态与截止时间见 [turn 执行](scheduling.md#turn-runner) 与 [超时、取消与清理](scheduling.md#cancellation)，日志事件见 [日志事件](../observability.md#log-events)。源码：[`src/qq/markdown.ts`](../../src/qq/markdown.ts)、[`src/qq/reply-port.ts`](../../src/qq/reply-port.ts)、[`src/qq/index.ts`](../../src/qq/index.ts) 与 [`src/contracts.ts`](../../src/contracts.ts)。

<a id="reply-planning"></a>

## 回复规划

每条通过入站过滤的消息在交给 core 之前创建一个回复端口，端口随 `InboundText.reply` 传递，一个端口最多消费一个 `ReplyEnvelope`。规划在第一个发送请求之前一次完成：`planReply` 是纯函数，输入最终正文、提示类型列表、条数上限与单条长度上限，输出按发送顺序排列的消息、`truncated` 与 `degraded`；它不做 IO、不依赖 SDK、不持有跨调用状态。

正文、提示与截断说明共享两个额度：`QQ_MAX_MESSAGES_PER_INBOUND`（4 条）与 `QQ_MESSAGE_MAX_LENGTH`（4000 UTF-16 code units）。下文以 `B` 表示条数预算、`L` 表示单条长度上限；端口以 `min(envelope.maxMessages, 4)` 作为 `B`，`L` 取 `QQ_MESSAGE_MAX_LENGTH`，`envelope` 只能把条数改小，不能放大。长度按字符串的 `length`（UTF-16 code units）量化，Markdown 标记、围栏与换行都计入，属于保守计数。

`text` 缺省或 trim 后为空按无正文处理。所有提示用换行合并为一条消息；有提示时正文最多占 `B-1` 条，无提示时正文可用满 `B` 条。无正文且无提示、合并后的提示文本超过 `L`、或正文存在但没有任何可用条数时，规划直接降级。

超长正文按以下层次降级；每一层只在上一层仍留下超过 `L` 的单元时生效。

| 层次 | 对象 | 规则 |
|---|---|---|
| 顶层块 | marked GFM Lexer 的顶层 token 原文 | 整块不超过 `L` 时保留原文，围栏代码块另按下一行规则处理；token 原文不能拼回输入时放弃块切分，整体按行处理 |
| 围栏代码块 | `code` 块 | 未闭合先补同字符闭合围栏；仍超长则按代码行分段，每段重加语言标记与围栏；围栏长度取 `max(3, 开启长度, 内容中同字符最长串 + 1)`，头尾围栏计入 `L`；无围栏形态的缩进代码块按普通行处理，不重建围栏 |
| 列表 | `list` 块与列表项 | 整块超长按 item 拆；单个 item 超长按行拆，同一行被拆出的后续片段用与首行标记前缀等宽的空格缩进 |
| 普通块 | 段落、标题、表格、引用、HTML 等 | 整块超长按行拆；单行仍超长时依次尝试句末、空白、字素边界 |
| 装条 | 单元序列 | 贪心拼接，块间原始空白作为连接符；超过 `L` 就换下一条，最多收集预算条数加一条用于判断溢出 |

普通块的单行仍超长时，先找最后一个句末切点（中文 `。！？`，或后随空白/行尾的英文 `. ! ?`，连同其后空白），没有则退到最后一个空白，再没有则按字素边界切。字素切分使用 `Intl.Segmenter`，从切点前约 64 个 UTF-16 单位开始向后找不超过上限的最后一个字素边界；单个字素本身超过剩余预算时退到码点边界，绝不拆开代理对。代码行的超长硬切只用字素规则，不套句子规则。

装条用单元自带的 gap 连接，候选长度不超过 `L` 就并入当前消息，否则结束当前消息并从该单元开始下一条；块间原始空白作为 gap 保留。正文条数超过预算时触发截断重规划：保留前 `B-1` 条正文，截断说明 `回复过长，已截断。` 放到末尾。存在 `session-recreated` 时，说明追加到最后一条正文，先把被截断处未闭合的顶层代码围栏补上，再追加说明；其他提示存在时，说明并入末尾的独立提示消息；没有提示时，说明单独成为最后一条消息。追加说明需要为换行、补围栏与说明文本预留长度，最后一条消息仍须不超过 `L`。

规划结束前自检：消息数在 1 到 `B` 之间、每条非空且不超过 `L`、提示消息出现在预期位置、`truncated` 为真时最后一条确实包含截断说明。任一检查失败或内部抛出异常，都返回降级结果：只有一条 `本次处理失败，请稍后重试。`，`truncated` 为 false、`degraded` 为 true；`planReply` 不向调用方抛出。

<a id="notice-order"></a>

## 提示与顺序

回复信封中的提示类型由 core 与 turn-runner 选择，`busy`、`service-stopping`、`state-unavailable` 由渠道在拒绝路径选择；`planReply` 只负责文案、合并与位置，信封提示的产生条件见 [准入与入队](scheduling.md#ingress-admission) 与 [turn 执行](scheduling.md#turn-runner)。固定文案如下，`truncated` 不是 `NoticeKind`，只由渠道在正文超预算时生成。

| 提示 | 文案 | 触发 |
|---|---|---|
| `session-recreated` | 原会话无法恢复，已开启新会话。 | 恢复失败或 cwd 不一致后重建成功 |
| `turn-failed` | 本次处理失败，请稍后重试。 | prepare 创建失败、turn 失败、无可用最终文本、运行契约异常或 fatal |
| `turn-timeout` | 本次处理超时，请稍后重试。 | 执行截止或准备超时 |
| `empty-reply` | 本次未生成可发送的文本，请稍后重试。 | 最终文本为空 |
| `model-output-limited` | 模型输出达到上限，回复可能不完整。 | `max-tokens` 且有文本 |
| `busy` | 当前排队消息较多，请稍后再试。 | 队列容量拒绝，经渠道独立槽发送 |
| `queue-expired` | 等待时间过长，本条消息未处理，请重新发送。 | 出队时剩余窗口不足 |
| `service-stopping` | 服务正在停止，请稍后重试。 | core 不在 ready 时的 stopping 拒绝 |
| `state-unavailable` | 会话状态暂不可用，请稍后重试。 | core failed 或持久状态不可用 |
| `truncated`（渠道规划） | 回复过长，已截断。 | 正文条数超过预算，需要丢弃末尾内容 |

合并顺序为：重复类型只保留首次出现；`session-recreated` 恒排最前，其余保持 `notices` 输入顺序；合并后用换行连接。有正文时，含恢复提示的消息排在正文之前，其他提示消息排在正文之后；无正文时只发这一条提示消息。信封中的提示消息占一条条数预算，合并后文本超过 `L` 时规划降级。

提示与正文共享同一次投递，因此不承诺必达：提示排在正文之后时，前面任一段失败或窗口到期都会使提示不被尝试；提示排在正文之前时，它可以先发出，而正文仍可能部分失败；提示消息自身失败时，正文同样不会再尝试。

渠道的 `busy`、`service-stopping`、`state-unavailable` 拒绝提示不经过回复端口，而走 `BUSY_NOTICE_SLOTS`（4）个独立并发发送槽：无等待队列、不重试，槽位在发送 Promise 终态（含超时）后释放；每条提示套 `QQ_OUTBOUND_CALL_TIMEOUT_MS`（35 s）期限，超时同样触发出站隔离。拒绝原因到提示的映射、窗口检查与槽满时的记录见 [入站过滤](inbound.md#inbound-filter)。

<a id="reply-port"></a>

## 投递

回复端口在入站过滤通过后创建，绑定本条入站的 `replyTarget.msgId`、`peerId` 与 `expiresAt`，并注入渠道的 `sender`、日志器、`GATEWAY_LIMITS`、墙钟与 `onSendStuck` 回调。`closed`、`consumed` 与最近快照保存在端口闭包内，`attempted`、`confirmed` 是单次 `deliver` 的局部变量；全部状态不落盘、不跨进程恢复，进程退出时未发送的计划直接丢失。发送使用 `bot.sendText({ scope: 'c2c', targetId, msgId }, text)`，即被动回复锚点与 Markdown 文本。

core 对每条被接受的入站最多产生一个回复信封；是否产生以及由谁在何时产生见 [准入与入队](scheduling.md#ingress-admission) 与 [turn 执行](scheduling.md#turn-runner)。端口只消费一个信封：`deliver` 的顺序是，端口已关闭则返回 `closed`（`attempted`/`confirmed` 为 0）；已消费过则返回最近的快照；首次发送前检查墙钟是否达到 `expiresAt`，达到则返回 `expired`（0/0）；否则取 `min(envelope.maxMessages, 4)` 完成规划。规划降级时记一次 `reply_failed`，在窗口内仍会尝试发送唯一的固定失败文案。

规划完成后按计划顺序逐段发送：每段发送前重查关闭标志与窗口，关闭或到期时按已尝试段收敛为 `closed`/`expired` 或 `partial`；每次尝试先把 `attempted` 加一，再以 `QQ_OUTBOUND_CALL_TIMEOUT_MS`（35 s）为总期限调用 `sender.send`。期限涵盖 SDK 取 token 与读取响应体，按段独立计算，不是整条入站共用一个 35 s。

投递报告只包含 `status`、`attempted`、`confirmed`。`attempted` 是已经发起的发送尝试数，`confirmed` 是其中调用成功的条数；失败与超时的尝试不返还额度。

| 状态 | 语义 | 计数 |
|---|---|---|
| `sent` | 计划内的消息全部发送成功 | `attempted` 与 `confirmed` 都等于计划消息数 |
| `partial` | 已有确认段后停止：后续段明确失败，或端口在发送期间被关闭、回复窗口到期 | `attempted` 为已发起尝试数；明确失败时等于 `confirmed + 1`，关闭或到期时等于 `confirmed` |
| `failed` | 第一次发送尝试即明确失败 | `attempted` 为 1，`confirmed` 为 0 |
| `unknown` | 某段超过 35 s 而底层调用仍未结束 | 该段计入 `attempted`、不计入 `confirmed`，余段不发送 |
| `expired` | 首个发送请求之前回复窗口已到期 | `attempted` 与 `confirmed` 均为 0 |
| `closed` | 首个发送请求之前端口已关闭，包括超时隔离后的再次调用 | `attempted` 与 `confirmed` 均为 0 |

明确失败会在该段立即停止：`sender.send` 拒绝且不是超时哨兵时，已有确认段给出 `partial`，否则给出 `failed`；余段不再尝试，不发送错误提示，也不改发普通文本。端口在发送过程中被关闭或窗口到期时同样停止余段，但已成功的段仍计入 `confirmed`，不会被标记为失败。

某段超过 35 s 而底层调用仍未结束时，端口以 `unknown` 结束并关闭自己：该段计入 `attempted`、不计入 `confirmed`，余段不发送，同时调用 `onSendStuck` 触发出站隔离。底层 promise 之后才 settle 的结果被忽略，不改变报告，也不产生未处理的 rejection。`unknown` 不是可重试状态。

`close()` 是幂等置位，不取消已经进行中的发送；关闭后 `deliver` 一律返回 `closed`（0/0），即使此前已有最终报告。首次 `deliver` 在发出第一个请求前就把端口标记为已消费，因此并发或随后的第二次调用不会发送，只返回当时的快照：发送进行中且端口未关闭时为 `unknown`/0/0，正常结束后为最终报告；端口已关闭时仍按 `closed` 优先。超时路径先关闭端口再返回 `unknown`，所以之后的调用得到 `closed`。

端口对 `sent`、`partial`、`unknown` 各记一条 `reply_sent`、`reply_partial`、`reply_unknown`；`failed`、`expired`、`closed` 的报告由消费方 core 或 turn-runner 记为 `reply_failed`，规划降级由端口另记 `reply_failed`。事件字段见 [日志事件](../observability.md#log-events)。

<a id="outbound-isolation"></a>

## 出站隔离

出站隔离由发送超时触发：回复端口的某一段超过 `QQ_OUTBOUND_CALL_TIMEOUT_MS`（35 s）仍未结束，或渠道拒绝提示的 `sendText` 超过同一期限，都会调用渠道的 `isolateOutbound`。该函数只生效一次：置 `outboundIsolated`、记录 `manual_restart_required`、调用 `setState('blocked')`；之后的超时不会重复记录 `manual_restart_required`。

隔离后，新的 SDK 消息在过滤之前被丢弃，只记 `inbound_ignored`（原因 `outbound-isolated`，有合法 `messageId` 时一并记录）；已在途的 ingress 拒绝仍记 `inbound_rejected`，但不再发送 `busy`、`service-stopping` 或 `state-unavailable` 提示。渠道保持 `blocked`，`/readyz` 的 `channels` 条件因渠道不在 `online` 而不满足，见 [QQ 连接与生命周期](inbound.md#qq-connection) 与 [健康探针](../observability.md#readiness)。

隔离是渠道级、面向准入与提示的开关：触发超时的回复端口已在调用前自行关闭，隔离本身只阻止后续入站与拒绝提示，不中止已经越过准入、正在发送的其他端口，也不调用 `bot.stop()`；这些端口会按各自计划继续发送，SDK 连接由渠道的 `stop()` 单独停止。隔离状态在渠道实例内不会自动解除，恢复需要人工重启。

没有自动重试、补发、改发或降级为普通文本的路径；`unknown` 之后再次 `deliver` 得到 `closed`，被隔离的入站也不会收到用户可见的失败提示。

<a id="known-gaps"></a>

## 已知缺口

- 复杂 Markdown 的展示不等价：引用块内的围栏不参与未闭合围栏修复，段落、标题、表格、引用与 HTML 超长时按行硬切，截断后的展示不保证与原文相同。
- 规划降级的原因不可得：`planReply` 把内部异常与自检失败都收敛为同一个 `degraded` 结果，不携带原因；端口只能记录固定描述，无法区分提示过长、条数不足还是内部错误。
- 出站隔离不中止已经越过准入的其他端口：这些端口仍按各自计划发送剩余段，隔离不能保证渠道在置 `blocked` 后完全没有出站请求。
- 35 s 超时后的渠道隔离效果没有渠道层自动化测试：端口测试只覆盖 `onSendStuck` 回调、`unknown` 报告与端口关闭，不覆盖隔离后的入站丢弃、提示抑制与 `blocked` 保持。
