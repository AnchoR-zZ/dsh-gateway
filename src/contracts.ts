/**
 * 渠道契约：core 与渠道适配器之间的全部共享 DTO、接口与固定行为常量。
 *
 * 本文件只依赖 TypeScript 类型；禁止导入 QQ SDK、dsh 或其他 src 模块，保持契约层无运行时
 * 耦合（设计文档 2.1、4.2）。
 */

/** 渠道注册信息。注册返回绑定该渠道账号及其生命周期代次的 ingress；`stopReceiving()` 幂等。 */
export interface ChannelRegistration {
  channelId: string
  accountId: string
  stopReceiving(): void | Promise<void>
}

/** 平台侧回复预算：由渠道声明，core 不得放大。 */
export interface ReplyPolicy {
  /** 平台单次入站的最大发送预算 */
  maxMessages: number
  /** 平台被动回复截止时间，Unix 毫秒 */
  expiresAt: number
}

/** 规范入站文本消息。reply port 由每条入站创建，只接受一次 envelope。 */
export interface InboundText {
  peerId: string
  messageId: string
  text: string
  receivedAt: number
  replyPolicy: ReplyPolicy
  reply: ReplyPort
}

/**
 * 提示类型。顺序即渠道渲染优先级。
 * `truncated` 由渠道规划器在切分阶段自行生成（设计文档 10.2），不经 NoticeKind 传递。
 */
export type NoticeKind =
  | 'session-recreated'
  | 'turn-failed'
  | 'turn-timeout'
  | 'empty-reply'
  | 'model-output-limited'
  | 'busy'
  | 'queue-expired'
  | 'service-stopping'
  | 'state-unavailable'

/** core 交付给 reply port 的唯一信封：最终正文加提示类型，一次消费。 */
export interface ReplyEnvelope {
  text?: string
  /** 顺序即渠道渲染优先级 */
  notices: readonly NoticeKind[]
  /** 不得大于 ReplyPolicy.maxMessages */
  maxMessages: number
}

/** 渠道发送结果报告：失败和未知结果不返还额度，也不触发补发。 */
export interface DeliveryReport {
  status: 'sent' | 'partial' | 'failed' | 'unknown' | 'expired' | 'closed'
  attempted: number
  confirmed: number
}

/** 每条入站创建一次的回复出口；`close()` 幂等，重复 deliver 不发送。 */
export interface ReplyPort {
  deliver(envelope: ReplyEnvelope): Promise<DeliveryReport>
  close(): void
}

/** core 返回给渠道的入口；渠道不能在每次入站时冒用另一个注册身份。 */
export interface ChannelIngress {
  setState(state: 'connecting' | 'online' | 'reconnecting' | 'blocked'): void
  inbound(message: InboundText): Promise<
    | { accepted: true; requestId: string }
    | { accepted: false; reason: 'busy' | 'expired' | 'stopping' | 'unavailable' }
  >
  disconnect(): Promise<void>
}

/** 网关核心的对外注册面；重复注册同一渠道账号报错，不覆盖已有实例。 */
export interface GatewayCore {
  registerChannel(channel: ChannelRegistration): ChannelIngress
}

/** 规范身份三元组；QQ 分别使用 `qq`、机器人 AppID、`user_openid`。 */
export interface ChannelIdentity {
  channelId: string
  accountId: string
  peerId: string
}

/** bindingId 的最大长度：同时作为映射键和目录名，给 workspace 路径留出余量。 */
export const BINDING_ID_MAX_LENGTH = 128

/** channelId/accountId 的允许字符；不含 `_`，保证 bindingId 的前两段可无歧义拆分。 */
const BINDING_SCOPE_PATTERN = /^[A-Za-z0-9@.-]+$/
/** peerId 的允许字符；允许 `_`、`@` 和 `.`，末尾不能为点以免 Windows 路径别名。 */
const BINDING_PEER_PATTERN = /^[A-Za-z0-9_@.-]+$/

/** channelId/accountId 是否可作为 bindingId 的前两段。 */
export function isValidBindingScope(value: string): boolean {
  return typeof value === 'string' && BINDING_SCOPE_PATTERN.test(value)
}

/** peerId 是否可安全地作为 bindingId 的末段和目录名的一部分。 */
export function isValidBindingPeer(value: string): boolean {
  return typeof value === 'string' && BINDING_PEER_PATTERN.test(value) && !value.endsWith('.')
}

/**
 * 可读会话键：`<channelId>_<accountId>_<peerId>`。
 * QQ 下即 `qq_<AppID>_<user_openid>`；channelId/accountId 不含 `_`，peerId 可含 `_`。
 * 拼接结果同时作为内存键、映射文件键和工作目录名，因此逐段校验非法字符、`.`/`..`
 * 和总长度，禁止把平台传入的原始 ID 未经验证拼成路径（设计文档 4.1）。
 * 大小写按原样保留；Windows 路径不区分大小写，若平台产生仅大小写不同的 peerId，
 * 它们会落到同一目录（QQ 的十六进制 openid 形态不受影响）。
 */
export function computeBindingId(identity: ChannelIdentity): string {
  if (!isValidBindingScope(identity.channelId)) {
    throw new Error('channelId must match [A-Za-z0-9@.-]+')
  }
  if (!isValidBindingScope(identity.accountId)) {
    throw new Error('accountId must match [A-Za-z0-9@.-]+')
  }
  if (!isValidBindingPeer(identity.peerId)) {
    throw new Error('peerId must match [A-Za-z0-9_@.-]+ and must not end with a dot')
  }
  const bindingId = `${identity.channelId}_${identity.accountId}_${identity.peerId}`
  if (bindingId.length > BINDING_ID_MAX_LENGTH) {
    throw new Error(`bindingId must be at most ${BINDING_ID_MAX_LENGTH} characters`)
  }
  return bindingId
}

/**
 * bindingId 是否具有可读键的规范形态。只校验形态，不校验与身份记录是否一致；
 * 后者由调用方用 computeBindingId(identity) 重新计算并比较。
 */
export function isValidBindingId(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > BINDING_ID_MAX_LENGTH) {
    return false
  }
  const first = value.indexOf('_')
  if (first <= 0) {
    return false
  }
  const second = value.indexOf('_', first + 1)
  if (second <= first + 1) {
    return false
  }
  const channelId = value.slice(0, first)
  const accountId = value.slice(first + 1, second)
  const peerId = value.slice(second + 1)
  return isValidBindingScope(channelId) && isValidBindingScope(accountId) && isValidBindingPeer(peerId)
}

/**
 * 固定行为常量：超时、QQ 长度和发送次数属于行为契约，不提供环境变量绕过（设计文档 16 节）。
 * 全部为 const number，后续模块只读取。
 */
export const GATEWAY_LIMITS = {
  /** 单个 turn 的执行截止时间（毫秒），从获得全局槽、开始准备会话时计时（9.1）。 */
  TURN_DEADLINE_MS: 600_000,
  /** 映射写事务的超时上限（毫秒）（9.1）。 */
  MAP_WRITE_TIMEOUT_MS: 5_000,
  /** 单次 session flush 的超时上限（毫秒）（9.1）。 */
  SESSION_FLUSH_TIMEOUT_MS: 5_000,
  /** QQ 出站单次调用的总期限（毫秒），涵盖取 token 与响应体读取（10.3）。 */
  QQ_OUTBOUND_CALL_TIMEOUT_MS: 35_000,
  /** QQ 被动回复有效期（毫秒），以平台入站时间为起点（6.2）。 */
  QQ_PASSIVE_REPLY_WINDOW_MS: 3_600_000,
  /** 有效期内为出站预留的余量（毫秒）（6.2）。 */
  QQ_OUTBOUND_MARGIN_MS: 180_000,
  /** QQ 单条入站的回复预算（最大消息条数）；QQ 渠道固定为 4（4.3、10.1）。 */
  QQ_MAX_MESSAGES_PER_INBOUND: 4,
  /** QQ 单条 markdown 消息的长度上限，UTF-16 code units 保守计数（10.1）。 */
  QQ_MESSAGE_MAX_LENGTH: 4_000,
  /** busy 拒绝提示的有界独立发送槽数量，无等待队列；槽满只记日志（6.2）。 */
  BUSY_NOTICE_SLOTS: 4,
  /** 取消后等待 agent 停稳的时间上限（毫秒）（9.2）。 */
  CANCEL_SETTLE_WAIT_MS: 5_000,
  /** dispose 的等待时间上限（毫秒）（9.2）。 */
  DISPOSE_WAIT_MS: 5_000,
  /** 取消清理总预算（毫秒）：停稳、flush 与 dispose 共用，不按步骤追加（9.2）。 */
  CANCEL_CLEANUP_BUDGET_MS: 10_000,
  /** 正常停止时运行中任务自然结束的等待时间（毫秒）（9.3）。 */
  STOP_NATURAL_COMPLETION_WAIT_MS: 5_000,
  /** 核心清理总预算（毫秒）；超限记录未完成清理并提示手动结束（9.3）。 */
  CORE_SHUTDOWN_BUDGET_MS: 25_000,
} as const
