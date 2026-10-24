import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * 网关配置：唯一环境变量 `DSH_GATEWAY_WORKSPACE` 加 `<workspace>/gateway.config.json`。
 *
 * 环境变量只决定 workspace 根；配置文件承载 QQ 凭证、debug 和调度/回收参数。字段缺失时使用
 * 本模块的默认值，未知字段、类型错误、缺 QQ 凭证、非法路径等一律抛 GatewayConfigError 拒绝
 * 启动。错误消息只包含字段名/路径与原因，不包含 qqAppSecret 的值。
 *
 * 本模块保持无文件 IO：配置文件的读取、模板创建与路径重叠校验在 config-file.ts。
 */

/** 配置文件当前唯一支持的 schema 版本。 */
export const GATEWAY_CONFIG_SCHEMA_VERSION = 1

/** `<DSH_GATEWAY_WORKSPACE>` 未设置时的默认目录名，位于操作系统 home 下。 */
export const DEFAULT_GATEWAY_WORKSPACE_DIRNAME = '.dsh-gateway'

/** 类型化运行时配置；启动时解析一次，变更走重启，不热重载。全部字段只读。 */
export interface GatewayConfig {
  /** `<workspace>/state`。 */
  readonly stateDir: string
  /** `<workspace>/users`。 */
  readonly workspaceRoot: string
  readonly qqAppId: string
  readonly qqAppSecret: string
  readonly debug: boolean
  readonly maxConcurrent: number
  readonly maxPendingPerPeer: number
  readonly maxPendingTotal: number
  readonly maxPendingBytes: number
  readonly idleAgentTtlMs: number
  readonly maxLiveAgents: number
}

/** 配置文件中的完整字段形状；schemaVersion、QQ 凭证必填，其余字段可缺省取默认值。 */
export interface GatewayConfigFile {
  readonly schemaVersion: 1
  readonly qqAppId: string
  readonly qqAppSecret: string
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

/** 配置模板与缺省值；qq 字段在模板里为空，校验时仍要求非空。 */
const DEFAULT_GATEWAY_CONFIG_FILE: GatewayConfigFile = Object.freeze({
  schemaVersion: GATEWAY_CONFIG_SCHEMA_VERSION,
  qqAppId: '',
  qqAppSecret: '',
  debug: false,
  maxConcurrent: 4,
  maxPendingPerPeer: 3,
  maxPendingTotal: 100,
  maxPendingBytes: 8_388_608,
  idleAgentTtlMs: 900_000,
  maxLiveAgents: 32,
})

/** 生成首次启动写入的配置文件内容（UTF-8 JSON，2 空格缩进，结尾换行）。 */
export function createGatewayConfigTemplate(): string {
  return `${JSON.stringify(DEFAULT_GATEWAY_CONFIG_FILE, null, 2)}\n`
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

function requireSchemaVersion(value: unknown, configPath: string): 1 {
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

/** 配置文件的全部合法字段；任何其他字段都视为拼写错误或旧版本残留。 */
const CONFIG_FIELDS = new Set<keyof GatewayConfigFile>([
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
 * 严格校验已解析的 JSON 对象。缺省的非必填字段取默认值；unknown/null/类型错误拒绝。
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
  const qqAppId = requireNonEmptyString(value.qqAppId, configPath, 'qqAppId')
  const qqAppSecret = requireNonEmptyString(value.qqAppSecret, configPath, 'qqAppSecret')
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
    qqAppId,
    qqAppSecret,
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
    qqAppId: file.qqAppId,
    qqAppSecret: file.qqAppSecret,
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
