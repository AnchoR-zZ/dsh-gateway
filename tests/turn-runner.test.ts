import { describe, expect, it } from 'vitest'

import { GATEWAY_LIMITS } from '../src/contracts.js'
import type { DeliveryReport, ReplyEnvelope } from '../src/contracts.js'
import type { GatewayLogger } from '../src/logging.js'
import type { AgentHandleLike } from '../src/core/session-manager.js'
import {
  createTurnRunner,
  type RunTurnInput,
  type TurnBlockLike,
  type TurnEventSource,
  type TurnHost,
  type TurnOutcome,
  type TurnRunnerLimits,
  type TurnSessionEvent,
} from '../src/core/turn-runner.js'

/**
 * turn-runner 测试：手写事件泵（FakeEventSource）+ 脚本化 FakeTurnHost + 注入 mono/小预算 limits。
 * 不接触真实 dsh；所有事件由测试同步泵入，回调只做同步记录（8.1）。
 */

/** 小预算 limits：真实键集合 + 毫秒级超时，避免测试等待 5s。 */
const SMALL_LIMITS: TurnRunnerLimits = {
  ...GATEWAY_LIMITS,
  CANCEL_SETTLE_WAIT_MS: 30,
  SESSION_FLUSH_TIMEOUT_MS: 30,
}

const SENT: DeliveryReport = { status: 'sent', attempted: 1, confirmed: 1 }

type FlushBehavior = 'resolve-true' | 'resolve-false' | 'reject' | 'hang'

interface ClaimHandlers {
  onInboxClaimed(payload: { messageId: string; turn: number }): void
  onSessionEvent(event: TurnSessionEvent): void
}

function assistantMsg(
  turn: number,
  blocks: readonly TurnBlockLike[],
  opts?: { interrupted?: boolean },
): TurnSessionEvent {
  return { type: 'assistant/message', turn, step: 0, content: blocks, interrupted: opts?.interrupted }
}

function toolResult(turn: number, callId?: string): TurnSessionEvent {
  return { type: 'tool/result', turn, step: 0, callId }
}

function turnEnd(turn: number, kind: string): TurnSessionEvent {
  return { type: 'turn/end', turn, reason: { kind } }
}

class Harness {
  readonly ops: string[] = []
  readonly logs: { event: string; fields?: Record<string, unknown> }[] = []
  readonly delivered: ReplyEnvelope[] = []
  readonly fatals: string[] = []
  readonly cancels: { kind: string }[] = []
  readonly followups: unknown[] = []
  monoNow = 1_000
  flushBehavior: FlushBehavior = 'resolve-true'
  whenIdleImpl: () => Promise<void> = () => Promise.resolve()
  deliverImpl: (envelope: ReplyEnvelope) => Promise<DeliveryReport> = async (envelope) => {
    this.delivered.push(envelope)
    return SENT
  }
  lastMessageId = 'unset'
  private handlers: ClaimHandlers | undefined

  readonly logger: GatewayLogger = {
    logEvent: (event, fields) => {
      this.logs.push({ event, fields: fields as Record<string, unknown> | undefined })
    },
    debugBody: () => undefined,
  }

  readonly handle: AgentHandleLike = {
    agent: {
      id: 'agent-1',
      session: { id: 'session-1', header: { cwd: 'C:/ws/session-1' } },
      followup: (message: unknown) => {
        this.ops.push('followup')
        this.followups.push(message)
      },
      cancel: (cause: { kind: string }) => {
        this.ops.push('cancel')
        this.cancels.push(cause)
      },
      whenIdle: () => {
        this.ops.push('whenIdle')
        return this.whenIdleImpl()
      },
      inbox: { clear: () => this.ops.push('inbox.clear') },
      status: 'idle' as const,
    },
    dispose: async () => {
      this.ops.push('dispose')
    },
  }

  readonly host: TurnHost = {
    currentModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    createAgent: async () => {
      throw new Error('createAgent not used by turn-runner')
    },
    resumeAgent: async () => {
      throw new Error('resumeAgent not used by turn-runner')
    },
    flushSession: async () => {
      this.ops.push('flush')
      if (this.flushBehavior === 'resolve-false') {
        return false
      }
      if (this.flushBehavior === 'reject') {
        throw new Error('flush rejected by fake host')
      }
      if (this.flushBehavior === 'hang') {
        return await new Promise<boolean>(() => undefined)
      }
      return true
    },
    isAgentLive: () => true,
    createUserMessage: (text: string) => {
      this.ops.push('createUserMessage')
      const id = `user-msg-${this.ops.length}`
      this.lastMessageId = id
      return { id, message: { id, content: [{ type: 'text', text }], source: { kind: 'user' } } }
    },
  }

  readonly source: TurnEventSource = {
    subscribe: (handlers) => {
      this.ops.push('subscribe')
      this.handlers = handlers
      return () => {
        this.ops.push('unsubscribe')
      }
    },
  }

  readonly runner = createTurnRunner({
    host: this.host,
    eventsFor: () => this.source,
    limits: SMALL_LIMITS,
    logger: this.logger,
    mono: () => this.monoNow,
  })

  claim(turn: number, messageId?: string): void {
    this.handlers?.onInboxClaimed({ messageId: messageId ?? this.lastMessageId, turn })
  }

  pump(...events: readonly TurnSessionEvent[]): void {
    for (const event of events) {
      this.handlers?.onSessionEvent(event)
    }
  }

  makeInput(overrides?: Partial<RunTurnInput>): RunTurnInput {
    return {
      handle: this.handle,
      text: '你好',
      recreated: false,
      runToken: 'run-1',
      maxMessages: 4,
      deadlineMono: this.monoNow + 600_000,
      deliver: (envelope) => {
        this.ops.push('deliver')
        return this.deliverImpl(envelope)
      },
      onFatal: (reason) => {
        this.fatals.push(reason)
      },
      ...overrides,
    }
  }

  events(name: string): { event: string; fields?: Record<string, unknown> }[] {
    return this.logs.filter((entry) => entry.event === name)
  }

  opOrder(a: string, b: string): number {
    const ia = this.ops.indexOf(a)
    const ib = this.ops.indexOf(b)
    return ia - ib
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** 泵入一轮正常完成的事件（claimed → 混合中间消息 → 工具 → 最终消息 → turn/end）。 */
function pumpNormalCompletion(h: Harness, turn = 7): void {
  h.claim(turn)
  h.pump(
    assistantMsg(turn, [
      { type: 'reasoning', text: '先想一想' },
      { type: 'text', text: '中间步骤说明' },
    ]),
    assistantMsg(turn, [{ type: 'tool-call', id: 't1' }]),
    toolResult(turn, 't1'),
    assistantMsg(turn, [
      { type: 'reasoning', text: '收尾思考' },
      { type: 'text', text: '最终答案' },
    ]),
    turnEnd(turn, 'completed'),
  )
}

describe('turn-runner 正常路径（8.1/8.2）', () => {
  it('正常完成：只取最后有效消息的 text block，reasoning 与中间文本不进入 envelope，deliver 恰一次', async () => {
    const h = new Harness()
    const outcomePromise = h.runner.run(h.makeInput())
    pumpNormalCompletion(h)
    const outcome = await outcomePromise

    expect(outcome).toEqual({ kind: 'completed', handleHealth: 'healthy', settled: true, runMs: expect.any(Number) })
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0].text).toBe('最终答案')
    expect(h.delivered[0].notices).toEqual([])
    expect(h.delivered[0].maxMessages).toBe(4)
    expect(h.delivered[0].text).not.toContain('中间')
    expect(h.events('turn_completed')).toHaveLength(1)
    expect(h.events('turn_completed')[0].fields?.turn).toBe(7)
  })

  it('订阅先于 followup，flush 先于 deliver，结束后取消订阅', async () => {
    const h = new Harness()
    const outcomePromise = h.runner.run(h.makeInput())
    pumpNormalCompletion(h)
    await outcomePromise

    expect(h.opOrder('subscribe', 'followup')).toBeLessThan(0)
    expect(h.opOrder('createUserMessage', 'subscribe')).toBeLessThan(0)
    expect(h.opOrder('flush', 'deliver')).toBeLessThan(0)
    expect(h.ops).toContain('unsubscribe')
  })

  it('空回复：最终消息只有 reasoning/tool-call（工具已完成）→ empty-reply', async () => {
    const h = new Harness()
    const outcomePromise = h.runner.run(h.makeInput())
    h.claim(2)
    h.pump(
      assistantMsg(2, [{ type: 'tool-call', id: 't1' }]),
      toolResult(2, 't1'),
      assistantMsg(2, [{ type: 'reasoning', text: '只有思考' }]),
      turnEnd(2, 'completed'),
    )
    const outcome = await outcomePromise

    expect(outcome.kind).toBe('completed')
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0].notices).toEqual(['empty-reply'])
    expect(h.delivered[0].text).toBeUndefined()
  })

  it('max-tokens：有文本 → 附加 model-output-limited；无文本 → empty-reply', async () => {
    const h1 = new Harness()
    const p1 = h1.runner.run(h1.makeInput())
    h1.claim(1)
    h1.pump(assistantMsg(1, [{ type: 'text', text: '被截断的回答' }]), turnEnd(1, 'max-tokens'))
    const o1 = await p1
    expect(o1.kind).toBe('completed')
    expect(h1.delivered[0].text).toBe('被截断的回答')
    expect(h1.delivered[0].notices).toEqual(['model-output-limited'])

    const h2 = new Harness()
    const p2 = h2.runner.run(h2.makeInput())
    h2.claim(1)
    h2.pump(assistantMsg(1, [{ type: 'reasoning', text: '只有思考' }]), turnEnd(1, 'max-tokens'))
    await p2
    expect(h2.delivered[0].notices).toEqual(['empty-reply'])
    expect(h2.delivered[0].text).toBeUndefined()
  })

  it('error / blocked → turn-failed，不发正文；停稳且 flush 成功 → handle 可复用', async () => {
    for (const reason of ['error', 'blocked']) {
      const h = new Harness()
      const outcomePromise = h.runner.run(h.makeInput())
      h.claim(4)
      h.pump(
        assistantMsg(4, [{ type: 'text', text: '失败前的中间输出' }]),
        turnEnd(4, reason),
      )
      const outcome = await outcomePromise

      expect(outcome).toEqual({ kind: 'failed', handleHealth: 'healthy', settled: true, runMs: expect.any(Number) })
      expect(h.delivered).toHaveLength(1)
      expect(h.delivered[0].notices).toEqual(['turn-failed'])
      expect(h.delivered[0].text).toBeUndefined()
      expect(h.events('turn_failed')).toHaveLength(1)
    }
  })

  it('interrupted 前缀不作为最终消息；全部 interrupted → failed', async () => {
    const h = new Harness()
    const p = h.runner.run(h.makeInput())
    h.claim(9)
    h.pump(
      assistantMsg(9, [{ type: 'text', text: '被打断的输出' }], { interrupted: true }),
      assistantMsg(9, [{ type: 'text', text: '真正的最终输出' }]),
      turnEnd(9, 'completed'),
    )
    const outcome = await p
    expect(outcome.kind).toBe('completed')
    expect(h.delivered[0].text).toBe('真正的最终输出')

    const h2 = new Harness()
    const p2 = h2.runner.run(h2.makeInput())
    h2.claim(9)
    h2.pump(
      assistantMsg(9, [{ type: 'text', text: '被打断的输出' }], { interrupted: true }),
      turnEnd(9, 'completed'),
    )
    const outcome2 = await p2
    expect(outcome2.kind).toBe('failed')
    expect(outcome2.handleHealth).toBe('healthy')
    expect(h2.delivered[0].notices).toEqual(['turn-failed'])
    expect(h2.delivered[0].text).toBeUndefined()
  })

  it('待执行 tool call：最后消息的 tool-call 无对应 tool/result → 回退更早可用消息；全无 → failed', async () => {
    const h = new Harness()
    const p = h.runner.run(h.makeInput())
    h.claim(5)
    h.pump(
      assistantMsg(5, [
        { type: 'text', text: '先读文件' },
        { type: 'tool-call', id: 't1' },
      ]),
      toolResult(5, 't1'),
      assistantMsg(5, [
        { type: 'text', text: '发起另一个工具' },
        { type: 'tool-call', id: 't9' },
      ]),
      turnEnd(5, 'completed'),
    )
    const outcome = await p
    expect(outcome.kind).toBe('completed')
    expect(h.delivered[0].text).toBe('先读文件')

    const h2 = new Harness()
    const p2 = h2.runner.run(h2.makeInput())
    h2.claim(5)
    h2.pump(assistantMsg(5, [{ type: 'tool-call', id: 't9' }]), turnEnd(5, 'completed'))
    const outcome2 = await p2
    expect(outcome2.kind).toBe('failed')
    expect(h2.delivered[0].notices).toEqual(['turn-failed'])
  })

  it('recreated：session-recreated 排在 completed / failed / timeout 的 notices 首位', async () => {
    const h1 = new Harness()
    const p1 = h1.runner.run(h1.makeInput({ recreated: true }))
    h1.claim(1)
    h1.pump(assistantMsg(1, [{ type: 'text', text: 'ok' }]), turnEnd(1, 'completed'))
    await p1
    expect(h1.delivered[0].notices).toEqual(['session-recreated'])

    const h2 = new Harness()
    const p2 = h2.runner.run(h2.makeInput({ recreated: true }))
    h2.claim(1)
    h2.pump(turnEnd(1, 'error'))
    await p2
    expect(h2.delivered[0].notices).toEqual(['session-recreated', 'turn-failed'])

    const h3 = new Harness()
    const p3 = h3.runner.run(
      h3.makeInput({ recreated: true, deadlineMono: h3.monoNow + 20 }),
    )
    await p3
    expect(h3.delivered[0].notices).toEqual(['session-recreated', 'turn-timeout'])
  })

  it('deliver 抛错：记 reply_failed，outcome 仍为 completed（12 节投递边界）', async () => {
    const h = new Harness()
    h.deliverImpl = () => Promise.reject(new Error('qq send boom'))
    const outcomePromise = h.runner.run(h.makeInput())
    h.claim(1)
    h.pump(assistantMsg(1, [{ type: 'text', text: '答案' }]), turnEnd(1, 'completed'))
    const outcome = await outcomePromise
    expect(outcome.kind).toBe('completed')
    expect(h.events('reply_failed')).toHaveLength(1)
    expect(h.events('turn_completed')).toHaveLength(1)
  })

  it('runMs 为单调耗时（注入递增 mono 时 > 0）', async () => {
    const h = new Harness()
    h.monoNow = 1_000
    let callCount = 0
    const runner = createTurnRunner({
      host: h.host,
      eventsFor: () => h.source,
      limits: SMALL_LIMITS,
      logger: h.logger,
      mono: () => {
        callCount += 1
        return 1_000 + callCount
      },
    })
    const outcomePromise = runner.run(h.makeInput())
    h.claim(1)
    h.pump(assistantMsg(1, [{ type: 'text', text: 'ok' }]), turnEnd(1, 'completed'))
    const outcome: TurnOutcome = await outcomePromise
    expect(outcome.runMs).toBeGreaterThan(0)
  })
})

describe('turn-runner 终态门与竞态（9.1）', () => {
  it('结果先于 deadline 到达：定时器不再覆盖，outcome 为 completed', async () => {
    const h = new Harness()
    // deadline 距今 200ms（真实定时器），事件同步完成在几毫秒内 → 结果先赢。
    const p = h.runner.run(h.makeInput({ deadlineMono: h.monoNow + 200 }))
    pumpNormalCompletion(h)
    const outcome = await p
    expect(outcome.kind).toBe('completed')
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0].text).toBe('最终答案')
  })

  it('结果越过 deadline（mono 检查）：丢弃结果走 timeout，记 late_result_dropped，cancel 被调', async () => {
    const h = new Harness()
    let resolveIdle: () => void = () => undefined
    h.whenIdleImpl = () =>
      new Promise<void>((resolve) => {
        resolveIdle = resolve
      })
    const deadline = h.monoNow + 600_000
    const p = h.runner.run(h.makeInput({ deadlineMono: deadline }))
    h.claim(3)
    h.pump(assistantMsg(3, [{ type: 'text', text: '迟到的完整答案' }]), turnEnd(3, 'completed'))
    await waitFor(() => h.ops.includes('whenIdle'))
    // whenIdle 已 resolve 前，把单调时钟推过截止点，再放行停稳。
    h.monoNow = deadline + 10
    resolveIdle()
    const outcome = await p

    expect(outcome.kind).toBe('timeout')
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0].notices).toEqual(['turn-timeout'])
    expect(h.delivered[0].text).toBeUndefined()
    expect(h.cancels).toEqual([{ kind: 'user' }])
    expect(h.events('late_result_dropped')).toHaveLength(1)
    expect(h.events('turn_timeout')).toHaveLength(1)
  })
})

describe('turn-runner 超时路径（9.2）', () => {
  it('超时：cancel 被调、envelope=turn-timeout、停稳成功且 flush 成功 → settled=true healthy', async () => {
    const h = new Harness()
    const p = h.runner.run(h.makeInput({ deadlineMono: h.monoNow + 20 }))
    const outcome = await p

    expect(outcome).toEqual({ kind: 'timeout', handleHealth: 'healthy', settled: true, runMs: expect.any(Number) })
    expect(h.cancels).toEqual([{ kind: 'user' }])
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0].notices).toEqual(['turn-timeout'])
    expect(h.ops).toContain('flush')
    expect(h.events('turn_timeout')).toHaveLength(1)
  })

  it('超时未停稳（whenIdle 挂起）：settled=false needs-release，不 flush', async () => {
    const h = new Harness()
    h.whenIdleImpl = () => new Promise<void>(() => undefined)
    const p = h.runner.run(h.makeInput({ deadlineMono: h.monoNow + 20 }))
    const outcome = await p

    expect(outcome).toEqual({
      kind: 'timeout',
      handleHealth: 'needs-release',
      settled: false,
      runMs: expect.any(Number),
    })
    expect(h.ops).not.toContain('flush')
    expect(h.delivered).toHaveLength(1)
  })

  it('deliver 与停稳并行：挂起 deliver 不阻塞停稳与 flush，outcome 等两者都结束', async () => {
    const h = new Harness()
    let releaseDeliver: (report: DeliveryReport) => void = () => undefined
    h.deliverImpl = (envelope) => {
      h.delivered.push(envelope)
      return new Promise<DeliveryReport>((resolve) => {
        releaseDeliver = resolve
      })
    }
    const p = h.runner.run(h.makeInput({ deadlineMono: h.monoNow + 20 }))
    let resolved = false
    const tracked = p.then(() => {
      resolved = true
    })

    await waitFor(() => h.ops.includes('flush'))
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(h.delivered).toHaveLength(1)
    expect(h.ops).toContain('whenIdle')
    expect(h.ops).toContain('flush')
    expect(resolved).toBe(false)

    releaseDeliver(SENT)
    await tracked
    expect(resolved).toBe(true)
  })

  it('晚到结果隔离：timeout 终态后再泵 turn/end(completed) 不再 deliver', async () => {
    const h = new Harness()
    const p = h.runner.run(h.makeInput({ deadlineMono: h.monoNow + 20 }))
    await p
    expect(h.delivered).toHaveLength(1)

    h.claim(6)
    h.pump(assistantMsg(6, [{ type: 'text', text: '晚到的答案' }]), turnEnd(6, 'completed'))
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0].notices).toEqual(['turn-timeout'])
    expect(h.events('late_result_dropped')).toHaveLength(1)
  })
})

describe('turn-runner flush 故障（8.2 / 12 表）', () => {
  it('flush 返回 false → fatal：只发 turn-failed、onFatal(no_persistence_listener)、needs-release', async () => {
    const h = new Harness()
    h.flushBehavior = 'resolve-false'
    const p = h.runner.run(h.makeInput())
    h.claim(1)
    h.pump(assistantMsg(1, [{ type: 'text', text: '本不该发出的答案' }]), turnEnd(1, 'completed'))
    const outcome = await p

    expect(outcome).toEqual({ kind: 'fatal', handleHealth: 'needs-release', settled: false, runMs: expect.any(Number) })
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0].notices).toEqual(['turn-failed'])
    expect(h.delivered[0].text).toBeUndefined()
    expect(h.fatals).toEqual(['no_persistence_listener'])
  })

  it('flush reject → fatal：onFatal(flush_failed)', async () => {
    const h = new Harness()
    h.flushBehavior = 'reject'
    const p = h.runner.run(h.makeInput())
    h.claim(1)
    h.pump(turnEnd(1, 'error'))
    const outcome = await p

    expect(outcome.kind).toBe('fatal')
    expect(h.delivered[0].notices).toEqual(['turn-failed'])
    expect(h.fatals).toEqual(['flush_failed'])
  })

  it('flush 超时 → fatal：onFatal(flush_failed)', async () => {
    const h = new Harness()
    h.flushBehavior = 'hang'
    const p = h.runner.run(h.makeInput())
    h.claim(1)
    h.pump(turnEnd(1, 'completed'))
    const outcome = await p

    expect(outcome.kind).toBe('fatal')
    expect(h.fatals).toEqual(['flush_failed'])
    expect(h.delivered[0].notices).toEqual(['turn-failed'])
  })
})

describe('turn-runner 停止与契约异常（9.3 / 8.2 表）', () => {
  it('stopInterrupt 运行中调用：stopping outcome、不 deliver、cancel 被调；runToken 错误为 no-op', async () => {
    const h = new Harness()
    const p = h.runner.run(h.makeInput())
    h.runner.stopInterrupt('wrong-token')
    h.claim(2)
    h.pump(assistantMsg(2, [{ type: 'text', text: '进行中' }]))

    h.runner.stopInterrupt('run-1')
    const outcome = await p

    expect(outcome).toEqual({ kind: 'stopping', handleHealth: 'healthy', settled: true, runMs: expect.any(Number) })
    expect(h.delivered).toHaveLength(0)
    expect(h.cancels).toEqual([{ kind: 'user' }])
    // 错误 token 未触发额外 cancel。
    expect(h.cancels).toHaveLength(1)
  })

  it('stopInterrupt 在 run 完成后为 no-op：不产生新 deliver', async () => {
    const h = new Harness()
    const p = h.runner.run(h.makeInput())
    pumpNormalCompletion(h)
    await p
    expect(h.delivered).toHaveLength(1)

    h.runner.stopInterrupt('run-1')
    h.runner.stopInterrupt('run-1')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(h.delivered).toHaveLength(1)
    expect(h.cancels).toHaveLength(0)
  })

  it('never-claimed：turn/end 到达但无 claimed → turn-failed + needs-release + cancel', async () => {
    const h = new Harness()
    const p = h.runner.run(h.makeInput())
    h.claim(8, '别人的消息id')
    h.pump(turnEnd(8, 'completed'))
    const outcome = await p

    expect(outcome).toEqual({ kind: 'failed', handleHealth: 'needs-release', settled: false, runMs: expect.any(Number) })
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0].notices).toEqual(['turn-failed'])
    expect(h.cancels).toEqual([{ kind: 'user' }])
    expect(h.events('turn_failed')).toHaveLength(1)
  })

  it('never-claimed 契约清理进行中（deliver 挂起）stopInterrupt 到达：不产生第二个 envelope，outcome 单派为 failed', async () => {
    const h = new Harness()
    let releaseDeliver: (report: DeliveryReport) => void = () => undefined
    h.deliverImpl = (envelope) => {
      h.delivered.push(envelope)
      return new Promise<DeliveryReport>((resolve) => {
        releaseDeliver = resolve
      })
    }
    const p = h.runner.run(h.makeInput())
    h.pump(turnEnd(3, 'completed')) // 无 claimed → 契约异常路径，deliver 挂起中
    await waitFor(() => h.delivered.length === 1)

    h.runner.stopInterrupt('run-1')
    await new Promise((resolve) => setTimeout(resolve, 15))

    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0].notices).toEqual(['turn-failed'])
    // 只有 contractFailure 自己的 cancel；stopping 未并行启动取消路径。
    expect(h.cancels).toHaveLength(1)
    releaseDeliver(SENT)
    const outcome = await p
    expect(outcome.kind).toBe('failed')
    expect(outcome.handleHealth).toBe('needs-release')
  })

  it('whenIdle-reject 契约清理进行中（deliver 挂起）stopInterrupt 到达：不产生第二个 envelope，outcome 单派为 failed', async () => {
    const h = new Harness()
    h.whenIdleImpl = () => Promise.reject(new Error('whenIdle exploded'))
    let releaseDeliver: (report: DeliveryReport) => void = () => undefined
    h.deliverImpl = (envelope) => {
      h.delivered.push(envelope)
      return new Promise<DeliveryReport>((resolve) => {
        releaseDeliver = resolve
      })
    }
    const p = h.runner.run(h.makeInput())
    h.claim(4)
    h.pump(turnEnd(4, 'completed'))
    await waitFor(() => h.delivered.length === 1)

    h.runner.stopInterrupt('run-1')
    await new Promise((resolve) => setTimeout(resolve, 15))

    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0].notices).toEqual(['turn-failed'])
    releaseDeliver(SENT)
    const outcome = await p
    expect(outcome.kind).toBe('failed')
    expect(outcome.handleHealth).toBe('needs-release')
  })

  it('中断/forked/未知 reason kind：按失败处理，不发正文', async () => {
    for (const reason of ['interrupted', 'forked', 'something-new']) {
      const h = new Harness()
      const p = h.runner.run(h.makeInput())
      h.claim(1)
      h.pump(assistantMsg(1, [{ type: 'text', text: '残留输出' }]), turnEnd(1, reason))
      const outcome = await p
      expect(outcome.kind).toBe('failed')
      expect(h.delivered[0].notices).toEqual(['turn-failed'])
      expect(h.delivered[0].text).toBeUndefined()
    }
  })

  it('followup 抛错：按契约异常收尾（turn-failed + needs-release）', async () => {
    const h = new Harness()
    h.handle.agent.followup = () => {
      throw new Error('followup exploded')
    }
    const p = h.runner.run(h.makeInput())
    const outcome = await p

    expect(outcome.kind).toBe('failed')
    expect(outcome.handleHealth).toBe('needs-release')
    expect(h.delivered[0].notices).toEqual(['turn-failed'])
    expect(h.cancels).toHaveLength(1)
  })
})
