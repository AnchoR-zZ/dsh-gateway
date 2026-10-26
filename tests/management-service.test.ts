import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createChannelManager } from '../src/channels/manager.js'
import type { ChannelManager } from '../src/channels/manager.js'
import { QQCredentialCheckError } from '../src/channels/qq/token.js'
import { GATEWAY_LIMITS } from '../src/contracts.js'
import type { GatewayCore } from '../src/contracts.js'
import { GatewayConfigError } from '../src/config/schema.js'
import type { GatewayConfigFile, QQChannelInstance } from '../src/config/schema.js'
import { GATEWAY_CONFIG_FILENAME, loadGatewayConfigStore } from '../src/config/store.js'
import type { GatewayConfigStore } from '../src/config/store.js'
import type { ChannelState, CoreQueries, CoreState } from '../src/core/contracts.js'
import { createGatewayLogger } from '../src/logging.js'
import { ManagementError } from '../src/management/contracts.js'
import type { ChannelChangeResult } from '../src/management/contracts.js'
import { createManagementService } from '../src/management/service.js'
import type { ManagementService } from '../src/management/service.js'
import { createStatusProjection } from '../src/management/status.js'

/**
 * 管理服务测试：真实 ConfigStore（临时 workspace）+ 真实 ChannelManager + 假凭证校验器、
 * 假渠道工厂与假 core 查询（无真实网络、无 QQ SDK）。断言 `ManagementError.code` 与变更
 * 结果对象（HTTP 映射由 http.test.ts 覆盖）；appSecret 不得出现在结果与日志中。
 *
 * 覆盖 add/enable 全部既有行为，以及新增停机闸门：入口拒绝、凭证校验期间停机、
 * 写队列执行前停机、配置已保存后停机（保留配置但不启动实例）与 `settle` 有界等待。
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
  afterStartState: ChannelState | 'none'
}

interface Harness {
  store: GatewayConfigStore
  manager: ChannelManager
  service: ManagementService
  /** 每次工厂调用（= 每个渠道实例）一条记录，按创建顺序排列。 */
  records: FakeChannelRecord[]
  /** 每个 appId 的最新实例记录。 */
  channels: Map<string, FakeChannelRecord>
  stateMap: Map<string, ChannelState>
  failAppIds: Set<string>
  validate: ReturnType<typeof vi.fn>
  logs: LogLine[]
  configPath: string
  workspace: string
  coreState: { value: CoreState }
  add(body: unknown): Promise<ChannelChangeResult>
  enable(body: unknown): Promise<ChannelChangeResult>
}

let tempRoots: string[] = []

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gw-management-'))
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

function readConfigOnDisk(configPath: string): GatewayConfigFile {
  return JSON.parse(readFileSync(configPath, 'utf8')) as GatewayConfigFile
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason?: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitFor(condition: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor: condition not met within timeout')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** 断言操作以 `ManagementError` 拒绝并返回该错误；成功或错误类型不符都让测试失败。 */
async function captureManagementError(operation: Promise<unknown>): Promise<ManagementError> {
  try {
    await operation
  } catch (err) {
    expect(err).toBeInstanceOf(ManagementError)
    return err as ManagementError
  }
  throw new Error('expected the operation to reject with ManagementError')
}

function makeHarness(
  instances: readonly InstanceInput[],
  options?: {
    validateImpl?: (appId: string, appSecret: string) => Promise<void>
    coreState?: CoreState
    settleMs?: number
    /** 工厂 start 成功后把实例置为该状态；'none' 表示不写状态（保持 connecting 等）。 */
    startState?: ChannelState | 'none'
    /** 工厂 start 抛错的说明生成器（用实例 secret 构造，验证详情脱敏）。 */
    startError?: (appSecret: string) => Error
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
  const stateMap = new Map<string, ChannelState>()
  const failAppIds = new Set<string>()
  const afterStartState: ChannelState | 'none' = options?.startState ?? 'online'
  const startError = options?.startError
  const factory = (opts: { appId: string; appSecret: string }): { start(): Promise<void>; stop(): Promise<void> } => {
    const record: FakeChannelRecord = {
      appId: opts.appId,
      appSecret: opts.appSecret,
      startCalls: 0,
      stopCalls: 0,
      failStart: failAppIds.has(opts.appId) || startError !== undefined,
      afterStartState,
    }
    records.push(record)
    channels.set(opts.appId, record)
    return {
      start: async () => {
        const current = channels.get(opts.appId)!
        current.startCalls += 1
        if (current.failStart) {
          throw startError?.(opts.appSecret) ?? new Error('registration rejected')
        }
        if (current.afterStartState !== 'none') {
          stateMap.set(opts.appId, current.afterStartState)
        }
      },
      stop: async () => {
        const current = channels.get(opts.appId)!
        current.stopCalls += 1
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
  // 假 core 查询：只暴露已注册渠道的运行状态（注册等价于工厂 start 成功后写入 stateMap）。
  const queries: CoreQueries = {
    snapshot: () => ({
      state: coreState.value,
      stateStoreFailed: false,
      startedAt: coreState.value === 'ready' ? '2026-10-01T00:00:00.000Z' : '',
      pending: 0,
      running: 0,
      channels: [...stateMap.entries()].map(([appId, state]) => ({
        channelId: 'qq',
        accountId: appId,
        state,
      })),
    }),
  }
  const status = createStatusProjection({ queries, currentQQInstances: () => store.file.channels.qq })

  const service = createManagementService({
    logger,
    store,
    manager,
    status,
    validateQQCredentials: validate as unknown as (appId: string, appSecret: string) => Promise<void>,
    coreState: () => coreState.value,
  })

  return {
    store,
    manager,
    service,
    records,
    channels,
    stateMap,
    failAppIds,
    validate,
    logs,
    configPath,
    workspace,
    coreState,
    add: (body) => service.addQQ(body),
    enable: (body) => service.enableQQ(body),
  }
}

describe('management service: addQQ', () => {
  it('validates, persists, and starts a new instance', async () => {
    const h = makeHarness([])

    const result = await h.add({ appId: 'app-1', appSecret: 'secret-1' })

    expect(result).toEqual({ channel: 'qq:app-1', saved: true, state: 'online' })
    expect(h.validate).toHaveBeenCalledWith('app-1', 'secret-1')
    expect(h.channels.get('app-1')?.startCalls).toBe(1)
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual([
      { appId: 'app-1', appSecret: 'secret-1', enabled: true },
    ])
    expect(h.logs.some((line) => line.event === 'channel_added')).toBe(true)
  })

  it('rejects invalid shapes with invalid_request and does nothing', async () => {
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
      const error = await captureManagementError(h.add(body))
      expect(error.code, JSON.stringify(body)).toBe('invalid_request')
      expect(error.message.length).toBeGreaterThan(0)
    }
    expect(h.records).toHaveLength(0)
    expect(h.channels.size).toBe(0)
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual([])
  })

  it('rejects gateway_not_ready with a retryable message while the core is starting', async () => {
    const h = makeHarness([], { coreState: 'starting' })
    const error = await captureManagementError(h.add({ appId: 'app-1', appSecret: 'secret-1' }))
    expect(error.code).toBe('gateway_not_ready')
    expect(error.message).toContain('retry after startup')
    expect(h.channels.size).toBe(0)
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual([])
  })

  it('rejects gateway_not_ready with a manual-intervention message when the core has failed', async () => {
    const h = makeHarness([], { coreState: 'failed' })
    const error = await captureManagementError(
      h.add({ appId: 'app-1', appSecret: 'secret-1', force: true }),
    )
    expect(error.code).toBe('gateway_not_ready')
    expect(error.message).toContain('has failed')
    expect(error.message).toContain('restart')
    // stopping/stopped 同为关机文案，不提示重试。
    h.coreState.value = 'stopping'
    const stopping = await captureManagementError(
      h.add({ appId: 'app-1', appSecret: 'secret-1', force: true }),
    )
    expect(stopping.code).toBe('gateway_not_ready')
    expect(stopping.message).toContain('shutting down')
    expect(stopping.message).not.toContain('retry')
    expect(h.channels.size).toBe(0)
  })

  it('rejects an appId with characters outside [A-Za-z0-9-] and does nothing', async () => {
    const h = makeHarness([])
    for (const appId of ['bad_app', 'app.id', '应用', 'app id']) {
      const error = await captureManagementError(h.add({ appId, appSecret: 'secret-1', force: true }))
      expect(error.code, appId).toBe('invalid_request')
      expect(error.message).toContain('[A-Za-z0-9-]')
    }
    expect(h.records).toHaveLength(0)
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual([])
  })

  it('rejects credential_validation_failed on platform rejection without writing config', async () => {
    const h = makeHarness([], {
      validateImpl: async () => {
        throw new QQCredentialCheckError('rejected', 'QQ token endpoint rejected the credentials: HTTP 401')
      },
    })

    const error = await captureManagementError(h.add({ appId: 'app-1', appSecret: 'secret-1' }))

    expect(error.code).toBe('credential_validation_failed')
    // token 模块已自行脱敏 message：原样返回，保留 "HTTP 401" 等可读信息（不额外 redact）。
    expect(error.message).toBe('QQ token endpoint rejected the credentials: HTTP 401')
    expect(error.message).not.toContain('secret-1')
    expect(h.records).toHaveLength(0)
    expect(h.channels.size).toBe(0)
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual([])
  })

  it('rejects credential_validation_failed with a force hint on network failures', async () => {
    const h = makeHarness([], {
      validateImpl: async () => {
        throw new QQCredentialCheckError('network', 'QQ token endpoint timed out after 10000ms')
      },
    })

    const error = await captureManagementError(h.add({ appId: 'app-1', appSecret: 'secret-1' }))

    expect(error.code).toBe('credential_validation_failed')
    expect(error.message).toContain('QQ token endpoint timed out after 10000ms')
    expect(error.message).toContain('"force": true')
  })

  it('wraps unexpected validator errors as credential_validation_failed with a redacted message', async () => {
    const h = makeHarness([], {
      validateImpl: async () => {
        throw new Error('boom secret=top-secret-value')
      },
    })

    const error = await captureManagementError(h.add({ appId: 'app-1', appSecret: 'top-secret-value' }))

    expect(error.code).toBe('credential_validation_failed')
    expect(error.message).not.toContain('top-secret-value')
  })

  it('skips validation with force and still saves + starts the instance', async () => {
    const h = makeHarness([], {
      validateImpl: async () => {
        throw new Error('validator must not be called under force')
      },
    })

    const result = await h.add({ appId: 'app-1', appSecret: 'secret-1', force: true })

    expect(h.validate).not.toHaveBeenCalled()
    expect(result).toEqual({ channel: 'qq:app-1', saved: true, state: 'online' })
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual([
      { appId: 'app-1', appSecret: 'secret-1', enabled: true },
    ])
  })

  it('force + start failure keeps credentials saved and reports blocked with detail', async () => {
    const h = makeHarness([])
    const first = await h.add({ appId: 'app-1', appSecret: 'secret-1', force: true })
    expect(first.state).toBe('online')

    // 第二次 add 同 appId：更新 secret 后重启实例，这次启动失败 → blocked + detail。
    h.failAppIds.add('app-1')
    const result = await h.add({ appId: 'app-1', appSecret: 'secret-2', force: true })

    expect(result.saved).toBe(true)
    expect(result.state).toBe('blocked')
    expect(result.detail).toContain('credentials were saved')
    expect(JSON.stringify(result)).not.toContain('secret-2')
    // 凭证已更新保存。
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual([
      { appId: 'app-1', appSecret: 'secret-2', enabled: true },
    ])
  })

  it('duplicate add updates the secret, restarts the instance, and keeps enabled', async () => {
    const h = makeHarness([{ appId: 'app-1', appSecret: 'old-secret', enabled: false }])

    const result = await h.add({ appId: 'app-1', appSecret: 'new-secret' })

    expect(result).toEqual({ channel: 'qq:app-1', saved: true, state: 'online' })
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

    const result = await h.add({ appId: 'app-1', appSecret: 'new-secret' })

    expect(result).toEqual({ channel: 'qq:app-1', saved: true, state: 'online' })
    // 旧实例被停止，新实例以新 secret 启动。
    expect(h.records).toHaveLength(2)
    expect(h.records[0]!.stopCalls).toBe(1)
    expect(h.records[1]!.stopCalls).toBe(0)
    expect(h.records[1]!.startCalls).toBe(1)
    expect(h.records[1]!.appSecret).toBe('new-secret')
  })

  it('rejects config_modified_externally when the config file was modified externally', async () => {
    const h = makeHarness([])
    writeFileSync(
      h.configPath,
      `${JSON.stringify({ schemaVersion: 2, channels: { qq: [{ appId: 'external', appSecret: 'e', enabled: true }] } }, null, 2)}\n`,
      'utf8',
    )

    const error = await captureManagementError(h.add({ appId: 'app-1', appSecret: 'secret-1' }))

    expect(error.code).toBe('config_modified_externally')
    expect(error.message).toContain('restart')
    // 校验先于持久化发生，但配置不被覆盖、实例不启动。
    expect(h.validate).toHaveBeenCalled()
    expect(h.records).toHaveLength(0)
    expect(readConfigOnDisk(h.configPath).channels.qq[0]!.appId).toBe('external')
  })

  it('never echoes the appSecret in unexpected-error messages, details, or logs', async () => {
    const secret = 'top-secret-value'

    // 非预期异常（非 QQCredentialCheckError）：走 redact 分支，原始 secret 不得进入 message。
    const rejecting = makeHarness([], {
      validateImpl: async () => {
        throw new Error(`validator blew up; appSecret=${secret}`)
      },
    })
    const rejected = await captureManagementError(rejecting.add({ appId: 'app-1', appSecret: secret }))
    expect(rejected.code).toBe('credential_validation_failed')
    expect(rejected.message).not.toContain(secret)
    expect(rejected.message).toContain('[REDACTED]')

    // 渠道启动失败详情携带 secret：detail 走 redact，日志字段同样脱敏。
    const failing = makeHarness([], {
      startError: (appSecret) => new Error(`login failed secret=${appSecret}`),
    })
    const blocked = await failing.add({ appId: 'app-1', appSecret: secret, force: true })
    expect(blocked.state).toBe('blocked')
    expect(blocked.detail).toBeDefined()
    expect(blocked.detail).not.toContain(secret)
    expect(blocked.detail).toContain('[REDACTED]')

    // 成功路径：结果对象与日志都不含原始 secret。
    const okHarness = makeHarness([])
    const ok = await okHarness.add({ appId: 'app-1', appSecret: secret })
    expect(ok.state).toBe('online')
    expect(JSON.stringify(ok)).not.toContain(secret)

    for (const logs of [rejecting.logs, failing.logs, okHarness.logs]) {
      expect(JSON.stringify(logs)).not.toContain(secret)
    }
  })

  it('serializes concurrent add requests: no false conflict, both instances persisted and started', async () => {
    const h = makeHarness([])

    const [first, second] = await Promise.all([
      h.add({ appId: 'app-1', appSecret: 'secret-1' }),
      h.add({ appId: 'app-2', appSecret: 'secret-2' }),
    ])

    // 内部并发不得被误报为外部修改（config_modified_externally）。
    expect(first.saved).toBe(true)
    expect(second.saved).toBe(true)
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

    const result = await h.add({ appId: 'app-1', appSecret: 'secret-1' })
    clearTimeout(timer)

    expect(result.state).toBe('online')
  })

  it('并发重复 add 同 appId：最终运行实例用最后落盘的 secret（无陈旧窗口）', async () => {
    const h = makeHarness([])

    const [first, second] = await Promise.all([
      h.add({ appId: 'app-1', appSecret: 'secret-a', force: true }),
      h.add({ appId: 'app-1', appSecret: 'secret-b', force: true }),
    ])

    expect(first.saved).toBe(true)
    expect(second.saved).toBe(true)
    // store 串行链按到达序落盘：最终磁盘是后一个请求的 secret。
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual([
      { appId: 'app-1', appSecret: 'secret-b', enabled: true },
    ])
    // 每个请求用各自"保存后文档"的 secret 启动，启动顺序与落盘顺序一致：
    // 最后一次构造（= 当前运行实例）恰为最后落盘的 secret。
    expect(h.records.filter((record) => record.appId === 'app-1').map((record) => record.appSecret)).toEqual([
      'secret-a',
      'secret-b',
    ])
    const running = h.channels.get('app-1')!
    expect(running.startCalls).toBe(1)
    expect(running.appSecret).toBe('secret-b')
  })

  it('配置写回失败 → config_write_failed，消息脱敏且不启动实例', async () => {
    const h = makeHarness([])
    const spy = vi
      .spyOn(h.store, 'update')
      .mockRejectedValueOnce(new GatewayConfigError('failed to write: secret=top-secret-value'))

    const error = await captureManagementError(
      h.add({ appId: 'app-1', appSecret: 'secret-1', force: true }),
    )

    expect(error.code).toBe('config_write_failed')
    expect(error.message).not.toContain('top-secret-value')
    expect(h.records).toHaveLength(0)
    spy.mockRestore()
  })
  it('leaves no temp files after saves', async () => {
    const h = makeHarness([])
    await h.add({ appId: 'app-1', appSecret: 'secret-1' })
    expect(existsSync(join(h.workspace, `${GATEWAY_CONFIG_FILENAME}.tmp`))).toBe(false)
    expect(readdirSync(h.workspace).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('management service: enableQQ', () => {
  it('resolves the single configured instance when appId is omitted', async () => {
    const h = makeHarness([{ appId: 'app-1', appSecret: 'secret-1', enabled: false }])

    const result = await h.enable({})

    expect(result).toEqual({ channel: 'qq:app-1', saved: true, state: 'online' })
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual([
      { appId: 'app-1', appSecret: 'secret-1', enabled: true },
    ])
    expect(h.channels.get('app-1')?.startCalls).toBe(1)
    expect(h.logs.some((line) => line.event === 'channel_enabled')).toBe(true)
  })

  it('requires appId when zero or multiple instances are configured', async () => {
    const zero = makeHarness([])
    expect((await captureManagementError(zero.enable({}))).code).toBe('app_id_required')

    const multi = makeHarness([
      { appId: 'app-1', appSecret: 's1', enabled: false },
      { appId: 'app-2', appSecret: 's2', enabled: false },
    ])
    const error = await captureManagementError(multi.enable({}))
    expect(error.code).toBe('app_id_required')
    expect(multi.channels.size).toBe(0)
  })

  it('rejects instance_not_found for an appId missing from the config', async () => {
    const h = makeHarness([{ appId: 'app-1', appSecret: 's', enabled: false }])
    const error = await captureManagementError(h.enable({ appId: 'missing-app' }))
    expect(error.code).toBe('instance_not_found')
    expect(error.message).toContain('missing-app')
  })

  it('is idempotent for an already-online instance without restarting it', async () => {
    const h = makeHarness([{ appId: 'app-1', appSecret: 's' }])
    // 冷启动等价：先经 enable 拉起一次。
    await h.enable({ appId: 'app-1' })
    expect(h.channels.get('app-1')?.startCalls).toBe(1)

    const result = await h.enable({ appId: 'app-1' })

    expect(result).toEqual({ channel: 'qq:app-1', saved: true, state: 'online' })
    expect(h.channels.get('app-1')?.startCalls).toBe(1)
  })

  it('retries a blocked instance by replacing it', async () => {
    const h = makeHarness([{ appId: 'app-1', appSecret: 's' }])
    // 第一次启动失败（blocked），detail 说明配置已保存。
    h.failAppIds.add('app-1')
    const first = await h.enable({ appId: 'app-1' })
    expect(first.state).toBe('blocked')
    expect(first.detail).toContain('enabled=true')

    // 修复后重跑 enable：新实例启动成功。
    h.failAppIds.delete('app-1')
    const second = await h.enable({ appId: 'app-1' })
    expect(second).toEqual({ channel: 'qq:app-1', saved: true, state: 'online' })
  })

  it('rejects invalid bodies and gateway_not_ready', async () => {
    const notReady = makeHarness([{ appId: 'app-1', appSecret: 's' }], { coreState: 'starting' })
    expect((await captureManagementError(notReady.enable({ appId: 'app-1' }))).code).toBe(
      'gateway_not_ready',
    )

    const h = makeHarness([{ appId: 'app-1', appSecret: 's' }])
    for (const body of ['x', null, { appId: '' }, { appId: 'a', extra: 1 }]) {
      const error = await captureManagementError(h.enable(body))
      expect(error.code, JSON.stringify(body)).toBe('invalid_request')
    }
  })

  it('rejects config_modified_externally on external config drift', async () => {
    const h = makeHarness([{ appId: 'app-1', appSecret: 's', enabled: false }])
    writeFileSync(
      h.configPath,
      `${JSON.stringify({ schemaVersion: 2, channels: { qq: [] } }, null, 2)}\n`,
      'utf8',
    )

    const error = await captureManagementError(h.enable({ appId: 'app-1' }))

    expect(error.code).toBe('config_modified_externally')
    expect(h.records).toHaveLength(0)
  })
})

describe('management service: shutdown gate', () => {
  it('rejects new management operations after beginShutdown with gateway_stopping', async () => {
    const h = makeHarness([{ appId: 'app-1', appSecret: 's', enabled: false }])
    h.service.beginShutdown()

    const addError = await captureManagementError(h.add({ appId: 'app-2', appSecret: 's2', force: true }))
    expect(addError.code).toBe('gateway_stopping')
    expect(addError.message).toContain('admin requests are not accepted during shutdown')

    const enableError = await captureManagementError(h.enable({ appId: 'app-1' }))
    expect(enableError.code).toBe('gateway_stopping')

    expect(h.records).toHaveLength(0)
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual([
      { appId: 'app-1', appSecret: 's', enabled: false },
    ])
  })

  it('停机竞态：凭证校验期间停机 → 校验返回后拒绝 gateway_stopping，配置未写、实例未创建', async () => {
    const gate = deferred<void>()
    const h = makeHarness([], { validateImpl: () => gate.promise })
    // 钉住"校验返回后、进入写队列前"的检查点：一旦进入写队列，store.update 必被调用。
    const updateSpy = vi.spyOn(h.store, 'update')

    const pending = h.add({ appId: 'app-1', appSecret: 'secret-1' })
    await waitFor(() => h.validate.mock.calls.length === 1)
    // 校验仍 pending 时开始停机。
    h.service.beginShutdown()
    gate.resolve()

    const error = await captureManagementError(pending)
    expect(error.code).toBe('gateway_stopping')
    expect(updateSpy).not.toHaveBeenCalled()
    expect(h.records).toHaveLength(0)
    expect(h.channels.size).toBe(0)
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual([])
    updateSpy.mockRestore()
  })

  it('停机竞态：校验挂起期间停机且校验随后失败 → gateway_stopping 而非 422，配置未写', async () => {
    const gate = deferred<void>()
    const h = makeHarness([], { validateImpl: () => gate.promise })

    const pending = h.add({ appId: 'app-1', appSecret: 'secret-1' })
    await waitFor(() => h.validate.mock.calls.length === 1)
    h.service.beginShutdown()
    gate.reject(new QQCredentialCheckError('rejected', 'QQ token endpoint rejected the credentials: HTTP 401'))

    const error = await captureManagementError(pending)
    expect(error.code).toBe('gateway_stopping')
    expect(error.message).toContain('admin requests are not accepted during shutdown')
    expect(h.records).toHaveLength(0)
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual([])
  })

  it('停机竞态：写队列执行前停机 → 两个排队 force add 均拒绝且配置未写', async () => {
    const h = makeHarness([])

    // 两个请求都已在 store 串行队列中等待落盘（force 跳过校验），此刻进入停机。
    const first = h.add({ appId: 'app-1', appSecret: 'secret-1', force: true })
    const second = h.add({ appId: 'app-2', appSecret: 'secret-2', force: true })
    h.service.beginShutdown()

    for (const pending of [first, second]) {
      const error = await captureManagementError(pending)
      expect(error.code).toBe('gateway_stopping')
    }
    expect(h.records).toHaveLength(0)
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual([])
  })

  it('保存后停机：配置保留、不启动实例，返回 saved:true + 当前状态与停机说明', async () => {
    const h = makeHarness([])
    const originalSync = h.manager.syncInstances.bind(h.manager)
    const syncSpy = vi.spyOn(h.manager, 'syncInstances').mockImplementation((instances) => {
      // 模拟"配置已保存"之后、启动实例之前进入停机。
      originalSync(instances)
      h.service.beginShutdown()
    })

    const result = await h.add({ appId: 'app-1', appSecret: 'secret-1', force: true })

    expect(result).toEqual({
      channel: 'qq:app-1',
      saved: true,
      state: 'blocked',
      detail: 'the gateway is shutting down; the configuration was saved but the instance was not started',
    })
    expect(h.records).toHaveLength(0)
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual([
      { appId: 'app-1', appSecret: 'secret-1', enabled: true },
    ])
    syncSpy.mockRestore()
  })

  it('保存后停机（enable）：配置保留、不启动实例', async () => {
    const h = makeHarness([{ appId: 'app-1', appSecret: 's', enabled: false }])
    const ensureSpy = vi.spyOn(h.manager, 'ensureOnline')
    const originalSync = h.manager.syncInstances.bind(h.manager)
    const syncSpy = vi.spyOn(h.manager, 'syncInstances').mockImplementation((instances) => {
      originalSync(instances)
      h.service.beginShutdown()
    })

    const result = await h.enable({ appId: 'app-1' })

    expect(result.saved).toBe(true)
    expect(result.state).toBe('blocked')
    expect(result.detail).toContain('configuration was saved but the instance was not started')
    expect(ensureSpy).not.toHaveBeenCalled()
    expect(readConfigOnDisk(h.configPath).channels.qq).toEqual([
      { appId: 'app-1', appSecret: 's', enabled: true },
    ])
    syncSpy.mockRestore()
    ensureSpy.mockRestore()
  })

  it('settle：无在途操作立即 true；在途操作超时 false，落定后 true', async () => {
    const gate = deferred<void>()
    const h = makeHarness([], { validateImpl: () => gate.promise })
    expect(await h.service.settle(0)).toBe(true)
    expect(await h.service.settle(50)).toBe(true)

    const pending = h.add({ appId: 'app-1', appSecret: 'secret-1' })
    await waitFor(() => h.validate.mock.calls.length === 1)
    h.service.beginShutdown()

    expect(await h.service.settle(20)).toBe(false)
    gate.resolve()
    await captureManagementError(pending)
    expect(await h.service.settle(500)).toBe(true)
  })

  it('getStatus 委托给注入的状态投影', async () => {
    const h = makeHarness([{ appId: 'app-1', appSecret: 's' }])
    const status = h.service.getStatus()
    expect(status.coreState).toBe('ready')
    expect(status.channels).toEqual([
      { channelId: 'qq', appId: 'app-1', configured: true, enabled: true, state: 'blocked' },
    ])
  })
})
