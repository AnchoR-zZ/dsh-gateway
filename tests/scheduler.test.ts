import { describe, expect, it, vi } from 'vitest'
import { GATEWAY_LIMITS, type DeliveryReport, type ReplyPort } from '../src/contracts.js'
import { createGatewayLogger } from '../src/logging.js'
import {
  createScheduler,
  type AdmitInput,
  type AdmitResult,
  type QueuedTask,
  type Scheduler,
} from '../src/core/scheduler.js'

/** 出队窗口下限：10 分钟执行预算 + 3 分钟出站余量（设计文档 6.2）。
 * 简报写 TURN_TIMEOUT_MS，contracts 实际键名为 TURN_DEADLINE_MS，按实际键断言。 */
const MIN_WINDOW_MS = GATEWAY_LIMITS.TURN_DEADLINE_MS + GATEWAY_LIMITS.QQ_OUTBOUND_MARGIN_MS

/** 等待微任务队列排空：调度级联全部是 microtask，一个 macrotask 边界足够。 */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function makeReply(): ReplyPort {
  return {
    deliver: vi.fn(async (): Promise<DeliveryReport> => ({ status: 'sent', attempted: 1, confirmed: 1 })),
    close: vi.fn(),
  }
}

interface Park {
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}

/** 受控 promise：默认挂起，测试按 index 手动 settle。 */
function park(): Park {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type Outcome = 'resolve' | 'reject'
type Settle = (outcome: Outcome, error?: unknown) => void

interface HarnessOptions {
  maxConcurrent?: number
  maxPendingPerPeer?: number
  maxPendingTotal?: number
  maxPendingBytes?: number
  onExecute?: (task: QueuedTask, settle: Settle) => void
  onQueueExpired?: (task: QueuedTask, settle: Settle) => void
  onDropped?: (task: QueuedTask) => void | Promise<void>
  onStopDropped?: (task: QueuedTask) => void
}

interface Harness {
  scheduler: Scheduler
  clock: { now(): number; advance(ms: number): void }
  executeCalls: QueuedTask[]
  queueExpiredCalls: QueuedTask[]
  droppedCalls: QueuedTask[]
  onStopDroppedCalls: QueuedTask[]
  logEvents: Array<Record<string, unknown>>
  settleExecute(index: number, outcome?: Outcome, error?: unknown): void
  settleQueueExpired(index: number, outcome?: Outcome, error?: unknown): void
  admit(overrides?: Partial<AdmitInput>): AdmitResult
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const executeCalls: QueuedTask[] = []
  const queueExpiredCalls: QueuedTask[] = []
  const droppedCalls: QueuedTask[] = []
  const onStopDroppedCalls: QueuedTask[] = []
  const logEvents: Array<Record<string, unknown>> = []
  const executeParks: Park[] = []
  const queueExpiredParks: Park[] = []
  let clockMs = 1_000_000
  let counter = 0

  const settleOf = (p: Park): Settle => (outcome, error) => {
    if (outcome === 'resolve') {
      p.resolve()
    } else {
      p.reject(error ?? new Error('test reject'))
    }
  }

  const scheduler = createScheduler({
    config: {
      maxConcurrent: options.maxConcurrent ?? 4,
      maxPendingPerPeer: options.maxPendingPerPeer ?? 3,
      maxPendingTotal: options.maxPendingTotal ?? 100,
      maxPendingBytes: options.maxPendingBytes ?? 8_388_608,
    },
    limits: GATEWAY_LIMITS,
    logger: createGatewayLogger({
      debug: false,
      sink: (line) => {
        logEvents.push(JSON.parse(line) as Record<string, unknown>)
      },
    }),
    callbacks: {
      execute(task) {
        executeCalls.push(task)
        const p = park()
        executeParks.push(p)
        options.onExecute?.(task, settleOf(p))
        return p.promise
      },
      queueExpired(task) {
        queueExpiredCalls.push(task)
        const p = park()
        queueExpiredParks.push(p)
        options.onQueueExpired?.(task, settleOf(p))
        return p.promise
      },
      dropped(task) {
        droppedCalls.push(task)
        return options.onDropped?.(task)
      },
      onStopDropped(task) {
        onStopDroppedCalls.push(task)
        options.onStopDropped?.(task)
      },
    },
    now: () => clockMs,
  })

  return {
    scheduler,
    clock: {
      now: () => clockMs,
      advance: (ms: number) => {
        clockMs += ms
      },
    },
    executeCalls,
    queueExpiredCalls,
    droppedCalls,
    onStopDroppedCalls,
    logEvents,
    settleExecute: (index, outcome = 'resolve', error) => settleOf(executeParks[index])(outcome, error),
    settleQueueExpired: (index, outcome = 'resolve', error) =>
      settleOf(queueExpiredParks[index])(outcome, error),
    admit(overrides = {}) {
      counter += 1
      return scheduler.admit({
        requestId: `req-${counter}`,
        bindingId: 'A',
        messageId: `msg-${counter}`,
        text: 'hello',
        receivedAt: clockMs,
        expiresAt: clockMs + GATEWAY_LIMITS.QQ_PASSIVE_REPLY_WINDOW_MS,
        reply: makeReply(),
        ...overrides,
      })
    },
  }
}

function expectAccepted(result: AdmitResult): QueuedTask {
  if (!result.accepted) {
    throw new Error(`expected accepted, got: ${result.reason}`)
  }
  return result.task
}

function expectRejected(result: AdmitResult, reason: 'busy' | 'stopping' | 'expired'): void {
  expect(result).toEqual({ accepted: false, reason })
}

describe('scheduler: 同用户 FIFO 与跨用户并发', () => {
  it('同一用户 3 条消息按接受顺序串行执行，前一任务 settle 前下一条不开始', async () => {
    const h = makeHarness()
    expectAccepted(h.admit({ messageId: 'a1' }))
    expectAccepted(h.admit({ messageId: 'a2' }))
    expectAccepted(h.admit({ messageId: 'a3' }))

    expect(h.executeCalls.map((t) => t.messageId)).toEqual(['a1'])
    expect(h.scheduler.stats()).toEqual({ pendingTotal: 2, pendingBytes: 10, running: 1, waitingPeers: 0 })

    h.settleExecute(0)
    await flush()
    expect(h.executeCalls.map((t) => t.messageId)).toEqual(['a1', 'a2'])

    h.settleExecute(1)
    await flush()
    expect(h.executeCalls.map((t) => t.messageId)).toEqual(['a1', 'a2', 'a3'])
    expect(h.scheduler.stats()).toEqual({ pendingTotal: 0, pendingBytes: 0, running: 1, waitingPeers: 0 })

    h.settleExecute(2)
    await flush()
    expect(h.scheduler.stats()).toEqual({ pendingTotal: 0, pendingBytes: 0, running: 0, waitingPeers: 0 })
  })

  it('maxConcurrent=2 时不同用户的任务并行在飞，互不等待', async () => {
    const h = makeHarness({ maxConcurrent: 2 })
    expectAccepted(h.admit({ bindingId: 'A' }))
    expectAccepted(h.admit({ bindingId: 'B' }))
    expect(h.executeCalls.map((t) => t.bindingId).sort()).toEqual(['A', 'B'])
    expect(h.scheduler.stats().running).toBe(2)

    h.settleExecute(0)
    await flush()
    expect(h.scheduler.stats().running).toBe(1)
    h.settleExecute(1)
    await flush()
    expect(h.scheduler.stats().running).toBe(0)
  })

  it('maxConcurrent=1 时不同用户串行执行，后到用户就绪等待', async () => {
    const h = makeHarness({ maxConcurrent: 1 })
    expectAccepted(h.admit({ bindingId: 'A' }))
    expectAccepted(h.admit({ bindingId: 'B' }))
    expect(h.executeCalls.map((t) => t.bindingId)).toEqual(['A'])
    expect(h.scheduler.stats()).toEqual({ pendingTotal: 1, pendingBytes: 5, running: 1, waitingPeers: 1 })

    h.settleExecute(0)
    await flush()
    expect(h.executeCalls.map((t) => t.bindingId)).toEqual(['A', 'B'])
    h.settleExecute(1)
    await flush()
    expect(h.scheduler.stats().running).toBe(0)
  })
})

describe('scheduler: 轮转公平', () => {
  it('maxConcurrent=1 时三个积压用户交替执行 A→B→C→A→B→C，同用户内部保持 FIFO', async () => {
    const h = makeHarness({ maxConcurrent: 1, maxPendingPerPeer: 3 })
    h.admit({ bindingId: 'A', messageId: 'a1' })
    h.admit({ bindingId: 'B', messageId: 'b1' })
    h.admit({ bindingId: 'C', messageId: 'c1' })
    h.admit({ bindingId: 'A', messageId: 'a2' })
    h.admit({ bindingId: 'B', messageId: 'b2' })
    h.admit({ bindingId: 'C', messageId: 'c2' })
    expect(h.executeCalls.map((t) => t.messageId)).toEqual(['a1'])

    for (let i = 1; i <= 5; i += 1) {
      h.settleExecute(i - 1)
      await flush()
    }
    h.settleExecute(5)
    await flush()

    expect(h.executeCalls.map((t) => `${t.bindingId}:${t.messageId}`)).toEqual([
      'A:a1',
      'B:b1',
      'C:c1',
      'A:a2',
      'B:b2',
      'C:c2',
    ])
    expect(h.scheduler.stats()).toEqual({ pendingTotal: 0, pendingBytes: 0, running: 0, waitingPeers: 0 })
  })
})

describe('scheduler: 容量准入', () => {
  it('maxPendingPerPeer=1：执行中用户的第 2 条排队接受、第 3 条被拒 busy', () => {
    const h = makeHarness({ maxConcurrent: 1, maxPendingPerPeer: 1 })
    expectAccepted(h.admit())
    expectAccepted(h.admit())
    expectRejected(h.admit(), 'busy')
    expect(h.scheduler.stats()).toEqual({ pendingTotal: 1, pendingBytes: 5, running: 1, waitingPeers: 0 })
  })

  it('maxPendingTotal=2：全局条数满时新用户被拒 busy', () => {
    const h = makeHarness({ maxConcurrent: 1, maxPendingTotal: 2, maxPendingPerPeer: 10 })
    expectAccepted(h.admit({ bindingId: 'A' }))
    expectAccepted(h.admit({ bindingId: 'A' }))
    expectAccepted(h.admit({ bindingId: 'B' }))
    expectRejected(h.admit({ bindingId: 'C' }), 'busy')
    // A 执行中且有 1 条排队（busy 不计入 waitingPeers，执行中正文不计入 pendingBytes），B 就绪等待
    expect(h.scheduler.stats()).toEqual({ pendingTotal: 2, pendingBytes: 10, running: 1, waitingPeers: 1 })
  })

  it('maxPendingBytes=100：排队正文按 UTF-8 字节累计，恰好等于上限允许、超出拒绝', () => {
    const h = makeHarness({ maxConcurrent: 1, maxPendingBytes: 100 })
    expectAccepted(h.admit({ text: 'x'.repeat(60) })) // 执行中，不占等待字节
    expectAccepted(h.admit({ text: 'y'.repeat(60) })) // 排队 60B
    expectRejected(h.admit({ text: 'z'.repeat(50) }), 'busy') // 60+50 > 100
    expect(h.scheduler.stats().pendingBytes).toBe(60)
    expectAccepted(h.admit({ text: 'w'.repeat(40) })) // 60+40 = 100 恰好允许
    expect(h.scheduler.stats().pendingBytes).toBe(100)
    expectRejected(h.admit({ text: 'v' }), 'busy')
  })

  it('pendingBytes 按 UTF-8 字节而非字符数计', () => {
    const h = makeHarness({ maxConcurrent: 1, maxPendingBytes: 10 })
    expectAccepted(h.admit({ text: 'ok' }))
    expectRejected(h.admit({ text: '你好你好' }), 'busy') // 4 字符 = 12 字节
    expectAccepted(h.admit({ text: '你好' })) // 6 字节
    expect(h.scheduler.stats().pendingBytes).toBe(6)
  })

  it('拒绝不改变计数：被拒后再次 admit 仍基于原计数判断', async () => {
    const h = makeHarness({ maxConcurrent: 1, maxPendingPerPeer: 1 })
    expectAccepted(h.admit())
    expectAccepted(h.admit())
    expectRejected(h.admit(), 'busy')
    expectRejected(h.admit(), 'busy')
    expect(h.scheduler.stats()).toEqual({ pendingTotal: 1, pendingBytes: 5, running: 1, waitingPeers: 0 })

    h.settleExecute(0)
    await flush()
    // 排队任务被 pump 接走执行；随后再入队 1 条即重新触达 per-peer 上限
    expect(h.executeCalls).toHaveLength(2)
    expectAccepted(h.admit())
    expectRejected(h.admit(), 'busy')
    expect(h.scheduler.stats().pendingTotal).toBe(1)
  })

  it('入队时已过 expiresAt：直接拒绝 expired 并关闭 port，不产生任何回调与计数', () => {
    const h = makeHarness()
    const reply = makeReply()
    expectRejected(h.admit({ expiresAt: h.clock.now() - 1, reply }), 'expired')
    expect(reply.close).toHaveBeenCalledTimes(1)
    // 边界：expiresAt === now 同样视为已过期
    const boundary = makeReply()
    expectRejected(h.admit({ expiresAt: h.clock.now(), reply: boundary }), 'expired')
    expect(boundary.close).toHaveBeenCalledTimes(1)
    expect(h.executeCalls).toHaveLength(0)
    expect(h.queueExpiredCalls).toHaveLength(0)
    expect(h.droppedCalls).toHaveLength(0)
    expect(h.scheduler.stats()).toEqual({ pendingTotal: 0, pendingBytes: 0, running: 0, waitingPeers: 0 })
  })
})

describe('scheduler: 出队窗口判定', () => {
  it('出队时已过 expiresAt：dropped 回调收到任务，不 execute、不占槽，FIFO 清空并回收条目', async () => {
    const h = makeHarness({ maxConcurrent: 1, maxPendingPerPeer: 5 })
    expectAccepted(h.admit({ messageId: 'a1' }))
    expectAccepted(h.admit({ messageId: 'a2', expiresAt: h.clock.now() + 10 }))
    expectAccepted(h.admit({ messageId: 'a3', expiresAt: h.clock.now() + 5 }))
    h.clock.advance(10) // a2: expiresAt === now 边界；a3: 已过

    h.settleExecute(0)
    await flush()
    expect(h.droppedCalls.map((t) => t.messageId)).toEqual(['a2', 'a3'])
    expect(h.executeCalls.map((t) => t.messageId)).toEqual(['a1'])
    expect(h.queueExpiredCalls).toHaveLength(0)
    expect(h.scheduler.stats()).toEqual({ pendingTotal: 0, pendingBytes: 0, running: 0, waitingPeers: 0 })
    expect(h.scheduler.inspect().peerEntries).toBe(0)
  })

  it('dropped 回调返回 rejected promise：只记日志，不影响后续调度', async () => {
    const h = makeHarness({
      maxConcurrent: 1,
      onDropped: () => Promise.reject(new Error('drop boom')),
    })
    expectAccepted(h.admit({ messageId: 'a1' }))
    expectAccepted(h.admit({ messageId: 'a2', expiresAt: h.clock.now() + 5 }))
    h.clock.advance(6)
    h.settleExecute(0)
    await flush()
    expect(h.droppedCalls.map((t) => t.messageId)).toEqual(['a2'])
    expect(
      h.logEvents.some(
        (e) => e['event'] === 'turn_failed' && e['reason'] === 'drop_callback_error' && e['error'] === 'drop boom',
      ),
    ).toBe(true)
    // 队列未被阻塞：新任务正常执行
    expectAccepted(h.admit({ messageId: 'a3' }))
    expect(h.executeCalls.map((t) => t.messageId)).toEqual(['a1', 'a3'])
  })

  it('剩余窗口不足：queueExpired 回调占槽直至 resolve，execute 不被调用', async () => {
    const h = makeHarness({ maxConcurrent: 1 })
    expectAccepted(h.admit({ messageId: 'a1' }))
    expectAccepted(h.admit({ messageId: 'a2', expiresAt: h.clock.now() + MIN_WINDOW_MS - 1 }))
    h.settleExecute(0)
    await flush()
    expect(h.queueExpiredCalls.map((t) => t.messageId)).toEqual(['a2'])
    expect(h.executeCalls).toHaveLength(1)
    expect(h.scheduler.stats()).toEqual({ pendingTotal: 0, pendingBytes: 0, running: 1, waitingPeers: 0 })

    h.settleQueueExpired(0)
    await flush()
    expect(h.scheduler.stats().running).toBe(0)
  })

  it('剩余窗口恰好等于执行预算加余量：仍走 execute（判定为严格小于）', async () => {
    const h = makeHarness({ maxConcurrent: 1 })
    expectAccepted(h.admit({ messageId: 'a1' }))
    expectAccepted(h.admit({ messageId: 'a2', expiresAt: h.clock.now() + MIN_WINDOW_MS }))
    h.settleExecute(0)
    await flush()
    expect(h.queueExpiredCalls).toHaveLength(0)
    expect(h.executeCalls.map((t) => t.messageId)).toEqual(['a1', 'a2'])
  })
})

describe('scheduler: 失败隔离', () => {
  it('execute reject：记录 turn_failed(executor_error)，槽释放后同用户与其它用户继续', async () => {
    const h = makeHarness({ maxConcurrent: 2 })
    h.admit({ bindingId: 'A', messageId: 'a1' })
    h.admit({ bindingId: 'A', messageId: 'a2' })
    h.admit({ bindingId: 'B', messageId: 'b1' })
    expect(h.executeCalls.map((t) => t.messageId)).toEqual(['a1', 'b1'])

    h.settleExecute(0, 'reject', new Error('agent boom'))
    await flush()
    const failed = h.logEvents.filter((e) => e['event'] === 'turn_failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({
      requestId: 'req-1',
      bindingId: 'A',
      messageId: 'a1',
      reason: 'executor_error',
      error: 'agent boom',
    })
    // a1 失败释放槽 → a2 立即接上，b1 仍在飞
    expect(h.executeCalls.map((t) => t.messageId)).toEqual(['a1', 'b1', 'a2'])
    expect(h.scheduler.stats().running).toBe(2)

    h.settleExecute(1)
    h.settleExecute(2)
    await flush()
    expect(h.scheduler.stats().running).toBe(0)
  })

  it('queueExpired 回调 reject：同样释放槽并记录，后续 admit 不受影响', async () => {
    const h = makeHarness({ maxConcurrent: 1 })
    h.admit({ messageId: 'a1' })
    h.admit({ messageId: 'a2', expiresAt: h.clock.now() + 1000 })
    h.settleExecute(0)
    await flush()
    expect(h.queueExpiredCalls).toHaveLength(1)

    h.settleQueueExpired(0, 'reject', new Error('send failed'))
    await flush()
    expect(h.scheduler.stats().running).toBe(0)
    expect(
      h.logEvents.some(
        (e) => e['event'] === 'turn_failed' && e['reason'] === 'queue_expired_callback_error' && e['error'] === 'send failed',
      ),
    ).toBe(true)
    expectAccepted(h.admit({ messageId: 'a3' }))
    expect(h.executeCalls.map((t) => t.messageId)).toEqual(['a1', 'a3'])
  })
})

describe('scheduler: 正常停止', () => {
  it('stop()：admit 转 stopping，排队任务全部走 onStopDropped，运行中任务自然结束后 running 归零', async () => {
    const h = makeHarness({ maxConcurrent: 2, maxPendingPerPeer: 5 })
    h.admit({ bindingId: 'A', messageId: 'a1' }) // 运行中
    h.admit({ bindingId: 'A', messageId: 'a2' }) // 排队
    h.admit({ bindingId: 'B', messageId: 'b1' }) // 运行中（mc=2）
    h.admit({ bindingId: 'B', messageId: 'b2' }) // 排队

    h.scheduler.stop()
    expect(h.onStopDroppedCalls.map((t) => t.messageId)).toEqual(['a2', 'b2'])
    expectRejected(h.admit({ bindingId: 'C' }), 'stopping')
    expect(h.scheduler.stats()).toEqual({ pendingTotal: 0, pendingBytes: 0, running: 2, waitingPeers: 0 })

    h.settleExecute(0)
    h.settleExecute(1)
    await flush()
    expect(h.scheduler.stats()).toEqual({ pendingTotal: 0, pendingBytes: 0, running: 0, waitingPeers: 0 })
    expect(h.scheduler.inspect().peerEntries).toBe(0)

    // 幂等：重复 stop 不重复回调
    h.scheduler.stop()
    expect(h.onStopDroppedCalls).toHaveLength(2)
    // 停止后运行中的 settle 不再触发新执行
    expect(h.executeCalls.map((t) => t.messageId)).toEqual(['a1', 'b1'])
  })
})

describe('scheduler: stats 与条目回收', () => {
  it('stats 各字段随过程变化', async () => {
    const h = makeHarness({ maxConcurrent: 1 })
    expectAccepted(h.admit({ bindingId: 'A', messageId: 'a1' }))
    expect(h.scheduler.stats()).toEqual({ pendingTotal: 0, pendingBytes: 0, running: 1, waitingPeers: 0 })

    expectAccepted(h.admit({ bindingId: 'A', messageId: 'a2' }))
    expectAccepted(h.admit({ bindingId: 'B', messageId: 'b1' }))
    expect(h.scheduler.stats()).toEqual({ pendingTotal: 2, pendingBytes: 10, running: 1, waitingPeers: 1 })

    h.settleExecute(0)
    await flush()
    // a1 结束：轮转先取 B，b1 出队执行；A 仍有 a2 排队、转为就绪
    expect(h.scheduler.stats()).toEqual({ pendingTotal: 1, pendingBytes: 5, running: 1, waitingPeers: 1 })

    h.settleExecute(1)
    await flush()
    expect(h.scheduler.stats()).toEqual({ pendingTotal: 0, pendingBytes: 0, running: 1, waitingPeers: 0 })

    h.settleExecute(2)
    await flush()
    expect(h.scheduler.stats()).toEqual({ pendingTotal: 0, pendingBytes: 0, running: 0, waitingPeers: 0 })
  })

  it('FIFO 为空且无执行中任务后回收用户调度条目', async () => {
    const h = makeHarness({ maxConcurrent: 2 })
    expect(h.scheduler.inspect().peerEntries).toBe(0)

    expectAccepted(h.admit({ bindingId: 'A' }))
    expect(h.scheduler.inspect().peerEntries).toBe(1) // 执行中保留

    h.settleExecute(0)
    await flush()
    expect(h.scheduler.inspect().peerEntries).toBe(0) // 空闲回收

    expectAccepted(h.admit({ bindingId: 'A' }))
    expect(h.scheduler.inspect().peerEntries).toBe(1)
    h.settleExecute(1)
    await flush()
    expect(h.scheduler.inspect().peerEntries).toBe(0)
  })
})

describe('scheduler: 字段透传与序号', () => {
  it('task 字段逐项透传，seq 只在接受时递增（拒绝不消耗序号）', () => {
    const h = makeHarness({ maxConcurrent: 1, maxPendingPerPeer: 5 })
    const reply1 = makeReply()
    const expiresAt = h.clock.now() + GATEWAY_LIMITS.QQ_PASSIVE_REPLY_WINDOW_MS
    const r1 = h.admit({
      requestId: 'R1',
      messageId: 'M1',
      text: '你好 world',
      receivedAt: 12345,
      expiresAt,
      reply: reply1,
    })
    const task1 = expectAccepted(r1)
    expect(task1).toMatchObject({
      requestId: 'R1',
      bindingId: 'A',
      messageId: 'M1',
      text: '你好 world',
      receivedAt: 12345,
      expiresAt,
      reply: reply1,
      seq: 1,
    })

    // 中间夹一条入队即过期的拒绝：不消耗 seq
    expectRejected(h.admit({ expiresAt: h.clock.now() - 1 }), 'expired')

    const task2 = expectAccepted(h.admit({ requestId: 'R2', bindingId: 'B', messageId: 'M2' }))
    expect(task2.seq).toBe(2)
    const task3 = expectAccepted(h.admit({ requestId: 'R3', messageId: 'M3' }))
    expect(task3.seq).toBe(3)

    // 回调收到的是 admit 返回的同一 task 对象
    expect(h.executeCalls[0]).toBe(task1)
  })
})
