import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WeixinChannelInstance } from '../../config/schema.js'
import { GATEWAY_LIMITS } from '../../contracts.js'
import type { ChannelIngress, GatewayCore, NoticeKind } from '../../contracts.js'
import type { GatewayLogger } from '../../logging.js'
import { NOTICE_TEXTS } from '../qq/markdown.js'
import { createQQReplyPort } from '../qq/reply-port.js'
import { WeixinApiError } from './api.js'
import type { WeixinApi } from './api.js'

export interface WeixinChannel {
  start(): Promise<void>
  stop(): Promise<void>
}

export interface WeixinChannelOptions {
  instance: WeixinChannelInstance
  stateDir: string
  core: GatewayCore
  logger: GatewayLogger
  api: WeixinApi
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** 仅允许扫码用户的私聊纯文本；上下文 token 不进入日志或持久化。 */
export function normalizeWeixinMessage(raw: unknown, userId: string): { peerId: string; messageId: string; text: string; context: string } | undefined {
  const message = record(raw)
  if (!message || message.message_type !== 1 || message.from_user_id !== userId ||
    message.group_id || message.room_id || message.room || message.roomId || message.chat_id || message.chatId) return undefined
  if (typeof message.context_token !== 'string' || !message.context_token) return undefined
  if (!Array.isArray(message.item_list) || message.item_list.length === 0) return undefined
  const items = message.item_list.map(record)
  if (items.some((item) => !item || item.type !== 1 || typeof record(item.text_item)?.text !== 'string' ||
    item.image_item !== undefined || item.voice_item !== undefined || item.file_item !== undefined || item.video_item !== undefined)) return undefined
  const text = items.map((item) => record(item!.text_item)!.text as string).join('\n').trim()
  if (!text) return undefined
  const id = message.message_id ?? message.client_id ?? message.seq
  const messageId = typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id)) ? String(id) : randomUUID()
  return { peerId: userId, messageId, text, context: message.context_token }
}

function cursorPath(stateDir: string, botId: string): string {
  return join(stateDir, 'weixin', `${createHash('sha256').update(botId).digest('hex')}.json`)
}

async function readCursor(path: string): Promise<string> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    const cursor = record(value)?.cursor
    if (typeof cursor !== 'string') throw new Error('invalid cursor')
    return cursor
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw new Error('failed to load Weixin cursor')
  }
}

async function saveCursor(path: string, cursor: string): Promise<void> {
  const temporary = `${path}.tmp`
  await mkdir(join(path, '..'), { recursive: true })
  try {
    await writeFile(temporary, JSON.stringify({ cursor }), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw new Error('failed to save Weixin cursor')
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    timer.unref?.()
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    signal.addEventListener('abort', done, { once: true })
  })
}

export function createWeixinChannel(options: WeixinChannelOptions): WeixinChannel {
  const { instance, stateDir, core, logger, api } = options
  const controller = new AbortController()
  const path = cursorPath(stateDir, instance.botId)
  let ingress: ChannelIngress | undefined
  let polling: Promise<void> | undefined
  let stopped: Promise<void> | undefined
  let rejectionSends = 0

  function isolate(reason: string): void {
    ingress?.setState('blocked')
    logger.logEvent('manual_restart_required', { channelId: 'weixin', reason })
    controller.abort()
  }

  async function send(peer: string, context: string, text: string): Promise<void> {
    try { await api.send(instance.baseUrl, instance.botToken, instance.botId, peer, context, text, controller.signal) }
    catch (error) {
      if (error instanceof WeixinApiError && error.code === -14) isolate('Weixin token expired; bind again')
      throw error
    }
  }

  async function handle(raw: unknown): Promise<void> {
    const message = normalizeWeixinMessage(raw, instance.userId)
    if (!message || !ingress || controller.signal.aborted) return
    const receivedAt = Date.now()
    const expiresAt = receivedAt + 3_600_000
    const reply = createQQReplyPort({ msgId: message.messageId, targetId: message.peerId, expiresAt,
      maxMessages: 4, logger, limits: { ...GATEWAY_LIMITS, QQ_MESSAGE_MAX_LENGTH: 2000 },
      sender: { send: (_id, peer, text) => send(peer, message.context, text) },
      onSendStuck: () => isolate('Weixin send timed out; enable the instance again'),
    })
    const result = await ingress.inbound({ peerId: message.peerId, messageId: message.messageId, text: message.text,
      receivedAt, replyPolicy: { expiresAt, maxMessages: 4 }, reply })
    if (!result.accepted) {
      reply.close()
      if (result.reason === 'expired' || controller.signal.aborted || rejectionSends >= GATEWAY_LIMITS.BUSY_NOTICE_SLOTS) return
      const notices: Record<'busy' | 'stopping' | 'unavailable', NoticeKind> = { busy: 'busy', stopping: 'service-stopping', unavailable: 'state-unavailable' }
      rejectionSends++
      void send(message.peerId, message.context, NOTICE_TEXTS[notices[result.reason]]).catch(() => {
        logger.logEvent('reply_failed', { channelId: 'weixin', reason: 'rejection notice failed' })
      }).finally(() => { rejectionSends-- })
    }
  }

  async function loop(cursor: string): Promise<void> {
    while (!controller.signal.aborted) {
      let response: Record<string, unknown>
      try {
        response = await api.updates(instance.baseUrl, instance.botToken, cursor, controller.signal)
      } catch (error) {
        if (controller.signal.aborted) break
        if (error instanceof WeixinApiError && error.code === -14) {
          ingress?.setState('blocked')
          logger.logEvent('manual_restart_required', { channelId: 'weixin', reason: 'Weixin token expired; bind again' })
          break
        }
        ingress?.setState('reconnecting')
        await delay(5000, controller.signal)
        continue
      }
      if (controller.signal.aborted) break
      ingress?.setState('online')
      try {
        const messages = response.msgs
        if (messages !== undefined && !Array.isArray(messages)) throw new Error('invalid messages')
        for (const message of messages ?? []) {
          if (controller.signal.aborted) return
          await handle(message)
        }
        if (controller.signal.aborted) return
        const next = response.get_updates_buf
        if (typeof next === 'string' && next !== '' && next !== cursor) {
          await saveCursor(path, next)
          cursor = next
        }
      } catch {
        ingress?.setState('blocked')
        logger.logEvent('manual_restart_required', { channelId: 'weixin', reason: 'Weixin batch or cursor processing failed' })
        break
      }
    }
  }

  async function stopReceiving(): Promise<void> {
    controller.abort()
    await polling
  }
  return {
    async start() {
      const cursor = await readCursor(path)
      if (controller.signal.aborted) throw new Error('channel stopped')
      ingress = core.registerChannel({ channelId: 'weixin', accountId: instance.botId, stopReceiving })
      polling = loop(cursor)
    },
    stop() {
      stopped ??= (async () => { await stopReceiving(); await ingress?.disconnect() })()
      return stopped
    },
  }
}
