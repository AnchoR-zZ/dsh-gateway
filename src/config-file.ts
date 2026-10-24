import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import {
  buildGatewayConfig,
  createGatewayConfigTemplate,
  GatewayConfigError,
  isPathOverlapping,
  parseGatewayConfigDocument,
} from './config.js'
import type { GatewayConfig } from './config.js'

/**
 * config-file：读取 `<workspace>/gateway.config.json`，首次缺失时写入模板，并校验
 * workspace 与 dsh home 不重叠。
 *
 * 配置文件是网关唯一自有的持久配置来源；读取/写入都在启动阶段同步完成，任何错误直接拒绝
 * 启动。模板只在文件不存在时以 `wx` 独占创建，已有文件绝不覆盖或自动修复。
 */

/** 网关配置文件名；固定位于 workspace 根。 */
export const GATEWAY_CONFIG_FILENAME = 'gateway.config.json'

export interface LoadGatewayConfigOptions {
  /** `DSH_GATEWAY_WORKSPACE` 解析后的绝对路径。 */
  workspaceDir: string
  /** 通过 dsh 根上下文 `dshHomePath()` 解析出的绝对路径。 */
  dshHome: string
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
 * 读取配置文件；文件不存在时先写模板再读取。
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

/**
 * 加载网关配置。
 *
 * 顺序：绝对路径校验 → workspace/dsh home 重叠校验 → 建 workspace → 读/建配置文件 →
 * 严格 schema 校验 → 派生 state/users 路径。校验失败时不会覆盖已有文件；首次自动创建模板
 * 后会因 QQ 凭证为空而失败，并在错误中提示编辑该文件。
 */
export function loadGatewayConfig(options: LoadGatewayConfigOptions): GatewayConfig {
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
  const { text, created } = readOrCreateConfig(configPath)

  let parsed: unknown
  try {
    // Windows 编辑器可能在文件开头写入 UTF-8 BOM；JSON 标准不允许 BOM。
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (err) {
    throw new GatewayConfigError(`${configPath}: invalid JSON: ${errorMessage(err)}`, {
      cause: err,
    })
  }

  try {
    const file = parseGatewayConfigDocument(parsed, configPath)
    return buildGatewayConfig(workspaceDir, file)
  } catch (err) {
    if (created && err instanceof GatewayConfigError) {
      throw new GatewayConfigError(
        `${err.message}; created a template at ${configPath}; set qqAppId and qqAppSecret, then restart`,
        { cause: err },
      )
    }
    throw err
  }
}
