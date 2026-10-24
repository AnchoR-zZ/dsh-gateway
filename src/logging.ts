/**
 * 结构化日志器（设计文档 14 节、11.3）：每条日志是一个 JSON 对象，单行输出到 sink（默认 stdout）。
 *
 * 原始 user_openid 和 AppID 不作为独立字段输出——LogFields 不提供这两个字段；但 QQ 的
 * bindingId 由 `qq_<AppID>_<user_openid>` 组成，会随 bindingId 字段记录，便于按身份关联日志。
 *
 * debug 配置项在创建日志器时固定，关闭开关需重启生效；正文日志仅在 debug 开启时输出，
 * 且即便开启也持续脱敏凭证、Authorization、token 与已知 secret 形态。
 * 错误只记录调用方已脱敏为字符串的 message，不直接序列化可能夹带 prompt、工具参数
 * 或响应体的 error 对象。
 */

/** 14 节列出的事件类别；后续任务可扩充联合类型。 */
export type GatewayLogEvent =
  | 'inbound_ignored'
  | 'inbound_rejected'
  | 'queued'
  | 'session_created'
  | 'session_resumed'
  | 'session_recreated'
  | 'turn_completed'
  | 'turn_failed'
  | 'turn_timeout'
  | 'late_result_dropped'
  | 'reply_sent'
  | 'reply_partial'
  | 'reply_unknown'
  /** deliver 抛错或返回 failed/expired/closed：core 不因渠道失败重试（设计 12 节投递边界）。 */
  | 'reply_failed'
  | 'state_failed'
  /** 非致命的状态持久化边界告警（如 win32 目录 fsync 失败），不代表 store 转 failed。 */
  | 'state_warning'
  | 'channel_reconnecting'
  | 'manual_restart_required'
  | 'shutdown'
  /** T10 新增：启动摘要（14 节）——版本、映射 schema、provider/model 与有效策略；不 dump 环境或完整配置。 */
  | 'startup_summary'

/** 结构化字段；值只允许 string | number，undefined 的字段在序列化时省略。 */
export interface LogFields {
  requestId?: string
  channelId?: string
  bindingId?: string
  sessionId?: string
  generation?: number
  messageId?: string
  turn?: number
  inputLength?: number
  outputLength?: number
  queueWaitMs?: number
  runMs?: number
  deliveryMs?: number
  outcome?: string
  reason?: string
  error?: string
  /** T8 新增：reply port 投递报告的发送次数（attempted=已消耗预算，confirmed=平台确认成功）。 */
  attempted?: number
  /** T8 新增：reply port 投递报告的平台确认成功次数，与 attempted 成对出现。 */
  confirmed?: number
  /** T8 新增：inbound_ignored 记录的附件个数（0=无附件；非数组真值按 1 记）。 */
  attachmentCount?: number
  /** T10 新增（startup_summary）：插件版本（package.json version）。 */
  version?: string
  /** T10 新增（startup_summary）：映射文件 schema 版本。 */
  schemaVersion?: number
  /** 配置文件 schema 版本；与映射文件的 schemaVersion 分开记录。 */
  configSchemaVersion?: number
  /** T10 新增（startup_summary）：当前模型选择的 provider 路由。 */
  provider?: string
  /** T10 新增（startup_summary）：当前模型选择的 model id。 */
  model?: string
  /** T10 新增（startup_summary）：有效策略摘要（审批/sandbox/工作目录边界）。 */
  policy?: string
  /** T10 新增（startup_summary）：并行任务与 live handle 上限。 */
  maxConcurrent?: number
  maxLiveAgents?: number
}

export interface GatewayLogger {
  logEvent(event: GatewayLogEvent, fields?: LogFields): void
  debugBody(kind: 'inbound' | 'outbound', text: string, fields?: LogFields): void
}

const REDACTED = '[REDACTED]'

/**
 * 保守的凭证脱敏正则集合，按序整体替换。宁可多脱（假阳性只损失可读性），不可漏脱。
 * 覆盖：Authorization 头、Bearer 令牌、`"secret": "..."` JSON 字段形态、
 * `token=...` / `secret: ...` 赋值形态（含 QQ AppSecret、旧环境变量或配置转储之类形态）。
 */
const REDACTION_RULES: readonly { pattern: RegExp; replacement: string }[] = [
  { pattern: /\b(authorization\s*:\s*)[^\r\n"']+/gi, replacement: '$1' + REDACTED },
  { pattern: /\b(bearer\s+)[A-Za-z0-9-._~+/]+=*/gi, replacement: '$1' + REDACTED },
  {
    pattern: /("(?:[A-Za-z0-9_-]*(?:secret|token|api[-_]?key|password|credential)[A-Za-z0-9_-]*)"\s*:\s*")[^"]*(")/gi,
    replacement: '$1' + REDACTED + '$2',
  },
  {
    pattern: /\b([A-Za-z0-9_-]*(?:secret|token|api[-_]?key|password|credential)[A-Za-z0-9_-]*\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&'"}\]])+/gi,
    replacement: '$1' + REDACTED,
  },
]

/** 把文本中的凭证形态替换为 [REDACTED]；纯函数，无状态。 */
export function redact(text: string): string {
  let result = text
  for (const rule of REDACTION_RULES) {
    result = result.replace(rule.pattern, rule.replacement)
  }
  return result
}

/** 追加结构化字段：跳过 undefined；error 与 reason 这类自由文本再过一次 redact。 */
function appendFields(target: Record<string, string | number>, fields: LogFields): void {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue
    }
    target[key] = key === 'error' || key === 'reason' ? redact(value) : value
  }
}

/**
 * 创建网关日志器。sink 可注入（测试或重定向），默认逐行输出到 stdout。
 * debug 标志固定于创建时，变更需重启进程。
 */
export function createGatewayLogger(options: {
  debug: boolean
  sink?: (line: string) => void
}): GatewayLogger {
  const sink: (line: string) => void = options.sink ?? ((line) => console.log(line))
  return {
    logEvent(event, fields) {
      const line: Record<string, string | number> = { event, time: new Date().toISOString() }
      if (fields !== undefined) {
        appendFields(line, fields)
      }
      sink(JSON.stringify(line))
    },
    debugBody(kind, text, fields) {
      // 关闭时完全 no-op：不输出正文，也不产生空行。
      if (!options.debug) {
        return
      }
      const line: Record<string, string | number> = {
        event: 'debug_body',
        time: new Date().toISOString(),
        kind,
        text: redact(text),
      }
      if (fields !== undefined) {
        appendFields(line, fields)
      }
      sink(JSON.stringify(line))
    },
  }
}
