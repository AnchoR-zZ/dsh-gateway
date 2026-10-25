import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import {
  buildGatewayConfig,
  createGatewayConfigTemplate,
  GatewayConfigError,
  isPathOverlapping,
  migrateLegacyGatewayConfigDocument,
  parseGatewayConfigDocument,
  serializeGatewayConfigFile,
} from './config.js'
import type { GatewayConfig, GatewayConfigFile } from './config.js'

/**
 * config-file：读取 `<workspace>/gateway.config.json`，首次缺失时写入 v2 模板，检测到 v1
 * 文档时自动迁移并写回，并校验 workspace 与 dsh home 不重叠。
 *
 * 进程是配置文件唯一在线写者：store 维护"最后已知文件内容"快照，`update` 写前重读磁盘做
 * 漂移检测，磁盘内容与快照不一致（被外部修改且进程未重启）时拒绝写入，绝不静默覆盖。写回
 * 走同目录临时文件 + rename 的原子替换。手工编辑配置后重启 dsh 仍是合法的冷路径。
 */

/** 网关配置文件名；固定位于 workspace 根。 */
export const GATEWAY_CONFIG_FILENAME = 'gateway.config.json'

/** 写冲突：配置文件在启动后被外部修改，进程内快照已失效；重启或改回文件后可恢复。 */
export class GatewayConfigConflictError extends GatewayConfigError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'GatewayConfigConflictError'
  }
}

export interface LoadGatewayConfigOptions {
  /** `DSH_GATEWAY_WORKSPACE` 解析后的绝对路径。 */
  workspaceDir: string
  /** 通过 dsh 根上下文 `dshHomePath()` 解析出的绝对路径。 */
  dshHome: string
}

/** 加载结果：运行时配置与后续热更新用的 store。 */
export interface GatewayConfigStore {
  readonly workspaceDir: string
  readonly configPath: string
  /** 启动时加载的运行时配置。 */
  readonly config: GatewayConfig
  /** 最后已知（已解析校验的）配置文件对象；保存后同步更新。 */
  readonly file: GatewayConfigFile
  /** 本次加载是否新建了模板（文件此前不存在）。 */
  readonly createdTemplate: boolean
  /** 本次加载是否发生 v1→v2 迁移写回。 */
  readonly migratedFromV1: boolean
  /**
   * 热更新配置（进程内串行：并发调用按到达顺序排队，后到者基于前者的写回结果继续）：
   * 重读磁盘 → 漂移检测（不一致拒绝 GatewayConfigConflictError）→ mutate → 严格校验 →
   * 原子写回 → 更新快照。mutate 收到的是当前磁盘上的已解析对象，返回新的完整文档对象。
   * 返回写回并校验后的文档。
   */
  update(mutate: (current: GatewayConfigFile) => GatewayConfigFile): Promise<GatewayConfigFile>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

function assertAbsolute(label: string, path: string): void {
  if (!isAbsolute(path)) {
    throw new GatewayConfigError(`${label} must be an absolute path`)
  }
}

function ensureWorkspace(workspaceDir: string): void {
  try {
    mkdirSync(workspaceDir, { recursive: true })
  } catch (err) {
    throw new GatewayConfigError(
      `failed to create gateway workspace ${workspaceDir}: ${errorMessage(err)}`,
      { cause: err },
    )
  }
}

/**
 * 读取配置文件；文件不存在时先写 v2 模板再读取。
 * @returns 原始 JSON 文本与本次是否新建了模板。
 */
function readOrCreateConfig(configPath: string): { text: string; created: boolean } {
  let created = false
  try {
    const text = readFileSync(configPath, 'utf8')
    return { text, created }
  } catch (err) {
    if (!isErrorCode(err, 'ENOENT')) {
      throw new GatewayConfigError(`${configPath}: failed to read: ${errorMessage(err)}`, {
        cause: err,
      })
    }
  }

  try {
    writeFileSync(configPath, createGatewayConfigTemplate(), { encoding: 'utf8', flag: 'wx' })
    created = true
  } catch (err) {
    // 并发启动时另一方可能已经创建；EEXIST 交给下面的读取处理。
    if (!isErrorCode(err, 'EEXIST')) {
      throw new GatewayConfigError(`${configPath}: failed to create template: ${errorMessage(err)}`, {
        cause: err,
      })
    }
  }

  try {
    const text = readFileSync(configPath, 'utf8')
    return { text, created }
  } catch (err) {
    throw new GatewayConfigError(`${configPath}: failed to read: ${errorMessage(err)}`, {
      cause: err,
    })
  }
}

/** 剥离文件开头的 UTF-8 BOM 后 JSON.parse；解析失败抛带路径的 GatewayConfigError。 */
function parseConfigText(text: string, configPath: string): unknown {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (err) {
    throw new GatewayConfigError(`${configPath}: invalid JSON: ${errorMessage(err)}`, {
      cause: err,
    })
  }
}

/** 同目录临时文件 + rename 的原子替换；失败时清理临时文件并抛 GatewayConfigError。 */
function atomicWriteConfig(configPath: string, text: string): void {
  const tmpPath = `${configPath}.tmp`
  try {
    writeFileSync(tmpPath, text, 'utf8')
    renameSync(tmpPath, configPath)
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true })
    } catch {
      // 清理失败不影响错误报告。
    }
    throw new GatewayConfigError(`${configPath}: failed to write: ${errorMessage(err)}`, {
      cause: err,
    })
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 加载网关配置并返回可热更新的 store。
 *
 * 顺序：绝对路径校验 → workspace/dsh home 重叠校验 → 建 workspace → 读/建配置文件 →
 * 剥 BOM 后 JSON.parse → v1 检测（`schemaVersion === 1` 时校验旧文档、转换为 v2、原子写回，
 * 单向一次性）→ v2 严格校验 → 派生 state/users 路径。校验失败时不覆盖已有文件；首次自动
 * 创建的 v2 模板（`channels.qq` 为空数组）可直接加载，进程以零渠道实例正常启动。
 */
export function loadGatewayConfigStore(options: LoadGatewayConfigOptions): GatewayConfigStore {
  const { workspaceDir, dshHome } = options
  assertAbsolute('gateway workspace', workspaceDir)
  assertAbsolute('dsh home', dshHome)
  if (isPathOverlapping(dshHome, workspaceDir)) {
    throw new GatewayConfigError(
      `gateway workspace ${workspaceDir} must not overlap with dsh home ${dshHome}`,
    )
  }

  ensureWorkspace(workspaceDir)
  const configPath = join(workspaceDir, GATEWAY_CONFIG_FILENAME)
  const { text: rawText, created } = readOrCreateConfig(configPath)
  const parsed = parseConfigText(rawText, configPath)

  let text = rawText
  let migratedFromV1 = false
  let document: unknown = parsed
  if (isPlainObject(parsed) && parsed.schemaVersion === 1) {
    // v1 → v2：校验旧文档后转换并原子写回，之后的加载全部按 v2 进行（单向）。
    const migrated = migrateLegacyGatewayConfigDocument(parsed, configPath)
    text = serializeGatewayConfigFile(migrated)
    atomicWriteConfig(configPath, text)
    migratedFromV1 = true
    document = migrated
  }

  const file = parseGatewayConfigDocument(document, configPath)

  let lastKnownText = text
  let currentFile: GatewayConfigFile = file
  /** update 的进程内串行链：并发管理请求按到达顺序逐个落盘，杜绝内部并发触发漂移误报。 */
  let updateTail: Promise<unknown> = Promise.resolve()

  function runUpdate(mutate: (current: GatewayConfigFile) => GatewayConfigFile): GatewayConfigFile {
    let diskText: string
    try {
      diskText = readFileSync(configPath, 'utf8')
    } catch (err) {
      throw new GatewayConfigError(`${configPath}: failed to read: ${errorMessage(err)}`, {
        cause: err,
      })
    }
    if (diskText.replace(/^\uFEFF/, '') !== lastKnownText.replace(/^\uFEFF/, '')) {
      throw new GatewayConfigConflictError(
        `${configPath}: config file was modified externally after startup; restart the gateway or revert the file before changing channels`,
      )
    }
    const current = parseGatewayConfigDocument(parseConfigText(diskText, configPath), configPath)
    const next = parseGatewayConfigDocument(mutate(current), configPath)
    const nextText = serializeGatewayConfigFile(next)
    atomicWriteConfig(configPath, nextText)
    lastKnownText = nextText
    currentFile = next
    return next
  }

  return {
    workspaceDir,
    configPath,
    config: buildGatewayConfig(workspaceDir, file),
    get file(): GatewayConfigFile {
      return currentFile
    },
    createdTemplate: created,
    migratedFromV1,
    update(mutate) {
      const next = updateTail.then(
        () => runUpdate(mutate),
        () => runUpdate(mutate),
      )
      updateTail = next.catch(() => undefined)
      return next
    },
  }
}
