import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import type { GatewayLogger } from '../logging.js'
import {
  ADMIN_BODY_LIMIT_BYTES,
  DEFAULT_GATEWAY_HTTP_HOST,
  DEFAULT_GATEWAY_HTTP_PORT,
  errorBody,
  notFoundBody,
} from './protocol.js'
import type { HttpReply } from './protocol.js'

/**
 * 本机 HTTP server：只做传输层——监听、body 读取与限制、JSON 解析、响应发送与连接关闭。
 *
 * 路由与业务错误映射在 `src/http/routes.ts`；本模块不认识管理请求、配置或 QQ。默认只绑定
 * 回环地址（`127.0.0.1:17890`，同时承担单实例占位）：绑定失败由 `start()` 原样 reject，
 * 不尝试杀死其他进程；listening 后 unref，使超预算未关闭的 server 不阻塞进程退出。
 *
 * 生命周期是显式状态机（`idle → starting → listening → closing → closed`，绑定失败退回
 * `idle`）：并发 `start()` 复用同一个绑定 promise；`close()` 在 `starting` 阶段调用时先等
 * 绑定落定、再真正关闭，绝不留下"close 已返回但监听仍在"的窗口；并发 `close()` 复用同一个
 * 关闭 promise。`closed` 后不能再启动（进程停止链只关闭一次）。
 *
 * 传输契约（与既有探针契约保持一致）：
 * - 路径去查询串后再交给路由；只有 `POST` 才读 body，其余方法的 `body` 为 `undefined`。
 * - POST 的 `content-type` 不含 `application/json` → 400 `invalid_request`。
 * - body 上限 64 KiB：超限后继续 drain 到 `end` 再回 400（不提前销毁连接，否则响应无法送达）。
 * - 读取中断（error/aborted/仅 close）→ 400；空 body 视为 `{}`；坏 JSON → 400。
 * - 路由返回 `undefined` → 404；路由抛错 → 记 `state_warning` + 500 `internal_error`。
 * - 所有响应 `content-type: application/json`。
 */

/** 已解析的请求：`path` 已去查询串；非 POST 的 `body` 为 `undefined`。 */
export interface HttpRequest {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

/** 路由处理器：`undefined` 表示未命中（由 server 统一 404），抛错按 500 处理。 */
export type HttpRequestHandler = (request: HttpRequest) => Promise<HttpReply | undefined>

export interface HttpServer {
  /** 绑定监听并等待 listening；已启动时幂等 resolve；关闭中/已关闭时 reject。 */
  start(): Promise<void>
  /** 关闭监听与全部连接；未启动时为 no-op；并发调用与重复调用复用同一 promise。 */
  close(): Promise<void>
  /** 实际绑定地址；未监听时 undefined。 */
  address(): { host: string; port: number } | undefined
}

export interface HttpServerOptions {
  host?: string
  port?: number
  logger: GatewayLogger
  handle: HttpRequestHandler
}

/** body 收集结果：成功（缓冲）、超限（>64 KiB）或读取失败（连接中断等）。 */
export type BodyReadResult = { body: Buffer } | { overflow: true } | { readFailed: true }

/** server 生命周期状态；`idle` 为初始态，绑定失败退回 `idle`（可重试）。 */
type ServerState = 'idle' | 'starting' | 'listening' | 'closing' | 'closed'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function respond(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

/**
 * 收集请求 body 至字节上限；超限或读取失败按对应形态返回（调用方按 400 拒绝，message 区分）。
 * 超限后丢弃后续数据但继续消费到 `end` 再返回——不提前销毁连接，否则 400 响应无法送达客户端。
 * `error`/`aborted`/`close` 都是读取中断的收敛点：只触发 close（如连接被对端销毁）时也必须
 * 让 promise 落定，避免处理器永久挂起。导出仅供传输层测试直接驱动中断分支。
 */
export function readRequestBody(req: IncomingMessage): Promise<BodyReadResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let overflow = false
    let settled = false
    const finish = (value: BodyReadResult): void => {
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
    req.on('aborted', () => finish({ readFailed: true }))
    req.on('close', () => finish({ readFailed: true }))
  })
}

export function createHttpServer(options: HttpServerOptions): HttpServer {
  const host = options.host ?? DEFAULT_GATEWAY_HTTP_HOST
  const port = options.port ?? DEFAULT_GATEWAY_HTTP_PORT
  const server: Server = createServer((req, res) => {
    void handleRequest(req, res)
  })
  server.on('error', (err: Error) => {
    // 持续挂接避免运行期 error 事件成为未处理异常；启动期绑定错误由 start() 的 once 处理。
    options.logger.logEvent('state_warning', { reason: `http server error: ${err.message}` })
  })

  let state: ServerState = 'idle'
  /** 共享绑定 promise：并发 start 复用，close 在 starting 阶段等待它落定。 */
  let startPromise: Promise<void> | undefined
  /** 共享关闭 promise：并发/重复 close 复用。 */
  let closePromise: Promise<void> | undefined
  /** 实际断开监听的 promise；listening 时若已请求关闭则提前启动，close 等待同一 promise。 */
  let closingPromise: Promise<void> | undefined
  /** 绑定进行中收到的关闭请求：listening 后立即开始关闭。 */
  let closeRequested = false

  /** 开始绑定；返回共享的 startPromise。绑定失败退回 idle（可重试）。 */
  function bind(): Promise<void> {
    state = 'starting'
    closeRequested = false
    closePromise = undefined
    closingPromise = undefined
    startPromise = new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        cleanup()
        state = 'idle'
        reject(err)
      }
      const onListening = (): void => {
        cleanup()
        state = 'listening'
        // 监听不承担保活职责：unref 使停机预算耗尽而未关闭的 server 不阻塞进程退出。
        server.unref?.()
        if (closeRequested) {
          // 绑定期间已请求关闭：立即开始断开；start 仍 resolve（监听曾短暂建立）。
          void shutdown()
        }
        resolve()
      }
      const cleanup = (): void => {
        server.off('error', onError)
        server.off('listening', onListening)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    })
    return startPromise
  }

  /** 关闭监听并等待真正断开；幂等（多次调用/提前调用复用同一 promise）。 */
  function shutdown(): Promise<void> {
    closingPromise ??= (async () => {
      if (state !== 'listening') {
        state = 'closed'
        return
      }
      state = 'closing'
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        // 强制断开保持连接，避免 close 等待客户端归还连接（探测客户端用 keep-alive 池）。
        server.closeAllConnections?.()
      })
      state = 'closed'
    })()
    return closingPromise
  }

  function start(): Promise<void> {
    if (state === 'starting') {
      return startPromise!
    }
    if (state === 'listening') {
      return Promise.resolve()
    }
    if (state === 'closing') {
      return Promise.reject(new Error('http server is closing; wait for close() to resolve'))
    }
    if (state === 'closed') {
      return Promise.reject(new Error('http server has been closed'))
    }
    return bind()
  }

  function close(): Promise<void> {
    if (state === 'idle' || state === 'closed') {
      return Promise.resolve()
    }
    closePromise ??= (async () => {
      if (state === 'starting') {
        closeRequested = true
        try {
          await startPromise
        } catch {
          // 绑定失败：没有监听可关闭。
          state = 'closed'
          return
        }
      }
      await shutdown()
    })()
    return closePromise
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0]!
    const method = req.method ?? ''
    try {
      let body: unknown = undefined
      if (method === 'POST') {
        const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
        if (!contentType.includes('application/json')) {
          respond(res, 400, errorBody('invalid_request', 'content-type must be application/json'))
          return
        }
        const raw = await readRequestBody(req)
        if ('overflow' in raw) {
          respond(res, 400, errorBody('invalid_request', 'request body is too large'))
          return
        }
        if ('readFailed' in raw) {
          respond(res, 400, errorBody('invalid_request', 'failed to read request body'))
          return
        }
        if (raw.body.length === 0) {
          body = {}
        } else {
          try {
            body = JSON.parse(raw.body.toString('utf8')) as unknown
          } catch {
            respond(res, 400, errorBody('invalid_request', 'request body is not valid JSON'))
            return
          }
        }
      }
      const reply = await options.handle({ method, path, body })
      if (reply === undefined) {
        respond(res, 404, notFoundBody())
        return
      }
      respond(res, reply.status, reply.body)
    } catch (err) {
      options.logger.logEvent('state_warning', {
        reason: `admin request failed: ${errorMessage(err)}`,
      })
      respond(res, 500, errorBody('internal_error', 'internal error while handling the request'))
    }
  }

  return {
    start,
    close,
    address: () => {
      const addr = server.address()
      if (typeof addr === 'object' && addr !== null) {
        return { host: addr.address, port: addr.port }
      }
      return undefined
    },
  }
}