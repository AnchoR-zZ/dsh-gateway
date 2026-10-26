import { describe, expect, it } from 'vitest'
import type { QQChannelInstance } from '../src/config/schema.js'
import { GATEWAY_LIMITS } from '../src/contracts.js'
import type { GatewayCore } from '../src/contracts.js'
import type { ChannelState } from '../src/core/contracts.js'
import { SHUTDOWN_START_ERROR, createChannelManager } from '../src/channels/manager.js'
import type { ChannelManager } from '../src/channels/manager.js'
import type { QQChannel, QQChannelOptions } from '../src/channels/qq/index.js'
import { createGatewayLogger } from '../src/logging.js'
import type { GatewayLogger } from '../src/logging.js'

/**
 * channel 实例管理器单测：假渠道工厂 + 内存运行状态表（无真实网络、无 QQ SDK）。
 *
 * 覆盖基础行为（启停、替换、同 appId 串行、失败隔离、ensureOnline 幂等、waitForSettled、
 * stopAll）、停机闸门（新启动入口立即 blocked、排队启动在停机后不再创建实例、迟到的
 * waitForSettled 立即返回当前状态）与停止竞态（start 晚于 stopAll 落定、并发 stopAll 共享
 * 同一停止、启动失败后的运行表清理）。
 */

interface LogLine {
  event: string
  [key: string]: unknown
}

interface FakeChannelRecord {
  readonly appId: string
  readonly appSecret: string
  startCalls: number
  stopCalls: number
  /** start 成功后写入状态表的值；'none' 表示不写（保持预设值或未注册）。 */
  readonly afterStartState: ChannelState | 'none'
  /** 存在时 start() 等待其 resolve（驱动"启动尚未落定"的时序）。 */
  startGate?: Promise<void>
  /** 存在时 stop() 等待其 resolve（驱动"停止尚未落定/并发停止"的时序）。 */
  stopGate?: Promise<void>
}

/** 实例描述允许省略 enabled（默认 true）。 */
type InstanceInput = QQChannelInstance | { appId: string; appSecret: string }

interface HarnessOptions {
  instances?: readonly InstanceInput[]
  settleMs?: number
  /** 工厂 start 成功后写入的状态；'none' 表示不写（保持 connecting 等）。默认 online。 */
  startState?: ChannelState | 'none'
  /** 非 undefined 时工厂在构造阶段同步抛错（模拟注册/构造失败）。 */
  factoryError?: string
}

interface Harness {
  manager: ChannelManager
  core: GatewayCore
  logger: GatewayLogger
  factoryCalls: QQChannelOptions[]
  /** 每次工厂调用（= 每个渠道实例）一条记录，按创建顺序排列。 */
  records: FakeChannelRecord[]
  /** 每个 appId 的最新实例记录。 */
  channels: Map<string, FakeChannelRecord>
  stateMap: Map<string, ChannelState>
  failAppIds: Set<string>
  failStopAppIds: Set<string>
  logs: LogLine[]
  /** 让下一次工厂构造的实例 start() 等待给定闸门（模拟启动慢/挂起）。 */
  gateNextStart(gate: Promise<void>): void
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor: condition was not met before the timeout')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function normalizeInstances(instances: readonly InstanceInput[]): QQChannelInstance[] {
  return instances.map((instance) =>
    'enabled' in instance
      ? { appId: instance.appId, appSecret: instance.appSecret, enabled: instance.enabled }
      : { appId: instance.appId, appSecret: instance.appSecret, enabled: true },
  )
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const logs: LogLine[] = []
  const logger = createGatewayLogger({ debug: false, sink: (line) => logs.push(JSON.parse(line) as LogLine) })
  const factoryCalls: QQChannelOptions[] = []
  const records: FakeChannelRecord[] = []
  const channels = new Map<string, FakeChannelRecord>()
  const stateMap = new Map<string, ChannelState>()
  const failAppIds = new Set<string>()
  const failStopAppIds = new Set<string>()
  const afterStartState: ChannelState | 'none' = options.startState ?? 'online'
  let nextStartGate: Promise<void> | undefined

  const factory = (ctorOptions: QQChannelOptions): QQChannel => {
    if (options.factoryError !== undefined) {
      throw new Error(options.factoryError)
    }
    const record: FakeChannelRecord = {
      appId: ctorOptions.appId,
      appSecret: ctorOptions.appSecret,
      startCalls: 0,
      stopCalls: 0,
      afterStartState,
      startGate: nextStartGate,
    }
    nextStartGate = undefined
    factoryCalls.push(ctorOptions)
    records.push(record)
    channels.set(ctorOptions.appId, record)
    return {
      start: async () => {
        record.startCalls += 1
        if (record.startGate !== undefined) {
          await record.startGate
        }
        if (failAppIds.has(record.appId)) {
          throw new Error('registration rejected')
        }
        if (record.afterStartState !== 'none') {
          stateMap.set(record.appId, record.afterStartState)
        }
      },
      stop: async () => {
        record.stopCalls += 1
        if (record.stopGate !== undefined) {
          await record.stopGate
        }
        stateMap.delete(record.appId)
        if (failStopAppIds.has(record.appId)) {
          throw new Error('stop failed')
        }
      },
    }
  }

  const core = {} as GatewayCore
  const manager = createChannelManager({
    core,
    logger,
    limits: GATEWAY_LIMITS,
    factory,
    instances: normalizeInstances(options.instances ?? []),
    channelState: (appId) => stateMap.get(appId),
    settleMs: options.settleMs ?? 0,
  })

  return {
    manager,
    core,
    logger,
    factoryCalls,
    records,
    channels,
    stateMap,
    failAppIds,
    failStopAppIds,
    logs,
    gateNextStart: (gate) => {
      nextStartGate = gate
    },
  }
}

describe('channel manager: lifecycle', () => {
  it('starts an instance with the injected dependencies and reports the observed state', async () => {
    const h = makeHarness()

    const result = await h.manager.startInstance('app-1', 'secret-1')

    expect(result).toEqual({ state: 'online' })
    expect(h.records).toHaveLength(1)
    expect(h.records[0]).toMatchObject({ appId: 'app-1', appSecret: 'secret-1', startCalls: 1, stopCalls: 0 })
    // 工厂拿到 core 注册面、logger 与 limits（渠道适配器组装所需）。
    expect(h.factoryCalls[0]?.core).toBe(h.core)
    expect(h.factoryCalls[0]?.logger).toBe(h.logger)
    expect(h.factoryCalls[0]?.limits).toBe(GATEWAY_LIMITS)
    expect(JSON.stringify(h.logs)).not.toContain('secret-1')
  })

  it('reports connecting when no runtime state has been observed yet', async () => {
    const h = makeHarness({ startState: 'none' })

    const result = await h.manager.startInstance('app-1', 'secret-1')

    expect(result).toEqual({ state: 'connecting' })
  })

  it('restarts an instance by stopping the old one before starting the new one', async () => {
    const h = makeHarness()
    await h.manager.startInstance('app-1', 'old-secret')

    const result = await h.manager.startInstance('app-1', 'new-secret')

    expect(result).toEqual({ state: 'online' })
    expect(h.records).toHaveLength(2)
    expect(h.records[0]).toMatchObject({ appSecret: 'old-secret', startCalls: 1, stopCalls: 1 })
    expect(h.records[1]).toMatchObject({ appSecret: 'new-secret', startCalls: 1, stopCalls: 0 })
    expect(h.channels.get('app-1')?.appSecret).toBe('new-secret')
  })

  it('isolates start failures: logs manual_restart_required and allows a later retry', async () => {
    const h = makeHarness()
    h.failAppIds.add('app-1')

    const failed = await h.manager.startInstance('app-1', 'secret-1')

    expect(failed).toEqual({ state: 'blocked', startError: 'registration rejected' })
    expect(h.logs.some((line) => line.event === 'manual_restart_required' && line.appId === 'app-1')).toBe(true)
    expect(JSON.stringify(h.logs)).not.toContain('secret-1')
    // 失败实例被停止（经 channel.stop → ingress.disconnect）并从运行表移除。
    expect(h.channels.get('app-1')?.stopCalls).toBe(1)

    // 其他实例不受影响。
    await expect(h.manager.startInstance('app-2', 'secret-2')).resolves.toEqual({ state: 'online' })
    expect(h.channels.get('app-2')?.startCalls).toBe(1)

    // 修复后重跑：为同一 appId 替换启动一个新实例。
    h.failAppIds.delete('app-1')
    await expect(h.manager.startInstance('app-1', 'secret-1')).resolves.toEqual({ state: 'online' })
    expect(h.records.filter((record) => record.appId === 'app-1')).toHaveLength(2)
  })

  it('converges a synchronous factory throw into blocked instead of rejecting', async () => {
    const h = makeHarness({ factoryError: 'registration rejected at construction' })

    const result = await h.manager.startInstance('app-1', 'secret-1')

    expect(result).toEqual({ state: 'blocked', startError: 'registration rejected at construction' })
    expect(h.records).toHaveLength(0)
    expect(h.logs.some((line) => line.event === 'manual_restart_required')).toBe(true)
  })

  it('serializes concurrent operations on the same appId without interleaving start/stop', async () => {
    const h = makeHarness()
    const gate = deferred()
    h.gateNextStart(gate.promise)

    const first = h.manager.startInstance('app-1', 'secret-a')
    await waitFor(() => h.records.length === 1)
    const second = h.manager.startInstance('app-1', 'secret-b')
    // 第二个操作排在队列里：第一个启动未落定前不会构造第二个实例。
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.records).toHaveLength(1)

    gate.resolve()
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult).toEqual({ state: 'online' })
    expect(secondResult).toEqual({ state: 'online' })
    expect(h.records).toHaveLength(2)
    expect(h.records[0]).toMatchObject({ appSecret: 'secret-a', startCalls: 1, stopCalls: 1 })
    expect(h.records[1]).toMatchObject({ appSecret: 'secret-b', startCalls: 1, stopCalls: 0 })
  })

  it('syncInstances replaces the configured instance list used by ensureOnline', async () => {
    const h = makeHarness()
    expect(h.manager.listInstances()).toEqual([])

    h.manager.syncInstances([{ appId: 'app-1', appSecret: 'sync-secret', enabled: true }])
    expect(h.manager.listInstances()).toEqual([{ appId: 'app-1', appSecret: 'sync-secret', enabled: true }])

    const result = await h.manager.ensureOnline('app-1')
    expect(result.state).toBe('online')
    expect(h.records[0]?.appSecret).toBe('sync-secret')
  })
})

describe('channel manager: ensureOnline and waitForSettled', () => {
  it('is idempotent for an already-online instance and does not recreate it', async () => {
    const h = makeHarness()
    h.stateMap.set('app-1', 'online')

    const result = await h.manager.ensureOnline('app-1')

    expect(result).toEqual({ state: 'online' })
    expect(h.records).toHaveLength(0)
  })

  it('starts a configured instance with the saved credential and waits for settle', async () => {
    const h = makeHarness({ instances: [{ appId: 'app-1', appSecret: 'configured-secret' }] })

    const result = await h.manager.ensureOnline('app-1')

    expect(result).toEqual({ state: 'online' })
    expect(h.records[0]).toMatchObject({ appId: 'app-1', appSecret: 'configured-secret', startCalls: 1 })
  })

  it('returns blocked when the instance is missing from the config', async () => {
    const h = makeHarness()

    const result = await h.manager.ensureOnline('missing-app')

    expect(result).toEqual({ state: 'blocked', startError: 'instance is missing from the gateway config' })
    expect(h.records).toHaveLength(0)
  })

  it('waits until the observed state leaves connecting', async () => {
    const h = makeHarness({ settleMs: 1_500, startState: 'none' })
    h.stateMap.set('app-1', 'connecting')
    const timer = setTimeout(() => h.stateMap.set('app-1', 'online'), 100)

    try {
      await expect(h.manager.waitForSettled('app-1')).resolves.toBe('online')
    } finally {
      clearTimeout(timer)
    }
  })

  it('returns the last observed state when the settle window expires', async () => {
    const h = makeHarness({ settleMs: 0 })
    h.stateMap.set('app-1', 'connecting')

    await expect(h.manager.waitForSettled('app-1')).resolves.toBe('connecting')
    // 未注册实例没有观察值：沿用 connecting 兜底。
    await expect(h.manager.waitForSettled('unknown-app')).resolves.toBe('connecting')
  })
})

describe('channel manager: stopAll', () => {
  it('stops every running instance and only logs stop failures', async () => {
    const h = makeHarness()
    await h.manager.startInstance('app-1', 'secret-1')
    await h.manager.startInstance('app-2', 'secret-2')
    h.failStopAppIds.add('app-2')

    await expect(h.manager.stopAll()).resolves.toBeUndefined()

    expect(h.channels.get('app-1')?.stopCalls).toBe(1)
    expect(h.channels.get('app-2')?.stopCalls).toBe(1)
    expect(
      h.logs.some(
        (line) => line.event === 'state_warning' && String(line.reason).includes('channel stop threw'),
      ),
    ).toBe(true)

    // 运行表已清空：再次 stopAll 不重复停止（停止失败也不阻塞其他实例）。
    await h.manager.stopAll()
    expect(h.channels.get('app-1')?.stopCalls).toBe(1)
    expect(h.channels.get('app-2')?.stopCalls).toBe(1)
  })
})

describe('channel manager: shutdown gate', () => {
  it('blocks new starts immediately after beginShutdown: no queue, no factory, no instance touched', async () => {
    const h = makeHarness({ instances: [{ appId: 'app-1', appSecret: 'secret-1' }] })
    await h.manager.startInstance('app-1', 'secret-1')
    const startCalls = h.records[0]!.startCalls

    h.manager.beginShutdown()
    h.manager.beginShutdown() // 幂等

    const expected = { state: 'blocked', startError: SHUTDOWN_START_ERROR }
    await expect(h.manager.startInstance('app-1', 'secret-2')).resolves.toEqual(expected)
    // 已在线实例的 ensureOnline 也不报 online（停机后不再受理启动）。
    await expect(h.manager.ensureOnline('app-1')).resolves.toEqual(expected)

    expect(h.records).toHaveLength(1)
    expect(h.records[0]!.startCalls).toBe(startCalls)
    // 闸门本身不停止运行中的实例；运行实例由 stopAll 收尾。
    expect(h.records[0]!.stopCalls).toBe(0)
  })

  it('does not create instances for starts queued before beginShutdown (factory call count unchanged)', async () => {
    const h = makeHarness()
    const gate = deferred()
    h.gateNextStart(gate.promise)

    const first = h.manager.startInstance('app-1', 'secret-a')
    await waitFor(() => h.records.length === 1)
    const queued = h.manager.startInstance('app-1', 'secret-b')
    // 第二个启动停在串行队列里，尚未执行。
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.records).toHaveLength(1)

    h.manager.beginShutdown()
    // 停机后的新启动立即返回，不排在仍挂起中的第一个启动之后（若入队，此处会一直等待）。
    await expect(h.manager.startInstance('app-2', 'secret-late')).resolves.toEqual({
      state: 'blocked',
      startError: SHUTDOWN_START_ERROR,
    })
    gate.resolve()

    const [firstResult, queuedResult] = await Promise.all([first, queued])
    // 已开始执行的那个实例启动完成后被立即停机并收敛为 blocked；排队中的操作从未调工厂。
    expect(firstResult).toEqual({ state: 'blocked', startError: SHUTDOWN_START_ERROR })
    expect(queuedResult).toEqual({ state: 'blocked', startError: SHUTDOWN_START_ERROR })
    expect(h.records).toHaveLength(1)
    expect(h.records[0]).toMatchObject({ appSecret: 'secret-a', startCalls: 1, stopCalls: 1 })
  })

  it('returns the current state immediately for waitForSettled after shutdown', async () => {
    const h = makeHarness({ settleMs: 10_000 })
    h.stateMap.set('app-1', 'reconnecting')
    h.manager.beginShutdown()

    const startedAt = Date.now()
    await expect(h.manager.waitForSettled('app-1')).resolves.toBe('reconnecting')
    // 未注册实例在停机后按 blocked 收敛。
    await expect(h.manager.waitForSettled('unknown-app')).resolves.toBe('blocked')
    // 远小于 10s 的 settle 窗口：没有轮询等待。
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  it('returns the current state immediately when shutdown begins during a wait', async () => {
    const h = makeHarness({ settleMs: 5_000 })
    h.stateMap.set('app-1', 'connecting')

    const waiting = h.manager.waitForSettled('app-1')
    await new Promise((resolve) => setTimeout(resolve, 30))
    h.manager.beginShutdown()

    const startedAt = Date.now()
    await expect(waiting).resolves.toBe('connecting')
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })
})

describe('channel manager: stop/failure races', () => {
  it('stops an instance whose start settles after stopAll (final gate covers the concurrent stop)', async () => {
    const h = makeHarness()
    const gate = deferred()
    h.gateNextStart(gate.promise)

    const starting = h.manager.startInstance('app-1', 'secret-1')
    await waitFor(() => h.records.length === 1)
    h.manager.beginShutdown()
    // stopAll 在 start 仍挂起时停止并移除该实例。
    await h.manager.stopAll()
    const record = h.channels.get('app-1')!
    expect(record.stopCalls).toBe(1)
    expect(h.stateMap.has('app-1')).toBe(false)

    // 放行 start：其落定后 final gate 必须把这次尝试的实例再次收敛为停止。
    gate.resolve()
    await expect(starting).resolves.toEqual({ state: 'blocked', startError: SHUTDOWN_START_ERROR })
    expect(record.stopCalls).toBe(2)
    expect(h.stateMap.has('app-1')).toBe(false)

    // 运行表无该实例：再次 stopAll 不产生新的停止调用。
    const stopCalls = record.stopCalls
    await h.manager.stopAll()
    expect(record.stopCalls).toBe(stopCalls)
  })

  it('cleans up a failed start: the channel is stopped and not left in the runtime table', async () => {
    const h = makeHarness()
    h.failAppIds.add('app-1')

    const result = await h.manager.startInstance('app-1', 'secret-1')

    expect(result).toEqual({ state: 'blocked', startError: 'registration rejected' })
    const record = h.channels.get('app-1')!
    expect(record.startCalls).toBe(1)
    // 注册后抛错：catch 中经 channel.stop（→ ingress.disconnect）清理。
    expect(record.stopCalls).toBe(1)
    expect(h.stateMap.has('app-1')).toBe(false)
    // 运行表已清理：再次 stopAll 不会重复停止该失败实例。
    await h.manager.stopAll()
    expect(record.stopCalls).toBe(1)
  })

  it('makes concurrent stopAll calls wait for the same in-flight stop', async () => {
    const h = makeHarness()
    await h.manager.startInstance('app-1', 'secret-1')
    const record = h.channels.get('app-1')!
    const stopGate = deferred()
    record.stopGate = stopGate.promise

    const first = h.manager.stopAll()
    const second = h.manager.stopAll()
    // 第二次 stopAll 不得在首个停止未落定时提前返回。
    const outcome = await Promise.race([
      second.then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('still-pending'), 20)),
    ])
    expect(outcome).toBe('still-pending')

    stopGate.resolve()
    await Promise.all([first, second])
    // 两个 stopAll 共享同一 stop promise：channel.stop 只调用一次。
    expect(record.stopCalls).toBe(1)
    expect(h.stateMap.has('app-1')).toBe(false)
  })

  it('shares the in-flight stop when an instance start settles during stopAll', async () => {
    const h = makeHarness()
    const startGate = deferred()
    h.gateNextStart(startGate.promise)

    const starting = h.manager.startInstance('app-1', 'secret-1')
    await waitFor(() => h.records.length === 1)
    const record = h.channels.get('app-1')!
    const stopGate = deferred()
    record.stopGate = stopGate.promise
    h.manager.beginShutdown()

    const stopping = h.manager.stopAll()
    await waitFor(() => record.stopCalls === 1)
    // start 在 channel.stop 尚未落定时恢复：final gate 汇入同一 stop promise，不重复停止。
    startGate.resolve()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(record.stopCalls).toBe(1)

    stopGate.resolve()
    await expect(starting).resolves.toEqual({ state: 'blocked', startError: SHUTDOWN_START_ERROR })
    await stopping
    expect(record.stopCalls).toBe(1)
    expect(h.stateMap.has('app-1')).toBe(false)
  })
})
