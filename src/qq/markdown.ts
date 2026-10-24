import { Lexer } from 'marked'
import type { NoticeKind } from '../contracts.js'

/**
 * QQ 回复规划纯函数（设计文档 10.1、10.2）：把最终正文与提示类型规划为实际发送的
 * markdown 消息序列。无 IO、无 SDK 依赖、无共享状态，长度与条数边界全部由输入给定，
 * 可独立验证（设计文档 2 节 qq 行"Markdown 规划"）。
 *
 * 长度口径：UTF-16 code units（`str.length`，保守）。切分优先 Unicode 字素边界，
 * 单字素超长退到码点边界，绝不拆开 surrogate pair。
 */

/** 固定提示文案表（设计文档 10.4），键序即 NoticeKind 声明序。 */
export const NOTICE_TEXTS: Readonly<Record<NoticeKind, string>> = {
  'session-recreated': '原会话无法恢复，已开启新会话。',
  'turn-failed': '本次处理失败，请稍后重试。',
  'turn-timeout': '本次处理超时，请稍后重试。',
  'empty-reply': '本次未生成可发送的文本，请稍后重试。',
  'model-output-limited': '模型输出达到上限，回复可能不完整。',
  busy: '当前排队消息较多，请稍后再试。',
  'queue-expired': '等待时间过长，本条消息未处理，请重新发送。',
  'service-stopping': '服务正在停止，请稍后重试。',
  'state-unavailable': '会话状态暂不可用，请稍后重试。',
}

/** 渠道规划产生的截断说明（10.4 表末行）；truncated 不是 NoticeKind，单独导出。 */
export const TRUNCATED_TEXT = '回复过长，已截断。'

/** 规划自检失败的兜底文案（10.2.6）；与 10.4 的 turn-failed 文案一致。 */
export const PLAN_FAILURE_TEXT = '本次处理失败，请稍后重试。'

export interface PlanInput {
  /** 最终正文；undefined 或 trim 后为空按无正文处理 */
  text?: string
  /** 顺序即渠道渲染优先级（来自 ReplyEnvelope.notices） */
  notices: readonly NoticeKind[]
  /** B：正文可用总条数上限（QQ 固定 4，算法尊重输入） */
  maxMessages: number
  /** L：单条消息 UTF-16 长度上限（QQ 固定 4000） */
  maxLength: number
}

export interface ReplyPlan {
  /** 按发送顺序的每条 markdown.content；degraded 时恰为 [PLAN_FAILURE_TEXT] */
  messages: readonly string[]
  /** 正文是否被截断 */
  truncated: boolean
  /** true = 规划自检失败，messages 恰为 [PLAN_FAILURE_TEXT] 一条 */
  degraded: boolean
}

/** 规划内部错误：被 planReply 捕获后降级为 degraded（10.2.6）。 */
class PlanError extends Error {}

/** 多条提示文案的拼接方式：换行连接——每条文案是完整句子，独立成行更可读（10.1 规则 1 的实现选择）。 */
const NOTICE_JOIN = '\n'

/** 句末切点（保守正则）：中文句号/问号/感叹号直接切，英文 . ! ? 需后随空白或行尾。 */
const SENTENCE_END_SOURCE = '[。！？]|[.!?]+(?=\\s|$)'

/** fenced code 开启围栏行：0-3 空格缩进 + 3 个以上反引号或波浪线 + info 串。 */
const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/** 可能延续前一字素的码点（组合标记、区域指示符、Hangul 扩展、ZWJ）；用于把字素观察窗口的起点回退到近似字素起点。 */
const CLUSTER_CONTINUATION = /[\p{M}\p{Regional_Indicator}\p{Extender}\u200D]/u

/** 待装条单元：text 恒非空且 ≤ maxLength；gap 是与前一单元同条时的连接符（原块间空白或换行）。 */
interface Unit {
  text: string
  gap: string
}

/** fenced code 的解析结果。 */
interface FencedCode {
  fenceChar: '`' | '~'
  openLen: number
  info: string
  bodyLines: string[]
  closed: boolean
}

/** 自检所需的期望形状：提示消息应出现的位置与精确文本。 */
interface NoticeShape {
  noticeMessage: string | null
  noticePosition: 'first' | 'last' | null
}

let segmenterSingleton: Intl.Segmenter | undefined

function getSegmenter(): Intl.Segmenter {
  if (segmenterSingleton === undefined) {
    segmenterSingleton = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  }
  return segmenterSingleton
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff
}

function isWhitespaceUnit(unit: number): boolean {
  return unit === 0x20 || unit === 0x09 || unit === 0x0a || unit === 0x0d || unit === 0x0b || unit === 0x0c || unit === 0xa0 || unit === 0x1680 || unit === 0x2028 || unit === 0x2029 || unit === 0xfeff || (unit >= 0x2000 && unit <= 0x200a)
}

/**
 * 取不超过 maxLen 的合法边界前缀。只在切分点附近开观察窗口（约 64 单位），
 * 并把窗口起点回退越过可能延续前一字素的码点；取窗口内最后一个 ≤ maxLen 的字素边界。
 * 窗口内找不到边界（单字素超长等）时退到码点边界，绝不拆开 surrogate pair。
 */
function graphemeSafePrefix(text: string, maxLen: number): string {
  if (maxLen <= 0) return ''
  if (text.length <= maxLen) return text
  let w = Math.max(0, maxLen - 64)
  // 回退整码点（不落在代理对中间），直到窗口起点不再是延续码点。
  while (w > 0) {
    const prev = w - 1
    let cpStart = prev
    if (prev > 0 && isLowSurrogate(text.charCodeAt(prev)) && isHighSurrogate(text.charCodeAt(prev - 1))) {
      cpStart = prev - 1
    }
    const cp = text.codePointAt(cpStart)
    if (cp === undefined || !CLUSTER_CONTINUATION.test(String.fromCodePoint(cp))) break
    w = cpStart
  }
  let lastBoundary = -1
  for (const seg of getSegmenter().segment(text.slice(w))) {
    const end = w + seg.index + seg.segment.length
    if (end > maxLen) break
    lastBoundary = end
  }
  if (lastBoundary > 0) return text.slice(0, lastBoundary)
  // 退化：码点边界硬切（保证不拆 surrogate pair，可能拆字素）。
  let cut = maxLen
  if (isHighSurrogate(text.charCodeAt(cut - 1))) cut -= 1
  return text.slice(0, Math.max(0, cut))
}

/** 在 text[0..limit] 内找最后一个句末切点（含其后空白），没有返回 -1。 */
function lastSentenceCut(text: string, limit: number): number {
  const re = new RegExp(SENTENCE_END_SOURCE, 'g')
  let last = -1
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    let end = m.index + m[0].length
    while (end < text.length && isWhitespaceUnit(text.charCodeAt(end))) end += 1
    if (end > limit) break
    last = end
  }
  return last
}

/** 句子 → 空白 → 字素 的逐级降级切窗（普通文本行；返回 [head, rest]，head ≤ limit 且非空）。 */
function cutTextWindow(text: string, limit: number): [string, string] {
  if (limit < 1) throw new PlanError('limit too small for text cut')
  if (text.length <= limit) return [text, '']
  const sentenceCut = lastSentenceCut(text, limit)
  if (sentenceCut > 0) {
    return [text.slice(0, sentenceCut), text.slice(sentenceCut)]
  }
  for (let i = limit - 1; i > 0; i -= 1) {
    if (isWhitespaceUnit(text.charCodeAt(i))) {
      const head = text.slice(0, i).replace(/\s+$/u, '')
      if (head.length > 0) return [head, text.slice(i).replace(/^\s+/u, '')]
      break
    }
  }
  const head = graphemeSafePrefix(text, limit)
  if (head.length === 0) throw new PlanError('text cut made no progress')
  return [head, text.slice(head.length)]
}

/** 字符 ch 在文本中的最长连续串长度（围栏冲突规避用）。 */
function longestRun(text: string, ch: string): number {
  let best = 0
  let cur = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === ch) {
      cur += 1
      if (cur > best) best = cur
    } else {
      cur = 0
    }
  }
  return best
}

/** 围栏字符数：max(3, 开启长度, 内容中同字符最长串 + 1)，避免与代码内容里的围栏冲突。 */
function safeFenceLen(fenceChar: string, openLen: number, content: string): number {
  return Math.max(3, openLen, longestRun(content, fenceChar) + 1)
}

/** 同字符闭合围栏的正则（缩进 ≤3、只允许围栏与尾随空白、长度 ≥ minLen）。 */
function closerRegex(fenceChar: '`' | '~', minLen: number): RegExp {
  const ch = fenceChar === '`' ? '`' : '~'
  return new RegExp(`^ {0,3}\\${ch}{${minLen},}\\s*$`)
}

/** 解析 fenced code 块原文；非围栏形态（含缩进代码块、info 含反引号的行）返回 null。 */
function parseFencedCode(raw: string): FencedCode | null {
  const stripped = raw.endsWith('\n') ? raw.slice(0, -1) : raw
  const lines = stripped.split('\n')
  const m = OPEN_FENCE.exec(lines[0] ?? '')
  if (!m || m[1].length < 3) return null
  const fenceChar = m[1][0] as '`' | '~'
  // 反引号围栏的 info 串不允许再含反引号（CommonMark），否则整块按普通文本降级。
  if (fenceChar === '`' && m[2].includes('`')) return null
  const openLen = m[1].length
  const info = m[2].trim()
  const closer = closerRegex(fenceChar, openLen)
  let closeIdx = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (closer.test(lines[i] ?? '')) closeIdx = i
  }
  return {
    fenceChar,
    openLen,
    info,
    bodyLines: lines.slice(1, closeIdx === -1 ? lines.length : closeIdx),
    closed: closeIdx !== -1,
  }
}

/** 扫描顶层围栏状态：返回未闭合的开启围栏，已闭合或无围栏返回 null。引用块内的围栏不识别（截断补围栏只处理顶层，引用内截断属可接受的展示不等价）。 */
function openCodeFence(text: string): { fenceChar: '`' | '~'; openLen: number } | null {
  let open: { fenceChar: '`' | '~'; openLen: number } | null = null
  for (const line of text.split('\n')) {
    if (open !== null) {
      if (closerRegex(open.fenceChar, open.openLen).test(line)) open = null
      continue
    }
    const m = OPEN_FENCE.exec(line)
    if (m && m[1].length >= 3 && !(m[1][0] === '`' && m[2].includes('`'))) {
      open = { fenceChar: m[1][0] as '`' | '~', openLen: m[1].length }
    }
  }
  return open
}

/** 列表项续行缩进：首行标记前缀（缩进 + 标记 + 空白）的宽度，用空格对齐。 */
function listContinuationPrefix(itemRaw: string): string {
  const firstLine = itemRaw.split('\n')[0] ?? ''
  const m = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)/.exec(firstLine)
  if (!m) return ''
  return ' '.repeat(m[0].length)
}

/**
 * 把超长文本块按行降级为 ≤ maxLength 的单元序列；块内空行不产生单元（块级空行由块间 gap 承担）。
 * contPrefix 用于列表项续段缩进：首段用满预算，续段预算扣除前缀后拼接。
 */
function splitTextLinesToUnits(raw: string, maxLength: number, contPrefix: string, firstGap: string): Unit[] {
  const contLimit = maxLength - contPrefix.length
  if (contLimit < 1) throw new PlanError('maxLength too small for continuation prefix')
  const units: Unit[] = []
  let gap = firstGap
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    if (line.length <= maxLength) {
      units.push({ text: line, gap })
    } else {
      let rest = line
      let first = true
      while (rest.length > 0) {
        const [head, tail] = cutTextWindow(rest, first ? maxLength : contLimit)
        units.push({ text: first ? head : contPrefix + head, gap })
        rest = tail
        first = false
        gap = '\n'
      }
      gap = '\n'
      continue
    }
    gap = '\n'
  }
  return units
}

/**
 * 把超长 fenced code 按代码行拆为多段，每段独立补开闭围栏与语言标记；
 * 围栏与换行开销计入预算；单行超长按字素边界硬切（代码行不用句子规则）。
 */
function splitCodeToUnits(parsed: FencedCode, fenceLen: number, gapBefore: string, maxLength: number): Unit[] {
  const header = parsed.fenceChar.repeat(fenceLen) + parsed.info
  const close = parsed.fenceChar.repeat(fenceLen)
  // 每段固定开销：header + '\n' + 行内容（各行含换行）+ '\n' + 闭合围栏。
  const base = header.length + 1 + 1 + close.length
  const avail = maxLength - base
  if (avail < 1) throw new PlanError('maxLength too small for code segment')
  const units: Unit[] = []
  let cur: string[] = []
  let curLen = 0
  let gap = gapBefore
  const flush = () => {
    if (cur.length === 0) return
    units.push({ text: header + '\n' + cur.join('\n') + '\n' + close, gap })
    gap = '\n\n'
    cur = []
    curLen = 0
  }
  for (const line of parsed.bodyLines) {
    const pieces: string[] = []
    if (line.length + 1 <= avail) {
      pieces.push(line)
    } else {
      let rest = line
      while (rest.length > 0) {
        const head = graphemeSafePrefix(rest, avail - 1)
        if (head.length === 0) throw new PlanError('code line cannot fit')
        pieces.push(head)
        rest = rest.slice(head.length)
      }
    }
    for (const piece of pieces) {
      const cost = piece.length + 1
      if (curLen + cost > avail && cur.length > 0) flush()
      cur.push(piece)
      curLen += cost
    }
  }
  flush()
  if (units.length === 0) {
    // 空代码体（仅围栏对）也产出可发送单元。
    units.push({ text: header + '\n' + close, gap: gapBefore })
  }
  return units
}

/** fenced code 块 → 单元：未闭合先规范为可独立展示的块（补闭合围栏），超长再分段。 */
function codeBlockUnits(raw: string, gapBefore: string, maxLength: number): Unit[] {
  const parsed = parseFencedCode(raw)
  if (parsed === null) {
    // 缩进代码块等无围栏形态：按普通行降级（保留原文，不重建围栏）。
    return splitTextLinesToUnits(raw, maxLength, '', gapBefore)
  }
  const content = parsed.bodyLines.join('\n')
  const fenceLen = safeFenceLen(parsed.fenceChar, parsed.openLen, content)
  if (!parsed.closed) {
    const withNewline = raw.endsWith('\n') ? raw : raw + '\n'
    const normalized = withNewline + parsed.fenceChar.repeat(fenceLen)
    if (normalized.length <= maxLength) return [{ text: normalized, gap: gapBefore }]
    return splitCodeToUnits(parsed, fenceLen, gapBefore, maxLength)
  }
  if (raw.length <= maxLength) return [{ text: raw, gap: gapBefore }]
  return splitCodeToUnits(parsed, fenceLen, gapBefore, maxLength)
}

/** 超长列表 → 按 list item 拆分；item 原文（含嵌套内容与尾随换行）保持完整，单 item 超长按行降级并保留缩进。 */
function listToUnits(itemsRaw: readonly string[], gapBefore: string, maxLength: number): Unit[] {
  const units: Unit[] = []
  let gap = gapBefore
  for (const itemRaw of itemsRaw) {
    if (itemRaw.length <= maxLength) {
      // item 原文自带尾随换行，相邻 item 的 gap 为空串即可按原文拼接。
      units.push({ text: itemRaw, gap })
    } else {
      units.push(...splitTextLinesToUnits(itemRaw, maxLength, listContinuationPrefix(itemRaw), gap))
    }
    gap = ''
  }
  return units
}

/** 正文 → 待装条单元序列：marked Lexer（GFM）取顶层块原文区间，整块 ≤ L 直接保留，超长按类型降级。 */
function buildUnits(text: string, maxLength: number): Unit[] {
  const tokens = Lexer.lex(text, { gfm: true })
  // 原文区间校验：marked 的顶层 token.raw 应恰好铺满原文；否则放弃块切分，整体按普通文本行降级。
  if (tokens.map((t) => t.raw).join('') !== text) {
    return splitTextLinesToUnits(text, maxLength, '', '')
  }
  const units: Unit[] = []
  let pendingGap = ''
  for (const tok of tokens) {
    if (tok.type === 'space') {
      pendingGap += tok.raw
      continue
    }
    const gapBefore = pendingGap
    pendingGap = ''
    if (tok.type === 'code') {
      units.push(...codeBlockUnits(tok.raw, gapBefore, maxLength))
    } else if (tok.type === 'list') {
      if (tok.raw.length <= maxLength) {
        units.push({ text: tok.raw, gap: gapBefore })
      } else {
        units.push(...listToUnits(tok.items.map((it: { raw: string }) => it.raw), gapBefore, maxLength))
      }
    } else if (tok.raw.length <= maxLength) {
      units.push({ text: tok.raw, gap: gapBefore })
    } else {
      // 段落、标题、表格、引用、HTML 等超长：按行降级（引用保留 > 前缀、表格按行硬切），
      // 不承诺复杂 Markdown 展示完全等价（10.2 条 4）。
      units.push(...splitTextLinesToUnits(tok.raw, maxLength, '', gapBefore))
    }
  }
  if (units.length === 0) return splitTextLinesToUnits(text, maxLength, '', '')
  return units
}

/** 贪心装条：最多收集 maxCount 条；装不下更多时停止并标记 overflow（此时 messages 恰有 maxCount 条）。 */
function packUnits(units: readonly Unit[], maxLength: number, maxCount: number): { messages: string[]; overflow: boolean } {
  const messages: string[] = []
  let cur = ''
  for (const u of units) {
    if (u.text.length === 0) continue
    const cand = cur === '' ? u.text : cur + u.gap + u.text
    if (cand.length <= maxLength) {
      cur = cand
      continue
    }
    if (cur !== '') {
      if (messages.length >= maxCount) return { messages, overflow: true }
      messages.push(cur)
      cur = ''
    }
    if (u.text.length > maxLength) throw new PlanError('unit exceeds maxLength')
    cur = u.text
  }
  if (cur !== '') {
    if (messages.length >= maxCount) return { messages, overflow: true }
    messages.push(cur)
  }
  return { messages, overflow: false }
}

/**
 * 在最后一条正文后追加截断说明（有恢复提示的截断路径，10.1 规则 3）：
 * 先为换行、可能需要补的闭合围栏与说明文本预留字符，再取合法边界前缀，
 * 使该条总长仍 ≤ L；前缀落在代码块中间时先补闭合围栏（10.2 条 4）。
 */
function appendTruncationNote(message: string, maxLength: number): string {
  // 保守闭合围栏长度：消息内任一围栏字符的最长串 + 1（覆盖可能的开启围栏长度）。
  const closingLen = Math.max(3, longestRun(message, '`') + 1, longestRun(message, '~') + 1)
  const reserve = 1 + closingLen + 1 + TRUNCATED_TEXT.length
  const available = maxLength - reserve
  if (available < 1) throw new PlanError('no room for truncation note')
  let head = graphemeSafePrefix(message, available)
  const open = openCodeFence(head)
  if (open !== null) {
    head = head + '\n' + open.fenceChar.repeat(Math.max(3, open.openLen))
  }
  const result = head + '\n' + TRUNCATED_TEXT
  if (result.length > maxLength || head.length === 0) throw new PlanError('truncation note overflow')
  return result
}

/** 渠道渲染顺序：恢复提示恒排最前，其余保持输入顺序；重复提示只保留首次出现。 */
function orderNotices(notices: readonly NoticeKind[]): NoticeKind[] {
  const seen = new Set<NoticeKind>()
  const recreated: NoticeKind[] = []
  const rest: NoticeKind[] = []
  for (const n of notices) {
    if (seen.has(n)) continue
    seen.add(n)
    if (n === 'session-recreated') recreated.push(n)
    else rest.push(n)
  }
  return [...recreated, ...rest]
}

function degradedPlan(): ReplyPlan {
  return { messages: [PLAN_FAILURE_TEXT], truncated: false, degraded: true }
}

/**
 * 规划自检（10.2 条 5）：条数 ≤ B、每条 ≤ L 且非空、提示消息位置精确匹配、
 * truncated 为 true 时末条确实含截断说明。任一失败 → degraded 单条兜底。
 */
function finalize(
  messages: string[],
  truncated: boolean,
  shape: NoticeShape,
  maxMessages: number,
  maxLength: number,
): ReplyPlan {
  if (messages.length === 0 || messages.length > maxMessages) return degradedPlan()
  for (const m of messages) {
    if (m.length === 0 || m.length > maxLength) return degradedPlan()
  }
  if (shape.noticeMessage !== null) {
    if (shape.noticePosition === 'first' && messages[0] !== shape.noticeMessage) return degradedPlan()
    if (shape.noticePosition === 'last' && messages[messages.length - 1] !== shape.noticeMessage) {
      return degradedPlan()
    }
  }
  if (truncated && !messages[messages.length - 1].includes(TRUNCATED_TEXT)) return degradedPlan()
  return { messages, truncated, degraded: false }
}

function planReplyInner(input: PlanInput): ReplyPlan {
  const maxMessages = input.maxMessages
  const maxLength = input.maxLength
  if (!Number.isInteger(maxMessages) || maxMessages < 1 || !Number.isInteger(maxLength) || maxLength < 1) {
    throw new PlanError('invalid planning limits')
  }
  const hasBody = typeof input.text === 'string' && input.text.trim() !== ''
  const kinds = orderNotices(input.notices)
  const hasNotices = kinds.length > 0
  if (!hasBody && !hasNotices) return degradedPlan()
  let noticeMsg: string | null = null
  if (hasNotices) {
    const texts = kinds.map((k) => NOTICE_TEXTS[k])
    if (texts.some((t) => typeof t !== 'string')) throw new PlanError('unknown notice kind')
    noticeMsg = texts.join(NOTICE_JOIN)
    // 合并提示本身超 L：固定文案属程序错误，直接降级（10.1 规则 1）。
    if (noticeMsg.length > maxLength) return degradedPlan()
  }
  const hasRecreated = kinds.includes('session-recreated')

  // 正文预算：有提示时 B-1，无提示时 B；只多装一条用于判断是否溢出。
  let bodyMessages: string[] = []
  let overflow = false
  if (hasBody) {
    const bodyBudget = hasNotices ? maxMessages - 1 : maxMessages
    if (bodyBudget < 1) {
      // 正文存在却连一条槽位都没有：整段正文会被丢弃，属不可规划。
      return degradedPlan()
    }
    const packed = packUnits(buildUnits(input.text ?? '', maxLength), maxLength, bodyBudget + 1)
    bodyMessages = packed.messages
    overflow = packed.overflow || bodyMessages.length > bodyBudget
  }

  if (!overflow) {
    if (noticeMsg === null) {
      return finalize(bodyMessages, false, { noticeMessage: null, noticePosition: null }, maxMessages, maxLength)
    }
    if (hasRecreated) {
      return finalize(
        [noticeMsg, ...bodyMessages],
        false,
        { noticeMessage: noticeMsg, noticePosition: 'first' },
        maxMessages,
        maxLength,
      )
    }
    return finalize(
      [...bodyMessages, noticeMsg],
      false,
      { noticeMessage: noticeMsg, noticePosition: 'last' },
      maxMessages,
      maxLength,
    )
  }

  // 截断重规划（10.1 规则 3）。
  if (hasRecreated) {
    // 保留最前面的独立恢复提示；正文取前 B-1 条，截断说明追加进最后一条正文。
    const bodyBudget = maxMessages - 1
    const kept = bodyMessages.slice(0, bodyBudget)
    if (kept.length === 0) return degradedPlan()
    const last = appendTruncationNote(kept[kept.length - 1], maxLength)
    const messages = [noticeMsg!, ...kept.slice(0, -1), last]
    return finalize(
      messages,
      true,
      { noticeMessage: noticeMsg, noticePosition: 'first' },
      maxMessages,
      maxLength,
    )
  }
  if (noticeMsg !== null) {
    // 无恢复提示：截断说明并入末尾独立提示消息（其他提示文案 + 截断说明的合并文本）。
    const bodyBudget = maxMessages - 1
    const kept = bodyMessages.slice(0, bodyBudget)
    if (kept.length === 0) return degradedPlan()
    const noticeWithNote = noticeMsg + NOTICE_JOIN + TRUNCATED_TEXT
    if (noticeWithNote.length > maxLength) return degradedPlan()
    return finalize(
      [...kept, noticeWithNote],
      true,
      { noticeMessage: noticeWithNote, noticePosition: 'last' },
      maxMessages,
      maxLength,
    )
  }
  // 原本无提示、正文超 B 条：重新按 (B-1) 条正文 + 1 条含截断说明的独立提示规划。
  const bodyBudget = maxMessages - 1
  if (bodyBudget < 1) return degradedPlan()
  const kept = bodyMessages.slice(0, bodyBudget)
  return finalize([...kept, TRUNCATED_TEXT], true, { noticeMessage: null, noticePosition: null }, maxMessages, maxLength)
}

/**
 * 回复规划入口：输入最终正文 + 提示类型 + 边界，输出按发送顺序的消息序列。
 * 纯函数；任何内部异常都收敛为 degraded 单条兜底，不抛出（调用方据 degraded 记录规划错误）。
 */
export function planReply(input: PlanInput): ReplyPlan {
  try {
    return planReplyInner(input)
  } catch {
    // 内部异常与自检失败同路径：只发一条固定失败提示（10.2 条 6）。
    return degradedPlan()
  }
}
