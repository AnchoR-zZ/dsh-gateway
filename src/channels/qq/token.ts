import { redact } from '../../logging.js'

/**
 * QQ 凭证在线校验：一次 `POST https://bots.qq.com/app/getAppAccessToken`（body 为
 * `{"appId", "clientSecret"}`），HTTP 200 且响应含非空 `access_token` 即判定凭证有效，
 * 不建立 WebSocket 连接。端点形状与 SDK 内部取 token 路径一致
 * （`@tencent-connect/qqbot-nodejs` 的 token api）。
 *
 * 错误分两类：`rejected`（平台明确拒绝：非 200、响应缺 token、响应不可解析）与
 * `network`（不可达/超时/中断）；调用方据此决定是否允许 `--force` 跳过。错误消息不含
 * appSecret，上游错误正文片段经 `redact` 后截断附加。
 */

/** QQ 开放平台 token 端点。 */
export const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'

/** 单次校验请求的超时（毫秒）。 */
export const QQ_TOKEN_CHECK_TIMEOUT_MS = 10_000

/** 上游错误正文片段的最大长度。 */
const QQ_TOKEN_ERROR_SNIPPET_LENGTH = 200

/** 凭证校验失败；kind 区分平台拒绝与网络不可达，message 不含 appSecret。 */
export class QQCredentialCheckError extends Error {
  readonly kind: 'rejected' | 'network'

  constructor(kind: 'rejected' | 'network', message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'QQCredentialCheckError'
    this.kind = kind
  }
}

/** 凭证校验器： resolves 表示有效，抛 QQCredentialCheckError 表示无效。 */
export type QQCredentialValidator = (appId: string, appSecret: string) => Promise<void>

/** 上游 token 响应的最小形状。 */
interface TokenResponseBody {
  access_token?: unknown
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function snippet(text: string): string {
  return text === '' ? '' : ` — ${redact(text.slice(0, QQ_TOKEN_ERROR_SNIPPET_LENGTH))}`
}

/**
 * 创建凭证校验器。`fetchImpl` 与 `timeoutMs` 仅供测试注入；缺省使用全局 fetch 与
 * `QQ_TOKEN_CHECK_TIMEOUT_MS`。
 */
export function createQQTokenValidator(options?: {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): QQCredentialValidator {
  const doFetch: typeof fetch = options?.fetchImpl ?? fetch
  const timeoutMs: number = options?.timeoutMs ?? QQ_TOKEN_CHECK_TIMEOUT_MS
  return async (appId: string, appSecret: string): Promise<void> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    let response: Response
    try {
      response = await doFetch(QQ_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId, clientSecret: appSecret }),
        signal: controller.signal,
      })
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      throw new QQCredentialCheckError(
        'network',
        aborted
          ? `QQ token endpoint timed out after ${timeoutMs}ms`
          : `failed to reach the QQ token endpoint: ${errorMessage(err)}`,
        { cause: err },
      )
    } finally {
      clearTimeout(timer)
    }

    let bodyText = ''
    try {
      bodyText = await response.text()
    } catch (err) {
      throw new QQCredentialCheckError(
        'network',
        `failed to read the QQ token endpoint response: ${errorMessage(err)}`,
        { cause: err },
      )
    }

    if (!response.ok) {
      throw new QQCredentialCheckError(
        'rejected',
        `QQ token endpoint rejected the credentials: HTTP ${response.status}${snippet(bodyText)}`,
      )
    }
    let data: TokenResponseBody
    try {
      data = JSON.parse(bodyText) as TokenResponseBody
    } catch (err) {
      throw new QQCredentialCheckError('rejected', 'QQ token endpoint response was not valid JSON', {
        cause: err,
      })
    }
    if (typeof data.access_token !== 'string' || data.access_token === '') {
      throw new QQCredentialCheckError(
        'rejected',
        'QQ token endpoint response did not include an access_token',
      )
    }
  }
}
