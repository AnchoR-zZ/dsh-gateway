import type { QQChannelInstance } from './config.js'
import type { GATEWAY_LIMITS, GatewayCore } from './contracts.js'
import type { ChannelHealthState } from './core/lifecycle.js'
import type { GatewayLogger } from './logging.js'
import type { QQChannel, QQChannelOptions } from './qq/index.js'

/**
 * channel 实例管理器：维护"配置实例清单"与"运行中的 QQ 渠道实例"两张表，服务于冷启动
 * 按实例拉起、管理路由的添加/启用与进程停止。实例标识为 `appId`；启动失败的实例不进运行
 * 表（配置里 enabled 未注册，健康表回落 `blocked`），不影响其他实例。
 *
 * 本模块不导入 QQ SDK 运行时（QQ 适配器由插件入口注入工厂）；对同一 `appId` 的操作串行
 * 化，避免并发管理请求交叉停止/启动。
 */

/** QQ 渠道实例工厂；正式入口注入 `createQQChannel`，测试注入替身。 */
export type QQChannelFactory = (options: QQChannelOptions) => QQChannel

/** admin 响应等待实例离开 `connecting` 的默认窗口（毫秒）。 */
export const CHANNEL_START_SETTLE_MS = 3_000

const CHANNEL_STATE_POLL_MS = 25

interface InstanceRuntime {
  readonly appId: string
  readonly channel: QQChannel
}

export interface ChannelManagerOptions {
  core: GatewayCore
  logger: GatewayLogger
  limits: typeof GATEWAY_LIMITS
  factory: QQChannelFactory
  /** 启动时的配置实例清单（含 disabled 实例）。 */
  instances: readonly QQChannelInstance[]
  /** 读取某实例当前健康状态（来自 core 健康快照的 `qq:<appId>` 键）。 */
  channelState: (appId: string) => ChannelHealthState | undefined
  /** admin 响应前等待状态离开 `connecting` 的窗口；默认 CHANNEL_START_SETTLE_MS。 */
  settleMs?: number
}

export interface InstanceStartResult {
  /** 响应时观察到的实例状态；启动失败恒为 `blocked`。 */
  state: ChannelHealthState
  /** 启动抛错时的说明（凭证已保存，实例置 blocked）；成功时缺省。 */
  startError?: string
}

export interface ChannelManager {
  /** 当前配置实例清单（最近一次保存后的视图）。 */
  listInstances(): readonly QQChannelInstance[]
  /** 管理面保存配置后同步最新清单（健康展示的 disabled/not_configured 来源）。 */
  syncInstances(next: readonly QQChannelInstance[]): void
  /** 停旧实例（如存在）→ 用给定凭证建新实例并启动；失败只影响该实例。 */
  startInstance(appId: string, appSecret: string): Promise<InstanceStartResult>
  /** 已在线为幂等成功；否则按当前配置凭证 startInstance 并等待离开 connecting。 */
  ensureOnline(appId: string): Promise<InstanceStartResult>
  /** 等待实例状态离开 `connecting`（admin 响应用）；超窗返回当前观察值。 */
  waitForSettled(appId: string): Promise<ChannelHealthState>
  /** 停止全部运行中的实例（进程停止链用）；尽力而为，逐个记录失败。 */
  stopAll(): Promise<void>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createChannelManager(options: ChannelManagerOptions): ChannelManager {
  const { core, logger, limits, factory } = options
  const settleMs: number = options.settleMs ?? CHANNEL_START_SETTLE_MS
  let instances: readonly QQChannelInstance[] = options.instances
  const runtimes = new Map<string, InstanceRuntime>()
  /** 同一 appId 的管理操作串行化；键恒存在以简化链式拼接。 */
  const opTails = new Map<string, Promise<unknown>>()

  function serialize<T>(appId: string, op: () => Promise<T>): Promise<T> {
    const tail = opTails.get(appId) ?? Promise.resolve()
    const next = tail.catch(() => undefined).then(op)
    opTails.set(appId, next)
    return next
  }

  function listInstances(): readonly QQChannelInstance[] {
    return instances
  }

  function syncInstances(next: readonly QQChannelInstance[]): void {
    instances = next
  }

  async function stopRuntime(appId: string, reason: string): Promise<void> {
    const runtime = runtimes.get(appId)
    if (runtime === undefined) {
      return
    }
    runtimes.delete(appId)
    try {
      await runtime.channel.stop()
    } catch (err) {
      logger.logEvent('state_warning', {
        channelId: 'qq',
        appId,
        reason: `${reason}: channel stop threw: ${errorMessage(err)}`,
      })
    }
  }

  async function startInstanceInternal(appId: string, appSecret: string): Promise<InstanceStartResult> {
    await stopRuntime(appId, 'channel restart')
    try {
      // 工厂构造也在 try 内：同步抛错与注册失败、SDK 启动失败同样收敛为 blocked 结果对象
      // （记 manual_restart_required），startInstance 不因此 reject。
      const channel = factory({ appId, appSecret, core, logger, limits })
      runtimes.set(appId, { appId, channel })
      await channel.start()
    } catch (err) {
      const startError = errorMessage(err)
      logger.logEvent('manual_restart_required', {
        channelId: 'qq',
        appId,
        reason: `channel instance failed to start: ${startError}`,
      })
      return { state: 'blocked', startError }
    }
    return { state: options.channelState(appId) ?? 'connecting' }
  }

  async function waitForSettled(appId: string): Promise<ChannelHealthState> {
    const deadline = Date.now() + settleMs
    for (;;) {
      const state = options.channelState(appId)
      if (state !== undefined && state !== 'connecting') {
        return state
      }
      if (Date.now() >= deadline) {
        return state ?? 'connecting'
      }
      await new Promise((resolve) => setTimeout(resolve, CHANNEL_STATE_POLL_MS))
    }
  }

  async function ensureOnlineInternal(appId: string): Promise<InstanceStartResult> {
    if (options.channelState(appId) === 'online') {
      return { state: 'online' }
    }
    const instance = instances.find((item) => item.appId === appId)
    if (instance === undefined) {
      return { state: 'blocked', startError: 'instance is missing from the gateway config' }
    }
    const started = await startInstanceInternal(appId, instance.appSecret)
    if (started.startError !== undefined) {
      return started
    }
    return { state: await waitForSettled(appId) }
  }

  function startInstance(appId: string, appSecret: string): Promise<InstanceStartResult> {
    return serialize(appId, () => startInstanceInternal(appId, appSecret))
  }

  function ensureOnline(appId: string): Promise<InstanceStartResult> {
    return serialize(appId, () => ensureOnlineInternal(appId))
  }

  async function stopAll(): Promise<void> {
    // 有意绕过按 appId 的串行队列：本函数只在进程停止链调用，且调用前插件入口已摘除管理
    // 路由（新管理请求一律 404）；即便与已在执行中的管理请求理论交错，进程即将退出，无实际
    // 后果。
    await Promise.allSettled([...runtimes.keys()].map((appId) => stopRuntime(appId, 'gateway stop')))
  }

  return {
    listInstances,
    syncInstances,
    startInstance,
    ensureOnline,
    waitForSettled,
    stopAll,
  }
}
