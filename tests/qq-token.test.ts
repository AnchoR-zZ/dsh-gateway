import { describe, expect, it } from 'vitest'
import { createQQTokenValidator, QQ_TOKEN_URL, QQCredentialCheckError } from '../src/channels/qq/token.js'

/**
 * QQ 凭证在线校验测试：注入假 fetch，无真实网络。覆盖有效凭证、平台拒绝（非 200/缺
 * token/坏 JSON）、网络不可达与超时；错误消息不含 appSecret。
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface RecordedCall {
  url: string
  init: RequestInit
}

function createRecordingFetch(
  impl: (call: RecordedCall, signal: AbortSignal) => Promise<Response>,
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(url),
      init: init ?? {},
    }
    calls.push(call)
    return impl(call, (init?.signal as AbortSignal | undefined) ?? new AbortController().signal)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('createQQTokenValidator', () => {
  it('resolves for HTTP 200 with an access_token and posts the expected body', async () => {
    const { fetchImpl, calls } = createRecordingFetch(async () =>
      jsonResponse(200, { access_token: 'tok', expires_in: 7200 }),
    )
    const validate = createQQTokenValidator({ fetchImpl })

    await expect(validate('app-1', 'secret-1')).resolves.toBeUndefined()

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(QQ_TOKEN_URL)
    expect(calls[0]!.init.method).toBe('POST')
    expect(String(calls[0]!.init.body)).toBe(JSON.stringify({ appId: 'app-1', clientSecret: 'secret-1' }))
  })

  it('rejects with kind=rejected for a non-200 response and includes the status', async () => {
    const { fetchImpl } = createRecordingFetch(async () => jsonResponse(401, { message: 'invalid secret' }))
    const validate = createQQTokenValidator({ fetchImpl })

    const error = await validate('app-1', 'secret-1').catch((err: unknown) => err)
    expect(error).toBeInstanceOf(QQCredentialCheckError)
    const check = error as QQCredentialCheckError
    expect(check.kind).toBe('rejected')
    expect(check.message).toContain('HTTP 401')
    expect(check.message).not.toContain('secret-1')
  })

  it('rejects with kind=rejected when the response lacks access_token', async () => {
    const { fetchImpl } = createRecordingFetch(async () => jsonResponse(200, { expires_in: 7200 }))
    const validate = createQQTokenValidator({ fetchImpl })

    await expect(validate('app-1', 'secret-1')).rejects.toThrow(/did not include an access_token/)
  })

  it('rejects with kind=rejected for a non-JSON 200 body', async () => {
    const { fetchImpl } = createRecordingFetch(
      async () => new Response('<html>oops</html>', { status: 200 }),
    )
    const validate = createQQTokenValidator({ fetchImpl })

    const error = await validate('app-1', 'secret-1').catch((err: unknown) => err)
    expect((error as QQCredentialCheckError).kind).toBe('rejected')
    expect((error as Error).message).toContain('not valid JSON')
  })

  it('rejects with kind=network when the endpoint is unreachable', async () => {
    const { fetchImpl } = createRecordingFetch(async () => {
      throw new TypeError('fetch failed')
    })
    const validate = createQQTokenValidator({ fetchImpl })

    const error = await validate('app-1', 'secret-1').catch((err: unknown) => err)
    expect((error as QQCredentialCheckError).kind).toBe('network')
    expect((error as Error).message).toContain('failed to reach the QQ token endpoint')
    expect((error as Error).message).not.toContain('secret-1')
  })

  it('rejects with kind=network on timeout', async () => {
    const { fetchImpl } = createRecordingFetch(
      (_call, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const abortError = new Error('The operation was aborted')
            abortError.name = 'AbortError'
            reject(abortError)
          })
        }),
    )
    const validate = createQQTokenValidator({ fetchImpl, timeoutMs: 30 })

    const error = await validate('app-1', 'secret-1').catch((err: unknown) => err)
    expect((error as QQCredentialCheckError).kind).toBe('network')
    expect((error as Error).message).toContain('timed out after 30ms')
  })
})
