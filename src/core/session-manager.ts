import { randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'

import type { GatewayConfig } from '../config.js'
import { computeBindingId, GATEWAY_LIMITS, isValidBindingId } from '../contracts.js'
import type { ChannelIdentity } from '../contracts.js'
import type { GatewayLogger } from '../logging.js'
import type { StateStore } from './state-store.js'

/**
 * core/session-manager：bindingId 到 dsh agent 的创建、恢复、复用、重建、LRU 缓存与释放
 * （设计文档 3.2、6.3、7.4、7.5、9.2、11.2）。它是 core 与 dsh 的唯一桥接点——本模块只定义
 * 并消费 AgentHost 端口（Like 接口，自包含），不 import 任何 @deepseek-ai/* 运行时代码；
 * 真实实现由插件入口（宿主接缝）提供，测试注入替身。
 *
 * 所有权契约（3.2）：create/resume 返回的 handle 由本模块独占保存到其异步 dispose 结束；
 * `isAgentLive` 只是 live registry 的只读探针，不取得释放权。所有 handle 的取消、停稳、
 * flush 与 dispose 序列都走同一份有界预算（releaseHandle / runRelease）。
 *
 * 会话准备遵循 7.4/7.5：缓存命中先校验对象身份与 generation；无映射走新建（显式 flush
 * 成功后才提交映射）；有映射无缓存走恢复（校验持久 cwd、清 inbox）；恢复失败走重建
 * （generation+1，旧 session 文件不动）；新建本身失败只发失败提示、不更新旧映射；
 * 持久层不可用转 fatal。准备期间 signal 中止时，晚到 handle 必须释放且不发布进缓存。
 */

/** dsh session 的最小只读视图；header.cwd 是持久工作目录（11.2 校验对象）。 */
export interface SessionLike {
  readonly id: string
  readonly header: { cwd: string }
}

/** dsh agent 的最小视图：驱动、取消、停稳与 inbox 清理由网关按 6.1/7.4/9.2 使用。 */
export interface AgentLike {
  readonly id: string
  readonly session: SessionLike
  followup(message: unknown): void
  cancel(cause: { kind: string }): void
  whenIdle(): Promise<void>
  readonly inbox: { clear(): void }
  readonly status: 'idle' | 'running'
}

/** create/resume 返回的所有权句柄；dispose 是异步所有权操作，不保证强制终止卡住的工具。 */
export interface AgentHandleLike {
  agent: AgentLike
  dispose(): Promise<void>
}

/** 新建 agent 的输入；signal 只覆盖创建事务，handle 可见前由宿主分离（3.2）。 */
export interface CreateAgentInput {
  sessionId: string
  /** 身份工作目录（resolveWorkspaceDir 的规范化结果）。 */
  cwd: string
  agentOptions: AgentModelOptions
  signal: AbortSignal
}

/** 恢复 agent 的输入；恢复不改变 session ID（6.3）。 */
export interface ResumeAgentInput {
  sessionId: string
  agentOptions: AgentModelOptions
  signal: AbortSignal
}

/** 模型选择（11.1）：启动时读取一次并缓存，全部 agent 显式传入同一份。 */
export type AgentModelOptions = Readonly<{ provider: string; model: string; reasoningEffort?: string }>

/**
 * dsh 宿主端口。真实实现（插件入口任务）负责：在 setup 内执行 setApprovalPolicy('never')
 * 与 setSandboxMode('workspace-write')（幂等 append，恢复亦强制）；对同一 session 的并发
 * flush 做 in-flight 复用（只发一次）；isAgentLive 封装 ctx.agents.get(sessionId)。
 */
export interface AgentHost {
  /** 构造 SessionManager 时调用一次，之后全部 agent 共用该选择（11.1）。 */
  currentModelSelection(): AgentModelOptions
  createAgent(input: CreateAgentInput): Promise<AgentHandleLike>
  resumeAgent(input: ResumeAgentInput): Promise<AgentHandleLike>
  /** false = 无持久化监听者（部署错误）；调用方（turn 协调）负责超时包装。 */
  flushSession(session: SessionLike): Promise<boolean>
  /** live registry 中该 session 是否仍有 agent；dispose 收敛判定用（9.2.4）。 */
  isAgentLive(sessionId: string): boolean
}

/** 成功准备的会话视图；handle 为 busy，任务结束后调用方必须 markIdle。 */
export interface PreparedSession {
  bindingId: string
  sessionId: string
  generation: number
  handle: AgentHandleLike
  /** 本次准备中重建过会话（恢复失败→新建），T9 据此加一次性恢复提示（7.5）。 */
  recreated: boolean
  /** 命中健康缓存 handle（日志与诊断用）。 */
  reusedCached: boolean
}

/**
 * 准备失败分类。creation-failed 只影响本次消息（不更新映射）；fatal 使 core 转 failed
 * 等待人工处理；aborted 表示执行预算耗尽或停机，晚到 handle 已释放。
 */
export type PrepareFailure =
  | { kind: 'creation-failed' }
  | { kind: 'fatal' }
  | { kind: 'aborted' }

export interface PrepareOptions {
  identity: ChannelIdentity
  /** 调用方的执行预算信号（turn 截止/停机）；等待执行槽与各准备步骤都受它约束。 */
  signal: AbortSignal
}

/** 会话管理器；生命周期由 core/lifecycle 持有（start/stop 控制空闲回收器）。 */
export interface SessionManager {
  /**
   * 准备（或复用）identity 对应的 agent。不抛常规错误：失败以返回值区分，内部意外异常
   * 按 creation-failed 处理并记日志。同一 bindingId 的并发 prepare 依赖上游调度器
   * （6.1 同一身份串行）保证不重叠，本模块不做额外互斥。
   */
  prepare(opts: PrepareOptions): Promise<PreparedSession | { error: PrepareFailure }>
  /** 任务结束调用：清 busy、刷新 LRU/TTL 时间戳；未知或已移除的 handle 为 no-op。 */
  markIdle(handle: AgentHandleLike): void
  /**
   * 有界释放（空闲回收/停机/异常路径）：cancelled 时先 cancel({kind:'user'})，再依次
   * whenIdle → flush（尽力）→ dispose，共用 deadlineMs 预算（默认 CANCEL_CLEANUP_BUDGET_MS，
   * 9.2.5）。预算耗尽或 dispose 抛错都视为释放未收敛，返回 'timeout' 并把缓存条目
   * 标记 stuck（不再复用、不再重复释放）；成功且 session 已从 live registry 退出后
   * 才移除缓存（9.2.4-9.2.5：仅在该 Promise 成功结束且 session 退出后，才允许下一条
   * 消息恢复同一 session ID）。
   */
  releaseHandle(
    handle: AgentHandleLike,
    opts?: { cancelled?: boolean; deadlineMs?: number },
  ): Promise<'disposed' | 'timeout'>
  /** 启动空闲回收器（幂等）：周期释放空闲超过 idleAgentTtlMs 的 entry（无 cancel）。 */
  start(): void
  /** 停止回收器定时器（幂等）；不主动释放 handle——停机释放由 core 停止协调器逐 entry 调 releaseHandle。 */
  stop(): Promise<void>
  /**
   * T9 增量缝隙：枚举缓存全部条目的 handle（含 releasing 与 stuck）供停机协调器逐个
   * releaseHandle。只读探针，不取得所有权；stuck 条目的 releaseHandle 立即返回
   * 'timeout'（其 manual_restart_required 已在转 stuck 时记录）。
   */
  listCachedHandles(): readonly AgentHandleLike[]
  /** 缓存探针：liveHandles 为缓存条目数（含 stuck），busyHandles 为其中 busy 的数量。 */
  stats(): { liveHandles: number; busyHandles: number }
}

/** 校验并规范化身份工作目录（11.2）：mkdir 后 realpath，拒绝 symlink/junction 目录关系逃逸。 */
export function resolveWorkspaceDir(workspaceRoot: string, bindingId: string): string {
  if (!isValidBindingId(bindingId)) {
    throw new Error(`invalid bindingId for workspace directory: format/characters mismatch`)
  }
  const requested = join(workspaceRoot, bindingId)
  mkdirSync(requested, { recursive: true })
  const root = realpathSync(workspaceRoot)
  const expected = join(root, bindingId)
  const dir = realpathSync(requested)
  if (!isSameOrUnder(dir, expected)) {
    throw new Error(
      `workspace directory escapes the identity boundary: ${bindingId} resolves to ${dir}`,
    )
  }
  return dir
}

/** descendant 是否等于 ancestor 或位于其内；win32 大小写不敏感。 */
function isSameOrUnder(ancestor: string, descendant: string): boolean {
  const a = process.platform === 'win32' ? ancestor.toLowerCase() : ancestor
  const d = process.platform === 'win32' ? descendant.toLowerCase() : descendant
  return a === d || d.startsWith(a + sep)
}

function pathsEqual(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** 预算耗尽哨兵：withBudget 超时以该值 reject，调用点据此与真实错误区分。 */
const BUDGET_EXHAUSTED = Symbol('session-manager budget exhausted')

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

export function createSessionManager(options: {
  host: AgentHost
  store: StateStore
  workspaceRoot: string
  config: Pick<GatewayConfig, 'idleAgentTtlMs' | 'maxLiveAgents' | 'maxConcurrent'>
  limits: typeof GATEWAY_LIMITS
  logger: GatewayLogger
  /** sessionId 生成器；默认 randomUUID，测试注入确定性序列。 */
  uuid?: () => string
  /** 墙钟（毫秒）：仅用于映射记录的 createdAt/updatedAt 持久化时间戳；默认 Date.now。 */
  now?: () => number
  /** 单调时钟（毫秒）：释放预算（runRelease/withBudget）与空闲 TTL 计时；默认 Math.round(performance.now())，与 core/turn-runner 传入的 deadline 同口径（设计 6.2/9.1）。 */
  mono?: () => number
  /** 回收器检查间隔（毫秒）；默认 clamp(idleAgentTtlMs/4, 1s, 30s)，测试可注入小间隔。 */
  reapIntervalMs?: number
}): SessionManager {
  const { host, store, workspaceRoot, config, limits, logger } = options
  const now: () => number = options.now ?? Date.now
  const mono: () => number = options.mono ?? (() => Math.round(performance.now()))
  const uuid: () => string = options.uuid ?? randomUUID
  // 11.1：模型选择在构造时读取一次；变更走重启，不热更读。
  const modelSelection = host.currentModelSelection()

  /** 缓存条目。evicting 条目已同步移出 cache（LRU 让位），只保留在释放闭包里。 */
  interface CachedEntry {
    readonly bindingId: string
    readonly sessionId: string
    readonly generation: number
    readonly handle: AgentHandleLike
    busy: boolean
    /** 空闲 TTL 基准（单调时钟域，与 idleAgentTtlMs 判定同口径；非持久化数据）。 */
    lastUsedAt: number
    /** LRU 序（插入与 markIdle 递增），与 lastUsedAt 分离以保证确定性。 */
    useSeq: number
    state: 'active' | 'releasing' | 'stuck'
    releasePromise: Promise<'disposed' | 'timeout'> | undefined
  }

  const cache = new Map<string, CachedEntry>()
  let nextUseSeq = 1

  interface SlotWaiter {
    fire(): void
  }
  const slotWaiters: SlotWaiter[] = []

  function notifySlotWaiters(): void {
    const waiters = slotWaiters.splice(0, slotWaiters.length)
    for (const waiter of waiters) {
      waiter.fire()
    }
  }

  /** 等待容量事件或 abort；醒后由调用方重查（可能仍需继续等待）。 */
  function waitForSlotOrAbort(signal: AbortSignal): Promise<'slot' | 'abort'> {
    return new Promise((resolve) => {
      let cleanup = (): void => undefined
      const settle = (value: 'slot' | 'abort'): void => {
        cleanup()
        resolve(value)
      }
      const waiter: SlotWaiter = { fire: () => settle('slot') }
      const onAbort = (): void => settle('abort')
      slotWaiters.push(waiter)
      cleanup = (): void => {
        const index = slotWaiters.indexOf(waiter)
        if (index >= 0) {
          slotWaiters.splice(index, 1)
        }
        signal.removeEventListener('abort', onAbort)
      }
      if (signal.aborted) {
        settle('abort')
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** 把一个会占用缓存新条目的准备步骤纳入容量管理（6.3）：有空位或有可逐出的空闲 entry 时放行。 */
  async function acquireSlot(signal: AbortSignal): Promise<boolean> {
    for (;;) {
      if (cache.size < config.maxLiveAgents) {
        return true
      }
      if (evictLruIdle()) {
        return true
      }
      // 均忙时等待执行槽释放（6.3）；等待计入调用方执行预算（signal 控制）。
      if ((await waitForSlotOrAbort(signal)) === 'abort') {
        return false
      }
    }
  }

  /** LRU 逐出最久未使用的空闲 entry：同步移出缓存让位，释放异步进行。 */
  function evictLruIdle(): boolean {
    let victim: CachedEntry | undefined
    for (const entry of cache.values()) {
      if (entry.state === 'active' && !entry.busy && (victim === undefined || entry.useSeq < victim.useSeq)) {
        victim = entry
      }
    }
    if (victim === undefined) {
      return false
    }
    const evicted = victim
    cache.delete(evicted.bindingId)
    void runRelease(evicted.handle, { deadlineMs: limits.CANCEL_CLEANUP_BUDGET_MS }).then((result) => {
      if (result === 'timeout') {
        logger.logEvent('manual_restart_required', {
          bindingId: evicted.bindingId,
          sessionId: evicted.sessionId,
          reason: 'evicted handle release did not converge; manual cleanup may be required',
        })
      } else if (host.isAgentLive(evicted.sessionId)) {
        logger.logEvent('state_warning', {
          bindingId: evicted.bindingId,
          sessionId: evicted.sessionId,
          reason: 'evicted handle disposed but session still live in registry',
        })
      }
    })
    return true
  }

  /** 以剩余预算执行一个（可能同步抛错的）异步步骤；预算耗尽以 BUDGET_EXHAUSTED reject。 */
  function withBudget<T>(start: () => T | Promise<T>, deadlineAt: number): Promise<T> {
    let op: Promise<T>
    try {
      op = Promise.resolve(start())
    } catch (err) {
      return Promise.reject(err)
    }
    // 预挂 rejection 处理器：竞速失败后迟到的 rejection 不成为未处理拒绝。
    op.then(
      () => undefined,
      () => undefined,
    )
    const remaining = deadlineAt - mono()
    if (remaining <= 0) {
      return Promise.reject(BUDGET_EXHAUSTED)
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(BUDGET_EXHAUSTED), remaining)
      timer.unref?.()
      op.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (err) => {
          clearTimeout(timer)
          reject(err)
        },
      )
    })
  }

  /**
   * 与 abort 信号竞速：abort 先到时 resolve 'aborted'（底层操作不取消，由其自身收敛；
   * flush 的 in-flight 复用在宿主内）。操作自身 rejection 原样向外传播，由调用点区分
   * "预算中止" 与 "操作失败"。
   */
  function raceWithAbort<T>(op: Promise<T>, signal: AbortSignal): Promise<T | 'aborted'> {
    // 预挂 rejection 处理器：abort 先赢后迟到的 rejection 不成为未处理拒绝。
    op.then(
      () => undefined,
      () => undefined,
    )
    if (signal.aborted) {
      return Promise.resolve<T | 'aborted'>('aborted')
    }
    return new Promise<T | 'aborted'>((resolve, reject) => {
      const onAbort = (): void => resolve('aborted')
      signal.addEventListener('abort', onAbort, { once: true })
      op.then(
        (value) => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        (err: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(err)
        },
      )
    })
  }

  /**
   * 有界释放序列（9.2）：cancel（可选）→ whenIdle → flush（尽力，失败记日志不中断）→ dispose。
   * 各步共用同一 deadline 预算（单调时钟）；预算耗尽或 dispose 抛错返回 'timeout'（释放未
   * 收敛，调用点标 stuck / 记 manual_restart_required），不重试。
   */
  async function runRelease(
    handle: AgentHandleLike,
    opts: { cancelled?: boolean; deadlineMs: number },
  ): Promise<'disposed' | 'timeout'> {
    const deadlineAt = mono() + opts.deadlineMs
    const sessionId = handle.agent.session.id
    if (opts.cancelled === true) {
      try {
        handle.agent.cancel({ kind: 'user' })
      } catch (err) {
        logger.logEvent('turn_failed', {
          sessionId,
          reason: `agent cancel threw during release: ${errorMessage(err)}`,
        })
      }
    }
    try {
      await withBudget(() => handle.agent.whenIdle(), deadlineAt)
    } catch (err) {
      if (err === BUDGET_EXHAUSTED) {
        return 'timeout'
      }
      logger.logEvent('turn_failed', {
        sessionId,
        reason: `agent whenIdle rejected during release: ${errorMessage(err)}`,
      })
    }
    try {
      const flushed = await withBudget(() => host.flushSession(handle.agent.session), deadlineAt)
      if (!flushed) {
        logger.logEvent('state_warning', {
          sessionId,
          reason: 'session flush reported no persistence listener during release',
        })
      }
    } catch (err) {
      if (err === BUDGET_EXHAUSTED) {
        return 'timeout'
      }
      logger.logEvent('turn_failed', {
        sessionId,
        reason: `session flush failed during release: ${errorMessage(err)}`,
      })
    }
    try {
      await withBudget(() => handle.dispose(), deadlineAt)
    } catch (err) {
      if (err === BUDGET_EXHAUSTED) {
        return 'timeout'
      }
      // dispose rejected：清理未成功结束，与预算耗尽同样视为未收敛（9.2.5：仅在该
      // Promise 成功结束且 session 退出 live registry 后才移除缓存）。调用点据此
      // 标记 stuck 并记 manual_restart_required；此处只记诊断明细。
      logger.logEvent('turn_failed', {
        sessionId,
        reason: `handle dispose rejected: ${errorMessage(err)}`,
      })
      return 'timeout'
    }
    return 'disposed'
  }

  /** 失败/中止路径的晚到或未发布 handle：尽力有界 dispose，不阻塞返回（7.4.5）。 */
  function disposeBestEffort(handle: AgentHandleLike, context: string): void {
    const sessionId = handle.agent.session.id
    withBudget(() => handle.dispose(), mono() + limits.DISPOSE_WAIT_MS).then(
      () => undefined,
      (err) => {
        if (err === BUDGET_EXHAUSTED) {
          logger.logEvent('turn_failed', {
            sessionId,
            reason: `late handle dispose timed out (${context})`,
          })
        } else {
          logger.logEvent('turn_failed', {
            sessionId,
            reason: `late handle dispose failed (${context}): ${errorMessage(err)}`,
          })
        }
      },
    )
  }

  function findEntryByHandle(handle: AgentHandleLike): CachedEntry | undefined {
    for (const entry of cache.values()) {
      if (entry.handle === handle) {
        return entry
      }
    }
    return undefined
  }

  function publishEntry(
    bindingId: string,
    sessionId: string,
    generation: number,
    handle: AgentHandleLike,
  ): CachedEntry {
    const entry: CachedEntry = {
      bindingId,
      sessionId,
      generation,
      handle,
      busy: true,
      lastUsedAt: mono(),
      useSeq: nextUseSeq,
      state: 'active',
      releasePromise: undefined,
    }
    nextUseSeq += 1
    cache.set(bindingId, entry)
    return entry
  }

  function releaseHandle(
    handle: AgentHandleLike,
    opts?: { cancelled?: boolean; deadlineMs?: number },
  ): Promise<'disposed' | 'timeout'> {
    const deadlineMs = opts?.deadlineMs ?? limits.CANCEL_CLEANUP_BUDGET_MS
    const entry = findEntryByHandle(handle)
    if (entry === undefined) {
      // 不在缓存（已被 LRU 逐出或早已移除）：独立尽力释放，无缓存簿记。
      return runRelease(handle, { cancelled: opts?.cancelled, deadlineMs })
    }
    if (entry.state === 'stuck') {
      // 不再重复释放尝试，只记录（9.2.5）。
      logger.logEvent('turn_failed', {
        bindingId: entry.bindingId,
        sessionId: entry.sessionId,
        reason: 'release skipped: entry is stuck and will not be re-released',
      })
      return Promise.resolve('timeout')
    }
    if (entry.state === 'releasing' && entry.releasePromise !== undefined) {
      return entry.releasePromise
    }
    entry.state = 'releasing'
    const release = runRelease(handle, { cancelled: opts?.cancelled, deadlineMs })
    entry.releasePromise = release
    void release.then(
      (result) => finalizeRelease(entry, result),
      () => finalizeRelease(entry, 'timeout'),
    )
    return release
  }

  function finalizeRelease(entry: CachedEntry, result: 'disposed' | 'timeout'): void {
    if (result === 'timeout') {
      entry.state = 'stuck'
      logger.logEvent('manual_restart_required', {
        bindingId: entry.bindingId,
        sessionId: entry.sessionId,
        generation: entry.generation,
        reason: 'agent release did not converge (budget exhausted or dispose failed); handle marked stuck',
      })
      return
    }
    if (host.isAgentLive(entry.sessionId)) {
      // dispose 已结束但 live registry 尚有该 session：不能移除缓存当作已释放（9.2.4），
      // 条目转 stuck（不可复用、不重复释放），属需人工处理信号。
      entry.state = 'stuck'
      logger.logEvent('manual_restart_required', {
        bindingId: entry.bindingId,
        sessionId: entry.sessionId,
        reason: 'dispose resolved but session still live in registry; entry marked stuck',
      })
      return
    }
    if (cache.get(entry.bindingId) === entry) {
      cache.delete(entry.bindingId)
      notifySlotWaiters()
    }
  }

  function markIdle(handle: AgentHandleLike): void {
    const entry = findEntryByHandle(handle)
    if (entry === undefined || entry.state !== 'active') {
      return
    }
    entry.busy = false
    entry.lastUsedAt = mono()
    entry.useSeq = nextUseSeq
    nextUseSeq += 1
    // 空闲 entry 现在可被 LRU 逐出，唤醒等待容量的准备事务。
    notifySlotWaiters()
  }

  /** 新建路径失败时 signal 已中止则归为 aborted（宿主可能因 abort reject 创建事务）。 */
  function prepareFailed(signal: AbortSignal, reason: string, bindingId: string): { error: PrepareFailure } {
    logger.logEvent('turn_failed', { bindingId, reason })
    return { error: { kind: signal.aborted ? 'aborted' : 'creation-failed' } }
  }

  /** 显式 flush 新会话；false（无持久化监听者）或 flush 抛错视为部署/会话故障，按创建失败处理（7.4.2）。 */
  async function flushForPublish(
    handle: AgentHandleLike,
    bindingId: string,
    signal: AbortSignal,
  ): Promise<true | false | 'aborted'> {
    const sessionId = handle.agent.session.id
    let outcome: boolean | 'aborted'
    try {
      outcome = await raceWithAbort(host.flushSession(handle.agent.session), signal)
    } catch (err) {
      logger.logEvent('turn_failed', {
        bindingId,
        sessionId,
        reason: `session flush failed: ${errorMessage(err)}`,
      })
      return false
    }
    if (outcome === 'aborted') {
      return 'aborted'
    }
    if (!outcome) {
      logger.logEvent('turn_failed', {
        bindingId,
        sessionId,
        reason: 'session flush reported no persistence listener; treating creation as failed',
      })
      return false
    }
    return true
  }

  async function prepare(opts: PrepareOptions): Promise<PreparedSession | { error: PrepareFailure }> {
    const { identity, signal } = opts
    if (signal.aborted) {
      return { error: { kind: 'aborted' } }
    }
    let bindingId: string
    try {
      bindingId = computeBindingId(identity)
    } catch (err) {
      logger.logEvent('turn_failed', {
        reason: `invalid identity: ${errorMessage(err)}`,
      })
      return { error: { kind: 'creation-failed' } }
    }
    if (store.isFailed()) {
      // 持久映射不可用时不能继续处理新消息（7.3）；core 转 failed。
      return { error: { kind: 'fatal' } }
    }

    // 7.4.1 缓存健康检查：引用比较（缓存对象 === 发布时的对象）+ sessionId/generation 一致。
    const record = store.getBinding(bindingId)
    const cached = cache.get(bindingId)
    if (
      cached !== undefined &&
      cached.state === 'active' &&
      record !== undefined &&
      cached.sessionId === record.sessionId &&
      cached.generation === record.generation
    ) {
      cached.busy = true
      cached.lastUsedAt = mono()
      cached.useSeq = nextUseSeq
      nextUseSeq += 1
      return {
        bindingId,
        sessionId: cached.sessionId,
        generation: cached.generation,
        handle: cached.handle,
        recreated: false,
        reusedCached: true,
      }
    }
    if (cached !== undefined && cached.state === 'active') {
      // 条目与映射不一致（映射被外部变更）：不可复用，移出缓存并异步释放。
      cache.delete(bindingId)
      logger.logEvent('turn_failed', {
        bindingId,
        sessionId: cached.sessionId,
        generation: cached.generation,
        reason: 'cached handle no longer matches mapping; releasing stale handle',
      })
      const stale = cached
      void runRelease(stale.handle, { deadlineMs: limits.CANCEL_CLEANUP_BUDGET_MS }).then((result) => {
        if (result === 'timeout') {
          logger.logEvent('manual_restart_required', {
            bindingId: stale.bindingId,
            sessionId: stale.sessionId,
            reason: 'stale handle release did not converge; manual cleanup may be required',
          })
        }
      })
    }

    if (!(await acquireSlot(signal))) {
      return { error: { kind: 'aborted' } }
    }
    if (signal.aborted) {
      notifySlotWaiters()
      return { error: { kind: 'aborted' } }
    }

    let result: PreparedSession | { error: PrepareFailure }
    try {
      result =
        record === undefined
          ? await createBindingSession(bindingId, identity, signal)
          : await resumeOrRecreate(bindingId, identity, record, signal)
    } catch (err) {
      // 意外异常按 creation-failed 处理（本模块约定不向调用方抛常规错误）。
      logger.logEvent('turn_failed', {
        bindingId,
        reason: `unexpected session prepare failure: ${errorMessage(err)}`,
      })
      result = { error: { kind: 'creation-failed' } }
    }
    if ('error' in result) {
      // 未插入新条目：腾出的容量（如已逐出的空位）可能让等待者继续。
      notifySlotWaiters()
    }
    return result
  }

  /** 7.4.2-7.4.3 首次创建：mkdir+逃逸校验 → createAgent → flush → 事务提交 generation=1。 */
  async function createBindingSession(
    bindingId: string,
    identity: ChannelIdentity,
    signal: AbortSignal,
  ): Promise<PreparedSession | { error: PrepareFailure }> {
    const sessionId = uuid()
    let dir: string
    try {
      dir = resolveWorkspaceDir(workspaceRoot, bindingId)
    } catch (err) {
      return prepareFailed(signal, `workspace directory rejected: ${errorMessage(err)}`, bindingId)
    }
    let handle: AgentHandleLike
    try {
      handle = await host.createAgent({ sessionId, cwd: dir, agentOptions: modelSelection, signal })
    } catch (err) {
      return prepareFailed(signal, `agent create failed: ${errorMessage(err)}`, bindingId)
    }
    if (signal.aborted) {
      disposeBestEffort(handle, 'create aborted before publish')
      return { error: { kind: 'aborted' } }
    }
    const flushed = await flushForPublish(handle, bindingId, signal)
    if (flushed === 'aborted') {
      disposeBestEffort(handle, 'flush aborted before publish')
      return { error: { kind: 'aborted' } }
    }
    if (!flushed) {
      disposeBestEffort(handle, 'flush unavailable')
      return { error: { kind: 'creation-failed' } }
    }
    const timestamp = new Date(now()).toISOString()
    try {
      await store.runTransaction((draft) => {
        draft.set(bindingId, {
          channelId: identity.channelId,
          accountId: identity.accountId,
          peerId: identity.peerId,
          sessionId,
          generation: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
      })
    } catch (err) {
      disposeBestEffort(handle, 'mapping commit failed')
      if (store.isFailed()) {
        logger.logEvent('turn_failed', {
          bindingId,
          sessionId,
          reason: `mapping transaction failed and store turned failed: ${errorMessage(err)}`,
        })
        return { error: { kind: 'fatal' } }
      }
      logger.logEvent('turn_failed', {
        bindingId,
        sessionId,
        reason: `mapping commit failed: ${errorMessage(err)}`,
      })
      return { error: { kind: 'creation-failed' } }
    }
    if (signal.aborted) {
      // 映射已提交（session 有效，下次入站恢复），但本 turn 已死：晚到 handle 释放、不发布。
      disposeBestEffort(handle, 'aborted after mapping commit')
      return { error: { kind: 'aborted' } }
    }
    publishEntry(bindingId, sessionId, 1, handle)
    logger.logEvent('session_created', { bindingId, sessionId, generation: 1 })
    return {
      bindingId,
      sessionId,
      generation: 1,
      handle,
      recreated: false,
      reusedCached: false,
    }
  }

  /** 7.4.4 正常恢复：resume → cwd 校验 → inbox.clear；失败转重建（7.5）。 */
  async function resumeOrRecreate(
    bindingId: string,
    identity: ChannelIdentity,
    record: { sessionId: string; generation: number; createdAt: string },
    signal: AbortSignal,
  ): Promise<PreparedSession | { error: PrepareFailure }> {
    let dir: string | undefined
    try {
      dir = resolveWorkspaceDir(workspaceRoot, bindingId)
    } catch {
      // 身份目录关系不成立（如被改为逃逸链接）：按 cwd 不一致处理，走重建；重建内再次校验失败则 creation-failed。
    }
    if (dir !== undefined) {
      let resumed: AgentHandleLike
      try {
        resumed = await host.resumeAgent({
          sessionId: record.sessionId,
          agentOptions: modelSelection,
          signal,
        })
      } catch (err) {
        return await recreateSession(
          bindingId,
          identity,
          record,
          signal,
          `resume_failed: ${errorMessage(err)}`,
        )
      }
      if (signal.aborted) {
        disposeBestEffort(resumed, 'resume aborted before publish')
        return { error: { kind: 'aborted' } }
      }
      let cwdMatches = false
      try {
        cwdMatches = pathsEqual(realpathSync(resumed.agent.session.header.cwd), dir)
      } catch {
        cwdMatches = false
      }
      if (!cwdMatches) {
        disposeBestEffort(resumed, 'persistent cwd mismatch')
        return await recreateSession(bindingId, identity, record, signal, 'cwd_mismatch')
      }
      // 7.4.4：丢弃崩溃遗留的未消费 inbox 项，避免旧项在本次 followup 被意外驱动。
      try {
        resumed.agent.inbox.clear()
      } catch (err) {
        logger.logEvent('turn_failed', {
          bindingId,
          sessionId: record.sessionId,
          reason: `inbox clear threw: ${errorMessage(err)}`,
        })
      }
      publishEntry(bindingId, record.sessionId, record.generation, resumed)
      logger.logEvent('session_resumed', {
        bindingId,
        sessionId: record.sessionId,
        generation: record.generation,
      })
      return {
        bindingId,
        sessionId: record.sessionId,
        generation: record.generation,
        handle: resumed,
        recreated: false,
        reusedCached: false,
      }
    }
    return await recreateSession(bindingId, identity, record, signal, 'cwd_mismatch')
  }

  /**
   * 7.5 重建：记录旧 session 与原因 → 新 UUID → createAgent → flush → 事务写入
   * sessionId/generation+1（createdAt 保留，updatedAt 刷新）。新建失败不更新旧映射。
   */
  async function recreateSession(
    bindingId: string,
    identity: ChannelIdentity,
    record: { sessionId: string; generation: number; createdAt: string },
    signal: AbortSignal,
    reason: string,
  ): Promise<PreparedSession | { error: PrepareFailure }> {
    logger.logEvent('session_recreated', {
      bindingId,
      sessionId: record.sessionId,
      generation: record.generation,
      reason,
    })
    const sessionId = uuid()
    let dir: string
    try {
      // 目录已存在则复用：清空上下文不删除工作目录（11.2）。
      dir = resolveWorkspaceDir(workspaceRoot, bindingId)
    } catch (err) {
      return prepareFailed(signal, `workspace directory rejected: ${errorMessage(err)}`, bindingId)
    }
    let handle: AgentHandleLike
    try {
      handle = await host.createAgent({ sessionId, cwd: dir, agentOptions: modelSelection, signal })
    } catch (err) {
      return prepareFailed(signal, `agent recreate failed: ${errorMessage(err)}`, bindingId)
    }
    if (signal.aborted) {
      disposeBestEffort(handle, 'recreate aborted before publish')
      return { error: { kind: 'aborted' } }
    }
    const flushed = await flushForPublish(handle, bindingId, signal)
    if (flushed === 'aborted') {
      disposeBestEffort(handle, 'recreate flush aborted')
      return { error: { kind: 'aborted' } }
    }
    if (!flushed) {
      // 新建失败：不更新旧映射、不执行输入，只发失败提示（7.5）。
      disposeBestEffort(handle, 'recreate flush unavailable')
      return { error: { kind: 'creation-failed' } }
    }
    const generation = record.generation + 1
    try {
      await store.runTransaction((draft) => {
        draft.set(bindingId, {
          channelId: identity.channelId,
          accountId: identity.accountId,
          peerId: identity.peerId,
          sessionId,
          generation,
          createdAt: record.createdAt,
          updatedAt: new Date(now()).toISOString(),
        })
      })
    } catch (err) {
      disposeBestEffort(handle, 'recreate mapping commit failed')
      if (store.isFailed()) {
        logger.logEvent('turn_failed', {
          bindingId,
          sessionId,
          reason: `recreate mapping transaction failed and store turned failed: ${errorMessage(err)}`,
        })
        return { error: { kind: 'fatal' } }
      }
      logger.logEvent('turn_failed', {
        bindingId,
        sessionId,
        reason: `recreate mapping commit failed: ${errorMessage(err)}`,
      })
      return { error: { kind: 'creation-failed' } }
    }
    if (signal.aborted) {
      disposeBestEffort(handle, 'recreate aborted after mapping commit')
      return { error: { kind: 'aborted' } }
    }
    publishEntry(bindingId, sessionId, generation, handle)
    logger.logEvent('session_created', { bindingId, sessionId, generation })
    return {
      bindingId,
      sessionId,
      generation,
      handle,
      recreated: true,
      reusedCached: false,
    }
  }

  // 空闲回收器（6.3）：周期检查空闲（!busy 且 active）超过 idleAgentTtlMs 的 entry。
  // 空闲判定与 lastUsedAt 同为单调时钟域；reapIntervalMs 是真实的 setInterval 周期。
  let reapTimer: ReturnType<typeof setInterval> | undefined
  const reapIntervalMs =
    options.reapIntervalMs ??
    Math.max(1_000, Math.min(30_000, Math.ceil(config.idleAgentTtlMs / 4)))

  function reapIdle(): void {
    const cutoff = mono() - config.idleAgentTtlMs
    // releaseHandle 的缓存移除在异步收尾才发生，同步迭代期间不会修改 cache。
    for (const entry of cache.values()) {
      if (entry.state === 'active' && !entry.busy && entry.lastUsedAt <= cutoff) {
        releaseHandle(entry.handle).catch((err: unknown) => {
          logger.logEvent('turn_failed', {
            bindingId: entry.bindingId,
            sessionId: entry.sessionId,
            reason: `idle release threw unexpectedly: ${errorMessage(err)}`,
          })
        })
      }
    }
  }

  function start(): void {
    if (reapTimer !== undefined) {
      return
    }
    reapTimer = setInterval(reapIdle, reapIntervalMs)
    reapTimer.unref?.()
  }

  async function stop(): Promise<void> {
    if (reapTimer !== undefined) {
      clearInterval(reapTimer)
      reapTimer = undefined
    }
  }

  function stats(): { liveHandles: number; busyHandles: number } {
    let busyHandles = 0
    for (const entry of cache.values()) {
      if (entry.busy) {
        busyHandles += 1
      }
    }
    return { liveHandles: cache.size, busyHandles }
  }

  function listCachedHandles(): readonly AgentHandleLike[] {
    const handles: AgentHandleLike[] = []
    for (const entry of cache.values()) {
      handles.push(entry.handle)
    }
    return handles
  }

  return { prepare, markIdle, releaseHandle, start, stop, listCachedHandles, stats }
}
