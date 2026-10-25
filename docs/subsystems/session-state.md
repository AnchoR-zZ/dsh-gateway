# 会话与持久状态

本页描述网关如何把聊天身份绑定到 dsh 会话：身份键、`bindings.json` 映射、串行写事务、会话准备与 handle 缓存回收；配置字段与 workspace 解析见 [配置与固定常量](../config.md#config-fields)，调度与 turn 控制见 [调度](scheduling.md#scheduler)，持久状态失败后的就绪与状态机见 [健康、状态与日志](../observability.md#state-machines)。源码：[`src/core/state-store.ts`](../../src/core/state-store.ts)、[`src/core/session-manager.ts`](../../src/core/session-manager.ts)、[`src/index.ts`](../../src/index.ts) 与 [`src/contracts.ts`](../../src/contracts.ts)。

<a id="binding-id"></a>

## 身份键

`bindingId` 是渠道身份三元组按 `<channelId>_<accountId>_<peerId>` 拼接的可读键，QQ 下为 `qq_<AppID>_<user_openid>`。同一个字符串同时是内存键、`bindings.json` 的键和身份工作目录名（`<workspaceRoot>/<bindingId>`），因此它被平台身份信息直接决定，应按敏感数据处理。

身份三段必须满足以下字符与长度规则；任一失败则无法计算 `bindingId`。

| 片段 | 允许字符 | 约束 |
|---|---|---|
| `channelId` | `[A-Za-z0-9-]+` | 不含 `_`，保证前两段可无歧义拆分 |
| `accountId` | `[A-Za-z0-9-]+` | 不含 `_`，同上 |
| `peerId` | `[A-Za-z0-9_-]+` | 允许 `_`，QQ openid 内部的 `_` 不需要转义 |
| 整体 | 仅上述 ASCII 字符 | 总长不超过 128 个字符 |

大小写按原样保留，不做折叠；Windows 路径不区分大小写，仅大小写不同的 `peerId` 会落到同一个身份目录。无法计算 `bindingId` 的身份不会进入会话流程：core 在入站形态检查阶段以 `unavailable` 拒绝，`prepare` 返回 `creation-failed` 且不创建目录或 agent；QQ 侧的身份过滤见 [入站过滤](inbound.md#inbound-filter)。

<a id="bindings-file"></a>

## 映射文件

网关持久化会话映射的唯一文件是 `<workspace>/state/bindings.json`，由状态存储独占读写；会话历史、工具调用与 turn 边界归 dsh 所有，网关不读不写（状态归属总览见 [状态总览](../architecture.md#state-overview)）。文件缺失表示首次部署，不是错误。

文档级字段规则如下；任一不满足都会拒绝启动，不做部分加载。

| 字段 | 规则 |
|---|---|
| `schemaVersion` | 必须为 `1`；缺失或其他值均拒绝 |
| `revision` | 必须为非负整数；每次成功写事务加一；启动只校验形态，不要求大于 `.bak` 或旧文件中的值 |
| `bindings` | 可缺省，缺省视为 `{}`；存在时必须是对象，键为 `bindingId`，值为记录 |

`bindings` 的键与记录必须同时通过以下校验。

| 位置 | 规则 |
|---|---|
| 键 | 必须是合法的 `bindingId` 形态（两段 `_` 分隔、各段非空且符合字符集），且等于用记录三元组重新计算的结果 |
| `channelId` / `accountId` / `peerId` | 非空字符串；能重新拼出该键；字符集或长度不合法按身份错误拒绝 |
| `sessionId` | UUID（8-4-4-4-12 位十六进制，大小写不敏感，不限定 UUID 版本）；同一文件内不得被两个记录共用 |
| `generation` | 整数且不小于 1 |
| `createdAt` / `updatedAt` | 受限 ISO 8601 日期时间形态，且能被 `Date.parse` 解析 |
| 未列出的字段 | 读取时忽略，下一次写事务按规范化结果序列化时丢弃 |

主文件与 `.bak` 都使用 2 空格缩进的 UTF-8 JSON。手工编辑必须满足上表全部规则，否则启动被拒绝；`.bak` 保存上一份已提交快照，但加载只读主文件，主文件损坏时不会回退到 `.bak`。

加载发生在 core 进入 ready 之前：`state/` 或主文件不存在（`ENOENT`）时得到空快照、`revision=0`，不立即写文件，首个写事务才创建目录与主文件；文件存在时逐项校验 JSON、schema、revision、键与每条记录。任一失败都会抛 `StateStoreError`，`core.start()` 关闭健康监听并抛错，启动链记录 `manual_restart_required` 后停止已创建资源。坏记录不会被跳过，也不存在以空状态重建或自动迁移 schema 的路径。加载成功后再次 `load()` 是 no-op，不重置已提交快照；加载失败只拒绝本次启动，不把 store 置为 `failed`，`failed` 仅由写事务的持久化失败或超时触发。

<a id="write-transaction"></a>

## 写事务与故障

`runTransaction()` 是修改映射的唯一入口，所有事务在一个进程内串行队列上执行。事务从最新已提交快照派生草稿，`mutate` 同步或异步修改草稿；持久化与快照发布完成后队列才推进，事务之间不交错。session-manager 是唯一提交映射事务的模块：首次创建写入 `generation=1`，重建写入新 `sessionId` 与 `generation+1`，每次提交一个事务。

```text
1. 首次落盘前确认 stateDir 存在
2. 完整新 JSON 写入同目录临时文件 bindings.json.tmp-<n>：open → write → fsync → close
3. 若存在上一份已提交快照：写入另一个临时文件，再原子替换 bindings.json.bak
4. 原子替换主文件 bindings.json；Windows 文件占用错误退避重试
5. 尽力 fsync 父目录
```

`mutate` 抛错或草稿校验失败时不写盘，`revision`、内存快照与 store 状态都不变，store 继续可用。持久化阶段从写入开始共享一个 `MAP_WRITE_TIMEOUT_MS` 期限（值见 [固定行为常量](../config.md#gateway-limits)），每个文件操作都与该期限竞速。主文件替换在 `EPERM`、`EBUSY`、`ENOTEMPTY`、`EACCES` 下首次失败后最多再重试 3 次、每次间隔 100 ms，重试计入同一期限。父目录 fsync 失败时每个 store 实例只记录一次告警，不回滚已成功的事务。首次成功事务不产生 `.bak`；失败可能留下 `bindings.json.tmp-<n>`，`.bak` 存在时保存上一份已提交快照。

持久化失败或超时后事务 reject，store 进入 `failed`：保留最近已提交的内存快照，每个 `onFailed` 监听器恰好触发一次，后续事务直接拒绝。`failed` 是吸收态，没有自动恢复，只能重建 store。core 订阅该回调后转入 failed 并停止准入，后续入站以 `unavailable` 拒绝；就绪判定与状态迁移见 [健康、状态与日志](../observability.md#state-machines)，准入顺序见 [准入与入队](scheduling.md#ingress-admission)。

`flushNow()` 等待在途事务与队列排空后返回，不产生新写入，也不等待超时后被放弃的底层 I/O。session flush 是另一条持久化路径：新建与重建在发布映射前要求 flush 返回 `true`，返回 `false`（无持久化监听者）、reject 或准备中止都阻止映射提交，且准备路径的 flush 没有单独超时，只受 turn 执行预算与中止信号约束；turn 发送前的最终 flush 另受 `SESSION_FLUSH_TIMEOUT_MS` 上限约束，超时、失败或无监听者按 fatal 处理（见 [turn 执行](scheduling.md#turn-runner)）。同一 session 的并发 flush 在宿主适配层复用同一个 in-flight Promise（见 [宿主接入](../architecture.md#host-integration)）。

`revision` 是文档级计数，每次成功事务在已提交值上加一，与草稿内容是否变化无关。`generation` 是记录级重建计数：首次创建为 1，每次重建加一；缓存命中要求缓存条目的 `sessionId` 与 `generation` 同时等于映射。重建换用新 `sessionId`、保留 `createdAt`、刷新 `updatedAt`，旧 dsh 会话文件保留。

<a id="prepare"></a>

## 会话准备

core 在 execute 开始时调用 `prepare({ identity, signal })`，准备与后续执行共用从获得全局执行槽时开始的 `TURN_DEADLINE_MS` 执行预算，超时与停机收尾见 [超时、取消与清理](scheduling.md#cancellation)。同一 `bindingId` 的并发 prepare 不在管理器内互斥，依赖调度器的同一身份串行（见 [调度](scheduling.md#scheduler)）；准备成功返回的 handle 处于 busy，调用方在 turn 结束后用 `markIdle` 归还。

| 情况 | 行为 |
|---|---|
| 缓存命中 | 条目为 `active` 且 `sessionId`/`generation` 与当前映射一致：复用同一 handle，标记 busy，刷新 LRU 与空闲时间戳，不调用宿主 |
| 缓存与映射不一致 | 条目移出缓存并异步释放旧 handle，随后按映射继续恢复或新建 |
| 无映射 | 生成新 UUID → 创建并校验身份目录 → `createAgent` → flush 为 `true` → 事务提交 `generation=1` 的映射 → 发布缓存 → 交给 turn-runner |
| 有映射但无缓存 | `resumeAgent` 原 `sessionId` → 持久 session 的 cwd 经 `realpath` 后必须等于身份目录 → 清空 agent inbox → 复用原 session，`generation` 不变 |
| 恢复失败 | resume 抛错、cwd 不一致或身份目录校验失败：释放已取得的 handle，生成新 UUID，`createAgent` → flush → 事务写入新 `sessionId` 与 `generation+1`，旧 dsh 会话文件保留 |
| 新建或重建失败 | 不更新旧映射、不执行输入；返回 `creation-failed`，core 发送 `turn-failed` |
| 持久状态不可用 | store 已 `failed` 或提交事务失败且 store 转 `failed`：返回 `fatal`，core 转 failed 并发送 `state-unavailable` |
| 准备被中止 | 返回 `aborted`；已取得但未发布的 handle 在 `DISPOSE_WAIT_MS` 内尽力 dispose，不进缓存；映射若已提交则保留，本次不执行 |
| 无法计算身份键 | 返回 `creation-failed`，不创建目录或 agent |

创建与重建都先解析身份目录：校验 `bindingId` 形态，递归创建 `<workspaceRoot>/<bindingId>`，再对 workspace 根与目录做 `realpath`，要求目录等于根下的该键（Windows 比较忽略大小写）；目录经符号链接或 junction 指向边界外时拒绝并返回 `creation-failed`。重建复用现有目录，不删除目录内容。workspace 根的解析见 [workspace 与派生路径](../config.md#workspace-derivation)。

新建与恢复都在 dsh 的 setup 阶段强制写入 `setApprovalPolicy('never')` 与 `setSandboxMode('workspace-write')`；两者是幂等 append，恢复的会话同样强制。模型选择在管理器构造时读取一次，之后所有 agent 共用，变更需要重启（宿主适配细节见 [宿主接入](../architecture.md#host-integration)）。

准备结果由 core 收尾：`creation-failed` 只影响本条入站（首次创建不留下映射，重建保留旧映射）并发送 `turn-failed`；`fatal` 使 core 转 failed 并发送 `state-unavailable`；`aborted` 在超过执行截止时发送 `turn-timeout`，停机中止不发送提示。提示文案、合并与排序见 [提示与顺序](outbound.md#notice-order)。

重建成功时 `recreated=true` 随准备结果返回，core 把它传给 turn-runner，`session-recreated` 作为该入站唯一信封的第一条提示发送，之后不持久化，下一条消息不会重提。重建过且准备阶段耗尽执行预算时，core 直接发送 `session-recreated` 与 `turn-timeout` 的提示信封；未重建时只发 `turn-timeout`。

<a id="lru-recycle"></a>

## 缓存与回收

缓存是进程内按 `bindingId` 索引的 `Map`，条目保存 handle、`sessionId`、`generation`、busy 标志、最近使用时间（单调时钟）与 LRU 序号，状态为 `active`、`releasing` 或 `stuck`。缓存不落盘，进程重启后为空，下一条入站按映射恢复。`stats().liveHandles` 统计全部条目（含 releasing 与 stuck），`busyHandles` 统计 busy 条目。

`maxLiveAgents` 同时是缓存条数上限和阻塞式准入上限（字段见 [配置字段](../config.md#config-fields)）。缓存已满时 prepare 先同步逐出 LRU 序号最小、状态为 `active` 且不 busy 的条目并异步释放；没有可逐出条目就等待容量事件或中止信号，中止返回 `aborted`。`releasing` 与 `stuck` 条目不可逐出。

turn 以健康 handle 结束时 core 调用 `markIdle`：清 busy、刷新 TTL 与 LRU 序号并唤醒容量等待者；未知或已移除的 handle 是 no-op。busy 条目不会被 LRU 逐出，也不会被空闲回收器释放。

回收器由 `start()` 启动、`stop()` 停止：默认检查周期为 `clamp(idleAgentTtlMs/4, 1000, 30000)` ms，判定只看单调时钟，`active`、不 busy 且 `lastUsedAt` 不晚于 `now - idleAgentTtlMs` 的条目走 `releaseHandle`（不带 cancel）。回收只释放 handle，不删除映射，也不删除 dsh 会话历史；`stop()` 只清定时器，停机释放由 core 逐个调用 `releaseHandle`。

释放序列为可选的 `cancel({ kind: 'user' })` → `whenIdle` → flush（尽力）→ `dispose`，各步共用同一截止（默认 `CANCEL_CLEANUP_BUDGET_MS`，调用方也可传入其他期限），全部按单调时钟计算。预算耗尽在对应步骤返回 `timeout`；`dispose` 抛错同样返回 `timeout`；`whenIdle` 或 flush 的非预算错误只记录并继续。

返回 `timeout` 的缓存条目转 `stuck` 并记录 `manual_restart_required`，之后不再复用、不再重复释放，但仍计入 `liveHandles` 并占用缓存名额。`dispose` 成功而 `isAgentLive` 仍为 `true` 同样按未收敛处理并转 `stuck`。只有释放成功且 session 已退出 live registry 才移除条目并唤醒容量等待者。被 LRU 逐出的空闲 handle 在释放超时时记 `manual_restart_required`，dispose 结束后仍 live 记告警；因映射不一致被移除的旧 handle 只在释放超时时记 `manual_restart_required`。这两条路径都没有缓存条目可标记。

handle 的所有权属于 session-manager，从 `createAgent`/`resumeAgent` 返回起保存到异步 `dispose` 结束；`isAgentLive` 只用于释放收敛判定，释放统一走 `releaseHandle` 的预算序列。准备中止或失败时，已取得但未发布的 handle 在 `DISPOSE_WAIT_MS` 内尽力 dispose，不发布进缓存；映射若已提交则保留，下一次入站按映射恢复。

停机时 core 先停止回收器，再枚举缓存中的全部 handle（含 releasing 与 stuck）逐个调用 `releaseHandle`，每项使用剩余的停机预算，`stuck` 条目立即返回 `timeout`。随后 `store.flushNow()` 排空状态写事务，整体受停机总预算约束，超限记录 `manual_restart_required`（预算常量见 [固定行为常量](../config.md#gateway-limits)）。

<a id="known-gaps"></a>

## 已知缺口

- 写事务超时后被放弃的底层写操作无法从 JS 取消，`flushNow()` 也不等待；失败事务的底层操作仍可能在失败后完成，留下临时文件或替换主文件，需要人工核对 `state/` 下的 `bindings.json`、`.bak` 与遗留 `.tmp-*`。
- `stuck` 条目永久占用缓存名额且不会被逐出；缓存被 `stuck` 条目占满时，后续 `prepare` 只能等待容量直到执行预算中止并返回 `aborted`，恢复路径是重启进程。
