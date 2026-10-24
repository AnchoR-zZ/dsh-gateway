# 架构

本页组织网关的运行组合、宿主接入、职责边界、消息流、状态与固定契约，描述当前实现而非最终架构；项目阶段与稳定性承诺见 [README 的项目阶段](../README.md#项目阶段)。项目定位、安装命令、部署与运维步骤见 [README](../README.md)，长期取舍的依据见 [Notes](notes/README.md)：[同进程 cordis 插件](notes/implemented/architecture/2026-10-21-in-process-cordis-plugin.md)、[可读 bindingId](notes/implemented/architecture/2026-10-22-readable-binding-id.md)、[fail-closed 状态与出站](notes/implemented/architecture/2026-10-21-fail-closed-state-and-outbound.md)。

<a id="composition"></a>

## 运行组合

网关通过 dsh 的 cordis 插件机制接入，安装在专用的 base-backed `gateway` profile 中，与 dsh 同进程运行。dsh 提供模型、工具、agent、会话与持久化基础能力；网关对接聊天平台，不另建 gateway 到 dsh 的子进程协议。首个渠道是 QQ 官方机器人 WebSocket，当前只处理 C2C 私聊纯文本。

网关按渠道无关核心与渠道适配器划分职责。核心不导入 QQ SDK 或 dsh 运行时包，渠道适配器不直接控制 agent 会话。当前 core 的渠道生命周期按单渠道简化：`disconnect` 会停掉整个调度器，多渠道路由需要核心改动；渠道扩展契约见[扩展位置](#extension-points)。

bundle 组合由根目录 [`cordis.patch.yml`](../cordis.patch.yml) 定义：叠加在 `@deepseek-ai/dsh-base` 之上，插入唯一的 `dsh-gateway` 插件行；禁用 goal 系多轮驱动、subagent 与 workflow、遥测与 HMR、HTTP 远程传输、`tool-jobs` / `tool-web` / `tool-skill` / `tool-working-directory` / `session-title-llm` 等非闭环能力，以及 `user-questions` 这个 UI-backed 服务；一次性 shell 不允许后台执行。审批服务保留但策略改为 `never`，permission 预设表增补 `gateway-unattended`（workspace-write + never）承接该组合。dsh patch 对一行 config 是整值替换，修改须重述该行完整 config；完整禁用清单以 patch 文件为准。

core 启动时绑定本机健康探针 `127.0.0.1:17890`：`/livez` 恒 200，`/readyz` 在 core ready、持久状态健康且全部已注册渠道 online 时返回 200，否则 503。零个已注册渠道时集合为空，就绪判定为真；启动窗口内可能先于 QQ 注册返回 200，详细判定见[健康与日志](#health-logs)。监听独占回环地址并兼作单实例占位，端口被占（已有实例）时拒绝启动；进程退出由操作系统释放监听。探针不承担保活职责，也不接受消息、配置修改或控制请求。

<a id="host-integration"></a>

## 宿主接入

插件入口 [`src/index.ts`](../src/index.ts) 向 dsh 声明对 `agents`、`sessions`、`sessionPersistence`、`agentDefaultModel`、`approval`、`sandboxPolicy` 与 `agentLoop` 的服务依赖。任一服务缺失时插件不加载，保持未就绪，不连接 QQ 接流量。插件 config 无字段，网关配置只来自 `DSH_GATEWAY_WORKSPACE` 与 `<workspace>/gateway.config.json`。

`apply` 同步完成配置解析与对象组装：先从 dsh 根上下文取 `dshHomePath()` 取得 dsh home，再解析 workspace、加载配置文件、构造 AgentHost、core 与 QQ 适配器，最后通过 `ctx.effect` 注册启停。`effect` 内的启动顺序是先启动 core（绑定健康监听、加载映射、进入 ready），再启动 QQ；任一步失败都会停止已创建资源。配置错误直接抛错使插件加载失败；异步启动失败不会把异常抛回已返回的 `apply`，而是记录 `manual_restart_required`、停止已创建资源，并让 readiness 保持不可用，不主动退出进程。

dsh ctx 到核心端口的适配集中在 `src/index.ts`：

- 启动时读取一次 `ctx.agentDefaultModel.currentSelection()`，新建与恢复 agent 共用同一份模型选择；修改模型需要重启。
- `createAgent` / `resumeAgent` 在 setup 阶段对 session 调用 `setApprovalPolicy('never')` 与 `setSandboxMode('workspace-write')`；恢复路径同样强制。
- `flushSession` 对同一 session 的并发调用复用同一个 in-flight Promise，成功后允许再次发起。
- `eventsFor` 把 dsh 的 `agent/inbox/claimed` 与 `session/event` 翻译为 turn-runner 消费的事件；订阅必须先于 `followup`，并按 session id 过滤。
- session 事件只投影 `assistant/message`、`tool/result` 与 `turn/end` 的必要字段；其他事件归入 `other`，不参与最终文本选择。

cordis disposer 触发停止时，core 与 QQ 的 `stop` 并行执行。core 停止协调器的顺序是：置 `stopping` → 丢弃内存队列 → 渠道停收 → 等待 `execute` 运行中任务自然结束（超时后中断）→ 停回收器并释放缓存 handle → 排空状态写事务 → 关闭健康监听 → 置 `stopped`（此前已 `failed` 时保持 `failed`）。协调器使用总预算；超限记录 `manual_restart_required` 并结束有界等待，进程退出由 dsh 宿主保证，网关不强制结束自己。配置变更、升级和人工重置都走停止再启动，不热重载。

<a id="boundaries"></a>

## 职责边界

| 参与方 | 负责内容 |
|---|---|
| 聊天平台 | 平台消息事件、用户身份和回复接口 |
| 渠道适配器 | 连接和凭证、平台消息过滤与规范化、回复格式、分段和平台发送限制 |
| 网关核心 | 渠道接入、会话映射、同一用户的串行调度、turn 控制、超时与统一结果 |
| dsh | agent 执行、模型路由、工具、审批、sandbox 与会话历史持久化 |

渠道适配器通过核心提交输入并接收最终结果，不直接控制 agent 会话。网关通过插件入口的宿主适配层使用 dsh 公共插件 API；core 只依赖 AgentHost 端口，不依赖某一聊天平台的 SDK。

包内按模块划分职责（构建为单入口发布，`src/index.ts` 是唯一 cordis 入口与 dsh `AgentHost` 适配层）：

| 模块 | 职责 |
|---|---|
| [`src/index.ts`](../src/index.ts) | 唯一 cordis 插件入口：从 dsh 根上下文取 dsh home、加载配置、dsh ctx 到 AgentHost 与事件源的适配、core 与 QQ 适配器组装、统一启停 |
| [`src/contracts.ts`](../src/contracts.ts) | core 与渠道间的共享 DTO、接口、身份键与固定行为常量 `GATEWAY_LIMITS`，无运行时模块依赖 |
| [`src/config.ts`](../src/config.ts) | 网关配置 schema、默认值与 `DSH_GATEWAY_WORKSPACE` 解析；无文件 IO，无效值拒绝启动 |
| [`src/config-file.ts`](../src/config-file.ts) | 读取 `<workspace>/gateway.config.json`、首次缺失时创建模板，并校验 workspace 与 dsh home 不重叠 |
| [`src/logging.ts`](../src/logging.ts) | 单行 JSON 结构化日志：事件名与字段类型、`error`/`reason` 脱敏、正文日志开关 |
| [`src/core/index.ts`](../src/core/index.ts) | core 总装：渠道注册表与代次、入站防御校验、准入与 execute 管道、健康快照 |
| [`src/core/scheduler.ts`](../src/core/scheduler.ts) | 每用户 FIFO、就绪用户轮转、全局执行槽与容量准入，纯内存 |
| [`src/core/state-store.ts`](../src/core/state-store.ts) | `bindings.json` 的 schema 校验、串行写事务与原子替换，持久化失败转 failed |
| [`src/core/session-manager.ts`](../src/core/session-manager.ts) | 会话新建、恢复与重建，handle 所有权，LRU 缓存与有界释放 |
| [`src/core/turn-runner.ts`](../src/core/turn-runner.ts) | 单次 followup 的执行：事件观察、最终文本选择、终态门、取消与 flush |
| [`src/core/lifecycle.ts`](../src/core/lifecycle.ts) | core 状态机、幂等停止协调器、本机健康探针 server |
| [`src/qq/index.ts`](../src/qq/index.ts) | QQ SDK 组装与生命周期、入站过滤后的渠道状态映射、拒绝提示与出站隔离 |
| [`src/qq/inbound.ts`](../src/qq/inbound.ts) | 入站纯过滤：C2C 文本准入与规范化，无 IO、不导入 SDK |
| [`src/qq/reply-port.ts`](../src/qq/reply-port.ts) | 每入站一次的回复出口：预算消耗、分段顺序发送、出站超时隔离 |
| [`src/qq/markdown.ts`](../src/qq/markdown.ts) | Markdown 回复规划纯函数：切分、长度边界、围栏修复与提示文案 |

<a id="message-flow"></a>

## 消息流

入站链路：QQ SDK（WebSocket 事件）→ `qq/inbound` 纯过滤与规范化 → core ingress 准入（core 状态、渠道代次与形态校验后同步原子入队并立即返回）→ `core/scheduler` 按用户 FIFO、就绪用户轮转分配全局执行槽 → `core/session-manager` prepare（经 `core/state-store` 映射事务新建或恢复会话）→ `core/turn-runner` 先订阅事件再 followup、按终态门选择最终文本并 flush → `qq/reply-port` 经 `qq/markdown` 完成切分规划后按预算分段发送。

```text
QQ message
  -> normalizeC2CMessage（c2c、身份、msgType、附件、正文、timestamp）
  -> core ingress（core 状态、渠道代次、store 健康、形态校验）
       拒绝 busy / stopping / unavailable -> 渠道侧提示或只记日志
       拒绝 expired -> 关闭 reply port，不发送
  -> 每用户 FIFO 接受
  -> 出队（有空闲全局槽）
       expiresAt <= now -> dropped：只记日志、关闭 port、不产生信封
       0 < 剩余窗口 < TURN_DEADLINE_MS + QQ_OUTBOUND_MARGIN_MS
         -> queue-expired 信封；占全局槽与该用户 busy
       否则 -> execute
  -> prepare（缓存 / 新建 / 恢复 / 重建）
       creation-failed -> turn-failed 信封
       fatal -> core failed + state-unavailable 信封
       超时 -> turn-timeout 信封；停机中止 -> 不发送
  -> turn-runner：subscribe -> followup -> claimed -> turn/end -> whenIdle -> deadline 检查
       -> 最终文本与提示类型 -> flush -> deliver
  -> reply port：planReply -> 按预算逐段发送
```

被 core 接受的入站最多启动一个 turn，并在存在终态时产生最多一个回复信封。入队即过期、出队已过期、正常停止丢弃队列和 `stopping` 取消不产生信封；`busy`、`stopping`、`unavailable` 的拒绝提示由渠道适配器用自己的发送槽发出，不经过 core 信封。`queue-expired` 也占全局执行槽与该用户 busy，直到提示发送结束。

同一用户的消息按接受顺序串行处理，不合并连续输入；不同用户在 `maxConcurrent` 内并发。就绪用户按轮转顺序取一条，执行结束后若有积压再排到队尾，避免单个用户长期占满执行槽。等待计数只统计尚未出队的任务；运行计数包含 `execute` 与 `queueExpired` 两类在飞任务。容量超限拒绝最新入站，不挤掉已接受任务。

QQ 入站过滤是纯函数，按以下顺序检查；任一失败整条忽略，不把字段补成默认值：

| 检查 | 拒绝原因 | 说明 |
|---|---|---|
| `kind === 'c2c'` | `not-c2c` | 当前不接群聊、频道或频道私信 |
| `senderId`、`messageId` 非空 | `incomplete-fields` | 缺失或类型不对 |
| `senderId` 匹配 `[A-Za-z0-9_-]+` | `invalid-identity` | 会进入 bindingId 与工作目录名 |
| `replyTarget.msgId` 非空且 `targetId === senderId` | `incomplete-fields` / `target-mismatch` | 被动回复锚点必须属于该用户 |
| `msgType === 0` | `non-text-type` | 缺失也拒绝 |
| 附件缺省、`null` 或空数组 | `has-attachments` | 有附件时整条忽略，不保留文字 |
| `content` 为 trim 后非空字符串 | `empty-content` | 只去首尾空白，保留内部换行与表情标记 |
| `timestamp` 可解析为有限正数 | `bad-timestamp` | `receivedAt` 取平台时间，不延长窗口 |

`receivedAt` 来自平台 `timestamp`，`expiresAt = receivedAt + QQ_PASSIVE_REPLY_WINDOW_MS`。QQ 渠道只装载 SDK 的 `messageFilter()` 一个中间件，保持默认去重窗口，不额外维护去重表；窗口外的重复推送可能再次执行。入站被忽略时只记录原因、类型、附件数和长度，不记录正文。

### QQ 连接与出站

QQ SDK 以 C2C 与群消息共用的 intents 位（当前只处理 C2C）、Markdown 支持、WebSocket 传输和同步 token 预取构造。`ready` / `resumed` 映射为 `online`；可恢复的 `error` 或 `disconnected(willReconnect=true)` 映射为 `reconnecting`，重连委托 SDK；永久断连、认证失败、其他启动失败或出站隔离映射为 `blocked` 并记录 `manual_restart_required`。`start()` 幂等且失败即本实例终局，重启走新实例；`stop()` 同步停止 bot 并有界等待在途入站处理。

SDK 自身日志经脱敏后以独立 `sdk_log` JSON 行写到 stderr（默认），不进入 `GatewayLogEvent` 联合，也不受 `debug` 开关控制。

回复端口先完成全部规划再发第一个请求：提示文案合并为独立消息，恢复提示排在正文之前，无恢复提示时其他提示排在正文之后，无正文时只发提示；正文预算与提示共享 `QQ_MAX_MESSAGES_PER_INBOUND` 与 `QQ_MESSAGE_MAX_LENGTH` 的额度。超长正文按 Markdown 块、列表项、代码行、句子、字素边界逐级切分；代码围栏会补齐并计入长度；超预算时保留前缀并把截断说明放入末尾提示或最后一条正文。规划自检失败时只发一条固定失败文案并记日志。

每次发送前消耗一次预算且失败不返还；每段外层套 `QQ_OUTBOUND_CALL_TIMEOUT_MS` 总期限，涵盖取 token 与响应体读取。明确失败停止余段并报告 `partial` / `failed`；总期限到而底层调用未结束报告 `unknown`、关闭本条 port、停止余段并隔离整个渠道出站，等待人工重启。出站隔离后不再接收新入站、不再发拒绝提示，`setState('blocked')` 使 readiness 不可用。没有重试、补发或改发普通文本的路径。

<a id="session-state"></a>

## 会话与状态

网关维护聊天身份到 dsh 会话的映射，dsh 管理会话历史与执行状态。两者分别持久化：网关不通过直接修改 dsh session 文件实现恢复或重置。

| 状态 | 主人 | 位置 | 重启后行为 |
|---|---|---|---|
| 身份到 session 的映射 | 网关 | `<workspace>/state/bindings.json` | 启动校验并加载；按用户惰性恢复 agent |
| 会话历史、工具调用、turn 边界 | dsh | `<DSH_HOME>/sessions` | 由 dsh 恢复；网关不读不写 |
| 待处理任务、出站计划、发送计数、handles | 网关内存 | 不落盘 | 退出即丢失，不重放 |
| QQ 连接恢复数据 | QQ SDK | 进程内 | 进程内断线由 SDK 恢复；进程重启重新连接 |

网关配置与持久数据固定在 workspace 下：`<workspace>/gateway.config.json` 是唯一配置文件，`<workspace>/state/` 保存映射与备份，`<workspace>/users/<bindingId>/` 是每个身份的工作目录。workspace 由 `DSH_GATEWAY_WORKSPACE` 指定，未设置时默认 `~/.dsh-gateway`；网关不直接读取 `DSH_HOME`，启动时经 dsh 根上下文的 `dshHomePath()` 取得 dsh home，取不到该服务或 workspace 与 dsh home 重叠时拒绝启动。

bindingId 是渠道身份三元组按 `<channelId>_<accountId>_<peerId>` 拼接的可读键，QQ 下即 `qq_<AppID>_<user_openid>`。channelId/accountId 只允许 `[A-Za-z0-9-]`，peerId 允许 `[A-Za-z0-9_-]`，总长不超过 128；同一结果同时作为内存键、映射文件键和工作目录名。大小写按原样保留；Windows 路径不区分大小写，仅大小写不同的 peerId 会落到同一目录。该键包含平台身份信息，应按敏感状态保护。

映射文件形如：

```json
{
  "schemaVersion": 1,
  "revision": 12,
  "bindings": {
    "qq_<AppID>_<user_openid>": {
      "channelId": "qq",
      "accountId": "<AppID>",
      "peerId": "<user_openid>",
      "sessionId": "<UUID>",
      "generation": 2,
      "createdAt": "2026-10-20T12:00:00.000Z",
      "updatedAt": "2026-10-20T13:00:00.000Z"
    }
  }
}
```

`schemaVersion` 必须为 1；`revision` 必须为非负整数，每次成功写事务加一（启动只校验形态，不校验相对旧文件递增）；`bindings` 可缺省为 `{}`。每个键必须等于对应身份重新计算的 bindingId；`sessionId` 为 UUID 且不能被多个 binding 共用；`generation` 为不小于 1 的整数；`createdAt` / `updatedAt` 为受限 ISO 8601 形态。记录中的未知字段会被忽略并在下一次写入时丢弃，手工编辑不应依赖额外字段。

加载时目录或文件不存在视为首次部署，得到空状态且不立即写文件；JSON 损坏、schema 版本不支持、字段校验失败或读取 IO 错误会拒绝启动，不能跳过坏记录继续。首次事务才创建目录和主文件。写入序列为：完整新 JSON 写入同目录临时文件并 fsync → 上一份已提交快照写入另一临时文件并原子替换 `.bak` → 原子替换主文件（Windows 文件占用时在有界期限内退避重试）→ 尽力同步父目录。首次成功事务不产生 `.bak`；失败可能留下临时文件。整个事务受映射写超时约束；超时或写失败后 store 转 failed，保留最近已提交快照，core 停止准入并要求人工处理。没有自动迁移或空状态重建路径。

会话准备按以下情况分派：

| 情况 | 行为 |
|---|---|
| 缓存命中且 sessionId/generation 与映射一致 | 复用 handle，标记 busy，不重新创建 |
| 无映射 | 生成新 UUID → 创建身份目录并校验 realpath 未逃逸 → `createAgent` → flush 成功 → 提交 generation=1 的映射 → 交给 turn-runner |
| 有映射但无缓存 | `resumeAgent` → 校验持久 cwd 等于身份目录 → 清空 agent inbox → 复用原 session |
| 恢复失败或 cwd 不一致 | 释放旧 handle，创建新 UUID，flush 成功后将 sessionId 更新为新的 UUID、generation +1；旧 dsh session 文件保留 |
| 新建/重建失败 | 不更新旧映射、不执行输入，发送 `turn-failed`；store 已 failed 时转 `fatal` 并发送 `state-unavailable` |
| 准备期间被中止 | 晚到 handle 尽力 dispose，不发布回缓存；超时与停机由调用方区分是否发送提示 |

重建过会话时，`session-recreated` 会作为该入站最终信封的第一个提示；提示只随当前回复发送一次，不持久化，也不在下一条消息重提。

空闲 handle 以 LRU 缓存复用：`maxLiveAgents` 是缓存上限，也是阻塞式准入上限；缓存已满且没有可逐出的空闲条目时，新的 prepare 等待容量，直到 turn 预算中止。空闲超过 `idleAgentTtlMs` 的 handle 由回收器释放，回收只释放 handle，不删除映射与 dsh 会话历史。释放序列为可选 `cancel` → `whenIdle` → flush（尽力）→ `dispose`，共用取消清理预算；预算耗尽、`dispose` 失败或 dispose 后 session 仍在 live registry 时，条目标记 stuck 并记录 `manual_restart_required`，不再复用或重复释放。

<a id="reply-semantics"></a>

## 回复与失败语义

turn-runner 只发送最终回复，不转发中间步骤、reasoning 或工具参数。最终文本取最后一条非 `interrupted`、且所有带 id 的 `tool-call` 都已有对应 `tool/result` 的 assistant 消息，按内容顺序拼接其中的 `text` 块。`turn/end` 的原因决定结果：

| `turn/end` reason | 结果 |
|---|---|
| `completed` | 发送最终文本；文本为空时发送 `empty-reply` |
| `max-tokens` | 有文本时发送文本并附 `model-output-limited`；无文本时发送 `empty-reply` |
| `error` / `blocked` / `aborted` / `interrupted` / `forked` / 未知 | 不发送正文，发送 `turn-failed` |
| 没有可用最终消息 | 发送 `turn-failed` |
| 输入从未被 claimed，或 `whenIdle` / followup 等运行契约异常 | 取消、发送 `turn-failed`，handle 走释放路径 |
| flush 失败、超时或无持久化监听者 | 视为 fatal：只发送 `turn-failed`，core 转 failed，handle 不可复用 |

成功与失败终态在发送前都做有界 flush；flush 失败转 fatal。超时路径先封住正常结果出口，取消 agent，发送 `turn-timeout`，并与停稳/flush 并行清理；停止路径不发送任何停机广播。`whenIdle()` 不是成功证明，结果还必须通过目标 turn 的 `turn/end` 与单调时钟截止检查；截止后到达的结果记 `late_result_dropped` 并按超时处理。

固定提示与触发场景：

| 提示 | 文案 | 触发 |
|---|---|---|
| `session-recreated` | 原会话无法恢复，已开启新会话。 | 恢复失败或 cwd 不一致后重建成功 |
| `turn-failed` | 本次处理失败，请稍后重试。 | prepare 创建失败、turn 失败、无可用文本、运行契约异常或 fatal |
| `turn-timeout` | 本次处理超时，请稍后重试。 | 执行截止或准备超时 |
| `empty-reply` | 本次未生成可发送的文本，请稍后重试。 | 最终文本为空 |
| `model-output-limited` | 模型输出达到上限，回复可能不完整。 | `max-tokens` 且有文本 |
| `busy` | 当前排队消息较多，请稍后再试。 | 队列容量拒绝，渠道独立槽发送 |
| `queue-expired` | 等待时间过长，本条消息未处理，请重新发送。 | 出队窗口不足 |
| `service-stopping` | 服务正在停止，请稍后重试。 | core 不在 ready 时的 stopping 拒绝 |
| `state-unavailable` | 会话状态暂不可用，请稍后重试。 | core failed 或持久状态不可用 |
| `truncated`（渠道规划） | 回复过长，已截断。 | 正文超预算，作为末尾提示或最后一条正文的一部分 |

提示顺序按输入顺序，重复提示只保留首次出现；`session-recreated` 恒排最前。有恢复提示时提示消息在正文之前，否则在正文之后；无正文时只发合并后的提示消息。任何提示都受回复窗口、条数预算和发送槽约束，不承诺必达。

回复端口的投递报告状态为 `sent`、`partial`、`failed`、`unknown`、`expired`、`closed`。每段发送前重新检查 port 状态与窗口；失败和未知结果不返还额度。`failed` / `partial` 停止余段但不重试；`unknown` 关闭 port 并触发渠道出站隔离；`expired` / `closed` 不发送。每个 reply port 只接受一次信封；首次 `deliver` 完成前的重复调用返回进行中的 `unknown` / 0 / 0 快照，完成后返回最终报告。`close()` 幂等。

<a id="limits"></a>

## 固定行为常量

以下值集中在 [`src/contracts.ts`](../src/contracts.ts) 的 `GATEWAY_LIMITS`，是行为契约，不提供配置项绕过。

| 常量 | 值 | 用途 |
|---|---|---|
| `TURN_DEADLINE_MS` | 600000 ms | 单任务执行截止，从获得全局槽、开始 prepare 时计时；覆盖 prepare 与模型/工具执行，不含排队和 QQ 发送。结果发送前的 flush 另有单步上限，deadline 检查发生在 flush 之前 |
| `MAP_WRITE_TIMEOUT_MS` | 5000 ms | 单次映射写事务总期限 |
| `SESSION_FLUSH_TIMEOUT_MS` | 5000 ms | turn-runner 等待单次 session flush 的上限；准备与释放路径另受各自预算约束 |
| `QQ_OUTBOUND_CALL_TIMEOUT_MS` | 35000 ms | 单次 QQ 发送调用总期限，涵盖取 token 与响应体读取；拒绝提示同样适用 |
| `QQ_PASSIVE_REPLY_WINDOW_MS` | 3600000 ms | QQ 被动回复有效期，以平台入站时间为起点 |
| `QQ_OUTBOUND_MARGIN_MS` | 180000 ms | 出队窗口为执行预算保留的余量；剩余窗口 < `TURN_DEADLINE_MS + QQ_OUTBOUND_MARGIN_MS` 时发 `queue-expired` |
| `QQ_MAX_MESSAGES_PER_INBOUND` | 4 | 每条入站的最大发送次数，正文、提示与截断说明共享 |
| `QQ_MESSAGE_MAX_LENGTH` | 4000 | 单条 `markdown.content` 上限，UTF-16 code units 保守计数 |
| `BUSY_NOTICE_SLOTS` | 4 | `busy` / `stopping` / `unavailable` 拒绝提示的独立并发发送槽；无等待队列，槽满只记日志 |
| `CANCEL_SETTLE_WAIT_MS` | 5000 ms | 取消后等待 `whenIdle` 的单步上限 |
| `DISPOSE_WAIT_MS` | 5000 ms | 晚到或未发布 handle 的尽力 dispose 上限；也用于 QQ stop 等待在途入站 |
| `CANCEL_CLEANUP_BUDGET_MS` | 10000 ms | 取消后的停稳、flush 与 dispose 共享预算，不按步骤追加；turn 路径从执行截止点起算，空闲/LRU 释放以调用时为起点 |
| `STOP_NATURAL_COMPLETION_WAIT_MS` | 5000 ms | 正常停止时等待 `execute` 运行中任务自然结束的窗口，超时才中断 |
| `CORE_SHUTDOWN_BUDGET_MS` | 25000 ms | core 停止协调器总预算；超限记录 `manual_restart_required`，正常路径仍进入 `stopped`，已 `failed` 则保持 `failed` |

<a id="config-contract"></a>

## 配置契约

网关配置固定为 `<workspace>/gateway.config.json`，UTF-8 JSON；插件 config 无字段。文件在启动时一次性解析，不存在热加载。字段如下：

| 字段 | 必需 / 默认 | 校验与运行时语义 |
|---|---|---|
| `schemaVersion` | 必需，只能为 `1` | 缺失、其他版本或其他类型均拒绝启动 |
| `qqAppId` | 必需，无默认 | trim 后非空字符串；作为 QQ 渠道 accountId，不写入仓库 |
| `qqAppSecret` | 必需，无默认 | trim 后非空字符串；不写入仓库；错误消息不含值 |
| `debug` | 可选，默认 `false` | 布尔值；控制日志器的正文输出开关。当前消息路径没有调用 `debugBody` 的生产代码，开启不会产生正文日志；凭证脱敏仍始终生效 |
| `maxConcurrent` | 可选，默认 `4` | 正安全整数；core 最大并行任务数，包含 prepare、清理、turn 与最终发送 |
| `maxPendingPerPeer` | 可选，默认 `3` | 正安全整数；每用户最大等待消息数，不含活动任务 |
| `maxPendingTotal` | 可选，默认 `100` | 正安全整数；全局最大等待消息数 |
| `maxPendingBytes` | 可选，默认 `8388608` | 正安全整数；等待正文的 UTF-8 总字节上限 |
| `idleAgentTtlMs` | 可选，默认 `900000` | 正安全整数；空闲 handle 的回收时间，不删除映射与会话历史 |
| `maxLiveAgents` | 可选，默认 `32` | 正安全整数且不得小于 `maxConcurrent`；live handle 缓存上限，满载且无可逐出空闲条目时 prepare 阻塞等待容量 |

6 个数值字段必须是正安全整数。未知字段、`null`、类型错误和无效值一律拒绝启动，不静默采用默认值，也不会自动修复已有文件。首次启动时若文件不存在，网关先创建 workspace 再写入包含空 QQ 凭证与默认值的模板；读取时容忍 UTF-8 BOM。模板创建后的校验失败会在错误中附加编辑提示。已有文件绝不覆盖。

`stateDir` 与 `workspaceRoot` 由 workspace 派生为 `<workspace>/state` 与 `<workspace>/users`，不是配置字段。workspace 与 dsh home 相同或互为父目录时拒绝启动；显式 workspace 必须是绝对路径，不展开 `~`。

配置错误由插件入口记录字段/路径与原因后抛出，错误消息不包含 AppSecret。模型选择不在此文件，见[宿主接入](#host-integration)与 README 的部署说明。配置与 `.env` 的安全边界见 README 的“安全与已知边界”。

<a id="health-logs"></a>

## 健康与日志

core 状态为 `starting`、`ready`、`stopping`、`stopped`、`failed`。允许的迁移为 `starting → ready | stopping | failed`、`ready → stopping | failed`、`stopping → stopped | failed`；`stopped` 与 `failed` 是吸收态。渠道状态为 `connecting`、`online`、`reconnecting`、`blocked`。

`GET /livez` 恒返回 200 与 `{"status":"ok"}`；`GET /readyz` 在 core ready、store 未 failed 且所有已注册渠道 online 时返回 200，否则 503。就绪谓词对零个已注册渠道返回真，因此启动窗口内可能先于 QQ 注册返回 200，注册失败也不会被该谓词单独判为不就绪；运维必须同时检查正文的 `channels`。`/readyz` 正文包含 `coreState`、`channels`（按 channelId 聚合）、`pending`（尚未出队任务数）、`running`（execute 与 queueExpired 在飞数）与 `startedAt`（core 进入 ready 的时间）；不含用户标识、sessionId、AppID 或错误原文。其他路径返回 404，非 GET 不提供控制语义。

网关日志是逐行 JSON，默认写 stdout。事件名受 `GatewayLogEvent` 联合类型约束，字段类型由 `LogFields` 描述，`error` 与 `reason` 在序列化前再次脱敏。事件覆盖入站（`inbound_ignored`、`inbound_rejected`、`queued`）、会话（`session_created`、`session_resumed`、`session_recreated`）、turn（`turn_completed`、`turn_failed`、`turn_timeout`、`late_result_dropped`）、投递（`reply_sent`、`reply_partial`、`reply_unknown`、`reply_failed`）、状态与生命周期（`state_failed`、`state_warning`、`channel_reconnecting`、`manual_restart_required`、`shutdown`、`startup_summary`）。

`startup_summary` 记录插件版本、映射与配置 schema、provider/model、有效策略摘要、`maxConcurrent` 与 `maxLiveAgents`，不 dump 环境或完整配置。SDK 内部日志走独立的 `sdk_log` 行（默认 stderr），只经脱敏转发，不属于上述事件联合。

默认不记录消息正文、工具参数或模型推理。原始 user_openid 与 AppID 不作为独立字段输出，但 `bindingId` 由 `<channelId>_<accountId>_<peerId>` 组成，会随日志记录，应按敏感数据保护。`debug` 只控制 `debugBody` 的正文输出，当前没有生产调用点，因此不会产生 `debug_body` 行。

`manual_restart_required` 表示需要人工介入，触发点包括：渠道进入 blocked、认证失败、终端断连或注册失败；QQ 出站隔离；store 持久化失败或 core 转 failed；handle 释放未收敛或 dispose 后 session 仍 live；停机预算耗尽；插件异步启动失败。failed 不会自动恢复，需结束旧进程、修复原因后重启。

<a id="extension-points"></a>

## 扩展位置

| 变更 | 所属边界 |
|---|---|
| 新增聊天渠道或适配平台字段 | 渠道适配器；实现 `src/contracts.ts` 的注册、入站与 ReplyPort 契约，再在插件入口组装。当前 core 的单渠道生命周期限制见[运行组合](#composition) |
| 调整会话路由、调度或 turn 控制 | 网关核心；同步更新本页消息流与会话状态 |
| 调整网关配置字段、默认值或文件格式 | `src/config.ts`、`src/config-file.ts`，并同步本页配置契约与 README 示例 |
| 新增模型、工具或权限能力 | dsh 插件与 profile 组合；模型选择走 `agent-default-model` |
| 调整超时、长度或发送次数等固定行为常量 | `src/contracts.ts` 的 `GATEWAY_LIMITS`，并同步本页固定契约 |
| 调整部署、启动或人工运维操作 | README |
| 解释长期架构取舍 | Notes |

接口、配置与实现入口随代码落地同步到所属文档。需求与详细设计草案保存在工作区 `tmp/`，不作为本页的当前运行契约。
