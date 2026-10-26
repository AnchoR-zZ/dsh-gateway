import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { isValidBindingScope } from '../contracts.js'

/**
 * 网关配置：唯一环境变量 `DSH_GATEWAY_WORKSPACE` 加 `<workspace>/gateway.config.json`。
 *
 * 环境变量只决定 workspace 根；配置文件承载渠道实例凭证、debug 和调度/回收参数。未知字段、
 * 类型错误、非法路径等一律抛 GatewayConfigError 拒绝启动。错误消息只包含字段名/路径与原因，
 * 不包含 appSecret 的值。
 *
 * schemaVersion 2：QQ 凭证移入 `channels.qq` 实例数组，每个实例以 `appId` 标识并携带独立的
 * `enabled` 开关；数组可为空（未配置任何 bot）。检测到 schemaVersion 1 的旧文档时由
 * config/store.ts 自动迁移为 v2 并写回（单向）。本模块保持无文件 IO。
 */

/** 配置文件当前唯一支持的 schema 版本。 */
export const GATEWAY_CONFIG_SCHEMA_VERSION = 2

/** `<DSH_GATEWAY_WORKSPACE>` 未设置时的默认目录名，位于操作系统 home 下。 */
export const DEFAULT_GATEWAY_WORKSPACE_DIRNAME = '.dsh-gateway'

/** 渠道实例 `appId` trim 后的最大长度。 */
export const CHANNEL_APP_ID_MAX_LENGTH = 128

/** 渠道实例 `appSecret` trim 后的最大长度。 */
export const CHANNEL_APP_SECRET_MAX_LENGTH = 256

/** QQ 渠道实例配置；实例标识为 `appId`，启用与凭证分层。 */
export interface QQChannelInstance {
  readonly appId: string
  readonly appSecret: string
  readonly enabled: boolean
}

/** 类型化运行时配置；启动时解析一次。除 channel 实例的增改启（管理路由热生效）外，变更走重启。 */
export interface GatewayConfig {
  /** `<workspace>/state`。 */
  readonly stateDir: string
  /** `<workspace>/users`。 */
  readonly workspaceRoot: string
  /** 启动时加载的 QQ 实例清单（含 disabled 实例）。 */
  readonly qqInstances: readonly QQChannelInstance[]
  readonly debug: boolean
  readonly maxConcurrent: number
  readonly maxPendingPerPeer: number
  readonly maxPendingTotal: number
  readonly maxPendingBytes: number
  readonly idleAgentTtlMs: number
  readonly maxLiveAgents: number
}

/** 配置文件中的完整字段形状；`schemaVersion` 必填，其余字段可缺省取默认值。 */
export interface GatewayConfigFile {
  readonly schemaVersion: typeof GATEWAY_CONFIG_SCHEMA_VERSION
  /** 渠道实例表；本期只支持 `qq` 键。 */
  readonly channels: { readonly qq: readonly QQChannelInstance[] }
  readonly debug: boolean
  readonly maxConcurrent: number
  readonly maxPendingPerPeer: number
  readonly maxPendingTotal: number
  readonly maxPendingBytes: number
  readonly idleAgentTtlMs: number
  readonly maxLiveAgents: number
}

/** 配置无效；message 指明字段/路径与原因，不包含凭证值。 */
export class GatewayConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'GatewayConfigError'
  }
}

/** 配置模板与缺省值；`channels.qq` 为空数组（未配置任何 bot）。 */
const DEFAULT_GATEWAY_CONFIG_FILE: GatewayConfigFile = Object.freeze({
  schemaVersion: GATEWAY_CONFIG_SCHEMA_VERSION,
  channels: Object.freeze({ qq: Object.freeze([]) }),
  debug: false,
  maxConcurrent: 4,
  maxPendingPerPeer: 3,
  maxPendingTotal: 100,
  maxPendingBytes: 8_388_608,
  idleAgentTtlMs: 900_000,
  maxLiveAgents: 32,
})

/** 生成配置文件文本（UTF-8 JSON，2 空格缩进，结尾换行）；模板与保存写回共用同一序列化。 */
export function serializeGatewayConfigFile(file: GatewayConfigFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

/** 生成首次启动写入的配置文件内容；写入后可直接按 v2 加载（零实例）。 */
export function createGatewayConfigTemplate(): string {
  return serializeGatewayConfigFile(DEFAULT_GATEWAY_CONFIG_FILE)
}

/**
 * 解析唯一网关环境变量：未设置或 trim 后为空时返回默认 `<homeDir>/.dsh-gateway`；
 * 显式值必须是绝对路径，不展开 `~`，相对路径直接拒绝。
 */
export function resolveGatewayWorkspace(
  env: Record<string, string | undefined>,
  homeDir: string = homedir(),
): string {
  const raw = env.DSH_GATEWAY_WORKSPACE
  const value = raw === undefined ? '' : raw.trim()
  if (value === '') {
    return resolve(join(homeDir, DEFAULT_GATEWAY_WORKSPACE_DIRNAME))
  }
  if (!isAbsolute(value)) {
    throw new GatewayConfigError('DSH_GATEWAY_WORKSPACE must be an absolute path')
  }
  return resolve(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fieldError(configPath: string, field: string, reason: string): GatewayConfigError {
  return new GatewayConfigError(`${configPath}: ${field} ${reason}`)
}

function requireSchemaVersion(value: unknown, configPath: string): 2 {
  if (value === undefined) {
    throw fieldError(configPath, 'schemaVersion', 'is required')
  }
  if (value !== GATEWAY_CONFIG_SCHEMA_VERSION) {
    throw fieldError(
      configPath,
      'schemaVersion',
      `must be ${GATEWAY_CONFIG_SCHEMA_VERSION}; unsupported version ${String(value)}`,
    )
  }
  return GATEWAY_CONFIG_SCHEMA_VERSION
}

function requireNonEmptyString(value: unknown, configPath: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw fieldError(configPath, field, 'must be a non-empty string')
  }
  return value.trim()
}

function optionalBoolean(value: unknown, configPath: string, field: string, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback
  }
  if (typeof value !== 'boolean') {
    throw fieldError(configPath, field, 'must be a boolean')
  }
  return value
}

function optionalPositiveInteger(
  value: unknown,
  configPath: string,
  field: string,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw fieldError(configPath, field, 'must be a positive integer')
  }
  return value
}

/** 校验单个 QQ 渠道实例对象；只允许 `appId`、`appSecret`、`enabled` 三个字段。 */
function parseQQInstance(value: unknown, configPath: string, index: number): QQChannelInstance {
  const field = `channels.qq[${index}]`
  if (!isPlainObject(value)) {
    throw fieldError(configPath, field, 'must be an object')
  }
  for (const key of Object.keys(value)) {
    if (key !== 'appId' && key !== 'appSecret' && key !== 'enabled') {
      throw fieldError(configPath, `${field}`, `unknown field "${key}"`)
    }
  }
  const appId = requireNonEmptyString(value.appId, configPath, `${field}.appId`)
  if (appId.length > CHANNEL_APP_ID_MAX_LENGTH) {
    throw fieldError(configPath, `${field}.appId`, `must be at most ${CHANNEL_APP_ID_MAX_LENGTH} characters`)
  }
  // appId 是 bindingId 的前缀段（isValidBindingScope）：前置拒绝会在注册面被拒、
  // 永远 blocked 的字符（如含 `_`）。
  if (!isValidBindingScope(appId)) {
    throw fieldError(configPath, `${field}.appId`, 'must only contain [A-Za-z0-9-] characters')
  }
  const appSecret = requireNonEmptyString(value.appSecret, configPath, `${field}.appSecret`)
  if (appSecret.length > CHANNEL_APP_SECRET_MAX_LENGTH) {
    throw fieldError(
      configPath,
      `${field}.appSecret`,
      `must be at most ${CHANNEL_APP_SECRET_MAX_LENGTH} characters`,
    )
  }
  const enabled = optionalBoolean(value.enabled, configPath, `${field}.enabled`, true)
  return Object.freeze({ appId, appSecret, enabled })
}

/** 校验 `channels` 对象；只允许 `qq` 键，其余键按未知渠道类型拒绝（微信暂未支持）。 */
function parseChannels(value: unknown, configPath: string): { readonly qq: readonly QQChannelInstance[] } {
  if (value === undefined) {
    return Object.freeze({ qq: Object.freeze([]) })
  }
  if (!isPlainObject(value)) {
    throw fieldError(configPath, 'channels', 'must be an object')
  }
  for (const key of Object.keys(value)) {
    if (key !== 'qq') {
      throw new GatewayConfigError(
        `${configPath}: unknown channel type "${key}"; only "qq" is supported (weixin is not supported yet)`,
      )
    }
  }
  const qqRaw = value.qq
  if (qqRaw === undefined) {
    return Object.freeze({ qq: Object.freeze([]) })
  }
  if (!Array.isArray(qqRaw)) {
    throw fieldError(configPath, 'channels.qq', 'must be an array')
  }
  const qq = Object.freeze(qqRaw.map((item, index) => parseQQInstance(item, configPath, index)))
  const seen = new Set<string>()
  for (const instance of qq) {
    if (seen.has(instance.appId)) {
      throw new GatewayConfigError(`${configPath}: duplicate channels.qq appId "${instance.appId}"`)
    }
    seen.add(instance.appId)
  }
  return Object.freeze({ qq })
}

/** 配置文件的全部合法字段；任何其他字段都视为拼写错误或旧版本残留。 */
const CONFIG_FIELDS = new Set<keyof GatewayConfigFile | 'channels'>([
  'schemaVersion',
  'channels',
  'debug',
  'maxConcurrent',
  'maxPendingPerPeer',
  'maxPendingTotal',
  'maxPendingBytes',
  'idleAgentTtlMs',
  'maxLiveAgents',
])

/**
 * 严格校验已解析的 v2 JSON 对象。缺省的非必填字段取默认值；unknown/null/类型错误拒绝。
 * `configPath` 只用于错误定位，不参与配置值。
 */
export function parseGatewayConfigDocument(value: unknown, configPath: string): GatewayConfigFile {
  if (!isPlainObject(value)) {
    throw new GatewayConfigError(`${configPath}: root must be an object`)
  }
  for (const key of Object.keys(value)) {
    if (!CONFIG_FIELDS.has(key as keyof GatewayConfigFile)) {
      throw new GatewayConfigError(`${configPath}: unknown field "${key}"`)
    }
  }

  const schemaVersion = requireSchemaVersion(value.schemaVersion, configPath)
  const channels = parseChannels(value.channels, configPath)
  const debug = optionalBoolean(
    value.debug,
    configPath,
    'debug',
    DEFAULT_GATEWAY_CONFIG_FILE.debug,
  )
  const maxConcurrent = optionalPositiveInteger(
    value.maxConcurrent,
    configPath,
    'maxConcurrent',
    DEFAULT_GATEWAY_CONFIG_FILE.maxConcurrent,
  )
  const maxPendingPerPeer = optionalPositiveInteger(
    value.maxPendingPerPeer,
    configPath,
    'maxPendingPerPeer',
    DEFAULT_GATEWAY_CONFIG_FILE.maxPendingPerPeer,
  )
  const maxPendingTotal = optionalPositiveInteger(
    value.maxPendingTotal,
    configPath,
    'maxPendingTotal',
    DEFAULT_GATEWAY_CONFIG_FILE.maxPendingTotal,
  )
  const maxPendingBytes = optionalPositiveInteger(
    value.maxPendingBytes,
    configPath,
    'maxPendingBytes',
    DEFAULT_GATEWAY_CONFIG_FILE.maxPendingBytes,
  )
  const idleAgentTtlMs = optionalPositiveInteger(
    value.idleAgentTtlMs,
    configPath,
    'idleAgentTtlMs',
    DEFAULT_GATEWAY_CONFIG_FILE.idleAgentTtlMs,
  )
  const maxLiveAgents = optionalPositiveInteger(
    value.maxLiveAgents,
    configPath,
    'maxLiveAgents',
    DEFAULT_GATEWAY_CONFIG_FILE.maxLiveAgents,
  )

  if (maxLiveAgents < maxConcurrent) {
    throw fieldError(configPath, 'maxLiveAgents', 'must be >= maxConcurrent')
  }

  return Object.freeze({
    schemaVersion,
    channels,
    debug,
    maxConcurrent,
    maxPendingPerPeer,
    maxPendingTotal,
    maxPendingBytes,
    idleAgentTtlMs,
    maxLiveAgents,
  })
}

/** v1 顶层文档的全部合法字段。 */
const LEGACY_CONFIG_FIELDS = new Set([
  'schemaVersion',
  'qqAppId',
  'qqAppSecret',
  'debug',
  'maxConcurrent',
  'maxPendingPerPeer',
  'maxPendingTotal',
  'maxPendingBytes',
  'idleAgentTtlMs',
  'maxLiveAgents',
])

/**
 * 校验 schemaVersion 1 的旧文档并转换为 v2：顶层 `qqAppId`/`qqAppSecret` 变为
 * `channels.qq[0]`（`enabled: true`），其余字段沿用。`qqAppId` 与 `qqAppSecret` 双双为
 * trim 后的空串（旧版首启模板形态）时无凭证可迁，产物为 `channels.qq: []`（零实例），
 * 升级后以零实例正常启动。恰好一个为空、一个非空属真实配置错误，照常拒绝。转换是纯函数，
 * 写回由 config/store.ts 负责；v1 文档本身非法（单空凭证、未知字段等）时抛
 * GatewayConfigError 且不产生转换结果。
 */
export function migrateLegacyGatewayConfigDocument(value: unknown, configPath: string): GatewayConfigFile {
  if (!isPlainObject(value)) {
    throw new GatewayConfigError(`${configPath}: root must be an object`)
  }
  for (const key of Object.keys(value)) {
    if (!LEGACY_CONFIG_FIELDS.has(key)) {
      throw new GatewayConfigError(`${configPath}: unknown field "${key}"`)
    }
  }
  if (value.schemaVersion !== 1) {
    throw fieldError(
      configPath,
      'schemaVersion',
      `must be 1 for legacy migration; unsupported version ${String(value.schemaVersion)}`,
    )
  }
  // 双空判定只认 trim 后为空的字符串；缺失或非字符串值不走放行路径，由下方常规校验拒绝。
  const qqAppIdBlank = typeof value.qqAppId === 'string' && value.qqAppId.trim() === ''
  const qqAppSecretBlank = typeof value.qqAppSecret === 'string' && value.qqAppSecret.trim() === ''
  let channels: { readonly qq: readonly QQChannelInstance[] }
  if (qqAppIdBlank && qqAppSecretBlank) {
    // 旧版首启模板（双空凭证）：迁移为零实例，其余字段照常携带。
    channels = Object.freeze({ qq: Object.freeze([]) })
  } else {
    const qqAppId = requireNonEmptyString(value.qqAppId, configPath, 'qqAppId')
    // 与 v2 实例同规则（appId 即迁移产物的 channels.qq[0].appId）：在写回迁移文档之前拒绝，
    // 避免非法 v1 被改写为同样非法的 v2 后才报错。
    if (!isValidBindingScope(qqAppId)) {
      throw fieldError(configPath, 'qqAppId', 'must only contain [A-Za-z0-9-] characters')
    }
    const qqAppSecret = requireNonEmptyString(value.qqAppSecret, configPath, 'qqAppSecret')
    channels = Object.freeze({
      qq: Object.freeze([Object.freeze({ appId: qqAppId, appSecret: qqAppSecret, enabled: true })]),
    })
  }
  const debug = optionalBoolean(value.debug, configPath, 'debug', DEFAULT_GATEWAY_CONFIG_FILE.debug)
  const maxConcurrent = optionalPositiveInteger(
    value.maxConcurrent,
    configPath,
    'maxConcurrent',
    DEFAULT_GATEWAY_CONFIG_FILE.maxConcurrent,
  )
  const maxPendingPerPeer = optionalPositiveInteger(
    value.maxPendingPerPeer,
    configPath,
    'maxPendingPerPeer',
    DEFAULT_GATEWAY_CONFIG_FILE.maxPendingPerPeer,
  )
  const maxPendingTotal = optionalPositiveInteger(
    value.maxPendingTotal,
    configPath,
    'maxPendingTotal',
    DEFAULT_GATEWAY_CONFIG_FILE.maxPendingTotal,
  )
  const maxPendingBytes = optionalPositiveInteger(
    value.maxPendingBytes,
    configPath,
    'maxPendingBytes',
    DEFAULT_GATEWAY_CONFIG_FILE.maxPendingBytes,
  )
  const idleAgentTtlMs = optionalPositiveInteger(
    value.idleAgentTtlMs,
    configPath,
    'idleAgentTtlMs',
    DEFAULT_GATEWAY_CONFIG_FILE.idleAgentTtlMs,
  )
  const maxLiveAgents = optionalPositiveInteger(
    value.maxLiveAgents,
    configPath,
    'maxLiveAgents',
    DEFAULT_GATEWAY_CONFIG_FILE.maxLiveAgents,
  )
  if (maxLiveAgents < maxConcurrent) {
    throw fieldError(configPath, 'maxLiveAgents', 'must be >= maxConcurrent')
  }
  return Object.freeze({
    schemaVersion: GATEWAY_CONFIG_SCHEMA_VERSION,
    channels,
    debug,
    maxConcurrent,
    maxPendingPerPeer,
    maxPendingTotal,
    maxPendingBytes,
    idleAgentTtlMs,
    maxLiveAgents,
  })
}

/** 把配置文件字段与 workspace 派生路径组合成运行时配置。 */
export function buildGatewayConfig(workspaceDir: string, file: GatewayConfigFile): GatewayConfig {
  return {
    stateDir: join(workspaceDir, 'state'),
    workspaceRoot: join(workspaceDir, 'users'),
    qqInstances: file.channels.qq,
    debug: file.debug,
    maxConcurrent: file.maxConcurrent,
    maxPendingPerPeer: file.maxPendingPerPeer,
    maxPendingTotal: file.maxPendingTotal,
    maxPendingBytes: file.maxPendingBytes,
    idleAgentTtlMs: file.idleAgentTtlMs,
    maxLiveAgents: file.maxLiveAgents,
  }
}

/**
 * descendant 是否等于 ancestor 或位于其目录内；用 path 归一化比较，win32 大小写不敏感。
 * "在外部"的判定是 rel === '..'、rel 以 '..' + sep 开头或为绝对路径（跨盘符）；
 * 不能用 startsWith('..') 判断——首段以 '..' 命名的子目录（如 '..ws'）会被误判为外部。
 */
function containsPath(ancestor: string, descendant: string): boolean {
  const rel = relative(resolve(ancestor), resolve(descendant))
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

/** 两个路径是否互为前缀目录（含相同路径）；跨盘符视为不重叠。 */
export function isPathOverlapping(a: string, b: string): boolean {
  return containsPath(a, b) || containsPath(b, a)
}
