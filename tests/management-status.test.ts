import { describe, expect, it } from 'vitest'

import type { QQChannelInstance } from '../src/config/schema.js'
import type {
  ChannelRuntimeSnapshot,
  ChannelState,
  CoreQueries,
  CoreState,
} from '../src/core/contracts.js'
import { createStatusProjection } from '../src/management/status.js'

/**
 * 管理状态投影测试：用假 core 查询与可变配置清单验证合并规则、ready 判定与脱敏。
 * 不接触 store/manager/HTTP。
 */

interface ProjectionHarness {
  projection: ReturnType<typeof createStatusProjection>
  /** 可变输入：当前配置清单（模拟管理面保存后的最新配置）与假 core 快照。 */
  state: {
    current: QQChannelInstance[]
    snapshot: {
      state: CoreState
      stateStoreFailed: boolean
      startedAt: string
      pending: number
      running: number
      channels: ChannelRuntimeSnapshot[]
    }
  }
}

function makeHarness(options?: {
  configured?: readonly QQChannelInstance[]
  channels?: readonly ChannelRuntimeSnapshot[]
  state?: CoreState
  stateStoreFailed?: boolean
  startedAt?: string
  pending?: number
  running?: number
}): ProjectionHarness {
  const state: ProjectionHarness['state'] = {
    current: [...(options?.configured ?? [])],
    snapshot: {
      state: options?.state ?? ('ready' as CoreState),
      stateStoreFailed: options?.stateStoreFailed ?? false,
      startedAt: options?.startedAt ?? '2026-10-01T00:00:00.000Z',
      pending: options?.pending ?? 0,
      running: options?.running ?? 0,
      channels: [...(options?.channels ?? [])],
    },
  }
  const queries: CoreQueries = {
    snapshot: () => ({ ...state.snapshot, channels: [...state.snapshot.channels] }),
  }
  const projection = createStatusProjection({
    queries,
    currentQQInstances: () => state.current,
  })
  return { projection, state }
}

function channel(appId: string, enabled = true): QQChannelInstance {
  return { appId, appSecret: `secret-${appId}`, enabled }
}

function runtime(accountId: string, channelState: ChannelState): ChannelRuntimeSnapshot {
  return { channelId: 'qq', accountId, state: channelState }
}

describe('management status projection', () => {
  it('给零配置零注册的 qq 类型一条 not_configured 类型级条目，并映射 core 快照字段', () => {
    const h = makeHarness({ pending: 2, running: 1, startedAt: '2026-10-02T03:04:05.000Z' })

    const status = h.projection.getStatus()

    expect(status.channels).toEqual([
      { channelId: 'qq', configured: false, enabled: false, state: 'not_configured' },
    ])
    expect(status.coreState).toBe('ready')
    expect(status.stateStoreFailed).toBe(false)
    expect(status.startedAt).toBe('2026-10-02T03:04:05.000Z')
    expect(status.pending).toBe(2)
    expect(status.running).toBe(1)
    expect(status.ready).toBe(true)
  })

  it('配置实例先行铺底：enabled 未注册 → blocked，disabled 未注册 → disabled', () => {
    const h = makeHarness({
      configured: [channel('app-1', true), channel('app-2', false)],
    })

    expect(h.projection.getStatus().channels).toEqual([
      { channelId: 'qq', appId: 'app-1', configured: true, enabled: true, state: 'blocked' },
      { channelId: 'qq', appId: 'app-2', configured: true, enabled: false, state: 'disabled' },
    ])
    // enabled 未注册实例按 blocked 参与 ready → 整体未就绪。
    expect(h.projection.getStatus().ready).toBe(false)
    // 只有 disabled 实例时 ready 不受影响。
    h.state.current = [channel('app-2', false)]
    expect(h.projection.getStatus().ready).toBe(true)
  })

  it('已注册实例的运行状态覆盖同名配置项', () => {
    const h = makeHarness({
      configured: [channel('app-1', true), channel('app-2', false)],
      channels: [runtime('app-1', 'online'), runtime('app-2', 'online')],
    })

    const status = h.projection.getStatus()

    expect(status.channels).toEqual([
      { channelId: 'qq', appId: 'app-1', configured: true, enabled: true, state: 'online' },
      { channelId: 'qq', appId: 'app-2', configured: true, enabled: false, state: 'online' },
    ])
    expect(status.ready).toBe(true)
  })

  it('已注册但不在配置中的实例追加在配置项之后（configured:false、enabled:false）', () => {
    const h = makeHarness({
      configured: [channel('app-1')],
      channels: [runtime('app-9', 'reconnecting'), runtime('app-1', 'online')],
    })

    const status = h.projection.getStatus()

    expect(status.channels).toEqual([
      { channelId: 'qq', appId: 'app-1', configured: true, enabled: true, state: 'online' },
      { channelId: 'qq', appId: 'app-9', configured: false, enabled: false, state: 'reconnecting' },
    ])
    expect(status.ready).toBe(false)
  })

  it('有已注册实例但零配置时不输出 not_configured', () => {
    const h = makeHarness({ channels: [runtime('app-9', 'blocked')] })
    const status = h.projection.getStatus()
    expect(status.channels).toEqual([
      { channelId: 'qq', appId: 'app-9', configured: false, enabled: false, state: 'blocked' },
    ])
    expect(status.channels.some((item) => item.state === 'not_configured')).toBe(false)
  })

  it('ready 矩阵：core 非 ready、store failed、非 online 运行状态均使 ready 为 false', () => {
    // 全 online（含 disabled 配置项）→ ready。
    const h = makeHarness({
      configured: [channel('app-1'), channel('app-2', false)],
      channels: [runtime('app-1', 'online')],
    })
    expect(h.projection.getStatus().ready).toBe(true)

    // core 非 ready 的四个状态都不 ready。
    for (const state of ['starting', 'stopping', 'stopped', 'failed'] as const) {
      h.state.snapshot.state = state
      expect(h.projection.getStatus().ready, state).toBe(false)
    }
    h.state.snapshot.state = 'ready'

    // store failed 不 ready。
    h.state.snapshot.stateStoreFailed = true
    expect(h.projection.getStatus().ready).toBe(false)
    h.state.snapshot.stateStoreFailed = false

    // 任何非 online/disabled/not_configured 的运行状态都不 ready。
    for (const state of ['connecting', 'reconnecting', 'blocked'] as const) {
      h.state.snapshot.channels = [runtime('app-1', state)]
      expect(h.projection.getStatus().ready, state).toBe(false)
    }
  })

  it('每次调用读取最新配置并返回新的 DTO 与渠道数组', () => {
    const h = makeHarness({ configured: [channel('app-1')], channels: [runtime('app-1', 'online')] })

    const first = h.projection.getStatus()
    h.state.current = [channel('app-2', false)]
    h.state.snapshot.channels = []
    const second = h.projection.getStatus()

    expect(first.channels).toEqual([
      { channelId: 'qq', appId: 'app-1', configured: true, enabled: true, state: 'online' },
    ])
    expect(second.channels).toEqual([
      { channelId: 'qq', appId: 'app-2', configured: true, enabled: false, state: 'disabled' },
    ])
    expect(first).not.toBe(second)
    expect(first.channels).not.toBe(second.channels)
    expect(first.channels[0]).not.toBe(second.channels[0])
  })

  it('脱敏：结果只含公开字段，不泄漏 appSecret', () => {
    const secret = 'top-secret-value'
    const h = makeHarness({
      configured: [{ appId: 'app-1', appSecret: secret, enabled: true }],
      channels: [runtime('app-1', 'online')],
    })

    const status = h.projection.getStatus()
    const serialized = JSON.stringify(status)

    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('appSecret')
    expect(Object.keys(status.channels[0]!).sort()).toEqual(
      ['appId', 'channelId', 'configured', 'enabled', 'state'].sort(),
    )
  })
})