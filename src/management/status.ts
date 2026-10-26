import type { QQChannelInstance } from '../config/schema.js'
import type { CoreQueries } from '../core/contracts.js'
import type { GatewayChannelStatus, GatewayStatus } from './contracts.js'

/**
 * 管理状态投影：把 core 运行快照与 ConfigStore 最新配置聚合成 `GatewayStatus`。
 *
 * 规则（沿用重构前健康表的合并语义）：
 * - 配置实例先行铺底：`enabled` 但未注册 → `blocked`，`disabled` 未注册 → `disabled`；
 * - 已注册实例的运行状态覆盖同名键；
 * - qq 类型配置与注册表皆空时给出一条类型级 `not_configured`；
 * - `ready = core ready && !store failed && 除 disabled/not_configured 外的实例全部 online`。
 *
 * 输出是脱敏的只读 DTO：不含 `appSecret`、内部 Map 或运行句柄；每次调用构造新对象，
 * `getStatus()` 与 `/readyz` 共用同一份计算。
 */

export interface StatusProjectionOptions {
  queries: CoreQueries
  /** ConfigStore 最新配置（`store.file.channels.qq`）；管理面保存后动态反映。 */
  currentQQInstances: () => readonly QQChannelInstance[]
}

export interface StatusProjection {
  getStatus(): GatewayStatus
}

/** 展示状态是否允许整体 ready：disabled/not_configured 不参与就绪判定。 */
function isReadyState(state: GatewayChannelStatus['state']): boolean {
  return state === 'online' || state === 'disabled' || state === 'not_configured'
}

export function createStatusProjection(options: StatusProjectionOptions): StatusProjection {
  const { queries, currentQQInstances } = options

  return {
    getStatus(): GatewayStatus {
      const snapshot = queries.snapshot()
      const channels: GatewayChannelStatus[] = []
      // 配置实例先行铺底；已注册同键实例用运行快照覆盖状态。
      const registered = new Map(
        snapshot.channels.map((channel) => [`${channel.channelId}:${channel.accountId}`, channel]),
      )
      const configuredKeys = new Set<string>()
      for (const instance of currentQQInstances()) {
        const key = `qq:${instance.appId}`
        configuredKeys.add(key)
        const runtime = registered.get(key)
        channels.push({
          channelId: 'qq',
          appId: instance.appId,
          configured: true,
          enabled: instance.enabled,
          state: runtime?.state ?? (instance.enabled ? 'blocked' : 'disabled'),
        })
      }
      const qqConfigured = configuredKeys.size > 0
      let qqRegistered = false
      for (const channel of snapshot.channels) {
        if (channel.channelId === 'qq') {
          qqRegistered = true
        }
        if (configuredKeys.has(`${channel.channelId}:${channel.accountId}`)) {
          // 同名键已由配置铺底项覆盖为运行状态，不重复输出。
          continue
        }
        channels.push({
          channelId: channel.channelId,
          appId: channel.accountId,
          configured: false,
          enabled: false,
          state: channel.state,
        })
      }
      if (!qqConfigured && !qqRegistered) {
        channels.push({ channelId: 'qq', configured: false, enabled: false, state: 'not_configured' })
      }

      const ready =
        snapshot.state === 'ready' &&
        !snapshot.stateStoreFailed &&
        channels.every((channel) => isReadyState(channel.state))

      return {
        coreState: snapshot.state,
        stateStoreFailed: snapshot.stateStoreFailed,
        startedAt: snapshot.startedAt,
        pending: snapshot.pending,
        running: snapshot.running,
        ready,
        channels,
      }
    },
  }
}