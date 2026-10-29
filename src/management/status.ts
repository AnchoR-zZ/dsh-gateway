import type { QQChannelInstance, WeixinChannelInstance } from '../config/schema.js'
import type { CoreQueries } from '../core/contracts.js'
import type { GatewayChannelStatus, GatewayStatus } from './contracts.js'

/**
 * 管理状态投影：把 core 运行快照与 ConfigStore 最新配置聚合成 `GatewayStatus`。
 *
 * 规则（沿用重构前健康表的合并语义）：
 * - 配置实例先行铺底，qq 与 weixin 同规则：`enabled` 但未注册 → `blocked`，`disabled` 未注册 → `disabled`；
 * - 已注册实例的运行状态覆盖同名键，qq 键为 `qq:<appId>`，weixin 键为 `weixin:<botId>`；
 * - 两类条目结构相同，都只有 `channelId`/`appId`/`configured`/`enabled`/`state`，微信实例的 `botId` 落在 `appId` 字段；
 * - qq 类型配置与注册表皆空时给出一条类型级 `not_configured`；weixin 没有类型级条目，未配置且未注册时无条目；
 * - `ready = core ready && !store failed && 除 disabled/not_configured 外的实例全部 online`。
 *
 * 输出是脱敏的只读 DTO：不含 `appSecret`/`botToken`、内部 Map 或运行句柄；每次调用构造新对象，
 * `getStatus()` 与 `/readyz` 共用同一份计算。
 */

export interface StatusProjectionOptions {
  queries: CoreQueries
  /** ConfigStore 最新配置（`store.file.channels.qq`）；管理面保存后动态反映。 */
  currentQQInstances: () => readonly QQChannelInstance[]
  /** ConfigStore 最新配置（`store.file.channels.weixin`，旧配置可缺省）；不提供时不派生微信的配置条目。 */
  currentWeixinInstances?: () => readonly WeixinChannelInstance[]
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
      // 键在微信循环之前收集，因此这里只表示 qq 是否已配置。
      const qqConfigured = configuredKeys.size > 0
      const weixinInstances = options.currentWeixinInstances?.()
      for (const instance of weixinInstances ?? []) {
        const key = `weixin:${instance.botId}`
        configuredKeys.add(key)
        channels.push({ channelId: 'weixin', appId: instance.botId, configured: true, enabled: instance.enabled,
          state: registered.get(key)?.state ?? (instance.enabled ? 'blocked' : 'disabled') })
      }
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
