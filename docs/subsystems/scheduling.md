# 调度与 turn 控制

本页描述网关核心如何接纳入站、排队与出队、分配全局执行槽，以及单个 turn 从准备、事件观察到最终文本选择、终态、超时、取消与清理的契约；入站字段过滤与 QQ 连接见 [入站与 QQ 连接](inbound.md#inbound-filter)，会话准备与重建见 [会话与持久状态](session-state.md#prepare)，提示与投递分别见 [提示与顺序](outbound.md#notice-order) 与 [投递](outbound.md#reply-port)，状态机见 [状态机](../observability.md#state-machines)、日志字段见 [日志事件](../observability.md#log-events)，`maxConcurrent` 等配置字段见 [配置与固定常量](../config.md#config-fields)。源码：[`src/core/index.ts`](../../src/core/index.ts)、[`src/core/scheduler.ts`](../../src/core/scheduler.ts)、[`src/core/turn-runner.ts`](../../src/core/turn-runner.ts)、[`src/index.ts`](../../src/index.ts) 与 [`src/contracts.ts`](../../src/contracts.ts)。

<a id="ingress-admission"></a>

## 准入与入队

`ingress.inbound` 在返回前同步完成全部判定；通过后交给 `scheduler.admit`，接受即进入该用户的 FIFO 并立即返回 `requestId`，不等待准备或执行完成。空闲全局槽时，执行管道可能在 `admit` 的同一次调用内已经启动。判定按下表顺序执行，任一失败都只把拒绝原因返回渠道，不启动 turn：

| 顺序 | 检查 | 拒绝原因 |
|---|---|---|
| 1 | core 状态为 `ready` | `failed` → `unavailable`；`starting`、`stopping`、`stopped` → `stopping` |
| 2 | 入站携带的渠道代次仍是该注册的当前代次 | `stopping` |
| 3 | 持久状态存储未处于 failed | `unavailable` |
| 4 | 入站形态：`peerId` 与 `messageId` 为非空字符串、`text` trim 后非空、`replyPolicy.maxMessages` 为正整数、`replyPolicy.expiresAt` 为有限正数、reply port 同时提供 `deliver` 与 `close` | `unavailable` |
| 5 | 身份三元组可拼出合法 `bindingId` | `unavailable` |
| 6 | `scheduler.admit` 的停止、窗口与容量检查 | `stopping`、`expired` 或 `busy` |

第 5 步的字符集与长度规则见 [身份键](session-state.md#binding-id)。第 6 步的 `admit` 依次检查：调度器已停止 → `stopping`；`expiresAt <= now` → 直接关闭该 reply port 并返回 `expired`，不消耗容量、不调用任何回调、不产生回复信封；随后做容量检查。三个等待上限都只统计尚未出队的任务，任一超限返回 `busy`：

| 配置 | 准入判定 | 计数口径 |
|---|---|---|
| `maxPendingPerPeer` | 该用户等待条数加一超过值 → `busy` | 只算该 `bindingId` 尚未出队的任务 |
| `maxPendingTotal` | 全局等待条数加一超过值 → `busy` | 所有用户尚未出队的任务 |
| `maxPendingBytes` | 全局等待正文的 UTF-8 字节数加本条超过值 → `busy` | 只算尚未出队任务的正文 |
| `maxConcurrent` | 不参与准入 | 出队时 `running` 达到该值即暂停出队 |

三个等待上限都是"超过才拒绝"，恰好等于上限仍接受；拒绝不改变任何计数，也不挤掉已接受任务。在飞任务的正文不计入 `pendingBytes`，也不占用该用户的等待条数，因此 `maxConcurrent` 只约束同时在飞的任务数，等待队列的容量由另外三个字段约束；字段默认值与校验见 [配置字段](../config.md#config-fields)。

接受的任务携带 `requestId`、`bindingId`、`messageId`、trim 后正文、`receivedAt`、`expiresAt`、reply port 与全局递增的接受序号，拒绝不分配序号。core 在调用 `admit` 前把身份与 `maxMessages` 记入按 `requestId` 索引的内存表，供出队后的准备与回复信封使用，任务完成、在出队时被丢弃、被停止丢弃或准入被拒时删除。

reply port 也随任务流转：入队即过期时调度器直接关闭它，该任务未被接受；被接受的任务由 core 在结束、丢弃或停止丢弃时关闭 port，投递由 core 或 turn-runner 发起。

每个被接受的入站最多启动一个 turn，并且最多产生一个回复信封。`prepare` 返回 `fatal` 或 `creation-failed` 时各产生一个；出队时判定为 `queue-expired`、turn 以正常结果、超时、fatal 或运行契约异常收尾时也各产生一个。入队即过期、出队已过期、正常停止丢弃队列、准备在截止点前被停机中止与 `stopping` 终态不产生。

`busy`、`stopping`、`unavailable` 的拒绝只把原因交回渠道，由渠道用自己的发送槽发提示，core 不产生回复信封；`expired` 的 reply port 已经关闭。拒绝提示的映射与发送见 [入站过滤](inbound.md#inbound-filter) 与 [提示与顺序](outbound.md#notice-order)。

<a id="scheduler"></a>

## 调度

调度器是纯内存结构：每个 `bindingId` 一个 FIFO、一个 `busy` 标记与一个就绪标记，另有全局就绪轮转队列、`pendingTotal`、`pendingBytes`、`running` 与接受序号；它不访问会话或映射文件，也不把待处理消息提前写入 agent inbox，排队期间只保存网关 DTO。进程退出后队列与计数直接丢失，不重放。

计数口径固定：`pendingTotal` 与 `pendingBytes` 只包含已接受、尚未出队的任务；`running` 包含 `execute` 与 `queueExpired` 两类在飞任务；`waitingPeers` 是就绪轮转队列长度。同一 `bindingId` 最多一个在飞任务，它的执行、清理与出站处理全部结束后才会出队该用户的下一条。健康探针的 `pending` 与 `running` 分别取 `pendingTotal` 与 `running`，探针判定见 [健康探针](../observability.md#readiness)。

任务 promise 落定后释放一个全局槽并清除 `busy`；若该用户仍有积压，就把该 `bindingId` 排到就绪队列尾部，再继续 `pump`。`pump` 在 `running < maxConcurrent` 且就绪队列非空时，从队头取一个用户、再取该用户 FIFO 的队头一条，因此不同用户按"就绪用户轮转"获得执行机会，同一用户保持接受顺序；新接受的任务在 `busy` 时只排队，不重复进入就绪队列。FIFO 为空且无在飞任务时，该用户的调度条目被删除。

出队时先按墙钟做窗口判定，再决定走哪条路径：

```text
expiresAt <= now
  -> dropped：不发送、不占槽、不置 busy，只关闭 port，继续轮转
expiresAt - now < TURN_DEADLINE_MS + QQ_OUTBOUND_MARGIN_MS
  -> queueExpired：发送 queue-expired 提示，占全局槽与该用户 busy 直到投递结束
否则
  -> execute：进入准备与 turn 执行
```

`queue-expired` 的阈值是 `TURN_DEADLINE_MS`（600,000 ms）加 `QQ_OUTBOUND_MARGIN_MS`（180,000 ms），即剩余窗口不足 780,000 ms；恰好等于阈值仍执行。`dropped` 路径由 core 只记录过期原因并关闭 port，不发送任何内容，也不产生回复信封；`queueExpired` 路径发送 `queue-expired` 提示并关闭 port，在这条提示结束前占用全局执行槽与该用户的 `busy`，因此不会和同一用户的下一条任务并行。

`stop()` 幂等：置 `stopping`、清空就绪队列，对每个尚未出队的任务恰好调用一次 `onStopDropped`，由 core 只记录并关闭 port，不发送停机提示；等待计数随即归零，在飞任务不受影响，其槽位在 promise 落定后自然释放。`stop()` 之后 `admit` 一律返回 `stopping`，已接受任务不会被重新排队或补发。

`dropBindingPrefix(prefix)` 供渠道注销（`disconnect`）按实例丢弃，与 `stop()` 互不影响调度器状态：对 bindingId 以 `<channelId>_<accountId>_` 为前缀的每个用户清空等待队列（每个任务恰好调用一次 `onStopDropped`）、移出就绪轮转并回收空闲条目（busy 条目留待在飞 promise 落定后回收），全局等待计数相应扣减；其余用户、全局调度与在飞任务不受影响，同账号随后可用新实例重新注册（见[状态机](../observability.md#state-machines)）。

`execute` 或 `queueExpired` 回调 reject 不阻塞调度：调度器记录失败并按完成处理，释放槽与 `busy` 后继续轮转；`dropped` 回调同步抛错或返回 rejected promise 只记录，不占槽也不影响后续任务。

<a id="turn-runner"></a>

## turn 执行

出队后的 `execute` 管道先以获得全局槽的时刻计算单调截止 `deadlineMono = mono() + TURN_DEADLINE_MS`，再带 abort signal 调用 `sessions.prepare`；成功后把 handle、trim 正文、`recreated`、`runToken`、`maxMessages`、`deadlineMono`、投递函数与 `onFatal` 交给 turn-runner。prepare 的分派、缓存与重建见 [会话准备](session-state.md#prepare)；本页只负责其截止时序：准备与后续执行共用同一截止预算，core 的截止定时器到点只 abort 准备的 signal，进入 runner 后不再影响执行。

准备成功但已到截止点时，core 不进入 turn，按超时收尾并释放 handle；准备在截止点前被停机中止时只关闭 port、不产生提示。

turn-runner 的主流程按以下顺序推进，并且只允许一个终态路径获得结果所有权：

```text
创建 UserMessage
  -> subscribe（先于 followup）
  -> followup
  -> 等待本消息被 claimed（messageId 匹配）并取得 turn
  -> 等待该 turn 的 turn/end
  -> 等待 whenIdle()
  -> 单调时钟检查截止点
       已到 -> 记录 late_result_dropped，走超时终态
       未到 -> 赢下终态门，选择最终文本或失败原因
  -> 有界 flush -> 投递唯一回复信封 -> 清理（取消订阅、清除定时器）
```

订阅必须先于 `followup` 建立，否则 `agent/inbox/claimed` 可能先到而丢失关联；claimed 只在 `messageId` 等于本次 `UserMessage` 且尚未关联 turn 时生效。`assistant/message` 与 `tool/result` 只收集 `turn` 等于已关联 turn 的事件，`turn/end` 只接受该 turn 的第一个 reason；其他事件归入 `other`，不参与结果选择。事件回调只做同步状态记录与唤醒，不在回调内等待取消、flush 或投递，等待与清理都由主流程串行推进。

`whenIdle()` 只表示没有活动驱动，不构成成功证明；成功还必须由目标 turn 的 `turn/end` 与单调时钟截止检查共同确认。

终态门在 `result-ready`、`timeout` 与 `stopping` 之间只接受第一个同步提交，后到的提交只做清理；截止定时器、`stopInterrupt` 与正常结果路径因此不会各自发出一个回复信封。

最终文本从后向前扫描已收集的 assistant 消息，跳过 `interrupted` 为 `true` 的消息，以及任一 `tool-call` 块（带 `id`）尚无对应 `tool/result` 的消息；取第一条满足条件的消息，按内容顺序拼接其中所有 `text` 块的 `text`。中间步骤、`reasoning` 块与工具调用不会进入回复；没有满足条件的消息即为"无可用最终消息"。

`turn/end` 的 `reason.kind` 决定正文与提示；`completed` 与 `max-tokens` 先按上述规则选择最终文本：

| `reason.kind` | 正文 | 提示 |
|---|---|---|
| `completed`：有最终文本 | 发送最终文本 | 无 |
| `completed`：最终文本为空 | 不发送正文 | `empty-reply` |
| `completed` 或 `max-tokens`：无可用最终消息 | 不发送正文 | `turn-failed` |
| `max-tokens`：有最终文本 | 发送最终文本 | `model-output-limited` |
| `max-tokens`：最终文本为空 | 不发送正文 | `empty-reply` |
| `error`、`blocked`、`aborted`、`interrupted`、`forked` 或未知 kind | 不发送正文 | `turn-failed` |

每个回复信封携带可选的 `text`、`notices` 与 `maxMessages`；`maxMessages` 原样来自入站的 `replyPolicy`，core 不放大。准备阶段重建过会话时，`session-recreated` 始终是 `notices` 的第一项；提示的合并、排序与文案由回复规划负责（见 [提示与顺序](outbound.md#notice-order)）。

handle 健康度与 turn 成败解耦：`turn/end` 为 `error`、`blocked` 等失败原因时，只要停稳且 flush 成功，handle 仍标记为可复用并交回缓存；超时路径停稳且 flush 成功时同样可复用，flush 未成功或未停稳则标记为需释放。`healthy` 的 handle 交回 [缓存与回收](session-state.md#lru-recycle)，`needs-release` 的 handle 进入下述清理预算。

成功与失败终态在投递前都执行一次有界 flush，上限为 `SESSION_FLUSH_TIMEOUT_MS`（5,000 ms）；同一 session 的并发 flush 在宿主适配层复用同一个 in-flight Promise，落定后移除，后续 flush 会重新发起。这次终态 flush 若返回 `false`、reject 或超时，一律按 fatal 收尾：不发送正文，产生失败回复信封（`turn-failed`，重建过会话时另有 `session-recreated`），调用 `onFatal` 让 core 转 failed，并把 handle 标记为需释放。

turn-runner 在正常结果、超时、fatal 与运行契约异常路径各调用一次 `deliver`；`stopping` 路径不投递。投递本身抛错只记录，不改变 turn 结果，投递报告的状态与失败语义见 [投递](outbound.md#reply-port)。

运行契约异常包括输入从未被 claimed（尚无 claimed 记录时先观察到 `turn/end`）、`whenIdle()` reject，以及 `createUserMessage`、订阅或 `followup` 抛错。这些路径先同步赢下终态门，防止截止定时器或停机中断并行产生第二个回复信封；随后取消 agent、有界 flush、产生失败回复信封，并把 handle 标记为需释放。若终态门已被其他路径赢下，该路径直接返回，回复信封与清理归获胜路径。

<a id="cancellation"></a>

## 超时、取消与清理

执行截止 `TURN_DEADLINE_MS`（600,000 ms）从获得全局执行槽、开始准备时计时，覆盖准备与 turn 内的模型、工具执行；排队等待不计入，回复发送也不在截止范围内，因为截止检查在 flush 与投递之前完成。turn-runner 启动时按剩余时间设置截止定时器，并在 `whenIdle()` 之后、赢下结果路径之前再读一次单调时钟，因此定时器被事件循环推迟时仍会丢弃越界结果。

截止先到时终态门封住正常结果出口：取消 agent（`cancel({ kind: 'user' })`）、记录超时、产生 `turn-timeout` 信封，并与取消后的清理并行推进。清理先以 `CANCEL_SETTLE_WAIT_MS`（5,000 ms）等待 `whenIdle()`，停稳后再以 `SESSION_FLUSH_TIMEOUT_MS`（5,000 ms）尽力 flush；超时路径的清理 flush 失败只记录，不转 fatal。投递与清理都结束后 run 才返回 `timeout`。

终态之后，目标 turn 的晚到 `turn/end` 只记录 `late_result_dropped`，不再投递；即使最终文本与 `turn/end` 已就绪，只要在 `whenIdle()` 之后发现已越过截止点，也记录 `late_result_dropped` 并按超时处理。一个已进入终态的 run 不会被晚到事件改写为成功或产生第二个回复信封。

停机时 core 的停止协调器先调用 `scheduler.stop()` 丢弃等待队列，渠道停收后给在飞的 `execute` 任务一个自然结束窗口 `STOP_NATURAL_COMPLETION_WAIT_MS`（5,000 ms）；超时后对每个活动 run 同时 abort 准备 signal 并调用 `runner.stopInterrupt(runToken)`，后者向该 run 的终态门提交 `stopping`，对已结束或未知的 `runToken` 是 no-op。`stopping` 路径取消 agent、等待停稳与 flush，但不产生回复信封；停止协调器的其余步骤与总预算见 [运行组合](../architecture.md#composition)。

`needs-release` 的 handle 由 core 交给会话管理层做有界释放。释放预算取取消清理总预算 `CANCEL_CLEANUP_BUDGET_MS`（10,000 ms）与"截止点 + 该预算 - 当前时刻"的较小值，停稳、flush 与 dispose 共用该预算且不按步骤追加；晚于截止点的终态因此只剩扣除已超时部分后的预算。

释放返回 `timeout` 时 core 转 failed 并停止准入，需要人工重启；释放序列与 stuck 处理见 [缓存与回收](session-state.md#lru-recycle)。所有超时、取消与清理预算的常量值见 [固定行为常量](../config.md#gateway-limits)。

<a id="known-gaps"></a>

## 已知缺口

- turn 的截止、取消、flush 与事件时序只在替身 host 与替身事件源上验证：真实 dsh 的 `session/event` 顺序、`whenIdle()` 与持久化行为没有自动化覆盖，端到端偏差只能在真实环境联调中发现（覆盖范围见 [README](../../README.md)）。
