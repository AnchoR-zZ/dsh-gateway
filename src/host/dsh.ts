import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage as createDshUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgentHandle, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
// 仅引入类型增强：把 agentDefaultModel 服务声明合并进 cordis Context（运行时由宿主提供）。
import type {} from '@deepseek-ai/dsh-agent-default-model'

import { GatewayConfigError } from '../config/schema.js'
import type { AgentHandleLike, AgentHost, AgentLike, SessionLike } from '../core/session-manager.js'
import type { TurnBlockLike, TurnEventSource, TurnHost, TurnSessionEvent } from '../core/turn-runner.js'

/**
 * dsh 宿主接入层：把 dsh 根上下文适配成 core 的 AgentHost 端口、把 dsh session 事件翻译成
 * TurnEventSource，并解析 dsh home 供配置层做路径安全校验。
 *
 * 本文件是 src 内唯一 import `@deepseek-ai/*` 运行时值的模块（`index.ts` 只保留类型 import
 * 与 Config schema）。core 的 runner/session-manager 只依赖这里的端口类型，不感知 dsh。
 */

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

// ---- dsh home 解析（配置层 workspace/dsh home 重叠校验的输入） ----

/** dsh 根上下文提供的 home 路径函数（不是环境变量，也不是缓存的字符串）。 */
type DshHomePath = (...segments: string[]) => string

/**
 * 从 dsh 根上下文取 `dshHomePath` 并解析当前 dsh home。服务由 dsh app-boot 在挂载配置树
 * 之前提供；取不到说明 dsh 版本/运行组合不匹配，直接拒绝启动而不是跳过路径安全校验。
 */
export function resolveDshHomeForConfig(ctx: Context): string {
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
