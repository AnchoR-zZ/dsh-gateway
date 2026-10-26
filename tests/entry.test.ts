import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * 插件入口测试：仅覆盖插件面（name/inject/Config/apply）与 apply → runtime 的委托。
 *
 * runtime 被 mock：apply 的职责只是把 ctx 与环境变量交给 launchGateway，组装与启停不属于
 * 本文件（由 tests/runtime.test.ts 覆盖）。因此本测试不触碰真实配置、HTTP 或 QQ 网络。
 */

const mocks = vi.hoisted(() => ({ launchGateway: vi.fn() }))

vi.mock('../src/runtime.js', () => ({ launchGateway: mocks.launchGateway }))

import { Config, apply, inject, name } from '../src/index.js'

afterEach(() => {
  mocks.launchGateway.mockReset()
})

describe('plugin surface', () => {
  it('Config schema 解析空对象成功', () => {
    expect(Config({})).toEqual({})
  })

  it('name 与 inject 声明宿主服务依赖（含 agentLoop）', () => {
    expect(name).toBe('dsh-gateway')
    expect([...inject]).toEqual(
      expect.arrayContaining([
        'agents',
        'sessions',
        'sessionPersistence',
        'agentDefaultModel',
        'approval',
        'sandboxPolicy',
        'agentLoop',
      ]),
    )
  })

  it('apply 只委托 launchGateway(ctx, process.env)：自身不注册 effect、不执行启动', () => {
    const ctx = {
      effect: vi.fn(),
      logger: vi.fn(),
    } as unknown as Context

    expect(apply(ctx, {})).toBeUndefined()

    expect(mocks.launchGateway).toHaveBeenCalledTimes(1)
    expect(mocks.launchGateway).toHaveBeenCalledWith(ctx, process.env)
    // 启动体的 effect 由 runtime 注册；入口本身不触碰 ctx.effect。
    expect(ctx.effect).not.toHaveBeenCalled()
  })
})
