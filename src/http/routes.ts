import type { GatewayLogger } from '../logging.js'
import { ManagementError } from '../management/contracts.js'
import type {
  ChannelChangeResult,
  ChannelHealthState,
  GatewayManagement,
  GatewayStatus,
  ManagementErrorCode,
} from '../management/contracts.js'
import {
  CHANNEL_ADD_PATH,
  CHANNEL_BIND_PATH,
  CHANNEL_ENABLE_PATH,
  LIVEZ_PATH,
  READYZ_PATH,
  errorBody,
} from './protocol.js'
import type {
  BindStartSuccessBody,
  ChannelSuccessBody,
  HttpReply,
  LivezBody,
  ReadyzBody,
} from './protocol.js'
import type { HttpRequestHandler } from './server.js'
import type { WeixinManager } from '../channels/weixin/manager.js'

/**
 * HTTP 路由层：把已解析的请求映射到管理业务能力，并把业务错误码映射为 HTTP 状态码。
 *
 * - `GET /livez` → 200 `{"status":"ok"}`（监听存在即存活）。
 * - `GET /readyz` → 管理状态投影为就绪正文；`ready` 为真 200，否则 503。
 * - `POST /channels/qq`、`POST /channels/qq/enable` → 管理服务；成功 200。
 * - `POST /channels/qq/bind` → 管理服务启动扫码绑定，成功 200 `{"ok":true,"url":...}`。
 * - `GET /channels/qq/bind` → 挂起等待绑定终态：成功 200（与 add 同形状）；过期/未启动
 *   409、上游失败 502、停机 503，由 `ManagementError.code` 映射。
 * - `ManagementError` → `{"error":{"code","message"}}` + 按 code 的状态码；其余异常不吞，
 *   由 server 记 500。
 * - 其他路径/方法返回 `undefined`，交给 server 统一 404。
 */

export interface HttpRoutesOptions {
  management: GatewayManagement
  logger: GatewayLogger
  weixin?: WeixinManager
}

/** 管理业务错误码 → HTTP 状态码（见 `management/contracts.ts` 注释）。 */
const STATUS_BY_ERROR_CODE: Readonly<Record<ManagementErrorCode, number>> = {
  invalid_request: 400,
  app_id_required: 400,
  instance_not_found: 404,
  config_modified_externally: 409,
  credential_validation_failed: 422,
  gateway_not_ready: 503,
  gateway_stopping: 503,
  config_write_failed: 500,
  bind_failed: 502,
  bind_expired: 409,
  bind_not_started: 409,
}

/** 就绪正文投影：`channels` 键为 `<channelId>:<appId>`，类型级状态使用 `<channelId>`。 */
function projectReadyz(status: GatewayStatus): ReadyzBody {
  const channels: Record<string, ChannelHealthState> = {}
  for (const channel of status.channels) {
    const key = channel.appId === undefined ? channel.channelId : `${channel.channelId}:${channel.appId}`
    channels[key] = channel.state
  }
  return {
    coreState: status.coreState,
    channels,
    pending: status.pending,
    running: status.running,
    startedAt: status.startedAt,
  }
}

/** 成功变更应答：`{"ok":true,"channel","state","detail"?}`。 */
function successReply(result: ChannelChangeResult): HttpReply {
  const body: ChannelSuccessBody =
    result.detail === undefined
      ? { ok: true, channel: result.channel, state: result.state }
      : { ok: true, channel: result.channel, state: result.state, detail: result.detail }
  return { status: 200, body }
}

/** 扫码绑定启动应答：`{"ok":true,"url"}`。 */
function bindStartReply(url: string): HttpReply {
  const body: BindStartSuccessBody = { ok: true, url }
  return { status: 200, body }
}

export function createHttpRoutes(options: HttpRoutesOptions): HttpRequestHandler {
  const { management } = options

  /** 把 `ManagementError` 映射为错误应答；其他异常上抛给 server（500）。 */
  function errorReply(err: unknown): HttpReply {
    if (err instanceof ManagementError) {
      return {
        status: STATUS_BY_ERROR_CODE[err.code],
        body: errorBody(err.code, err.message),
      }
    }
    throw err
  }

  /** 执行管理操作并把可预期失败映射为错误应答；其他异常上抛给 server（500）。 */
  async function dispatch(operation: () => Promise<ChannelChangeResult>): Promise<HttpReply> {
    try {
      return successReply(await operation())
    } catch (err) {
      return errorReply(err)
    }
  }

  /** 启动扫码绑定：成功体是 `{"ok":true,"url"}`，失败同样按管理错误码映射。 */
  async function dispatchBindStart(): Promise<HttpReply> {
    try {
      const result = await management.bindQQStart()
      return bindStartReply(result.url)
    } catch (err) {
      return errorReply(err)
    }
  }

  return async (request) => {
    if (request.method === 'GET' && request.path === LIVEZ_PATH) {
      const body: LivezBody = { status: 'ok' }
      return { status: 200, body }
    }
    if (request.method === 'GET' && request.path === READYZ_PATH) {
      const status = management.getStatus()
      return { status: status.ready ? 200 : 503, body: projectReadyz(status) }
    }
    if (request.method === 'POST' && request.path === CHANNEL_ADD_PATH) {
      return dispatch(() => management.addQQ(request.body))
    }
    if (request.method === 'POST' && request.path === CHANNEL_ENABLE_PATH) {
      return dispatch(() => management.enableQQ(request.body))
    }
    if (request.method === 'POST' && request.path === CHANNEL_BIND_PATH) {
      return dispatchBindStart()
    }
    if (request.method === 'GET' && request.path === CHANNEL_BIND_PATH) {
      // 挂起直到会话终态；过期/失败/停机在 dispatch 内映射为对应状态码。
      return dispatch(() => management.bindQQWait())
    }
    if (options.weixin && request.method === 'POST' && request.path === '/channels/weixin/bind') {
      try { return bindStartReply((await options.weixin.bindStart()).url) } catch (err) { return errorReply(err) }
    }
    if (options.weixin && request.method === 'GET' && request.path === '/channels/weixin/bind') {
      return dispatch(() => options.weixin!.bindWait())
    }
    if (options.weixin && request.method === 'POST' && request.path === '/channels/weixin/enable') {
      return dispatch(() => options.weixin!.enable(request.body))
    }
    return undefined
  }
}
