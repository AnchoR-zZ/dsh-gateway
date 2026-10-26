import type { ChannelRegistration, GatewayCore } from '../contracts.js'

/**
 * core 对外契约：运行状态、运行快照与生命周期能力。
 *
 * 三个能力面交给不同调用方：`GatewayCore`（来自 `src/contracts.ts`）给渠道适配器注册与
 * 投递消息；`CoreQueries` 给管理查询与实例管理器读取运行事实；`CoreLifecycle` 给 runtime
 * 启动与停止核心。core 控制能力本期只有启动、停止与渠道注册后的注销，不提前提供会话重置
 * 或 turn 中断接口。
 *
 * 快照是独立只读数据：不暴露内部 Map、scheduler、session handle 或 store 对象，也不含
 * 配置派生状态（`disabled`/`not_configured` 由 management 查询层推导）。
 */

export type CoreState = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'

/** 已注册渠道实例的运行状态；不含配置派生值。 */
export type ChannelState = 'connecting' | 'online' | 'reconnecting' | 'blocked'

/** 单个已注册渠道实例的运行快照。 */
export interface ChannelRuntimeSnapshot {
  readonly channelId: string
  readonly accountId: string
  readonly state: ChannelState
}

/** core 运行事实的只读快照。 */
export interface CoreSnapshot {
  readonly state: CoreState
  /** 状态映射 store 是否已进入 failed（持久化失败后 core 停止准入）。 */
  readonly stateStoreFailed: boolean
  /** core 进入 `ready` 的 UTC ISO 8601 时间；进入之前为空字符串。 */
  readonly startedAt: string
  /** 仍在 FIFO 等待、尚未出队的任务数。 */
  readonly pending: number
  /** 已占用全局执行槽的在飞任务数。 */
  readonly running: number
  /** 只有实际注册的渠道实例及其运行状态。 */
  readonly channels: readonly ChannelRuntimeSnapshot[]
}

export interface CoreQueries {
  snapshot(): CoreSnapshot
}

export interface CoreLifecycle {
  /** 启动核心：加载持久映射、启动回收器并进入 `ready`；失败时拒绝且不清理已由 runtime 创建的资源。 */
  start(): Promise<void>
  /** 幂等停止：丢弃队列、收敛在途执行、释放 handle 与排空写入；并发调用共享同一 promise。 */
  stop(): Promise<void>
}

/** 交给不同调用方的能力面集合。 */
export interface CoreHandle {
  /** 渠道适配器注册面（沿用 `registerChannel` → `ChannelIngress` 契约）。 */
  readonly ingress: GatewayCore
  readonly query: CoreQueries
  readonly lifecycle: CoreLifecycle
}

/** 渠道入站注册所需的类型在这里一并导出，方便渠道与 core 组合方只引一个 core 契约模块。 */
export type { ChannelRegistration, GatewayCore }
