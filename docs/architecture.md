# 架构

本页是网关的顺序地图：运行组合、宿主接入、职责边界、消息流骨架、状态所有权与扩展入口。每个运行时子系统的当前契约、跨子系统的配置与观测事实在 [文档索引](#doc-index) 列出的页面中，本页只保留理解整体所需的摘要与链接。项目阶段与稳定性承诺见 [README 的项目阶段](../README.md)，项目定位、安装、部署与运维步骤见 [README](../README.md)。

<a id="composition"></a>

## 运行组合

网关通过 dsh 的 cordis 插件机制接入，安装在专用的 base-backed `gateway` profile 中，与 dsh 同进程运行。dsh 提供模型、工具、agent、会话与持久化基础能力；网关对接聊天平台，不另建 gateway 到 dsh 的子进程协议。首个渠道是 QQ 官方机器人 WebSocket，当前只处理 C2C 私聊纯文本。

网关按渠道无关核心与渠道适配器划分职责。核心不导入 QQ SDK 或 dsh 运行时包，渠道适配器不直接控制 agent 会话。QQ 支持多实例并存：每个配置实例一个适配器（`accountId = appId`），共享全局并发限额；单实例断开或失败只注销该实例（丢其排队任务、中断其运行中执行），调度器与其他实例继续。渠道扩展契约见[扩展位置](#extension-points)。

bundle 组合由根目录 [`cordis.patch.yml`](../cordis.patch.yml) 定义：叠加在 `@deepseek-ai/dsh-base` 之上，插入唯一的 `dsh-gateway` 插件行。该禁用清单禁用 goal 系多轮驱动、subagent 与 workflow、遥测与 HMR、HTTP 远程传输、`tool-jobs` / `tool-web` / `tool-skill` / `tool-working-directory` / `session-title-llm` 等非闭环能力，以及 `user-questions` 这个 UI-backed 服务；一次性 shell 不允许后台执行。审批服务保留但策略为 `never`，permission 预设表含 `gateway-unattended`（workspace-write + never），承接该组合。dsh patch 对一行 config 是整值替换，修改须重述该行完整 config；完整清单以 patch 文件为准。

core 启动时绑定本机 HTTP server `127.0.0.1:17890`：`/livez` 恒 200，`/readyz` 在 core ready、持久状态健康且健康渠道表中除 `disabled`/`not_configured` 外的条目全部 online 时返回 200，否则 503；此外挂载仅本机、仅 channel 管理的 POST 路由（`dsh-gateway` CLI 的后端）。监听独占回环地址并兼作单实例占位，端口被占（已有实例）时拒绝启动，进程退出由操作系统释放监听。探针不承担保活职责，也不接受消息或 channel 管理之外的控制请求；判定细节与响应正文见[健康探针与管理路由](observability.md#readiness)。

<a id="host-integration"></a>

## 宿主接入

插件入口 [`src/index.ts`](../src/index.ts) 向 dsh 声明对 `agents`、`sessions`、`sessionPersistence`、`agentDefaultModel`、`approval`、`sandboxPolicy` 与 `agentLoop` 的服务依赖。任一服务缺失时插件不加载，保持未就绪，不连接 QQ 接流量。插件 config 无字段，网关配置只来自 `DSH_GATEWAY_WORKSPACE` 与 `<workspace>/gateway.config.json`，字段见[配置契约](config.md#config-fields)。

`apply` 同步完成配置解析与对象组装：先从 dsh 根上下文取 `dshHomePath()` 取得 dsh home，再解析 workspace、加载配置文件（含 v1 迁移与模板创建）、构造 AgentHost、core、实例管理器与管理路由，最后通过 `ctx.effect` 注册启停。`effect` 内的启动顺序是先启动 core（绑定健康监听、加载映射、进入 ready），再按配置顺序拉起每个 `enabled` 的 QQ 实例；core 启动失败会停止已创建资源，单个实例启动失败只影响该实例（`blocked` + `manual_restart_required`），零实例时 core 照常运行。配置错误直接抛错使插件加载失败；异步启动失败不会把异常抛回已返回的 `apply`，而是记录 `manual_restart_required`、停止已创建资源，并让 readiness 保持不可用，不主动退出进程。channel 实例的添加/启用经管理路由热生效，不重启进程；范围与写冲突规则见[热生效范围与写冲突](config.md#hot-reload-scope)。

dsh ctx 到核心端口的适配集中在 `src/index.ts`：启动期读取 `ctx.agentDefaultModel.currentSelection()`，启动摘要与会话管理器各读一次，全部新建与恢复 agent 共用会话管理器持有的同一份模型选择，修改模型需要重启；`createAgent` / `resumeAgent` 在 setup 阶段对 session 调用 `setApprovalPolicy('never')` 与 `setSandboxMode('workspace-write')`，恢复路径同样强制；`flushSession` 对同一 session 的并发调用复用同一个 in-flight Promise；`eventsFor` 把 dsh 的 `agent/inbox/claimed` 与 `session/event` 翻译为 turn-runner 消费的事件，订阅必须先于 `followup` 并按 session id 过滤；session 事件只投影 `assistant/message`、`tool/result` 与 `turn/end` 的必要字段，其他事件归入 `other`，不参与最终文本选择。事件消费与终态判定见[turn 执行](subsystems/scheduling.md#turn-runner)。

cordis disposer 触发停止时，core 停止协调器与全部渠道实例的 `stop` 并行执行。core 停止协调器的顺序是：置 `stopping` → 丢弃内存队列 → 渠道停收 → 等待 `execute` 运行中任务自然结束（超时后中断）→ 停回收器并释放缓存 handle → 排空状态写事务 → 关闭健康监听 → 置 `stopped`（此前已 `failed` 时保持 `failed`）。渠道实例的 `stop` 在停收后还会经 `ingress.disconnect` 从 core 注销本实例。协调器使用总预算，超限记录 `manual_restart_required` 并结束有界等待，进程退出由 dsh 宿主保证，网关不强制结束自己。非 channel 字段的配置变更、升级和人工重置都走停止再启动，不热重载。

<a id="boundaries"></a>

## 职责边界

| 参与方 | 负责内容 |
|---|---|
| 聊天平台 | 平台消息事件、用户身份和回复接口 |
| 渠道适配器 | 连接和凭证、平台消息过滤与规范化、回复格式、分段和平台发送限制 |
| 网关核心 | 渠道接入、会话映射、同一用户的串行调度、turn 控制、超时与统一结果 |
| dsh | agent 执行、模型路由、工具、审批、sandbox 与会话历史持久化 |

渠道适配器通过核心提交输入并接收最终结果，不直接控制 agent 会话。网关通过插件入口的宿主适配层使用 dsh 公共插件 API；core 只依赖 AgentHost 端口，不依赖某一聊天平台的 SDK。

包内按模块划分职责（`src/index.ts` 是唯一 cordis 入口与唯一组装 QQ 适配器的模块，`src/cli.ts` 是独立 bin 入口）：

| 模块 | 职责 |
|---|---|
| [`src/index.ts`](../src/index.ts) | 唯一 cordis 插件入口：从 dsh 根上下文取 dsh home、加载配置、dsh ctx 到 AgentHost 与事件源的适配、core / 实例管理器 / 管理路由 / QQ 适配器组装、统一启停 |
| [`src/cli.ts`](../src/cli.ts) | `dsh-gateway` bin：channel 子命令的参数解析、交互输入与本机管理路由的瘦 HTTP 客户端 |
| [`src/contracts.ts`](../src/contracts.ts) | core 与渠道间的共享 DTO、接口、身份键与固定行为常量 `GATEWAY_LIMITS`，无运行时模块依赖 |
| [`src/config.ts`](../src/config.ts) | 网关配置 v2 schema、默认值、v1→v2 迁移转换与 `DSH_GATEWAY_WORKSPACE` 解析；无文件 IO，无效值拒绝启动 |
| [`src/config-file.ts`](../src/config-file.ts) | 读取 `<workspace>/gateway.config.json`、首次缺失创建模板、v1 迁移写回、热更新 store（漂移检测 + 原子写），并校验 workspace 与 dsh home 不重叠 |
| [`src/logging.ts`](../src/logging.ts) | 单行 JSON 结构化日志：事件名与字段类型、`error`/`reason` 脱敏、正文日志开关 |
| [`src/core/index.ts`](../src/core/index.ts) | core 总装：渠道注册表与代次、多实例失败隔离、入站防御校验、准入与 execute 管道、健康快照与管理路由挂载 |
| [`src/core/scheduler.ts`](../src/core/scheduler.ts) | 每用户 FIFO、就绪用户轮转、全局执行槽与容量准入、按绑定前缀丢弃，纯内存 |
| [`src/core/state-store.ts`](../src/core/state-store.ts) | `bindings.json` 的 schema 校验、串行写事务与原子替换，持久化失败转 failed |
| [`src/core/session-manager.ts`](../src/core/session-manager.ts) | 会话新建、恢复与重建，handle 所有权，LRU 缓存与有界释放 |
| [`src/core/turn-runner.ts`](../src/core/turn-runner.ts) | 单次 followup 的执行：事件观察、最终文本选择、终态门、取消与 flush |
| [`src/core/lifecycle.ts`](../src/core/lifecycle.ts) | core 状态机、幂等停止协调器、本机健康 server 与管理路由 POST 分派 |
| [`src/channels.ts`](../src/channels.ts) | channel 实例管理器：配置实例清单、运行实例表、按 appId 的替换重启与停止 |
| [`src/admin.ts`](../src/admin.ts) | 本机管理路由：channel add/enable 的校验、凭证校验编排、持久化与生效 |
| [`src/qq/index.ts`](../src/qq/index.ts) | QQ SDK 组装与生命周期、入站过滤后的渠道状态映射、拒绝提示与出站隔离、stop 时注销注册 |
| [`src/qq/inbound.ts`](../src/qq/inbound.ts) | 入站纯过滤：C2C 文本准入与规范化，无 IO、不导入 SDK |
| [`src/qq/reply-port.ts`](../src/qq/reply-port.ts) | 每入站一次的回复出口：预算消耗、分段顺序发送、出站超时隔离 |
| [`src/qq/markdown.ts`](../src/qq/markdown.ts) | Markdown 回复规划纯函数：切分、长度边界、围栏修复与提示文案 |
| [`src/qq/token.ts`](../src/qq/token.ts) | QQ 凭证在线校验：token 端点 POST、超时与 rejected/network 错误分类 |

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

被 core 接受的入站最多启动一个 turn，并在存在终态时产生最多一个回复信封。入队即过期、出队已过期、正常停止丢弃队列和 `stopping` 取消不产生信封；`busy`、`stopping`、`unavailable` 的拒绝提示由渠道适配器用自己的发送槽发出，不经过 core 信封。`queue-expired` 也占全局执行槽与该用户 busy，直到提示发送结束。准入判定与队列规则见[准入与入队](subsystems/scheduling.md#ingress-admission)，提示文案与发送顺序见[提示与顺序](subsystems/outbound.md#notice-order)。

同一用户的消息按接受顺序串行处理，不合并连续输入；不同用户在 `maxConcurrent` 内并发。就绪用户按轮转顺序取一条，执行结束后若有积压再排到队尾，避免单个用户长期占满执行槽。等待计数只统计尚未出队的任务；运行计数包含 `execute` 与 `queueExpired` 两类在飞任务。容量超限拒绝最新入站，不挤掉已接受任务。完整规则见[调度](subsystems/scheduling.md#scheduler)。

QQ 入站过滤、回复窗口与渠道连接语义分别见[入站过滤](subsystems/inbound.md#inbound-filter)、[回复窗口与时间](subsystems/inbound.md#reply-window)与[QQ 连接与生命周期](subsystems/inbound.md#qq-connection)；回复规划与投递见[回复规划与投递](subsystems/outbound.md)。

<a id="state-overview"></a>

## 状态与所有权

网关维护聊天身份到 dsh 会话的映射，dsh 管理会话历史与执行状态。两者分别持久化：网关不通过直接修改 dsh session 文件实现恢复或重置。

| 状态 | 主人 | 位置 | 重启后行为 |
|---|---|---|---|
| 身份到 session 的映射 | 网关 | `<workspace>/state/bindings.json` | 启动校验并加载；按用户惰性恢复 agent |
| 会话历史、工具调用、turn 边界 | dsh | `<DSH_HOME>/sessions` | 由 dsh 恢复；网关不读不写 |
| 待处理任务、出站计划、发送计数、handles | 网关内存 | 不落盘 | 退出即丢失，不重放 |
| QQ 连接恢复数据 | QQ SDK | 进程内 | 进程内断线由 SDK 恢复；进程重启重新连接 |

网关配置与持久数据固定在 workspace 下：`<workspace>/gateway.config.json` 是唯一配置文件，`<workspace>/state/` 保存映射与备份，`<workspace>/users/<bindingId>/` 是每个身份的工作目录。workspace 由 `DSH_GATEWAY_WORKSPACE` 指定，未设置时默认 `~/.dsh-gateway`；网关不直接读取 `DSH_HOME`，启动时经 dsh 根上下文的 `dshHomePath()` 取得 dsh home，取不到该服务或 workspace 与 dsh home 重叠时拒绝启动。解析规则与派生路径见[workspace 与派生路径](config.md#workspace-derivation)。

core 状态为 `starting`、`ready`、`stopping`、`stopped`、`failed`；渠道注册表状态为 `connecting`、`online`、`reconnecting`、`blocked`，健康表另有配置派生的 `disabled` 与 `not_configured`。允许的迁移、吸收态与就绪判定见[健康探针与管理路由](observability.md#readiness)与[状态机](observability.md#state-machines)。映射持久化失败会使 core 转 `failed` 并停止准入，没有自动迁移或空状态重建路径；写事务与恢复约束见[写事务与故障](subsystems/session-state.md#write-transaction)。

<a id="extension-points"></a>

## 扩展位置

| 变更 | 所属边界 |
|---|---|
| 新增聊天渠道或适配平台字段 | 渠道适配器；实现 `src/contracts.ts` 的注册、入站与 ReplyPort 契约，再在插件入口组装。schema 与管理路由按 `channels.<type>` 扩展（本期只支持 `qq`） |
| 调整会话路由、调度或 turn 控制 | 网关核心；同步更新[调度与 turn 控制](subsystems/scheduling.md)与[会话与持久状态](subsystems/session-state.md) |
| 调整网关配置字段、默认值或文件格式 | `src/config.ts`、`src/config-file.ts`，并同步更新[配置与固定常量](config.md)与 README 示例 |
| 新增模型、工具或权限能力 | dsh 插件与 profile 组合；模型选择走 `agent-default-model` |
| 调整超时、长度或发送次数等固定行为常量 | `src/contracts.ts` 的 `GATEWAY_LIMITS`，并同步更新[固定行为常量](config.md#gateway-limits)与相关子系统页 |
| 调整部署、启动或人工运维操作 | README |
| 说明当前行为的约束与代价 | 所属子系统页，或跨子系统的配置与观测页 |

接口、配置与实现入口随代码落地同步到所属文档。需求与详细设计草案保存在工作区 `tmp/`，不作为本页的当前运行契约。

<a id="doc-index"></a>

## 文档索引

| 页面 | 拥有的内容 |
|---|---|
| 本页 | 运行组合、宿主接入、职责边界、消息流骨架、状态所有权、扩展入口 |
| [入站与 QQ 连接](subsystems/inbound.md) | QQ 连接与生命周期、渠道状态映射、入站过滤、回复窗口 |
| [channel 管理](subsystems/channel-admin.md) | 实例管理器、管理路由契约与错误码、CLI、QQ 凭证校验 |
| [调度与 turn 控制](subsystems/scheduling.md) | 准入与入队、调度、turn 执行、超时与清理 |
| [会话与持久状态](subsystems/session-state.md) | 身份键、映射文件、写事务与故障、会话准备、缓存与回收 |
| [回复规划与投递](subsystems/outbound.md) | 回复规划、提示与顺序、投递、出站隔离 |
| [配置与固定常量](config.md) | 配置文件字段、v1 迁移、热生效与写冲突、workspace 与派生路径、`GATEWAY_LIMITS` |
| [健康、状态与日志](observability.md) | 健康探针与管理路由、状态机、日志事件、脱敏与敏感数据 |
