import type { DeliveryReport, GATEWAY_LIMITS, ReplyEnvelope, ReplyPort } from '../contracts.js'
import type { GatewayLogger } from '../logging.js'
import { planReply } from './markdown.js'

/**
 * QQ reply port（设计文档 4.2、4.3、10.3）：每条入站创建一次的回复出口。
 * 闭包只保存必要目标（msgId、targetId、expiresAt）与计数状态，不保留 SDK 上下文；
 * 只接受一次 envelope，重复调用不发请求；close() 幂等。
 *
 * 发送流程：先经 planReply 完成全部规划（10.2），再按计划顺序逐段发送；每段发送前
 * 检查 port 状态与窗口（墙钟），每次调用前消耗一次预算且失败不返还；每段外层套
 * 35s 总期限（GATEWAY_LIMITS.QQ_OUTBOUND_CALL_TIMEOUT_MS），超期标记 unknown、关闭
 * 本 port、停止后续段并触发 onSendStuck（渠道出站隔离入口）；底层 promise 之后 settle
 * 的结果被忽略。明确失败停止余段；发送失败不补发错误提示、不改发普通文本。
 */

/** 出站发送端口：实现用 bot.sendText(replyTarget, text) 发一条 markdown 被动回复。 */
export interface QQSender {
  send(msgId: string, targetId: string, text: string): Promise<unknown>
}

/** limits 注入形状：键集合与 GATEWAY_LIMITS 一致，值放宽为 number 以便测试注入小预算。 */
export type ReplyPortLimits = { readonly [K in keyof typeof GATEWAY_LIMITS]: number }

export interface ReplyPortOptions {
  /** 被动回复锚点（replyTarget.msgId）。 */
  msgId: string
  /** 回复目标 user_openid。 */
  targetId: string
  /** 平台被动回复截止时间（Unix 毫秒，墙钟比较）。 */
  expiresAt: number
  /** 平台预算 B（来自 ReplyPolicy；envelope.maxMessages 只能在此基础上取小）。 */
  maxMessages: number
  sender: QQSender
  logger: GatewayLogger
  limits: ReplyPortLimits
  /** 墙钟（毫秒）；默认 Date.now。 */
  now?: () => number
  /** 一段发送超过总期限后底层 promise 仍未 settle 时回调（渠道出站隔离入口）。 */
  onSendStuck?: () => void
}

/** 出站单次调用超时哨兵：raceSendTimeout 超时以该值 reject，与真实错误区分。 */
export const SEND_TIMED_OUT = Symbol('qq outbound send timeout')

/**
 * 以墙外定时器为出站调用加总期限；超时以 SEND_TIMED_OUT reject。
 * 底层 promise 先挂 no-op 处理器：race 输掉之后它的迟到 settle 不产生 unhandled rejection。
 */
export function raceSendTimeout<T>(op: Promise<T>, ms: number): Promise<T> {
  op.then(
    () => undefined,
    () => undefined,
  )
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(SEND_TIMED_OUT), Math.max(0, ms))
    timer.unref?.()
    op.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createQQReplyPort(options: ReplyPortOptions): ReplyPort {
  const { msgId, targetId, expiresAt, sender, logger, limits } = options
  const now: () => number = options.now ?? Date.now
  let closed = false
  let consumed = false
  /** 最近一次投递结论的快照：deliver 期间为进行中（unknown/0/0），结束后为最终报告。 */
  let snapshot: DeliveryReport = { status: 'unknown', attempted: 0, confirmed: 0 }

  return {
    close() {
      // 幂等；不影响已 settle 的 send promise 追踪（raceSendTimeout 已挂 no-op 处理器）。
      closed = true
    },

    async deliver(envelope: ReplyEnvelope): Promise<DeliveryReport> {
      if (closed) {
        return { status: 'closed', attempted: 0, confirmed: 0 }
      }
      if (consumed) {
        // 只接受一次：第二次调用不发请求，返回当时值的快照。
        return { ...snapshot }
      }
      consumed = true
      if (now() >= expiresAt) {
        snapshot = { status: 'expired', attempted: 0, confirmed: 0 }
        return { ...snapshot }
      }

      const budget = Math.min(envelope.maxMessages, options.maxMessages)
      const plan = planReply({
        text: envelope.text,
        notices: envelope.notices,
        maxMessages: budget,
        maxLength: limits.QQ_MESSAGE_MAX_LENGTH,
      })
      if (plan.degraded) {
        // 规划自检失败或内部异常：planReply 已收敛为单条兜底文案；降级原因不可得（T5 已知边界）。
        logger.logEvent('reply_failed', { messageId: msgId, reason: 'reply plan degraded to fixed failure text' })
      }

      const messages = plan.messages
      let attempted = 0
      let confirmed = 0
      let firstSendAt: number | undefined

      const finalize = (status: DeliveryReport['status']): DeliveryReport => {
        snapshot = { status, attempted, confirmed }
        if (status === 'sent' || status === 'partial' || status === 'unknown') {
          const deliveryMs = firstSendAt === undefined ? 0 : now() - firstSendAt
          const fields = { messageId: msgId, deliveryMs, attempted, confirmed }
          if (status === 'sent') {
            logger.logEvent('reply_sent', fields)
          } else if (status === 'partial') {
            logger.logEvent('reply_partial', fields)
          } else {
            logger.logEvent('reply_unknown', fields)
          }
        }
        return { ...snapshot }
      }

      for (const segment of messages) {
        // 每段前检查 port 状态与窗口（墙钟）。
        if (closed) {
          return finalize(attempted === 0 ? 'closed' : 'partial')
        }
        if (now() >= expiresAt) {
          // 部分发送成功后过期：已发段落构成部分投递（10.3、6.2）。
          return finalize(attempted === 0 ? 'expired' : 'partial')
        }
        if (attempted >= budget) {
          // 防御：planReply 保证条数 ≤ budget，正常不会走到这里。
          break
        }
        if (firstSendAt === undefined) {
          firstSendAt = now()
        }
        // 每次调用前消耗一次预算；失败与未知结果不返还额度。
        attempted += 1
        try {
          await raceSendTimeout(sender.send(msgId, targetId, segment), limits.QQ_OUTBOUND_CALL_TIMEOUT_MS)
          confirmed += 1
        } catch (err) {
          if (err === SEND_TIMED_OUT) {
            // 总期限已过而底层调用未结束：unknown、关闭本 port、停止余段、触发出站隔离。
            closed = true
            try {
              options.onSendStuck?.()
            } catch (cbErr) {
              logger.logEvent('reply_failed', {
                messageId: msgId,
                reason: `onSendStuck callback threw: ${errorMessage(cbErr)}`,
              })
            }
            return finalize('unknown')
          }
          // 明确失败（ApiError 等）：停止余段，不补发错误提示。
          return finalize(confirmed > 0 ? 'partial' : 'failed')
        }
      }
      return finalize('sent')
    },
  }
}
