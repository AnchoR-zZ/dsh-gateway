import { describe, expect, it } from 'vitest'
import {
  NOTICE_TEXTS,
  PLAN_FAILURE_TEXT,
  TRUNCATED_TEXT,
  planReply,
} from '../src/channels/qq/markdown.js'
import type { PlanInput } from '../src/channels/qq/markdown.js'

const L = 4000
const B = 4

const plan = (over: Partial<PlanInput> = {}): ReturnType<typeof planReply> =>
  planReply({ notices: [], maxMessages: B, maxLength: L, ...over })

const para = (tag: string, n: number): string => `${tag} ${'a'.repeat(n)}`

const RECREATED = '原会话无法恢复，已开启新会话。'
const LIMITED = '模型输出达到上限，回复可能不完整。'
const BUSY = '当前排队消息较多，请稍后再试。'
const QUEUE_EXPIRED = '等待时间过长，本条消息未处理，请重新发送。'
const TIMEOUT = '本次处理超时，请稍后重试。'

describe('4000 边界与装条（场景 1、5）', () => {
  it('正文恰 3999/4000 字符时装为一条，不截断', () => {
    for (const n of [3999, 4000]) {
      const r = plan({ text: 'a'.repeat(n) })
      expect(r.degraded).toBe(false)
      expect(r.truncated).toBe(false)
      expect(r.messages).toEqual(['a'.repeat(n)])
    }
  })

  it('正文 4001 字符的段落切成两条：4000 + 1', () => {
    const r = plan({ text: 'a'.repeat(4001) })
    expect(r.degraded).toBe(false)
    expect(r.truncated).toBe(false)
    expect(r.messages).toEqual(['a'.repeat(4000), 'a'])
  })

  it('4 个段落各近 4000：恰好 4 条完整正文，不截断（场景 5）', () => {
    const ps = ['P1', 'P2', 'P3', 'P4'].map((tag) => para(tag, 2990))
    const r = plan({ text: ps.join('\n\n') })
    expect(r.degraded).toBe(false)
    expect(r.truncated).toBe(false)
    expect(r.messages).toEqual(ps)
    for (const m of r.messages) expect(m.length).toBeLessThanOrEqual(L)
  })

  it('无提示、单条预算（maxMessages=1）装得下时不降级', () => {
    const r = planReply({ text: 'x'.repeat(100), notices: [], maxMessages: 1, maxLength: L })
    expect(r).toEqual({ messages: ['x'.repeat(100)], truncated: false, degraded: false })
  })
})

describe('Unicode 切分边界（场景 2）', () => {
  it('家族 emoji（11 单位/字素）硬切落在字素边界：3993 + 407', () => {
    const family = '👩‍👩‍👧‍👦'
    const r = plan({ text: family.repeat(400) })
    expect(r.degraded).toBe(false)
    expect(r.truncated).toBe(false)
    expect(r.messages).toEqual([family.repeat(363), family.repeat(37)])
    // 不拆 surrogate pair：每条消息的末字符是完整代理对的低位。
    for (const m of r.messages) {
      expect(m.length).toBeLessThanOrEqual(L)
      const last = m.charCodeAt(m.length - 1)
      expect(last >= 0xdc00 && last <= 0xdfff).toBe(true)
    }
  })

  it('组合字符文本边界落在字素末尾：2000 个 e+锐音符后接 x 分为 4000 + 1', () => {
    const cluster = 'e\u0301'
    const r = plan({ text: cluster.repeat(2000) + 'x' })
    expect(r.messages).toEqual([cluster.repeat(2000), 'x'])
  })

  it('中文长段优先按句末切：444 句 + 6 句', () => {
    const sentence = '这是测试句号结尾。'
    const r = plan({ text: sentence.repeat(450) })
    expect(r.degraded).toBe(false)
    expect(r.truncated).toBe(false)
    expect(r.messages).toEqual([sentence.repeat(444), sentence.repeat(6)])
  })
})

describe('长列表与代码块（场景 3、4）', () => {
  it('100 个 item 的列表按 item 拆为 3 条，item 完整不跨条（场景 3）', () => {
    const items = Array.from({ length: 100 }, (_, i) => `- item ${i} ${'x'.repeat(90)}`)
    const r = plan({ text: items.join('\n') })
    expect(r.degraded).toBe(false)
    expect(r.truncated).toBe(false)
    expect(r.messages.length).toBe(3)
    for (const m of r.messages) expect(m.length).toBeLessThanOrEqual(L)
    for (const item of items) {
      expect(r.messages.filter((m) => m.includes(item))).toHaveLength(1)
    }
  })

  it('超长 fenced code 按代码行拆段，每段独立围栏与语言标记（场景 4）', () => {
    const lines = Array.from({ length: 80 }, () => 'c'.repeat(100))
    const text = '```ts\n' + lines.join('\n') + '\n```'
    const r = plan({ text })
    expect(r.degraded).toBe(false)
    expect(r.truncated).toBe(false)
    expect(r.messages.length).toBe(3)
    const collected: string[] = []
    for (const m of r.messages) {
      expect(m.length).toBeLessThanOrEqual(L)
      expect(m.startsWith('```ts\n')).toBe(true)
      expect(m.endsWith('\n```')).toBe(true)
      collected.push(...m.split('\n').slice(1, -1))
    }
    // 代码行按原顺序完整保留。
    expect(collected).toEqual(lines)
  })

  it('代码内容含 ``` 时围栏升级为 ````', () => {
    const lines = Array.from({ length: 80 }, () => 'd'.repeat(97) + ' ```')
    const text = '```md\n' + lines.join('\n') + '\n```'
    const r = plan({ text })
    expect(r.degraded).toBe(false)
    expect(r.truncated).toBe(false)
    expect(r.messages.length).toBe(3)
    const collected: string[] = []
    for (const m of r.messages) {
      expect(m.length).toBeLessThanOrEqual(L)
      expect(m.startsWith('````md\n')).toBe(true)
      expect(m.endsWith('\n````')).toBe(true)
      collected.push(...m.split('\n').slice(1, -1))
    }
    expect(collected).toEqual(lines)
  })

  it('未闭合围栏原文被规范闭合（场景 4）', () => {
    const r = plan({ text: '说明：\n\n```python\nprint(1)' })
    expect(r).toEqual({
      messages: ['说明：\n\n```python\nprint(1)\n```'],
      truncated: false,
      degraded: false,
    })
  })
})

describe('截断重规划（场景 6、8、10）', () => {
  it('无提示超 4 条：3 条正文 + 1 条截断说明（场景 6）', () => {
    const ps = ['P1', 'P2', 'P3', 'P4', 'P5'].map((tag) => para(tag, 2990))
    const r = plan({ text: ps.join('\n\n') })
    expect(r.truncated).toBe(true)
    expect(r.degraded).toBe(false)
    expect(r.messages).toEqual([ps[0], ps[1], ps[2], TRUNCATED_TEXT])
    expect(r.messages.length).toBeLessThanOrEqual(B)
  })

  it('恢复提示 + 超长正文（段落）：末条正文 = 关闭围栏后的原文 + 截断说明（场景 8）', () => {
    const ps = ['P1', 'P2', 'P3', 'P4'].map((tag) => para(tag, 2990))
    const r = plan({ text: ps.join('\n\n'), notices: ['session-recreated'] })
    expect(r.truncated).toBe(true)
    expect(r.degraded).toBe(false)
    expect(r.messages).toEqual([RECREATED, ps[0], ps[1], `${ps[2]}\n${TRUNCATED_TEXT}`])
    expect(r.messages.length).toBe(4)
    for (const m of r.messages) expect(m.length).toBeLessThanOrEqual(L)
  })

  it('恢复提示 + 超长代码正文：末条正文以补齐的闭合围栏 + 截断说明结尾', () => {
    // 2395 行 aaaa（每行 4 字符）按预算拆为 4 段围栏块；预算 3 条 → 截断，末条在代码中间被截后补围栏。
    const body = '```ts\n' + 'aaaa\n'.repeat(2395)
    const r = plan({ text: body, notices: ['session-recreated'] })
    expect(r.truncated).toBe(true)
    expect(r.degraded).toBe(false)
    expect(r.messages.length).toBe(4)
    expect(r.messages[0]).toBe(RECREATED)
    const full = '```ts\n' + 'aaaa\n'.repeat(797) + 'aaaa\n```'
    expect(r.messages[1]).toBe(full)
    expect(r.messages[2]).toBe(full)
    const last = r.messages[3]
    expect(last.length).toBeLessThanOrEqual(L)
    expect(last.startsWith('```ts\n')).toBe(true)
    expect(last.endsWith(`\n\`\`\`\n${TRUNCATED_TEXT}`)).toBe(true)
    // 截断说明之前的部分是一个已闭合的围栏块。
    const beforeNote = last.slice(0, last.length - TRUNCATED_TEXT.length - 1)
    expect(beforeNote.endsWith('```')).toBe(true)
  })

  it('多提示（无恢复提示）+ 截断：说明并入末尾独立提示消息（场景 10）', () => {
    const ps = ['P1', 'P2', 'P3', 'P4', 'P5'].map((tag) => para(tag, 2990))
    const r = plan({ text: ps.join('\n\n'), notices: ['model-output-limited'] })
    expect(r.truncated).toBe(true)
    expect(r.degraded).toBe(false)
    expect(r.messages).toEqual([ps[0], ps[1], ps[2], `${LIMITED}\n${TRUNCATED_TEXT}`])
    expect(r.messages.length).toBeLessThanOrEqual(B)
  })
})

describe('提示消息位置与合并（场景 7、9、11）', () => {
  it('恢复提示排最前且提示消息在正文之前，即使 notices 中它不在首位（场景 7）', () => {
    const r = plan({ text: '正文内容', notices: ['model-output-limited', 'session-recreated'] })
    expect(r).toEqual({
      messages: [`${RECREATED}\n${LIMITED}`, '正文内容'],
      truncated: false,
      degraded: false,
    })
  })

  it('无正文：3 个提示合并为一条消息且顺序保持（场景 9）', () => {
    const r = plan({ notices: ['busy', 'queue-expired', 'turn-timeout'] })
    expect(r).toEqual({
      messages: [`${BUSY}\n${QUEUE_EXPIRED}\n${TIMEOUT}`],
      truncated: false,
      degraded: false,
    })
  })

  it('无正文且重复提示只保留一次', () => {
    const r = plan({ notices: ['busy', 'busy'] })
    expect(r.messages).toEqual([BUSY])
  })

  it('空白正文按无正文处理：只发提示', () => {
    const r = plan({ text: '   \n  ', notices: ['busy'] })
    expect(r.messages).toEqual([BUSY])
  })

  it('max-tokens 形状：有正文时提示在正文之后（场景 11）', () => {
    const r = plan({ text: '正常回复', notices: ['model-output-limited'] })
    expect(r).toEqual({
      messages: ['正常回复', LIMITED],
      truncated: false,
      degraded: false,
    })
  })
})

describe('degraded 路径（场景 12）', () => {
  it('maxMessages=1 且必须放提示 + 超长正文：自检失败返回兜底单条', () => {
    const r = planReply({
      text: 'x'.repeat(10000),
      notices: ['busy'],
      maxMessages: 1,
      maxLength: L,
    })
    expect(r).toEqual({ messages: [PLAN_FAILURE_TEXT], truncated: false, degraded: true })
  })

  it('notices 与正文都为空：防御性降级', () => {
    expect(planReply({ notices: [], maxMessages: B, maxLength: L })).toEqual({
      messages: [PLAN_FAILURE_TEXT],
      truncated: false,
      degraded: true,
    })
    expect(plan({ text: '   ' })).toEqual({
      messages: [PLAN_FAILURE_TEXT],
      truncated: false,
      degraded: true,
    })
  })

  it('合并提示本身超 L：按程序错误降级', () => {
    const r = planReply({
      notices: ['busy'],
      maxMessages: B,
      maxLength: 10,
    })
    expect(r).toEqual({ messages: [PLAN_FAILURE_TEXT], truncated: false, degraded: true })
  })
})

describe('固定文案表（场景 13）', () => {
  it('NOTICE_TEXTS 与 10.4 表逐条一致', () => {
    expect(NOTICE_TEXTS).toEqual({
      'session-recreated': '原会话无法恢复，已开启新会话。',
      'turn-failed': '本次处理失败，请稍后重试。',
      'turn-timeout': '本次处理超时，请稍后重试。',
      'empty-reply': '本次未生成可发送的文本，请稍后重试。',
      'model-output-limited': '模型输出达到上限，回复可能不完整。',
      busy: '当前排队消息较多，请稍后再试。',
      'queue-expired': '等待时间过长，本条消息未处理，请重新发送。',
      'service-stopping': '服务正在停止，请稍后重试。',
      'state-unavailable': '会话状态暂不可用，请稍后重试。',
    })
    expect(TRUNCATED_TEXT).toBe('回复过长，已截断。')
    expect(PLAN_FAILURE_TEXT).toBe('本次处理失败，请稍后重试。')
  })
})
