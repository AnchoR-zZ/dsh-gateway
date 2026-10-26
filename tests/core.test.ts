import { mkdtemp, writeFile } from 'node:fs/promises'
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { computeBindingId, GATEWAY_LIMITS } from '../src/contracts.js'
import type {
  ChannelIngress,
  ChannelIdentity,
  ChannelRegistration,
  DeliveryReport,
  InboundText,
  ReplyEnvelope,
  ReplyPort,
} from '../src/contracts.js'
import { createGatewayLogger } from '../src/logging.js'
import { createScheduler } from '../src/core/scheduler.js'
import { createDefaultStateStoreIo, createStateStore } from '../src/core/state-store.js'
import type { StateStore, StateStoreIo } from '../src/core/state-store.js'
import type {
  AgentHandleLike,
  PrepareFailure,
  PrepareOptions,
  PreparedSession,
  SessionManager,
} from '../src/core/session-manager.js'
import type { RunTurnInput, TurnOutcome, TurnRunner } from '../src/core/turn-runner.js'
import { createGatewayCore } from '../src/core/index.js'
import type { CoreHandle, CoreLimits } from '../src/core/index.js'

/**
 * core 组装测试：真实 scheduler + 真实 StateStore（临时目录）+ 受控替身 sessions/runner +
 * 注入时钟。不接触真实 dsh 与 QQ SDK，也不绑定任何 HTTP 监听——core 只负责消息执行，
 * 传输层（探针/管理路由）由 http 模块与 runtime 的测试覆盖。
 */

// ---- 替身与工具 ----

interface LogLine {
  event: string
  reason?: string
  [key: string]: unknown
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function waitFor(condition: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor: condition not met within timeout')
    }
    await new Promise((r) => setTimeout(r, 5))
  }
}

let handleSeq = 0
function makeHandle(id?: string): AgentHandleLike {
  const name = id ?? `handle-${++handleSeq}`
  return {
    agent: {
      id: name,
      session: { id: `session-${name}`, header: { cwd: 'C:/ws' } },
      followup: () => undefined,
      cancel: () => undefined,
      whenIdle: () => Promise.resolve(),
      inbox: { clear: () => undefined },
      status: 'idle' as const,
    },
    dispose: async () => undefined,
  }
}

function makePrepared(handle: AgentHandleLike, opts?: { recreated?: boolean }): PreparedSession {
  return {
    bindingId: 'binding-test',
    sessionId: handle.agent.session.id,
    generation: 1,
    handle,
    recreated: opts?.recreated ?? false,
    reusedCached: false,
  }
}

class FakePort implements ReplyPort {
  readonly ops: string[]
  envelopes: ReplyEnvelope[] = []
  closed = false
  report: DeliveryReport = { status: 'sent', attempted: 1, confirmed: 1 }
  deliverImpl: (envelope: ReplyEnvelope) => Promise<DeliveryReport> = async (envelope) => {
    this.envelopes.push(envelope)
    return this.report
  }

  constructor(ops: string[] = []) {
    this.ops = ops
  }

  async deliver(envelope: ReplyEnvelope): Promise<DeliveryReport> {
    this.ops.push('deliver')
    return this.deliverImpl(envelope)
  }

  close(): void {
    this.ops.push('close')
    this.closed = true
  }
}

let msgSeq = 0
const WALL_BASE = 1_700_000_000_000

function makeMessage(
  text: string,
  opts?: { peerId?: string; messageId?: string; maxMessages?: number; expiresAt?: number; ops?: string[] },
): { message: InboundText; port: FakePort } {
  const port = new FakePort(opts?.ops ?? [])
  const message: InboundText = {
    peerId: opts?.peerId ?? 'peer-1',
    messageId: opts?.messageId ?? `msg-${++msgSeq}`,
    text,
    receivedAt: WALL_BASE,
    replyPolicy: {
      maxMessages: opts?.maxMessages ?? 4,
      expiresAt: opts?.expiresAt ?? WALL_BASE + 3_600_000,
    },
    reply: port,
  }
  return { message, port }
}

class FakeChannel implements ChannelRegistration {
  readonly channelId: string
  readonly accountId: string
  stopCalls = 0

  constructor(channelId = 'qq', accountId = 'app-1') {
    this.channelId = channelId
    this.accountId = accountId
  }

  async stopReceiving(): Promise<void> {
    this.stopCalls += 1
  }
}

type PrepareResult = PreparedSession | { error: PrepareFailure }

class FakeSessions implements SessionManager {
  readonly ops: string[]
  prepareCalls: { identity: ChannelIdentity; signal: AbortSignal }[] = []
  prepareImpl: (identity: ChannelIdentity, signal: AbortSignal) => Promise<PrepareResult> =
    async () => makePrepared(makeHandle())
  markIdleCalls: AgentHandleLike[] = []
  released: { handle: AgentHandleLike; cancelled?: boolean; deadlineMs?: number }[] = []
  releaseImpl: (handle: AgentHandleLike) => Promise<'disposed' | 'timeout'> = async () => 'disposed'
  cachedHandles: AgentHandleLike[] = []

  constructor(ops: string[]) {
    this.ops = ops
  }

  async prepare(opts: PrepareOptions): Promise<PrepareResult> {
    this.ops.push('prepare')
    this.prepareCalls.push({ identity: opts.identity, signal: opts.signal })
    return this.prepareImpl(opts.identity, opts.signal)
  }

  markIdle(handle: AgentHandleLike): void {
    this.ops.push('markIdle')
    this.markIdleCalls.push(handle)
  }

  async releaseHandle(
    handle: AgentHandleLike,
    opts?: { cancelled?: boolean; deadlineMs?: number },
  ): Promise<'disposed' | 'timeout'> {
    this.ops.push('releaseHandle')
    this.released.push({ handle, cancelled: opts?.cancelled, deadlineMs: opts?.deadlineMs })
    return this.releaseImpl(handle)
  }

  start(): void {
    this.ops.push('sessions.start')
  }

  async stop(): Promise<void> {
    this.ops.push('sessions.stop')
  }

  listCachedHandles(): readonly AgentHandleLike[] {
    return [...this.cachedHandles]
  }

  stats(): { liveHandles: number; busyHandles: number } {
    return { liveHandles: this.cachedHandles.length, busyHandles: 0 }
  }
}

class FakeRunner implements TurnRunner {
  readonly ops: string[]
  runs: RunTurnInput[] = []
  stopInterrupts: string[] = []
  runImpl: (input: RunTurnInput) => Promise<TurnOutcome> = async () => ({
    kind: 'completed',
    handleHealth: 'healthy',
    settled: true,
    runMs: 1,
  })

  constructor(ops: string[]) {
    this.ops = ops
  }

  async run(input: RunTurnInput): Promise<TurnOutcome> {
    this.ops.push('runner.run')
    this.runs.push(input)
    return this.runImpl(input)
  }

  stopInterrupt(runToken: string): void {
    this.stopInterrupts.push(runToken)
  }
}

// ---- harness ----

interface Harness {
  handle: CoreHandle
  store: StateStore
  sessions: FakeSessions
  runner: FakeRunner
  logs: LogLine[]
  ops: string[]
  clocks: { wall: number; mono: number }
}

const activeHarnesses: Harness[] = []

async function makeHarness(options?: {
  limits?: Partial<CoreLimits>
  store?: StateStore
}): Promise<Harness> {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-core-state-'))
  const logs: LogLine[] = []
  const logger = createGatewayLogger({
    debug: false,
    sink: (line) => {
      logs.push(JSON.parse(line) as LogLine)
    },
  })
  const limits: CoreLimits = {
    ...GATEWAY_LIMITS,
    // 小预算驱动真实定时器（毫秒级），10s 的 turn 截止与窗口判定仍由注入时钟控制。
    TURN_DEADLINE_MS: 10_000,
    QQ_OUTBOUND_MARGIN_MS: 0,
    STOP_NATURAL_COMPLETION_WAIT_MS: 30,
    CORE_SHUTDOWN_BUDGET_MS: 500,
    CANCEL_CLEANUP_BUDGET_MS: 200,
    ...options?.limits,
  }
  const literalLimits = limits as unknown as typeof GATEWAY_LIMITS
  const ops: string[] = []
  const store = options?.store ?? createStateStore({ stateDir, limits: literalLimits, logger })
  const sessions = new FakeSessions(ops)
  const runner = new FakeRunner(ops)
  const clocks = { wall: WALL_BASE, mono: 1_000 }
  let reqSeq = 0
  const handle = createGatewayCore({
    limits,
    logger,
    store,
    createScheduler: (callbacks) =>
      createScheduler({
        config: {
          maxConcurrent: 4,
          maxPendingPerPeer: 3,
          maxPendingTotal: 100,
          maxPendingBytes: 8_388_608,
        },
        limits: literalLimits,
        logger,
        callbacks,
        now: () => clocks.wall,
      }),
    sessions,
    runner,
    now: () => clocks.wall,
    mono: () => clocks.mono,
    requestId: () => `req-${++reqSeq}`,
  })
  const harness: Harness = { handle, store, sessions, runner, logs, ops, clocks }
  activeHarnesses.push(harness)
  return harness
}

async function startWithChannel(
  h: Harness,
  opts?: { online?: boolean },
): Promise<{ ingress: ChannelIngress; channel: FakeChannel }> {
  await h.handle.lifecycle.start()
  const channel = new FakeChannel()
  const ingress = h.handle.ingress.registerChannel(channel)
  if (opts?.online !== false) {
    ingress.setState('online')
  }
  return { ingress, channel }
}

afterEach(async () => {
  for (const h of activeHarnesses.splice(0)) {
    await h.handle.lifecycle.stop().catch(() => undefined)
  }
})

// ---- 测试 ----

describe('core assembly', () => {
  it('registerChannel 拒绝重复注册同一 [channelId, accountId]，不同账号可注册', async () => {
    const h = await makeHarness()
    await h.handle.lifecycle.start()
    h.handle.ingress.registerChannel(new FakeChannel('qq', 'app-1'))
    expect(() => h.handle.ingress.registerChannel(new FakeChannel('qq', 'app-1'))).toThrow(
      /already registered/,
    )
    expect(() => h.handle.ingress.registerChannel(new FakeChannel('qq', 'app-2'))).not.toThrow()
  })

  it('registerChannel 拒绝无法构成 bindingId 的 channelId/accountId', async () => {
    const h = await makeHarness()
    await h.handle.lifecycle.start()
    expect(() => h.handle.ingress.registerChannel(new FakeChannel('q_q', 'app-1'))).toThrow(
      /path-safe/,
    )
    expect(() => h.handle.ingress.registerChannel(new FakeChannel('qq', 'app_1'))).toThrow(
      /path-safe/,
    )
  })

  it('registerChannel 在 core 非 starting/ready 状态抛错', async () => {
    const h = await makeHarness()
    await h.handle.lifecycle.start()
    await h.handle.lifecycle.stop()
    expect(() => h.handle.ingress.registerChannel(new FakeChannel())).toThrow(/cannot register/)
  })

  it('inbound 立即返回：执行挂起时 admission promise 已 resolve', async () => {
    const h = await makeHarness()
    const { ingress } = await startWithChannel(h)
    const gate = deferred<PrepareResult>()
    h.sessions.prepareImpl = () => gate.promise
    const { message, port } = makeMessage('hello')
    const result = await ingress.inbound(message)
    expect(result).toEqual({ accepted: true, requestId: 'req-1' })
    expect(h.sessions.prepareCalls).toHaveLength(1)
    expect(port.envelopes).toHaveLength(0)
    gate.resolve({ error: { kind: 'creation-failed' } })
    await waitFor(() => port.closed)
  })

  it('inbound 防御性校验矩阵：畸形输入 → unavailable 且不触发执行', async () => {
    const h = await makeHarness()
    const { ingress } = await startWithChannel(h)
    const bad: InboundText[] = [
      makeMessage('hi', { peerId: '' }).message,
      makeMessage('hi', { peerId: '../escape' }).message,
      makeMessage('hi', { messageId: '' }).message,
      makeMessage('   ').message,
      makeMessage('hi', { maxMessages: 0 }).message,
      makeMessage('hi', { maxMessages: 1.5 }).message,
      makeMessage('hi', { expiresAt: Number.NaN }).message,
      makeMessage('hi', { expiresAt: 0 }).message,
    ]
    for (const message of bad) {
      expect(await ingress.inbound(message)).toEqual({ accepted: false, reason: 'unavailable' })
    }
    const broken = makeMessage('hi')
    const withoutDeliver = await ingress.inbound({
      ...broken.message,
      reply: { close: () => undefined } as unknown as ReplyPort,
    })
    expect(withoutDeliver).toEqual({ accepted: false, reason: 'unavailable' })
    expect(h.logs.filter((l) => l.event === 'inbound_ignored')).toHaveLength(bad.length + 1)
    expect(h.sessions.prepareCalls).toHaveLength(0)
    const ok = await ingress.inbound(makeMessage('fine').message)
    expect(ok.accepted).toBe(true)
  })

  it('core 未 ready（starting）时 inbound 归为 stopping', async () => {
    const h = await makeHarness()
    const ingress = h.handle.ingress.registerChannel(new FakeChannel())
    const result = await ingress.inbound(makeMessage('early').message)
    expect(result).toEqual({ accepted: false, reason: 'stopping' })
  })

  it('execute 管道正常路径：runner 入参、markIdle/deliver/close 顺序', async () => {
    const h = await makeHarness()
    const { ingress } = await startWithChannel(h)
    const handle = makeHandle('h-run')
    h.sessions.prepareImpl = async () => makePrepared(handle)
    h.runner.runImpl = async (input) => {
      await input.deliver({ text: 'answer', notices: [], maxMessages: input.maxMessages })
      return { kind: 'completed', handleHealth: 'healthy', settled: true, runMs: 3 }
    }
    const { message, port } = makeMessage(' hi ', { maxMessages: 3, ops: h.ops })
    const result = await ingress.inbound(message)
    expect(result.accepted).toBe(true)
    await waitFor(() => port.closed)

    const run = h.runner.runs[0]
    expect(run).toBeDefined()
    expect(run.handle).toBe(handle)
    expect(run.text).toBe('hi')
    expect(run.recreated).toBe(false)
    expect(run.runToken).toBe((result as { requestId: string }).requestId)
    expect(run.maxMessages).toBe(3)
    expect(run.deadlineMono).toBe(1_000 + 10_000)
    expect(port.envelopes).toEqual([{ text: 'answer', notices: [], maxMessages: 3 }])
    expect(h.sessions.markIdleCalls).toEqual([handle])
    expect(h.sessions.released).toHaveLength(0)
    const deliverIdx = h.ops.indexOf('deliver')
    const markIdleIdx = h.ops.indexOf('markIdle')
    const closeIdx = h.ops.indexOf('close')
    expect(deliverIdx).toBeGreaterThanOrEqual(0)
    expect(markIdleIdx).toBeGreaterThan(deliverIdx)
    expect(closeIdx).toBeGreaterThan(markIdleIdx)
    expect(h.logs.some((l) => l.event === 'queued')).toBe(true)
  })

  it('prepare creation-failed：turn-failed 信封、close、不进 runner、不释放 handle', async () => {
    const h = await makeHarness()
    const { ingress } = await startWithChannel(h)
    h.sessions.prepareImpl = async () => ({ error: { kind: 'creation-failed' } })
    const { message, port } = makeMessage('boom')
    await ingress.inbound(message)
    await waitFor(() => port.closed)
    expect(port.envelopes).toHaveLength(1)
    expect(port.envelopes[0].notices).toEqual(['turn-failed'])
    expect(port.envelopes[0].maxMessages).toBe(4)
    expect(h.runner.runs).toHaveLength(0)
    expect(h.sessions.markIdleCalls).toHaveLength(0)
    expect(h.sessions.released).toHaveLength(0)
    expect(h.logs.some((l) => l.event === 'reply_sent')).toBe(true)
    expect(h.handle.query.snapshot().state).toBe('ready')
  })

  it('prepare fatal：enterFailed + state-unavailable，后续 inbound unavailable', async () => {
    const h = await makeHarness()
    const { ingress } = await startWithChannel(h)
    h.sessions.prepareImpl = async () => ({ error: { kind: 'fatal' } })
    const { message, port } = makeMessage('x')
    await ingress.inbound(message)
    await waitFor(() => port.closed)
    expect(port.envelopes[0].notices).toEqual(['state-unavailable'])
    expect(h.handle.query.snapshot().state).toBe('failed')
    expect(h.logs.some((l) => l.event === 'state_failed')).toBe(true)
    expect(h.logs.some((l) => l.event === 'manual_restart_required')).toBe(true)
    const again = await ingress.inbound(makeMessage('again').message)
    expect(again).toEqual({ accepted: false, reason: 'unavailable' })
  })

  it('prepare 超时 abort（deadline 定时器）：aborted + 越界 mono → turn-timeout', async () => {
    const h = await makeHarness({ limits: { TURN_DEADLINE_MS: 40 } })
    const { ingress } = await startWithChannel(h)
    h.sessions.prepareImpl = (_identity, signal) =>
      new Promise<PrepareResult>((resolve) => {
        // 定时器到点 abort 时模拟单调时钟已越过截止点（真实环境二者同源）。
        signal.addEventListener('abort', () => {
          h.clocks.mono += 41
          resolve({ error: { kind: 'aborted' } })
        })
      })
    const { message, port } = makeMessage('slow-prepare')
    await ingress.inbound(message)
    await waitFor(() => port.closed, 2_000)
    expect(port.envelopes).toHaveLength(1)
    expect(port.envelopes[0].notices).toEqual(['turn-timeout'])
    expect(h.logs.some((l) => l.event === 'turn_timeout')).toBe(true)
    expect(h.runner.runs).toHaveLength(0)
  })

  it('prepare 停机 abort：不发送任何提示，仅 close', async () => {
    const h = await makeHarness()
    const { ingress } = await startWithChannel(h)
    h.sessions.prepareImpl = (_identity, signal) =>
      new Promise<PrepareResult>((resolve) => {
        signal.addEventListener('abort', () => resolve({ error: { kind: 'aborted' } }))
      })
    const { message, port } = makeMessage('stopping')
    await ingress.inbound(message)
    await waitFor(() => h.sessions.prepareCalls.length === 1)
    const stopPromise = h.handle.lifecycle.stop()
    await waitFor(() => port.closed)
    expect(port.envelopes).toHaveLength(0)
    await stopPromise
  })

  it('准备完成但 deadline 已耗尽：turn-timeout（含 recreated 提示）+ releaseHandle(cancelled)', async () => {
    const h = await makeHarness()
    const { ingress } = await startWithChannel(h)
    const handle = makeHandle('h-late')
    const gate = deferred<PrepareResult>()
    h.sessions.prepareImpl = () => gate.promise
    const { message, port } = makeMessage('late-prepare')
    await ingress.inbound(message)
    await waitFor(() => h.sessions.prepareCalls.length === 1)
    h.clocks.mono = 1_000 + 10_000 + 50
    gate.resolve(makePrepared(handle, { recreated: true }))
    await waitFor(() => port.closed)
    expect(port.envelopes).toHaveLength(1)
    expect(port.envelopes[0].notices).toEqual(['session-recreated', 'turn-timeout'])
    expect(h.runner.runs).toHaveLength(0)
    expect(h.sessions.released).toHaveLength(1)
    expect(h.sessions.released[0].handle).toBe(handle)
    expect(h.sessions.released[0].cancelled).toBe(true)
    // 剩余清理预算 = deadlineMono(11000) + 200 - mono(11050) = 150
    expect(h.sessions.released[0].deadlineMs).toBe(150)
  })

  it('outcome needs-release：cancelled 依 outcome.kind；释放未收敛转 failed', async () => {
    const h = await makeHarness()
    const { ingress } = await startWithChannel(h)
    const handleA = makeHandle('h-a')
    h.sessions.prepareImpl = async () => makePrepared(handleA)
    h.runner.runImpl = async () => ({
      kind: 'timeout',
      handleHealth: 'needs-release',
      settled: false,
      runMs: 5,
    })
    const first = makeMessage('timeout-case')
    await ingress.inbound(first.message)
    await waitFor(() => h.sessions.released.length === 1)
    expect(h.sessions.released[0].cancelled).toBe(true)
    expect(h.sessions.markIdleCalls).toHaveLength(0)
    expect(h.handle.query.snapshot().state).toBe('ready')

    const handleB = makeHandle('h-b')
    h.sessions.prepareImpl = async () => makePrepared(handleB)
    h.runner.runImpl = async () => ({
      kind: 'completed',
      handleHealth: 'needs-release',
      settled: false,
      runMs: 5,
    })
    const second = makeMessage('contract-case')
    await ingress.inbound(second.message)
    await waitFor(() => h.sessions.released.length === 2)
    expect(h.sessions.released[1].cancelled).toBe(false)

    h.sessions.releaseImpl = async () => 'timeout'
    const handleC = makeHandle('h-c')
    h.sessions.prepareImpl = async () => makePrepared(handleC)
    h.runner.runImpl = async () => ({
      kind: 'failed',
      handleHealth: 'needs-release',
      settled: false,
      runMs: 5,
    })
    const third = makeMessage('stuck-case')
    await ingress.inbound(third.message)
    await waitFor(() => h.handle.query.snapshot().state === 'failed')
    expect(h.logs.some((l) => l.event === 'manual_restart_required')).toBe(true)
    expect(h.logs.some((l) => l.event === 'state_failed' && l.reason === 'dispose_did_not_converge')).toBe(
      true,
    )
  })

  it('queueExpired：窗口不足出队 → queue-expired 信封 + close；dropped：过期只记日志；onStopDropped：只 close', async () => {
    // queueExpired：剩余窗口 5s < TURN_DEADLINE(10s)+margin(0)
    const h1 = await makeHarness()
    const s1 = await startWithChannel(h1)
    const expiredWindow = makeMessage('late', { expiresAt: WALL_BASE + 5_000 })
    const admitted = await s1.ingress.inbound(expiredWindow.message)
    expect(admitted.accepted).toBe(true)
    await waitFor(() => expiredWindow.port.closed)
    expect(expiredWindow.port.envelopes).toHaveLength(1)
    expect(expiredWindow.port.envelopes[0].notices).toEqual(['queue-expired'])
    expect(h1.sessions.prepareCalls).toHaveLength(0)

    // dropped：排队消息在出队前过期 → 不发送任何内容
    const h2 = await makeHarness()
    const s2 = await startWithChannel(h2)
    const gate = deferred<PrepareResult>()
    h2.sessions.prepareImpl = () => gate.promise
    await s2.ingress.inbound(makeMessage('first').message)
    const second = makeMessage('second', { messageId: 'm-second' })
    expect((await s2.ingress.inbound(second.message)).accepted).toBe(true)
    expect(h2.handle.query.snapshot()).toMatchObject({ pending: 1, running: 1 })
    h2.clocks.wall += 3_600_000 * 2
    gate.resolve({ error: { kind: 'creation-failed' } })
    await waitFor(() => second.port.closed)
    expect(second.port.envelopes).toHaveLength(0)
    expect(
      h2.logs.some((l) => l.event === 'inbound_ignored' && l.reason === 'expired before dequeue'),
    ).toBe(true)

    // onStopDropped：正常停止丢弃排队任务 → 只 close，无停机广播
    const h3 = await makeHarness()
    const s3 = await startWithChannel(h3)
    h3.sessions.prepareImpl = (_identity, signal) =>
      new Promise<PrepareResult>((resolve) => {
        signal.addEventListener('abort', () => resolve({ error: { kind: 'aborted' } }))
      })
    await s3.ingress.inbound(makeMessage('busy').message)
    const queued = makeMessage('queued')
    await s3.ingress.inbound(queued.message)
    const stopPromise = h3.handle.lifecycle.stop()
    await waitFor(() => queued.port.closed)
    expect(queued.port.envelopes).toHaveLength(0)
    await stopPromise
  })

  it('stop 幂等（同 promise）、终态 stopped、后续 inbound 拒绝', async () => {
    const h = await makeHarness()
    const { ingress } = await startWithChannel(h)
    const p1 = h.handle.lifecycle.stop()
    const p2 = h.handle.lifecycle.stop()
    expect(p1).toBe(p2)
    await p1
    expect(h.handle.query.snapshot().state).toBe('stopped')
    const result = await ingress.inbound(makeMessage('after-stop').message)
    expect(result).toEqual({ accepted: false, reason: 'stopping' })
  })

  it('stop：先等自然结束窗口再 stopInterrupt；随后释放缓存 handle、置 stopped', async () => {
    const h = await makeHarness({
      limits: { STOP_NATURAL_COMPLETION_WAIT_MS: 40, CORE_SHUTDOWN_BUDGET_MS: 1_000 },
    })
    const { ingress, channel } = await startWithChannel(h)
    const handle = makeHandle('h-stop')
    h.sessions.prepareImpl = async () => makePrepared(handle)
    const runGate = deferred<void>()
    h.runner.runImpl = () =>
      runGate.promise.then(
        () =>
          ({
            kind: 'completed',
            handleHealth: 'healthy',
            settled: true,
            runMs: 1,
          }) satisfies TurnOutcome,
      )
    await ingress.inbound(makeMessage('running').message)
    await waitFor(() => h.runner.runs.length === 1)
    expect(h.handle.query.snapshot().running).toBe(1)
    h.sessions.cachedHandles = [handle]

    const stopPromise = h.handle.lifecycle.stop()
    expect(h.runner.stopInterrupts).toHaveLength(0)
    await waitFor(() => h.runner.stopInterrupts.length === 1, 500)
    expect(h.runner.stopInterrupts[0]).toBe(h.runner.runs[0].runToken)
    expect(h.handle.query.snapshot().state).toBe('stopping')
    runGate.resolve()
    await stopPromise
    expect(h.handle.query.snapshot().state).toBe('stopped')
    expect(channel.stopCalls).toBe(1)
    expect(h.ops).toContain('sessions.stop')
    expect(h.sessions.released.map((r) => r.handle)).toEqual([handle])
    expect(h.logs.some((l) => l.event === 'manual_restart_required')).toBe(false)
  })

  it('stop 预算耗尽（releaseHandle 挂起）：记 manual_restart_required 并仍置 stopped', async () => {
    const h = await makeHarness({
      limits: { CORE_SHUTDOWN_BUDGET_MS: 60, STOP_NATURAL_COMPLETION_WAIT_MS: 10 },
    })
    await startWithChannel(h)
    const handle = makeHandle('h-stuck')
    h.sessions.cachedHandles = [handle]
    h.sessions.releaseImpl = () => new Promise<'disposed' | 'timeout'>(() => undefined)
    await h.handle.lifecycle.stop()
    expect(h.handle.query.snapshot().state).toBe('stopped')
    const restart = h.logs.find((l) => l.event === 'manual_restart_required')
    expect(restart?.reason).toMatch(/session_release/)
    expect(h.logs.some((l) => l.event === 'shutdown')).toBe(true)
  })

  it('store.load 校验失败 → start() 抛错且 core 保持 starting（不启动回收器）', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'dsh-core-invalid-'))
    await writeFile(join(stateDir, 'bindings.json'), '{not valid json', 'utf8')
    const logs: LogLine[] = []
    const logger = createGatewayLogger({
      debug: false,
      sink: (line) => {
        logs.push(JSON.parse(line) as LogLine)
      },
    })
    const store = createStateStore({ stateDir, limits: GATEWAY_LIMITS, logger })
    const h = await makeHarness({ store })
    await expect(h.handle.lifecycle.start()).rejects.toThrow()
    expect(h.handle.query.snapshot().state).toBe('starting')
    expect(h.handle.query.snapshot().startedAt).toBe('')
    // core 不在启动路径关闭任何资源，也不启动会话回收器。
    expect(h.ops).not.toContain('sessions.start')
  })

  it('start 挂起在 store.load 期间被 stop：启动被停止吸收，不启动回收器、不写 startedAt、不抛错', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'dsh-core-race-load-'))
    const logs: LogLine[] = []
    const logger = createGatewayLogger({
      debug: false,
      sink: (line) => {
        logs.push(JSON.parse(line) as LogLine)
      },
    })
    const loadGate = deferred<void>()
    let loadStarted = false
    const io: StateStoreIo = {
      ...createDefaultStateStoreIo(),
      readFile: async () => {
        loadStarted = true
        await loadGate.promise
        return '{"schemaVersion":1,"revision":0,"bindings":{}}\n'
      },
    }
    const store = createStateStore({ stateDir, limits: GATEWAY_LIMITS, logger, io })
    const h = await makeHarness({ store })

    const startPromise = h.handle.lifecycle.start()
    await waitFor(() => loadStarted)
    // 停止链先于启动完成：core 进入 stopped，不启动回收器。
    await h.handle.lifecycle.stop()
    expect(h.handle.query.snapshot().state).toBe('stopped')
    expect(h.handle.query.snapshot().startedAt).toBe('')

    loadGate.resolve()
    await expect(startPromise).resolves.toBeUndefined()
    // load 返回后不得重新启动回收器，也不得补写 startedAt（stopped 状态不带启动时间）。
    expect(h.ops).not.toContain('sessions.start')
    expect(h.handle.query.snapshot().state).toBe('stopped')
    expect(h.handle.query.snapshot().startedAt).toBe('')
  })

  it('快照：ready 前 startedAt 为空串；进入 ready 后含启动时间，pending/running 反映调度计数', async () => {
    const h = await makeHarness()
    // starting：空注册表、无启动时间、store 未失败。
    expect(h.handle.query.snapshot()).toEqual({
      state: 'starting',
      stateStoreFailed: false,
      startedAt: '',
      pending: 0,
      running: 0,
      channels: [],
    })
    const { ingress } = await startWithChannel(h)
    expect(h.handle.query.snapshot().state).toBe('ready')
    expect(h.handle.query.snapshot().startedAt).toBe(new Date(WALL_BASE).toISOString())
    expect(h.handle.query.snapshot().channels).toEqual([
      { channelId: 'qq', accountId: 'app-1', state: 'online' },
    ])

    const gate = deferred<PrepareResult>()
    h.sessions.prepareImpl = () => gate.promise
    const first = makeMessage('first')
    await ingress.inbound(first.message)
    const second = makeMessage('second', { messageId: 'm-second' })
    await ingress.inbound(second.message)
    const runningSnapshot = h.handle.query.snapshot()
    expect(runningSnapshot).toMatchObject({ pending: 1, running: 1 })
    // 就绪时间在启动时固化，不随后续调度变化。
    expect(runningSnapshot.startedAt).toBe(new Date(WALL_BASE).toISOString())
    gate.resolve({ error: { kind: 'creation-failed' } })
    await waitFor(() => second.port.closed)
  })

  it('快照：channels 只含已注册实例并按注册顺序；setState/disconnect 实时反映', async () => {
    const h = await makeHarness()
    await h.handle.lifecycle.start()
    // 未注册（配置有实例或没有都无关）：core 快照为空。
    expect(h.handle.query.snapshot().channels).toEqual([])

    const ingress1 = h.handle.ingress.registerChannel(new FakeChannel('qq', 'app-1'))
    expect(h.handle.query.snapshot().channels).toEqual([
      { channelId: 'qq', accountId: 'app-1', state: 'connecting' },
    ])
    ingress1.setState('online')
    expect(h.handle.query.snapshot().channels).toEqual([
      { channelId: 'qq', accountId: 'app-1', state: 'online' },
    ])

    const ingress2 = h.handle.ingress.registerChannel(new FakeChannel('qq', 'app-2'))
    ingress2.setState('reconnecting')
    expect(h.handle.query.snapshot().channels).toEqual([
      { channelId: 'qq', accountId: 'app-1', state: 'online' },
      { channelId: 'qq', accountId: 'app-2', state: 'reconnecting' },
    ])

    await ingress1.disconnect()
    expect(h.handle.query.snapshot().channels).toEqual([
      { channelId: 'qq', accountId: 'app-2', state: 'reconnecting' },
    ])
  })

  it('快照：stateStoreFailed 反映 store failed 并转 failed', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'dsh-core-broken-'))
    const logs: LogLine[] = []
    const logger = createGatewayLogger({
      debug: false,
      sink: (line) => {
        logs.push(JSON.parse(line) as LogLine)
      },
    })
    const io: StateStoreIo = {
      ...createDefaultStateStoreIo(),
      writeFile: async () => {
        throw Object.assign(new Error('simulated persistence failure'), { code: 'EIO' })
      },
    }
    const store = createStateStore({ stateDir, limits: GATEWAY_LIMITS, logger, io })
    const h = await makeHarness({ store })
    await h.handle.lifecycle.start()
    const ingress = h.handle.ingress.registerChannel(new FakeChannel())
    ingress.setState('online')
    expect(h.handle.query.snapshot()).toMatchObject({ state: 'ready', stateStoreFailed: false })

    const identity: ChannelIdentity = { channelId: 'qq', accountId: 'app-1', peerId: 'peer-1' }
    const bindingId = computeBindingId(identity)
    await expect(
      store.runTransaction((draft) => {
        draft.set(bindingId, {
          channelId: identity.channelId,
          accountId: identity.accountId,
          peerId: identity.peerId,
          sessionId: '0b2d1a34-6f21-4c3d-9a52-2f7c2f1b0001',
          generation: 1,
          createdAt: '2026-10-01T00:00:00Z',
          updatedAt: '2026-10-01T00:00:00Z',
        })
      }),
    ).rejects.toThrow()
    expect(store.isFailed()).toBe(true)
    expect(h.handle.query.snapshot().stateStoreFailed).toBe(true)
    expect(h.handle.query.snapshot().state).toBe('failed')
    // failed 是吸收态：停止协调器清理后仍保持 failed，不会落 stopped。
    await h.handle.lifecycle.stop()
    expect(h.handle.query.snapshot().state).toBe('failed')
  })

  it('core 模块源码不导入 QQ SDK、dsh 运行时、node:http 与 config（边界）', () => {
    const coreDir = fileURLToPath(new URL('../src/core/', import.meta.url))
    const files = readdirSync(coreDir).filter((f) => f.endsWith('.ts'))
    expect(files.length).toBeGreaterThanOrEqual(5)
    for (const file of files) {
      const content = readFileSync(join(coreDir, file), 'utf8')
      // 简报要求：core 源码不含 QQ SDK 标识（子串级）。
      expect(content.includes('@tencent-connect'), `${file} imports QQ SDK`).toBe(false)
      // dsh 边界按 import 语句断言（单/双引号两种写法；注释散文可提及包名）。
      expect(
        content.match(/from\s+['"]@deepseek-ai|import\s+['"]@deepseek-ai/),
        `${file} imports dsh runtime`,
      ).toBe(null)
      // 传输层归 http 模块；core 不拥有监听与探针。
      expect(content.match(/from\s+['"]node:http['"]/), `${file} imports node:http`).toBe(null)
      // core 不依赖配置模块（GatewayConfig 由 runtime.ts 解析后按参数注入）。
      expect(content.match(/from\s+['"]\.\.\/config\//), `${file} imports GatewayConfig`).toBe(null)
    }
  })

  it('disconnect：旧 ingress 失效、该实例队列丢弃与运行中断，其他实例继续收发', async () => {
    const h = await makeHarness()
    await h.handle.lifecycle.start()
    const ingress1 = h.handle.ingress.registerChannel(new FakeChannel('qq', 'app-1'))
    ingress1.setState('online')
    const ingress2 = h.handle.ingress.registerChannel(new FakeChannel('qq', 'app-2'))
    ingress2.setState('online')

    h.sessions.prepareImpl = (_identity, signal) =>
      new Promise<PrepareResult>((resolve) => {
        signal.addEventListener('abort', () => resolve({ error: { kind: 'aborted' } }))
      })
    const m1 = makeMessage('d1', { peerId: 'peer-1' })
    await ingress1.inbound(m1.message)
    const m2 = makeMessage('d2', { peerId: 'peer-2' })
    await ingress2.inbound(m2.message)
    await waitFor(() => h.sessions.prepareCalls.length === 2)
    // q1/q2 分别排到各自实例正在执行的同 peer FIFO 后（保持 pending 状态）。
    const queued1 = makeMessage('q1', { messageId: 'q-1', peerId: 'peer-1' })
    await ingress1.inbound(queued1.message)
    const queued2 = makeMessage('q2', { messageId: 'q-2', peerId: 'peer-2' })
    await ingress2.inbound(queued2.message)
    expect(h.handle.query.snapshot().pending).toBe(2)

    await ingress1.disconnect()

    // app-1：排队任务被丢弃（仅关闭 port），运行中的执行被中断。
    await waitFor(() => m1.port.closed && queued1.port.closed)
    expect(m1.port.envelopes).toHaveLength(0)
    expect(queued1.port.envelopes).toHaveLength(0)
    // 旧 ingress 失效：后续 inbound 拒绝。
    const stale = await ingress1.inbound(makeMessage('d3').message)
    expect(stale).toEqual({ accepted: false, reason: 'stopping' })
    // disconnect 幂等。
    await ingress1.disconnect()
    // app-2 不受影响：其排队任务保留、新消息仍可准入，scheduler 未停止。
    expect(h.handle.query.snapshot().pending).toBe(1)
    const fresh = await ingress2.inbound(makeMessage('d4', { peerId: 'peer-2' }).message)
    expect(fresh.accepted).toBe(true)
    expect(h.handle.query.snapshot().state).toBe('ready')
    // 渠道表已注销 app-1；app-2 仍在。
    expect(h.handle.query.snapshot().channels).toEqual([
      { channelId: 'qq', accountId: 'app-2', state: 'online' },
    ])
  })

  it('disconnect 后可用新实例重新注册同一账号', async () => {
    const h = await makeHarness()
    const first = new FakeChannel('qq', 'app-1')
    const ingress1 = h.handle.ingress.registerChannel(first)
    await ingress1.disconnect()
    const second = new FakeChannel('qq', 'app-1')
    expect(() => h.handle.ingress.registerChannel(second)).not.toThrow()
    expect(h.handle.query.snapshot().channels).toEqual([
      { channelId: 'qq', accountId: 'app-1', state: 'connecting' },
    ])
  })

  it('setState blocked 记 manual_restart_required，reason 指引重跑 channel enable（重启兜底）', async () => {
    const h = await makeHarness()
    await h.handle.lifecycle.start()
    const ingress = h.handle.ingress.registerChannel(new FakeChannel('qq', 'app-1'))
    ingress.setState('blocked')
    const line = h.logs.find((l) => l.event === 'manual_restart_required')
    expect(String(line?.reason)).toContain('dsh-gateway channel enable qq')
    expect(String(line?.reason)).toContain('fallback')
  })
})
