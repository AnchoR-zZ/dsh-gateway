import { EventEmitter } from 'node:events'
import { createServer, type IncomingMessage } from 'node:http'
import { connect, type AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { createGatewayLogger } from '../src/logging.js'
import { createHttpServer, readRequestBody } from '../src/http/server.js'
import type { HttpRequest, HttpServer } from '../src/http/server.js'
import type { HttpReply } from '../src/http/protocol.js'

/**
 * HTTP 传输层测试：真实监听回环随机端口 + 真实 fetch/裸 socket，验证方法/内容类型/body
 * 限制/JSON 解析/404/500/查询串/连接关闭与端口占用；生命周期状态机（并发 start/close、
 * 绑定期间 close）与 body 中断收敛用假 IncomingMessage 单测。路由分派由 http.test.ts 覆盖。
 */

interface LogLine {
  event: string
  [key: string]: unknown
}

interface ServerHarness {
  server: HttpServer
  base: string
  requests: HttpRequest[]
  logs: LogLine[]
}

const activeServers: HttpServer[] = []

afterEach(async () => {
  for (const server of activeServers.splice(0)) {
    await server.close()
  }
})

function makeLogger(logs: LogLine[]) {
  return createGatewayLogger({ debug: false, sink: (line) => logs.push(JSON.parse(line) as LogLine) })
}

/** 预留一个当前空闲的回环端口（用于断言 close 后端口真正释放）。 */
async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(() => resolve(port))
    })
  })
}

/** 启动一个回环随机端口 server；默认处理器回显收到的请求（便于断言 body 解析）。 */
async function startServer(options?: {
  handle?: (request: HttpRequest) => Promise<HttpReply | undefined>
  port?: number
}): Promise<ServerHarness> {
  const logs: LogLine[] = []
  const requests: HttpRequest[] = []
  const handle = async (request: HttpRequest): Promise<HttpReply | undefined> => {
    requests.push(request)
    if (options?.handle !== undefined) {
      return options.handle(request)
    }
    return { status: 200, body: { method: request.method, path: request.path, body: request.body } }
  }
  const server = createHttpServer({
    host: '127.0.0.1',
    port: options?.port ?? 0,
    logger: makeLogger(logs),
    handle,
  })
  await server.start()
  activeServers.push(server)
  const address = server.address()!
  return { server, base: `http://127.0.0.1:${address.port}`, requests, logs }
}

describe('http server: lifecycle', () => {
  it('start 绑定实际地址且幂等，close 后 address 为空且可重复调用', async () => {
    const logs: LogLine[] = []
    const server = createHttpServer({
      host: '127.0.0.1',
      port: 0,
      logger: makeLogger(logs),
      handle: async () => undefined,
    })
    activeServers.push(server)
    expect(server.address()).toBeUndefined()

    await server.start()
    expect(server.address()).toBeDefined()
    const address = server.address()!
    expect(address.host).toBe('127.0.0.1')
    expect(address.port).toBeGreaterThan(0)
    // 已启动时幂等 resolve。
    await expect(server.start()).resolves.toBeUndefined()
    expect(server.address()).toEqual(address)

    await server.close()
    expect(server.address()).toBeUndefined()
    // 已关闭时 close 幂等 resolve。
    await expect(server.close()).resolves.toBeUndefined()
  })

  it('并发 start 复用同一 promise；并发 close 也复用同一 promise', async () => {
    const server = createHttpServer({
      host: '127.0.0.1',
      port: 0,
      logger: makeLogger([]),
      handle: async () => undefined,
    })
    activeServers.push(server)

    const firstStart = server.start()
    const secondStart = server.start()
    expect(secondStart).toBe(firstStart)
    await firstStart
    expect(server.address()).toBeDefined()

    const firstClose = server.close()
    const secondClose = server.close()
    expect(secondClose).toBe(firstClose)
    await firstClose
    expect(server.address()).toBeUndefined()
  })

  it('close() 在 start() 落定前调用：等绑定完成后关闭，端口真正释放', async () => {
    const reserved = await reservePort()
    const server = createHttpServer({
      host: '127.0.0.1',
      port: reserved,
      logger: makeLogger([]),
      handle: async () => undefined,
    })
    activeServers.push(server)

    // start() 返回时仍处于 starting（listen 异步），此刻 close 必须等绑定落定再关闭。
    const startPromise = server.start()
    const closePromise = server.close()
    await expect(startPromise).resolves.toBeUndefined()
    await closePromise

    expect(server.address()).toBeUndefined()
    // 端口已可被重新绑定：证明 close 真正断开监听，而不是先 resolve 留下后台监听。
    const probe = createServer()
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(reserved, '127.0.0.1', resolve)
    })
    await new Promise<void>((resolve) => probe.close(() => resolve()))
  })

  it('close 前未启动时为 no-op 且之后仍可 start；closing/closed 时 start reject', async () => {
    const server = createHttpServer({
      host: '127.0.0.1',
      port: 0,
      logger: makeLogger([]),
      handle: async () => undefined,
    })
    activeServers.push(server)

    // 未启动时 close 是 no-op，不阻止后续 start。
    await expect(server.close()).resolves.toBeUndefined()
    await server.start()
    expect(server.address()).toBeDefined()

    const closing = server.close()
    await expect(server.start()).rejects.toThrow(/closing/)
    await closing
    await expect(server.start()).rejects.toThrow(/has been closed/)
  })

  it('端口被占用：start() reject，外部监听不受影响，运行期错误记 state_warning', async () => {
    const blocker = createServer((_req, res) => {
      res.end('blocker-ok')
    })
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const occupiedPort = (blocker.address() as AddressInfo).port
    const logs: LogLine[] = []
    const server = createHttpServer({
      host: '127.0.0.1',
      port: occupiedPort,
      logger: makeLogger(logs),
      handle: async () => undefined,
    })

    try {
      await expect(server.start()).rejects.toThrow()
      // 不尝试杀死其他进程：外部 server 仍正常响应。
      const response = await fetch(`http://127.0.0.1:${occupiedPort}/`)
      expect(await response.text()).toBe('blocker-ok')
      expect(
        logs.some(
          (line) => line.event === 'state_warning' && String(line.reason).startsWith('http server error:'),
        ),
      ).toBe(true)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('close 断开保持中的空闲连接', async () => {
    const h = await startServer({ handle: async () => undefined })
    const port = Number(new URL(h.base).port)
    const socket = connect({ host: '127.0.0.1', port })
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    const socketClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()))

    await h.server.close()
    await socketClosed
    // 端口已释放：后续请求被拒绝。
    await expect(fetch(`${h.base}/livez`)).rejects.toThrow()
  })
})

describe('http server: readRequestBody', () => {
  function fakeRequest(): IncomingMessage {
    return new EventEmitter() as unknown as IncomingMessage
  }

  it('收集 data 到 end 返回完整缓冲', async () => {
    const req = fakeRequest()
    const pending = readRequestBody(req)
    req.emit('data', Buffer.from('ab'))
    req.emit('data', Buffer.from('cd'))
    req.emit('end')

    const result = await pending
    expect('body' in result && result.body.toString('utf8')).toBe('abcd')
  })

  it('空 body（仅 end）返回空缓冲', async () => {
    const req = fakeRequest()
    const pending = readRequestBody(req)
    req.emit('end')

    const result = await pending
    expect('body' in result && result.body.length).toBe(0)
  })

  it('error 事件 → readFailed', async () => {
    const req = fakeRequest()
    const pending = readRequestBody(req)
    req.emit('error', new Error('connection reset'))
    expect(await pending).toEqual({ readFailed: true })
    // 落定后再触发其他事件不改变结果、不抛错。
    req.emit('end')
    expect(await pending).toEqual({ readFailed: true })
  })

  it('aborted 事件 → readFailed', async () => {
    const req = fakeRequest()
    const pending = readRequestBody(req)
    req.emit('aborted')
    expect(await pending).toEqual({ readFailed: true })
  })

  it('仅 close（无 end/error/aborted）→ readFailed，promise 不悬挂', async () => {
    const req = fakeRequest()
    const pending = readRequestBody(req)
    req.emit('close')
    expect(await pending).toEqual({ readFailed: true })
  })

  it('超过 64 KiB → overflow，且继续 drain 到 end', async () => {
    const req = fakeRequest()
    const pending = readRequestBody(req)
    req.emit('data', Buffer.alloc(70_000))
    // 超限后仍在消费后续数据（不提前 destroy 连接）。
    req.emit('data', Buffer.from('tail'))
    req.emit('end')
    expect(await pending).toEqual({ overflow: true })
  })
})

describe('http server: routing basics', () => {
  it('命中的路径返回处理器应答，未命中的路径统一 404 且 content-type 为 JSON', async () => {
    const h = await startServer({
      handle: async (request) =>
        request.path === '/known' ? { status: 200, body: { ok: true } } : undefined,
    })

    const ok = await fetch(`${h.base}/known`)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('application/json')
    expect(await ok.json()).toEqual({ ok: true })

    const missing = await fetch(`${h.base}/nope`)
    expect(missing.status).toBe(404)
    expect(missing.headers.get('content-type')).toBe('application/json')
    expect(await missing.json()).toEqual({ error: 'not found' })
    expect(h.requests.map((request) => request.path)).toEqual(['/known', '/nope'])
  })

  it('路径去查询串；非 POST 不读 body（body 为 undefined）', async () => {
    const h = await startServer()

    const get = await fetch(`${h.base}/known?x=1&y=2`)
    expect(get.status).toBe(200)
    expect(h.requests[0]).toEqual({ method: 'GET', path: '/known', body: undefined })

    const put = await fetch(`${h.base}/known`, { method: 'PUT', body: 'ignored' })
    expect(put.status).toBe(200)
    expect(h.requests[1]).toEqual({ method: 'PUT', path: '/known', body: undefined })

    const post = await fetch(`${h.base}/known?x=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    })
    expect(post.status).toBe(200)
    expect(h.requests[2]).toEqual({ method: 'POST', path: '/known', body: { a: 1 } })
  })

  it('未知方法与未命中路径返回 404 {"error":"not found"}', async () => {
    const h = await startServer({ handle: async () => undefined })
    const response = await fetch(`${h.base}/known`, { method: 'DELETE' })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not found' })
  })
})

describe('http server: POST body handling', () => {
  it('非 JSON content-type → 400 invalid_request，处理器不被调用', async () => {
    const h = await startServer()
    const response = await fetch(`${h.base}/known`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x',
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: { code: 'invalid_request', message: 'content-type must be application/json' },
    })
    expect(h.requests).toHaveLength(0)
  })

  it('坏 JSON → 400 request body is not valid JSON', async () => {
    const h = await startServer()
    const response = await fetch(`${h.base}/known`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: { code: 'invalid_request', message: 'request body is not valid JSON' },
    })
    expect(h.requests).toHaveLength(0)
  })

  it('空 body 视为 {}', async () => {
    const h = await startServer()
    const response = await fetch(`${h.base}/known`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    })
    expect(response.status).toBe(200)
    expect(h.requests[0]?.body).toEqual({})
  })

  it('body 超过 64 KiB：drain 剩余数据后仍能收到 400（连接不提前销毁）', async () => {
    const h = await startServer()
    const response = await fetch(`${h.base}/known`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: 'x'.repeat(70_000) }),
    })

    // 客户端能读到 400（先消费完超限 body 再响应，不 destroy socket）。
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: { code: 'invalid_request', message: 'request body is too large' },
    })
    expect(h.requests).toHaveLength(0)
  })

  it('body 读取中断（客户端提前断开）→ 400，且不被误述为超限', async () => {
    const h = await startServer()
    const port = Number(new URL(h.base).port)

    // 裸 socket 声明 content-length: 50 只发 10 字节后半关闭（FIN）。Node 的 HTTP 解析器可能
    // 先于应用层以自带 400 应答；这里钉的可观察不变量是：中断路径得到 400，绝不出现
    // "request body is too large" 误述，处理器不被调用。
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port }, () => {
        socket.write(
          'POST /known HTTP/1.1\r\nHost: 127.0.0.1\r\ncontent-type: application/json\r\ncontent-length: 50\r\n\r\n',
        )
        socket.write('x'.repeat(10))
        socket.end()
      })
      let data = ''
      socket.on('data', (chunk) => {
        data += String(chunk)
        resolve(data)
        socket.destroy()
      })
      socket.on('close', () => resolve(data))
      socket.on('error', (err) => {
        if (data === '') {
          reject(err)
        }
      })
    })

    expect(response).toContain(' 400 ')
    expect(response).not.toContain('too large')
    expect(h.requests).toHaveLength(0)
  })

  it('处理器抛错 → 500 internal_error 并记 state_warning', async () => {
    const h = await startServer({
      handle: async () => {
        throw new Error('handler exploded')
      },
    })
    const response = await fetch(`${h.base}/known`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: { code: 'internal_error', message: 'internal error while handling the request' },
    })
    expect(
      h.logs.some(
        (line) => line.event === 'state_warning' && String(line.reason).includes('admin request failed: handler exploded'),
      ),
    ).toBe(true)
  })
})