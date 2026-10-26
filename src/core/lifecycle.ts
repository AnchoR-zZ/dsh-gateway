import type { GatewayLogger } from '../logging.js'
import type { CoreState } from './contracts.js'

/**
 * core/lifecycle：core 状态机与正常停止协调器（设计 9.3）。
 *
 * 本模块不直接持有 scheduler / session-manager / state-store 等具体依赖：停止协调器以钩子
 * 形式由组装层（core/index.ts）提供各步骤的具体实现。传输层（HTTP 监听与探针/管理路由）
 * 不属于 core，由 runtime 组装的 http 模块负责；本模块不导入 node:http、QQ SDK 与 dsh
 * 运行时包（设计 2 节边界）。
 */

/** 单向迁移表：`stopped` 与 `failed` 为吸收态（9.3、13.3）。 */
const ALLOWED_TRANSITIONS: Readonly<Record<CoreState, readonly CoreState[]>> = {
  starting: ['ready', 'stopping', 'failed'],
  ready: ['stopping', 'failed'],
  stopping: ['stopped', 'failed'],
  stopped: [],
  failed: [],
}

/** core 状态机；非法迁移拒绝并记 state_warning，重复提交同一状态静默 no-op。 */
export interface CoreStateMachine {
  get(): CoreState
  /** 返回是否真的发生了迁移；owner 据此做一次性副作用（如 failed 日志）。 */
  transition(next: CoreState): boolean
}

export function createCoreStateMachine(options: {
  logger: GatewayLogger
  initial?: CoreState
}): CoreStateMachine {
  let state: CoreState = options.initial ?? 'starting'
  return {
    get: () => state,
    transition(next: CoreState): boolean {
      if (state === next) {
        return false
      }
      if (!ALLOWED_TRANSITIONS[state].includes(next)) {
        options.logger.logEvent('state_warning', {
          reason: `rejected core state transition ${state} -> ${next}`,
        })
        return false
      }
      state = next
      return true
    },
  }
}

/** 停止协调器的预算键（值放宽为 number，组装层可注入小预算驱动测试）。 */
export interface StopBudgetLimits {
  STOP_NATURAL_COMPLETION_WAIT_MS: number
  CORE_SHUTDOWN_BUDGET_MS: number
}

/** 各预算内步骤收到的上下文：距总预算耗尽的剩余毫秒（单调口径）。 */
export interface StopStepContext {
  remainingMs(): number
}

/**
 * 幂等停止协调器（9.3）。步骤顺序：置 stopping → 丢弃内存队列（onStopDropped 关闭
 * ports，不发停机广播）→ 各渠道 stopReceiving（尽力）→ 运行中任务先等自然结束窗口、
 * 超时后中断并等剩余预算 → 停会话回收器并释放全部缓存 handle → 排空状态写事务 →
 * 置 stopped。总预算 CORE_SHUTDOWN_BUDGET_MS（单调时钟）；超预算未完成的步骤记
 * manual_restart_required 并仍置 stopped——进程退出由 dsh 宿主保证（9.3），本协调器
 * 不强制结束自己。
 */
export interface StopCoordinatorOptions {
  limits: StopBudgetLimits
  mono: () => number
  logger: GatewayLogger
  /** 步骤 1：置 stopping（owner 状态机决定实际迁移；已 failed 时保持 failed）。 */
  onStopping(): void
  /** 步骤 2：丢弃尚未执行的内存队列并关闭其 reply ports。 */
  dropQueue(): void
  /** 步骤 3：各渠道停止接收（尽力 await，计入预算）。 */
  stopChannels(ctx: StopStepContext): Promise<void>
  /**
   * 步骤 4 的活动执行集合：占全局槽的执行 promise 与中断入口（prepare abort 与
   * runner stopInterrupt 由 owner 组合提供）。协调器先等自然结束窗口，超时才中断。
   */
  activeRuns(): { promises: readonly Promise<unknown>[]; interruptAll(): void }
  /** 步骤 5：停回收器并按剩余预算释放全部缓存 handle。 */
  releaseSessions(ctx: StopStepContext): Promise<void>
  /** 步骤 6：排空状态写事务（不产生新写入）。 */
  flushStore(ctx: StopStepContext): Promise<void>
  /** 步骤 7：置 stopped（owner 状态机决定；failed 吸收态下为 no-op）。 */
  onStopped(): void
}

export interface StopCoordinator {
  /** 幂等：并发与后续调用共享同一 promise。 */
  stop(): Promise<void>
}

export function createStopCoordinator(options: StopCoordinatorOptions): StopCoordinator {
  const { limits, mono, logger } = options
  let stopPromise: Promise<void> | undefined

  async function runStop(): Promise<void> {
    const budgetDeadline = mono() + limits.CORE_SHUTDOWN_BUDGET_MS
    const ctx: StopStepContext = { remainingMs: () => budgetDeadline - mono() }
    const unfinished: string[] = []

    const capped = (capMs: number): number => Math.max(0, Math.min(capMs, budgetDeadline - mono()))

    /**
     * 在 cap 与剩余预算取小的窗口内等待 op 落定（rejection 视为落定，步骤永不阻塞后续
     * 清理）。recordTimeout=false 用于"预期中的超时"（自然结束窗口），不进未收敛清单。
     */
    const waitStep = async (op: Promise<unknown>, capMs: number, label: string, recordTimeout = true): Promise<boolean> => {
      const ms = capped(capMs)
      if (ms <= 0) {
        if (recordTimeout) {
          unfinished.push(label)
        }
        return false
      }
      const guarded = Promise.resolve(op).then(
        () => undefined,
        () => undefined,
      )
      const done = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), ms)
        timer.unref?.()
        guarded.then(() => {
          clearTimeout(timer)
          resolve(true)
        })
      })
      if (!done && recordTimeout) {
        unfinished.push(label)
      }
      return done
    }

    const call = (fn: (ctx: StopStepContext) => Promise<void>, label: string): Promise<void> => {
      try {
        return fn(ctx)
      } catch (err) {
        logger.logEvent('state_warning', {
          reason: `shutdown step ${label} threw: ${err instanceof Error ? err.message : String(err)}`,
        })
        return Promise.resolve()
      }
    }

    // 1. readiness 立即不可用（owner 状态迁移）。
    options.onStopping()
    // 2. 丢弃内存队列；onStopDropped 已逐个关闭 port，不发停机广播。
    options.dropQueue()
    // 3. 渠道停止接收（尽力）。
    await waitStep(call(options.stopChannels, 'stop_channels'), Number.POSITIVE_INFINITY, 'stop_channels')
    // 4. 运行中任务：先等自然结束，超时中断，再等剩余预算收敛。
    const runs = options.activeRuns()
    if (runs.promises.length > 0) {
      const all = Promise.allSettled(runs.promises)
      const natural = await waitStep(all, limits.STOP_NATURAL_COMPLETION_WAIT_MS, 'natural_completion_wait', false)
      if (!natural) {
        runs.interruptAll()
        await waitStep(all, Number.POSITIVE_INFINITY, 'active_run_completion')
      }
    }
    // 5. 停回收器 + 释放全部缓存 handle（hook 用 ctx.remainingMs 派生各自期限）。
    await waitStep(call(options.releaseSessions, 'session_release'), Number.POSITIVE_INFINITY, 'session_release')
    // 6. 排空状态写事务。
    await waitStep(call(options.flushStore, 'state_flush'), Number.POSITIVE_INFINITY, 'state_flush')
    // 7. 终态（owner 决定；failed 吸收态下保持 failed）。
    options.onStopped()
    if (unfinished.length > 0) {
      logger.logEvent('manual_restart_required', {
        reason: `shutdown budget exhausted; unfinished steps: ${unfinished.join(', ')}`,
      })
      logger.logEvent('shutdown', { reason: 'budget_exhausted' })
      return
    }
    logger.logEvent('shutdown')
  }

  return {
    stop(): Promise<void> {
      stopPromise ??= runStop()
      return stopPromise
    },
  }
}
