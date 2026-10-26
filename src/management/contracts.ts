import type { ChannelState, CoreState } from '../core/contracts.js'

/**
 * 管理业务契约：管理请求的输入/输出、状态查询结果与稳定的业务错误码。
 *
 * 本模块不包含 HTTP 状态码；网络协议 DTO 在 `src/http/protocol.ts`，管理请求到 HTTP 响应
 * 的映射由 `src/http/routes.ts` 负责。管理输入来自不可信 JSON，形状与业务字段由管理服务
 * 校验，失败一律抛带稳定 `code` 的 `ManagementError`。所有权：管理服务拥有 add/enable 的
 * 流程；ConfigStore 拥有配置写入；ChannelManager 拥有运行实例。
 */

/** 健康展示用的渠道状态：已注册实例的运行状态之外，另有配置派生值。 */
export type ChannelHealthState = ChannelState | 'disabled' | 'not_configured'

/** 管理查询结果中的一条实例状态；不含凭证。 */
export interface GatewayChannelStatus {
  /** 渠道类型标识，QQ 恒为 `qq`。 */
  readonly channelId: string
  /** 配置实例标识；类型级状态（`not_configured`）时缺省。 */
  readonly appId?: string
  /** 该实例是否在当前配置中。 */
  readonly configured: boolean
  /** 该实例在当前配置中是否 `enabled: true`。 */
  readonly enabled: boolean
  /** 运行快照覆盖配置派生值后的展示状态。 */
  readonly state: ChannelHealthState
}

/** 配置与运行状态的聚合结果；`getStatus()` 与 `/readyz` 共用同一份计算。 */
export interface GatewayStatus {
  readonly coreState: CoreState
  readonly stateStoreFailed: boolean
  readonly startedAt: string
  readonly pending: number
  readonly running: number
  /** 就绪判定：core ready、store 健康且除 `disabled`/`not_configured` 外的实例全部 online。 */
  readonly ready: boolean
  readonly channels: readonly GatewayChannelStatus[]
}

/**
 * 管理业务错误的稳定 code。HTTP 映射：`invalid_request`/`app_id_required` → 400，
 * `instance_not_found` → 404，`config_modified_externally`/`bind_expired`/`bind_not_started` → 409，
 * `credential_validation_failed` → 422，`gateway_not_ready`/`gateway_stopping` → 503，
 * `bind_failed` → 502，`config_write_failed` → 500。
 */
export type ManagementErrorCode =
  | 'invalid_request'
  | 'app_id_required'
  | 'instance_not_found'
  | 'config_modified_externally'
  | 'credential_validation_failed'
  | 'gateway_not_ready'
  | 'gateway_stopping'
  | 'config_write_failed'
  /** 扫码绑定上游失败（创建绑定任务、解密/解析扫码结果、返回非法凭据或绑定流水线异常）。 */
  | 'bind_failed'
  /** 二维码已过期，绑定会话终止；重新 POST 启动即可刷新。 */
  | 'bind_expired'
  /** 尚未启动绑定会话就查询结果。 */
  | 'bind_not_started'

/** 可预期的管理失败；message 不含 `appSecret`，也不带 HTTP 状态码。 */
export class ManagementError extends Error {
  readonly code: ManagementErrorCode

  constructor(code: ManagementErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ManagementError'
    this.code = code
  }
}

/** 一次成功的实例变更结果：实例标识、配置是否已保存、当前运行状态与可公开说明。 */
export interface ChannelChangeResult {
  /** 实例标识，形如 `qq:<appId>`。 */
  readonly channel: string
  /** 配置是否已写入（凭证校验失败时为 false 并抛错，不走本结果）。 */
  readonly saved: boolean
  /** 响应时观察到的实例状态；启动失败或停机中止时可能为 `blocked`。 */
  readonly state: ChannelHealthState
  /** 可公开的补充说明（不含凭证），例如启动失败原因或"已保存但未启动"。 */
  readonly detail?: string
}

/** 扫码绑定启动结果：腾讯侧的二维码 URL，由调用方自行展示。 */
export interface QQBindStartResult {
  /** 二维码落地页 URL（`q.qq.com`）；短时效，不写日志、不持久化。 */
  readonly url: string
}

/** 管理业务能力；HTTP 与管理入口都只通过本接口执行业务流程。 */
export interface GatewayManagement {
  getStatus(): GatewayStatus

  /**
   * 添加或更新一个 QQ 实例：校验 → 允许修改检查 → 凭证在线校验（`force` 跳过）→
   * ConfigStore 串行保存 → 同步实例视图 → ChannelManager 启动或替换实例。
   */
  addQQ(input: unknown): Promise<ChannelChangeResult>

  /** 启用一个 QQ 实例：置 `enabled: true` 并对未在线实例立即启动。 */
  enableQQ(input: unknown): Promise<ChannelChangeResult>

  /**
   * 启动（或幂等复用）扫码绑定会话，等二维码 URL 就绪后返回。
   * core 未 ready 或停机闸门关闭时抛 `gateway_not_ready` / `gateway_stopping`。
   */
  bindQQStart(): Promise<QQBindStartResult>

  /**
   * 等待扫码绑定会话终态：扫码成功返回实例变更结果（已自动落盘并启动），二维码过期抛
   * `bind_expired`，上游失败抛 `bind_failed`，停机作废抛 `gateway_stopping`，从未启动
   * 会话抛 `bind_not_started`。没有总超时，由二维码过期或会话终止收尾。
   */
  bindQQWait(): Promise<ChannelChangeResult>
}
