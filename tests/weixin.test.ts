import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWeixinApi, WeixinApiError } from '../src/channels/weixin/api.js'
import type { WeixinApi } from '../src/channels/weixin/api.js'
import { createWeixinChannel, normalizeWeixinMessage } from '../src/channels/weixin/index.js'
import { createWeixinManager } from '../src/channels/weixin/manager.js'
import { buildGatewayConfig, parseGatewayConfigDocument } from '../src/config/schema.js'
import type { GatewayConfigFile, WeixinChannelInstance } from '../src/config/schema.js'
import type { GatewayConfigStore } from '../src/config/store.js'
import type { InboundText } from '../src/contracts.js'
import type { CoreSnapshot } from '../src/core/contracts.js'
import { createGatewayLogger } from '../src/logging.js'

const instance: WeixinChannelInstance = { botId: 'bot-1@im.bot', userId: 'user-1@im.wechat', botToken: 'secret-token', baseUrl: 'https://ilinkai.weixin.qq.com', enabled: true }
const rawMessage = { message_type: 1, message_id: '123', from_user_id: instance.userId, context_token: 'secret-context', item_list: [{ type: 1, text_item: { text: '  你好  ' } }] }
const logger = createGatewayLogger({ debug: false, sink: () => undefined })
const tempDirs: string[] = []
function tempDir(): string { const dir = mkdtempSync(join(tmpdir(), 'weixin-test-')); tempDirs.push(dir); return dir }
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

describe('Weixin protocol', () => {
  it('sends authentication, cursor, text payload and CRLF without following redirects', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'next' }), { status: 200 }))
    const api = createWeixinApi(fetcher as unknown as typeof fetch)
    const signal = new AbortController().signal
    await api.updates(instance.baseUrl, instance.botToken, 'cursor', signal)
    await api.send(instance.baseUrl, instance.botToken, instance.botId, instance.userId, 'context', 'a\nb', signal)
    const updateCall = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(updateCall[0]).toBe('https://ilinkai.weixin.qq.com/ilink/bot/getupdates')
    expect(updateCall[1].redirect).toBe('error')
    expect(updateCall[1].headers).toMatchObject({ Authorization: 'Bearer secret-token', AuthorizationType: 'ilink_bot_token' })
    expect(JSON.parse(updateCall[1].body as string)).toMatchObject({ get_updates_buf: 'cursor', base_info: { channel_version: '2.0.0' } })
    const sendCall = fetcher.mock.calls[1] as unknown as [string, RequestInit]
    expect(JSON.parse(sendCall[1].body as string).msg).toMatchObject({ to_user_id: instance.userId, context_token: 'context', item_list: [{ type: 1, text_item: { text: 'a\r\nb' } }] })
    await expect(api.updates('https://evil.example', 'secret', '', signal)).rejects.toBeInstanceOf(WeixinApiError)
  })

  it('accepts only authorized private pure text with context token', () => {
    expect(normalizeWeixinMessage(rawMessage, instance.userId)).toMatchObject({ text: '你好', messageId: '123' })
    expect(normalizeWeixinMessage({ ...rawMessage, from_user_id: 'stranger' }, instance.userId)).toBeUndefined()
    expect(normalizeWeixinMessage({ ...rawMessage, group_id: 'group' }, instance.userId)).toBeUndefined()
    expect(normalizeWeixinMessage({ ...rawMessage, room: 'group' }, instance.userId)).toBeUndefined()
    expect(normalizeWeixinMessage({ ...rawMessage, context_token: '' }, instance.userId)).toBeUndefined()
    expect(normalizeWeixinMessage({ ...rawMessage, item_list: [...rawMessage.item_list, { type: 2, image_item: {} }] }, instance.userId)).toBeUndefined()
    expect(normalizeWeixinMessage({ ...rawMessage, item_list: [{ ...rawMessage.item_list[0], image_item: {} }] }, instance.userId)).toBeUndefined()
  })

  it('validates configuration, optional legacy field and trusted base URL', () => {
    expect(parseGatewayConfigDocument({ schemaVersion: 2 }, 'test').channels.weixin).toBeUndefined()
    expect(parseGatewayConfigDocument({ schemaVersion: 2, channels: { weixin: [instance] } }, 'test').channels.weixin).toEqual([instance])
    expect(() => parseGatewayConfigDocument({ schemaVersion: 2, channels: { weixin: [{ ...instance, baseUrl: 'https://qq.com.evil.example' }] } }, 'test')).toThrow()
    expect(() => parseGatewayConfigDocument({ schemaVersion: 2, channels: { weixin: [{ ...instance, userId: '../bad' }] } }, 'test')).toThrow()
  })

  it('classifies stale credentials without exposing the upstream error text', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ret: -14, errmsg: 'secret-token' }), { status: 200 }))
    const api = createWeixinApi(fetcher as unknown as typeof fetch)
    await expect(api.updates(instance.baseUrl, instance.botToken, '', new AbortController().signal)).rejects.toMatchObject({ code: -14, message: 'Weixin API error -14' })
  })
})

describe('Weixin channel', () => {
  it('admits the owner message, replies with its context and saves the cursor', async () => {
    const dir = tempDir()
    let inbound: InboundText | undefined
    const states: string[] = []
    const send = vi.fn(async () => undefined)
    let count = 0
    const api: WeixinApi = {
      begin: vi.fn(), qrStatus: vi.fn(), send,
      updates: vi.fn(async (_base, _token, _cursor, signal) => {
        if (count++ === 0) return { msgs: [rawMessage], get_updates_buf: 'next-cursor' }
        return new Promise<Record<string, unknown>>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      }),
    }
    const channel = createWeixinChannel({ instance, stateDir: dir, logger, api,
      core: { registerChannel: () => ({ setState: (state) => states.push(state), inbound: async (message) => { inbound = message; return { accepted: true, requestId: 'req' } }, disconnect: async () => undefined }) } })
    await channel.start()
    await vi.waitFor(() => expect(api.updates).toHaveBeenCalledTimes(2))
    expect(states).toContain('online')
    expect(inbound?.text).toBe('你好')
    expect((await inbound!.reply.deliver({ text: 'answer', notices: [], maxMessages: 4 })).status).toBe('sent')
    expect(send).toHaveBeenCalledWith(instance.baseUrl, instance.botToken, instance.botId, instance.userId, 'secret-context', 'answer', expect.any(AbortSignal))
    const files = (await import('node:fs')).readdirSync(join(dir, 'weixin'))
    expect(JSON.parse(readFileSync(join(dir, 'weixin', files[0]!), 'utf8'))).toEqual({ cursor: 'next-cursor' })
    await channel.stop()
  })

  it('marks an expired token blocked without retrying', async () => {
    const states: string[] = []
    const api: WeixinApi = { begin: vi.fn(), qrStatus: vi.fn(), send: vi.fn(), updates: vi.fn(async () => { throw new WeixinApiError(-14, 'stale') }) }
    const channel = createWeixinChannel({ instance, stateDir: tempDir(), logger, api,
      core: { registerChannel: () => ({ setState: (state) => states.push(state), inbound: vi.fn(), disconnect: async () => undefined }) } })
    await channel.start()
    await vi.waitFor(() => expect(states).toContain('blocked'))
    expect(api.updates).toHaveBeenCalledTimes(1)
    await channel.stop()
  })

  it('blocks the instance if the cursor cannot be saved and does not poll again', async () => {
    const dir = tempDir()
    const states: string[] = []
    const api: WeixinApi = { begin: vi.fn(), qrStatus: vi.fn(), send: vi.fn(), updates: vi.fn(async () => {
      writeFileSync(join(dir, 'weixin'), 'not-a-directory')
      return { msgs: [], get_updates_buf: 'next' }
    }) }
    const channel = createWeixinChannel({ instance, stateDir: dir, logger, api,
      core: { registerChannel: () => ({ setState: (state) => states.push(state), inbound: vi.fn(), disconnect: async () => undefined }) } })
    await channel.start()
    await vi.waitFor(() => expect(states).toContain('blocked'))
    expect(api.updates).toHaveBeenCalledOnce()
    await channel.stop()
  })
})

describe('Weixin management', () => {
  function fixture(api: WeixinApi) {
    let file = parseGatewayConfigDocument({ schemaVersion: 2, channels: { qq: [] } }, 'test')
    const store = { config: buildGatewayConfig('C:/workspace', file), get file() { return file }, update: async (mutate: (current: GatewayConfigFile) => GatewayConfigFile) => { file = parseGatewayConfigDocument(mutate(file), 'test'); return file } } as GatewayConfigStore
    const snapshot: CoreSnapshot = { state: 'ready', stateStoreFailed: false, startedAt: '', pending: 0, running: 0, channels: [] }
    const start = vi.fn(async () => undefined)
    const stop = vi.fn(async () => undefined)
    const manager = createWeixinManager({ store, api, logger, stateDir: 'unused', core: { registerChannel: vi.fn() }, queries: { snapshot: () => snapshot }, factory: () => ({ start, stop }) })
    return { manager, store, start, stop }
  }

  it('saves owner and credentials after QR confirmation and starts an instance', async () => {
    const api: WeixinApi = { begin: vi.fn(async () => ({ qrcode: 'qr-secret', qrcode_img_content: 'https://qr.example' })), qrStatus: vi.fn(async () => ({ status: 'confirmed', ilink_bot_id: instance.botId, ilink_user_id: instance.userId, bot_token: instance.botToken })), updates: vi.fn(), send: vi.fn() }
    const { manager, store, start } = fixture(api)
    expect(await manager.bindStart()).toEqual({ url: 'https://qr.example' })
    expect(await manager.bindWait()).toMatchObject({ channel: `weixin:${instance.botId}`, saved: true })
    expect(store.file.channels.weixin).toEqual([instance])
    expect(start).toHaveBeenCalledOnce()
    manager.beginShutdown()
    await manager.stopAll()
    expect(await manager.bindWait()).toMatchObject({ channel: `weixin:${instance.botId}`, saved: true })
  })

  it('fails clearly for verification-code requests or missing owner', async () => {
    for (const response of [{ status: 'need_verifycode' }, { status: 'confirmed', ilink_bot_id: instance.botId, bot_token: instance.botToken }, { status: 'scaned_but_redirect', redirect_host: 'qq.com.evil.example' }]) {
      const api: WeixinApi = { begin: vi.fn(async () => ({ qrcode: 'qr', qrcode_img_content: 'url' })), qrStatus: vi.fn(async () => response), updates: vi.fn(), send: vi.fn() }
      const { manager, store } = fixture(api)
      await manager.bindStart()
      await expect(manager.bindWait()).rejects.toMatchObject({ code: 'bind_failed' })
      expect(store.file.channels.weixin).toBeUndefined()
    }
  })

  it('reuses an in-flight QR session and aborts waiting callers during shutdown', async () => {
    let release!: (value: Record<string, unknown>) => void
    const begin = vi.fn(() => new Promise<Record<string, unknown>>((resolve) => { release = resolve }))
    const api: WeixinApi = { begin, qrStatus: vi.fn((_base, _qr, signal) => new Promise<Record<string, unknown>>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('abort')), { once: true }))), updates: vi.fn(), send: vi.fn() }
    const { manager } = fixture(api)
    const first = manager.bindStart()
    const second = manager.bindStart()
    expect(begin).toHaveBeenCalledOnce()
    release({ qrcode: 'qr', qrcode_img_content: 'url' })
    expect(await first).toEqual({ url: 'url' })
    expect(await second).toEqual({ url: 'url' })
    const waiting = manager.bindWait()
    manager.beginShutdown()
    await expect(waiting).rejects.toMatchObject({ code: 'gateway_stopping' })
    await manager.stopAll()
  })

  it('classifies cancellation while creating the QR code as gateway_stopping', async () => {
    const api: WeixinApi = {
      begin: (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      }),
      qrStatus: vi.fn(), updates: vi.fn(), send: vi.fn(),
    }
    const { manager, store, start } = fixture(api)
    const starting = manager.bindStart().catch((error: unknown) => error)
    const waiting = manager.bindWait().catch((error: unknown) => error)
    manager.beginShutdown()
    await manager.stopAll()
    expect(await starting).toMatchObject({ code: 'gateway_stopping' })
    expect(await waiting).toMatchObject({ code: 'gateway_stopping' })
    expect(store.file.channels.weixin).toBeUndefined()
    expect(start).not.toHaveBeenCalled()
  })

  it('replaces credentials for the same bot without creating a duplicate', async () => {
    let token = 'first-token'
    const api: WeixinApi = { begin: vi.fn(async () => ({ qrcode: 'qr', qrcode_img_content: 'url' })), qrStatus: vi.fn(async () => ({ status: 'confirmed', ilink_bot_id: instance.botId, ilink_user_id: instance.userId, bot_token: token })), updates: vi.fn(), send: vi.fn() }
    const { manager, store, start, stop } = fixture(api)
    await manager.bindStart()
    await manager.bindWait()
    token = 'second-token'
    await manager.bindStart()
    await manager.bindWait()
    expect(store.file.channels.weixin).toHaveLength(1)
    expect(store.file.channels.weixin?.[0]?.botToken).toBe('second-token')
    expect(start).toHaveBeenCalledTimes(2)
    expect(stop).toHaveBeenCalledOnce()
    manager.beginShutdown()
    await manager.stopAll()
  })
})
