import { describe, expect, it } from 'vitest'
import { parseChannelCommand, runChannelCommand } from '../src/cli.js'
import { DEFAULT_GATEWAY_HTTP_PORT } from '../src/http/protocol.js'
import type { ChannelCommand, CliIO } from '../src/cli.js'

/**
 * CLI 测试：参数解析纯函数 + 注入假 fetch/prompt 的请求映射与输出（不发真实请求）。
 * 交互输入（readline 回显抑制）不做自动测试。
 */

interface RecordedRequest {
  url: string
  init: { method: string; headers: Record<string, string>; body: string }
}

interface CliIOPatch {
  requests: RecordedRequest[]
  prompts: { question: string; secret?: boolean }[]
  answers: Record<string, string>
  lines: string[]
}

function createFakeIO(
  respond: (
    request: RecordedRequest,
  ) => { status: number; text(): Promise<string> } | Promise<{ status: number; text(): Promise<string> }>,
  answers: Record<string, string> = {},
): CliIO & CliIOPatch {
  const patch: CliIOPatch = { requests: [], prompts: [], answers, lines: [] }
  return {
    ...patch,
    async fetch(url, init) {
      const request: RecordedRequest = { url, init }
      patch.requests.push(request)
      return respond(request)
    },
    prompt(question, options) {
      patch.prompts.push({ question, secret: options?.secret })
      return Promise.resolve(patch.answers[question] ?? '')
    },
    print(text) {
      patch.lines.push(text)
    },
  }
}

function jsonReply(status: number, body: unknown): { status: number; text(): Promise<string> } {
  return { status, text: async () => JSON.stringify(body) }
}

describe('parseChannelCommand', () => {
  it('parses channel add qq with all flags', () => {
    expect(
      parseChannelCommand([
        'channel',
        'add',
        'qq',
        '--app-id',
        'app-1',
        '--app-secret',
        'secret-1',
        '--force',
        '--port',
        '18000',
      ]),
    ).toEqual({ kind: 'add', appId: 'app-1', appSecret: 'secret-1', force: true, port: 18000 })
  })

  it('defaults force to false and the port to 17890', () => {
    expect(parseChannelCommand(['channel', 'add', 'qq'])).toEqual({
      kind: 'add',
      appId: undefined,
      appSecret: undefined,
      force: false,
      port: DEFAULT_GATEWAY_HTTP_PORT,
    })
  })

  it('parses channel enable qq with an optional app id', () => {
    expect(parseChannelCommand(['channel', 'enable', 'qq'])).toEqual({
      kind: 'enable',
      appId: undefined,
      port: DEFAULT_GATEWAY_HTTP_PORT,
    })
    expect(parseChannelCommand(['channel', 'enable', 'qq', '--app-id', 'app-2', '--port', '9'])).toEqual({
      kind: 'enable',
      appId: 'app-2',
      port: 9,
    })
  })

  it('rejects the weixin channel as unsupported for both verbs', () => {
    expect(parseChannelCommand(['channel', 'add', 'weixin'])).toMatchObject({ kind: 'unsupported' })
    expect(parseChannelCommand(['channel', 'enable', 'weixin'])).toMatchObject({ kind: 'unsupported' })
    expect((parseChannelCommand(['channel', 'add', 'weixin']) as { message: string }).message).toContain(
      'weixin channel is not supported yet',
    )
  })

  it('rejects unknown verbs, channel types, options, and malformed values', () => {
    expect(parseChannelCommand([]).kind).toBe('invalid')
    expect(parseChannelCommand(['channels', 'add', 'qq']).kind).toBe('invalid')
    expect(parseChannelCommand(['channel', 'remove', 'qq']).kind).toBe('invalid')
    expect(parseChannelCommand(['channel', 'add', 'telegram']).kind).toBe('invalid')
    expect(parseChannelCommand(['channel', 'add', 'qq', '--extra', 'x']).kind).toBe('invalid')
    expect(parseChannelCommand(['channel', 'add', 'qq', '--extra=x']).kind).toBe('invalid')
    expect(parseChannelCommand(['channel', 'enable', 'qq', '--force']).kind).toBe('invalid')
    expect(parseChannelCommand(['channel', 'enable', 'qq', '--app-secret', 's']).kind).toBe('invalid')
    expect(parseChannelCommand(['channel', 'add', 'qq', '--app-id']).kind).toBe('invalid')
    expect(parseChannelCommand(['channel', 'add', 'qq', '--port', 'abc']).kind).toBe('invalid')
    expect(parseChannelCommand(['channel', 'add', 'qq', '--port', '0']).kind).toBe('invalid')
    expect(parseChannelCommand(['channel', 'add', 'qq', '--port', '65536']).kind).toBe('invalid')
    expect(parseChannelCommand(['channel', 'add', 'qq', '--port=abc']).kind).toBe('invalid')
    expect(parseChannelCommand(['channel', 'add', 'qq', '--force=yes']).kind).toBe('invalid')
  })

  it('parses the --flag=value form for value options', () => {
    expect(
      parseChannelCommand(['channel', 'add', 'qq', '--app-id=app-1', '--app-secret=secret-1', '--force', '--port=18000']),
    ).toEqual({ kind: 'add', appId: 'app-1', appSecret: 'secret-1', force: true, port: 18000 })
    expect(parseChannelCommand(['channel', 'enable', 'qq', '--app-id=app-2', '--port=9'])).toEqual({
      kind: 'enable',
      appId: 'app-2',
      port: 9,
    })
  })

  it('accepts values starting with -- in the = form (the P2-7 miss case)', () => {
    const command = parseChannelCommand(['channel', 'add', 'qq', '--app-id=a', '--app-secret=--not-a-flag'])
    expect(command).toMatchObject({ kind: 'add', appId: 'a', appSecret: '--not-a-flag' })
    // 两种形式可混用；= 形式的空值等价于提供了空字符串（后续按缺参走交互输入）。
    expect(parseChannelCommand(['channel', 'add', 'qq', '--app-id=', '--app-secret', 's'])).toMatchObject({
      kind: 'add',
      appId: '',
      appSecret: 's',
    })
  })
})

describe('runChannelCommand', () => {
  it('maps add flags to POST /channels/qq with force, and prints success', async () => {
    const io = createFakeIO(() => jsonReply(200, { ok: true, channel: 'qq:app-1', state: 'online' }))
    const command = parseChannelCommand([
      'channel',
      'add',
      'qq',
      '--app-id',
      'app-1',
      '--app-secret',
      'secret-1',
      '--force',
    ]) as Extract<ChannelCommand, { kind: 'add' }>

    const code = await runChannelCommand(command, io)

    expect(code).toBe(0)
    expect(io.requests).toHaveLength(1)
    expect(io.requests[0]!.url).toBe(`http://127.0.0.1:${DEFAULT_GATEWAY_HTTP_PORT}/channels/qq`)
    expect(io.requests[0]!.init.method).toBe('POST')
    expect(io.requests[0]!.init.headers['content-type']).toBe('application/json')
    expect(JSON.parse(io.requests[0]!.init.body)).toEqual({ appId: 'app-1', appSecret: 'secret-1', force: true })
    expect(io.lines).toEqual(['ok: qq:app-1 is online'])
  })

  it('maps enable without app id to an empty body on POST /channels/qq/enable', async () => {
    const io = createFakeIO(() => jsonReply(200, { ok: true, channel: 'qq:app-1', state: 'online' }))
    const command = parseChannelCommand(['channel', 'enable', 'qq', '--port', '18111'])

    const code = await runChannelCommand(command, io)

    expect(code).toBe(0)
    expect(io.requests[0]!.url).toBe('http://127.0.0.1:18111/channels/qq/enable')
    expect(JSON.parse(io.requests[0]!.init.body)).toEqual({})
  })

  it('prompts interactively for missing app id and secret (secret prompt not echoed)', async () => {
    const io = createFakeIO(
      () => jsonReply(200, { ok: true, channel: 'qq:app-9', state: 'online' }),
      { 'QQ App ID: ': 'app-9', 'QQ App Secret: ': 'secret-9' },
    )
    const command = parseChannelCommand(['channel', 'add', 'qq'])

    const code = await runChannelCommand(command, io)

    expect(code).toBe(0)
    expect(io.prompts).toEqual([
      { question: 'QQ App ID: ', secret: undefined },
      { question: 'QQ App Secret: ', secret: true },
    ])
    expect(JSON.parse(io.requests[0]!.init.body)).toEqual({ appId: 'app-9', appSecret: 'secret-9', force: false })
  })

  it('reports blocked state as an explicit error with a non-zero exit code', async () => {
    const io = createFakeIO(() => jsonReply(200, {
      ok: true,
      channel: 'qq:app-1',
      state: 'blocked',
      detail: 'sdk start failed; the credentials were saved',
    }))
    const command = parseChannelCommand(['channel', 'add', 'qq', '--app-id', 'app-1', '--app-secret', 's', '--force'])

    const code = await runChannelCommand(command, io)

    expect(code).toBe(1)
    expect(io.lines[0]).toContain('error')
    expect(io.lines[0]).toContain('blocked')
    expect(io.lines[0]).toContain('credentials were saved')
  })

  it('prints the error message and code for an HTTP error response', async () => {
    const io = createFakeIO(() => jsonReply(422, {
      error: { code: 'credential_validation_failed', message: 'QQ token endpoint rejected the credentials: HTTP 401' },
    }))
    const command = parseChannelCommand(['channel', 'add', 'qq', '--app-id', 'a', '--app-secret', 's'])

    const code = await runChannelCommand(command, io)

    expect(code).toBe(1)
    expect(io.lines[0]).toContain('credential_validation_failed')
    expect(io.lines[0]).toContain('HTTP 401')
  })

  it('hints to start the gateway first when the connection is refused', async () => {
    const io = createFakeIO(() => {
      throw new TypeError('fetch failed')
    })
    const command = parseChannelCommand(['channel', 'enable', 'qq'])

    const code = await runChannelCommand(command, io)

    expect(code).toBe(1)
    expect(io.lines[0]).toContain('start the gateway service first')
  })

  it('prints the unsupported message for weixin without issuing a request', async () => {
    const io = createFakeIO(() => jsonReply(200, {}))
    const command = parseChannelCommand(['channel', 'add', 'weixin'])

    const code = await runChannelCommand(command, io)

    expect(code).toBe(1)
    expect(io.lines[0]).toContain('weixin channel is not supported yet')
    expect(io.requests).toHaveLength(0)
  })

  it('reports unavailable interactive input (stdin closed/EOF) with a flag hint and exits non-zero', async () => {
    // stdin 关闭时 readline question 回调不触发（rl 'close' → prompt reject）：给明确报错，
    // 不悬挂、不把"没有输入"当空答案。
    const io = createFakeIO(() => jsonReply(200, {}))
    io.prompt = () => Promise.reject(new Error('stdin closed'))
    const command = parseChannelCommand(['channel', 'add', 'qq'])

    const code = await runChannelCommand(command, io)

    expect(code).toBe(1)
    expect(io.lines).toEqual([
      'error: interactive input is unavailable (stdin closed); pass --app-id/--app-secret explicitly (the --flag=value form also works)',
    ])
    expect(io.requests).toHaveLength(0)
  })
})
