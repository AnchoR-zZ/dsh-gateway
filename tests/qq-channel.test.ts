import { describe, expect, it } from 'vitest'

import { GATEWAY_LIMITS } from '../src/contracts.js'
import type { ChannelIngress, ChannelRegistration, GatewayCore, InboundText } from '../src/contracts.js'
import type { GatewayLogger } from '../src/logging.js'
import { NOTICE_TEXTS } from '../src/qq/markdown.js'
import { createQQChannel } from '../src/qq/index.js'
import type { QQBotCtorOptions, QQBotLike, QQChannelEventMap } from '../src/qq/index.js'

/**
 * QQ 渠道组装测试：替身 bot 工厂 + 替身 core/ingress，全程无真实网络。
 * FakeBot 的 start()/stop() 语义镜像 SDK：start 挂起直到 stop，stop 同步释放并让
 * start promise 自然 resolve；认证失败用 reject 的 startImpl 模拟。
 */

interface Deferred {
  promise: Promise<void>
  resolve: () => void
  reject: (err: unknown) => void
}

function createDeferred(): Deferred {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class FakeBot implements QQBotLike {
  readonly ops: string[]
  readonly used: unknown[][] = []
  readonly handlers = new Map<string, unknown>()
  readonly sentTexts: { target: { scope: 'c2c'; targetId: string; msgId?: string }; content: string }[] = []
  startCalls = 0
  stopCalls = 0
  ctorOptions: QQBotCtorOptions | undefined
  sendImpl: (target: { scope: 'c2c'; targetId: string; msgId?: string }, content: string) => Promise<unknown> = () =>
    Promise.resolve({ id: 'sent' })
  startImpl: () => Promise<void> = () => this.startDeferred.promise
  private readonly startDeferred = createDeferred()

  constructor(ops: string[]) {
    this.ops = ops
  }

  use(...middleware: unknown[]): unknown {
    this.used.push(middleware)
    return this
  }

  on<K extends keyof QQChannelEventMap>(event: K, handler: QQChannelEventMap[K]): unknown {
    this.handlers.set(event, handler as unknown)
    return this
  }

  emit(event: keyof QQChannelEventMap, ...args: unknown[]): unknown {
    const handler = this.handlers.get(event) as ((...a: unknown[]) => unknown) | undefined
    if (handler === undefined) {
      throw new Error(`no handler bound for ${String(event)}`)
    }
    return handler(...args)
  }

  start(_signal?: AbortSignal): Promise<void> {
    this.startCalls += 1
    this.ops.push('bot.start')
    return this.startImpl()
  }

  stop(): void {
    this.stopCalls += 1
    this.ops.push('bot.stop')
    // 镜像 SDK：stop 同步释放，start() promise 随后自然 resolve。
    this.startDeferred.resolve()
  }

  sendText(
    target: { scope: 'c2c'; targetId: string; msgId?: string },
    content: string,
  ): Promise<unknown> {
    this.sentTexts.push({ target, content })
    return this.sendImpl(target, content)
  }
}

type InboundResult =
  | { accepted: true; requestId: string }
  | { accepted: false; reason: 'busy' | 'expired' | 'stopping' | 'unavailable' }

class FakeIngress implements ChannelIngress {
  readonly states: string[] = []
  readonly inboundMessages: InboundText[] = []
  disconnectCalls = 0
  inboundResult: InboundResult = { accepted: true, requestId: 'req-1' }

  setState(state: 'connecting' | 'online' | 'reconnecting' | 'blocked'): void {
    this.states.push(state)
  }

  async inbound(message: InboundText): Promise<InboundResult> {
    this.inboundMessages.push(message)
    return this.inboundResult
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1
  }
}

class Harness {
  readonly ops: string[] = []
  readonly logs: { event: string; fields?: Record<string, unknown> }[] = []
  readonly registrations: ChannelRegistration[] = []
  readonly ingress = new FakeIngress()
  readonly bot: FakeBot
  readonly channel: ReturnType<typeof createQQChannel>
  readonly core: GatewayCore = {
    registerChannel: (registration: ChannelRegistration): ChannelIngress => {
      this.ops.push('register')
      this.registrations.push(registration)
      return this.ingress
    },
  }
  private readonly logger: GatewayLogger = {
    logEvent: (event, fields) => {
      this.logs.push({ event, fields: fields as Record<string, unknown> | undefined })
    },
    debugBody: () => undefined,
  }

  constructor(options: { sdkLogSink?: (line: string) => void; now?: () => number } = {}) {
    this.bot = new FakeBot(this.ops)
    this.channel = createQQChannel({
      appId: 'app-1',
      appSecret: 'secret-1',
      core: this.core,
      logger: this.logger,
      limits: { ...GATEWAY_LIMITS },
      // 测试消息时间戳固定为 TS；默认把墙钟钉在回复窗口内，使拒绝提示路径可发送。
      now: options.now ?? (() => RECEIVED + 1_000),
      sdkLogSink: options.sdkLogSink,
      botFactory: (opts) => {
        this.bot.ctorOptions = opts
        return this.bot
      },
    })
  }

  find(event: string): { event: string; fields?: Record<string, unknown> }[] {
    return this.logs.filter((l) => l.event === event)
  }
}

const TS = '2026-10-01T10:00:00.000Z'
const RECEIVED = Date.parse(TS)

function c2cMsg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rawEventType: 'C2C_MESSAGE_CREATE',
    kind: 'c2c',
    senderId: 'user-1',
    content: '  hello world  ',
    messageId: 'msg-1',
    timestamp: TS,
    attachments: undefined,
    msgType: 0,
    replyTarget: { scope: 'c2c', targetId: 'user-1', msgId: 'msg-1' },
    ...over,
  }
}

function messageWithId(id: string): Record<string, unknown> {
  return c2cMsg({ messageId: id, replyTarget: { scope: 'c2c', targetId: 'user-1', msgId: id } })
}

async function startedHarness(): Promise<Harness> {
  const h = new Harness()
  await h.channel.start()
  return h
}

describe('启动装配（5.1、3.1、13.1）', () => {
  it('注册渠道先于 bot.start，且只装载 messageFilter 一个中间件', async () => {
    const h = await startedHarness()
    expect(h.ops).toEqual(['register', 'bot.start'])
    expect(h.bot.used).toHaveLength(1)
    expect(typeof h.bot.used[0]?.[0]).toBe('function')
    expect(h.registrations[0]).toMatchObject({ channelId: 'qq', accountId: 'app-1' })
  })

  it('QQBot 构造参数固定：C2C intents、markdown、websocket、sync token 预取', async () => {
    const h = await startedHarness()
    expect(h.bot.ctorOptions).toMatchObject({
      appId: 'app-1',
      appSecret: 'secret-1',
      intents: 1 << 25,
      markdownSupport: true,
      transport: 'websocket',
      tokenPrefetch: 'sync',
    })
  })

  it('QQBot 构造注入 SDK logger：error 调用经脱敏转发到独立 sdk_log sink', async () => {
    const sdkLines: string[] = []
    const h = new Harness({ sdkLogSink: (line) => sdkLines.push(line) })
    await h.channel.start()
    const sdkLogger = h.bot.ctorOptions?.logger
    expect(sdkLogger).toBeDefined()
    expect(typeof sdkLogger?.info).toBe('function')
    expect(typeof sdkLogger?.error).toBe('function')

    sdkLogger!.error('token fetch failed: token=abc123')

    expect(sdkLines).toHaveLength(1)
    const parsed = JSON.parse(sdkLines[0]!) as { event: string; level: string; message: string; time: string }
    expect(parsed.event).toBe('sdk_log')
    expect(parsed.level).toBe('error')
    expect(parsed.message).toBe('token fetch failed: token=[REDACTED]')
    expect(typeof parsed.time).toBe('string')
    // SDK 日志不进 GatewayLogger 的事件流。
    expect(h.logs.some((l) => l.event === 'sdk_log')).toBe(false)
  })

  it('启动即上报 connecting', async () => {
    const h = await startedHarness()
    expect(h.ingress.states[0]).toBe('connecting')
  })

  it('start 幂等：重复调用不再注册或启动', async () => {
    const h = await startedHarness()
    await h.channel.start()
    expect(h.ops).toEqual(['register', 'bot.start'])
    expect(h.bot.startCalls).toBe(1)
  })

  it('注册失败（core 重复注册）→ 记录 manual_restart_required 并上抛', async () => {
    const h = new Harness()
    const err = new Error('duplicate channel account')
    h.core.registerChannel = () => {
      throw err
    }
    await expect(h.channel.start()).rejects.toThrow('duplicate channel account')
    expect(h.find('manual_restart_required')).toHaveLength(1)
    expect(h.bot.startCalls).toBe(0)
  })

  it('方案 B：start 失败 → stop → 同实例重试 start 为无操作，不产生漏停的新 bot', async () => {
    const h = new Harness()
    h.core.registerChannel = () => {
      throw new Error('duplicate channel account')
    }
    await expect(h.channel.start()).rejects.toThrow('duplicate channel account')
    // 失败后外部 stop：无 bot、无副作用，但本生命周期的 stop 缓存已落。
    await h.channel.stop()
    // 即使注册恢复可用，同实例重试也必须是无操作（一次性实例，重启走新实例）。
    const seen: ChannelRegistration[] = []
    h.core.registerChannel = (reg) => {
      seen.push(reg)
      return h.ingress
    }
    await h.channel.start()
    expect(seen).toHaveLength(0)
    expect(h.bot.startCalls).toBe(0)
    // stop 仍幂等可用，且不存在需要停止的新 bot。
    await h.channel.stop()
    expect(h.bot.stopCalls).toBe(0)
  })
})

describe('入站处理（5.2 步骤 6）', () => {
  it('合法消息 → ingress.inbound 收到规范字段并记录 queued', async () => {
    const h = await startedHarness()
    await h.bot.emit('message', undefined, c2cMsg())
    expect(h.ingress.inboundMessages).toHaveLength(1)
    const m = h.ingress.inboundMessages[0]!
    expect(m.peerId).toBe('user-1')
    expect(m.messageId).toBe('msg-1')
    expect(m.text).toBe('hello world')
    expect(m.receivedAt).toBe(RECEIVED)
    expect(m.replyPolicy).toEqual({
      maxMessages: GATEWAY_LIMITS.QQ_MAX_MESSAGES_PER_INBOUND,
      expiresAt: RECEIVED + GATEWAY_LIMITS.QQ_PASSIVE_REPLY_WINDOW_MS,
    })
    expect(typeof m.reply.deliver).toBe('function')
    expect(typeof m.reply.close).toBe('function')
    // queued 只在 core 侧记录（字段更全），渠道侧不双写。
    expect(h.find('queued')).toHaveLength(0)
  })

  it('msgType 过滤在适配器层生效：非 0 类型不入 core', async () => {
    const h = await startedHarness()
    await h.bot.emit('message', undefined, c2cMsg({ msgType: 3 }))
    expect(h.ingress.inboundMessages).toHaveLength(0)
    expect(h.find('inbound_ignored')).toHaveLength(1)
    expect(h.find('inbound_ignored')[0]?.fields?.reason).toBe('non-text-type')
  })

  it('带附件消息整条忽略，不保留文字', async () => {
    const h = await startedHarness()
    await h.bot.emit('message', undefined, c2cMsg({ attachments: [{ content_type: 'image/png', url: 'x' }] }))
    expect(h.ingress.inboundMessages).toHaveLength(0)
    expect(h.find('inbound_ignored')[0]?.fields?.reason).toBe('has-attachments')
  })
})

describe('ingress 拒绝与独立发送槽（6.2、10.4）', () => {
  it('busy → busy 文案经独立槽发送一次（msgId 用本条 replyTarget）', async () => {
    const h = await startedHarness()
    h.ingress.inboundResult = { accepted: false, reason: 'busy' }
    await h.bot.emit('message', undefined, c2cMsg())
    expect(h.bot.sentTexts).toHaveLength(1)
    expect(h.bot.sentTexts[0]).toEqual({
      target: { scope: 'c2c', targetId: 'user-1', msgId: 'msg-1' },
      content: NOTICE_TEXTS.busy,
    })
    expect(h.find('inbound_rejected')).toHaveLength(1)
    expect(h.find('inbound_rejected')[0]?.fields?.reason).toBe('busy')
  })

  it('stopping / unavailable 分别映射 service-stopping / state-unavailable 文案', async () => {
    const h = await startedHarness()
    h.ingress.inboundResult = { accepted: false, reason: 'stopping' }
    await h.bot.emit('message', undefined, messageWithId('m-stop'))
    h.ingress.inboundResult = { accepted: false, reason: 'unavailable' }
    await h.bot.emit('message', undefined, messageWithId('m-unavail'))
    expect(h.bot.sentTexts.map((s) => s.content)).toEqual([
      NOTICE_TEXTS['service-stopping'],
      NOTICE_TEXTS['state-unavailable'],
    ])
  })

  it('expired 拒绝只记录，不发送任何文案', async () => {
    const h = await startedHarness()
    h.ingress.inboundResult = { accepted: false, reason: 'expired' }
    await h.bot.emit('message', undefined, c2cMsg())
    expect(h.bot.sentTexts).toHaveLength(0)
    expect(h.find('inbound_rejected')[0]?.fields?.reason).toBe('expired')
  })

  it('回复窗口已过的 busy 拒绝：跳过发送，只记日志（10.4）', async () => {
    const h = new Harness({
      now: () => RECEIVED + GATEWAY_LIMITS.QQ_PASSIVE_REPLY_WINDOW_MS + 1,
    })
    await h.channel.start()
    h.ingress.inboundResult = { accepted: false, reason: 'busy' }
    await h.bot.emit('message', undefined, c2cMsg())
    expect(h.bot.sentTexts).toHaveLength(0)
    const skipped = h
      .find('inbound_rejected')
      .find((l) => l.fields?.reason === 'notice reply window expired')
    expect(skipped).toBeDefined()
    expect(skipped?.fields?.outcome).toBe('busy')
  })

  it('4 槽满时只记日志不发；槽释放后可再次发送', async () => {
    const h = await startedHarness()
    h.ingress.inboundResult = { accepted: false, reason: 'busy' }
    const hanging: Deferred[] = []
    h.bot.sendImpl = () => {
      const d = createDeferred()
      hanging.push(d)
      return d.promise.then(() => ({ id: 'sent' }))
    }
    for (let i = 0; i < 4; i += 1) {
      await h.bot.emit('message', undefined, messageWithId(`m-${i}`))
    }
    expect(h.bot.sentTexts).toHaveLength(4)
    // 第 5 条：槽满，只记日志。
    await h.bot.emit('message', undefined, messageWithId('m-4'))
    expect(h.bot.sentTexts).toHaveLength(4)
    const slotFull = h.find('inbound_rejected').find((l) => String(l.fields?.reason).includes('notice slots full'))
    expect(slotFull).toBeDefined()
    expect(slotFull?.fields?.outcome).toBe('busy')
    // 全部释放后，新拒绝可再次占用槽。
    for (const d of hanging) {
      d.resolve()
    }
    await new Promise((r) => setTimeout(r, 5))
    await h.bot.emit('message', undefined, messageWithId('m-5'))
    expect(h.bot.sentTexts).toHaveLength(5)
  })
})

describe('连接状态映射（13.3）', () => {
  it('ready / resumed → online', async () => {
    const h = await startedHarness()
    h.bot.emit('ready', undefined)
    h.bot.emit('resumed', undefined)
    expect(h.ingress.states.slice(-2)).toEqual(['online', 'online'])
  })

  it('error → reconnecting 并记录 channel_reconnecting', async () => {
    const h = await startedHarness()
    h.bot.emit('error', new Error('socket hang up'))
    expect(h.ingress.states[h.ingress.states.length - 1]).toBe('reconnecting')
    expect(h.find('channel_reconnecting')).toHaveLength(1)
  })

  it('disconnected(willReconnect=true) → reconnecting', async () => {
    const h = await startedHarness()
    h.bot.emit('disconnected', { code: 1000, reason: 'gateway requested reconnect', willReconnect: true })
    expect(h.ingress.states[h.ingress.states.length - 1]).toBe('reconnecting')
  })

  it('disconnected(willReconnect=false) → blocked 并记录 manual_restart_required', async () => {
    const h = await startedHarness()
    h.bot.emit('disconnected', { code: 4915, reason: 'disallowed intents', willReconnect: false })
    expect(h.ingress.states[h.ingress.states.length - 1]).toBe('blocked')
    expect(h.find('manual_restart_required')).toHaveLength(1)
  })
})

describe('bot.start() 后台化与失败归因（13.1、13.3）', () => {
  it('认证失败 reject → blocked + manual_restart_required，无 unhandled rejection', async () => {
    const h = new Harness()
    h.bot.startImpl = () => Promise.reject(new Error('invalid credentials'))
    await h.channel.start()
    await new Promise((r) => setTimeout(r, 5))
    expect(h.ingress.states).toContain('blocked')
    const fatal = h.find('manual_restart_required')
    expect(fatal).toHaveLength(1)
    expect(String(fatal[0]?.fields?.reason)).toContain('invalid credentials')
  })

  it('GATEWAY_FATAL_CLOSE → blocked', async () => {
    const h = new Harness()
    const gwErr = Object.assign(new Error('gateway fatal close 4915'), { code: 'GATEWAY_FATAL_CLOSE' })
    h.bot.startImpl = () => Promise.reject(gwErr)
    await h.channel.start()
    await new Promise((r) => setTimeout(r, 5))
    expect(h.ingress.states).toContain('blocked')
    const reason = String(h.find('manual_restart_required')[0]?.fields?.reason)
    expect(reason).toContain('GATEWAY_FATAL_CLOSE')
    // 归因行附处置指引：重跑 enable 拉起新实例，重启仅兜底。
    expect(reason).toContain('dsh-gateway channel enable qq')
    expect(reason).toContain('fallback')
  })
})

describe('stop 与 stopReceiving（4.2、9.3）', () => {
  it('stop：bot.stop 同步调用并等待后台 start 结束；幂等', async () => {
    const h = await startedHarness()
    await h.channel.stop()
    await h.channel.stop()
    expect(h.bot.stopCalls).toBe(1)
    expect(h.ops).toEqual(['register', 'bot.start', 'bot.stop'])
  })

  it('stop 经 ingress.disconnect 从 core 注销本实例，且幂等只断开一次', async () => {
    const h = await startedHarness()
    await h.channel.stop()
    await h.channel.stop()
    expect(h.ingress.disconnectCalls).toBe(1)
  })

  it('注册失败（无 ingress）时 stop 不触发 disconnect', async () => {
    const h = new Harness()
    h.core.registerChannel = () => {
      throw new Error('duplicate channel account')
    }
    await expect(h.channel.start()).rejects.toThrow('duplicate channel account')
    await h.channel.stop()
    expect(h.ingress.disconnectCalls).toBe(0)
  })

  it('注册的 stopReceiving 与 stop 等价作用于 bot', async () => {
    const h = await startedHarness()
    await h.registrations[0]!.stopReceiving()
    expect(h.bot.stopCalls).toBe(1)
    // 已停止后 stop 不再重复调用。
    await h.channel.stop()
    expect(h.bot.stopCalls).toBe(1)
  })
})
