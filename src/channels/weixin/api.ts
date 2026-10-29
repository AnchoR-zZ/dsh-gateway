import { randomInt, randomUUID } from 'node:crypto'
import { isTrustedWeixinBaseUrl } from '../../config/schema.js'

export const WEIXIN_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const PREFIX = '/ilink/bot'

export class WeixinApiError extends Error {
  constructor(readonly code: number | undefined, message: string) { super(message) }
}

export function trustedBaseUrl(raw: string): string {
  const base = raw.replace(/\/$/, '')
  if (!isTrustedWeixinBaseUrl(base)) throw new WeixinApiError(undefined, 'invalid Weixin API origin')
  return base
}

export interface WeixinApi {
  begin(signal: AbortSignal): Promise<Record<string, unknown>>
  qrStatus(baseUrl: string, qr: string, signal: AbortSignal): Promise<Record<string, unknown>>
  updates(baseUrl: string, token: string, cursor: string, signal: AbortSignal): Promise<Record<string, unknown>>
  send(baseUrl: string, token: string, botId: string, userId: string, context: string, text: string, signal: AbortSignal): Promise<void>
}

export function createWeixinApi(fetcher: typeof fetch = fetch): WeixinApi {
  async function request(base: string, endpoint: string, init: RequestInit, timeoutMs: number, signal: AbortSignal): Promise<Record<string, unknown>> {
    let response: Response
    const timeout = AbortSignal.timeout(timeoutMs)
    try {
      response = await fetcher(`${trustedBaseUrl(base)}${PREFIX}${endpoint}`, {
        ...init, redirect: 'error', signal: AbortSignal.any([signal, timeout]),
      })
    } catch (error) {
      if (signal.aborted) throw error
      if (timeout.aborted) throw new WeixinApiError(-10001, 'Weixin request timed out')
      throw new WeixinApiError(undefined, 'Weixin network request failed or timed out')
    }
    if (!response.ok) throw new WeixinApiError(response.status, `Weixin HTTP ${response.status}`)
    const raw: unknown = await response.json()
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new WeixinApiError(undefined, 'invalid Weixin response')
    const payload = raw as Record<string, unknown>
    const data = typeof payload.data === 'object' && payload.data !== null && !Array.isArray(payload.data)
      ? { ...payload, ...(payload.data as Record<string, unknown>) } : payload
    const code = typeof data.errcode === 'number' && data.errcode !== 0 ? data.errcode :
      typeof data.ret === 'number' && data.ret !== 0 ? data.ret : 0
    if (code !== 0) throw new WeixinApiError(code, `Weixin API error ${code}`)
    return data
  }
  function auth(token: string): Record<string, string> {
    return { 'content-type': 'application/json', AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${token}`, 'X-WECHAT-UIN': Buffer.from(String(randomInt(0, 0x1_0000_0000))).toString('base64') }
  }
  function post(base: string, token: string, path: string, body: object, signal: AbortSignal, timeout: number) {
    return request(base, path, { method: 'POST', headers: auth(token), body: JSON.stringify({ base_info: { channel_version: '2.0.0' }, ...body }) }, timeout, signal)
  }
  return {
    begin: (signal) => request(WEIXIN_DEFAULT_BASE_URL, '/get_bot_qrcode?bot_type=3', { headers: { 'iLink-App-ClientVersion': '1' } }, 30_000, signal),
    qrStatus: (base, qr, signal) => request(base, `/get_qrcode_status?qrcode=${encodeURIComponent(qr)}`, { headers: { 'iLink-App-ClientVersion': '1' } }, 35_000, signal),
    async updates(base, token, cursor, signal) {
      try { return await post(base, token, '/getupdates', { get_updates_buf: cursor }, signal, 90_000) }
      catch (error) {
        if (error instanceof WeixinApiError && error.code === -10001) return { msgs: [], get_updates_buf: cursor }
        throw error
      }
    },
    async send(base, token, botId, userId, context, text, signal) {
      await post(base, token, '/sendmessage', { msg: { from_user_id: botId, to_user_id: userId,
        client_id: `dsh-gateway-${randomUUID()}`, message_type: 2, message_state: 2,
        context_token: context, item_list: [{ type: 1, text_item: { text: text.replace(/\r\n|\r|\n/g, '\r\n') } }] } }, signal, 40_000)
    },
  }
}
