import { startQrConnect } from '@tencent-connect/qqbot-connector'

/**
 * QQ 扫码绑定连接器适配层。
 *
 * 协议本体（`q.qq.com` 的创建绑定任务、2s 轮询、AES-256-GCM 解密）在腾讯官方
 * `@tencent-connect/qqbot-connector` 内，本模块只把它的回调风格 API 收窄成网关需要的形状：
 * 不打印终端二维码（`displayQrCodeToConsole: false`）、来源标识固定、取消走 `AbortSignal`。
 * 连接器可被替换以便测试完全不联网。
 *
 * 过期语义由上游定义：连接器收到 EXPIRED 后先回调 `onQrExpired`，随后自行创建新任务与新
 * 二维码；网关在 `onQrExpired` 里 abort（见 `management/binding.ts`），从而把"过期"变成
 * 会话终态而不是无限换码。
 */

/** 扫码结果中的凭据；`userOpenid` 是扫码用户标识，网关不使用、不持久化。 */
export interface QQBindCredentials {
  readonly appId: string
  readonly appSecret: string
}

/** 扫码流程回调；调用顺序与上游一致：先 `onQrDisplayed`，之后成功/失败/过期。 */
export interface QQBindCallbacks {
  /** 二维码 URL 就绪；轮询开始前触发（过期换码不会重复触发，因为网关已终止会话）。 */
  onQrDisplayed(url: string): void
  /** 扫码成功，返回凭据数组（上游恒为单元素，空数组按失败处理）。 */
  onSuccess(credentials: readonly QQBindCredentials[]): void
  /** 流程失败或被动取消；`aborted` 归因由调用方按自己的 AbortSignal 判断。 */
  onFailure(error: Error): void
  /** 二维码过期；网关据此终止会话，不复用上游的自动换码。 */
  onQrExpired(): void
}

export interface QQBindOptions {
  /** 取消扫码轮询；abort 后上游以 `onFailure` 收尾。 */
  readonly signal: AbortSignal
}

/** 扫码绑定连接器；正式入口用 `createQQBindConnector`，测试注入替身。 */
export type QQBindConnector = (callbacks: QQBindCallbacks, options: QQBindOptions) => void

/** 拼进二维码落地页的来源标识（上游会编码进 `source` 查询参数）。 */
export const QQ_BIND_SOURCE = 'dsh-gateway'

/**
 * 基于腾讯官方连接器的默认实现。`startQrConnect` 的返回值是它的内部 stop 函数，这里不
 * 使用——取消统一走传入的 `AbortSignal`，保证"何时终止"只有网关一个事实源。
 */
export function createQQBindConnector(): QQBindConnector {
  return (callbacks, options) => {
    startQrConnect(
      {
        onQrDisplayed: (url) => {
          callbacks.onQrDisplayed(url)
        },
        onSuccess: (credentials) => {
          callbacks.onSuccess(
            credentials.map((credential) => ({
              appId: credential.appId,
              appSecret: credential.appSecret,
            })),
          )
        },
        onFailure: (error) => {
          callbacks.onFailure(error)
        },
        onQrExpired: () => {
          callbacks.onQrExpired()
        },
      },
      {
        displayQrCodeToConsole: false,
        source: QQ_BIND_SOURCE,
        signal: options.signal,
      },
    )
  }
}
