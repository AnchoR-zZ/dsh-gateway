import { describe, expect, it, vi } from 'vitest'

import { createGatewayLogger } from '../src/logging.js'
import type { ChannelChangeResult, GatewayManagement, GatewayStatus, ManagementErrorCode } from '../src/management/contracts.js'
import { ManagementError } from '../src/management/contracts.js'
import { createHttpRoutes } from '../src/http/routes.js'
import type { ChannelSuccessBody, HttpReply } from '../src/http/protocol.js'

/**
 * HTTP 路由层测试：直接调用 `createHttpRoutes` 返回的处理器（不开端口），验证路径/方法分派、
 * 业务错误码 → 状态码映射、readyz 正文投影与异常上抛。传输层（body/JSON/限制/连接）由
 * http-server.test.ts 覆盖。
 */

interface LogLine {
  event: string
  [key: string]: unknown
}

function makeStatus(overrides?: Partial<GatewayStatus>): GatewayStatus {
  return {
    coreState: 'ready',
    stateStoreFailed: false,
    startedAt: '2026-10-01T00:00:00.000Z',
    pending: 0,
    running: 0,
    ready: true,
    channels: [],
    ...overrides,
  }
}

function makeHarness(options?: { status?: GatewayStatus }) {
  const status = options?.status ?? makeStatus()
  const addQQ = vi.fn(
    async (_input: unknown): Promise<ChannelChangeResult> => ({
      channel: 'qq:app-1',
      saved: true,
      state: 'online',
    }),
  )
  const enableQQ = vi.fn(
    async (_input: unknown): Promise<ChannelChangeResult> => ({
      channel: 'qq:app-1',
      saved: true,
      state: 'online',
    }),
  )
  const getStatus = vi.fn(() => status)
  const management: GatewayManagement = { getStatus, addQQ, enableQQ }
  const logs: LogLine[] = []
  const logger = createGatewayLogger({ debug: false, sink: (line) => logs.push(JSON.parse(line) as LogLine) })
  const routes = createHttpRoutes({ management, logger })
  return { routes, status, addQQ, enableQQ, getStatus, logs }
}

async function call(
  routes: ReturnType<typeof createHttpRoutes>,
  method: string,
  path: string,
  body?: unknown,
): Promise<HttpReply | undefined> {
  return routes({ method, path, body })
}

describe('http routes: probes', () => {
  it('GET /livez 恒 200 {"status":"ok"}，不查询管理状态', async () => {
    const h = makeHarness()
    const reply = await call(h.routes, 'GET', '/livez')
    expect(reply).toEqual({ status: 200, body: { status: 'ok' } })
    expect(h.getStatus).not.toHaveBeenCalled()
  })

  it('GET /readyz ready=true → 200，正文只含旧契约的五个键', async () => {
    const h = makeHarness({
      status: makeStatus({
        pending: 2,
        running: 1,
        channels: [
          { channelId: 'qq', appId: 'app-1', configured: true, enabled: true, state: 'online' },
          { channelId: 'qq', configured: false, enabled: false, state: 'not_configured' },
        ],
      }),
    })

    const reply = await call(h.routes, 'GET', '/readyz')

    expect(reply?.status).toBe(200)
    const body = reply!.body as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['channels', 'coreState', 'pending', 'running', 'startedAt'])
    expect(body).toEqual({
      coreState: 'ready',
      channels: { 'qq:app-1': 'online', qq: 'not_configured' },
      pending: 2,
      running: 1,
      startedAt: '2026-10-01T00:00:00.000Z',
    })
    expect(h.getStatus).toHaveBeenCalledTimes(1)
  })

  it('GET /readyz ready=false → 503，正文投影不变', async () => {
    const h = makeHarness({
      status: makeStatus({
        ready: false,
        coreState: 'stopping',
        channels: [
          { channelId: 'qq', appId: 'app-1', configured: true, enabled: true, state: 'blocked' },
        ],
      }),
    })

    const reply = await call(h.routes, 'GET', '/readyz')

    expect(reply?.status).toBe(503)
    expect(reply?.body).toEqual({
      coreState: 'stopping',
      channels: { 'qq:app-1': 'blocked' },
      pending: 0,
      running: 0,
      startedAt: '2026-10-01T00:00:00.000Z',
    })
  })
})

describe('http routes: channel management', () => {
  it('POST /channels/qq 把 body 原样交给 addQQ 并返回统一成功体', async () => {
    const h = makeHarness()

    const reply = await call(h.routes, 'POST', '/channels/qq', { appId: 'app-1', appSecret: 's', force: true })

    expect(h.addQQ).toHaveBeenCalledWith({ appId: 'app-1', appSecret: 's', force: true })
    expect(reply).toEqual({ status: 200, body: { ok: true, channel: 'qq:app-1', state: 'online' } })
  })

  it('add 结果带 detail 时响应附 detail，且不泄露内部 saved 字段', async () => {
    const h = makeHarness()
    h.addQQ.mockResolvedValueOnce({
      channel: 'qq:app-1',
      saved: true,
      state: 'blocked',
      detail: 'sdk start failed; the credentials were saved',
    })

    const reply = await call(h.routes, 'POST', '/channels/qq', {})

    const body = reply!.body as ChannelSuccessBody & Record<string, unknown>
    expect(reply?.status).toBe(200)
    expect(body).toEqual({
      ok: true,
      channel: 'qq:app-1',
      state: 'blocked',
      detail: 'sdk start failed; the credentials were saved',
    })
    expect(body.saved).toBeUndefined()
  })

  it('POST /channels/qq/enable 分派到 enableQQ 并返回成功体', async () => {
    const h = makeHarness()

    const reply = await call(h.routes, 'POST', '/channels/qq/enable', { appId: 'app-1' })

    expect(h.enableQQ).toHaveBeenCalledWith({ appId: 'app-1' })
    expect(reply).toEqual({ status: 200, body: { ok: true, channel: 'qq:app-1', state: 'online' } })
    expect(h.addQQ).not.toHaveBeenCalled()
  })

  it('ManagementError → {"error":{"code","message"}} + 固定状态码映射', async () => {
    const cases: readonly { code: ManagementErrorCode; status: number }[] = [
      { code: 'invalid_request', status: 400 },
      { code: 'app_id_required', status: 400 },
      { code: 'instance_not_found', status: 404 },
      { code: 'config_modified_externally', status: 409 },
      { code: 'credential_validation_failed', status: 422 },
      { code: 'gateway_not_ready', status: 503 },
      { code: 'gateway_stopping', status: 503 },
      { code: 'config_write_failed', status: 500 },
    ]
    for (const { code, status } of cases) {
      const h = makeHarness()
      h.addQQ.mockRejectedValueOnce(new ManagementError(code, `message for ${code}`))
      const reply = await call(h.routes, 'POST', '/channels/qq', {})
      expect(reply?.status, code).toBe(status)
      expect(reply?.body).toEqual({ error: { code, message: `message for ${code}` } })
    }
  })

  it('enable 路由同样映射 ManagementError', async () => {
    const h = makeHarness()
    h.enableQQ.mockRejectedValueOnce(new ManagementError('gateway_stopping', 'shutting down'))
    const reply = await call(h.routes, 'POST', '/channels/qq/enable', {})
    expect(reply).toEqual({ status: 503, body: { error: { code: 'gateway_stopping', message: 'shutting down' } } })
  })

  it('非 ManagementError 不吞，交给 server 记 500', async () => {
    const h = makeHarness()
    h.addQQ.mockRejectedValueOnce(new Error('handler exploded'))
    await expect(call(h.routes, 'POST', '/channels/qq', {})).rejects.toThrow('handler exploded')
  })
})

describe('http routes: unknown paths and methods', () => {
  it('未命中路径或方法返回 undefined，且不触发管理操作', async () => {
    const h = makeHarness()
    const cases: readonly { method: string; path: string; body?: unknown }[] = [
      { method: 'GET', path: '/channels/qq' },
      { method: 'PUT', path: '/channels/qq', body: {} },
      { method: 'GET', path: '/channels/qq/enable' },
      { method: 'POST', path: '/livez', body: {} },
      { method: 'POST', path: '/readyz', body: {} },
      { method: 'GET', path: '/unknown' },
      { method: 'DELETE', path: '/' },
    ]
    for (const item of cases) {
      expect(await call(h.routes, item.method, item.path, item.body), `${item.method} ${item.path}`).toBeUndefined()
    }
    expect(h.addQQ).not.toHaveBeenCalled()
    expect(h.enableQQ).not.toHaveBeenCalled()
    expect(h.getStatus).not.toHaveBeenCalled()
  })
})
