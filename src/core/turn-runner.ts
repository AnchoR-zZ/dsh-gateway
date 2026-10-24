import type { DeliveryReport, NoticeKind, ReplyEnvelope } from '../contracts.js'
import type { GATEWAY_LIMITS } from '../contracts.js'
import type { GatewayLogger } from '../logging.js'
import type { AgentHandleLike, AgentHost } from './session-manager.js'

/**
 * core/turn-runner：一次 followup 的完整执行（设计文档 8.1、8.2、9.1、9.2、12 表）。
 *
 * 职责：创建 UserMessage、先订阅事件再 followup、通过 claimed 关联 turn、按 8.2 规则选择
 * 最终文本、成功与失败终态发送前的有界 flush、envelope 构造与恰一次 deliver、终态门
 * （成功/超时/停止三方竞争，第一个同步提交者获胜）、超时取消与停稳等待、晚到结果隔离。
 * 不依赖 session-manager/scheduler（组装在 T9）；事件流经 TurnEventSource 端口注入，
 * UserMessage 创建经 TurnHost.createUserMessage，测试全部用替身驱动，不接触真实 dsh。
 *
 * 事件回调契约（8.1）：只做同步状态记录（写 run 状态、resolve 等待信号、记日志），
 * 绝不在回调内 await whenIdle/flush/deliver/dispose。whenIdle() 不是成功证明——成功必须
 * 由 targetTurn 的 turn/end + 最终文本规则判定，且判定前检查单调时钟未越过截止点。
 */

/** assistant message content block 的最小视图（text/reasoning/tool-call 联合的公共形状）。 */
export interface TurnBlockLike {
  readonly type: string
  readonly text?: string
  readonly id?: string
}

/**
 * 本模块消费的 session 事件（已由事件源按 agent/session 过滤）。tool/call、turn/start 等
 * 其余事件归入 'other'，不参与结果选择。
 */
export type TurnSessionEvent =
  | {
      readonly type: 'assistant/message'
      readonly turn: number
      readonly step: number
      readonly content: readonly TurnBlockLike[]
      readonly interrupted?: boolean
    }
  | { readonly type: 'tool/result'; readonly turn: number; readonly step: number; readonly callId?: string }
  | { readonly type: 'turn/end'; readonly turn: number; readonly reason: { readonly kind: string } }
  | { readonly type: 'other'; readonly turn?: number }

/**
 * 事件端口。真实实现（T9）包装 agent.ctx 的事件订阅并按 session.id 过滤；subscribe
 * 必须在 followup 之前调用（观察器先于驱动，8.1），返回取消订阅函数。
 */
export interface TurnEventSource {
  subscribe(handlers: {
    onInboxClaimed(payload: { messageId: string; turn: number }): void
    onSessionEvent(event: TurnSessionEvent): void
  }): () => void
}

/** dsh 宿主端口在 session-manager AgentHost 之上的增量：构造本轮 UserMessage。 */
export interface TurnHost extends AgentHost {
  /** 返回带稳定 id 的冻结 UserMessage；message 原样交给 agent.followup。 */
  createUserMessage(text: string): { id: string; message: unknown }
}

export interface RunTurnInput {
  /** 已 prepare 完成的会话句柄（含已恢复/已新建），本模块不创建或释放它。 */
  handle: AgentHandleLike
  /** 已 trim 的用户输入。 */
  text: string
  /** prepare 时重建过会话 → 所有 envelope 的 notices 首位插入 session-recreated（7.5）。 */
  recreated: boolean
  /** 本执行的请求标识（调度层 requestId）；终态门登记与日志关联用。 */
  runToken: string
  /**
   * 平台回复预算上限（来自入站 ReplyPolicy.maxMessages）；envelope 原样携带，渠道不得放大。
   * （简报接口未列出该字段，但 ReplyEnvelope 必须携带 maxMessages，故补此输入。）
   */
  maxMessages: number
  /** 单调时钟截止点（T9 计算：获得执行槽时 + turn 执行预算，9.1）。 */
  deadlineMono: number
  deliver: (envelope: ReplyEnvelope) => Promise<DeliveryReport>
  /** flush 失败 / 无持久化监听者 / 契约异常清理失败 → T9 转 core failed；handle 不可复用。 */
  onFatal: (reason: string) => void
}

export type TurnOutcomeKind =
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'stopping'
  | 'fatal'

export interface TurnOutcome {
  kind: TurnOutcomeKind
  /** healthy=可复用（T9 markIdle）；needs-release=必须走释放路径。 */
  handleHealth: 'healthy' | 'needs-release'
  /** timeout/stopping 路径：取消后 5s 内 agent 是否停稳并完成 flush；其余路径按是否停稳+flush 填写。 */
  settled: boolean
  /** 单调耗时（日志与诊断）。 */
  runMs: number
}

export interface TurnRunner {
  run(input: RunTurnInput): Promise<TurnOutcome>
  /** 停机协调器（T9）调用：向指定 runToken 的终态门提交 'stopping'（若该 run 尚未终态）。幂等安全。 */
  stopInterrupt(runToken: string): void
}

/** 终态门状态；第一个同步提交的非 running 值获胜，之后仅允许清理（晚到结果隔离）。 */
type GateState = 'running' | 'result-ready' | 'timeout' | 'stopping'

interface AssistantRecord {
  readonly content: readonly TurnBlockLike[]
  readonly interrupted?: boolean
}

/** 预算耗尽哨兵：raceTimeout 超时以该值 reject，调用点据此与真实错误区分。 */
const TIMED_OUT = Symbol('turn-runner timeout')

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 条件等待信号：每次 signal 唤醒当前 waiter 并换新 promise；等待方在循环里重查谓词。 */
function createSignaller(): { wait(): Promise<void>; signal(): void } {
  let resolve: () => void = () => undefined
  let promise = new Promise<void>((r) => {
    resolve = r
  })
  return {
    wait: () => promise,
    signal: () => {
      const fire = resolve
      promise = new Promise<void>((r) => {
        resolve = r
      })
      fire()
    },
  }
}

function createDeferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** 以墙外定时器为某步操作加上限；超时以 TIMED_OUT reject，迟到 rejection 已预挂处理器。 */
function raceTimeout<T>(op: Promise<T>, ms: number): Promise<T> {
  op.then(
    () => undefined,
    () => undefined,
  )
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(TIMED_OUT), Math.max(0, ms))
    timer.unref?.()
    op.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/** limits 注入形状：键集合与 GATEWAY_LIMITS 一致；值放宽为 number 以便测试注入小预算。 */
export type TurnRunnerLimits = { readonly [K in keyof typeof GATEWAY_LIMITS]: number }

export function createTurnRunner(options: {
  host: TurnHost
  eventsFor: (handle: AgentHandleLike) => TurnEventSource
  limits: TurnRunnerLimits
  logger: GatewayLogger
  /** 单调时钟（毫秒）；默认 performance.now 的整数毫秒。 */
  mono?: () => number
}): TurnRunner {
  const { host, eventsFor, limits, logger } = options
  const mono: () => number = options.mono ?? (() => Math.round(performance.now()))

  /** runToken → 终态门中断入口；run 结束时移除，之后的 stopInterrupt 为 no-op。 */
  const runs = new Map<string, { interrupt(): void }>()

  function stopInterrupt(runToken: string): void {
    runs.get(runToken)?.interrupt()
  }

  async function run(input: RunTurnInput): Promise<TurnOutcome> {
    const { handle } = input
    const runStart = mono()
    const sessionId = handle.agent.session.id

    const signaller = createSignaller()
    const finish = createDeferred<TurnOutcome>()
    let finished = false
    const finishOnce = (outcome: TurnOutcome): void => {
      if (finished) {
        return
      }
      finished = true
      finish.resolve(outcome)
    }

    // ---- 终态门与观察状态（事件回调只同步写这里） ----
    let gate: GateState = 'running'
    /** 第一个同步提交的终态获胜；后续提交只返回 false（晚到方仅清理）。 */
    const submitGate = (kind: 'result-ready' | 'timeout' | 'stopping'): boolean => {
      if (gate !== 'running') {
        return false
      }
      gate = kind
      signaller.signal()
      return true
    }

    let userMessage: { id: string; message: unknown } | undefined
    let claimedTurn: number | undefined
    const assistantMessages: AssistantRecord[] = []
    const completedToolCalls = new Set<string>()
    let targetTurnEnd: { kind: string } | undefined
    /** 尚无 claimed 记录时观察到 turn/end：输入从未被 claimed 的契约异常（8.2 表末行）。 */
    let neverClaimedTurnEnd = false

    let idlePromise: Promise<void> | undefined
    function whenIdleOnce(): Promise<void> {
      if (idlePromise === undefined) {
        idlePromise = Promise.resolve(handle.agent.whenIdle())
        idlePromise.catch(() => undefined)
      }
      return idlePromise
    }

    const logBase = (): { requestId: string; sessionId: string; turn?: number } => ({
      requestId: input.runToken,
      sessionId,
      turn: claimedTurn,
    })

    function makeEnvelope(body: { text?: string; notices: readonly NoticeKind[] }): ReplyEnvelope {
      const notices: NoticeKind[] = input.recreated ? ['session-recreated', ...body.notices] : [...body.notices]
      const envelope: ReplyEnvelope = { notices, maxMessages: input.maxMessages }
      if (body.text !== undefined) {
        envelope.text = body.text
      }
      return envelope
    }

    /** 恰一次 deliver 的封装：报告按状态记日志，投递异常只记日志、不影响 outcome（12 节投递边界）。 */
    async function deliverEnvelope(envelope: ReplyEnvelope): Promise<void> {
      try {
        const report = await input.deliver(envelope)
        const fields = { ...logBase(), outputLength: envelope.text?.length ?? 0 }
        if (report.status === 'sent') {
          logger.logEvent('reply_sent', fields)
        } else if (report.status === 'partial') {
          logger.logEvent('reply_partial', fields)
        } else if (report.status === 'unknown') {
          logger.logEvent('reply_unknown', fields)
        } else {
          logger.logEvent('reply_failed', { ...fields, reason: `delivery status ${report.status}` })
        }
      } catch (err) {
        logger.logEvent('reply_failed', { ...logBase(), reason: `deliver threw: ${errorMessage(err)}` })
      }
    }

    /** 发送前的有界 flush（成功与失败终态都要，8.2）；false / reject / 超时统一转 fatal。 */
    async function flushOrFatal(): Promise<'flushed' | 'fatal'> {
      let flushed: boolean
      try {
        flushed = await raceTimeout(host.flushSession(handle.agent.session), limits.SESSION_FLUSH_TIMEOUT_MS)
      } catch (err) {
        await fatal('flush_failed', err === TIMED_OUT ? 'session flush timed out' : `session flush failed: ${errorMessage(err)}`)
        return 'fatal'
      }
      if (!flushed) {
        await fatal('no_persistence_listener', 'session flush reported no persistence listener')
        return 'fatal'
      }
      return 'flushed'
    }

    /** fatal 路径：只发失败提示（不发正常文本）、回调 onFatal、handle 不可复用。 */
    async function fatal(reason: string, detail: string): Promise<void> {
      logger.logEvent('turn_failed', { ...logBase(), reason: `fatal: ${detail}`, runMs: mono() - runStart })
      await deliverEnvelope(makeEnvelope({ notices: ['turn-failed'] }))
      try {
        input.onFatal(reason)
      } catch (err) {
        logger.logEvent('turn_failed', { ...logBase(), reason: `onFatal callback threw: ${errorMessage(err)}` })
      }
      finishOnce({ kind: 'fatal', handleHealth: 'needs-release', settled: false, runMs: mono() - runStart })
    }

    /**
     * 超时/停止共用路径（9.2.1-9.2.3）：gate 已由调用方赢下。cancel → deliver（仅 timeout）
     * 与停稳等待并行 → 停稳后尽力 flush（失败记日志不转 fatal）→ 两者都结束才出 outcome。
     */
    async function cancelledPath(kind: 'timeout' | 'stopping'): Promise<void> {
      const runMsNow = (): number => mono() - runStart
      try {
        handle.agent.cancel({ kind: 'user' })
      } catch (err) {
        logger.logEvent('turn_failed', { ...logBase(), reason: `agent cancel threw: ${errorMessage(err)}` })
      }
      if (kind === 'timeout') {
        logger.logEvent('turn_timeout', { ...logBase(), reason: 'execution deadline reached', runMs: runMsNow() })
      } else {
        logger.logEvent('turn_failed', { ...logBase(), reason: 'run cancelled by stop coordinator', runMs: runMsNow() })
      }

      // deliver 与清理并行（9.2.2）；outcome 在两者都结束后 resolve。
      const deliverP: Promise<void> =
        kind === 'timeout' ? deliverEnvelope(makeEnvelope({ notices: ['turn-timeout'] })) : Promise.resolve()

      let settled = false
      let healthy = false
      try {
        await raceTimeout(whenIdleOnce(), limits.CANCEL_SETTLE_WAIT_MS)
        try {
          const flushed = await raceTimeout(host.flushSession(handle.agent.session), limits.SESSION_FLUSH_TIMEOUT_MS)
          // settled = 停稳且 flush 调用完成（TurnOutcome 契约）；复用与否另由 healthy 表达。
          settled = true
          if (!flushed) {
            logger.logEvent('state_warning', {
              ...logBase(),
              reason: 'session flush reported no persistence listener during cancelled-turn cleanup',
            })
          }
          healthy = flushed
        } catch (err) {
          logger.logEvent('turn_failed', {
            ...logBase(),
            reason:
              err === TIMED_OUT
                ? 'session flush timed out during cancelled-turn cleanup'
                : `session flush failed during cancelled-turn cleanup: ${errorMessage(err)}`,
          })
          settled = false
          healthy = false
        }
      } catch {
        // 未停稳（9.2.4）：needs-release，释放决策交回调用方（T9 releaseHandle）。
        settled = false
        healthy = false
      }
      await deliverP
      finishOnce({
        kind,
        handleHealth: healthy ? 'healthy' : 'needs-release',
        settled,
        runMs: mono() - runStart,
      })
    }

    /** 8.2 最终文本选择：最后一个非 interrupted、且 tool-call 全部已有 tool/result 的消息。 */
    function selectFinalText(): { ok: true; text: string } | { ok: false } {
      for (let i = assistantMessages.length - 1; i >= 0; i -= 1) {
        const message = assistantMessages[i]
        if (message.interrupted === true) {
          continue
        }
        let pendingToolCall = false
        for (const block of message.content) {
          if (block.type === 'tool-call' && block.id !== undefined && !completedToolCalls.has(block.id)) {
            pendingToolCall = true
            break
          }
        }
        if (pendingToolCall) {
          continue
        }
        let text = ''
        for (const block of message.content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            text += block.text
          }
        }
        return { ok: true, text }
      }
      return { ok: false }
    }

    /**
     * 正常结果路径（gate 已赢 'result-ready'、whenIdle 已成功、mono 未越界）。
     * reason.kind 分派见 8.2 表；flush 失败转 fatal；deliver 异常不影响 outcome。
     */
    async function resultPath(): Promise<void> {
      const reasonKind = targetTurnEnd?.kind ?? 'unknown'
      type Plan =
        | { kind: 'completed'; text?: string; notices: readonly NoticeKind[] }
        | { kind: 'failed'; notices: readonly NoticeKind[]; reason: string }
      let plan: Plan
      if (reasonKind === 'completed' || reasonKind === 'max-tokens') {
        const selection = selectFinalText()
        if (!selection.ok) {
          plan = { kind: 'failed', notices: ['turn-failed'], reason: 'no usable final assistant message in turn' }
        } else if (selection.text === '') {
          plan = { kind: 'completed', notices: ['empty-reply'] }
        } else if (reasonKind === 'completed') {
          plan = { kind: 'completed', text: selection.text, notices: [] }
        } else {
          plan = { kind: 'completed', text: selection.text, notices: ['model-output-limited'] }
        }
      } else {
        // error/blocked/aborted/interrupted/forked/未知：失败提示，不发任何中间文本。
        plan = { kind: 'failed', notices: ['turn-failed'], reason: `turn ended with reason ${reasonKind}` }
      }

      if ((await flushOrFatal()) === 'fatal') {
        return
      }
      await deliverEnvelope(makeEnvelope(plan.kind === 'completed' && plan.text !== undefined ? { text: plan.text, notices: plan.notices } : { notices: plan.notices }))
      const runMs = mono() - runStart
      if (plan.kind === 'completed') {
        logger.logEvent('turn_completed', {
          ...logBase(),
          outputLength: plan.text?.length ?? 0,
          runMs,
          outcome: reasonKind,
        })
      } else {
        logger.logEvent('turn_failed', { ...logBase(), reason: plan.reason, runMs })
      }
      finishOnce({
        kind: plan.kind,
        // 停稳（whenIdle 成功）且 flush 成功才可复用；结果为 failed 的 turn 同样适用（12 表）。
        handleHealth: 'healthy',
        settled: true,
        runMs,
      })
    }

    /**
     * 运行契约异常（never claimed / whenIdle reject / setup 抛错）：cancel + 失败提示 + needs-release。
     *
     * 入口先赢终态门（同步、先于本函数内的任何 await）：否则 flush 与 deliver 的等待窗口内，
     * deadline 定时器或 stopInterrupt 仍可提交 timeout/stopping 并行启动取消路径，对同一
     * 入站发出第二个终态 envelope（12 节：每个 gateway 任务只生成一次终态 envelope）。
     * 已输掉门竞争的调用直接返回，envelope 与清理由获胜方负责。
     */
    async function contractFailure(detail: string): Promise<void> {
      if (!submitGate('result-ready')) {
        return
      }
      logger.logEvent('turn_failed', { ...logBase(), reason: `runtime contract violation: ${detail}` })
      try {
        handle.agent.cancel({ kind: 'user' })
      } catch (err) {
        logger.logEvent('turn_failed', { ...logBase(), reason: `agent cancel threw: ${errorMessage(err)}` })
      }
      if ((await flushOrFatal()) === 'fatal') {
        return
      }
      await deliverEnvelope(makeEnvelope({ notices: ['turn-failed'] }))
      finishOnce({ kind: 'failed', handleHealth: 'needs-release', settled: false, runMs: mono() - runStart })
    }

    /** 主流程：等待 claimed → targetTurn 的 turn/end → whenIdle → 单调时钟检查 → 赢下结果路径。 */
    const mainFlow = async (): Promise<void> => {
      try {
        while (gate === 'running' && claimedTurn === undefined && !neverClaimedTurnEnd) {
          await signaller.wait()
        }
        if (gate !== 'running') {
          return
        }
        if (claimedTurn === undefined) {
          await contractFailure('turn ended while our input was never claimed')
          return
        }

        while (gate === 'running' && targetTurnEnd === undefined) {
          await signaller.wait()
        }
        if (gate !== 'running') {
          return
        }

        // whenIdle 只证明无活动驱动，不是成功证明；与终态门变化竞速以便被取消路径接管。
        // idleSettled 在 idleRace 的处理器内同步置位，race 因 idleRace 唤醒时标志必然已生效。
        let idleSettled = false
        let idleError: unknown
        const idleRace = whenIdleOnce().then(
          () => {
            idleSettled = true
          },
          (err: unknown) => {
            idleSettled = true
            idleError = err
          },
        )
        while (gate === 'running' && !idleSettled) {
          await Promise.race([idleRace, signaller.wait()])
        }
        if (gate !== 'running') {
          return
        }
        if (idleError !== undefined) {
          await contractFailure(`agent whenIdle rejected: ${errorMessage(idleError)}`)
          return
        }

        // 成功判定前的单调时钟检查（9.1）：越界结果丢弃，走 timeout 路径。
        if (mono() >= input.deadlineMono) {
          logger.logEvent('late_result_dropped', {
            ...logBase(),
            reason: `result ready after deadline (reason ${targetTurnEnd?.kind ?? 'unknown'})`,
          })
          if (submitGate('timeout')) {
            await cancelledPath('timeout')
          }
          return
        }
        if (!submitGate('result-ready')) {
          return
        }
        await resultPath()
      } catch (err) {
        // 防御：主流程意外异常按契约异常收尾，保证 run() 不悬挂。gate 仍为 running 时
        // contractFailure 入口自会赢门；门已被本 run 的某路径持有但该路径在本 try 内
        // 崩溃时（正常情况下 mainFlow 在终态后直接返回），以 failed 兜底收尾——finishOnce
        // 的单次保护避免抢占仍在收尾的 outcome。
        logger.logEvent('turn_failed', { ...logBase(), reason: `internal main-flow error: ${errorMessage(err)}` })
        if (finished) {
          return
        }
        if (gate === 'running') {
          await contractFailure(`internal main-flow error: ${errorMessage(err)}`)
          return
        }
        finishOnce({ kind: 'failed', handleHealth: 'needs-release', settled: false, runMs: mono() - runStart })
      }
    }

    // ---- 启动：登记 runToken → 定时器 → 创建消息 → 订阅（先于 followup）→ followup ----
    /** 防御包装：路径意外抛错时记日志并以 failed 收尾，保证 run() 不悬挂。 */
    const guardedPath = (fn: () => Promise<void>): void => {
      fn().catch((err: unknown) => {
        logger.logEvent('turn_failed', { ...logBase(), reason: `internal path error: ${errorMessage(err)}` })
        finishOnce({ kind: 'failed', handleHealth: 'needs-release', settled: false, runMs: mono() - runStart })
      })
    }
    const interrupt = (): void => {
      if (submitGate('stopping')) {
        guardedPath(() => cancelledPath('stopping'))
      }
    }
    runs.set(input.runToken, { interrupt })

    const timer = setTimeout(() => {
      if (submitGate('timeout')) {
        guardedPath(() => cancelledPath('timeout'))
      }
    }, Math.max(0, input.deadlineMono - mono()))
    timer.unref?.()

    let unsubscribe: (() => void) | undefined
    try {
      userMessage = host.createUserMessage(input.text)
      unsubscribe = eventsFor(handle).subscribe({
        onInboxClaimed: (payload) => {
          if (userMessage !== undefined && payload.messageId === userMessage.id && claimedTurn === undefined) {
            claimedTurn = payload.turn
            signaller.signal()
          }
        },
        onSessionEvent: (event) => {
          if (event.type === 'assistant/message') {
            if (claimedTurn !== undefined && event.turn === claimedTurn) {
              assistantMessages.push({ content: event.content, interrupted: event.interrupted })
            }
            return
          }
          if (event.type === 'tool/result') {
            if (claimedTurn !== undefined && event.turn === claimedTurn && event.callId !== undefined) {
              completedToolCalls.add(event.callId)
            }
            return
          }
          if (event.type === 'turn/end') {
            if (claimedTurn !== undefined && event.turn === claimedTurn) {
              if (gate !== 'running') {
                // 晚到结果隔离（9.2.2）：终态之后的 turn/end 只记录，不再产生 envelope。
                logger.logEvent('late_result_dropped', {
                  ...logBase(),
                  reason: `late turn/end (${event.reason.kind}) after terminal state ${gate}`,
                })
              } else if (targetTurnEnd === undefined) {
                targetTurnEnd = event.reason
                signaller.signal()
              }
            } else if (claimedTurn === undefined && gate === 'running') {
              neverClaimedTurnEnd = true
              signaller.signal()
            }
          }
          // 'other'（turn/start、tool/call 等）不参与结果选择。
        },
      })
      handle.agent.followup(userMessage.message)
    } catch (err) {
      logger.logEvent('turn_failed', {
        requestId: input.runToken,
        sessionId,
        reason: `turn setup failed: ${errorMessage(err)}`,
      })
      await contractFailure(`setup failed: ${errorMessage(err)}`)
    }
    if (!finished) {
      // guardedPath 兜底：mainFlow 内部虽有全量 try/catch，若 catch 块自身抛错也不悬挂。
      guardedPath(mainFlow)
    }

    const outcome = await finish.promise
    clearTimeout(timer)
    unsubscribe?.()
    runs.delete(input.runToken)
    return outcome
  }

  return { run, stopInterrupt }
}
