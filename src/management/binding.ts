import { isValidBindingScope } from '../contracts.js'
import { CHANNEL_APP_ID_MAX_LENGTH, CHANNEL_APP_SECRET_MAX_LENGTH } from '../config/schema.js'
import { redact } from '../logging.js'
import type { QQBindConnector, QQBindCredentials } from '../channels/qq/qr-connect.js'
import { ManagementError } from './contracts.js'
import type { ChannelChangeResult, ManagementErrorCode } from './contracts.js'

/**
 * QQ 扫码绑定会话：单会话状态机与终态保留。
 *
 * 对外只有三个动作（由管理服务包装成 HTTP 路由）：
 * - `start`：启动或复用当前会话，等二维码 URL 就绪后返回它；会话进行中重复调用幂等复用
 *   同一张二维码；上一会话进入终态后再次调用才开新会话（即"过期后重新 POST 刷新"）；
 * - `wait`：挂起等待会话终态；成功返回 `ChannelChangeResult`，过期/失败/停机抛出带稳定
 *   `code` 的 `ManagementError`；从未启动过会话时抛 `bind_not_started`；
 * - `abort`：停机时作废进行中的会话，等待方以 `gateway_stopping` 收尾。
 *
 * 终态（成功/过期/失败/停机）保存在内存里，重复 `wait` 立即返回同一结果，直到下一次
 * `start` 或进程重启。失败原因经 `redact` 脱敏，任何响应/异常都不带 `appSecret`。
 *
 * 本模块不做并发/互斥控制：同一时间只维护一个会话，多个等待方共享同一终态；定位是单操作者
 * 场景（见 `docs/architecture.md#qr-bind-flow`）。过期处理是"终止会话"：在 `onQrExpired` 里
 * abort 上游轮询，而不是让上游无限自动换码。
 */

/** 会话终态；`failed` 复用管理错误码，由 HTTP 路由层映射状态码。 */
export type QQBindTerminal =
  | { readonly kind: 'succeeded'; readonly result: ChannelChangeResult }
  | { readonly kind: 'expired' }
  | { readonly kind: 'failed'; readonly code: ManagementErrorCode; readonly message: string }
  | { readonly kind: 'aborted' }

/** 二维码过期后的固定说明（引导重新发起绑定）。 */
export const BIND_EXPIRED_MESSAGE =
  'the QR code expired; call POST /channels/qq/bind again to get a new QR code'

/** 未启动会话就等待终态时的固定说明。 */
export const BIND_NOT_STARTED_MESSAGE =
  'no QR binding session has been started; call POST /channels/qq/bind first'

/** 停机作废会话时的固定说明（HTTP 503 `gateway_stopping`）。 */
export const BIND_ABORTED_MESSAGE =
  'the gateway is shutting down; the QR binding session was aborted'

/**
 * 绑定服务依赖：
 * - `connector` 是腾讯扫码协议的适配器（正式入口为官方连接器，测试注入替身）；
 * - `applyCredentials` 是"落盘 + 启动实例"路径（与管理路由 add 共用），扫码成功后调用。
 */
export interface QQBindingServiceOptions {
  readonly connector: QQBindConnector
  readonly applyCredentials: (appId: string, appSecret: string) => Promise<ChannelChangeResult>
}

/** 扫码绑定会话服务；生命周期与进程一致，不持久化。 */
export interface QQBindingService {
  /** 启动或复用会话；resolve 为二维码 URL。 */
  start(): Promise<{ readonly url: string }>
  /** 等待终态；成功返回变更结果，其余终态抛 `ManagementError`。 */
  wait(): Promise<ChannelChangeResult>
  /** 作废进行中的会话（进程停机用）；幂等。 */
  abort(): void
}

interface QQBindSession {
  /** 取消上游轮询；过期终止与停机终止都走它。 */
  readonly controller: AbortController
  /** 是否已由过期回调触发终止（用于把被动取消归因为 expired）。 */
  expired: boolean
  /** 二维码 URL 的首次就绪结果；失败/终止时以 `ManagementError` 拒绝。 */
  readonly urlPromise: Promise<string>
  readonly resolveUrl: (url: string) => void
  readonly rejectUrl: (error: Error) => void
  urlSettled: boolean
  /** 会话终态；所有等待方共享。 */
  readonly done: Promise<QQBindTerminal>
  readonly resolveDone: (terminal: QQBindTerminal) => void
  doneSettled: boolean
  terminal?: QQBindTerminal
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 上游错误文本可能夹带扫码 URL 的任务号：先去掉 `task_id` 参数值，再交给 `redact`。 */
const QR_TASK_ID_PATTERN = /\btask_id=[^\s&"'<>]+/gi

function scrubQrTaskId(text: string): string {
  return text.replace(QR_TASK_ID_PATTERN, 'task_id=[REDACTED]')
}

/** 自由文本经任务号清洗与 `redact` 脱敏后再进入响应/异常，避免泄露二维码任务或凭证。 */
function describeFailure(prefix: string, error: unknown): string {
  return `${prefix}: ${redact(scrubQrTaskId(errorMessage(error)))}`
}

/** 终态 → 等待方收到的异常；`succeeded` 不是异常路径。 */
function terminalError(terminal: QQBindTerminal): ManagementError {
  switch (terminal.kind) {
    case 'expired':
      return new ManagementError('bind_expired', BIND_EXPIRED_MESSAGE)
    case 'aborted':
      return new ManagementError('gateway_stopping', BIND_ABORTED_MESSAGE)
    case 'failed':
      return new ManagementError(terminal.code, terminal.message)
    case 'succeeded':
      // 成功终态由 wait 直接返回结果，不会走到这里；保留分支只为穷尽类型。
      return new ManagementError('bind_failed', 'the QR binding session already succeeded')
  }
}

/**
 * 校验上游凭据形态（与配置文件/管理路由同规则），防止把无法注册为实例的凭据落盘。
 * 返回规范化后的凭据或错误说明；错误说明只描述字段，不含 secret。上游返回值按不可信形状
 * 防御（非数组、非字符串字段一律按无效凭据处理），本函数不抛异常。
 */
function parseBoundCredentials(
  credentials: readonly QQBindCredentials[],
): { appId: string; appSecret: string } | string {
  if (!Array.isArray(credentials)) {
    return 'the QR flow returned invalid credentials'
  }
  const first: unknown = credentials[0]
  if (typeof first !== 'object' || first === null) {
    return 'the QR flow returned no credentials'
  }
  const { appId: rawAppId, appSecret: rawAppSecret } = first as {
    appId?: unknown
    appSecret?: unknown
  }
  if (typeof rawAppId !== 'string' || typeof rawAppSecret !== 'string') {
    return 'the QR flow returned invalid credentials'
  }
  const appId = rawAppId.trim()
  const appSecret = rawAppSecret.trim()
  if (appId === '' || appId.length > CHANNEL_APP_ID_MAX_LENGTH || !isValidBindingScope(appId)) {
    return 'the QR flow returned an invalid appId'
  }
  if (appSecret === '' || appSecret.length > CHANNEL_APP_SECRET_MAX_LENGTH) {
    return 'the QR flow returned an invalid appSecret'
  }
  return { appId, appSecret }
}

function createSession(): QQBindSession {
  let resolveUrl!: (url: string) => void
  let rejectUrl!: (error: Error) => void
  const urlPromise = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve
    rejectUrl = reject
  })
  let resolveDone!: (terminal: QQBindTerminal) => void
  const done = new Promise<QQBindTerminal>((resolve) => {
    resolveDone = resolve
  })
  return {
    controller: new AbortController(),
    expired: false,
    urlPromise,
    resolveUrl,
    rejectUrl,
    urlSettled: false,
    done,
    resolveDone,
    doneSettled: false,
  }
}

export function createQQBindingService(options: QQBindingServiceOptions): QQBindingService {
  const { connector, applyCredentials } = options
  /** 最近一次会话（含终态保留）；新 start 成功替换它。 */
  let current: QQBindSession | undefined

  /** 第一次拿到 URL 时结算 urlPromise；之后重复回调忽略。 */
  function settleUrl(session: QQBindSession, url: string): void {
    if (session.urlSettled || session.doneSettled) {
      return
    }
    session.urlSettled = true
    session.resolveUrl(url)
  }

  /**
   * 写入终态：只生效一次；若 URL 仍未就绪，用对应异常拒绝它（让等待二维码的 start 请求
   * 立即失败而不是挂住）；最后唤醒所有 wait 等待方。
   */
  function finish(session: QQBindSession, terminal: QQBindTerminal): void {
    if (session.doneSettled) {
      return
    }
    session.doneSettled = true
    session.terminal = terminal
    if (!session.urlSettled) {
      session.urlSettled = true
      session.rejectUrl(terminalError(terminal))
    }
    session.resolveDone(terminal)
  }

  /** 上游失败：按"过期 / 停机 / 上游错误"归因，不复用上游的自动换码。 */
  function failSession(session: QQBindSession, error: Error): void {
    if (session.doneSettled) {
      return
    }
    if (session.expired) {
      finish(session, { kind: 'expired' })
      return
    }
    if (session.controller.signal.aborted) {
      finish(session, { kind: 'aborted' })
      return
    }
    finish(session, {
      kind: 'failed',
      code: 'bind_failed',
      message: describeFailure('the QR binding flow failed', error),
    })
  }

  /** 扫码成功：校验凭据后走与管理路由 add 相同的落盘+启动路径，再写终态。 */
  async function succeedSession(
    session: QQBindSession,
    credentials: readonly QQBindCredentials[],
  ): Promise<void> {
    if (session.doneSettled) {
      return
    }
    const parsed = parseBoundCredentials(credentials)
    if (typeof parsed === 'string') {
      finish(session, { kind: 'failed', code: 'bind_failed', message: parsed })
      return
    }
    try {
      const result = await applyCredentials(parsed.appId, parsed.appSecret)
      finish(session, { kind: 'succeeded', result })
    } catch (error) {
      if (error instanceof ManagementError) {
        // 落盘漂移/写失败/停机等沿用 add 的稳定错误码，wait 侧原样抛出。
        finish(session, { kind: 'failed', code: error.code, message: error.message })
        return
      }
      finish(session, {
        kind: 'failed',
        code: 'bind_failed',
        message: describeFailure('the QR binding failed', error),
      })
    }
  }

  function start(): Promise<{ readonly url: string }> {
    const active = current
    if (active !== undefined && !active.doneSettled) {
      // 会话进行中：幂等复用同一张二维码，不新建上游任务。
      return active.urlPromise.then((url) => ({ url }))
    }
    const session = createSession()
    current = session
    try {
      connector(
        {
          onQrDisplayed: (url) => {
            settleUrl(session, url)
          },
          onQrExpired: () => {
            if (session.doneSettled) {
              return
            }
            // 上游收到 EXPIRED 后会自行创建新任务；在回调里同步 abort，让本次会话以
            // expired 终态结束（Q9：过期不自动换码，手动重新 POST 才刷新）。
            session.expired = true
            session.controller.abort()
          },
          onSuccess: (credentials) => {
            // 兜底 catch：成功路径内部已收敛所有失败；若未来改动引入意外 reject，也必须落终态
            // 而不是让等待方永久挂起或产生未处理拒绝。
            void succeedSession(session, credentials).catch(() => {
              finish(session, {
                kind: 'failed',
                code: 'bind_failed',
                message: 'the QR binding failed unexpectedly',
              })
            })
          },
          onFailure: (error) => {
            failSession(session, error)
          },
        },
        { signal: session.controller.signal },
      )
    } catch (error) {
      // 上游入口同步抛错（测试替身或连接器内部异常）：直接收敛为失败终态。
      finish(session, {
        kind: 'failed',
        code: 'bind_failed',
        message: describeFailure('the QR binding flow failed to start', error),
      })
    }
    return session.urlPromise.then((url) => ({ url }))
  }

  async function wait(): Promise<ChannelChangeResult> {
    const session = current
    if (session === undefined) {
      throw new ManagementError('bind_not_started', BIND_NOT_STARTED_MESSAGE)
    }
    const terminal = session.doneSettled ? session.terminal! : await session.done
    if (terminal.kind === 'succeeded') {
      return terminal.result
    }
    throw terminalError(terminal)
  }

  function abort(): void {
    const session = current
    if (session === undefined || session.doneSettled) {
      return
    }
    finish(session, { kind: 'aborted' })
    session.controller.abort()
  }

  return { start, wait, abort }
}
