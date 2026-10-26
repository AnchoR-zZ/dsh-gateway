import { GatewayErrorCode, QQBot, messageFilter } from '@tencent-connect/qqbot-nodejs'
import type { Logger as SdkLogger, QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs'
import type { ChannelIngress, GATEWAY_LIMITS, GatewayCore, NoticeKind } from '../../contracts.js'
import { redact } from '../../logging.js'
import type { GatewayLogger } from '../../logging.js'
import { NOTICE_TEXTS } from './markdown.js'
import { normalizeC2CMessage } from './inbound.js'
import type { NormalizedC2CMessage } from './inbound.js'
import { createQQReplyPort, raceSendTimeout, SEND_TIMED_OUT } from './reply-port.js'
import type { QQSender } from './reply-port.js'

/**
 * QQ 渠道适配器组装（设计文档 3.1、5.1、5.2 步骤 6、6.2、10.3、13.1、13.3）：
 * 注册渠道 → 装载 messageFilter（仅此一个中间件）→ 绑定事件 → bot.start() 后台化。
 * 模块顶层不创建 QQBot 实例、不发起网络连接（实例在 start() 内按注入的 botFactory
 * 或真实构造函数创建）；测试全部用替身 bot 工厂，无真实网络。
 *
 * SDK 原生日志（连接/鉴权等 SDK 内部 debug/info/warn/error）经 createSdkLoggerAdapter
 * 脱敏后转发到独立 JSON 行 sink（默认 console.error，事件名 sdk_log），不进入
 * GatewayLogger 的 GatewayLogEvent 联合——网关事件表保持自有语义，SDK 日志只用于联调排障。
 *
 * 状态映射：ready/resumed → online；可恢复 error/disconnected(willReconnect) →
 * reconnecting；永久拒绝（GATEWAY_FATAL_CLOSE / GATEWAY_RETRY_EXHAUSTED / 认证失败）
 * 与出站隔离 → blocked + manual_restart_required。重连本身委托 SDK（13.3）。
 */

/** SDK 网关断连事件的结构子集（对应 SDK GatewayDisconnect）。 */
export interface GatewayDisconnectLike {
  code: number
  reason: string
  willReconnect: boolean
}

/** 本渠道消费的 SDK 事件集合（QQBotEventMap 子集；ctx 不参与渠道逻辑）。 */
export interface QQChannelEventMap {
  ready: (data: unknown) => void
  resumed: (data: unknown) => void
  disconnected: (event: GatewayDisconnectLike) => void
  error: (err: Error) => void
  message: (ctx: unknown, msg: QQBotInboundMessage) => void | Promise<void>
}

/** QQBot 的最小结构接口：渠道只使用 use/on/start/stop/sendText。 */
export interface QQBotLike {
  use(...middleware: unknown[]): unknown
  on<K extends keyof QQChannelEventMap>(event: K, handler: QQChannelEventMap[K]): unknown
  start(signal?: AbortSignal): Promise<void>
  stop(): void
  sendText(target: { scope: 'c2c'; targetId: string; msgId?: string }, content: string): Promise<unknown>
}

/**
 * 组装 QQBot 时的构造参数（QQBotOptions 的子集，固定值见 5.1；logger 为脱敏转发适配器）。
 */
export interface QQBotCtorOptions {
  appId: string
  appSecret: string
  intents: number
  markdownSupport: boolean
  transport: 'websocket'
  tokenPrefetch: 'sync'
  /** SDK 原生日志适配器（SDK Logger 接口），转发到独立 sdk_log sink。 */
  logger: SdkLogger
}

/** C2C 与群消息的最小 intents 位（SDK 常量 GROUP_AND_C2C = 1 << 25，包未导出单值）。 */
export const QQ_C2C_INTENTS = 1 << 25

export interface QQChannelOptions {
  appId: string
  appSecret: string
  core: GatewayCore
  logger: GatewayLogger
  limits: typeof GATEWAY_LIMITS
  /** 测试注入替身 bot 工厂；缺省用真实 new QQBot(...)。 */
  botFactory?: (opts: QQBotCtorOptions) => QQBotLike
  /** 墙钟（毫秒）；默认 Date.now。 */
  now?: () => number
  /** SDK 原生日志（sdk_log JSON 行）的独立 sink；默认 console.error，测试注入替身收集。 */
  sdkLogSink?: (line: string) => void
}

export interface QQChannel {
  /**
   * 组装并启动：注册渠道 → 装载 messageFilter → 绑定事件 → bot.start() 后台化。幂等；
   * 启动失败即本实例终局（同实例重试为无操作），重启走新实例（设计 13.3 手动重启）。
   */
  start(): Promise<void>
  /**
   * 停止本实例：bot.stop()（同步）+ 有界等待在途 inbound 处理与后台 start 收敛，随后经
   * ingress.disconnect 从 core 注销（多实例并存时只影响本实例）。幂等。
   */
  stop(): Promise<void>
}

/** ingress 拒绝原因 → 提示类型的映射（busy 槽同时服务 stopping/unavailable，设计 6.2、10.4）。 */
const REJECTION_NOTICE: Readonly<Record<'busy' | 'stopping' | 'unavailable', NoticeKind>> = {
  busy: 'busy',
  stopping: 'service-stopping',
  unavailable: 'state-unavailable',
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function describeMsgType(msgType: number | undefined): string {
  return msgType === undefined ? 'msgType-missing' : `msgType=${msgType}`
}

function describeAttachments(attachments: unknown): number {
  if (attachments === undefined || attachments === null) return 0
  if (Array.isArray(attachments)) return attachments.length
  return 1
}

/**
 * SDK Logger 适配器：把 SDK 内部日志（连接/鉴权/重连等）以独立 sdk_log JSON 行转发到
 * sink（默认 console.error）。message 与 meta 都经 redact 脱敏（SDK 日志可能携带
 * Authorization/token 形态），不进 GatewayLogEvent 联合与 GatewayLogger sink。
 */
function createSdkLoggerAdapter(sink: (line: string) => void): SdkLogger {
  const emit = (level: string, msg: string, meta?: Record<string, unknown>): void => {
    const line: Record<string, string> = {
      event: 'sdk_log',
      level,
      message: redact(String(msg)),
      time: new Date().toISOString(),
    }
    if (meta !== undefined) {
      line.meta = redact(JSON.stringify(meta))
    }
    sink(JSON.stringify(line))
  }
  return {
    info: (msg, meta) => emit('info', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    debug: (msg, meta) => emit('debug', msg, meta),
  }
}

/**
 * 把真实 QQBot 适配到 QQBotLike。SDK 的 `on` 是对 QQBotEventMap 的泛型方法，与最小
 * 接口的泛型签名不构成直接结构兼容（多出 interaction/rawEvent 键），因此集中在本函数
 * 以两处显式 cast 收口；替身 bot（测试）直接实现 QQBotLike，不经此适配。
 */
function adaptRealBot(real: QQBot): QQBotLike {
  const onAny = real.on.bind(real) as (event: string, handler: (...args: unknown[]) => unknown) => unknown
  const useAny = real.use.bind(real) as (...middleware: unknown[]) => unknown
  return {
    use: (...middleware) => useAny(...middleware),
    on: (event, handler) => onAny(event, handler as (...args: unknown[]) => unknown),
    start: (signal?: AbortSignal) => real.start(signal),
    stop: () => real.stop(),
    sendText: (target, content) => real.sendText(target, content),
  }
}

type ChannelState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped'

/** manual_restart_required 归因行的处置指引：修因后重跑 enable 拉起新实例，重启进程仅兜底。 */
const ENABLE_REMEDY =
  'rerun "dsh-gateway channel enable qq" after fixing the cause (restarting the gateway is the fallback)'

export function createQQChannel(options: QQChannelOptions): QQChannel {
  const { appId, appSecret, core, logger, limits } = options
  const now: () => number = options.now ?? Date.now
  const sdkLogger = createSdkLoggerAdapter(options.sdkLogSink ?? ((line) => console.error(line)))

  let ingress: ChannelIngress | undefined
  let bot: QQBotLike | undefined
  let channelState: ChannelState = 'idle'
  let startRequested = false
  let startPromise: Promise<void> | undefined
  let stopPromise: Promise<void> | undefined
  let stopReceivingPromise: Promise<void> | undefined
  /** 出站隔离后不再发任何出站请求、不再向 core 递交新入站（10.3 手动恢复边界）。 */
  let outboundIsolated = false
  /** busy/stopping/unavailable 提示的独立发送槽占用数（无等待队列）。 */
  let activeNotices = 0
  const inflightHandlers = new Set<Promise<void>>()

  function setState(state: 'connecting' | 'online' | 'reconnecting' | 'blocked'): void {
    try {
      ingress?.setState(state)
    } catch (err) {
      logger.logEvent('state_failed', { channelId: 'qq', reason: `ingress setState threw: ${errorMessage(err)}` })
    }
  }

  /** 出站隔离：一次 35s 期限后的底层调用仍未结束即触发；之后等待使用者手动重启（10.3）。 */
  function isolateOutbound(reason: string): void {
    if (outboundIsolated) {
      return
    }
    outboundIsolated = true
    logger.logEvent('manual_restart_required', { channelId: 'qq', reason: `${reason}; ${ENABLE_REMEDY}` })
    setState('blocked')
  }

  const sender: QQSender = {
    send: (msgId, targetId, text) => {
      if (bot === undefined) {
        return Promise.reject(new Error('QQ channel: bot not started'))
      }
      return bot.sendText({ scope: 'c2c', targetId, msgId }, text)
    },
  }

  async function waitInflightHandlers(ms: number): Promise<void> {
    if (inflightHandlers.size === 0) {
      return
    }
    try {
      await raceSendTimeout(Promise.allSettled(inflightHandlers), ms)
    } catch {
      // 有界 best-effort 等待：超时放弃，剩余在途处理自行收尾。
    }
  }

  /** stopReceiving 语义（设计 4.2）：bot.stop() 同步释放 + 有界等待在途 inbound 处理。幂等。 */
  async function stopReceivingInternal(): Promise<void> {
    if (stopReceivingPromise !== undefined) {
      return stopReceivingPromise
    }
    stopReceivingPromise = (async () => {
      try {
        bot?.stop()
      } catch (err) {
        logger.logEvent('state_warning', { channelId: 'qq', reason: `bot.stop threw: ${errorMessage(err)}` })
      }
      await waitInflightHandlers(limits.DISPOSE_WAIT_MS)
    })()
    return stopReceivingPromise
  }

  /** ingress 拒绝提示：经独立发送槽尝试一次；槽满只记日志（6.2）。fire-and-forget。 */
  function sendRejectionNotice(kind: NoticeKind, m: NormalizedC2CMessage): void {
    if (now() >= m.expiresAt) {
      // 提示发送同样受该消息回复窗口约束（10.4）：窗口已过不再借用锚点发送，只记日志。
      logger.logEvent('inbound_rejected', {
        messageId: m.messageId,
        reason: 'notice reply window expired',
        outcome: kind,
      })
      return
    }
    if (activeNotices >= limits.BUSY_NOTICE_SLOTS) {
      logger.logEvent('inbound_rejected', {
        messageId: m.messageId,
        reason: `notice slots full (${limits.BUSY_NOTICE_SLOTS})`,
        outcome: kind,
      })
      return
    }
    activeNotices += 1
    // 计入这条被拒消息自己的预算（一次 sendText，msgId 用其 replyTarget）；同样套 35s 总期限。
    // 槽位在该 promise 终态（含超时）后释放；无等待队列，不重试。
    void raceSendTimeout(sender.send(m.msgId, m.peerId, NOTICE_TEXTS[kind]), limits.QQ_OUTBOUND_CALL_TIMEOUT_MS)
      .then(
        () => undefined,
        (err: unknown) => {
          if (err === SEND_TIMED_OUT) {
            isolateOutbound(`rejection notice send exceeded ${limits.QQ_OUTBOUND_CALL_TIMEOUT_MS}ms`)
            return
          }
          logger.logEvent('reply_failed', {
            messageId: m.messageId,
            reason: `rejection notice send failed: ${errorMessage(err)}`,
          })
        },
      )
      .then(
        () => {
          activeNotices -= 1
        },
        () => {
          // 上面的处理器不会抛出；防御性兜底，保证槽位一定释放。
          activeNotices -= 1
        },
      )
  }

  function handleIngressRejection(
    reason: 'busy' | 'expired' | 'stopping' | 'unavailable',
    m: NormalizedC2CMessage,
  ): void {
    if (reason === 'expired') {
      // 已过期只记录，不发提示、不移用其他消息锚点（6.2）。
      logger.logEvent('inbound_rejected', { messageId: m.messageId, reason: 'expired' })
      return
    }
    logger.logEvent('inbound_rejected', { messageId: m.messageId, reason })
    if (!outboundIsolated) {
      sendRejectionNotice(REJECTION_NOTICE[reason], m)
    }
  }

  function handleMessage(msg: QQBotInboundMessage): Promise<void> {
    const run = (async (): Promise<void> => {
      if (outboundIsolated) {
        logger.logEvent('inbound_ignored', {
          messageId: typeof msg.messageId === 'string' && msg.messageId.length > 0 ? msg.messageId : undefined,
          reason: 'outbound-isolated',
        })
        return
      }
      const decision = normalizeC2CMessage({
        kind: msg.kind,
        senderId: msg.senderId,
        messageId: msg.messageId,
        content: msg.content,
        msgType: msg.msgType,
        attachments: msg.attachments,
        timestamp: msg.timestamp,
        replyTarget: msg.replyTarget,
      })
      if (!decision.accepted) {
        // 只记录 reason、类型、附件数与长度，不记录正文（5.2 步骤 6）。
        logger.logEvent('inbound_ignored', {
          reason: decision.reason,
          messageId: typeof msg.messageId === 'string' && msg.messageId.length > 0 ? msg.messageId : undefined,
          outcome: describeMsgType(msg.msgType),
          attachmentCount: describeAttachments(msg.attachments),
          inputLength: typeof msg.content === 'string' ? msg.content.length : 0,
        })
        return
      }
      const m = decision.message
      const maxMessages = limits.QQ_MAX_MESSAGES_PER_INBOUND
      const reply = createQQReplyPort({
        msgId: m.msgId,
        targetId: m.peerId,
        expiresAt: m.expiresAt,
        maxMessages,
        sender,
        logger,
        limits,
        now,
        onSendStuck: () => {
          isolateOutbound(`reply send exceeded ${limits.QQ_OUTBOUND_CALL_TIMEOUT_MS}ms (messageId ${m.messageId})`)
        },
      })
      // ingress 准入即时返回；SDK 回调不 await 整个 turn（4.2、5.2 步骤 6）。
      const result = await ingress!.inbound({
        peerId: m.peerId,
        messageId: m.messageId,
        text: m.text,
        receivedAt: m.receivedAt,
        replyPolicy: { maxMessages, expiresAt: m.expiresAt },
        reply,
      })
      // queued 由 core 侧记录（字段含 channelId/bindingId 更全），渠道侧不重复记录。
      if (!result.accepted) {
        handleIngressRejection(result.reason, m)
      }
    })()
    // 防御：handler 意外异常只记日志，不向 SDK 抛出。
    const guarded = run.catch((err: unknown) => {
      logger.logEvent('inbound_ignored', { reason: `handler error: ${errorMessage(err)}` })
    })
    inflightHandlers.add(guarded)
    void guarded.then(() => {
      inflightHandlers.delete(guarded)
    })
    return guarded
  }

  function bindEvents(target: QQBotLike): void {
    target.on('message', (_ctx, msg) => handleMessage(msg))
    target.on('ready', () => {
      if (!outboundIsolated) {
        setState('online')
      }
    })
    target.on('resumed', () => {
      if (!outboundIsolated) {
        setState('online')
      }
    })
    target.on('error', (err) => {
      // SDK 的 error 事件均为可恢复故障（连接/套接字错误）；重连委托 SDK（13.3）。
      if (!outboundIsolated) {
        logger.logEvent('channel_reconnecting', { channelId: 'qq', reason: `sdk error: ${errorMessage(err)}` })
        setState('reconnecting')
      }
    })
    target.on('disconnected', (event) => {
      if (outboundIsolated) {
        return
      }
      if (event.willReconnect) {
        logger.logEvent('channel_reconnecting', {
          channelId: 'qq',
          reason: `gateway disconnect ${event.code}: ${event.reason}`,
        })
        setState('reconnecting')
      } else {
        // 终局断连：start() 随后以 GatewayError reject，由其处理器再确认 blocked。
        logger.logEvent('manual_restart_required', {
          channelId: 'qq',
          reason: `gateway terminal disconnect ${event.code}: ${event.reason}; ${ENABLE_REMEDY}`,
        })
        setState('blocked')
      }
    })
  }

  /** bot.start() 拒绝的归因：永久拒绝与意外失败都转 blocked（13.1、13.3），不自动重启。 */
  function classifyStartFailure(err: unknown): void {
    const code = (err as { code?: unknown } | null)?.code
    const terminal =
      code === GatewayErrorCode.FATAL_CLOSE || code === GatewayErrorCode.RETRY_EXHAUSTED
    const reason = terminal
      ? `gateway terminal failure (${String(code)}); ${ENABLE_REMEDY}`
      : `sdk start failed: ${errorMessage(err)}; ${ENABLE_REMEDY}`
    logger.logEvent('manual_restart_required', { channelId: 'qq', reason })
    setState('blocked')
    channelState = 'stopped'
  }

  async function start(): Promise<void> {
    if (startRequested) {
      // 幂等：已请求过启动（成功、进行中或已失败终局）不再重复注册与启动。
      // 启动失败后本实例废弃，重启走新实例（设计 13.3 手动重启）。
      return
    }
    startRequested = true
    channelState = 'starting'

    // 注册先于 SDK 启动（设计 3.1）；重复注册抛错由 core 侧判定，这里捕获记录后上抛。
    try {
      ingress = core.registerChannel({
        channelId: 'qq',
        accountId: appId,
        stopReceiving: () => stopReceivingInternal(),
      })
    } catch (err) {
      logger.logEvent('manual_restart_required', {
        channelId: 'qq',
        reason: `channel registration failed: ${errorMessage(err)}; ${ENABLE_REMEDY}`,
      })
      // 本实例一次性：启动失败即终局，不重置 startRequested（13.3 手动重启走新实例）。
      // 由此 stop()/stopReceiving() 的缓存恒属于这唯一一个生命周期，不会跨重启残留而
      // 漏停后来启动的 bot。
      channelState = 'stopped'
      throw err
    }

    const ctorOptions: QQBotCtorOptions = {
      appId,
      appSecret,
      intents: QQ_C2C_INTENTS,
      markdownSupport: true,
      transport: 'websocket',
      tokenPrefetch: 'sync',
      logger: sdkLogger,
    }
    const created: QQBotLike =
      options.botFactory !== undefined ? options.botFactory(ctorOptions) : adaptRealBot(new QQBot(ctorOptions))
    bot = created

    // 仅装载 messageFilter 一个中间件，保持默认 dedup 配置（5.1）。
    created.use(messageFilter())
    bindEvents(created)
    setState('connecting')

    // start() 是挂起直到 stop 的 Promise：立即挂 reject handler 后台化（13.1）。
    const sdkStart = created.start()
    const guarded = sdkStart.then(
      () => {
        if (channelState !== 'stopping' && channelState !== 'stopped') {
          logger.logEvent('shutdown', { channelId: 'qq', reason: 'sdk start resolved without channel stop' })
          channelState = 'stopped'
        }
      },
      (err: unknown) => {
        classifyStartFailure(err)
      },
    )
    guarded.catch(() => undefined)
    startPromise = guarded
    channelState = 'running'
  }

  async function stop(): Promise<void> {
    if (stopPromise !== undefined) {
      return stopPromise
    }
    stopPromise = (async () => {
      const previous = channelState
      channelState = 'stopping'
      await stopReceivingInternal()
      if (startPromise !== undefined) {
        try {
          // SDK 的 start() 在 stop 后自行 resolve；有界等待兜底。
          await raceSendTimeout(Promise.allSettled([startPromise]), limits.DISPOSE_WAIT_MS)
        } catch {
          // 有界等待超时：后台任务已挂 handler，不会产生 unhandled rejection。
        }
      }
      // 注销 core 注册（多实例并存：只影响本实例，丢其排队任务、中断其运行中执行）。
      // 注册失败的实例 ingress 为 undefined，跳过。
      try {
        await ingress?.disconnect()
      } catch (err) {
        logger.logEvent('state_warning', {
          channelId: 'qq',
          reason: `ingress disconnect threw: ${errorMessage(err)}`,
        })
      }
      if (previous !== 'stopped') {
        channelState = 'stopped'
      }
    })()
    return stopPromise
  }

  return {
    start,
    stop,
  }
}
