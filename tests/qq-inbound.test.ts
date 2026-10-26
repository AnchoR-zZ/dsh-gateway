import { describe, expect, it } from 'vitest'

import { GATEWAY_LIMITS } from '../src/contracts.js'
import { normalizeC2CMessage } from '../src/channels/qq/inbound.js'
import type { NormalizeC2CInput } from '../src/channels/qq/inbound.js'

/**
 * 5.2 入站准入矩阵：每格一例。全部用字面量构造，不接触 SDK；
 * 合法基线消息只改一个字段，保证每个 reason 都能归因到唯一规则。
 */

const TS = '2026-10-01T10:00:00.000Z'
const RECEIVED = Date.parse(TS)

const base = (over: Partial<NormalizeC2CInput> = {}): NormalizeC2CInput => ({
  kind: 'c2c',
  senderId: 'user-1',
  messageId: 'msg-1',
  content: 'hello',
  msgType: 0,
  attachments: undefined,
  timestamp: TS,
  replyTarget: { targetId: 'user-1', msgId: 'anchor-1' },
  ...over,
})

const decide = (over: Partial<NormalizeC2CInput> = {}) => normalizeC2CMessage(base(over))

describe('步骤 1：会话种类与身份完整性', () => {
  it('kind 非 c2c → not-c2c', () => {
    expect(decide({ kind: 'group' })).toEqual({ accepted: false, reason: 'not-c2c' })
    expect(decide({ kind: undefined })).toEqual({ accepted: false, reason: 'not-c2c' })
  })

  it('senderId 缺失或非串 → incomplete-fields', () => {
    for (const senderId of [undefined, '', 123, null]) {
      expect(decide({ senderId })).toEqual({ accepted: false, reason: 'incomplete-fields' })
    }
  })

  it('senderId 含路径不安全字符 → invalid-identity', () => {
    for (const senderId of ['../escape', 'bad/id', 'bad.id', 'bad id']) {
      expect(decide({ senderId })).toEqual({ accepted: false, reason: 'invalid-identity' })
    }
  })

  it('messageId 缺失或非串 → incomplete-fields', () => {
    for (const messageId of [undefined, '', {}]) {
      expect(decide({ messageId })).toEqual({ accepted: false, reason: 'incomplete-fields' })
    }
  })

  it('replyTarget 缺失或 msgId 非非空串 → incomplete-fields', () => {
    expect(decide({ replyTarget: undefined })).toEqual({ accepted: false, reason: 'incomplete-fields' })
    expect(decide({ replyTarget: null })).toEqual({ accepted: false, reason: 'incomplete-fields' })
    expect(decide({ replyTarget: { targetId: 'user-1', msgId: '' } })).toEqual({
      accepted: false,
      reason: 'incomplete-fields',
    })
    expect(decide({ replyTarget: { targetId: 'user-1', msgId: 42 } })).toEqual({
      accepted: false,
      reason: 'incomplete-fields',
    })
  })

  it('replyTarget.targetId !== senderId → target-mismatch', () => {
    expect(decide({ replyTarget: { targetId: 'user-2', msgId: 'anchor-1' } })).toEqual({
      accepted: false,
      reason: 'target-mismatch',
    })
    expect(decide({ replyTarget: { msgId: 'anchor-1' } })).toEqual({
      accepted: false,
      reason: 'target-mismatch',
    })
  })
})

describe('步骤 2：msgType 只接受 0（缺失同样拒绝）', () => {
  it.each([3, 103, 2, undefined, '0', false])('msgType=%p → non-text-type', (msgType) => {
    expect(decide({ msgType })).toEqual({ accepted: false, reason: 'non-text-type' })
  })

  it('msgType=0 → 通过本步', () => {
    expect(decide({ msgType: 0 }).accepted).toBe(true)
  })
})

describe('步骤 3：附件', () => {
  it('attachments 为 undefined/null/空数组 → 无附件，接受', () => {
    for (const attachments of [undefined, null, []]) {
      expect(decide({ attachments }).accepted).toBe(true)
    }
  })

  it('非空数组 → has-attachments，整条忽略不保留文字', () => {
    const decision = decide({ attachments: [{ content_type: 'image/png', url: 'https://x' }] })
    expect(decision).toEqual({ accepted: false, reason: 'has-attachments' })
  })

  it('非数组真值 → has-attachments', () => {
    expect(decide({ attachments: { content_type: 'image/png' } })).toEqual({
      accepted: false,
      reason: 'has-attachments',
    })
    expect(decide({ attachments: 'image' })).toEqual({ accepted: false, reason: 'has-attachments' })
  })
})

describe('步骤 4：content 校验与文本修剪', () => {
  it('content 非字符串或 trim 后为空 → empty-content', () => {
    for (const content of [undefined, 123, null, '', '   ', '\n\t ']) {
      expect(decide({ content })).toEqual({ accepted: false, reason: 'empty-content' })
    }
  })

  it('仅去首尾空白；内部空白与换行保留', () => {
    const decision = decide({ content: '  line1\n\n  line2 \t' })
    expect(decision).toEqual({
      accepted: true,
      message: {
        peerId: 'user-1',
        messageId: 'msg-1',
        text: 'line1\n\n  line2',
        receivedAt: RECEIVED,
        expiresAt: RECEIVED + GATEWAY_LIMITS.QQ_PASSIVE_REPLY_WINDOW_MS,
        msgId: 'anchor-1',
      },
    })
  })

  it('表情标记保留在文本内', () => {
    const decision = decide({ content: ' /姨母笑 你好 /裂开 ' })
    expect(decision.accepted && decision.message.text).toBe('/姨母笑 你好 /裂开')
  })
})

describe('步骤 5：平台 timestamp 解析', () => {
  it('timestamp 非法（非串 / NaN / 非正数）→ bad-timestamp', () => {
    for (const timestamp of [undefined, 123, 'not-a-date', ''] as unknown[]) {
      expect(decide({ timestamp })).toEqual({ accepted: false, reason: 'bad-timestamp' })
    }
    expect(decide({ timestamp: '1969-12-31T23:59:59.999Z' })).toEqual({
      accepted: false,
      reason: 'bad-timestamp',
    })
  })

  it('合法 timestamp → receivedAt 为解析值，expiresAt 恰加 60 分钟', () => {
    const decision = decide()
    expect(decision.accepted && decision.message.receivedAt).toBe(RECEIVED)
    expect(decision.accepted && decision.message.expiresAt).toBe(RECEIVED + GATEWAY_LIMITS.QQ_PASSIVE_REPLY_WINDOW_MS)
    expect(decision.accepted && decision.message.expiresAt - decision.message.receivedAt).toBe(3_600_000)
  })
})
