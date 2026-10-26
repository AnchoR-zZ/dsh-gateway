import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import { launchGateway } from './runtime.js'

/**
 * 插件入口：只声明插件面并委托 runtime 组装，不包含宿主适配或业务组装代码。
 *
 * `inject` 声明宿主服务依赖：缺服务时本插件不加载，天然满足"依赖未满足时保持未就绪，
 * 不连接 QQ 接流量"。全部网关配置经环境变量与 workspace 内配置文件（见 config 层）。
 */

/** Cordis plugin name; must match the insert row id in cordis.patch.yml. */
export const name = 'dsh-gateway'

/** 宿主服务依赖（3.2）：`agentLoop` 保证 agent factory 已注册。 */
export const inject = [
  'agents',
  'sessions',
  'sessionPersistence',
  'agentDefaultModel',
  'approval',
  'sandboxPolicy',
  'agentLoop',
] as const

/** Plugin config; 全部网关配置经环境变量（16 节），插件 config 无字段。 */
export interface Config {}

export const Config = z.object({})

/** Plugin entry; cordis 以 (ctx, config) 调用，全部配置经环境变量（16 节）。 */
export function apply(ctx: Context, _config: Config): void {
  launchGateway(ctx, process.env)
}
