# Agent Note: 网关作为 dsh cordis 插件同进程运行

Status: implemented

## Problem

聊天网关需要在每个用户身份上控制 dsh 的会话创建、恢复、followup、取消、flush 与 sandbox 策略，同时把聊天平台的连接、过滤和回复发送留在网关侧。初版要求手动启动、单实例，不引入额外的进程托管和远程控制面；网关与 dsh 的会话所有权必须清晰，不能出现两个进程同时驱动同一 session。

## Decision

网关以 cordis 插件形式安装在专用的 base-backed `gateway` profile 中，与 dsh 同进程运行，直接使用 dsh 公共插件 API 的 `agents`、`sessions`、`sessionPersistence`、`agentDefaultModel`、`approval`、`sandboxPolicy` 与 `agentLoop` 服务。插件入口 [`src/index.ts`](../../../../src/index.ts) 负责把 dsh ctx 适配成 core 的 AgentHost 与事件源；core 不导入 dsh 运行时包，QQ 适配器不直接控制 agent。

bundle 由 [`cordis.patch.yml`](../../../../cordis.patch.yml) 插入唯一的 `dsh-gateway` 插件行并裁剪非闭环能力；profile 组合、宿主适配、消息流与停止顺序见[架构的运行组合](../../../architecture.md#composition)与[宿主接入](../../../architecture.md#host-integration)。

## Alternatives considered

**独立 gateway 子进程，用自定义协议控制 dsh。** 这样可以把聊天连接与 agent 执行分进程，但需要重新实现会话创建/恢复、followup、cancel、flush、审批和事件订阅协议，并处理两个进程的启动顺序与故障归属。初版没有进程托管和远程控制面需求，重复协议会扩大失败面，因此未采用。

**通过 SDK 或 ACP 接入 dsh。** 这条路径仍要引入额外的控制通道和协议层，cancel、close、会话恢复与审批语义需要重新映射，且会话所有权会跨协议边界。初版只需要一个受信任的本地宿主，使用 cordis 插件直接消费公共 API 更小，因此未采用。

## Consequences

网关获得对会话和 turn 的直接控制，不需要额外的控制通道；代价是插件与 dsh 共享进程权限和生命周期。插件或渠道适配器异常可能影响 dsh，不能单独重启 gateway；部署方必须提供 dsh 宿主并手动处理崩溃恢复。QQ 凭证、模型 key 与 workspace 的 ACL 需要按同进程权限模型保护。

## Verification

插件入口、宿主适配、启动/停止链与配置拒绝路径由 `tests/entry.test.ts`、`tests/host.test.ts` 和 `tests/core.test.ts` 的替身覆盖。真实 dsh 宿主加载、真实 QQ WebSocket 和模型认证不在自动测试内；部署命令与人工联调边界见 [README 的部署小节](../../../../README.md#部署与启动)。
