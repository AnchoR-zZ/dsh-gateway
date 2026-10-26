import type { Context } from '@deepseek-ai/cordis'

import pkg from '../package.json' with { type: 'json' }
import { createChannelManager } from './channels/manager.js'
import type { QQChannelFactory } from './channels/manager.js'
import { createQQChannel } from './channels/qq/index.js'
import { createQQTokenValidator } from './channels/qq/token.js'
import type { QQCredentialValidator } from './channels/qq/token.js'
import { resolveGatewayWorkspace, GATEWAY_CONFIG_SCHEMA_VERSION } from './config/schema.js'
import type { GatewayConfig } from './config/schema.js'
import { loadGatewayConfigStore } from './config/store.js'
import type { GatewayConfigStore } from './config/store.js'
import { GATEWAY_LIMITS } from './contracts.js'
import { createGatewayCore } from './core/index.js'
import { createScheduler } from './core/scheduler.js'
import { createSessionManager } from './core/session-manager.js'
import { SCHEMA_VERSION, createStateStore } from './core/state-store.js'
import { createTurnRunner } from './core/turn-runner.js'
import { createAgentHost, resolveDshHomeForConfig } from './host/dsh.js'
import { createHttpRoutes } from './http/routes.js'
import { createHttpServer } from './http/server.js'
import { createGatewayLogger } from './logging.js'
import { createManagementService } from './management/service.js'
import { createStatusProjection } from './management/status.js'

/**
 * runtime：进程内唯一总装与生命周期协调者。
 *
 * 组装在 apply 返回前同步完成（构造器不做 I/O；配置/组装错误直接 throw 使插件加载失败）。
 * ctx.effect 内后台启动，并按严格顺序停止；启动与停止环节的失败只记录日志并尽力清理已
 * 创建资源，不向 apply 抛错（宿主可恢复窗口内 readiness 不可用，进程不退出）。
 *
 * 启动：绑定本机 HTTP 监听（端口占用=单实例保护）→ core 就绪 → 按配置顺序冷启动 enabled
 * 实例。启动与停止互相串行化：停机闸门置位后，启动在下一个检查点静默退出；disposer 在
 * 关闭监听前先等待启动收敛，因此不会出现"disposer 已返回、监听才出现"的迟到绑定。
 * 停止：关闭管理写入入口 → 置停机标记 → 封闭新的实例启动 → 总预算内并行等待启动收敛 /
 * 管理在途操作落定 / core 停止 / 全部实例停止（任一超预算记 manual_restart_required）→
 * 最后关闭 HTTP（停止进行中探针仍可观察）。
 */

/** 宿主日志命名（与插件 name 一致；本模块不 import index 以免形成环）。 */
const LOGGER_NAME = 'dsh-gateway'

/** 宿主接入层的可测接缝（正式入口不传）：HTTP 监听、QQ 渠道工厂、凭证校验与日志 sink。 */
export interface GatewayLaunchOptions {
  /** 本机 HTTP 监听注入（默认 127.0.0.1:17890）；测试用 port 0 探测随机端口。 */
  http?: { host?: string; port?: number }
  /** QQ 渠道工厂（测试替身避免真实网络）；缺省用真实 createQQChannel。 */
  createQQChannelAdapter?: QQChannelFactory
  /** QQ 凭证在线校验（管理路由 add 用；测试替身避免真实网络）。 */
  validateQQCredentials?: QQCredentialValidator
  /** 结构化日志 sink（默认逐行 stdout）；测试捕获启动摘要与失败事件。 */
  loggerSink?: (line: string) => void
  /**
   * 停止总预算注入（毫秒）；缺省 `GATEWAY_LIMITS.CORE_SHUTDOWN_BUDGET_MS`。测试用极小预算
   * 驱动"预算耗尽记 manual_restart_required"的路径。
   */
  shutdownBudgetMs?: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 组装并后台启动网关。env 由调用方注入（正式入口固定 process.env），只用于解析
 * `DSH_GATEWAY_WORKSPACE`；其余配置从 workspace 内的 gateway.config.json 读取。
 */
export function launchGateway(
  ctx: Context,
  env: Record<string, string | undefined>,
  options?: GatewayLaunchOptions,
): void {
  let gatewayConfig: GatewayConfig
  let configStore: GatewayConfigStore
  try {
    const dshHome = resolveDshHomeForConfig(ctx)
    const workspaceDir = resolveGatewayWorkspace(env)
    const loaded = loadGatewayConfigStore({ workspaceDir, dshHome })
    gatewayConfig = loaded.config
    configStore = loaded
  } catch (err) {
    // GatewayConfigError 的 message 只含字段/路径与原因、不含值；rethrow 使插件加载失败，
    // dsh 终止。
    ctx.logger(LOGGER_NAME).error(`gateway configuration rejected: ${errorMessage(err)}`)
    throw err
  }
  const logger = createGatewayLogger({ debug: gatewayConfig.debug, sink: options?.loggerSink })

  if (configStore.createdTemplate) {
    logger.logEvent('config_template_created', {
      reason: `created a template at ${configStore.configPath}; add a bot via POST /channels/qq or by editing channels.qq and restarting`,
    })
  }
  if (configStore.migratedFromV1) {
    logger.logEvent('config_migrated', {
      reason: `migrated ${configStore.configPath} from schemaVersion 1 to 2`,
    })
  }

  const { host, eventsFor } = createAgentHost(ctx)

  // 启动摘要（14 节）：版本、映射/配置 schema、provider/model 与有效策略；不 dump 环境或完整配置。
  const selection = host.currentModelSelection()
  logger.logEvent('startup_summary', {
    version: pkg.version,
    schemaVersion: SCHEMA_VERSION,
    configSchemaVersion: GATEWAY_CONFIG_SCHEMA_VERSION,
    provider: selection.provider,
    model: selection.model,
    policy: 'approval=never; sandbox=workspace-write; cwd=<workspaceRoot>/<bindingId>',
    maxConcurrent: gatewayConfig.maxConcurrent,
    maxLiveAgents: gatewayConfig.maxLiveAgents,
  })

  const stateStore = createStateStore({ stateDir: gatewayConfig.stateDir, limits: GATEWAY_LIMITS, logger })
  const runner = createTurnRunner({ host, eventsFor, limits: GATEWAY_LIMITS, logger })
  const sessions = createSessionManager({
    host,
    store: stateStore,
    workspaceRoot: gatewayConfig.workspaceRoot,
    config: {
      idleAgentTtlMs: gatewayConfig.idleAgentTtlMs,
      maxLiveAgents: gatewayConfig.maxLiveAgents,
      maxConcurrent: gatewayConfig.maxConcurrent,
    },
    limits: GATEWAY_LIMITS,
    logger,
  })
  const core = createGatewayCore({
    limits: GATEWAY_LIMITS,
    logger,
    store: stateStore,
    createScheduler: (callbacks) =>
      createScheduler({
        config: {
          maxConcurrent: gatewayConfig.maxConcurrent,
          maxPendingPerPeer: gatewayConfig.maxPendingPerPeer,
          maxPendingTotal: gatewayConfig.maxPendingTotal,
          maxPendingBytes: gatewayConfig.maxPendingBytes,
        },
        limits: GATEWAY_LIMITS,
        logger,
        callbacks,
      }),
    sessions,
    runner,
  })

  /** 读取某实例的运行状态（core 快照的已注册渠道表；未注册时 undefined）。 */
  function channelState(appId: string) {
    return core.query
      .snapshot()
      .channels.find((channel) => channel.channelId === 'qq' && channel.accountId === appId)?.state
  }

  const manager = createChannelManager({
    core: core.ingress,
    logger,
    limits: GATEWAY_LIMITS,
    factory: options?.createQQChannelAdapter ?? createQQChannel,
    instances: gatewayConfig.qqInstances,
    channelState,
  })

  const status = createStatusProjection({
    queries: core.query,
    currentQQInstances: () => configStore.file.channels.qq,
  })
  const management = createManagementService({
    logger,
    store: configStore,
    manager,
    status,
    validateQQCredentials: options?.validateQQCredentials ?? createQQTokenValidator(),
    coreState: () => core.query.snapshot().state,
  })
  const routes = createHttpRoutes({ management, logger })
  const http = createHttpServer({
    host: options?.http?.host,
    port: options?.http?.port,
    logger,
    handle: routes,
  })

  /**
   * 启停串行化状态：
   * - `stopping`：停机标记；启动检查点与冷启动循环看到后静默退出。
   * - `startupPromise`：effect 注册时同步创建的启动任务；停止链在关监听前有界等待它收敛。
   * - `stopPromise`：幂等 disposer 共享的停止任务。
   */
  let stopping = false
  let startupPromise: Promise<void> | undefined
  let stopPromise: Promise<void> | undefined

  /** 清理步骤尽力而为：失败只记 state_warning，不向调用方抛错（停止链不被单步失败中断）。 */
  async function bestEffort(step: () => Promise<void>, reason: string): Promise<void> {
    try {
      await step()
    } catch (err) {
      logger.logEvent('state_warning', { reason: `${reason}: ${errorMessage(err)}` })
    }
  }

  /**
   * 进入停机闸门（正常停止与启动失败回滚共用，幂等）：关闭管理写入入口 → 置停机标记 →
   * 封闭新的实例启动。回滚也走这里，避免启动失败后管理面继续写配置或拉起实例。
   */
  function enterShutdown(): void {
    // 1. 关闭管理写入入口：在途管理操作在下一个检查点中止。
    management.beginShutdown()
    // 2. 置停机标记：启动检查点与冷启动循环看到后静默退出。
    stopping = true
    // 3. 封闭新的实例启动（含排队中的管理触发启动）。
    manager.beginShutdown()
  }

  /** 启动失败回滚：先进入停机闸门，再尽力释放已创建资源；不抛回 apply。 */
  async function rollbackStartup(): Promise<void> {
    enterShutdown()
    await bestEffort(() => core.lifecycle.stop(), 'core stop after startup failure threw')
    await bestEffort(() => manager.stopAll(), 'channel stop after startup failure threw')
    await bestEffort(() => http.close(), 'http close after startup failure threw')
  }

  /**
   * 冷启动：按启动配置顺序拉起 enabled 实例。每轮读管理器最新视图（等待期间管理面可能已
   * 更新 secret/enabled 或已拉起同 appId），跳过 disabled 与已在线实例；单实例失败由
   * ChannelManager 记 manual_restart_required 并置 blocked，循环继续。
   */
  async function startEnabledInstances(): Promise<void> {
    for (const startupInstance of gatewayConfig.qqInstances) {
      if (stopping) {
        return
      }
      const current = manager.listInstances().find((instance) => instance.appId === startupInstance.appId)
      if (current === undefined || !current.enabled) {
        continue
      }
      // 已在线则幂等跳过（如循环等待期间管理面已拉起该实例），避免对在线实例停旧起新。
      if (channelState(current.appId) === 'online') {
        continue
      }
      await manager.startInstance(current.appId, current.appSecret)
    }
  }

  /**
   * 启动任务：HTTP 绑定 → core 就绪 → 冷启动。每个 await 之后检查停机标记，停机则静默
   * 退出（资源清理由停止链负责）；仅非停机原因导致的失败才记 manual_restart_required
   * 并回滚。
   */
  async function start(): Promise<void> {
    try {
      // 先绑定回环端口：端口占用即单实例保护，失败时 core 不启动。
      await http.start()
      if (stopping) {
        return
      }
      await core.lifecycle.start()
      if (stopping) {
        // 停机与 core 启动并发：core 在停止后静默返回/拒绝启动属预期；不再拉起实例，
        // 已创建资源统一由停止链清理。
        return
      }
      await startEnabledInstances()
    } catch (err) {
      // 停机引发的启动拒绝属预期（core.stop 可能已清掉资源），不记失败日志、不重复回滚。
      if (stopping) {
        return
      }
      // 异步启动失败不能 throw 进已返回的 apply：回滚已创建资源并提示手动重启。
      logger.logEvent('manual_restart_required', {
        reason: `gateway startup failed: ${errorMessage(err)}`,
      })
      await rollbackStartup()
    }
  }

  async function stop(): Promise<void> {
    // 1-3. 进入停机闸门：管理写入入口关闭 → 停机标记 → 实例启动封闭（与回滚共用）。
    enterShutdown()

    // 4. 总预算内并行等待：启动收敛、管理在途操作落定、core 停止与全部实例停止。
    const budgetMs = options?.shutdownBudgetMs ?? GATEWAY_LIMITS.CORE_SHUTDOWN_BUDGET_MS
    const deadline = Date.now() + budgetMs
    let managementConverged = true
    const settle = Promise.allSettled([
      // 启动可能仍在 http.start()/core.start()/冷启动中：先等它收敛（异常已在 start 内处理）。
      (startupPromise ?? Promise.resolve()).catch(() => undefined),
      management.settle(Math.max(0, deadline - Date.now())).then((converged) => {
        if (!converged) {
          managementConverged = false
        }
      }),
      core.lifecycle.stop(),
      manager.stopAll(),
    ])
    let timedOut = false
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true
        resolve()
      }, budgetMs)
      timer.unref?.()
      void settle.then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        () => {
          clearTimeout(timer)
          resolve()
        },
      )
    })
    // management.settle 自身超时（返回 false）时 allSettled 已让外层 timer 提前清理，
    // 两种预算耗尽形态都要记录，否则"管理操作未收敛"会被静默吞掉。
    if (timedOut || !managementConverged) {
      logger.logEvent('manual_restart_required', {
        reason: timedOut
          ? `gateway shutdown exceeded ${budgetMs}ms budget; ending bounded wait (host may force-exit)`
          : `gateway shutdown exceeded ${budgetMs}ms budget while waiting for in-flight admin operations; ending bounded wait (host may force-exit)`,
      })
    }

    // 5. HTTP 最后关闭：停止进行中探针仍可用；启动已收敛且监听已建立，close 完成后
    // disposer 才返回，之后端口不再接受连接。
    await bestEffort(() => http.close(), 'http close during shutdown threw')
  }

  ctx.effect(() => {
    // 启动任务在 effect 注册时同步创建并保存：停止链据此等待启动收敛后再关闭监听。
    startupPromise = start()
    void startupPromise.catch((err: unknown) => {
      // start() 内部已处理预期失败；这里兜底防止未处理拒绝（如装配缺陷）。
      logger.logEvent('state_warning', {
        reason: `gateway startup task failed unexpectedly: ${errorMessage(err)}`,
      })
    })
    return () => {
      stopPromise ??= stop()
      return stopPromise
    }
  })
}
