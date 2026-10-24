import { describe, expect, it } from 'vitest'
import { createGatewayLogger, redact } from '../src/logging.js'

interface SinkHarness {
  lines: string[]
  sink: (line: string) => void
}

function makeSink(): SinkHarness {
  const lines: string[] = []
  return { lines, sink: (line: string) => lines.push(line) }
}

function parseLines(harness: SinkHarness): Record<string, unknown>[] {
  return harness.lines.map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('createGatewayLogger.logEvent', () => {
  it('writes exactly one JSON line containing event and a valid ISO time', () => {
    const harness = makeSink()
    createGatewayLogger({ debug: false, sink: harness.sink }).logEvent('queued', {
      requestId: 'req-1',
      turn: 3,
    })
    expect(harness.lines).toHaveLength(1)
    const parsed = parseLines(harness)[0]
    expect(parsed.event).toBe('queued')
    expect(typeof parsed.time).toBe('string')
    expect(Number.isNaN(Date.parse(parsed.time as string))).toBe(false)
    expect(parsed.requestId).toBe('req-1')
    expect(parsed.turn).toBe(3)
  })

  it('omits fields whose value is undefined', () => {
    const harness = makeSink()
    createGatewayLogger({ debug: false, sink: harness.sink }).logEvent('reply_sent', {
      requestId: 'req-1',
      error: undefined,
      outcome: undefined,
    })
    const parsed = parseLines(harness)[0]
    expect(parsed).not.toHaveProperty('error')
    expect(parsed).not.toHaveProperty('outcome')
    expect(parsed.requestId).toBe('req-1')
  })

  it('redacts the error field before serialization', () => {
    const harness = makeSink()
    createGatewayLogger({ debug: false, sink: harness.sink }).logEvent('turn_failed', {
      error: 'request failed: Authorization: Bearer abc.def.ghi',
    })
    const parsed = parseLines(harness)[0]
    // Authorization 头的值保守替换到行尾，前缀说明文字保留。
    expect(parsed.error).toBe('request failed: Authorization: [REDACTED]')
  })

  it('works without a fields argument', () => {
    const harness = makeSink()
    createGatewayLogger({ debug: false, sink: harness.sink }).logEvent('shutdown')
    const parsed = parseLines(harness)[0]
    expect(parsed.event).toBe('shutdown')
    expect(Object.keys(parsed).sort()).toEqual(['event', 'time'])
  })
})

describe('createGatewayLogger.debugBody', () => {
  it('is a no-op when debug is disabled', () => {
    const harness = makeSink()
    const logger = createGatewayLogger({ debug: false, sink: harness.sink })
    logger.debugBody('inbound', 'hello with "secret": "hunter2"')
    expect(harness.lines).toHaveLength(0)
  })

  it('emits a redacted debug_body line when debug is enabled', () => {
    const harness = makeSink()
    createGatewayLogger({ debug: true, sink: harness.sink }).debugBody(
      'outbound',
      'reply with "secret": "hunter2" inside',
      { requestId: 'req-1', outputLength: 27 },
    )
    expect(harness.lines).toHaveLength(1)
    const parsed = parseLines(harness)[0]
    expect(parsed.event).toBe('debug_body')
    expect(parsed.kind).toBe('outbound')
    expect(parsed.text).toBe('reply with "secret": "[REDACTED]" inside')
    expect(parsed.requestId).toBe('req-1')
    expect(parsed.outputLength).toBe(27)
  })

  it('marks inbound bodies distinctly from outbound bodies', () => {
    const harness = makeSink()
    const logger = createGatewayLogger({ debug: true, sink: harness.sink })
    logger.debugBody('inbound', 'user text')
    logger.debugBody('outbound', 'agent text')
    const kinds = parseLines(harness).map((line) => line.kind)
    expect(kinds).toEqual(['inbound', 'outbound'])
  })
})

describe('redact', () => {
  it('redacts Authorization headers of any scheme', () => {
    expect(redact('Authorization: Bearer abc123')).toBe('Authorization: [REDACTED]')
    expect(redact('authorization: Basic dXNlcjpwYXNz')).toBe('authorization: [REDACTED]')
  })

  it('redacts standalone Bearer tokens', () => {
    expect(redact('Bearer abc.def.ghi tail')).toBe('Bearer [REDACTED] tail')
  })

  it('redacts secret values in JSON string field form', () => {
    expect(redact('{"secret": "value1"}')).toBe('{"secret": "[REDACTED]"}')
    expect(redact('{"appSecret":"abc","other":"keep"}')).toBe(
      '{"appSecret":"[REDACTED]","other":"keep"}',
    )
  })

  it('redacts token= and secret: assignment forms', () => {
    expect(redact('token=abcdef123&next=2')).toBe('token=[REDACTED]&next=2')
    expect(redact('DSH_GATEWAY_QQ_APP_SECRET=abc123 tail')).toBe(
      'DSH_GATEWAY_QQ_APP_SECRET=[REDACTED] tail',
    )
  })

  it('leaves plain text without credential shapes untouched', () => {
    const plain = '普通回复正文，无凭证形态。Markdown with `code` and a list.'
    expect(redact(plain)).toBe(plain)
  })
})
