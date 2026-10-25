import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import type { GatewayLogger } from '../logging.js'

/**
 * core/lifecycle：core 状态机、正常停止协调器（设计 9.3）与本机健康探针 server（13.2）。
 *
 * 本模块不直接持有 scheduler / session-manager / state-store 等具体依赖：停止协调器以钩子
 * 形式由组装层（core/index.ts）提供各步骤的具体实现，健康 server 只依赖快照函数、ready
 * 谓词与可选的 channel 管理路由处理器。保持 core 生命周期层不导入 QQ SDK 与 dsh 运行时包
 * （设计 2 节边界）。
 */

export type CoreState = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'
export type ChannelState = 'connecting' | 'online' | 'reconnecting' | 'blocked'

/**
 * 健康展示用的渠道状态：已注册实例的 `ChannelState` 之外，另有两类配置派生值——
 * `disabled`（配置存在但 `enabled: false`，未注册）与 `not_configured`（该渠道类型零实例）。
 * 两者都不参与就绪判定。
 */
export type ChannelHealthState = ChannelState | 'disabled' | 'not_configured'

/**
 * /readyz 正文与健康快照共用的只读形状。
 * 只含状态、渠道状态表、待处理数量、运行数量与启动时间；无用户标识、无 sessionId、
 * 无错误原文（设计 13.2）。渠道表按实例展开，键为 `<channelId>:<appId>`。
 */
export interface HealthSnapshot {
  coreState: CoreState
  channels: Record<string, ChannelHealthState>
  pending: number
  running: number
  startedAt: string
}

/** channel 管理路由的应答；`undefined` 表示路径未命中（按 404 处理）。 */
export interface AdminReply {
  status: number
  body: unknown
}

/**
 * 本机 channel 管理路由处理器：只处理 POST + `application/json` 请求（方法与内容类型由
 * 健康 server 统一判定），收到已解析的 JSON body。实现不得在响应正文、日志或错误信息中
 * 回显 `appSecret`。
 */
export type AdminHandler = (path: string, body: unknown) => Promise<AdminReply | undefined>

/** 管理请求 body 的字节上限；超出按 400 拒绝。 */
const ADMIN_BODY_LIMIT_BYTES = 65_536

/** 单向迁移表：`stopped` 与 `failed` 为吸收态（9.3、13.3）。 */
const ALLOWED_TRANSITIONS: Readonly<Record<CoreState, readonly CoreState[]>> = {
  starting: ['ready', 'stopping', 'failed'],
  ready: ['stopping', 'failed'],
  stopping: ['stopped', 'failed'],
  stopped: [],
  failed: [],
}

/** core 状态机；非法迁移拒绝并记 state_warning，重复提交同一状态静默 no-op。 */
export interface CoreStateMachine {
  get(): CoreState
  /** 返回是否真的发生了迁移；owner 据此做一次性副作用（如 failed 日志）。 */
  transition(next: CoreState): boolean
}

export function createCoreStateMachine(options: {
  logger: GatewayLogger
  initial?: CoreState
}): CoreStateMachine {
  let state: CoreState = options.initial ?? 'starting'
  return {
    get: () => state,
    transition(next: CoreState): boolean {
      if (state === next) {
        return false
      }
      if (!ALLOWED_TRANSITIONS[state].includes(next)) {
        options.logger.logEvent('state_warning', {
          reason: `rejected core state transition ${state} -> ${next}`,
        })
        return false
      }
      state = next
      return true
    },
  }
}

/**
 * 本机健康探针 server（13.2）：默认独占绑定 127.0.0.1:17890，同一 server 兼作单实例占位
 * 与只读状态查询。绑定失败（如 EADDRINUSE）由 start() 原样 reject，调用方拒绝启动，
 * 不尝试杀死其他进程。只绑回环；除 GET 探针外，仅接受注入的 channel 管理 POST 路由，
 * 不接受消息或其他控制请求。
 */
export interface HealthServer {
  /** 绑定监听并等待 listening；已启动时幂等 resolve。 */
  start(): Promise<void>
  /** 关闭监听与全部连接；未启动时幂等 resolve。 */
  close(): Promise<void>
  /** 实际绑定地址；未启动时 undefined（测试探测注入端口用）。 */
  address(): { host: string; port: number } | undefined
}

export function createHealthServer(options: {
  host?: string
  port?: number
  logger: GatewayLogger
  /** 探针正文来源；无用户标识、无 sessionId、无错误原文。 */
  snapshot: () => HealthSnapshot
  /** readiness 谓词：core ready 且持久状态健康且全部需要在线的渠道条目 online。 */
  ready: () => boolean
  /** 可选的 channel 管理路由；未注入时除 GET 探针外一律 404。 */
  admin?: AdminHandler
}): HealthServer {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 17_890
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && path === '/livez') {
      // livez 只证明进程事件循环可响应（13.2），恒 200。
      respond(res, 200, { status: 'ok' })
      return
    }
    if (req.method === 'GET' && path === '/readyz') {
      const body = options.snapshot()
      respond(res, options.ready() ? 200 : 503, body)
      return
    }
    if (options.admin !== undefined) {
      void handleAdminRequest(options.admin, options.logger, req, res, path)
      return
    }
    respond(res, 404, { error: 'not found' })
  })
  server.on('error', (err: Error) => {
    // 持续挂接避免运行期 error 事件成为未处理异常；启动期绑定错误由 start() 的 once 处理。
    options.logger.logEvent('state_warning', { reason: `health server error: ${err.message}` })
  })
  let listening = false

  return {
    start: () =>
      new Promise<void>((resolve, reject) => {
        if (listening) {
          resolve()
          return
        }
        const onError = (err: Error): void => {
          cleanup()
          reject(err)
        }
        const onListening = (): void => {
          cleanup()
          listening = true
          // 探针不承担保活职责：进程存活由 dsh 宿主的其余句柄保证，unref 使停机预算
          // 耗尽而未关闭的 server 不阻塞进程退出（13.2）。
          server.unref?.()
          resolve()
        }
        const cleanup = (): void => {
          server.off('error', onError)
          server.off('listening', onListening)
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, host)
      }),
    close: async () => {
      if (!listening) {
        return
      }
      listening = false
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        // 强制断开保持连接，避免 close 等待客户端归还连接（探测客户端用 keep-alive 池）。
        server.closeAllConnections?.()
      })
    },
    address: () => {
      const addr = server.address()
      if (typeof addr === 'object' && addr !== null) {
        return { host: addr.address, port: addr.port }
      }
      return undefined
    },
  }
}

function respond(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

function adminErrorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } }
}

/** body 收集结果：成功（缓冲）、超限（>64 KiB）或读取失败（连接中断等 `error` 事件）。 */
type AdminBodyResult = { body: Buffer } | { overflow: true } | { readFailed: true }

/**
 * 收集请求 body 至字节上限；超限或读取失败按对应形态返回（调用方按 400 拒绝，message 区分）。
 * 超限后丢弃后续数据但继续消费到 `end` 再返回——不提前销毁连接，否则 400 响应无法送达
 * 客户端（socket 已死）。
 */
function readAdminBody(req: IncomingMessage): Promise<AdminBodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let overflow = false
    let settled = false
    const finish = (value: AdminBodyResult): void => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    req.on('data', (chunk: Buffer) => {
      if (settled || overflow) {
        return
      }
      total += chunk.length
      if (total > ADMIN_BODY_LIMIT_BYTES) {
        overflow = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(overflow ? { overflow: true } : { body: Buffer.concat(chunks) }))
    req.on('error', () => finish({ readFailed: true }))
  })
}

/**
 * 管理请求分派：仅接受 POST + `application/json`（其余按 404/400 拒绝），解析 body 后交给
 * 注入的处理器；处理器未命中路径按 404，抛错按 500 并记 `state_warning`。
 */
async function handleAdminRequest(
  admin: AdminHandler,
  logger: GatewayLogger,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<void> {
  try {
    if (req.method !== 'POST') {
      respond(res, 404, { error: 'not found' })
      return
    }
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
    if (!contentType.includes('application/json')) {
      respond(res, 400, adminErrorBody('invalid_request', 'content-type must be application/json'))
      return
    }
    const raw = await readAdminBody(req)
    if ('overflow' in raw) {
      respond(res, 400, adminErrorBody('invalid_request', 'request body is too large'))
      return
    }
    if ('readFailed' in raw) {
      respond(res, 400, adminErrorBody('invalid_request', 'failed to read request body'))
      return
    }
    let body: unknown
    try {
      body = raw.body.length === 0 ? {} : (JSON.parse(raw.body.toString('utf8')) as unknown)
    } catch {
      respond(res, 400, adminErrorBody('invalid_request', 'request body is not valid JSON'))
      return
    }
    const reply = await admin(path, body)
    if (reply === undefined) {
      respond(res, 404, { error: 'not found' })
      return
    }
    respond(res, reply.status, reply.body)
  } catch (err) {
    logger.logEvent('state_warning', {
      reason: `admin request failed: ${err instanceof Error ? err.message : String(err)}`,
    })
    respond(res, 500, adminErrorBody('internal_error', 'internal error while handling the request'))
  }
}

/** 停止协调器的预算键（值放宽为 number，组装层可注入小预算驱动测试）。 */
export interface StopBudgetLimits {
  STOP_NATURAL_COMPLETION_WAIT_MS: number
  CORE_SHUTDOWN_BUDGET_MS: number
}

/** 各预算内步骤收到的上下文：距总预算耗尽的剩余毫秒（单调口径）。 */
export interface StopStepContext {
  remainingMs(): number
}

/**
 * 幂等停止协调器（9.3）。步骤顺序：置 stopping → 丢弃内存队列（onStopDropped 关闭
 * ports，不发停机广播）→ 各渠道 stopReceiving（尽力）→ 运行中任务先等自然结束窗口、
 * 超时后中断并等剩余预算 → 停会话回收器并释放全部缓存 handle → 排空状态写事务 →
 * 关闭健康监听 → 置 stopped。总预算 CORE_SHUTDOWN_BUDGET_MS（单调时钟）；超预算未完成
 * 的步骤记 manual_restart_required 并仍置 stopped——进程退出由 dsh 宿主保证（9.3），
 * 本协调器不强制结束自己。
 */
export interface StopCoordinatorOptions {
  limits: StopBudgetLimits
  mono: () => number
  logger: GatewayLogger
  /** 步骤 1：置 stopping（owner 状态机决定实际迁移；已 failed 时保持 failed）。 */
  onStopping(): void
  /** 步骤 2：丢弃尚未执行的内存队列并关闭其 reply ports。 */
  dropQueue(): void
  /** 步骤 3：各渠道停止接收（尽力 await，计入预算）。 */
  stopChannels(ctx: StopStepContext): Promise<void>
  /**
   * 步骤 4 的活动执行集合：占全局槽的执行 promise 与中断入口（prepare abort 与
   * runner stopInterrupt 由 owner 组合提供）。协调器先等自然结束窗口，超时才中断。
   */
  activeRuns(): { promises: readonly Promise<unknown>[]; interruptAll(): void }
  /** 步骤 5：停回收器并按剩余预算释放全部缓存 handle。 */
  releaseSessions(ctx: StopStepContext): Promise<void>
  /** 步骤 6：排空状态写事务（不产生新写入）。 */
  flushStore(ctx: StopStepContext): Promise<void>
  /** 步骤 7：关闭健康监听。 */
  closeHealth(): Promise<void>
  /** 步骤 8：置 stopped（owner 状态机决定；failed 吸收态下为 no-op）。 */
  onStopped(): void
}

export interface StopCoordinator {
  /** 幂等：并发与后续调用共享同一 promise。 */
  stop(): Promise<void>
}

export function createStopCoordinator(options: StopCoordinatorOptions): StopCoordinator {
  const { limits, mono, logger } = options
  let stopPromise: Promise<void> | undefined

  async function runStop(): Promise<void> {
    const budgetDeadline = mono() + limits.CORE_SHUTDOWN_BUDGET_MS
    const ctx: StopStepContext = { remainingMs: () => budgetDeadline - mono() }
    const unfinished: string[] = []

    const capped = (capMs: number): number => Math.max(0, Math.min(capMs, budgetDeadline - mono()))

    /**
     * 在 cap 与剩余预算取小的窗口内等待 op 落定（rejection 视为落定，步骤永不阻塞后续
     * 清理）。recordTimeout=false 用于"预期中的超时"（自然结束窗口），不进未收敛清单。
     */
    const waitStep = async (op: Promise<unknown>, capMs: number, label: string, recordTimeout = true): Promise<boolean> => {
      const ms = capped(capMs)
      if (ms <= 0) {
        if (recordTimeout) {
          unfinished.push(label)
        }
        return false
      }
      const guarded = Promise.resolve(op).then(
        () => undefined,
        () => undefined,
      )
      const done = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), ms)
        timer.unref?.()
        guarded.then(() => {
          clearTimeout(timer)
          resolve(true)
        })
      })
      if (!done && recordTimeout) {
        unfinished.push(label)
      }
      return done
    }

    const call = (fn: (ctx: StopStepContext) => Promise<void>, label: string): Promise<void> => {
      try {
        return fn(ctx)
      } catch (err) {
        logger.logEvent('state_warning', {
          reason: `shutdown step ${label} threw: ${err instanceof Error ? err.message : String(err)}`,
        })
        return Promise.resolve()
      }
    }

    // 1. readiness 立即不可用（owner 状态迁移）。
    options.onStopping()
    // 2. 丢弃内存队列；onStopDropped 已逐个关闭 port，不发停机广播。
    options.dropQueue()
    // 3. 渠道停止接收（尽力）。
    await waitStep(call(options.stopChannels, 'stop_channels'), Number.POSITIVE_INFINITY, 'stop_channels')
    // 4. 运行中任务：先等自然结束，超时中断，再等剩余预算收敛。
    const runs = options.activeRuns()
    if (runs.promises.length > 0) {
      const all = Promise.allSettled(runs.promises)
      const natural = await waitStep(all, limits.STOP_NATURAL_COMPLETION_WAIT_MS, 'natural_completion_wait', false)
      if (!natural) {
        runs.interruptAll()
        await waitStep(all, Number.POSITIVE_INFINITY, 'active_run_completion')
      }
    }
    // 5. 停回收器 + 释放全部缓存 handle（hook 用 ctx.remainingMs 派生各自期限）。
    await waitStep(call(options.releaseSessions, 'session_release'), Number.POSITIVE_INFINITY, 'session_release')
    // 6. 排空状态写事务。
    await waitStep(call(options.flushStore, 'state_flush'), Number.POSITIVE_INFINITY, 'state_flush')
    // 7. 关闭健康监听。
    await waitStep(
      Promise.resolve(options.closeHealth()).then(
        () => undefined,
        () => undefined,
      ),
      Number.POSITIVE_INFINITY,
      'health_close',
    )
    // 8. 终态（owner 决定；failed 吸收态下保持 failed）。
    options.onStopped()
    if (unfinished.length > 0) {
      logger.logEvent('manual_restart_required', {
        reason: `shutdown budget exhausted; unfinished steps: ${unfinished.join(', ')}`,
      })
      logger.logEvent('shutdown', { reason: 'budget_exhausted' })
      return
    }
    logger.logEvent('shutdown')
  }

  return {
    stop(): Promise<void> {
      stopPromise ??= runStop()
      return stopPromise
    },
  }
}
