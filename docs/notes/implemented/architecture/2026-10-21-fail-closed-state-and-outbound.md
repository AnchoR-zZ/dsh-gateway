# Agent Note: 状态与出站故障采用 fail-closed 和手动重启

Status: implemented

## Problem

网关有两类故障无法可靠地自动判定结果：映射持久化可能在写盘、超时或文件占用后处于未知状态；QQ 发送可能已经到达平台但本地只看到超时或连接错误。初版没有可靠消息队列、出站重放或跨进程恢复，错误地继续运行可能把同一身份分裂到两个 session、重复执行 turn，或对同一条入站重复发送。

## Decision

映射加载失败会拒绝启动；写事务失败或超时后，store 进入不可恢复的 failed 状态，保留最近已提交快照，core 停止接受新入站并转 failed。人工修复文件或从 `.bak` 恢复后，用相同 `DSH_HOME` 与 workspace 重启，按映射惰性恢复会话。映射校验失败不跳过坏记录，也不以空状态重建。

QQ 出站明确失败或部分成功时停止余段，不补发、不改发普通文本、不重新执行 turn。发送总期限到而底层调用未结束时报 `unknown`，关闭该条 reply port、停止余段并隔离渠道出站；渠道进入 blocked，readiness 不可用，等待人工重启。`dispose` 未收敛、dispose 后 session 仍 live，或停机预算耗尽时同样记录 `manual_restart_required`，不假装清理完成。具体状态与触发点见[会话与状态](../../../architecture.md#session-state)、[回复与失败语义](../../../architecture.md#reply-semantics)与[健康与日志](../../../architecture.md#health-logs)。

## Alternatives considered

**映射写失败后继续在内存中运行，稍后重试写盘。** 这能短期保可用性，但重启后内存状态丢失，同一身份可能被分配新 session 或丢失已有映射；写盘持续失败还会让状态与用户可见的上下文分叉。初版选择停止准入，避免在没有可靠持久层时继续执行。

**映射文件损坏时当作首次部署，以空状态启动。** 这样最容易恢复服务，但会静默为所有用户创建新 session，丢失原有上下文且无法从日志判断哪些身份被重置。初版保留现场并要求人工修复或从 `.bak` 恢复。

**对可能已送达的 QQ 发送做自动重试。** 平台没有幂等键能保证重试不产生重复消息；失败与超时无法区分“未送达”和“已送达但响应丢失”。重试会把网络不确定性变成重复回复，因此由人工判断后重启。

**由插件自动重启 dsh 或重建 core。** 初版没有进程托管和自动重启范围；在旧 handle、在途写入或未知出站请求可能仍存活时自动重建，会引入两个 owner 和重复执行风险。初版只记录需人工处理的状态。

## Consequences

可用性依赖人工介入：映射损坏、store failed、出站隔离或清理未收敛时，网关不会自行恢复，用户可能收不到当前回复，宕机期间的内存队列也不会补发。换来的是不会静默重置身份、不会自动重复可能已送达的消息，也不会在旧 session 仍 live 时创建同身份的新 agent。系统不提供 exactly-once 或可靠的端到端 at-least-once 投递。

## Verification

`tests/state-store.test.ts` 覆盖损坏 JSON、schema 版本、写失败、超时、`.bak` 序列与 failed 转态；`tests/qq-reply-port.test.ts` 覆盖明确失败、部分成功、35 秒超时与 `unknown`；`tests/core.test.ts`、`tests/session-manager.test.ts` 和 `tests/entry.test.ts` 覆盖 failed 传播、handle 未收敛与启动失败。真实 QQ 网络、真实文件占用和进程信号路径未做端到端验证。
