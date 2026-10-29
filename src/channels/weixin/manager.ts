import type { GatewayConfigStore } from '../../config/store.js'
import { GatewayConfigConflictError } from '../../config/store.js'
import { parseGatewayConfigDocument } from '../../config/schema.js'
import type { WeixinChannelInstance } from '../../config/schema.js'
import type { GatewayCore } from '../../contracts.js'
import type { CoreQueries } from '../../core/contracts.js'
import type { GatewayLogger } from '../../logging.js'
import { ManagementError } from '../../management/contracts.js'
import type { ChannelChangeResult } from '../../management/contracts.js'
import { WEIXIN_DEFAULT_BASE_URL, trustedBaseUrl } from './api.js'
import type { WeixinApi } from './api.js'
import { createWeixinChannel } from './index.js'
import type { WeixinChannel } from './index.js'

export interface WeixinManagerOptions {
  store: GatewayConfigStore
  core: GatewayCore
  queries: CoreQueries
  logger: GatewayLogger
  api: WeixinApi
  stateDir: string
  factory?: typeof createWeixinChannel
}

export interface WeixinManager {
  startConfigured(): Promise<void>
  bindStart(): Promise<{ url: string }>
  bindWait(): Promise<ChannelChangeResult>
  enable(body: unknown): Promise<ChannelChangeResult>
  beginShutdown(): void
  stopAll(): Promise<void>
}

interface WeixinBindSession {
  controller: AbortController
  start: Promise<{ url: string }>
  done: Promise<ChannelChangeResult>
  abort(): void
  terminal: boolean
}

function required(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function waitDelay(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    timer.unref?.()
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    signal.addEventListener('abort', done, { once: true })
  })
}

export function createWeixinManager(options: WeixinManagerOptions): WeixinManager {
  const { store, core, queries, logger, api, stateDir } = options
  const runtimes = new Map<string, WeixinChannel>()
  const tails = new Map<string, Promise<unknown>>()
  let shuttingDown = false
  let bind: WeixinBindSession | undefined

  function assertReady(): void {
    if (shuttingDown) throw new ManagementError('gateway_stopping', 'the gateway is shutting down')
    if (queries.snapshot().state !== 'ready') throw new ManagementError('gateway_not_ready', 'the gateway core is not ready')
  }
  function serialize<T>(id: string, op: () => Promise<T>): Promise<T> {
    const next = (tails.get(id) ?? Promise.resolve()).catch(() => undefined).then(op)
    tails.set(id, next)
    void next.finally(() => { if (tails.get(id) === next) tails.delete(id) }).catch(() => undefined)
    return next
  }
  function state(id: string) {
    return queries.snapshot().channels.find((channel) => channel.channelId === 'weixin' && channel.accountId === id)?.state ?? 'blocked'
  }
  async function startInstance(instance: WeixinChannelInstance): Promise<ChannelChangeResult> {
    return serialize(instance.botId, async () => {
      const old = runtimes.get(instance.botId)
      if (old) { await old.stop(); runtimes.delete(instance.botId) }
      if (shuttingDown) return { channel: `weixin:${instance.botId}`, saved: true, state: 'blocked', detail: 'gateway is shutting down' }
      // 使用最新配置避免并发扫码和 enable 造成旧凭据覆盖。
      const current = store.file.channels.weixin?.find((item) => item.botId === instance.botId)
      if (!current || !current.enabled) return { channel: `weixin:${instance.botId}`, saved: true, state: 'disabled' }
      let channel: WeixinChannel | undefined
      try {
        channel = (options.factory ?? createWeixinChannel)({ instance: current, stateDir, core, logger, api })
        runtimes.set(current.botId, channel)
        await channel.start()
        if (shuttingDown) { await channel.stop(); runtimes.delete(current.botId); return { channel: `weixin:${current.botId}`, saved: true, state: 'blocked' } }
        return { channel: `weixin:${current.botId}`, saved: true, state: state(current.botId) }
      } catch {
        await channel?.stop().catch(() => undefined)
        runtimes.delete(current.botId)
        logger.logEvent('manual_restart_required', { channelId: 'weixin', reason: 'Weixin channel failed to start' })
        return { channel: `weixin:${current.botId}`, saved: true, state: 'blocked', detail: 'channel could not be started; configuration was saved' }
      }
    })
  }
  async function saveInstance(instance: WeixinChannelInstance): Promise<ChannelChangeResult> {
    try {
      const saved = await store.update((current) => {
        assertReady()
        const list = [...(current.channels.weixin ?? [])]
        const index = list.findIndex((item) => item.botId === instance.botId)
        if (index < 0) list.push(instance)
        else list[index] = { ...instance, enabled: list[index]!.enabled }
        return { ...current, channels: { ...current.channels, weixin: list } }
      })
      const item = saved.channels.weixin!.find((entry) => entry.botId === instance.botId)!
      return startInstance(item)
    } catch (error) {
      if (error instanceof ManagementError) throw error
      if (error instanceof GatewayConfigConflictError) throw new ManagementError('config_modified_externally', 'the gateway config was modified externally')
      throw new ManagementError('config_write_failed', 'failed to save Weixin configuration')
    }
  }
  async function runBind(signal: AbortSignal, publish: (url: string) => void): Promise<ChannelChangeResult> {
    assertReady()
    const first = await api.begin(signal)
    signal.throwIfAborted()
    const qr = required(first.qrcode) ?? required(first.qr_code)
    const url = required(first.qrcode_img_content) ?? required(first.qrcode_url)
    if (!qr || !url) throw new ManagementError('bind_failed', 'Weixin did not return a QR code')
    publish(url)
    let base = WEIXIN_DEFAULT_BASE_URL
    const expires = Date.now() + (typeof first.expires_in === 'number' && first.expires_in > 0 ? first.expires_in * 1000 : 120_000)
    while (!signal.aborted && Date.now() < expires) {
      let response: Record<string, unknown>
      try { response = await api.qrStatus(base, qr, AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, expires - Date.now()))])) }
      catch {
        if (signal.aborted) break
        await waitDelay(signal, Math.max(0, Math.min(3000, expires - Date.now())))
        continue
      }
      signal.throwIfAborted()
      const rawStatus = response.status ?? response.qrcode_status ?? response.qr_status
      const status = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : rawStatus
      if (status === 2 || (typeof status === 'string' && ['confirmed', 'confirm', 'authorized', 'success', 'ok'].includes(status))) {
        const botId = required(response.ilink_bot_id) ?? required(response.bot_id)
        const userId = required(response.ilink_user_id)
        const botToken = required(response.bot_token) ?? required(response.token)
        let baseUrl: string
        try { baseUrl = trustedBaseUrl(required(response.baseurl) ?? required(response.base_url) ?? base) }
        catch { throw new ManagementError('bind_failed', 'Weixin returned an untrusted API address') }
        if (!botId || !userId || !botToken) throw new ManagementError('bind_failed', 'Weixin did not return a complete bot identity, owner, and token')
        const instance = { botId, userId, botToken, baseUrl, enabled: true }
        try { parseGatewayConfigDocument({ schemaVersion: 2, channels: { weixin: [instance] } }, 'Weixin bind') }
        catch { throw new ManagementError('bind_failed', 'Weixin returned invalid bot credentials or identities') }
        assertReady()
        return saveInstance(instance)
      }
      if (status === 3 || status === 4 || (typeof status === 'string' && ['expired', 'timeout', 'cancel', 'cancelled', 'canceled'].includes(status))) throw new ManagementError('bind_expired', 'Weixin QR code expired; start binding again')
      if (status === 'need_verifycode' || status === 'verify_code_blocked') throw new ManagementError('bind_failed', 'Weixin requires a verification code; this flow is not supported')
      if (status === 'scaned_but_redirect') {
        try { base = trustedBaseUrl(`https://${required(response.redirect_host) ?? ''}`) }
        catch { throw new ManagementError('bind_failed', 'Weixin returned an untrusted redirect') }
      } else if (status === 'binded_redirect' || status === 'error' || status === 'failed') {
        throw new ManagementError('bind_failed', 'Weixin binding failed')
      }
      await waitDelay(signal, Math.max(0, Math.min(3000, expires - Date.now())))
    }
    if (signal.aborted || shuttingDown) throw new ManagementError('gateway_stopping', 'the gateway is shutting down')
    throw new ManagementError('bind_expired', 'Weixin QR code expired; start binding again')
  }
  function bindStart(): Promise<{ url: string }> {
    assertReady()
    if (bind && !bind.terminal) return bind.start
    const controller = new AbortController()
    let resolveStart!: (result: { url: string }) => void
    let rejectStart!: (error: unknown) => void
    const start = new Promise<{ url: string }>((resolve, reject) => { resolveStart = resolve; rejectStart = reject })
    let abort!: () => void
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new ManagementError('gateway_stopping', 'the gateway is shutting down'))
    })
    const session: WeixinBindSession = { controller, start, done: undefined as unknown as Promise<ChannelChangeResult>, abort, terminal: false }
    bind = session
    // 对外终态不等待上游请求响应 abort；迟到结果由 runBind 的取消检查挡住。
    session.done = Promise.race([aborted, runBind(controller.signal, (url) => resolveStart({ url }))]).catch((error: unknown) => {
      const safe = error instanceof ManagementError ? error : new ManagementError('bind_failed', 'Weixin binding failed')
      rejectStart(safe)
      throw safe
    }).finally(() => { session.terminal = true })
    void session.done.catch(() => undefined)
    return start
  }
  async function enable(body: unknown): Promise<ChannelChangeResult> {
    assertReady()
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ManagementError('invalid_request', 'body must be an object')
    const obj = body as Record<string, unknown>
    if (Object.keys(obj).some((key) => key !== 'botId') || (obj.botId !== undefined && !required(obj.botId))) throw new ManagementError('invalid_request', 'invalid botId')
    const configured = store.file.channels.weixin ?? []
    const id = required(obj.botId) ?? (configured.length === 1 ? configured[0]!.botId : undefined)
    if (!id) throw new ManagementError('app_id_required', 'botId is required unless exactly one instance is configured')
    if (!configured.some((entry) => entry.botId === id)) throw new ManagementError('instance_not_found', 'Weixin instance not found')
    const saved = await store.update((current) => {
      assertReady()
      return { ...current, channels: { ...current.channels, weixin: (current.channels.weixin ?? []).map((item) => item.botId === id ? { ...item, enabled: true } : item) } }
    }).catch((error: unknown) => {
      if (error instanceof ManagementError) throw error
      if (error instanceof GatewayConfigConflictError) throw new ManagementError('config_modified_externally', 'the gateway config was modified externally')
      throw new ManagementError('config_write_failed', 'failed to save Weixin configuration')
    })
    const current = saved.channels.weixin!.find((item) => item.botId === id)!
    if (state(id) === 'online') return { channel: `weixin:${id}`, saved: true, state: 'online' }
    return startInstance(current)
  }
  return {
    async startConfigured() {
      for (const initial of store.config.weixinInstances) {
        if (shuttingDown) break
        const current = store.file.channels.weixin?.find((item) => item.botId === initial.botId)
        if (current?.enabled && !runtimes.has(current.botId)) await startInstance(current)
      }
    },
    bindStart,
    bindWait: () => bind ? bind.done : Promise.reject(new ManagementError('bind_not_started', 'Weixin binding has not started')),
    enable,
    beginShutdown() {
      shuttingDown = true
      if (bind && !bind.terminal) {
        // 先作废等待方，再取消上游，避免把上游 AbortError 误报为 bind_failed。
        bind.abort()
        bind.controller.abort()
      }
    },
    async stopAll() {
      // HTTP 在本方法返回后关闭；先让二维码创建和结果等待请求拿到停机终态。
      await Promise.allSettled(bind ? [bind.start, bind.done] : [])
      await Promise.allSettled(tails.values())
      await Promise.allSettled([...runtimes.values()].map((channel) => channel.stop()))
      runtimes.clear()
    },
  }
}
