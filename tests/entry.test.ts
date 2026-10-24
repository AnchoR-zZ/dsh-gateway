import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import pkg from '../package.json' with { type: 'json' }
import { GatewayConfigError } from '../src/config.js'
import { GATEWAY_CONFIG_FILENAME } from '../src/config-file.js'
import { Config, apply, inject, launchGateway, name } from '../src/index.js'
import type { GatewayLaunchOptions } from '../src/index.js'
import type { QQChannel, QQChannelOptions } from '../src/qq/index.js'

/**
 * 插件入口测试（T10）：Config schema、插件面（name/inject）、launchGateway 的组装与
 * 启动/失败/停止链（替身 cordis ctx + 替身 QQ 渠道工厂 + 注入健康端口，真实 core 总装）。
 * apply 本体只验证委托形状（effect 不执行启动体，避免真实 QQ 网络连接）。
 *
 * 配置来自临时 workspace 下的 gateway.config.json；dsh home 由假 ctx 的 dshHomePath 提供，
 * 全部临时目录在 afterEach 删除，不会写真实用户 home。
 */

// ---- 替身与工具 ----

interface LogLine {
  event: string
  [key: string]: unknown
}

const VALID_CONFIG = {
  schemaVersion: 1,
  qqAppId: 'file-app-id',
  qqAppSecret: 'file-app-secret',
  debug: false,
  maxConcurrent: 4,
  maxPendingPerPeer: 3,
  maxPendingTotal: 100,
  maxPendingBytes: 8_388_608,
  idleAgentTtlMs: 900_000,
  maxLiveAgents: 32,
} as const

let tempRoots: string[] = []

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gw-entry-'))
  tempRoots.push(root)
  return root
}

interface EnvFixture {
  root: string
  workspace: string
  dshHome: string
  configPath: string
  env: Record<string, string | undefined>
}

function writeGatewayConfig(workspace: string, document: Record<string, unknown>): string {
  const configPath = join(workspace, GATEWAY_CONFIG_FILENAME)
  mkdirSync(workspace, { recursive: true })
  writeFileSync(configPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  return configPath
}

function makeEnv(config: Record<string, unknown> = VALID_CONFIG): EnvFixture {
  const root = makeTempRoot()
  const workspace = join(root, 'workspace')
  const configPath = writeGatewayConfig(workspace, config)
  return {
    root,
    workspace,
    dshHome: join(root, 'dsh-home'),
    configPath,
    env: { DSH_GATEWAY_WORKSPACE: workspace },
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function createLoggerCapture(): { lines: LogLine[]; sink(line: string): void } {
  const lines: LogLine[] = []
  return {
    lines,
    sink(line) {
      lines.push(JSON.parse(line) as LogLine)
    },
  }
}

interface FakeCtxOptions {
  runEffect?: boolean
  /** dshHomePath() 的返回值；缺省时不提供该服务。 */
  dshHomePath?: string
  /** false 时模拟宿主缺少 dshHomePath 服务。 */
  provideDshHomePath?: boolean
}

/** 替身 cordis ctx：effect 立即执行并登记 disposer；logger 记录 error 调用；get 提供 dshHomePath。 */
function createFakeCordisCtx(opts?: FakeCtxOptions) {
  const disposers: (() => unknown)[] = []
  const errors: string[] = []
  const runEffect = opts?.runEffect ?? true
  const provideDshHomePath = opts?.provideDshHomePath ?? true
  const dshHomePath = opts?.dshHomePath
  const ctx = {
    effect(execute: () => unknown): () => Promise<void> {
      if (runEffect) {
        const disposer = execute() as () => unknown
        disposers.push(disposer)
      }
      return () => Promise.resolve()
    },
    logger(_name?: string) {
      return {
        error: (...args: unknown[]) => {
          errors.push(args.map(String).join(' '))
        },
      }
    },
    get(service: string): unknown {
      if (service !== 'dshHomePath' || !provideDshHomePath || dshHomePath === undefined) {
        return undefined
      }
      return () => dshHomePath
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    },
  }
  return {
    ctx: ctx as unknown as Context,
    disposers,
    errors,
    async disposeAll(): Promise<void> {
      for (const disposer of disposers.splice(0)) {
        await disposer()
      }
    },
  }
}

interface FakeQQ {
  channel: QQChannel
  calls: string[]
  options: QQChannelOptions[]
  failStart: boolean
}

function createFakeQQ(): FakeQQ {
  const qq: FakeQQ = {
    calls: [],
    options: [],
    failStart: false,
    channel: {
      async start() {
        qq.calls.push('start')
        if (qq.failStart) {
          throw new Error('qq gateway rejected')
        }
      },
      async stop() {
        qq.calls.push('stop')
      },
    },
  }
  return qq
}

function makeLaunchOptions(
  qq: FakeQQ,
  logs: { sink(line: string): void },
  port: number,
): GatewayLaunchOptions {
  const createQQChannelAdapter = (options: QQChannelOptions): QQChannel => {
    qq.options.push(options)
    return qq.channel
  }
  return {
    health: { host: '127.0.0.1', port },
    createQQChannelAdapter,
    loggerSink: logs.sink,
  }
}

/** 预留一个临时端口（bind 0 后关闭），降低 launch 绑定时的冲突窗口。 */
async function reservePort(): Promise<number> {
  const server: Server = createServer()
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
  return port
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timeout')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function requestStatus(port: number, path: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`)
  return response.status
}

// ---- 测试 ----

describe('plugin surface (T10)', () => {
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

  it('apply 委托 launchGateway：合法 workspace 下注册一个 effect，不抛错（effect 不执行启动体）', () => {
    const fixture = makeEnv()
    vi.stubEnv('DSH_GATEWAY_WORKSPACE', fixture.workspace)
    try {
      const fake = createFakeCordisCtx({
        runEffect: false,
        dshHomePath: fixture.dshHome,
      })
      expect(() => apply(fake.ctx, {})).not.toThrow()
      expect(fake.errors).toEqual([])
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('launchGateway startup chain (T10)', () => {
  it('core 先就绪再启动 QQ：startup_summary 落日志，/livez 200，disposer 触发停止链', async () => {
    const fixture = makeEnv()
    const fakeCtx = createFakeCordisCtx({ dshHomePath: fixture.dshHome })
    const logs = createLoggerCapture()
    const qq = createFakeQQ()
    const port = await reservePort()

    launchGateway(fakeCtx.ctx, fixture.env, makeLaunchOptions(qq, logs, port))

    await waitFor(() => qq.calls.includes('start'))
    // qq.start 严格排在 await coreHandle.start() 之后：能响应 /livez 即 core 已启动并绑定健康监听。
    expect(await requestStatus(port, '/livez')).toBe(200)

    const summary = logs.lines.find((line) => line.event === 'startup_summary')
    expect(summary).toMatchObject({
      version: pkg.version,
      schemaVersion: 1,
      configSchemaVersion: 1,
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      maxConcurrent: 4,
      maxLiveAgents: 32,
    })
    expect(qq.options).toEqual([
      expect.objectContaining({ appId: 'file-app-id', appSecret: 'file-app-secret' }),
    ])

    await fakeCtx.disposeAll()
    expect(qq.calls).toEqual(['start', 'stop'])
    // 停止链关闭健康监听：端口不再接受连接。
    await expect(requestStatus(port, '/livez')).rejects.toThrow()
  })

  it('QQ 启动失败：记 manual_restart_required，core 与 QQ 均被停止（无 unhandled rejection）', async () => {
    const fixture = makeEnv()
    const fakeCtx = createFakeCordisCtx({ dshHomePath: fixture.dshHome })
    const logs = createLoggerCapture()
    const qq = createFakeQQ()
    qq.failStart = true
    const port = await reservePort()

    launchGateway(fakeCtx.ctx, fixture.env, makeLaunchOptions(qq, logs, port))

    await waitFor(() => qq.calls.includes('stop'))
    expect(qq.calls).toEqual(['start', 'stop'])
    expect(logs.lines.some((line) => line.event === 'manual_restart_required')).toBe(true)
    // coreHandle.stop 已执行：健康监听被关闭（连接拒绝而非 503）。
    await expect(requestStatus(port, '/livez')).rejects.toThrow()
    // 启动失败后再次 dispose（cordis 卸载）不应重复抛错或悬挂。
    await fakeCtx.disposeAll()
  })

  it('配置无效：缺 qqAppId 时记录错误后 throw，不注册 effect', () => {
    const { qqAppId: _omitted, ...withoutAppId } = VALID_CONFIG
    const fixture = makeEnv(withoutAppId)
    const fakeCtx = createFakeCordisCtx({ dshHomePath: fixture.dshHome })
    const logs = createLoggerCapture()

    expect(() =>
      launchGateway(fakeCtx.ctx, fixture.env, makeLaunchOptions(createFakeQQ(), logs, 0)),
    ).toThrow(/qqAppId must be a non-empty string/)
    expect(fakeCtx.errors.join('\n')).toContain('qqAppId')
    expect(fakeCtx.errors.length).toBe(1)
    // effect 未注册：没有可触发的启动链。
    expect(fakeCtx.disposers).toEqual([])
  })

  it('宿主缺少 dshHomePath 服务：拒绝启动并提示服务不可用', () => {
    const fixture = makeEnv()
    const fakeCtx = createFakeCordisCtx({ provideDshHomePath: false })
    const logs = createLoggerCapture()

    expect(() =>
      launchGateway(fakeCtx.ctx, fixture.env, makeLaunchOptions(createFakeQQ(), logs, 0)),
    ).toThrow(GatewayConfigError)
    expect(() =>
      launchGateway(fakeCtx.ctx, fixture.env, makeLaunchOptions(createFakeQQ(), logs, 0)),
    ).toThrow(/dshHomePath service is unavailable/)
    expect(fakeCtx.errors.join('\n')).toContain('dshHomePath service is unavailable')
    expect(fakeCtx.disposers).toEqual([])
  })

  it('旧网关环境变量不再读取，配置只来自 gateway.config.json', async () => {
    const fixture = makeEnv({
      ...VALID_CONFIG,
      qqAppId: 'file-only-app-id',
      qqAppSecret: 'file-only-app-secret',
      maxConcurrent: 7,
      maxLiveAgents: 9,
    })
    const env: Record<string, string | undefined> = {
      ...fixture.env,
      DSH_HOME: join(fixture.root, 'old-home'),
      DSH_GATEWAY_STATE_DIR: join(fixture.root, 'old-state'),
      DSH_GATEWAY_WORKSPACE_ROOT: join(fixture.root, 'old-users'),
      DSH_GATEWAY_QQ_APP_ID: 'old-env-app-id',
      DSH_GATEWAY_QQ_APP_SECRET: 'old-env-app-secret',
      DEBUG: '1',
      DSH_GATEWAY_MAX_CONCURRENT: '99',
      DSH_GATEWAY_MAX_PENDING_PER_PEER: '99',
      DSH_GATEWAY_MAX_PENDING_TOTAL: '999',
      DSH_GATEWAY_MAX_PENDING_BYTES: '999999',
      DSH_GATEWAY_IDLE_AGENT_TTL_MS: '1',
      DSH_GATEWAY_MAX_LIVE_AGENTS: '99',
    }
    const fakeCtx = createFakeCordisCtx({ dshHomePath: fixture.dshHome })
    const logs = createLoggerCapture()
    const qq = createFakeQQ()
    const port = await reservePort()

    launchGateway(fakeCtx.ctx, env, makeLaunchOptions(qq, logs, port))

    await waitFor(() => qq.calls.includes('start'))
    expect(qq.options).toEqual([
      expect.objectContaining({ appId: 'file-only-app-id', appSecret: 'file-only-app-secret' }),
    ])
    const summary = logs.lines.find((line) => line.event === 'startup_summary')
    expect(summary).toMatchObject({
      maxConcurrent: 7,
      maxLiveAgents: 9,
      configSchemaVersion: 1,
    })

    await fakeCtx.disposeAll()
    expect(qq.calls).toEqual(['start', 'stop'])
  })
})
