import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage as createDshUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgentHandle, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
// 仅引入类型增强：把 agentDefaultModel 服务声明合并进 cordis Context（运行时由宿主提供）。
import type {} from '@deepseek-ai/dsh-agent-default-model'

import pkg from '../package.json' with { type: 'json' }
import { GATEWAY_LIMITS } from './contracts.js'
import {
  GATEWAY_CONFIG_SCHEMA_VERSION,
  GatewayConfigError,
  resolveGatewayWorkspace,
} from './config.js'
import type { GatewayConfig } from './config.js'
import { loadGatewayConfigStore } from './config-file.js'
import { createGatewayLogger } from './logging.js'
import type { GatewayLogger } from './logging.js'
import { createAdminRoutes } from './admin.js'
import type { ChannelManager } from './channels.js'
import { createChannelManager } from './channels.js'
import { createGatewayCore } from './core/index.js'
import type { CoreHandle } from './core/index.js'
import { createScheduler } from './core/scheduler.js'
import { createSessionManager } from './core/session-manager.js'
import type { AgentHandleLike, AgentHost, AgentLike, SessionLike } from './core/session-manager.js'
import { SCHEMA_VERSION, createStateStore } from './core/state-store.js'
import { createTurnRunner } from './core/turn-runner.js'
import type { TurnBlockLike, TurnEventSource, TurnHost, TurnSessionEvent } from './core/turn-runner.js'
import { createQQChannel } from './qq/index.js'
import { createQQTokenValidator } from './qq/token.js'
import type { QQCredentialValidator } from './qq/token.js'

/**
 * 插件入口与总装（设计 3.1、3.2、9.3、11.1、13.1、14 节）：本文件是唯一 import
 * @deepseek-ai/* 运行时与唯一组装 QQ 适配器的模块——把 dsh ctx 适配成 core 的 AgentHost
 * 端口、把 dsh session 事件翻译成 TurnEventSource、并在 cordis apply 里完成配置解析、
 * 组装与启停。其余 src 模块不得新增 dsh 运行时 import（设计 2 节边界）。
 *
 * 启动（13.1）：配置解析失败 → 记日志（只含变量名）后 throw，插件加载失败、dsh 终止；
 * 组装在 apply 内同步完成（各构造器不做 I/O），ctx.effect 内后台启动 core → QQ，
 * 任一步失败统一走停止协调器清理已创建资源，不主动退出进程（readiness 503 +
 * manual_restart_required 提示，13.3）。停止（9.3）：disposer 并行有界等待 core 与 QQ
 * 的幂等 stop，总预算 CORE_SHUTDOWN_BUDGET_MS；dsh 宿主的 SIGTERM 窗口若短于该预算
 * 会强杀进程，与设计 9.3"超限后记录未完成的清理并提示使用者结束 dsh 进程"一致。
 */

/** Cordis plugin name; must match the insert row id in cordis.patch.yml. */
export const name = 'dsh-gateway'

/**
 * 宿主服务依赖（3.2）：`agentLoop` 保证 agent factory 已注册——inject 缺服务时本插件
 * 不加载，天然满足"依赖未满足时保持未就绪，不连接 QQ 接流量"。
 */
export const inject = [
  'agents',
  'sessions',
  'sessionPersistence',
  'agentDefaultModel',
  'approval',
  'sandboxPolicy',
  'agentLoop',
] as const

/** Plugin config; 全部网关配置经环境变量（16 节），插件 config 无字段。 */
export interface Config {}

export const Config = z.object({})

// ---- dsh session 事件 → TurnSessionEvent（纯函数，tests/host.test.ts 单测） ----

/** ContentBlock 的最小投影：type 原样保留（含 merge-extensible 的未知块型），text/id 仅在为 string 时携带。 */
function toTurnBlock(block: ContentBlock): TurnBlockLike {
  const raw = block as { type: unknown; text?: unknown; id?: unknown }
  return {
    type: String(raw.type),
    text: typeof raw.text === 'string' ? raw.text : undefined,
    id: typeof raw.id === 'string' ? raw.id : undefined,
  }
}

/** 'other' 类事件（tool/call、step/* 等）若 data 带 number 型 turn 则携带，否则省略。 */
function otherTurn(event: SessionEvent): number | undefined {
  const data = (event as { data?: unknown }).data
  if (typeof data === 'object' && data !== null) {
    const turn = (data as { turn?: unknown }).turn
    if (typeof turn === 'number') {
      return turn
    }
  }
  return undefined
}

/**
 * dsh SessionEvent → TurnSessionEvent。真实事件形状（dsh-session 0.2.1-rc.2 类型声明）：
 * payload 位于 `event.data`（非顶层展开）；`tool/result` 的关联 id 是
 * `event.data.message.toolCallId`（无顶层 callId 字段）。三类事件之外一律归 'other'，
 * 不参与结果选择（8.2）。
 */
export function translateSessionEvent(event: SessionEvent): TurnSessionEvent {
  if (event.type === 'assistant/message') {
    const data = event.data
    return {
      type: 'assistant/message',
      turn: data.turn,
      step: data.step,
      content: data.message.content.map(toTurnBlock),
      interrupted: data.interrupted === true,
    }
  }
  if (event.type === 'tool/result') {
    const data = event.data
    return { type: 'tool/result', turn: data.turn, step: data.step, callId: data.message.toolCallId }
  }
  if (event.type === 'turn/end') {
    return { type: 'turn/end', turn: event.data.turn, reason: { kind: event.data.reason.kind } }
  }
  return { type: 'other', turn: otherTurn(event) }
}

// ---- dsh ctx → AgentHost 端口适配（3.2） ----

/** 事件订阅所需的原始 dsh 上下文；adaptHandle 时随句柄注册（AgentLike 无 ctx 字段）。 */
interface HandleRegistration {
  readonly agentCtx: Context
  readonly sessionId: string
}

/** 同一 session 的并发 flush 只发一次：in-flight Map 在 settle 后删除（T6 契约）。 */
function createSessionFlusher(ctx: Context): AgentHost['flushSession'] {
  const inFlight = new Map<string, Promise<boolean>>()
  return (session: SessionLike) => {
    const existing = inFlight.get(session.id)
    if (existing !== undefined) {
      return existing
    }
    // SessionLike 是最小视图；真实路径传入的恒是 dsh Session（取自 handle.agent.session）。
    const flushOp = ctx.sessions.flush(session as unknown as Session).then(
      (result: boolean) => {
        inFlight.delete(session.id)
        return result
      },
      (err: unknown) => {
        inFlight.delete(session.id)
        throw err
      },
    )
    inFlight.set(session.id, flushOp)
    return flushOp
  }
}

/**
 * 真实 dsh 宿主接入层：AgentHost + TurnHost.createUserMessage + eventsFor 事件源。
 * 同一闭包内维护 AgentHandleLike → 原始 dsh AgentHandle 的 WeakMap 注册表，
 * eventsFor 据此取得 agent.ctx（agent-scoped 订阅天然过滤本 agent）。
 */
export function createAgentHost(ctx: Context): {
  host: TurnHost
  eventsFor: (handle: AgentHandleLike) => TurnEventSource
} {
  const registry = new WeakMap<AgentHandleLike, HandleRegistration>()
  const flushSession = createSessionFlusher(ctx)

  /**
   * 3.2 configureGatewayAgent：发布前组合策略事件（幂等 append durable 事件，恢复亦强制），
   * 不注册额外观察器、不驱动——turn-runner 经 eventsFor 单独订阅。
   */
  const setupGatewayAgent: AgentSetup = (_agentCtx, agent) => {
    setApprovalPolicy(agent.session, 'never')
    setSandboxMode(agent.session, 'workspace-write')
  }

  /**
   * dsh AgentHandle → AgentHandleLike。唯一类型断言点：dsh SessionHeader.cwd 在类型上可选
   * （`cwd?: string`），而 SessionLike 要求必有——网关创建/恢复的 session 恒经 meta.cwd
   * 绑定身份目录（session-manager 恢复路径另做 realpath 复核）；followup/cancel 的参数差异
   * 由方法双变比较覆盖，whenIdle/inbox/status/id 直接结构兼容。
   */
  function adaptHandle(handle: AgentHandle): AgentHandleLike {
    const like: AgentHandleLike = {
      agent: handle.agent as unknown as AgentLike,
      dispose: () => handle.dispose(),
    }
    registry.set(like, { agentCtx: handle.agent.ctx, sessionId: handle.agent.id })
    return like
  }

  const host: TurnHost = {
    currentModelSelection: () => ctx.agentDefaultModel.currentSelection(),
    createAgent: async ({ sessionId, cwd, agentOptions, signal }) => {
      const handle = await ctx.agents.create({
        sessionId: SessionId(sessionId),
        meta: { cwd },
        // AgentModelOptions 与 AgentOptions 仅 reasoningEffort 的品牌类型差异（string vs
        // ReasoningEffortId），值形状兼容；断言集中于此。
        agentOptions: agentOptions as AgentOptions,
        signal,
        setup: setupGatewayAgent,
      })
      return adaptHandle(handle)
    },
    resumeAgent: async ({ sessionId, agentOptions, signal }) => {
      const handle = await ctx.agents.resume({
        resumeSessionId: SessionId(sessionId),
        agentOptions: agentOptions as AgentOptions,
        signal,
        setup: setupGatewayAgent,
      })
      return adaptHandle(handle)
    },
    flushSession,
    isAgentLive: (sessionId) => ctx.agents.get(SessionId(sessionId)) !== undefined,
    createUserMessage: (text) => {
      const message = createDshUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
      return { id: message.id, message }
    },
  }

  /** dsh 事件源适配（8.1：subscribe 必须先于 followup 调用；返回取消订阅函数）。 */
  function eventsFor(handle: AgentHandleLike): TurnEventSource {
    return {
      subscribe(handlers) {
        const registration = registry.get(handle)
        if (registration === undefined) {
          throw new Error('gateway eventsFor: handle was not created by this host (wiring defect)')
        }
        const offClaimed = registration.agentCtx.on('agent/inbox/claimed', (payload) => {
          handlers.onInboxClaimed({ messageId: payload.message.id, turn: payload.turn })
        })
        const offSessionEvent = registration.agentCtx.on('session/event', (session, event) => {
          if (session.id !== registration.sessionId) {
            return
          }
          handlers.onSessionEvent(translateSessionEvent(event))
        })
        return () => {
          offClaimed()
          offSessionEvent()
        }
      },
    }
  }

  return { host, eventsFor }
}

// ---- cordis 插件入口与总装（3.1、13.1、9.3、14） ----

/** 宿主接入层的可测接缝（正式入口不传）：健康监听注入、QQ 渠道工厂与凭证校验替身。 */
export interface GatewayLaunchOptions {
  /** 健康监听注入（13.2 默认 127.0.0.1:17890）；测试用 port 0 探测随机端口。 */
  health?: { host?: string; port?: number }
  /** QQ 渠道工厂（测试替身避免真实网络）；缺省用真实 createQQChannel。 */
  createQQChannelAdapter?: typeof createQQChannel
  /** QQ 凭证在线校验（管理路由 add 用；测试替身避免真实网络）。 */
  validateQQCredentials?: QQCredentialValidator
  /** 结构化日志 sink（默认逐行 stdout）；测试捕获启动摘要与失败事件。 */
  loggerSink?: (line: string) => void
}

/** dsh 根上下文提供的 home 路径函数（不是环境变量，也不是缓存的字符串）。 */
type DshHomePath = (...segments: string[]) => string

/**
 * 从 dsh 根上下文取 `dshHomePath` 并解析当前 dsh home。服务由 dsh app-boot 在挂载配置树
 * 之前提供；取不到说明 dsh 版本/运行组合不匹配，直接拒绝启动而不是跳过路径安全校验。
 */
function resolveDshHomeForConfig(ctx: Context): string {
  let dshHomePath: DshHomePath | undefined
  try {
    dshHomePath = ctx.get('dshHomePath') as DshHomePath | undefined
  } catch (err) {
    throw new GatewayConfigError('dshHomePath service is unavailable', { cause: err })
  }
  if (dshHomePath === undefined) {
    throw new GatewayConfigError('dshHomePath service is unavailable')
  }
  try {
    const value = dshHomePath()
    if (typeof value !== 'string' || value === '') {
      throw new GatewayConfigError('dshHomePath returned an invalid path')
    }
    return value
  } catch (err) {
    if (err instanceof GatewayConfigError) {
      throw err
    }
    throw new GatewayConfigError(`failed to resolve dsh home: ${errorMessage(err)}`, {
      cause: err,
    })
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 9.3 停止链：core 协调器与全部渠道实例的幂等 stop 并行有界等待，总预算 CORE_SHUTDOWN_BUDGET_MS。 */
async function stopGateway(
  coreHandle: CoreHandle,
  manager: ChannelManager,
  logger: GatewayLogger,
): Promise<void> {
  // 先摘除管理路由：停止链期间新到达（含已通过就绪检查后排队）的管理请求一律按 404
  // 处理，收窄"关机窗口内仍完成注册/写配置"的窗口；已在处理器内执行中的请求不受影响。
  coreHandle.setAdminHandler(undefined)
  let settled = false
  const both = Promise.allSettled([coreHandle.stop(), manager.stopAll()]).then(() => {
    settled = true
  })
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (!settled) {
        logger.logEvent('manual_restart_required', {
          reason: `gateway shutdown exceeded ${GATEWAY_LIMITS.CORE_SHUTDOWN_BUDGET_MS}ms budget; ending bounded wait (host may force-exit)`,
        })
      }
      resolve()
    }, GATEWAY_LIMITS.CORE_SHUTDOWN_BUDGET_MS)
    timer.unref?.()
    void both.then(
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
}

/**
 * 组装并后台启动网关。env 由调用方注入（正式入口固定 process.env），只用于解析
 * `DSH_GATEWAY_WORKSPACE`；其余配置从 workspace 内的 gateway.config.json 读取。
 *
 * 启动：core 就绪后按配置顺序拉起每个 `enabled` 的 QQ 实例；单个实例启动失败只记
 * manual_restart_required 并继续（实例置 blocked，见健康表），进程不退出。零实例（空数组
 * 或全部 disabled）时 core 正常运行，`/readyz` 200。管理路由（channel add/enable）经
 * `coreHandle.setAdminHandler` 挂到健康 server。
 */
export function launchGateway(
  ctx: Context,
  env: Record<string, string | undefined>,
  options?: GatewayLaunchOptions,
): void {
  let gatewayConfig: GatewayConfig
  let configStore: ReturnType<typeof loadGatewayConfigStore>
  try {
    const dshHome = resolveDshHomeForConfig(ctx)
    const workspaceDir = resolveGatewayWorkspace(env)
    const loaded = loadGatewayConfigStore({ workspaceDir, dshHome })
    gatewayConfig = loaded.config
    configStore = loaded
  } catch (err) {
    // GatewayConfigError 的 message 只含字段/路径与原因、不含值；rethrow 使插件加载失败，
    // dsh 终止。
    ctx.logger(name).error(`gateway configuration rejected: ${errorMessage(err)}`)
    throw err
  }
  const logger = createGatewayLogger({ debug: gatewayConfig.debug, sink: options?.loggerSink })

  if (configStore.createdTemplate) {
    logger.logEvent('config_template_created', {
      reason: `created a template at ${configStore.configPath}; run "dsh-gateway channel add qq" to add a bot`,
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

  const store = createStateStore({ stateDir: gatewayConfig.stateDir, limits: GATEWAY_LIMITS, logger })
  const runner = createTurnRunner({ host, eventsFor, limits: GATEWAY_LIMITS, logger })
  const sessions = createSessionManager({
    host,
    store,
    workspaceRoot: gatewayConfig.workspaceRoot,
    config: {
      idleAgentTtlMs: gatewayConfig.idleAgentTtlMs,
      maxLiveAgents: gatewayConfig.maxLiveAgents,
      maxConcurrent: gatewayConfig.maxConcurrent,
    },
    limits: GATEWAY_LIMITS,
    logger,
  })
  // channel 管理面晚于 coreHandle 构造（需要 core 注册面与健康快照），健康表先经闭包读
  // manager 的最新实例清单；未构造前回落启动快照。
  let manager: ChannelManager | undefined
  const coreHandle = createGatewayCore({
    config: gatewayConfig,
    limits: GATEWAY_LIMITS,
    logger,
    store,
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
    health: options?.health,
    currentQQInstances: () => manager?.listInstances() ?? gatewayConfig.qqInstances,
  })
  manager = createChannelManager({
    core: coreHandle.core,
    logger,
    limits: GATEWAY_LIMITS,
    factory: options?.createQQChannelAdapter ?? createQQChannel,
    instances: gatewayConfig.qqInstances,
    channelState: (appId) => coreHandle.health().channelStates[`qq:${appId}`],
  })
  coreHandle.setAdminHandler(
    createAdminRoutes({
      logger,
      store: configStore,
      manager,
      validateQQCredentials: options?.validateQQCredentials ?? createQQTokenValidator(),
      coreState: () => coreHandle.health().coreState,
    }),
  )

  ctx.effect(() => {
    void (async () => {
      try {
        await coreHandle.start()
      } catch (err) {
        // 异步启动失败不能 throw 进已返回的 apply：统一停止协调器清理已创建资源
        // （core 保持非 ready，readiness 503），不主动退出进程——manual_restart_required
        // 提示使用者处理后手动重启（13.1、13.3）。
        logger.logEvent('manual_restart_required', {
          reason: `gateway startup failed: ${errorMessage(err)}`,
        })
        await coreHandle.stop().catch((stopErr: unknown) => {
          logger.logEvent('state_warning', {
            reason: `core stop after startup failure threw: ${errorMessage(stopErr)}`,
          })
        })
        await manager?.stopAll().catch((stopErr: unknown) => {
          logger.logEvent('state_warning', {
            reason: `channel stop after startup failure threw: ${errorMessage(stopErr)}`,
          })
        })
        return
      }
      // 按配置顺序拉起 enabled 实例；单个失败只影响自身（blocked + manual_restart_required），
      // 其余实例与 core 继续（多实例失败隔离）。凭证从管理面的最新实例清单读取（循环内的
      // await 期间管理路由可能已更新同 appId 的 secret），避免用启动快照的旧凭证重启。
      for (const startupInstance of gatewayConfig.qqInstances) {
        const current = manager
          .listInstances()
          .find((instance) => instance.appId === startupInstance.appId)
        if (current === undefined || !current.enabled) {
          continue
        }
        // 已在线则幂等跳过（如循环等待期间管理路由已拉起该实例），避免对在线实例停旧起新。
        if (coreHandle.health().channelStates[`qq:${current.appId}`] === 'online') {
          continue
        }
        const result = await manager.startInstance(current.appId, current.appSecret)
        if (result.startError !== undefined) {
          continue
        }
      }
    })()
    return () => stopGateway(coreHandle, manager, logger)
  })
}

/** Plugin entry; cordis 以 (ctx, config) 调用，全部配置经环境变量（16 节）。 */
export function apply(ctx: Context, _config: Config): void {
  launchGateway(ctx, process.env)
}
