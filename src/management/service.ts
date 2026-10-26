import { isValidBindingScope } from '../contracts.js'
import { SHUTDOWN_START_ERROR } from '../channels/manager.js'
import type { ChannelManager } from '../channels/manager.js'
import { QQCredentialCheckError } from '../channels/qq/token.js'
import type { QQCredentialValidator } from '../channels/qq/token.js'
import type { QQBindConnector } from '../channels/qq/qr-connect.js'
import { createQQBindingService } from './binding.js'
import type { QQBindingService } from './binding.js'
import {
  CHANNEL_APP_ID_MAX_LENGTH,
  CHANNEL_APP_SECRET_MAX_LENGTH,
  GatewayConfigError,
} from '../config/schema.js'
import type { GatewayConfigFile } from '../config/schema.js'
import { GatewayConfigConflictError } from '../config/store.js'
import type { GatewayConfigStore } from '../config/store.js'
import type { CoreState } from '../core/contracts.js'
import { redact } from '../logging.js'
import type { GatewayLogger } from '../logging.js'
import { ManagementError } from './contracts.js'
import type {
  ChannelChangeResult,
  ChannelHealthState,
  GatewayManagement,
  GatewayStatus,
  QQBindStartResult,
} from './contracts.js'
import type { StatusProjection } from './status.js'

/**
 * 管理业务服务：QQ 渠道实例的添加/启用/扫码绑定流程与停机闸门。
 *
 * - `addQQ`：形状校验 → core ready 检查 → 凭证在线校验（`force` 跳过；失败不写任何配置）
 *   → ConfigStore 漂移检测 + 原子写 → 同步实例视图 → ChannelManager 启动/替换实例。
 * - `enableQQ`：从最新配置解析实例 → 写 `enabled: true` → 对未在线实例立即启动。
 * - `bindQQStart` / `bindQQWait`：扫码绑定的两段式入口（状态机在 `./binding.ts`）；扫码
 *   成功后走与 add 相同的落盘+启动路径（跳过凭证在线校验）。
 *
 * 本模块不产生 HTTP 状态码：可预期失败一律抛带稳定 `code` 的 `ManagementError`，由
 * `src/http/routes.ts` 映射为响应。停机闸门（`beginShutdown`/`settle`）使进程停止链能先
 * 关闭管理写入入口、再有界等待在途操作落定；检查点在入口与每次 await 之后（凭证校验返回、
 * 写队列真正执行时、启动实例前），已保存的配置在停机后保留但不启动实例。
 */

export interface ManagementServiceOptions {
  logger: GatewayLogger
  store: GatewayConfigStore
  manager: ChannelManager
  /** 配置与运行状态聚合（`getStatus` 与 `/readyz` 共用）。 */
  status: StatusProjection
  validateQQCredentials: QQCredentialValidator
  /** 扫码绑定连接器（正式入口为腾讯官方实现，测试注入替身）。 */
  qqBindConnector: QQBindConnector
  /** core 当前状态；非 `ready` 时管理请求按 `gateway_not_ready` 拒绝。 */
  coreState: () => CoreState
}

/** 管理服务：管理业务能力 + 停机闸门。 */
export interface ManagementService extends GatewayManagement {
  /** 停止接受新的管理写操作；在途操作在下一个检查点中止。幂等。 */
  beginShutdown(): void
  /** 有界等待全部在途管理操作落定；超时返回 false。 */
  settle(timeoutMs: number): Promise<boolean>
}

/** 停机闸门拒绝文案（HTTP 503 `gateway_stopping`）。 */
const SHUTDOWN_REJECTED_MESSAGE =
  'the gateway is shutting down; admin requests are not accepted during shutdown'

/** 配置已保存后才进入停机时的结果说明：不启动实例，但保留配置。 */
const SHUTDOWN_CONFIG_SAVED_DETAIL =
  'the gateway is shutting down; the configuration was saved but the instance was not started'

/** 配置文件被外部修改时的响应消息（与旧管理路由一致）。 */
const CONFIG_CONFLICT_MESSAGE =
  'the gateway config file was modified externally; restart the gateway or revert the file, then retry'

interface AddQQBody {
  readonly appId: string
  readonly appSecret: string
  readonly force: boolean
}

interface EnableQQBody {
  readonly appId?: string
}

/** 写入配置时允许修改的 QQ 实例字段；`enabled` 由 add/enable 各自决定。 */
type EditableQQInstance = { appId: string; appSecret: string; enabled: boolean }

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

/** 解析 `POST /channels/qq` 的不可信 body；返回错误消息或已规范化的字段。 */
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

/** 解析 `POST /channels/qq/enable` 的不可信 body。 */
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

/**
 * 更新配置中的 qq 实例表（store 层串行落盘）。
 *
 * 写冲突 → `config_modified_externally`；其余配置错误 → `config_write_failed`；mutate 内
 * 抛出的 `ManagementError`（停机闸门）原样上抛。`mutate` 在写队列真正执行时才运行，因此
 * 它是"排队期间已开始停机"的最后检查点，抛错时磁盘不会被写入。
 */
async function updateQQInstances(
  store: GatewayConfigStore,
  mutate: (qq: EditableQQInstance[]) => void,
): Promise<GatewayConfigFile> {
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
    if (err instanceof ManagementError) {
      throw err
    }
    if (err instanceof GatewayConfigConflictError) {
      throw new ManagementError('config_modified_externally', CONFIG_CONFLICT_MESSAGE, { cause: err })
    }
    if (err instanceof GatewayConfigError) {
      throw new ManagementError('config_write_failed', redact(err.message), { cause: err })
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

/**
 * 凭证校验失败的 422 消息。`QQCredentialCheckError` 的 message 由 token 模块自己构造并对
 * 上游正文片段脱敏，原样返回（保留 "HTTP 401" 等可读信息；上游正文片段由 token 模块脱敏）；
 * network 分支追加 `force: true` 提示；其他异常按脱敏后的 message 包装。
 */
function credentialFailureMessage(error: unknown): string {
  const check = error instanceof QQCredentialCheckError ? error : undefined
  if (check === undefined) {
    return `credential validation failed: ${redact(errorMessage(error))}`
  }
  if (check.kind === 'network') {
    return `${check.message}; the endpoint was unreachable; retry, or send "force": true in the request body to skip validation`
  }
  return check.message
}

/** 一个 QQ 实例的当前可公开状态（来自状态投影；未出现时按 `blocked` 处理）。 */
function currentChannelState(status: GatewayStatus, appId: string): ChannelHealthState {
  const channel = status.channels.find(
    (item) => item.channelId === 'qq' && item.appId === appId,
  )
  return channel?.state ?? 'blocked'
}

export function createManagementService(options: ManagementServiceOptions): ManagementService {
  const { logger, store, manager, status, validateQQCredentials, coreState } = options

  let shuttingDown = false
  /**
   * 在途管理操作（add/enable/扫码绑定启动与等待的内部 promise）；settle 有界等待其全部
   * 落定。扫码绑定等待在停机时由 `beginShutdown` 作废会话，因此不会拖住停止链。
   */
  const inFlight = new Set<Promise<unknown>>()

  function throwIfShuttingDown(): void {
    if (shuttingDown) {
      throw new ManagementError('gateway_stopping', SHUTDOWN_REJECTED_MESSAGE)
    }
  }

  /** 跟踪在途操作，落定（成功或失败）后移出集合；返回可正常 await 的原 promise。 */
  function track<T>(operation: Promise<T>): Promise<T> {
    let tracked: Promise<T>
    tracked = operation.then(
      (value) => {
        inFlight.delete(tracked)
        return value
      },
      (error: unknown) => {
        inFlight.delete(tracked)
        throw error
      },
    )
    inFlight.add(tracked)
    return tracked
  }

  async function addQQInternal(rawBody: unknown): Promise<ChannelChangeResult> {
    throwIfShuttingDown()
    const parsed = parseAddQQBody(rawBody)
    if (typeof parsed === 'string') {
      throw new ManagementError('invalid_request', parsed)
    }
    const { appId, appSecret, force } = parsed
    const stateNow = coreState()
    if (stateNow !== 'ready') {
      throw new ManagementError('gateway_not_ready', gatewayNotReadyMessage(stateNow))
    }
    if (!force) {
      try {
        await validateQQCredentials(appId, appSecret)
      } catch (err) {
        // 停机优先于校验结果：校验挂起期间已进入停机时按 gateway_stopping 拒绝，
        // 而不是把停机窗口内的校验失败误报为 422（同样不写配置、不创建实例）。
        throwIfShuttingDown()
        throw new ManagementError('credential_validation_failed', credentialFailureMessage(err), {
          cause: err,
        })
      }
      // 凭证校验期间可能已进入停机：不再写配置、不启动实例。
      throwIfShuttingDown()
    }
    return applyCredentialsInternal(appId, appSecret)
  }

  /**
   * 凭据落盘 + 启动/替换实例：add 与扫码绑定共用（绑定在调用前已跳过凭证在线校验）。
   *
   * 已存在同 `appId` 时更新 secret 并保留原 `enabled`；不存在时追加 `enabled: true`。启动
   * 凭证取保存后文档里该实例的值，而非调用方传入的原文：store 落盘队列与 manager 按 appId
   * 的启动队列是两条独立串行链，并发重复写入同 appId 时保证"运行实例 = 最后落盘的 secret"。
   */
  async function applyCredentialsInternal(
    appId: string,
    appSecret: string,
  ): Promise<ChannelChangeResult> {
    const saved = await updateQQInstances(store, (qq) => {
      // 写队列真正执行时的检查点：排队期间已停机则不落盘。
      throwIfShuttingDown()
      const index = qq.findIndex((instance) => instance.appId === appId)
      if (index >= 0) {
        // 重复写入同一 appId：更新 secret，保留原有 enabled（与 add 语义一致）。
        qq[index] = { appId, appSecret, enabled: qq[index]!.enabled }
      } else {
        qq.push({ appId, appSecret, enabled: true })
      }
    })
    return startSavedInstance(appId, saved)
  }

  /**
   * 启动/替换保存后的实例：启动失败不撤销配置，状态按当前观察值返回并附 `detail`；
   * 保存后进入停机则保留配置、不启动实例。
   */
  async function startSavedInstance(
    appId: string,
    saved: GatewayConfigFile,
  ): Promise<ChannelChangeResult> {
    manager.syncInstances(saved.channels.qq)
    const savedInstance = saved.channels.qq.find((instance) => instance.appId === appId)!
    // 保存后进入停机：保留配置，不启动实例，按当前状态（缺失时 blocked）返回。
    if (shuttingDown) {
      const state = currentChannelState(status.getStatus(), appId)
      logger.logEvent('channel_added', { channelId: 'qq', appId, outcome: state })
      return {
        channel: `qq:${appId}`,
        saved: true,
        state,
        detail: SHUTDOWN_CONFIG_SAVED_DETAIL,
      }
    }
    const started = await manager.startInstance(appId, savedInstance.appSecret)
    const state =
      started.startError !== undefined ? started.state : await manager.waitForSettled(appId)
    logger.logEvent('channel_added', { channelId: 'qq', appId, outcome: state })
    if (started.startError !== undefined) {
      // 保存后、启动执行前进入停机：统一返回"已保存但未启动"的停机说明，而不是把
      // manager 的停机闸门文案当作启动失败。
      const detail =
        started.startError === SHUTDOWN_START_ERROR
          ? SHUTDOWN_CONFIG_SAVED_DETAIL
          : `${redact(started.startError)}; the credentials were saved`
      return { channel: `qq:${appId}`, saved: true, state, detail }
    }
    return { channel: `qq:${appId}`, saved: true, state }
  }

  async function enableQQInternal(rawBody: unknown): Promise<ChannelChangeResult> {
    throwIfShuttingDown()
    const parsed = parseEnableQQBody(rawBody)
    if (typeof parsed === 'string') {
      throw new ManagementError('invalid_request', parsed)
    }
    const stateNow = coreState()
    if (stateNow !== 'ready') {
      throw new ManagementError('gateway_not_ready', gatewayNotReadyMessage(stateNow))
    }
    // 实例选择读取 ConfigStore 最新配置（配置是唯一事实来源，manager 视图可能滞后一拍）。
    const configured = store.file.channels.qq
    let appId: string
    if (parsed.appId === undefined) {
      if (configured.length !== 1) {
        throw new ManagementError(
          'app_id_required',
          `app-id is required unless exactly one qq instance is configured (found ${configured.length})`,
        )
      }
      appId = configured[0]!.appId
    } else {
      appId = parsed.appId
      if (!configured.some((instance) => instance.appId === appId)) {
        throw new ManagementError(
          'instance_not_found',
          `no qq instance with appId "${appId}" exists in the gateway config`,
        )
      }
    }
    const saved = await updateQQInstances(store, (qq) => {
      throwIfShuttingDown()
      const index = qq.findIndex((instance) => instance.appId === appId)
      if (index >= 0) {
        qq[index] = { ...qq[index]!, enabled: true }
      }
    })
    manager.syncInstances(saved.channels.qq)
    if (shuttingDown) {
      const state = currentChannelState(status.getStatus(), appId)
      logger.logEvent('channel_enabled', { channelId: 'qq', appId, outcome: state })
      return {
        channel: `qq:${appId}`,
        saved: true,
        state,
        detail: SHUTDOWN_CONFIG_SAVED_DETAIL,
      }
    }
    const result = await manager.ensureOnline(appId)
    logger.logEvent('channel_enabled', { channelId: 'qq', appId, outcome: result.state })
    if (result.startError !== undefined) {
      // 同 add：保存后、启动执行前进入停机时返回统一的"已保存但未启动"说明。
      const detail =
        result.startError === SHUTDOWN_START_ERROR
          ? SHUTDOWN_CONFIG_SAVED_DETAIL
          : `${redact(result.startError)}; the config was saved with enabled=true`
      return { channel: `qq:${appId}`, saved: true, state: result.state, detail }
    }
    return { channel: `qq:${appId}`, saved: true, state: result.state }
  }

  /**
   * 扫码绑定会话状态机：单会话、终态保留、过期即终止（见 `./binding.ts`）。
   * 扫码成功后复用 `applyCredentialsInternal`（与管理路由 add 相同的落盘+启动路径），但跳过
   * 凭证在线校验——扫码本身已由腾讯侧完成认证，没有必要再打一次 token 接口。
   */
  const binding: QQBindingService = createQQBindingService({
    connector: options.qqBindConnector,
    applyCredentials: applyCredentialsInternal,
  })

  /** 扫码绑定启动：闸门与 core 检查与 add 一致，之后委托会话状态机等二维码就绪。 */
  async function bindStartInternal(): Promise<QQBindStartResult> {
    throwIfShuttingDown()
    const stateNow = coreState()
    if (stateNow !== 'ready') {
      throw new ManagementError('gateway_not_ready', gatewayNotReadyMessage(stateNow))
    }
    return binding.start()
  }

  /** 扫码绑定等待终态：成功返回与 add 相同的变更结果；其余终态抛稳定错误码。 */
  function bindWaitInternal(): Promise<ChannelChangeResult> {
    return binding.wait()
  }

  async function settle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs)
    while (inFlight.size > 0) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        return false
      }
      const pending = [...inFlight]
      const settled = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), remaining)
        timer.unref?.()
        void Promise.allSettled(pending).then(() => {
          clearTimeout(timer)
          resolve(true)
        })
      })
      if (!settled) {
        // 超时瞬间可能恰好全部落定：以集合是否为空为准。
        return inFlight.size === 0
      }
    }
    return true
  }

  return {
    getStatus: () => status.getStatus(),
    addQQ: (input) => track(addQQInternal(input)),
    enableQQ: (input) => track(enableQQInternal(input)),
    bindQQStart: () => track(bindStartInternal()),
    bindQQWait: () => track(bindWaitInternal()),
    beginShutdown() {
      shuttingDown = true
      // 作废进行中的扫码绑定会话：挂起的等待请求以 gateway_stopping 收尾，不再悬挂。
      binding.abort()
    },
    settle,
  }
}
