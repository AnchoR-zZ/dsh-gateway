import {
  CHANNEL_APP_ID_MAX_LENGTH,
  CHANNEL_APP_SECRET_MAX_LENGTH,
  GatewayConfigError,
} from './config.js'
import type { GatewayConfigFile } from './config.js'
import type { GatewayConfigStore } from './config-file.js'
import { GatewayConfigConflictError } from './config-file.js'
import type { ChannelManager } from './channels.js'
import { isValidBindingScope } from './contracts.js'
import type { AdminHandler, AdminReply, CoreState } from './core/lifecycle.js'
import { redact } from './logging.js'
import type { GatewayLogger } from './logging.js'
import { QQCredentialCheckError } from './qq/token.js'
import type { QQCredentialValidator } from './qq/token.js'

/**
 * 本机 channel 管理路由（挂在健康 server 上，见 core/lifecycle 的 AdminHandler）：
 *
 * - `POST /channels/qq`：添加或更新一个 QQ 实例。形状校验 → core ready 检查 → 凭证在线
 *   校验（`force` 跳过；失败不写任何配置）→ 漂移检测 + 原子写 → 重启/启动实例。
 * - `POST /channels/qq/enable`：置配置 `enabled: true` 并对未在线实例立即启动。
 *
 * 错误统一 `{"error":{"code","message"}}`，HTTP 状态 400/404/409/422/503/500；成功统一
 * `{"ok":true,"channel":"qq:<appId>","state":...}`。任何响应、日志与错误信息都不回显
 * `appSecret`。
 */

export interface AdminRoutesOptions {
  logger: GatewayLogger
  store: GatewayConfigStore
  manager: ChannelManager
  validateQQCredentials: QQCredentialValidator
  /** core 当前状态；非 `ready` 时管理请求返回 503，message 按 starting/failed/关机区分。 */
  coreState: () => CoreState
}

interface AddQQBody {
  readonly appId: string
  readonly appSecret: string
  readonly force: boolean
}

interface EnableQQBody {
  readonly appId?: string
}

function errorReply(status: number, code: string, message: string): AdminReply {
  return { status, body: { error: { code, message } } }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseAppId(value: unknown, field: string): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return `${field} must be a non-empty string`
  }
  const trimmed = value.trim()
  if (trimmed.length > CHANNEL_APP_ID_MAX_LENGTH) {
    return `${field} must be at most ${CHANNEL_APP_ID_MAX_LENGTH} characters`
  }
  // 与配置文件同规则：appId 是 bindingId 的前缀段，字符集受限（isValidBindingScope），
  // 前置拒绝"保存成功却永远无法注册"的实例。
  if (!isValidBindingScope(trimmed)) {
    return `${field} must only contain [A-Za-z0-9-] characters`
  }
  return undefined
}

function parseAppSecret(value: unknown, field: string): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return `${field} must be a non-empty string`
  }
  const trimmed = value.trim()
  if (trimmed.length > CHANNEL_APP_SECRET_MAX_LENGTH) {
    return `${field} must be at most ${CHANNEL_APP_SECRET_MAX_LENGTH} characters`
  }
  return undefined
}

function parseAddQQBody(body: unknown): AddQQBody | string {
  if (!isPlainObject(body)) {
    return 'request body must be a JSON object'
  }
  for (const key of Object.keys(body)) {
    if (key !== 'appId' && key !== 'appSecret' && key !== 'force') {
      return `unknown field "${key}"`
    }
  }
  const appIdError = parseAppId(body.appId, 'appId')
  if (appIdError !== undefined) {
    return appIdError
  }
  const appSecretError = parseAppSecret(body.appSecret, 'appSecret')
  if (appSecretError !== undefined) {
    return appSecretError
  }
  if (body.force !== undefined && typeof body.force !== 'boolean') {
    return 'force must be a boolean'
  }
  return {
    appId: (body.appId as string).trim(),
    appSecret: (body.appSecret as string).trim(),
    force: body.force === true,
  }
}

function parseEnableQQBody(body: unknown): EnableQQBody | string {
  if (!isPlainObject(body)) {
    return 'request body must be a JSON object'
  }
  for (const key of Object.keys(body)) {
    if (key !== 'appId') {
      return `unknown field "${key}"`
    }
  }
  if (body.appId !== undefined) {
    const appIdError = parseAppId(body.appId, 'appId')
    if (appIdError !== undefined) {
      return appIdError
    }
    return { appId: (body.appId as string).trim() }
  }
  return {}
}

/** 更新配置中的 qq 实例表（store 层串行落盘）；返回写回后的文件或错误应答（409/500）。 */
async function updateQQInstances(
  store: GatewayConfigStore,
  mutate: (qq: { appId: string; appSecret: string; enabled: boolean }[]) => void,
): Promise<GatewayConfigFile | AdminReply> {
  try {
    return await store.update((current) => {
      const qq = current.channels.qq.map((instance) => ({
        appId: instance.appId,
        appSecret: instance.appSecret,
        enabled: instance.enabled,
      }))
      mutate(qq)
      return { ...current, channels: { ...current.channels, qq } }
    })
  } catch (err) {
    if (err instanceof GatewayConfigConflictError) {
      return errorReply(
        409,
        'config_modified_externally',
        'the gateway config file was modified externally; restart the gateway or revert the file, then retry',
      )
    }
    if (err instanceof GatewayConfigError) {
      return errorReply(500, 'config_write_failed', redact(err.message))
    }
    throw err
  }
}

/** 503 message 按 core 状态区分：starting 可稍后重试；failed 需人工介入；其余为关机中。 */
function gatewayNotReadyMessage(state: CoreState): string {
  if (state === 'starting') {
    return 'the gateway core is still starting; retry after startup completes'
  }
  if (state === 'failed') {
    return 'the gateway core has failed; check the manual_restart_required logs and restart the gateway process'
  }
  return 'the gateway is shutting down; admin requests are not accepted during shutdown'
}

export function createAdminRoutes(options: AdminRoutesOptions): AdminHandler {
  const { logger, store, manager, validateQQCredentials, coreState } = options

  async function addQQ(rawBody: unknown): Promise<AdminReply> {
    const parsed = parseAddQQBody(rawBody)
    if (typeof parsed === 'string') {
      return errorReply(400, 'invalid_request', parsed)
    }
    const { appId, appSecret, force } = parsed
    const coreStateNow = coreState()
    if (coreStateNow !== 'ready') {
      return errorReply(503, 'gateway_not_ready', gatewayNotReadyMessage(coreStateNow))
    }
    if (!force) {
      try {
        await validateQQCredentials(appId, appSecret)
      } catch (err) {
        const check = err instanceof QQCredentialCheckError ? err : undefined
        const message =
          check === undefined
            ? `credential validation failed: ${redact(errorMessage(err))}`
            : check.kind === 'network'
              ? `${check.message}; the endpoint was unreachable; retry, or use --force to skip validation`
              : check.message
        // 校验失败：不写任何配置。
        return errorReply(422, 'credential_validation_failed', message)
      }
    }
    const saved = await updateQQInstances(store, (qq) => {
      const index = qq.findIndex((instance) => instance.appId === appId)
      if (index >= 0) {
        // 重复 add 同一 appId：更新 secret，保留原有 enabled。
        qq[index] = { appId, appSecret, enabled: qq[index]!.enabled }
      } else {
        qq.push({ appId, appSecret, enabled: true })
      }
    })
    if ('status' in saved) {
      return saved
    }
    manager.syncInstances(saved.channels.qq)
    // 启动凭证取保存后文档里该实例的值，而非请求体原文：store 落盘队列与 manager 按 appId
    // 的启动队列是两条独立串行链，并发重复 add 同 appId 时保证"运行实例 = 最后落盘的 secret"。
    const savedInstance = saved.channels.qq.find((instance) => instance.appId === appId)!
    const started = await manager.startInstance(appId, savedInstance.appSecret)
    const state =
      started.startError !== undefined ? started.state : await manager.waitForSettled(appId)
    logger.logEvent('channel_added', { channelId: 'qq', appId, outcome: state })
    const body: Record<string, unknown> = { ok: true, channel: `qq:${appId}`, state }
    if (started.startError !== undefined) {
      body.detail = `${redact(started.startError)}; the credentials were saved`
    }
    return { status: 200, body }
  }

  async function enableQQ(rawBody: unknown): Promise<AdminReply> {
    const parsed = parseEnableQQBody(rawBody)
    if (typeof parsed === 'string') {
      return errorReply(400, 'invalid_request', parsed)
    }
    const coreStateNow = coreState()
    if (coreStateNow !== 'ready') {
      return errorReply(503, 'gateway_not_ready', gatewayNotReadyMessage(coreStateNow))
    }
    const configured = manager.listInstances()
    let appId: string
    if (parsed.appId === undefined) {
      if (configured.length !== 1) {
        return errorReply(
          400,
          'app_id_required',
          `app-id is required unless exactly one qq instance is configured (found ${configured.length})`,
        )
      }
      appId = configured[0]!.appId
    } else {
      appId = parsed.appId
      if (!configured.some((instance) => instance.appId === appId)) {
        return errorReply(
          404,
          'instance_not_found',
          `no qq instance with appId "${appId}" exists in the gateway config`,
        )
      }
    }
    const saved = await updateQQInstances(store, (qq) => {
      const index = qq.findIndex((instance) => instance.appId === appId)
      if (index >= 0) {
        qq[index] = { ...qq[index]!, enabled: true }
      }
    })
    if ('status' in saved) {
      return saved
    }
    manager.syncInstances(saved.channels.qq)
    const result = await manager.ensureOnline(appId)
    logger.logEvent('channel_enabled', { channelId: 'qq', appId, outcome: result.state })
    const body: Record<string, unknown> = { ok: true, channel: `qq:${appId}`, state: result.state }
    if (result.startError !== undefined) {
      body.detail = `${redact(result.startError)}; the config was saved with enabled=true`
    }
    return { status: 200, body }
  }

  return async (path: string, body: unknown): Promise<AdminReply | undefined> => {
    if (path === '/channels/qq') {
      return addQQ(body)
    }
    if (path === '/channels/qq/enable') {
      return enableQQ(body)
    }
    return undefined
  }
}
