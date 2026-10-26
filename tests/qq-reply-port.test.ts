import { describe, expect, it } from 'vitest'

import { GATEWAY_LIMITS } from '../src/contracts.js'
import type { ReplyEnvelope } from '../src/contracts.js'
import type { GatewayLogEvent, GatewayLogger, LogFields } from '../src/logging.js'
import { NOTICE_TEXTS, PLAN_FAILURE_TEXT, planReply } from '../src/channels/qq/markdown.js'
import type { ReplyPlan } from '../src/channels/qq/markdown.js'
import { createQQReplyPort, SEND_TIMED_OUT } from '../src/channels/qq/reply-port.js'
import type { QQSender, ReplyPortLimits } from '../src/channels/qq/reply-port.js'

/**
 * reply-port 行为（设计 4.2/4.3/10.3）：规划 → 逐段发送 → 预算/期限/未知结果。
 * sender 与时钟全部替身；limits 注入毫秒级超时，无真实网络与等待。
 */

interface Deferred {
  promise: Promise<unknown>
  resolve: (value?: unknown) => void
  reject: (err: unknown) => void
}

function createDeferred(): Deferred {
  let resolve!: (value: unknown) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type SendScript = 'ok' | 'hang' | { reject: Error }

class FakeSender implements QQSender {
  readonly calls: { msgId: string; targetId: string; text: string }[] = []
  readonly hanging: Deferred[] = []
  script: SendScript[] = []

  send(msgId: string, targetId: string, text: string): Promise<unknown> {
    this.calls.push({ msgId, targetId, text })
    const behavior = this.script[this.calls.length - 1] ?? 'ok'
    if (behavior === 'hang') {
      const d = createDeferred()
      this.hanging.push(d)
      return d.promise
    }
    if (typeof behavior === 'object') {
      return Promise.reject(behavior.reject)
    }
    return Promise.resolve({ id: `ret-${this.calls.length}` })
  }
}

class RecordingLogger implements GatewayLogger {
  readonly events: { event: string; fields?: Record<string, unknown> }[] = []

  logEvent(event: GatewayLogEvent, fields?: LogFields): void {
    this.events.push({ event, fields: fields as Record<string, unknown> | undefined })
  }

  debugBody(): void {
    // 本组测试不覆盖 debug 正文
  }

  find(event: string): { event: string; fields?: Record<string, unknown> }[] {
    return this.events.filter((e) => e.event === event)
  }
}

/** 5 段各近 4000 的正文：无提示、B=4 时溢出 → 重规划为「3 条正文 + 1 条截断提示」。 */
const LONG_TEXT = ['P1', 'P2', 'P3', 'P4', 'P5'].map((tag) => `${tag} ${'a'.repeat(2990)}`).join('\n\n')

const envelope = (over: Partial<ReplyEnvelope> = {}): ReplyEnvelope => ({
  notices: [],
  maxMessages: 4,
  ...over,
})

function makePort(
  over: {
    sender?: FakeSender
    expiresAt?: number
    maxMessages?: number
    limits?: Partial<ReplyPortLimits>
    now?: () => number
    onSendStuck?: () => void
  } = {},
) {
  const sender = over.sender ?? new FakeSender()
  let clock = 1_000_000
  const now = over.now ?? (() => clock)
  const logger = new RecordingLogger()
  const limits: ReplyPortLimits = { ...GATEWAY_LIMITS, ...over.limits }
  const port = createQQReplyPort({
    msgId: 'anchor-1',
    targetId: 'user-1',
    expiresAt: over.expiresAt ?? clock + 3_600_000,
    maxMessages: over.maxMessages ?? 4,
    sender,
    logger,
    limits,
    now,
    onSendStuck: over.onSendStuck,
  })
  return {
    port,
    sender,
    logger,
    bumpClock: (delta: number) => {
      clock += delta
    },
    setClock: (value: number) => {
      clock = value
    },
    clock: () => clock,
  }
}

describe('完整计划的逐段发送（10.3）', () => {
  it('4 条计划全部按序发送：文本等于规划段，msgId/targetId 逐次携带', async () => {
    const h = makePort()
    const expected: ReplyPlan = planReply({
      text: LONG_TEXT,
      notices: [],
      maxMessages: 4,
      maxLength: 4000,
    })
    expect(expected.messages.length).toBe(4)
    const report = await h.port.deliver(envelope({ text: LONG_TEXT }))
    expect(report).toEqual({ status: 'sent', attempted: 4, confirmed: 4 })
    expect(h.sender.calls.map((c) => c.text)).toEqual(expected.messages)
    for (const call of h.sender.calls) {
      expect(call.msgId).toBe('anchor-1')
      expect(call.targetId).toBe('user-1')
    }
    expect(h.logger.find('reply_sent')).toHaveLength(1)
    expect(h.logger.find('reply_sent')[0]?.fields).toMatchObject({ attempted: 4, confirmed: 4 })
  })

  it('第 2 段明确失败 → 停止余段，partial，不再第 3 次调用', async () => {
    const sender = new FakeSender()
    sender.script = ['ok', { reject: new Error('api 429') }, 'ok', 'ok']
    const h = makePort({ sender })
    const report = await h.port.deliver(envelope({ text: LONG_TEXT }))
    expect(report).toEqual({ status: 'partial', attempted: 2, confirmed: 1 })
    expect(sender.calls).toHaveLength(2)
    expect(h.logger.find('reply_partial')).toHaveLength(1)
  })

  it('第 1 段明确失败 → failed（无确认段）', async () => {
    const sender = new FakeSender()
    sender.script = [{ reject: new Error('api error') }]
    const h = makePort({ sender })
    const report = await h.port.deliver(envelope({ text: 'hi' }))
    expect(report).toEqual({ status: 'failed', attempted: 1, confirmed: 0 })
  })
})

describe('35s 总期限与未知结果（10.3）', () => {
  it('单段超时 → unknown：onSendStuck 触发、余段不发、晚 settle 被忽略', async () => {
    const stuckCalls: string[] = []
    const sender = new FakeSender()
    sender.script = ['ok', 'hang', 'ok', 'ok']
    const h = makePort({
      sender,
      limits: { QQ_OUTBOUND_CALL_TIMEOUT_MS: 20 },
      onSendStuck: () => {
        stuckCalls.push('stuck')
      },
    })
    const report = await h.port.deliver(envelope({ text: LONG_TEXT }))
    expect(report).toEqual({ status: 'unknown', attempted: 2, confirmed: 1 })
    expect(stuckCalls).toEqual(['stuck'])
    expect(sender.calls).toHaveLength(2)
    expect(h.logger.find('reply_unknown')).toHaveLength(1)
    // 底层 promise 之后 settle：不产生 unhandled rejection，也不改变报告。
    sender.hanging[0]?.resolve({ id: 'late' })
    await new Promise((r) => setTimeout(r, 5))
    // 超时路径已 close port（10.3）：之后的 deliver 按关闭语义返回，且不再发送。
    const again = await h.port.deliver(envelope({ text: 'retry' }))
    expect(again).toEqual({ status: 'closed', attempted: 0, confirmed: 0 })
    expect(sender.calls).toHaveLength(2)
  })
})

describe('一次 envelope 与关闭/过期（4.2）', () => {
  it('deliver 两次 → 第二次不发请求，返回第一次的报告', async () => {
    const h = makePort()
    const first = await h.port.deliver(envelope({ text: 'hello' }))
    expect(first).toEqual({ status: 'sent', attempted: 1, confirmed: 1 })
    const second = await h.port.deliver(envelope({ text: 'again' }))
    expect(second).toEqual(first)
    expect(h.sender.calls).toHaveLength(1)
  })

  it('close 后 deliver → closed 且不发送', async () => {
    const h = makePort()
    h.port.close()
    const report = await h.port.deliver(envelope({ text: 'hello' }))
    expect(report).toEqual({ status: 'closed', attempted: 0, confirmed: 0 })
    expect(h.sender.calls).toHaveLength(0)
  })

  it('close 幂等', () => {
    const h = makePort()
    h.port.close()
    h.port.close()
  })

  it('已过期（now ≥ expiresAt）→ expired 且不发送', async () => {
    const h = makePort({ expiresAt: 1_000_000 })
    const report = await h.port.deliver(envelope({ text: 'hello' }))
    expect(report).toEqual({ status: 'expired', attempted: 0, confirmed: 0 })
    expect(h.sender.calls).toHaveLength(0)
  })

  it('每段前重查窗口：首段成功后过期 → partial（已发段落构成部分投递）', async () => {
    let clock = 1_000_000
    const expiresAt = clock + 5_000
    const sender = new FakeSender()
    const origSend = sender.send.bind(sender)
    sender.send = (msgId, targetId, text) => {
      const p = origSend(msgId, targetId, text)
      // 首段发送期间窗口到期。
      clock = expiresAt
      return p
    }
    const h = makePort({ sender, expiresAt, now: () => clock })
    const report = await h.port.deliver(envelope({ text: LONG_TEXT }))
    expect(report).toEqual({ status: 'partial', attempted: 1, confirmed: 1 })
    expect(sender.calls).toHaveLength(1)
    expect(h.logger.find('reply_partial')).toHaveLength(1)
  })
})

describe('规划边界（10.2）', () => {
  it('degraded 计划 → 只发 PLAN_FAILURE_TEXT 单条并记录规划错误', async () => {
    const h = makePort()
    const report = await h.port.deliver(envelope({ text: undefined, notices: [] }))
    expect(report).toEqual({ status: 'sent', attempted: 1, confirmed: 1 })
    expect(h.sender.calls.map((c) => c.text)).toEqual([PLAN_FAILURE_TEXT])
    expect(h.logger.find('reply_failed')).toHaveLength(1)
    expect(h.logger.find('reply_failed')[0]?.fields?.reason).toContain('degraded')
  })

  it('envelope.maxMessages > port maxMessages → 取小', async () => {
    const h = makePort({ maxMessages: 2 })
    const expected = planReply({ text: LONG_TEXT, notices: [], maxMessages: 2, maxLength: 4000 })
    expect(expected.messages.length).toBe(2)
    const report = await h.port.deliver(envelope({ text: LONG_TEXT, maxMessages: 10 }))
    expect(report).toEqual({ status: 'sent', attempted: 2, confirmed: 2 })
    expect(h.sender.calls.map((c) => c.text)).toEqual(expected.messages)
  })

  it('提示走独立提示消息：无正文时只发提示一条', async () => {
    const h = makePort()
    const report = await h.port.deliver(envelope({ text: undefined, notices: ['turn-timeout'] }))
    expect(report).toEqual({ status: 'sent', attempted: 1, confirmed: 1 })
    expect(h.sender.calls.map((c) => c.text)).toEqual([NOTICE_TEXTS['turn-timeout']])
  })
})

describe('SEND_TIMED_OUT 哨兵', () => {
  it('是独立 symbol，不与 Error 混淆', () => {
    expect(typeof SEND_TIMED_OUT).toBe('symbol')
  })
})

describe('DeliveryReport 快照语义', () => {
  it('首次 deliver 进行中的第二次调用返回进行中快照（unknown/0/0）且不发送', async () => {
    const sender = new FakeSender()
    sender.script = ['hang']
    const h = makePort({ sender, limits: { QQ_OUTBOUND_CALL_TIMEOUT_MS: 10_000 } })
    const first = h.port.deliver(envelope({ text: 'hi' }))
    const second = await h.port.deliver(envelope({ text: 'again' }))
    expect(second).toEqual({ status: 'unknown', attempted: 0, confirmed: 0 })
    sender.hanging[0]?.resolve({})
    expect(await first).toEqual({ status: 'sent', attempted: 1, confirmed: 1 })
    expect(sender.calls).toHaveLength(1)
  })
})
