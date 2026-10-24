import { randomUUID } from 'node:crypto'

import type { GatewayConfig } from '../config.js'
import { computeBindingId, isValidBindingScope } from '../contracts.js'
import type {
  ChannelIdentity,
  ChannelIngress,
  ChannelRegistration,
  DeliveryReport,
  GATEWAY_LIMITS,
  GatewayCore,
  InboundText,
  NoticeKind,
  ReplyEnvelope,
} from '../contracts.js'
import type { GatewayLogger } from '../logging.js'
import type { QueuedTask, Scheduler, SchedulerCallbacks } from './scheduler.js'
import type { AgentHandleLike, SessionManager } from './session-manager.js'
import type { StateStore } from './state-store.js'
import type { TurnRunner } from './turn-runner.js'
import { createCoreStateMachine, createHealthServer, createStopCoordinator } from './lifecycle.js'
import type { ChannelState, CoreState, StopStepContext } from './lifecycle.js'

/**
 * core/index：GatewayCore 总装（设计 2 节、4.2、6.1、6.2、8.1、9.1、9.3、12 表、13 节）。
 *
 * 把 scheduler（真实实例经工厂注入）、session-manager、turn-runner、state-store 与 reply
 * port 连成闭环：registerChannel 维护渠道注册表与代次，inbound 做防御性校验后同步原子
 * 准入并立即返回（不等任何执行）；SchedulerCallbacks.execute 实现 8.1 的"出队 → prepare →
 * runner（观察器先于 followup 在 runner 内完成）→ deliver"管道，10 分钟截止从获得全局槽
 * 起算并覆盖 prepare；enterFailed 是 12 表"停止准入"各行的汇集点；stop 委托 lifecycle 的
 * 幂等停止协调器。本模块不导入 QQ SDK 与 dsh 运行时包（设计 2 节边界）；事件源适配
 * （eventsFor）由插件入口在构造 runner 时直接注入，core 不持有事件订阅。
 */

export type { ChannelState, CoreState } from './lifecycle.js'

/** limits 注入形状：键集合与 GATEWAY_LIMITS 一致，值放宽为 number 以便测试注入小预算。 */
export type CoreLimits = { readonly [K in keyof typeof GATEWAY_LIMITS]: number }

export interface GatewayCoreOptions {
  config: GatewayConfig
  limits: CoreLimits
  logger: GatewayLogger
  store: StateStore
  /**
   * scheduler 工厂：core 在构造时把自己的执行管道接成 SchedulerCallbacks 传入。
   * 简报原文为 `scheduler: Scheduler`，但 scheduler 的回调只能在 createScheduler 构造时
   * 接线，外部预构造的实例永远无法回调 core 的管道——这是简报承认的缝隙（"scheduler 已
   * 在构造时接好 callbacks"），故收工厂而非实例；T10 与测试传 createScheduler 的单参包装。
   */
  createScheduler: (callbacks: SchedulerCallbacks) => Scheduler
  sessions: SessionManager
  runner: TurnRunner
  /** 墙钟（准入窗口、startedAt）；默认 Date.now。 */
  now?: () => number
  /** 单调时钟（turn 截止、清理预算）；默认 Math.round(performance.now())，与 runner 同口径。 */
  mono?: () => number
  requestId?: () => string
  /** 健康监听注入（默认 127.0.0.1:17890）；测试用 host/port=0 探测随机端口。 */
  health?: { host?: string; port?: number }
}

/** 健康快照（/readyz 正文与探针判定共用）；channelStates 键为 channelId，不含 accountId。 */
export interface CoreHealth {
  coreState: CoreState
  channelStates: Record<string, ChannelState>
  pending: number
  running: number
  startedAt: string
}

export interface CoreHandle {
  /** 给渠道适配器（T10）的注册面。 */
  core: GatewayCore
  /**
   * 启动（13.1）：绑定健康监听（占用失败抛错，不杀别的进程）→ store.load()（校验失败
   * 抛错，由 T10 决定进程退出）→ sessions.start()（回收器）→ coreState=ready。
   * 任一步失败时关闭已创建资源，coreState 保持 starting。
   */
  start(): Promise<void>
  /** 幂等停止协调器（9.3），总预算 CORE_SHUTDOWN_BUDGET_MS；并发调用共享同一 promise。 */
  stop(): Promise<void>
  health(): CoreHealth
}

export function createGatewayCore(options: GatewayCoreOptions): CoreHandle {
  const { limits, logger, store, sessions, runner } = options
  const now: () => number = options.now ?? Date.now
  const mono: () => number = options.mono ?? (() => Math.round(performance.now()))
  const nextRequestId: () => string = options.requestId ?? randomUUID

  const stateMachine = createCoreStateMachine({ logger })
  let startedAt = ''

  // ---- 渠道注册表（4.2）：键 [channelId, accountId]，代次随 disconnect 递增使旧 ingress 失效。
  interface ChannelEntry {
    readonly channel: ChannelRegistration
    generation: number
    state: ChannelState
  }
  const channelKey = (channelId: string, accountId: string): string =>
    JSON.stringify([channelId, accountId])
  const channels = new Map<string, ChannelEntry>()

  function channelStates(): Record<string, ChannelState> {
    const states: Record<string, ChannelState> = {}
    for (const entry of channels.values()) {
      // 键只用 channelId（13.2 正文禁 AppID；初版单渠道，同 channelId 多账号时后写覆盖）。
      states[entry.channel.channelId] = entry.state
    }
    return states
  }

  // ---- requestId → 执行期元数据。QueuedTask 不携带 identity 与 maxMessages（scheduler
  // 在 admit 时只收 AdmitInput 白名单字段），core 在 admit 前注册、各回调完成时删除。
  interface TaskMeta {
    readonly identity: ChannelIdentity
    readonly maxMessages: number
  }
  const taskMeta = new Map<string, TaskMeta>()

  /** 活动执行登记：runToken（=调度层 requestId）→ 中断入口；stop 协调器与 disconnect 使用。 */
  interface RunEntry {
    abort(): void
    interrupt(): void
  }
  const runs = new Map<string, RunEntry>()
  const runPromises = new Set<Promise<void>>()

  // ---- 12 表"停止准入"行的汇集点：幂等，scheduler 丢队列（ports 经 onStopDropped 关闭）、
  // 渠道尽力停收、active runs 不做无限清理（交由 stop() 或自然结束，9.2.5）。
  function enterFailed(reason: string): void {
    if (!stateMachine.transition('failed')) {
      return
    }
    scheduler.stop()
    for (const entry of channels.values()) {
      try {
        void Promise.resolve(entry.channel.stopReceiving()).then(
          () => undefined,
          () => undefined,
        )
      } catch {
        // 尽力而为：渠道停止失败（含同步抛错）不阻断 failed 转换的其余副作用。
      }
    }
    logger.logEvent('state_failed', { reason })
    logger.logEvent('manual_restart_required', { reason: `core entered failed state: ${reason}` })
  }
  store.onFailed(() => enterFailed('state_store_failed'))

  // ---- 投递助手：core 自发的提示信封（prepare 失败/超时、queue-expired）恰一次 deliver，
  // 报告按状态记日志（12 节投递边界：渠道失败不重试）。
  function logDelivery(
    task: QueuedTask,
    report: DeliveryReport,
  ): void {
    const fields = {
      requestId: task.requestId,
      bindingId: task.bindingId,
      messageId: task.messageId,
      attempted: report.attempted,
      confirmed: report.confirmed,
    }
    if (report.status === 'sent') {
      logger.logEvent('reply_sent', fields)
    } else if (report.status === 'partial') {
      logger.logEvent('reply_partial', fields)
    } else if (report.status === 'unknown') {
      logger.logEvent('reply_unknown', fields)
    } else {
      logger.logEvent('reply_failed', { ...fields, reason: `delivery status ${report.status}` })
    }
  }

  async function deliverNotices(task: QueuedTask, meta: TaskMeta, notices: readonly NoticeKind[]): Promise<void> {
    const envelope: ReplyEnvelope = { notices, maxMessages: meta.maxMessages }
    try {
      const report = await task.reply.deliver(envelope)
      logDelivery(task, report)
    } catch (err) {
      logger.logEvent('reply_failed', {
        requestId: task.requestId,
        bindingId: task.bindingId,
        messageId: task.messageId,
        reason: `deliver threw: ${errorMessage(err)}`,
      })
    }
  }

  /**
   * needs-release 路径的有界释放（9.2.5）：取消清理总预算从执行截止点起算（覆盖 runner
   * 内已消耗的停稳/flush 等待），上限 CANCEL_CLEANUP_BUDGET_MS；未收敛（'timeout'/stuck）
   * 按 12 表转 core failed。
   */
  async function releaseAfterOutcome(
    task: QueuedTask,
    handle: AgentHandleLike,
    cancelled: boolean,
    deadlineMono: number,
  ): Promise<void> {
    const cleanupDeadline = deadlineMono + limits.CANCEL_CLEANUP_BUDGET_MS
    const deadlineMs = Math.min(limits.CANCEL_CLEANUP_BUDGET_MS, cleanupDeadline - mono())
    const result = await sessions.releaseHandle(handle, { cancelled, deadlineMs })
    if (result === 'timeout') {
      logger.logEvent('turn_failed', {
        requestId: task.requestId,
        bindingId: task.bindingId,
        messageId: task.messageId,
        reason: 'handle release did not converge; requesting core failure',
      })
      enterFailed('dispose_did_not_converge')
    }
  }

  // ---- execute 管道（8.1 序列图的 C 与 S；SchedulerCallbacks.execute 的实现）。
  function executeTask(task: QueuedTask): Promise<void> {
    return executeTaskInner(task).catch((err: unknown) => {
      // 防御兜底：管道意外异常只影响本任务，scheduler 把 resolve 视为完成并释放槽。
      logger.logEvent('turn_failed', {
        requestId: task.requestId,
        bindingId: task.bindingId,
        messageId: task.messageId,
        reason: `execute pipeline internal error: ${errorMessage(err)}`,
      })
    })
  }

  async function executeTaskInner(task: QueuedTask): Promise<void> {
    const runToken = task.requestId
    const meta = taskMeta.get(runToken)
    // 9.1：10 分钟从获得全局槽、开始准备会话时计时。
    const deadlineMono = mono() + limits.TURN_DEADLINE_MS
    const prepareAbort = new AbortController()
    // 9.2.1：准备阶段的超时 abort 由本模块负责（runner 内部有自己的终态门定时器）。
    // 到点只 abort prepare signal——此时若已进入 runner.run，abort 对其无影响。
    const deadlineTimer = setTimeout(() => prepareAbort.abort(), Math.max(0, deadlineMono - mono()))
    deadlineTimer.unref?.()
    runs.set(runToken, {
      abort: () => prepareAbort.abort(),
      interrupt: () => runner.stopInterrupt(runToken),
    })
    try {
      if (meta === undefined) {
        // 防御：admit 时必然注册；缺失说明装配缺陷，按失败提示收尾且不触碰会话。
        logger.logEvent('turn_failed', {
          requestId: runToken,
          bindingId: task.bindingId,
          messageId: task.messageId,
          reason: 'task meta missing at dequeue',
        })
        return
      }
      const prepared = await sessions.prepare({ identity: meta.identity, signal: prepareAbort.signal })
      if ('error' in prepared) {
        const kind = prepared.error.kind
        if (kind === 'fatal') {
          // 7.3/12 表：持久映射不可用 → core failed + state-unavailable 提示。
          enterFailed('state_unavailable')
          await deliverNotices(task, meta, ['state-unavailable'])
        } else if (kind === 'creation-failed') {
          // 7.4/7.5：新建/重建失败只影响本条消息（不更新映射、无 handle 可释放）。
          await deliverNotices(task, meta, ['turn-failed'])
        } else if (mono() >= deadlineMono) {
          logger.logEvent('turn_timeout', {
            requestId: runToken,
            bindingId: task.bindingId,
            messageId: task.messageId,
            reason: 'prepare aborted after the execution deadline',
          })
          await deliverNotices(task, meta, ['turn-timeout'])
        } else {
          // 停机中止：不发送任何提示（9.3 不为排队消息发停机广播）。
        }
        return
      }
      if (mono() >= deadlineMono) {
        // 准备阶段耗尽执行预算（9.1）：同超时收尾，重建过会话时附一次性恢复提示（7.5）。
        logger.logEvent('turn_timeout', {
          requestId: runToken,
          bindingId: task.bindingId,
          messageId: task.messageId,
          reason: 'prepare consumed the execution deadline',
        })
        const notices: NoticeKind[] = prepared.recreated
          ? ['session-recreated', 'turn-timeout']
          : ['turn-timeout']
        await deliverNotices(task, meta, notices)
        await releaseAfterOutcome(task, prepared.handle, true, deadlineMono)
        return
      }
      const outcome = await runner.run({
        handle: prepared.handle,
        text: task.text,
        recreated: prepared.recreated,
        runToken,
        maxMessages: meta.maxMessages,
        deadlineMono,
        deliver: (envelope) => task.reply.deliver(envelope),
        onFatal: enterFailed,
      })
      if (outcome.kind === 'fatal') {
        // runner 已发送 turn-failed 信封并触发 onFatal（core 已/将转 failed）；这里只做
        // 有限清理（12 表：会话 flush 失败 → 停止准入、有限清理）。
        await releaseAfterOutcome(task, prepared.handle, false, deadlineMono)
        return
      }
      if (outcome.handleHealth === 'healthy') {
        // 停稳且 flush 成功，可复用；执行槽由 scheduler 在本 promise settle 后释放。
        sessions.markIdle(prepared.handle)
        return
      }
      await releaseAfterOutcome(
        task,
        prepared.handle,
        outcome.kind === 'timeout' || outcome.kind === 'stopping',
        deadlineMono,
      )
    } finally {
      clearTimeout(deadlineTimer)
      task.reply.close()
      runs.delete(runToken)
      taskMeta.delete(runToken)
    }
  }

  // ---- scheduler 回调表与真实 scheduler 接线（构造时完成，13.1）。
  const schedulerCallbacks: SchedulerCallbacks = {
    execute(task) {
      const promise = executeTask(task)
      runPromises.add(promise)
      promise.then(
        () => {
          runPromises.delete(promise)
        },
        () => {
          runPromises.delete(promise)
        },
      )
      return promise
    },
    /** 6.2：出队时剩余窗口不足完整执行预算+出站余量 → 不启动 turn，窗口内发 queue-expired。 */
    async queueExpired(task) {
      const meta = taskMeta.get(task.requestId)
      try {
        if (meta !== undefined) {
          await deliverNotices(task, meta, ['queue-expired'])
        }
      } finally {
        taskMeta.delete(task.requestId)
        task.reply.close()
      }
    },
    /** 6.2：出队时已过期 → 只记日志、不发送任何内容（不挪用其他消息的回复锚点）。 */
    dropped(task) {
      taskMeta.delete(task.requestId)
      logger.logEvent('inbound_ignored', {
        requestId: task.requestId,
        bindingId: task.bindingId,
        messageId: task.messageId,
        reason: 'expired before dequeue',
      })
      task.reply.close()
    },
    /** 9.3：正常停止丢弃排队任务 → 只关闭 port，不发停机广播。 */
    onStopDropped(task) {
      taskMeta.delete(task.requestId)
      logger.logEvent('inbound_ignored', {
        requestId: task.requestId,
        bindingId: task.bindingId,
        messageId: task.messageId,
        reason: 'queue dropped at shutdown',
      })
      task.reply.close()
    },
  }
  const scheduler = options.createScheduler(schedulerCallbacks)

  // ---- 健康探针（13.2）。
  function allChannelsOnline(): boolean {
    for (const entry of channels.values()) {
      if (entry.state !== 'online') {
        return false
      }
    }
    return true
  }

  const healthServer = createHealthServer({
    host: options.health?.host,
    port: options.health?.port,
    logger,
    snapshot: () => {
      const stats = scheduler.stats()
      return {
        coreState: stateMachine.get(),
        channels: channelStates(),
        pending: stats.pendingTotal,
        running: stats.running,
        startedAt,
      }
    },
    ready: () => stateMachine.get() === 'ready' && !store.isFailed() && allChannelsOnline(),
  })

  // ---- 停止协调器（9.3）接线。
  const coordinator = createStopCoordinator({
    limits,
    mono,
    logger,
    onStopping: () => {
      // failed 吸收态下停止清理照常进行，但不改写状态（保持 failed 对 /readyz 可见）。
      const current = stateMachine.get()
      if (current === 'starting' || current === 'ready') {
        stateMachine.transition('stopping')
      }
    },
    dropQueue: () => {
      scheduler.stop()
    },
    stopChannels: async () => {
      for (const entry of channels.values()) {
        try {
          await entry.channel.stopReceiving()
        } catch (err) {
          logger.logEvent('turn_failed', {
            channelId: entry.channel.channelId,
            generation: entry.generation,
            reason: `stopReceiving threw during shutdown: ${errorMessage(err)}`,
          })
        }
      }
    },
    activeRuns: () => ({
      promises: [...runPromises],
      interruptAll: () => {
        for (const run of runs.values()) {
          run.abort()
          run.interrupt()
        }
      },
    }),
    releaseSessions: async (ctx: StopStepContext) => {
      await sessions.stop()
      const handles = sessions.listCachedHandles()
      if (handles.length === 0) {
        return
      }
      const deadlineMs = Math.max(1, ctx.remainingMs())
      await Promise.all(
        handles.map((handle) =>
          sessions.releaseHandle(handle, { deadlineMs }).catch(() => 'timeout' as const),
        ),
      )
    },
    flushStore: async () => {
      await store.flushNow()
    },
    closeHealth: async () => {
      await healthServer.close()
    },
    onStopped: () => {
      // 仅正常路径落 stopped；failed 吸收态保持 failed（manual_restart_required 语义）。
      if (stateMachine.get() === 'stopping') {
        stateMachine.transition('stopped')
      }
    },
  })

  // ---- inbound 防御性校验（4.2）：渠道负责平台字段真实性，core 负责形态。
  // 以 unknown 视角逐字段检查，防御适配器传入的畸形运行时对象。
  function validateInbound(message: InboundText): string | undefined {
    const raw = message as unknown
    if (typeof raw !== 'object' || raw === null) {
      return 'message must be an object'
    }
    const record = raw as Record<string, unknown>
    if (typeof record.peerId !== 'string' || record.peerId === '') {
      return 'peerId must be a non-empty string'
    }
    if (typeof record.messageId !== 'string' || record.messageId === '') {
      return 'messageId must be a non-empty string'
    }
    if (typeof record.text !== 'string' || record.text.trim() === '') {
      return 'text must be a non-empty string'
    }
    const policy = record.replyPolicy
    if (typeof policy !== 'object' || policy === null) {
      return 'replyPolicy must be an object'
    }
    const policyRecord = policy as Record<string, unknown>
    if (
      typeof policyRecord.maxMessages !== 'number' ||
      !Number.isInteger(policyRecord.maxMessages) ||
      policyRecord.maxMessages < 1
    ) {
      return 'replyPolicy.maxMessages must be a positive integer'
    }
    if (
      typeof policyRecord.expiresAt !== 'number' ||
      !Number.isFinite(policyRecord.expiresAt) ||
      policyRecord.expiresAt <= 0
    ) {
      return 'replyPolicy.expiresAt must be a finite positive number'
    }
    const reply = record.reply
    if (
      typeof reply !== 'object' ||
      reply === null ||
      typeof (reply as Record<string, unknown>).deliver !== 'function' ||
      typeof (reply as Record<string, unknown>).close !== 'function'
    ) {
      return 'reply port must provide deliver and close'
    }
    return undefined
  }

  type InboundResult =
    | { accepted: true; requestId: string }
    | { accepted: false; reason: 'busy' | 'expired' | 'stopping' | 'unavailable' }

  async function inbound(
    entry: ChannelEntry,
    ingressGeneration: number,
    message: InboundText,
  ): Promise<InboundResult> {
    // 顺序按简报：core 状态 → 代次 → store → 防御校验 → 原子准入；全部同步判定后立即返回。
    const coreState = stateMachine.get()
    if (coreState !== 'ready') {
      const reason = coreState === 'failed' ? 'unavailable' : 'stopping'
      logger.logEvent('inbound_rejected', {
        channelId: entry.channel.channelId,
        generation: ingressGeneration,
        reason,
      })
      return { accepted: false, reason }
    }
    if (entry.generation !== ingressGeneration || channels.get(channelKey(entry.channel.channelId, entry.channel.accountId)) !== entry) {
      logger.logEvent('inbound_rejected', {
        channelId: entry.channel.channelId,
        generation: ingressGeneration,
        reason: 'stale channel generation',
      })
      return { accepted: false, reason: 'stopping' }
    }
    if (store.isFailed()) {
      logger.logEvent('inbound_rejected', {
        channelId: entry.channel.channelId,
        generation: ingressGeneration,
        reason: 'state store failed',
      })
      return { accepted: false, reason: 'unavailable' }
    }
    const invalid = validateInbound(message)
    if (invalid !== undefined) {
      logger.logEvent('inbound_ignored', {
        channelId: entry.channel.channelId,
        generation: ingressGeneration,
        reason: invalid,
      })
      return { accepted: false, reason: 'unavailable' }
    }
    const text = message.text.trim()
    const identity: ChannelIdentity = {
      channelId: entry.channel.channelId,
      accountId: entry.channel.accountId,
      peerId: message.peerId,
    }
    let bindingId: string
    try {
      bindingId = computeBindingId(identity)
    } catch (err) {
      logger.logEvent('inbound_ignored', {
        channelId: entry.channel.channelId,
        generation: ingressGeneration,
        reason: `invalid identity: ${errorMessage(err)}`,
      })
      return { accepted: false, reason: 'unavailable' }
    }
    const requestId = nextRequestId()
    // admit 可能在同一调用内同步出队执行（pump → execute → 读取 taskMeta），必须先注册。
    taskMeta.set(requestId, { identity, maxMessages: message.replyPolicy.maxMessages })
    const result = scheduler.admit({
      requestId,
      bindingId,
      messageId: message.messageId,
      text,
      receivedAt: message.receivedAt,
      expiresAt: message.replyPolicy.expiresAt,
      reply: message.reply,
    })
    if (result.accepted) {
      logger.logEvent('queued', {
        requestId,
        channelId: identity.channelId,
        bindingId,
        messageId: message.messageId,
        inputLength: text.length,
      })
      return { accepted: true, requestId }
    }
    taskMeta.delete(requestId)
    logger.logEvent('inbound_rejected', {
      requestId,
      channelId: identity.channelId,
      bindingId,
      messageId: message.messageId,
      reason: result.reason,
    })
    return { accepted: false, reason: result.reason }
  }

  // ---- 渠道注销（4.2 + 简报单渠道简化说明）。
  async function disconnect(entry: ChannelEntry, ingressGeneration: number): Promise<void> {
    if (entry.generation !== ingressGeneration) {
      return
    }
    entry.generation += 1
    const key = channelKey(entry.channel.channelId, entry.channel.accountId)
    if (channels.get(key) === entry) {
      channels.delete(key)
    }
    // 单渠道简化（简报）：scheduler 无按渠道过滤丢弃的 API，disconnect 复用全局 stop 路径
    // 的前半——丢弃全部内存队列（ports 经 onStopDropped 关闭）。多渠道扩展点：给 scheduler
    // 增加按渠道（bindingId 前缀或显式渠道标记）的丢弃过滤；disconnect 后本 core 实例的
    // 调度器已 stopping，重新注册需要重建 core（初版单实例可接受）。
    scheduler.stop()
    try {
      await entry.channel.stopReceiving()
    } catch (err) {
      logger.logEvent('turn_failed', {
        channelId: entry.channel.channelId,
        generation: ingressGeneration,
        reason: `stopReceiving threw during disconnect: ${errorMessage(err)}`,
      })
    }
    // 等待/取消该渠道的运行任务：中断全部活动 run（prepare abort + runner stopInterrupt），
    // 由各自管道的有界预算收敛；不在 disconnect 内无限等待。
    for (const run of runs.values()) {
      run.abort()
      run.interrupt()
    }
  }

  // ---- GatewayCore 注册面（4.2）。
  const core: GatewayCore = {
    registerChannel(channel: ChannelRegistration): ChannelIngress {
      const coreState = stateMachine.get()
      if (coreState !== 'starting' && coreState !== 'ready') {
        throw new Error(`cannot register a channel while core is ${coreState}`)
      }
      if (
        typeof channel !== 'object' ||
        channel === null ||
        typeof channel.channelId !== 'string' ||
        !isValidBindingScope(channel.channelId) ||
        typeof channel.accountId !== 'string' ||
        !isValidBindingScope(channel.accountId) ||
        typeof channel.stopReceiving !== 'function'
      ) {
        throw new Error(
          'channel registration requires path-safe channelId/accountId (no "_") and stopReceiving',
        )
      }
      const key = channelKey(channel.channelId, channel.accountId)
      if (channels.has(key)) {
        // 错误消息不含 accountId（AppID 不入日志与错误文本，11.3）。
        throw new Error(`channel ${channel.channelId} with this account is already registered`)
      }
      const entry: ChannelEntry = { channel, generation: 1, state: 'connecting' }
      channels.set(key, entry)
      const ingressGeneration = entry.generation
      return {
        setState(state) {
          if (entry.generation !== ingressGeneration || channels.get(key) !== entry) {
            return
          }
          entry.state = state
          if (state === 'blocked') {
            // 13.3：不可恢复关闭/凭证错误 → 保持 blocked、停止接流量、等人工重启。
            logger.logEvent('manual_restart_required', {
              channelId: channel.channelId,
              generation: ingressGeneration,
              reason: 'channel reported blocked; fix configuration and restart manually',
            })
          } else if (state === 'reconnecting') {
            logger.logEvent('channel_reconnecting', {
              channelId: channel.channelId,
              generation: ingressGeneration,
            })
          }
        },
        inbound: (message) => inbound(entry, ingressGeneration, message),
        disconnect: () => disconnect(entry, ingressGeneration),
      }
    },
  }

  // ---- 启动（13.1）：绑定监听 → 加载映射 → 启回收器 → ready。
  async function start(): Promise<void> {
    if (stateMachine.get() !== 'starting') {
      throw new Error(`core start requires state starting, got ${stateMachine.get()}`)
    }
    // 绑定失败（EADDRINUSE 等）抛错拒绝启动；已创建资源只有 server 自身，无需回滚。
    await healthServer.start()
    try {
      await store.load()
    } catch (err) {
      await healthServer.close()
      throw err
    }
    sessions.start()
    stateMachine.transition('ready')
    startedAt = new Date(now()).toISOString()
  }

  function health(): CoreHealth {
    const stats = scheduler.stats()
    return {
      coreState: stateMachine.get(),
      channelStates: channelStates(),
      pending: stats.pendingTotal,
      running: stats.running,
      startedAt,
    }
  }

  return {
    core,
    start,
    stop: () => coordinator.stop(),
    health,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
