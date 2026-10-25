import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import pkg from '../package.json' with { type: 'json' }
import { GatewayConfigError } from '../src/config.js'
import type { GatewayConfigFile } from '../src/config.js'
import { GATEWAY_CONFIG_FILENAME } from '../src/config-file.js'
import { QQCredentialCheckError } from '../src/qq/token.js'
import { Config, apply, inject, launchGateway, name } from '../src/index.js'
import type { GatewayLaunchOptions } from '../src/index.js'
import type { QQChannel, QQChannelOptions } from '../src/qq/index.js'

/**
 * 插件入口测试（T10）：Config schema、插件面（name/inject）、launchGateway 的组装与
 * 启动/失败/停止链（替身 cordis ctx + 替身 QQ 渠道工厂 + 注入健康端口与凭证校验替身，
 * 真实 core 总装）。apply 本体只验证委托形状（effect 不执行启动体，避免真实 QQ 网络）。
 *
 * 配置来自临时 workspace 下的 gateway.config.json（v2 schema）；dsh home 由假 ctx 的
 * dshHomePath 提供，全部临时目录在 afterEach 删除，不会写真实用户 home。
 */

// ---- 替身与工具 ----

interface LogLine {
  event: string
  [key: string]: unknown
}

const VALID_CONFIG_V2 = {
  schemaVersion: 2,
  channels: {
    qq: [
      { appId: 'file-app-id', appSecret: 'file-app-secret' },
      { appId: 'second-app-id', appSecret: 'second-app-secret' },
    ],
  },
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

function makeEnv(config: Record<string, unknown> = VALID_CONFIG_V2): EnvFixture {
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

interface FakeChannelHandle {
  appId: string
  startCalls: number
  stopCalls: number
  failStart: boolean
  channel: QQChannel
}

/**
 * 按 appId 记录的替身渠道工厂：start() 经真实 core 注册面注册并置 online（镜像真实渠道
 * 的注册顺序），可配置某个实例 start 失败（抛错、不注册），记录收到的 options。
 */
function createFakeQQFactory() {
  const handles = new Map<string, FakeChannelHandle>()
  const optionsSeen: QQChannelOptions[] = []
  const failAppIds = new Set<string>()
  const factory = (opts: QQChannelOptions): QQChannel => {
    optionsSeen.push(opts)
    const handle: FakeChannelHandle = {
      appId: opts.appId,
      startCalls: 0,
      stopCalls: 0,
      failStart: failAppIds.has(opts.appId),
      channel: {
        async start() {
          handle.startCalls += 1
          if (handle.failStart) {
            throw new Error(`qq gateway rejected ${opts.appId}`)
          }
          const ingress = opts.core.registerChannel({
            channelId: 'qq',
            accountId: opts.appId,
            stopReceiving: async () => undefined,
          })
          ingress.setState('online')
        },
        async stop() {
          handle.stopCalls += 1
        },
      },
    }
    handles.set(opts.appId, handle)
    return handle.channel
  }
  return {
    factory,
    handles,
    optionsSeen,
    failAppIds,
    handleOf(appId: string): FakeChannelHandle | undefined {
      return handles.get(appId)
    },
  }
}

function makeLaunchOptions(
  qq: ReturnType<typeof createFakeQQFactory>,
  logs: { sink(line: string): void },
  port: number,
  extra?: Partial<GatewayLaunchOptions>,
): GatewayLaunchOptions {
  return {
    health: { host: '127.0.0.1', port },
    createQQChannelAdapter: qq.factory,
    loggerSink: logs.sink,
    ...extra,
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

async function readyzBody(port: number): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${port}/readyz`)
  return (await response.json()) as Record<string, unknown>
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
  it('core 先就绪再按配置顺序启动各实例：startup_summary 落日志，/livez 200，disposer 停止全部实例', async () => {
    const fixture = makeEnv()
    const fakeCtx = createFakeCordisCtx({ dshHomePath: fixture.dshHome })
    const logs = createLoggerCapture()
    const qq = createFakeQQFactory()
    const port = await reservePort()

    launchGateway(fakeCtx.ctx, fixture.env, makeLaunchOptions(qq, logs, port))

    await waitFor(() => qq.handles.size === 2 && [...qq.handles.values()].every((h) => h.startCalls === 1))
    // qq.start 严格排在 await coreHandle.start() 之后：能响应 /livez 即 core 已启动并绑定健康监听。
    expect(await requestStatus(port, '/livez')).toBe(200)

    const summary = logs.lines.find((line) => line.event === 'startup_summary')
    expect(summary).toMatchObject({
      version: pkg.version,
      schemaVersion: 1,
      configSchemaVersion: 2,
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      maxConcurrent: 4,
      maxLiveAgents: 32,
    })
    expect(qq.optionsSeen.map((o) => o.appId)).toEqual(['file-app-id', 'second-app-id'])
    expect(qq.optionsSeen[0]).toMatchObject({ appId: 'file-app-id', appSecret: 'file-app-secret' })
    expect(qq.optionsSeen[1]).toMatchObject({ appId: 'second-app-id', appSecret: 'second-app-secret' })

    await fakeCtx.disposeAll()
    expect([...qq.handles.values()].map((h) => h.stopCalls)).toEqual([1, 1])
    // 停止链关闭健康监听：端口不再接受连接。
    await expect(requestStatus(port, '/livez')).rejects.toThrow()
  })

  it('零实例（空数组）正常启动：无渠道工厂调用，/readyz 200 且 qq: not_configured', async () => {
    const fixture = makeEnv({ schemaVersion: 2, channels: { qq: [] } })
    const fakeCtx = createFakeCordisCtx({ dshHomePath: fixture.dshHome })
    const logs = createLoggerCapture()
    const qq = createFakeQQFactory()
    const port = await reservePort()

    launchGateway(fakeCtx.ctx, fixture.env, makeLaunchOptions(qq, logs, port))

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(qq.handles.size).toBe(0)
    expect(await requestStatus(port, '/readyz')).toBe(200)
    const body = await readyzBody(port)
    expect(body.channels).toEqual({ qq: 'not_configured' })
    expect(body.coreState).toBe('ready')
    await fakeCtx.disposeAll()
  })

  it('全部实例 disabled 时同样零启动且 ready', async () => {
    const fixture = makeEnv({
      schemaVersion: 2,
      channels: { qq: [{ appId: 'off-app', appSecret: 's', enabled: false }] },
    })
    const fakeCtx = createFakeCordisCtx({ dshHomePath: fixture.dshHome })
    const logs = createLoggerCapture()
    const qq = createFakeQQFactory()
    const port = await reservePort()

    launchGateway(fakeCtx.ctx, fixture.env, makeLaunchOptions(qq, logs, port))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(qq.handles.size).toBe(0)
    expect(await requestStatus(port, '/readyz')).toBe(200)
    expect((await readyzBody(port)).channels).toEqual({ 'qq:off-app': 'disabled' })
    await fakeCtx.disposeAll()
  })

  it('单实例启动失败只影响自身：该实例 blocked，其余实例照常，进程与 core 不退出', async () => {
    const fixture = makeEnv()
    const fakeCtx = createFakeCordisCtx({ dshHomePath: fixture.dshHome })
    const logs = createLoggerCapture()
    const qq = createFakeQQFactory()
    qq.failAppIds.add('file-app-id')
    const port = await reservePort()

    launchGateway(fakeCtx.ctx, fixture.env, makeLaunchOptions(qq, logs, port))

    await waitFor(() => qq.handleOf('second-app-id')?.startCalls === 1)
    expect(qq.handleOf('file-app-id')?.startCalls).toBe(1)
    // core 存活：健康监听仍在响应。
    expect(await requestStatus(port, '/livez')).toBe(200)
    // 失败实例 blocked（enabled 未注册铺底），成功实例已注册并 online。
    const body = await readyzBody(port)
    expect(body.channels).toEqual({ 'qq:file-app-id': 'blocked', 'qq:second-app-id': 'online' })
    expect(await requestStatus(port, '/readyz')).toBe(503)
    expect(logs.lines.some((line) => line.event === 'manual_restart_required')).toBe(true)

    await fakeCtx.disposeAll()
    expect(qq.handleOf('second-app-id')?.stopCalls).toBe(1)
  })

  it('冷启动循环期间 admin 已拉起同 appId 实例：循环跳过在线实例，不重启、不覆盖新 secret', async () => {
    const fixture = makeEnv()
    const fakeCtx = createFakeCordisCtx({ dshHomePath: fixture.dshHome })
    const logs = createLoggerCapture()
    const qq = createFakeQQFactory()
    const port = await reservePort()

    // 第一个实例的 start 挂起，把冷启动循环停在第一个实例上；等待期内经管理路由更新
    // 第二个实例的 secret 并拉起在线。构造委托共享替身工厂（optionsSeen 记录构造参数）。
    let releaseFirstStart!: () => void
    const firstStartGate = new Promise<void>((resolve) => {
      releaseFirstStart = resolve
    })
    const factory = (options: QQChannelOptions): QQChannel => {
      const channel = qq.factory(options)
      if (options.appId !== 'file-app-id') {
        return channel
      }
      return {
        start: () => firstStartGate.then(() => channel.start()),
        stop: () => channel.stop(),
      }
    }

    launchGateway(fakeCtx.ctx, fixture.env, makeLaunchOptions({ ...qq, factory }, logs, port))

    // 循环已构造第一个实例并停在其挂起的 start 上（尚未到达第二个实例）。
    await waitFor(() => qq.optionsSeen.some((o) => o.appId === 'file-app-id'))

    // core 就绪后、循环到达 second-app-id 前，admin 更新其 secret（重复 add 保留 enabled）
    // 并以新 secret 拉起该实例。
    const response = await fetch(`http://127.0.0.1:${port}/channels/qq`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: 'second-app-id', appSecret: 'updated-secret', force: true }),
    })
    expect(response.status).toBe(200)

    // 放行第一个实例：循环继续，到达 second-app-id 时该实例已在线 → 幂等跳过。
    releaseFirstStart()
    await waitFor(() => qq.handleOf('file-app-id')?.startCalls === 1)
    await new Promise((resolve) => setTimeout(resolve, 50))

    // 只有 admin 构造过一次 second-app-id（新 secret）；循环不以启动快照的旧 secret 重启，
    // 也不停掉在线实例。
    const secondOptions = qq.optionsSeen.filter((o) => o.appId === 'second-app-id')
    expect(secondOptions.map((o) => o.appSecret)).toEqual(['updated-secret'])
    expect(qq.handleOf('second-app-id')?.stopCalls).toBe(0)
    expect((await readyzBody(port)).channels).toEqual({
      'qq:file-app-id': 'online',
      'qq:second-app-id': 'online',
    })

    await fakeCtx.disposeAll()
  })

  it('工厂同步抛错：该实例 blocked 且记 manual_restart_required，其余实例照常、进程不退出', async () => {
    const fixture = makeEnv()
    const fakeCtx = createFakeCordisCtx({ dshHomePath: fixture.dshHome })
    const logs = createLoggerCapture()
    const qq = createFakeQQFactory()
    const port = await reservePort()
    const factory = (options: QQChannelOptions): QQChannel => {
      if (options.appId === 'file-app-id') {
        throw new Error(`factory exploded for ${options.appId}`)
      }
      return qq.factory(options)
    }

    launchGateway(fakeCtx.ctx, fixture.env, makeLaunchOptions({ ...qq, factory }, logs, port))

    await waitFor(() => qq.handleOf('second-app-id')?.startCalls === 1)
    // 抛错实例不进运行表（enabled 未注册 → blocked 铺底），成功实例照常在线。
    const body = await readyzBody(port)
    expect(body.channels).toEqual({ 'qq:file-app-id': 'blocked', 'qq:second-app-id': 'online' })
    expect(await requestStatus(port, '/readyz')).toBe(503)
    // core 不退出：/livez 仍 200 且 coreState 仍 ready。
    expect(await requestStatus(port, '/livez')).toBe(200)
    expect(body.coreState).toBe('ready')
    expect(
      logs.lines.some(
        (line) => line.event === 'manual_restart_required' && String(line.reason).includes('factory exploded'),
      ),
    ).toBe(true)

    await fakeCtx.disposeAll()
    expect(qq.handleOf('second-app-id')?.stopCalls).toBe(1)
  })

  it('v1 双空模板：自动迁移为 v2 零实例并正常启动，配置文件已写回 v2', async () => {
    const fixture = makeEnv({ schemaVersion: 1, qqAppId: '', qqAppSecret: '' })
    const fakeCtx = createFakeCordisCtx({ dshHomePath: fixture.dshHome })
    const logs = createLoggerCapture()
    const qq = createFakeQQFactory()
    const port = await reservePort()

    launchGateway(fakeCtx.ctx, fixture.env, makeLaunchOptions(qq, logs, port))

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(qq.handles.size).toBe(0)
    expect(await requestStatus(port, '/readyz')).toBe(200)
    const body = await readyzBody(port)
    expect(body.channels).toEqual({ qq: 'not_configured' })
    expect(body.coreState).toBe('ready')
    // 配置文件已被迁移写回为 v2 零实例文档。
    const onDisk = JSON.parse(readFileSync(fixture.configPath, 'utf8')) as GatewayConfigFile
    expect(onDisk.schemaVersion).toBe(2)
    expect(onDisk.channels.qq).toEqual([])
    expect(logs.lines.some((line) => line.event === 'config_migrated')).toBe(true)

    await fakeCtx.disposeAll()
  })

  it('配置无效：v1 单空凭证（appId 有值、secret 为空）经迁移校验失败后 throw，不注册 effect', () => {
    const fixture = makeEnv({ schemaVersion: 1, qqAppId: 'legacy-app', qqAppSecret: '' })
    const fakeCtx = createFakeCordisCtx({ dshHomePath: fixture.dshHome })
    const logs = createLoggerCapture()

    expect(() =>
      launchGateway(fakeCtx.ctx, fixture.env, makeLaunchOptions(createFakeQQFactory(), logs, 0)),
    ).toThrow(/qqAppSecret must be a non-empty string/)
    expect(fakeCtx.errors.join('\n')).toContain('qqAppSecret')
    expect(fakeCtx.disposers).toEqual([])
  })

  it('宿主缺少 dshHomePath 服务：拒绝启动并提示服务不可用', () => {
    const fixture = makeEnv()
    const fakeCtx = createFakeCordisCtx({ provideDshHomePath: false })
    const logs = createLoggerCapture()

    expect(() =>
      launchGateway(fakeCtx.ctx, fixture.env, makeLaunchOptions(createFakeQQFactory(), logs, 0)),
    ).toThrow(GatewayConfigError)
    expect(fakeCtx.errors.join('\n')).toContain('dshHomePath service is unavailable')
    expect(fakeCtx.disposers).toEqual([])
  })

  it('旧网关环境变量不再读取，配置只来自 gateway.config.json', async () => {
    const fixture = makeEnv({
      schemaVersion: 2,
      channels: { qq: [{ appId: 'file-only-app-id', appSecret: 'file-only-app-secret' }] },
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
      DSH_GATEWAY_MAX_LIVE_AGENTS: '99',
    }
    const fakeCtx = createFakeCordisCtx({ dshHomePath: fixture.dshHome })
    const logs = createLoggerCapture()
    const qq = createFakeQQFactory()
    const port = await reservePort()

    launchGateway(fakeCtx.ctx, env, makeLaunchOptions(qq, logs, port))

    await waitFor(() => qq.handles.size === 1)
    expect(qq.optionsSeen).toEqual([
      expect.objectContaining({ appId: 'file-only-app-id', appSecret: 'file-only-app-secret' }),
    ])
    const summary = logs.lines.find((line) => line.event === 'startup_summary')
    expect(summary).toMatchObject({
      maxConcurrent: 7,
      maxLiveAgents: 9,
      configSchemaVersion: 2,
    })

    await fakeCtx.disposeAll()
    expect(qq.handleOf('file-only-app-id')?.stopCalls).toBe(1)
  })
})

describe('launchGateway admin wiring', () => {
  it('零实例启动后 POST /channels/qq 完成添加：校验通过、配置落盘、实例启动', async () => {
    const fixture = makeEnv({ schemaVersion: 2, channels: { qq: [] } })
    const fakeCtx = createFakeCordisCtx({ dshHomePath: fixture.dshHome })
    const logs = createLoggerCapture()
    const qq = createFakeQQFactory()
    const port = await reservePort()
    const validate = vi.fn(async () => undefined)

    launchGateway(fakeCtx.ctx, fixture.env, makeLaunchOptions(qq, logs, port, { validateQQCredentials: validate }))

    await new Promise((resolve) => setTimeout(resolve, 50))

    const response = await fetch(`http://127.0.0.1:${port}/channels/qq`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: 'hot-app', appSecret: 'hot-secret' }),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; channel: string; state: string }
    expect(body.ok).toBe(true)
    expect(body.channel).toBe('qq:hot-app')
    expect(body.state).toBe('online')
    expect(JSON.stringify(body)).not.toContain('hot-secret')

    expect(validate).toHaveBeenCalledWith('hot-app', 'hot-secret')
    expect(qq.handleOf('hot-app')?.startCalls).toBe(1)
    const onDisk = JSON.parse(readFileSync(fixture.configPath, 'utf8')) as {
      channels: { qq: { appId: string; enabled: boolean }[] }
    }
    expect(onDisk.channels.qq).toEqual([{ appId: 'hot-app', appSecret: 'hot-secret', enabled: true }])
    expect(logs.lines.some((line) => line.event === 'channel_added')).toBe(true)
    // 日志与响应均不回显 secret。
    expect(JSON.stringify(logs.lines)).not.toContain('hot-secret')

    await fakeCtx.disposeAll()
  })

  it('凭证校验失败返回 422 且不写配置、不启动实例', async () => {
    const fixture = makeEnv({ schemaVersion: 2, channels: { qq: [] } })
    const fakeCtx = createFakeCordisCtx({ dshHomePath: fixture.dshHome })
    const logs = createLoggerCapture()
    const qq = createFakeQQFactory()
    const port = await reservePort()
    const validate = vi.fn(async () => {
      throw new QQCredentialCheckError('rejected', 'QQ token endpoint rejected the credentials: HTTP 401')
    })

    launchGateway(fakeCtx.ctx, fixture.env, makeLaunchOptions(qq, logs, port, { validateQQCredentials: validate }))
    await new Promise((resolve) => setTimeout(resolve, 50))

    const response = await fetch(`http://127.0.0.1:${port}/channels/qq`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: 'bad-app', appSecret: 'bad-secret' }),
    })
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('credential_validation_failed')
    expect(body.error.message).toContain('HTTP 401')
    expect(JSON.stringify(body)).not.toContain('bad-secret')

    expect(qq.handles.size).toBe(0)
    const onDisk = JSON.parse(readFileSync(fixture.configPath, 'utf8')) as {
      channels: { qq: unknown[] }
    }
    expect(onDisk.channels.qq).toEqual([])

    await fakeCtx.disposeAll()
  })
})
