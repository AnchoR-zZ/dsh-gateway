import { randomUUID } from 'node:crypto'

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
import type {
  ChannelRuntimeSnapshot,
  ChannelState,
  CoreHandle,
  CoreQueries,
  CoreSnapshot,
} from './contracts.js'
import { createCoreStateMachine, createStopCoordinator } from './lifecycle.js'
import type { StopStepContext } from './lifecycle.js'
import type { QueuedTask, Scheduler, SchedulerCallbacks } from './scheduler.js'
import type { AgentHandleLike, SessionManager } from './session-manager.js'
import type { StateStore } from './state-store.js'
import type { TurnRunner } from './turn-runner.js'

/**
 * core/index：core 组装与消息执行管道（设计 2 节、4.2、6.1、6.2、8.1、9.1、9.3、12 表）。
 *
 * 把 scheduler（真实实例经工厂注入）、session-manager、turn-runner、state-store 与 reply
 * port 连成闭环：registerChannel 维护渠道注册表与代次，inbound 做防御性校验后同步原子
 * 准入并立即返回（不等任何执行）；SchedulerCallbacks.execute 实现 8.1 的"出队 → prepare →
 * runner（观察器先于 followup 在 runner 内完成）→ deliver"管道，10 分钟截止从获得全局槽
 * 起算并覆盖 prepare；enterFailed 是 12 表"停止准入"各行的汇集点；stop 委托 lifecycle 的
 * 幂等停止协调器。多实例并存：单实例 disconnect 只注销该实例、丢弃其排队任务并中断其
 * 运行中的执行，scheduler 与其他实例继续。
 *
 * 边界：core 专注消息执行，不拥有 HTTP 监听/探针/管理路由（由 runtime 组装的 http 模块
 * 负责）、不聚合配置派生状态（`disabled`/`not_configured` 与 ready 判定在 management 查询
 * 层）、不依赖 `GatewayConfig`（调度/会话等参数由总装注入）。对外只暴露 `CoreHandle` 的
 * 三个能力面：`ingress`（渠道注册面）、`query.snapshot()`（运行快照）、
 * `lifecycle.start/stop`（启停）。本模块不导入 QQ SDK 与 dsh 运行时包（设计 2 节边界）；
 * 事件源适配（eventsFor）由 host/dsh.ts 提供、runtime.ts 在构造 runner 时直接注入，
 * core 不持有事件订阅。
 */

/** 渠道注册面、运行快照与生命周期能力面的对外类型（单一出处 core/contracts.ts）。 */
export type {
  ChannelRuntimeSnapshot,
  ChannelState,
  CoreHandle,
  CoreLifecycle,
  CoreQueries,
  CoreSnapshot,
  CoreState,
} from './contracts.js'

/** limits 注入形状：键集合与 GATEWAY_LIMITS 一致，值放宽为 number 以便测试注入小预算。 */
export type CoreLimits = { readonly [K in keyof typeof GATEWAY_LIMITS]: number }

/**
 * core 组装选项：只含执行管道所需依赖与注入接缝；配置（调度/会话参数）由总装决定后经
 * 工厂/实例传入，core 不读 GatewayConfig。
 */
export interface GatewayCoreOptions {
  limits: CoreLimits
  logger: GatewayLogger
  store: StateStore
  /**
   * scheduler 工厂：core 在构造时把自己的执行管道接成 SchedulerCallbacks 传入。
   * scheduler 的回调只能在 createScheduler 构造时接线，外部预构造的实例永远无法回调
   * core 的管道，故收工厂而非实例；runtime.ts 把调度参数（并发/排队上限）绑进工厂。
   */
  createScheduler: (callbacks: SchedulerCallbacks) => Scheduler
  sessions: SessionManager
  runner: TurnRunner
  /** 墙钟（准入窗口、startedAt）；默认 Date.now。 */
  now?: () => number
  /** 单调时钟（turn 截止、清理预算）；默认 Math.round(performance.now())，与 runner 同口径。 */
  mono?: () => number
  requestId?: () => string
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

  // ---- 停止协调器（9.3）接线：不再包含 HTTP/健康监听关闭（传输层由 runtime 负责）。
  const coordinator = createStopCoordinator({
    limits,
    mono,
    logger,
    onStopping: () => {
      // failed 吸收态下停止清理照常进行，但不改写状态（保持 failed 对就绪查询可见）。
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
    // 顺序固定：core 状态 → 代次 → store → 防御校验 → 原子准入；全部同步判定后立即返回。
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

  // ---- 渠道注销（4.2）：只影响该实例——丢其排队任务、停收、中断其运行中执行，
  // scheduler 与其他实例继续；之后可用新实例重新注册同一 [channelId, accountId]。
  async function disconnect(entry: ChannelEntry, ingressGeneration: number): Promise<void> {
    if (entry.generation !== ingressGeneration) {
      return
    }
    entry.generation += 1
    const { channelId, accountId } = entry.channel
    const key = channelKey(channelId, accountId)
    if (channels.get(key) === entry) {
      channels.delete(key)
    }
    scheduler.dropBindingPrefix(`${channelId}_${accountId}_`)
    try {
      await entry.channel.stopReceiving()
    } catch (err) {
      logger.logEvent('turn_failed', {
        channelId,
        generation: ingressGeneration,
        reason: `stopReceiving threw during disconnect: ${errorMessage(err)}`,
      })
    }
    // 中断该实例运行中的执行（prepare abort + runner stopInterrupt），由各自管道的
    // 有界预算收敛；不在 disconnect 内无限等待，其他实例的执行不受影响。
    for (const [runToken, run] of runs) {
      const meta = taskMeta.get(runToken)
      if (
        meta !== undefined &&
        meta.identity.channelId === channelId &&
        meta.identity.accountId === accountId
      ) {
        run.abort()
        run.interrupt()
      }
    }
  }

  // ---- GatewayCore 注册面（4.2）：对内称 ingress，对外经 CoreHandle.ingress 暴露。
  const ingress: GatewayCore = {
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
            // 13.3：不可恢复关闭/凭证错误 → 保持 blocked、停止接流量；处置是修因后重跑 enable
            // 拉起新实例（重启进程仅兜底）。
            logger.logEvent('manual_restart_required', {
              channelId: channel.channelId,
              generation: ingressGeneration,
              reason: `channel reported blocked; fix the cause, then POST /channels/${channel.channelId}/enable to start a fresh instance (restarting the gateway is the fallback)`,
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

  // ---- 运行快照（只读）；配置派生状态与 ready 判定在 management 查询层。
  const query: CoreQueries = {
    snapshot(): CoreSnapshot {
      const stats = scheduler.stats()
      return {
        state: stateMachine.get(),
        stateStoreFailed: store.isFailed(),
        startedAt,
        pending: stats.pendingTotal,
        running: stats.running,
        channels: [...channels.values()].map(
          (entry): ChannelRuntimeSnapshot => ({
            channelId: entry.channel.channelId,
            accountId: entry.channel.accountId,
            state: entry.state,
          }),
        ),
      }
    },
  }

  /**
   * 启动（13.1）：加载持久映射 → 启动回收器 → ready + startedAt。映射加载失败直接抛错
   * （state 保持 starting，不在这里关闭任何资源——HTTP 监听等由 runtime 自行回滚）。
   *
   * 并发停止：`store.load()` 挂起期间 runtime 可能已触发停止链。此时启动被停止吸收——
   * 不启动会话回收器、不写 startedAt、不抛错；只有状态机接受 `ready` 迁移后才产生启动
   * 副作用，避免"停止后重启回收器"或"stopped 状态却带 startedAt"。
   */
  async function start(): Promise<void> {
    if (stateMachine.get() !== 'starting') {
      throw new Error(`core start requires state starting, got ${stateMachine.get()}`)
    }
    await store.load()
    if (stateMachine.get() !== 'starting') {
      return
    }
    // 先启动回收器、再迁移 ready：两步之间没有 await，停止链无法插入；回收器启动抛错时
    // core 尚未 ready，启动失败不会留下"ready 但 start reject"的半状态。
    sessions.start()
    if (!stateMachine.transition('ready')) {
      return
    }
    startedAt = new Date(now()).toISOString()
  }

  return {
    ingress,
    query,
    lifecycle: {
      start,
      /** 幂等停止协调器（9.3），总预算 CORE_SHUTDOWN_BUDGET_MS；并发调用共享同一 promise。 */
      stop: () => coordinator.stop(),
    },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
