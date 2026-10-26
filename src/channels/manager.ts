import type { QQChannelInstance } from '../config/schema.js'
import type { GATEWAY_LIMITS, GatewayCore } from '../contracts.js'
import type { ChannelState } from '../core/contracts.js'
import type { GatewayLogger } from '../logging.js'
import type { QQChannel, QQChannelOptions } from './qq/index.js'

/**
 * channel 实例管理器：维护"配置实例清单"与"运行中的 QQ 渠道实例"两张表，服务于冷启动
 * 按实例拉起、管理路由的添加/启用与进程停止。实例标识为 `appId`；启动失败只影响该实例
 * （记 manual_restart_required，停止该实例并从运行表移除，健康表回落 `blocked`），不影响
 * 其他实例。
 *
 * 本模块不导入 QQ SDK 运行时（QQ 适配器由插件入口注入工厂）；对同一 `appId` 的操作串行
 * 化，避免并发管理请求交叉停止/启动。
 *
 * 进程停止链先调用 `beginShutdown()` 设置停机闸门：之后 `startInstance`/`ensureOnline`
 * 立即返回 blocked（不入队、不调工厂、不触碰任何实例），停机前已排队但尚未执行的操作在
 * 真正执行时同样放弃，迟到的 `waitForSettled` 直接返回当前观察值——停机窗口内不再创建
 * 实例。运行中的实例统一由 `stopAll()` 收尾：每个实例的 `channel.stop` 落定后才移出运行
 * 表，`stopAll()` 也只会在全部停止落定后 resolve。
 */

/** QQ 渠道实例工厂；正式入口注入 `createQQChannel`，测试注入替身。 */
export type QQChannelFactory = (options: QQChannelOptions) => QQChannel

/** admin 响应等待实例离开 `connecting` 的默认窗口（毫秒）。 */
export const CHANNEL_START_SETTLE_MS = 3_000

const CHANNEL_STATE_POLL_MS = 25

/** 停机闸门拦截启动时的固定 startError；管理面与测试复用该常量，不重复字面量。 */
export const SHUTDOWN_START_ERROR = 'the gateway is shutting down; the channel instance was not started'

interface InstanceRuntime {
  readonly appId: string
  readonly channel: QQChannel
  /** 该实例的停止 promise：并发停止共享同一份，条目保留到其落定后才移出运行表。 */
  stopPromise?: Promise<void>
}

export interface ChannelManagerOptions {
  core: GatewayCore
  logger: GatewayLogger
  limits: typeof GATEWAY_LIMITS
  factory: QQChannelFactory
  /** 启动时的配置实例清单（含 disabled 实例）。 */
  instances: readonly QQChannelInstance[]
  /** 读取某实例当前运行状态（core 运行快照中的已注册渠道）；未注册时 undefined。 */
  channelState: (appId: string) => ChannelState | undefined
  /** admin 响应前等待状态离开 `connecting` 的窗口；默认 CHANNEL_START_SETTLE_MS。 */
  settleMs?: number
}

export interface InstanceStartResult {
  /** 响应时观察到的实例状态；启动失败或被停机闸门拦截时恒为 `blocked`。 */
  readonly state: ChannelState
  /** 启动抛错或被停机闸门拦截时的说明（凭证/配置已保存，实例置 blocked）；成功时缺省。 */
  readonly startError?: string
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
  waitForSettled(appId: string): Promise<ChannelState>
  /** 设置停机闸门：之后（含已排队的）启动不再创建实例；幂等。 */
  beginShutdown(): void
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
  /** 停机闸门；置位后不再创建实例，重复置位为 no-op。 */
  let shuttingDown = false

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

  /** 停机闸门拦截结果；管理面据 startError 判定"saved + blocked"而不重试。 */
  function shutdownBlocked(): InstanceStartResult {
    return { state: 'blocked', startError: SHUTDOWN_START_ERROR }
  }

  /**
   * 停止某实例并把它移出运行表。条目保留到 `channel.stop` 落定之后才删除：期间的并发停止
   * （第二次 `stopAll`、替换启动）共享同一 stop promise，不会提前返回；启动的 final gate
   * 也能借此确认该实例确实已停。`channel.stop` 幂等，重复调用安全。
   */
  function stopRuntime(appId: string, reason: string): Promise<void> {
    const runtime = runtimes.get(appId)
    if (runtime === undefined) {
      return Promise.resolve()
    }
    runtime.stopPromise ??= (async (): Promise<void> => {
      try {
        await runtime.channel.stop()
      } catch (err) {
        logger.logEvent('state_warning', {
          channelId: 'qq',
          appId,
          reason: `${reason}: channel stop threw: ${errorMessage(err)}`,
        })
      } finally {
        // 只删除本次停止的对象，避免误删随后替换出的新实例（同 appId 串行，正常不会发生）。
        if (runtimes.get(appId) === runtime) {
          runtimes.delete(appId)
        }
      }
    })()
    return runtime.stopPromise
  }

  /**
   * 停止本次启动尝试创建的实例。条目仍在运行表时走共享 stop promise；条目已被并发
   * `stopAll` 移除（其停止已落定）时再对本次创建的 channel 调一次 stop：若并发 stop 先于
   * `start()` 落定，只有 `start()` 之后的这次 stop 才能保证实例终态（`channel.stop` 幂等）。
   */
  async function stopAttemptedChannel(
    appId: string,
    channel: QQChannel | undefined,
    reason: string,
  ): Promise<void> {
    if (channel === undefined) {
      return
    }
    const current = runtimes.get(appId)
    if (current !== undefined && current.channel === channel) {
      await stopRuntime(appId, reason)
      return
    }
    try {
      await channel.stop()
    } catch (err) {
      logger.logEvent('state_warning', {
        channelId: 'qq',
        appId,
        reason: `${reason}: channel stop threw: ${errorMessage(err)}`,
      })
    }
  }

  async function startInstanceInternal(appId: string, appSecret: string): Promise<InstanceStartResult> {
    // 排队操作的执行期闸门：停机前排入、停机后才轮到的不再创建实例。
    if (shuttingDown) {
      return shutdownBlocked()
    }
    await stopRuntime(appId, 'channel restart')
    // 停旧与起新之间进入停机：旧实例已停，不再创建新实例（停止链随后收尾）。
    if (shuttingDown) {
      return shutdownBlocked()
    }
    let channel: QQChannel | undefined
    try {
      // 工厂构造也在 try 内：同步抛错与注册失败、SDK 启动失败同样收敛为 blocked 结果对象
      // （记 manual_restart_required），startInstance 不因此 reject。
      channel = factory({ appId, appSecret, core, logger, limits })
      runtimes.set(appId, { appId, channel })
      await channel.start()
    } catch (err) {
      const startError = errorMessage(err)
      logger.logEvent('manual_restart_required', {
        channelId: 'qq',
        appId,
        reason: `channel instance failed to start: ${startError}`,
      })
      // 启动失败即本实例终局：停止它（QQChannel.stop 经 ingress.disconnect 注销可能已部分
      // 完成的注册）并从运行表移除，失败实例不进运行表。工厂同步抛错时没有实例可停。
      await stopAttemptedChannel(appId, channel, 'channel start failure')
      return { state: 'blocked', startError }
    }
    // 启动期间进入停机：确保这次尝试创建的实例已停——并发 stopAll 的 stop 可能先于
    // start() 落定，仅靠它不足以覆盖 start 之后的状态。
    if (shuttingDown) {
      await stopAttemptedChannel(appId, channel, 'gateway stop')
      return shutdownBlocked()
    }
    return { state: options.channelState(appId) ?? 'connecting' }
  }

  async function waitForSettled(appId: string): Promise<ChannelState> {
    const observed = (): ChannelState | undefined => options.channelState(appId)
    // 停机后不再有状态迁移：迟到的等待立即返回当前观察值（未注册实例按 blocked 收敛）。
    if (shuttingDown) {
      return observed() ?? 'blocked'
    }
    const deadline = Date.now() + settleMs
    for (;;) {
      const state = observed()
      if (state !== undefined && state !== 'connecting') {
        return state
      }
      // 等待期间进入停机：同样立即返回当前状态，不再轮询到窗口结束。
      if (shuttingDown) {
        return state ?? 'blocked'
      }
      if (Date.now() >= deadline) {
        return state ?? 'connecting'
      }
      await new Promise((resolve) => setTimeout(resolve, CHANNEL_STATE_POLL_MS))
    }
  }

  async function ensureOnlineInternal(appId: string): Promise<InstanceStartResult> {
    // 排队操作的执行期闸门：停机后才轮到的不再启动（已在线实例也不报 online）。
    if (shuttingDown) {
      return shutdownBlocked()
    }
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
    // 闸门先于队列：停机后立即返回，不占用串行队列、不触碰任何实例。
    if (shuttingDown) {
      return Promise.resolve(shutdownBlocked())
    }
    return serialize(appId, () => startInstanceInternal(appId, appSecret))
  }

  function ensureOnline(appId: string): Promise<InstanceStartResult> {
    if (shuttingDown) {
      return Promise.resolve(shutdownBlocked())
    }
    return serialize(appId, () => ensureOnlineInternal(appId))
  }

  function beginShutdown(): void {
    shuttingDown = true
  }

  async function stopAll(): Promise<void> {
    // 有意绕过按 appId 的串行队列：本函数只在进程停止链调用（此前 shutdown 闸门已封闭
    // 新的启动、管理面已停止受理）。运行表条目保留到各自 channel.stop 落定后才移除，故本
    // 函数返回时全部通道已停止；并发 stopAll/替换启动共享同一 stop promise，不会提前返回。
    // 与已在执行中的管理请求理论交错时进程即将退出，无实际后果。
    await Promise.allSettled([...runtimes.keys()].map((appId) => stopRuntime(appId, 'gateway stop')))
  }

  return {
    listInstances,
    syncInstances,
    startInstance,
    ensureOnline,
    waitForSettled,
    beginShutdown,
    stopAll,
  }
}
