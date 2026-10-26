import type { CoreState } from '../core/contracts.js'
import type { ChannelHealthState } from '../management/contracts.js'

/**
 * 本机 HTTP 协议层契约：默认监听地址、路由路径、请求 body 上限与网络 DTO。
 *
 * 本文件只含常量与类型；不引入 Node HTTP、管理服务或 QQ SDK。
 * 业务错误码在 `src/management/contracts.ts`，状态码映射在 `src/http/routes.ts`。
 */

/** 默认只绑定回环地址：探针与管理路由都只服务本机。 */
export const DEFAULT_GATEWAY_HTTP_HOST = '127.0.0.1'

/** 默认监听端口。 */
export const DEFAULT_GATEWAY_HTTP_PORT = 17_890

/** 只读存活探针路径；监听存在即返回 200。 */
export const LIVEZ_PATH = '/livez'

/** 只读就绪探针路径；判定与正文见 `src/http/routes.ts`。 */
export const READYZ_PATH = '/readyz'

/** 添加/更新 QQ 渠道实例的管理路径。 */
export const CHANNEL_ADD_PATH = '/channels/qq'

/** 启用 QQ 渠道实例的管理路径。 */
export const CHANNEL_ENABLE_PATH = '/channels/qq/enable'

/**
 * 扫码绑定 QQ 机器人实例的管理路径。
 *
 * - `POST`：启动（或幂等复用）绑定会话，等二维码 URL 就绪后返回它；
 * - `GET`：挂起等待会话终态，成功返回与 add 相同的变更结果。
 */
export const CHANNEL_BIND_PATH = '/channels/qq/bind'

/** 管理请求 body 的字节上限；超出按 400 拒绝。 */
export const ADMIN_BODY_LIMIT_BYTES = 65_536

/** 统一的 HTTP 应答形状。 */
export interface HttpReply {
  readonly status: number
  readonly body: unknown
}

/** 错误应答正文：`{"error":{"code","message"}}`。 */
export interface HttpErrorBody {
  readonly error: {
    readonly code: string
    readonly message: string
  }
}

/** `GET /livez` 正文。 */
export interface LivezBody {
  readonly status: 'ok'
}

/** `GET /readyz` 正文；由管理查询结果投影，不含用户标识、sessionId 或错误原文。 */
export interface ReadyzBody {
  readonly coreState: CoreState
  /** 实例粒度状态表，键为 `<channelId>:<appId>`；类型级状态使用 `<channelId>`。 */
  readonly channels: Readonly<Record<string, ChannelHealthState>>
  readonly pending: number
  readonly running: number
  readonly startedAt: string
}

/** 成功变更应答正文：`{"ok":true,"channel":"qq:<appId>","state":...}`。 */
export interface ChannelSuccessBody {
  readonly ok: true
  readonly channel: string
  readonly state: ChannelHealthState
  readonly detail?: string
}

/** 扫码绑定启动应答正文：`{"ok":true,"url":"https://q.qq.com/..."}`。 */
export interface BindStartSuccessBody {
  readonly ok: true
  readonly url: string
}

/** 未命中任何路由时的 404 正文（沿用探测器的简短形态）。 */
export interface NotFoundBody {
  readonly error: 'not found'
}

export function errorBody(code: string, message: string): HttpErrorBody {
  return { error: { code, message } }
}

export function notFoundBody(): NotFoundBody {
  return { error: 'not found' }
}
