import { describe, expect, it } from 'vitest'
import {
  BINDING_ID_MAX_LENGTH,
  GATEWAY_LIMITS,
  computeBindingId,
  isValidBindingId,
} from '../src/contracts.js'

const identity = { channelId: 'qq', accountId: '102000001', peerId: 'ABCDEF123456' }

describe('computeBindingId', () => {
  it('uses the readable <channelId>_<accountId>_<peerId> form', () => {
    expect(computeBindingId(identity)).toBe('qq_102000001_ABCDEF123456')
  })

  it('is deterministic for the same identity', () => {
    expect(computeBindingId(identity)).toBe(computeBindingId({ ...identity }))
  })

  it('differs when any identity component changes', () => {
    const base = computeBindingId(identity)
    expect(computeBindingId({ ...identity, channelId: 'wechat' })).not.toBe(base)
    expect(computeBindingId({ ...identity, accountId: '102000002' })).not.toBe(base)
    expect(computeBindingId({ ...identity, peerId: 'DIFFERENT' })).not.toBe(base)
  })

  it('allows underscores in peerId but not in channelId/accountId', () => {
    expect(computeBindingId({ ...identity, peerId: 'peer_with_underscores' })).toBe(
      'qq_102000001_peer_with_underscores',
    )
    expect(() => computeBindingId({ ...identity, channelId: 'q_q' })).toThrow(/channelId/)
    expect(() => computeBindingId({ ...identity, accountId: 'app_1' })).toThrow(/accountId/)
  })

  it('rejects path-unsafe or empty identity segments', () => {
    for (const peerId of ['', '../escape', 'peer/child', 'peer.child', 'peer with space']) {
      expect(() => computeBindingId({ ...identity, peerId })).toThrow(/peerId/)
    }
  })

  it('rejects binding ids longer than the limit', () => {
    expect(() =>
      computeBindingId({ ...identity, peerId: 'a'.repeat(BINDING_ID_MAX_LENGTH) }),
    ).toThrow(/bindingId/)
  })
})

describe('isValidBindingId', () => {
  it('accepts the digest-free form produced by computeBindingId', () => {
    expect(isValidBindingId(computeBindingId(identity))).toBe(true)
    expect(isValidBindingId('qq_102000001_peer_with_underscores')).toBe(true)
  })

  it('rejects old hash keys, missing segments and unsafe characters', () => {
    expect(isValidBindingId('0'.repeat(64))).toBe(false)
    expect(isValidBindingId('qq_102000001_')).toBe(false)
    expect(isValidBindingId('qq__peer')).toBe(false)
    expect(isValidBindingId('qq_102000001_peer/child')).toBe(false)
    expect(isValidBindingId('qq_102000001_peer.child')).toBe(false)
    expect(isValidBindingId('qq_102000001_' + 'a'.repeat(BINDING_ID_MAX_LENGTH))).toBe(false)
  })
})

describe('GATEWAY_LIMITS', () => {
  it('keeps the frozen behavior constants from the design document', () => {
    expect(GATEWAY_LIMITS.TURN_DEADLINE_MS).toBe(600_000)
    expect(GATEWAY_LIMITS.MAP_WRITE_TIMEOUT_MS).toBe(5_000)
    expect(GATEWAY_LIMITS.SESSION_FLUSH_TIMEOUT_MS).toBe(5_000)
    expect(GATEWAY_LIMITS.QQ_OUTBOUND_CALL_TIMEOUT_MS).toBe(35_000)
    expect(GATEWAY_LIMITS.QQ_PASSIVE_REPLY_WINDOW_MS).toBe(3_600_000)
    expect(GATEWAY_LIMITS.QQ_OUTBOUND_MARGIN_MS).toBe(180_000)
    expect(GATEWAY_LIMITS.QQ_MAX_MESSAGES_PER_INBOUND).toBe(4)
    expect(GATEWAY_LIMITS.QQ_MESSAGE_MAX_LENGTH).toBe(4_000)
    expect(GATEWAY_LIMITS.BUSY_NOTICE_SLOTS).toBe(4)
    expect(GATEWAY_LIMITS.CANCEL_SETTLE_WAIT_MS).toBe(5_000)
    expect(GATEWAY_LIMITS.DISPOSE_WAIT_MS).toBe(5_000)
    expect(GATEWAY_LIMITS.CANCEL_CLEANUP_BUDGET_MS).toBe(10_000)
    expect(GATEWAY_LIMITS.STOP_NATURAL_COMPLETION_WAIT_MS).toBe(5_000)
    expect(GATEWAY_LIMITS.CORE_SHUTDOWN_BUDGET_MS).toBe(25_000)
  })
})
