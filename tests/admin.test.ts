import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GatewayConfigFile, QQChannelInstance } from '../src/config.js'
import { GATEWAY_CONFIG_FILENAME, loadGatewayConfigStore } from '../src/config-file.js'
import type { GatewayConfigStore } from '../src/config-file.js'
import { createAdminRoutes } from '../src/admin.js'
import type { AdminReply } from '../src/core/lifecycle.js'
import { createChannelManager } from '../src/channels.js'
import { GATEWAY_LIMITS } from '../src/contracts.js'
import type { GatewayCore } from '../src/contracts.js'
import { createGatewayLogger } from '../src/logging.js'
import { QQCredentialCheckError } from '../src/qq/token.js'
import type { ChannelHealthState, CoreState } from '../src/core/lifecycle.js'

/**
 * channel 管理路由测试：真实 store（临时 workspace）+ 真实 ChannelManager + 假凭证校验器
 * 与假渠道工厂（无真实网络、无 QQ SDK）。断言经 handler 函数返回值（HTTP 分派层在
 * core.test.ts 覆盖）；appSecret 不得出现在响应与日志中。
 */

interface LogLine {
  event: string
  [key: string]: unknown
}

interface FakeChannelRecord {
  appId: string
  appSecret: string
  startCalls: number
  stopCalls: number
  failStart: boolean
  /** start 成功后把实例置为该状态（模拟注册 + setState）。 */
  afterStartState: ChannelHealthState | 'none'
}

interface Harness {
  store: GatewayConfigStore
  admin: ReturnType<typeof createAdminRoutes>
  /** 每次工厂调用（= 每个渠道实例）一条记录，按创建顺序排列。 */
  records: FakeChannelRecord[]
  /** 每个 appId 的最新实例记录。 */
  channels: Map<string, FakeChannelRecord>
  stateMap: Map<string, ChannelHealthState>
  failAppIds: Set<string>
  validate: ReturnType<typeof vi.fn>
  logs: LogLine[]
  configPath: string
  workspace: string
  coreState: { value: CoreState }
  add(body: unknown): Promise<AdminReply>
  enable(body: unknown): Promise<AdminReply>
  call(path: string, body: unknown): Promise<AdminReply | undefined>
}

let tempRoots: string[] = []

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gw-admin-'))
  tempRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function writeInitialConfig(workspace: string, instances: QQChannelInstance[]): string {
  const configPath = join(workspace, GATEWAY_CONFIG_FILENAME)
  mkdirSync(workspace, { recursive: true })
  writeFileSync(
    configPath,
    `${JSON.stringify({ schemaVersion: 2, channels: { qq: instances } }, null, 2)}\n`,
    'utf8',
  )
  return configPath
}

/** 实例描述允许省略 enabled（默认 true）。 */
type InstanceInput = QQChannelInstance | { appId: string; appSecret: string }

function normalizeInstances(instances: readonly InstanceInput[]): QQChannelInstance[] {
  return instances.map((instance) =>
    'enabled' in instance
      ? { appId: instance.appId, appSecret: instance.appSecret, enabled: instance.enabled }
      : { appId: instance.appId, appSecret: instance.appSecret, enabled: true },
  )
}

function makeHarness(
  instances: readonly InstanceInput[],
  options?: {
    validateImpl?: (appId: string, appSecret: string) => Promise<void>
    coreState?: CoreState
    settleMs?: number
    /** 工厂 start 成功后把实例置为该状态；'none' 表示不写状态（保持 connecting 等）。 */
    startState?: ChannelHealthState | 'none'
  },
): Harness {
  const root = makeTempRoot()
  const workspace = join(root, 'workspace')
  const dshHome = join(root, 'dsh-home')
  const configPath = writeInitialConfig(workspace, normalizeInstances(instances))
  const store = loadGatewayConfigStore({ workspaceDir: workspace, dshHome })

  const logs: LogLine[] = []
  const logger = createGatewayLogger({ debug: false, sink: (line) => logs.push(JSON.parse(line) as LogLine) })

  const records: FakeChannelRecord[] = []
  const channels = new Map<string, FakeChannelRecord>()
  const stateMap = new Map<string, ChannelHealthState>()
  const failAppIds = new Set<string>()
  const afterStartState: ChannelHealthState | 'none' = options?.startState ?? 'online'
  const factory = (opts: { appId: string; appSecret: string }): { start(): Promise<void>; stop(): Promise<void> } => {
    const record: FakeChannelRecord = {
      appId: opts.appId,
      appSecret: opts.appSecret,
      startCalls: 0,
      stopCalls: 0,
      failStart: failAppIds.has(opts.appId),
      afterStartState,
    }
    records.push(record)
    channels.set(opts.appId, record)
    return {
      start: async () => {
        const record = channels.get(opts.appId)!
        record.startCalls += 1
        if (record.failStart) {
          throw new Error('registration rejected')
        }
        if (record.afterStartState !== 'none') {
          stateMap.set(opts.appId, record.afterStartState)
        }
      },
      stop: async () => {
        const record = channels.get(opts.appId)!
        record.stopCalls += 1
        stateMap.delete(opts.appId)
      },
    }
  }

  const manager = createChannelManager({
    core: {} as GatewayCore,
    logger,
    limits: { ...GATEWAY_LIMITS },
    factory,
    instances: store.config.qqInstances,
    channelState: (appId) => stateMap.get(appId),
    settleMs: options?.settleMs ?? 0,
  })

  const validate = vi.fn(options?.validateImpl ?? (async () => undefined))
  const coreState = { value: options?.coreState ?? ('ready' as CoreState) }
  const admin = createAdminRoutes({
    logger,
    store,
    manager,
    validateQQCredentials: validate as unknown as (appId: string, appSecret: string) => Promise<void>,
    coreState: () => coreState.value,
  })

  return {
    store,
    admin,
    records,
    channels,
    stateMap,
    failAppIds,
    validate,
    logs,
    configPath,
    workspace,
    coreState,
    add: (body) => admin('/channels/qq', body) as Promise<AdminReply>,
    enable: (body) => admin('/channels/qq/enable', body) as Promise<AdminReply>,
    call: (path, body) => admin(path, body),
  }
}

function readConfigOnDisk(configPath: string): GatewayConfigFile {
  return JSON.parse(readFileSync(configPath, 'utf8')) as GatewayConfigFile
}

describe('admin routes: unknown paths', () => {
  it('returns undefined for paths outside the two managed routes', async () => {
    const h = makeHarness([])
    expect(await h.call('/channels/weixin', {})).toBeUndefined()
    expect(await h.call('/channels', {})).toBeUndefined()
    expect(await h.call('/livez', {})).toBeUndefined()
  })
})

describe('POST /channels/qq (add)', () => {
  it('validates, persists, and starts a new instance', async () => {
    const h = makeHarness([])

    const reply = await h.add({ appId: 'app-1', appSecret: 'secret-1' })

    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({ ok: true, channel: 'qq:app-1', state: 'online' })
    expect(h.validate).toHaveBeenCalledWith('app-1', 'secret-1')
    expect(h.channels.get('app-1')?.startCalls).toBe(1)
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual([
      { appId: 'app-1', appSecret: 'secret-1', enabled: true },
    ])
    expect(h.logs.some((line) => line.event === 'channel_added')).toBe(true)
  })

  it('rejects invalid shapes with 400 and does nothing', async () => {
    const h = makeHarness([])
    const cases: unknown[] = [
      'string',
      null,
      {},
      { appId: '' },
      { appId: '  ' },
      { appId: 'a'.repeat(129), appSecret: 's' },
      { appId: 'a', appSecret: '' },
      { appId: 'a', appSecret: 's'.repeat(257) },
      { appId: 'a', appSecret: 's', force: 'yes' },
      { appId: 'a', appSecret: 's', extra: true },
      { appId: 1, appSecret: 's' },
    ]
    for (const body of cases) {
      const reply = await h.add(body)
      expect(reply.status, JSON.stringify(body)).toBe(400)
      expect((reply.body as { error: { code: string } }).error.code).toBe('invalid_request')
    }
    expect(h.channels.size).toBe(0)
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual([])
  })

  it('returns 503 when the core is starting, with a retryable message', async () => {
    const h = makeHarness([], { coreState: 'starting' })
    const reply = await h.add({ appId: 'app-1', appSecret: 'secret-1' })
    expect(reply.status).toBe(503)
    expect((reply.body as { error: { code: string } }).error.code).toBe('gateway_not_ready')
    expect((reply.body as { error: { message: string } }).error.message).toContain('retry after startup')
    expect(h.channels.size).toBe(0)
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual([])
  })

  it('returns 503 with a manual-intervention message when the core has failed', async () => {
    const h = makeHarness([], { coreState: 'failed' })
    const reply = await h.add({ appId: 'app-1', appSecret: 'secret-1', force: true })
    expect(reply.status).toBe(503)
    expect((reply.body as { error: { message: string } }).error.message).toContain('has failed')
    expect((reply.body as { error: { message: string } }).error.message).toContain('restart')
    // stopping/stopped 同为关机文案，不提示重试。
    h.coreState.value = 'stopping'
    const stopping = await h.add({ appId: 'app-1', appSecret: 'secret-1', force: true })
    expect(stopping.status).toBe(503)
    const message = (stopping.body as { error: { message: string } }).error.message
    expect(message).toContain('shutting down')
    expect(message).not.toContain('retry')
    expect(h.channels.size).toBe(0)
  })

  it('rejects an appId with characters outside [A-Za-z0-9-] with 400 and does nothing', async () => {
    const h = makeHarness([])
    for (const appId of ['bad_app', 'app.id', '应用', 'app id']) {
      const reply = await h.add({ appId, appSecret: 'secret-1', force: true })
      expect(reply.status, appId).toBe(400)
      const error = (reply.body as { error: { code: string; message: string } }).error
      expect(error.code).toBe('invalid_request')
      expect(error.message).toContain('[A-Za-z0-9-]')
    }
    expect(h.channels.size).toBe(0)
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual([])
  })

  it('returns 422 on platform rejection without writing config or starting the instance', async () => {
    const h = makeHarness([], {
      validateImpl: async () => {
        throw new QQCredentialCheckError('rejected', 'QQ token endpoint rejected the credentials: HTTP 401')
      },
    })

    const reply = await h.add({ appId: 'app-1', appSecret: 'secret-1' })

    expect(reply.status).toBe(422)
    const error = (reply.body as { error: { code: string; message: string } }).error
    expect(error.code).toBe('credential_validation_failed')
    expect(error.message).toContain('HTTP 401')
    expect(JSON.stringify(reply.body)).not.toContain('secret-1')
    expect(h.channels.size).toBe(0)
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual([])
  })

  it('returns 422 with a --force hint on network failures', async () => {
    const h = makeHarness([], {
      validateImpl: async () => {
        throw new QQCredentialCheckError('network', 'QQ token endpoint timed out after 10000ms')
      },
    })

    const reply = await h.add({ appId: 'app-1', appSecret: 'secret-1' })

    expect(reply.status).toBe(422)
    expect((reply.body as { error: { message: string } }).error.message).toContain('--force')
  })

  it('skips validation with force and still saves + starts the instance', async () => {
    const h = makeHarness([], {
      validateImpl: async () => {
        throw new Error('validator must not be called under force')
      },
    })

    const reply = await h.add({ appId: 'app-1', appSecret: 'secret-1', force: true })

    expect(h.validate).not.toHaveBeenCalled()
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({ ok: true, channel: 'qq:app-1', state: 'online' })
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual([
      { appId: 'app-1', appSecret: 'secret-1', enabled: true },
    ])
  })

  it('force + start failure keeps credentials saved and reports state blocked with detail', async () => {
    const h = makeHarness([])
    h.validate.mockImplementation(async () => {
      throw new Error('validator must not be called under force')
    })

    const first = await h.add({ appId: 'app-1', appSecret: 'secret-1', force: true })
    expect(first.body).toMatchObject({ state: 'online' })

    // 第二次 add 同 appId：更新 secret 后重启实例，这次启动失败 → blocked + detail。
    h.failAppIds.add('app-1')
    const reply = await h.add({ appId: 'app-1', appSecret: 'secret-2', force: true })

    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ ok: true, channel: 'qq:app-1', state: 'blocked' })
    expect((reply.body as { detail?: string }).detail).toContain('credentials were saved')
    expect(JSON.stringify(reply.body)).not.toContain('secret-2')
    // 凭证已更新保存。
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual([
      { appId: 'app-1', appSecret: 'secret-2', enabled: true },
    ])
  })

  it('duplicate add updates the secret, restarts the instance, and keeps enabled', async () => {
    const h = makeHarness([{ appId: 'app-1', appSecret: 'old-secret', enabled: false }])

    const reply = await h.add({ appId: 'app-1', appSecret: 'new-secret' })

    expect(reply.status).toBe(200)
    const record = h.channels.get('app-1')!
    expect(record.startCalls).toBe(1)
    expect(record.appSecret).toBe('new-secret')
    // enabled 保留原值 false。
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual([
      { appId: 'app-1', appSecret: 'new-secret', enabled: false },
    ])
  })

  it('restarts a running instance on duplicate add (stop old, start new)', async () => {
    const h = makeHarness([{ appId: 'app-1', appSecret: 'old-secret' }])
    await h.add({ appId: 'app-1', appSecret: 'old-secret' })
    expect(h.records).toHaveLength(1)
    expect(h.records[0]!.startCalls).toBe(1)

    const reply = await h.add({ appId: 'app-1', appSecret: 'new-secret' })

    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({ ok: true, channel: 'qq:app-1', state: 'online' })
    // 旧实例被停止，新实例以新 secret 启动。
    expect(h.records).toHaveLength(2)
    expect(h.records[0]!.stopCalls).toBe(1)
    expect(h.records[1]!.stopCalls).toBe(0)
    expect(h.records[1]!.startCalls).toBe(1)
    expect(h.records[1]!.appSecret).toBe('new-secret')
  })

  it('returns 409 when the config file was modified externally', async () => {
    const h = makeHarness([])
    writeFileSync(
      h.configPath,
      `${JSON.stringify({ schemaVersion: 2, channels: { qq: [{ appId: 'external', appSecret: 'e', enabled: true }] } }, null, 2)}\n`,
      'utf8',
    )

    const reply = await h.add({ appId: 'app-1', appSecret: 'secret-1' })

    expect(reply.status).toBe(409)
    const error = (reply.body as { error: { code: string; message: string } }).error
    expect(error.code).toBe('config_modified_externally')
    expect(error.message).toContain('restart')
    // 校验先于持久化发生，但配置不被覆盖、实例不启动。
    expect(h.validate).toHaveBeenCalled()
    expect(h.channels.size).toBe(0)
    expect(readConfigOnDisk(h.configPath).channels.qq[0]!.appId).toBe('external')
  })

  it('never echoes the appSecret in responses or logs', async () => {
    const h = makeHarness([], {
      validateImpl: async () => {
        throw new QQCredentialCheckError('rejected', 'rejected by platform')
      },
    })
    await h.add({ appId: 'app-1', appSecret: 'top-secret-value' })
    const okHarness = makeHarness([])
    const okReply = await okHarness.add({ appId: 'app-1', appSecret: 'top-secret-value' })

    expect(JSON.stringify(okReply.body)).not.toContain('top-secret-value')
    expect(JSON.stringify(okHarness.logs)).not.toContain('top-secret-value')
    expect(JSON.stringify(h.logs)).not.toContain('top-secret-value')
  })

  it('serializes concurrent add requests: no 409 misreport, both instances persisted and started', async () => {
    const h = makeHarness([])

    const [first, second] = await Promise.all([
      h.add({ appId: 'app-1', appSecret: 'secret-1' }),
      h.add({ appId: 'app-2', appSecret: 'secret-2' }),
    ])

    // 内部并发不得被误报为外部修改（409）。
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    for (const reply of [first, second]) {
      expect(JSON.stringify(reply.body)).not.toContain('config_modified_externally')
    }
    // 最终配置包含两个实例，且都被启动。
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual(
      expect.arrayContaining([
        { appId: 'app-1', appSecret: 'secret-1', enabled: true },
        { appId: 'app-2', appSecret: 'secret-2', enabled: true },
      ]),
    )
    expect(h.channels.get('app-1')?.startCalls).toBe(1)
    expect(h.channels.get('app-2')?.startCalls).toBe(1)
  })

  it('waits for the instance to leave connecting within the settle window', async () => {
    // 工厂 start 后不写状态（保持预设的 connecting），100ms 后翻转为 online。
    const h = makeHarness([], { settleMs: 1_500, startState: 'none' })
    h.stateMap.set('app-1', 'connecting')
    const timer = setTimeout(() => h.stateMap.set('app-1', 'online'), 100)

    const reply = await h.add({ appId: 'app-1', appSecret: 'secret-1' })
    clearTimeout(timer)

    expect(reply.status).toBe(200)
    expect((reply.body as { state: string }).state).toBe('online')
  })

  it('并发重复 add 同 appId：最终运行实例用最后落盘的 secret（无陈旧窗口）', async () => {
    const h = makeHarness([])

    const [first, second] = await Promise.all([
      h.add({ appId: 'app-1', appSecret: 'secret-a', force: true }),
      h.add({ appId: 'app-1', appSecret: 'secret-b', force: true }),
    ])

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    // store 串行链按到达序落盘：最终磁盘是后一个请求的 secret。
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual([
      { appId: 'app-1', appSecret: 'secret-b', enabled: true },
    ])
    // 每个请求用各自"保存后文档"的 secret 启动，启动顺序与落盘顺序一致：
    // 最后一次构造（= 当前运行实例）恰为最后落盘的 secret。
    expect(h.records.filter((r) => r.appId === 'app-1').map((r) => r.appSecret)).toEqual([
      'secret-a',
      'secret-b',
    ])
    const running = h.channels.get('app-1')!
    expect(running.startCalls).toBe(1)
    expect(running.appSecret).toBe('secret-b')
  })
})

describe('POST /channels/qq/enable (enable)', () => {
  it('resolves the single configured instance when appId is omitted', async () => {
    const h = makeHarness([{ appId: 'app-1', appSecret: 'secret-1', enabled: false }])

    const reply = await h.enable({})

    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({ ok: true, channel: 'qq:app-1', state: 'online' })
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual([
      { appId: 'app-1', appSecret: 'secret-1', enabled: true },
    ])
    expect(h.channels.get('app-1')?.startCalls).toBe(1)
    expect(h.logs.some((line) => line.event === 'channel_enabled')).toBe(true)
  })

  it('requires appId when zero or multiple instances are configured', async () => {
    const zero = makeHarness([])
    const zeroReply = await zero.enable({})
    expect(zeroReply.status).toBe(400)
    expect((zeroReply.body as { error: { code: string } }).error.code).toBe('app_id_required')

    const multi = makeHarness([
      { appId: 'app-1', appSecret: 's1', enabled: false },
      { appId: 'app-2', appSecret: 's2', enabled: false },
    ])
    const multiReply = await multi.enable({})
    expect(multiReply.status).toBe(400)
    expect((multiReply.body as { error: { code: string } }).error.code).toBe('app_id_required')
    expect(multi.channels.size).toBe(0)
  })

  it('returns 404 for an appId missing from the config', async () => {
    const h = makeHarness([{ appId: 'app-1', appSecret: 's', enabled: false }])
    const reply = await h.enable({ appId: 'missing-app' })
    expect(reply.status).toBe(404)
    expect((reply.body as { error: { code: string } }).error.code).toBe('instance_not_found')
  })

  it('is idempotent for an already-online instance without restarting it', async () => {
    const h = makeHarness([{ appId: 'app-1', appSecret: 's' }])
    // 冷启动等价：先经 enable 拉起一次。
    await h.enable({ appId: 'app-1' })
    expect(h.channels.get('app-1')?.startCalls).toBe(1)

    const reply = await h.enable({ appId: 'app-1' })

    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({ ok: true, channel: 'qq:app-1', state: 'online' })
    expect(h.channels.get('app-1')?.startCalls).toBe(1)
  })

  it('retries a blocked instance by replacing it (manual_restart_required 的 enable 重跑)', async () => {
    const h = makeHarness([{ appId: 'app-1', appSecret: 's' }])
    // 第一次启动失败（blocked）。
    h.failAppIds.add('app-1')
    const first = await h.enable({ appId: 'app-1' })
    expect(first.body).toMatchObject({ ok: true, state: 'blocked' })

    // 修复后重跑 enable：新实例启动成功。
    h.failAppIds.delete('app-1')
    const second = await h.enable({ appId: 'app-1' })
    expect(second.status).toBe(200)
    expect(second.body).toEqual({ ok: true, channel: 'qq:app-1', state: 'online' })
  })

  it('rejects invalid bodies with 400 and returns 503 when not ready', async () => {
    const notReady = makeHarness([{ appId: 'app-1', appSecret: 's' }], { coreState: 'starting' })
    const notReadyReply = await notReady.enable({ appId: 'app-1' })
    expect(notReadyReply.status).toBe(503)

    const h = makeHarness([{ appId: 'app-1', appSecret: 's' }])
    for (const body of ['x', null, { appId: '' }, { appId: 'a', extra: 1 }]) {
      const reply = await h.enable(body)
      expect(reply.status, JSON.stringify(body)).toBe(400)
    }
  })

  it('returns 409 on external config drift', async () => {
    const h = makeHarness([{ appId: 'app-1', appSecret: 's', enabled: false }])
    writeFileSync(h.configPath, `${JSON.stringify({ schemaVersion: 2, channels: { qq: [] } }, null, 2)}\n`, 'utf8')

    const reply = await h.enable({ appId: 'app-1' })

    expect(reply.status).toBe(409)
    expect(h.channels.size).toBe(0)
  })

  it('leaves no temp files after saves', async () => {
    const h = makeHarness([])
    await h.add({ appId: 'app-1', appSecret: 'secret-1' })
    expect(existsSync(join(h.workspace, `${GATEWAY_CONFIG_FILENAME}.tmp`))).toBe(false)
    expect(readdirSync(h.workspace).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
