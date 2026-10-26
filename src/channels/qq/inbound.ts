import { GATEWAY_LIMITS, isValidBindingPeer } from '../../contracts.js'

/**
 * QQ 入站纯过滤（设计文档 5.2）：把 SDK 归一化的入站消息按准入顺序 1-5 转为规范
 * C2C 文本消息，或携带原因的拒绝结论。无 IO、不导入 SDK；字段一律按 unknown 接收并
 * 在此逐项校验，不把缺失字段补成默认值，也不根据 content 猜测类型。
 *
 * 入口签名刻意镜像 SDK 的 QQBotInboundMessage 形状，组装层（src/channels/qq/index.ts）只做
 * 字段搬运；测试直接构造字面量即可覆盖 5.2 的完整矩阵。
 */

/** 5.2 步骤 1-5 全部通过后的规范 C2C 文本消息。 */
export interface NormalizedC2CMessage {
  /** 发送方 user_openid；同时也是被动回复目标。 */
  peerId: string
  /** 平台消息 ID（追踪与日志关联用）。 */
  messageId: string
  /** 交给 core 的文本：仅去首尾空白，保留内部空白、换行和表情标记。 */
  text: string
  /** 平台入站时间（墙钟毫秒），来自 timestamp 解析值，不用本地接收时钟。 */
  receivedAt: number
  /** 被动回复截止时间：receivedAt + QQ 回复窗口（GATEWAY_LIMITS 相关键）。 */
  expiresAt: number
  /** 被动回复锚点（SDK replyTarget.msgId；C2C 下与 messageId 同源）。 */
  msgId: string
}

/** 拒绝原因，与 5.2 步骤一一对应；inbound_ignored 日志按此记录。 */
export type InboundRejectReason =
  | 'not-c2c'
  | 'incomplete-fields'
  | 'invalid-identity'
  | 'target-mismatch'
  | 'non-text-type'
  | 'has-attachments'
  | 'empty-content'
  | 'bad-timestamp'

export type InboundDecision =
  | { accepted: true; message: NormalizedC2CMessage }
  | { accepted: false; reason: InboundRejectReason }

export interface NormalizeC2CInput {
  kind: unknown
  senderId: unknown
  messageId: unknown
  content: unknown
  msgType: unknown
  attachments: unknown
  timestamp: unknown
  /** SDK ReplyTarget 的形状（msgId 可缺失：缺失按 incomplete-fields 拒绝）。 */
  replyTarget: { targetId?: unknown; msgId?: unknown } | undefined | null
  /**
   * 预留的本地时钟注入位：期限只依赖平台 timestamp（设计 5.2 步骤 5），本函数不读取
   * 本地时钟；保留该字段是为了让入口形状与 reply-port 的注入约定一致。
   */
  now?: () => number
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function normalizeC2CMessage(input: NormalizeC2CInput): InboundDecision {
  // 步骤 1：会话种类、用户与消息标识完整、回复目标存在且与该用户一致。
  if (input.kind !== 'c2c') {
    return { accepted: false, reason: 'not-c2c' }
  }
  if (!isNonEmptyString(input.senderId) || !isNonEmptyString(input.messageId)) {
    return { accepted: false, reason: 'incomplete-fields' }
  }
  // senderId 会进入 bindingId 和工作目录名：只接受可安全拼接的字符集。
  if (!isValidBindingPeer(input.senderId)) {
    return { accepted: false, reason: 'invalid-identity' }
  }
  const target = input.replyTarget
  if (target === undefined || target === null || !isNonEmptyString(target.msgId)) {
    return { accepted: false, reason: 'incomplete-fields' }
  }
  if (target.targetId !== input.senderId) {
    return { accepted: false, reason: 'target-mismatch' }
  }

  // 步骤 2：只接受 msgType === 0；缺失（undefined）与其他非 0 值一律拒绝。
  if (input.msgType !== 0) {
    return { accepted: false, reason: 'non-text-type' }
  }

  // 步骤 3：附件缺失或空数组视为无附件；存在附件或字段结构异常时整条忽略。
  const attachments = input.attachments
  const hasAttachments = !(
    attachments === undefined ||
    attachments === null ||
    (Array.isArray(attachments) && attachments.length === 0)
  )
  if (hasAttachments) {
    return { accepted: false, reason: 'has-attachments' }
  }

  // 步骤 4：content 必须是 trim 后非空的字符串。
  if (typeof input.content !== 'string' || input.content.trim() === '') {
    return { accepted: false, reason: 'empty-content' }
  }

  // 步骤 5：平台 timestamp 解析为有限正数；失败即拒绝，不延长窗口。
  if (typeof input.timestamp !== 'string') {
    return { accepted: false, reason: 'bad-timestamp' }
  }
  const receivedAt = Date.parse(input.timestamp)
  if (!Number.isFinite(receivedAt) || receivedAt <= 0) {
    return { accepted: false, reason: 'bad-timestamp' }
  }

  return {
    accepted: true,
    message: {
      peerId: input.senderId,
      messageId: input.messageId,
      text: input.content.trim(),
      receivedAt,
      expiresAt: receivedAt + GATEWAY_LIMITS.QQ_PASSIVE_REPLY_WINDOW_MS,
      msgId: target.msgId,
    },
  }
}
