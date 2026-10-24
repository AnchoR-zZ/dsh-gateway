import { deepStrictEqual, strictEqual } from 'node:assert/strict'

import type { Context } from '@deepseek-ai/cordis'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'

import type { AgentHandleLike } from '../src/core/session-manager.js'
import type { TurnSessionEvent } from '../src/core/turn-runner.js'
import { createAgentHost, translateSessionEvent } from '../src/index.js'

/**
 * 宿主接入层测试（T10）：translateSessionEvent 纯函数（真实 dsh 类型形状的字面量）、
 * createAgentHost（替身 ctx：agents/sessions/agentDefaultModel）与 eventsFor 事件源适配。
 * setApprovalPolicy / setSandboxMode / createUserMessage 用真实实现操作替身对象，不 mock 函数。
 */

// ---- translateSessionEvent：真实 dsh SessionEvent 形状的字面量 ----

/** turn/end 字面量：TurnEndReason 是合并可扩展联合，逐 kind 构造后按需收窄。 */
function makeTurnEnd(turn: number, kind: TurnEndReason['kind']): SessionEvent {
  return {
    type: 'turn/end',
    seq: SessionSeq(10),
    time: 1_200,
    data: { turn, reason: { kind } as TurnEndReason },
  }
}

function makeAssistantMessageEvent(interrupted?: true): SessionEvent {
  return {
    type: 'assistant/message',
    seq: SessionSeq(7),
    time: 1_000,
    surfaceOp: 'append',
    data: {
      turn: 2,
      step: 1,
      message: {
        id: MessageId('msg-a'),
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '思考中' },
          { type: 'text', text: '正文' },
          { type: 'tool-call', id: ToolCallId('call-1'), name: 'bash', arguments: '{}' },
        ],
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
      },
      stream: [],
      ...(interrupted !== undefined ? { interrupted } : {}),
    },
  }
}

describe('translateSessionEvent (T10)', () => {
  it('assistant/message：content 块投影 type/text/id，interrupted 归一为 boolean', () => {
    const mapped = translateSessionEvent(makeAssistantMessageEvent(true))
    strictEqual(mapped.type, 'assistant/message')
    if (mapped.type !== 'assistant/message') {
      throw new Error('unreachable')
    }
    strictEqual(mapped.turn, 2)
    strictEqual(mapped.step, 1)
    strictEqual(mapped.interrupted, true)
    deepStrictEqual(
      mapped.content.map((b) => ({ type: b.type, text: b.text, id: b.id })),
      [
        { type: 'reasoning', text: '思考中', id: undefined },
        { type: 'text', text: '正文', id: undefined },
        { type: 'tool-call', text: undefined, id: 'call-1' },
      ],
    )
  })

  it('assistant/message 无 interrupted 时映射为 false', () => {
    const mapped = translateSessionEvent(makeAssistantMessageEvent())
    expect(mapped).toMatchObject({ type: 'assistant/message', turn: 2, step: 1, interrupted: false })
  })

  it('tool/result：callId 取自 event.data.message.toolCallId（无顶层 callId 字段）', () => {
    const event: SessionEvent = {
      type: 'tool/result',
      seq: SessionSeq(9),
      time: 1_100,
      surfaceOp: 'append',
      data: {
        turn: 2,
        step: 1,
        message: {
          id: MessageId('msg-t'),
          role: 'tool',
          content: [{ type: 'text', text: '0' }],
          source: { kind: 'tool', callId: ToolCallId('call-1') },
          toolCallId: ToolCallId('call-1'),
        },
      },
    }
    expect(translateSessionEvent(event)).toEqual({
      type: 'tool/result',
      turn: 2,
      step: 1,
      callId: 'call-1',
    })
  })

  it('turn/end：各 reason.kind 原样映射', () => {
    const kinds: TurnEndReason['kind'][] = [
      'completed',
      'max-tokens',
      'error',
      'aborted',
      'blocked',
      'interrupted',
      'forked',
    ]
    for (const kind of kinds) {
      expect(translateSessionEvent(makeTurnEnd(4, kind))).toEqual({
        type: 'turn/end',
        turn: 4,
        reason: { kind },
      })
    }
  })

  it('未知事件归 other：带 number turn 的携带，不带的省略', () => {
    const stepStart: SessionEvent = {
      type: 'step/start',
      seq: SessionSeq(11),
      time: 1_300,
      data: { turn: 5, step: 1 },
    }
    expect(translateSessionEvent(stepStart)).toEqual({ type: 'other', turn: 5 })

    const endSeed: SessionEvent = {
      type: 'session/end-seed',
      seq: SessionSeq(12),
      time: 1_300,
      data: {},
    }
    expect(translateSessionEvent(endSeed)).toEqual({ type: 'other', turn: undefined })
  })
})

// ---- createAgentHost：替身 ctx ----

interface RecordedAppend {
  type: string
  data: unknown
}

interface FakeAgentCtx {
  listeners: { name: string; fn: (...args: unknown[]) => void }[]
  on(name: string, fn: (...args: unknown[]) => void): () => boolean
  emit(name: string, ...args: unknown[]): void
}

function createFakeAgentCtx(): FakeAgentCtx {
  const listeners: FakeAgentCtx['listeners'] = []
  return {
    listeners,
    on(name, fn) {
      listeners.push({ name, fn })
      return () => {
        const index = listeners.findIndex((l) => l.name === name && l.fn === fn)
        if (index >= 0) {
          listeners.splice(index, 1)
        }
        return true
      }
    },
    emit(name, ...args) {
      for (const listener of listeners) {
        if (listener.name === name) {
          listener.fn(...args)
        }
      }
    },
  }
}

interface FakeDshAgent {
  id: string
  session: {
    id: string
    header: { cwd: string }
    appends: RecordedAppend[]
    append(type: string, data: unknown): void
  }
  ctx: FakeAgentCtx
  disposed: boolean
}

function makeFakeAgent(sessionId: string, cwd: string): FakeDshAgent {
  return {
    id: sessionId,
    session: {
      id: sessionId,
      header: { cwd },
      appends: [],
      append(type, data) {
        this.appends.push({ type, data })
      },
    },
    ctx: createFakeAgentCtx(),
    disposed: false,
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(err: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createFakeDshCtx() {
  const createdOptions: Record<string, unknown>[] = []
  const resumeOptions: Record<string, unknown>[] = []
  const flushCalls: { sessionId: string }[] = []
  const liveAgents = new Map<string, FakeDshAgent>()
  let flushBehavior: (sessionId: string) => Promise<boolean> = () => Promise.resolve(true)

  const ctx = {
    agents: {
      async create(options: Record<string, unknown> & { setup?: (a: unknown, b: unknown) => void }) {
        createdOptions.push(options)
        const sessionId = options.sessionId as string
        const cwd = (options.meta as { cwd?: string } | undefined)?.cwd ?? ''
        const agent = makeFakeAgent(sessionId, cwd)
        liveAgents.set(agent.id, agent)
        await options.setup?.(agent.ctx, agent)
        return {
          agent,
          dispose: async () => {
            agent.disposed = true
            liveAgents.delete(agent.id)
          },
        }
      },
      async resume(options: Record<string, unknown> & { setup?: (a: unknown, b: unknown) => void }) {
        resumeOptions.push(options)
        const sessionId = options.resumeSessionId as string
        const agent = makeFakeAgent(sessionId, '/resumed')
        liveAgents.set(agent.id, agent)
        await options.setup?.(agent.ctx, agent)
        return {
          agent,
          dispose: async () => {
            agent.disposed = true
            liveAgents.delete(agent.id)
          },
        }
      },
      get(id: string) {
        return liveAgents.get(id)
      },
    },
    sessions: {
      flush(session: { id: string }): Promise<boolean> {
        flushCalls.push({ sessionId: session.id })
        return flushBehavior(session.id)
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    },
  }
  return {
    ctx: ctx as unknown as Context,
    createdOptions,
    resumeOptions,
    flushCalls,
    setFlushBehavior(behavior: (sessionId: string) => Promise<boolean>): void {
      flushBehavior = behavior
    },
    liveAgents,
  }
}

const MODEL_OPTIONS = { provider: 'deepseek-official', model: 'deepseek-flash' }

describe('createAgentHost (T10)', () => {
  it('createAgent 透传 sessionId/meta.cwd/agentOptions/signal，setup 追加两条策略事件', async () => {
    const fake = createFakeDshCtx()
    const { host } = createAgentHost(fake.ctx)
    const controller = new AbortController()
    const handle = await host.createAgent({
      sessionId: 'sess-1',
      cwd: '/ws/abc',
      agentOptions: MODEL_OPTIONS,
      signal: controller.signal,
    })
    strictEqual(fake.createdOptions.length, 1)
    const options = fake.createdOptions[0] as Record<string, unknown>
    // SessionId 是品牌恒等函数：fake 侧以原字符串断言。
    strictEqual(options.sessionId, 'sess-1')
    deepStrictEqual(options.meta, { cwd: '/ws/abc' })
    deepStrictEqual(options.agentOptions, MODEL_OPTIONS)
    strictEqual(options.signal, controller.signal)
    strictEqual(typeof options.setup, 'function')

    // 真实 setApprovalPolicy / setSandboxMode 作用于替身 session（append 记录）。
    const agent = fake.liveAgents.get('sess-1')
    strictEqual(agent !== undefined, true)
    deepStrictEqual(agent?.session.appends, [
      { type: 'approval/policy', data: { policy: 'never' } },
      { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
    ])
    // 适配后的 handle 直接暴露该 agent，dispose 经由原始 handle。
    strictEqual(handle.agent.id, 'sess-1')
    strictEqual(handle.agent.session.header.cwd, '/ws/abc')
    strictEqual(host.isAgentLive('sess-1'), true)
    await handle.dispose()
    strictEqual(agent?.disposed, true)
    strictEqual(host.isAgentLive('sess-1'), false)
  })

  it('resumeAgent 透传 resumeSessionId 并同样执行 setup', async () => {
    const fake = createFakeDshCtx()
    const { host } = createAgentHost(fake.ctx)
    const handle = await host.resumeAgent({
      sessionId: 'sess-2',
      agentOptions: MODEL_OPTIONS,
      signal: new AbortController().signal,
    })
    strictEqual(fake.resumeOptions.length, 1)
    strictEqual((fake.resumeOptions[0] as Record<string, unknown>).resumeSessionId, 'sess-2')
    deepStrictEqual(fake.liveAgents.get('sess-2')?.session.appends, [
      { type: 'approval/policy', data: { policy: 'never' } },
      { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
    ])
    strictEqual(handle.agent.id, 'sess-2')
    strictEqual(host.isAgentLive('nope'), false)
  })

  it('flushSession 对同一 session 并发只发一次，settle 后可再次发起', async () => {
    const fake = createFakeDshCtx()
    const { host } = createAgentHost(fake.ctx)
    const gate = deferred<boolean>()
    fake.setFlushBehavior(() => gate.promise)
    const sessionLike = { id: 'sess-1', header: { cwd: '/ws/abc' } }

    const first = host.flushSession(sessionLike)
    const second = host.flushSession(sessionLike)
    strictEqual(fake.flushCalls.length, 1)
    gate.resolve(true)
    strictEqual(await first, true)
    strictEqual(await second, true)

    const third = host.flushSession(sessionLike)
    strictEqual(fake.flushCalls.length, 2)
    strictEqual(await third, true)
  })

  it('flushSession 的失败同样解除 in-flight 并向两个并发调用方传播', async () => {
    const fake = createFakeDshCtx()
    const { host } = createAgentHost(fake.ctx)
    const gate = deferred<boolean>()
    fake.setFlushBehavior(() => gate.promise)
    const sessionLike = { id: 'sess-1', header: { cwd: '/ws/abc' } }

    const first = host.flushSession(sessionLike)
    const second = host.flushSession(sessionLike)
    gate.reject(new Error('boom'))
    await expect(first).rejects.toThrow('boom')
    await expect(second).rejects.toThrow('boom')

    // in-flight 已清理：再次调用会重新发起。
    fake.setFlushBehavior(() => Promise.resolve(false))
    strictEqual(await host.flushSession(sessionLike), false)
    strictEqual(fake.flushCalls.length, 2)
  })

  it('currentModelSelection 与 createUserMessage 适配', () => {
    const fake = createFakeDshCtx()
    const { host } = createAgentHost(fake.ctx)
    deepStrictEqual(host.currentModelSelection(), MODEL_OPTIONS)

    const created = host.createUserMessage('你好')
    strictEqual(typeof created.id, 'string')
    strictEqual(created.id.length > 0, true)
    const message = created.message as {
      role: string
      content: { type: string; text?: string }[]
      source: { kind: string }
    }
    strictEqual(message.role, 'user')
    strictEqual(message.source.kind, 'user')
    deepStrictEqual(message.content, [{ type: 'text', text: '你好' }])
    strictEqual(Object.isFrozen(message), true)
  })
})

// ---- eventsFor：agent-scoped 订阅、过滤与取消 ----

async function setupSubscribedAgent(): Promise<{
  agentCtx: FakeAgentCtx
  claimed: { messageId: string; turn: number }[]
  sessionEvents: TurnSessionEvent[]
  unsubscribe: () => void
}> {
  const fake = createFakeDshCtx()
  const { host, eventsFor } = createAgentHost(fake.ctx)
  const handle = await host.createAgent({
    sessionId: 'sess-1',
    cwd: '/ws/abc',
    agentOptions: MODEL_OPTIONS,
    signal: new AbortController().signal,
  })
  const agent = fake.liveAgents.get('sess-1')
  if (agent === undefined) {
    throw new Error('agent missing')
  }
  const claimed: { messageId: string; turn: number }[] = []
  const sessionEvents: TurnSessionEvent[] = []
  const unsubscribe = eventsFor(handle).subscribe({
    onInboxClaimed: (payload) => claimed.push(payload),
    onSessionEvent: (event) => sessionEvents.push(event),
  })
  return { agentCtx: agent.ctx, claimed, sessionEvents, unsubscribe }
}

describe('eventsFor (T10)', () => {
  it('claimed 事件映射 messageId/turn；session/event 按 session.id 过滤并翻译', async () => {
    const { agentCtx, claimed, sessionEvents, unsubscribe } = await setupSubscribedAgent()

    agentCtx.emit('agent/inbox/claimed', { agent: {}, message: { id: MessageId('m-1') }, turn: 3 })
    deepStrictEqual(claimed, [{ messageId: 'm-1', turn: 3 }])

    // 别的 session 的事件被忽略。
    agentCtx.emit(
      'session/event',
      { id: 'other-session', header: { cwd: '/x' } },
      { type: 'turn/end', seq: 1, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
    )
    strictEqual(sessionEvents.length, 0)

    // 本 session 的 assistant/message 与 turn/end 被翻译。
    agentCtx.emit(
      'session/event',
      { id: 'sess-1', header: { cwd: '/ws/abc' } },
      {
        type: 'assistant/message',
        seq: 2,
        time: 0,
        surfaceOp: 'append',
        data: {
          turn: 3,
          step: 1,
          message: {
            id: MessageId('m-2'),
            role: 'assistant',
            content: [{ type: 'text', text: 'hi' }],
            source: { kind: 'model', provider: 'p', model: 'm' },
          },
          stream: [],
        },
      },
    )
    agentCtx.emit(
      'session/event',
      { id: 'sess-1', header: { cwd: '/ws/abc' } },
      { type: 'turn/end', seq: 3, time: 0, data: { turn: 3, reason: { kind: 'completed' } } },
    )
    strictEqual(sessionEvents.length, 2)
    strictEqual(sessionEvents[0].type, 'assistant/message')
    if (sessionEvents[0].type === 'assistant/message') {
      deepStrictEqual(
        sessionEvents[0].content.map((b) => ({ type: b.type, text: b.text })),
        [{ type: 'text', text: 'hi' }],
      )
    }
    deepStrictEqual(sessionEvents[1], { type: 'turn/end', turn: 3, reason: { kind: 'completed' } })

    // 取消订阅后不再投递。
    unsubscribe()
    agentCtx.emit(
      'session/event',
      { id: 'sess-1', header: { cwd: '/ws/abc' } },
      { type: 'turn/end', seq: 4, time: 0, data: { turn: 4, reason: { kind: 'completed' } } },
    )
    agentCtx.emit('agent/inbox/claimed', { agent: {}, message: { id: MessageId('m-3') }, turn: 5 })
    strictEqual(sessionEvents.length, 2)
    strictEqual(claimed.length, 1)
  })

  it('未注册的 handle 订阅时抛错（装配缺陷防御）', () => {
    const { eventsFor } = createAgentHost({} as Context)
    const foreign: AgentHandleLike = {
      agent: {
        id: 'x',
        session: { id: 'x', header: { cwd: '/x' } },
        followup: () => undefined,
        cancel: () => undefined,
        whenIdle: () => Promise.resolve(),
        inbox: { clear: () => undefined },
        status: 'idle',
      },
      dispose: () => Promise.resolve(),
    }
    expect(() =>
      eventsFor(foreign).subscribe({
        onInboxClaimed: () => undefined,
        onSessionEvent: () => undefined,
      }),
    ).toThrow(/wiring defect/)
  })
})
