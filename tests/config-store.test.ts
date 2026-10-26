import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGatewayConfigTemplate, GatewayConfigError } from '../src/config/schema.js'
import type { GatewayConfigFile } from '../src/config/schema.js'
import {
  GATEWAY_CONFIG_FILENAME,
  GatewayConfigConflictError,
  loadGatewayConfigStore,
} from '../src/config/store.js'
import type { GatewayConfigStore } from '../src/config/store.js'

/**
 * 配置文件加载与热更新测试：模板创建（不再失败退出）、v2 加载、v1→v2 迁移写回与幂等、
 * 已有文件保护、原子保存与漂移拒绝。所有路径都在 mkdtempSync 临时根下，测试结束统一删除。
 */

const FULL_V2_CONFIG = {
  schemaVersion: 2,
  channels: {
    qq: [
      { appId: 'file-app-id', appSecret: 'file-app-secret', enabled: true },
      { appId: 'disabled-app', appSecret: 'disabled-secret', enabled: false },
    ],
  },
  debug: true,
  maxConcurrent: 7,
  maxPendingPerPeer: 2,
  maxPendingTotal: 40,
  maxPendingBytes: 4_096,
  idleAgentTtlMs: 120_000,
  maxLiveAgents: 9,
} as const

const FULL_V1_CONFIG = {
  schemaVersion: 1,
  qqAppId: 'legacy-app',
  qqAppSecret: 'legacy-secret',
  debug: true,
  maxConcurrent: 7,
  maxPendingPerPeer: 2,
  maxPendingTotal: 40,
  maxPendingBytes: 4_096,
  idleAgentTtlMs: 120_000,
  maxLiveAgents: 9,
} as const

/** 旧版首启模板形态：schemaVersion 1 + 双空凭证 + 其余字段（此处带非默认值验证携带）。 */
const BLANK_CREDENTIALS_V1_CONFIG = {
  schemaVersion: 1,
  qqAppId: '',
  qqAppSecret: '',
  debug: true,
  maxConcurrent: 7,
  maxPendingPerPeer: 2,
  maxPendingTotal: 40,
  maxPendingBytes: 4_096,
  idleAgentTtlMs: 120_000,
  maxLiveAgents: 9,
} as const

let tempRoots: string[] = []

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gateway-config-file-'))
  tempRoots.push(root)
  return root
}

interface Fixture {
  root: string
  workspace: string
  dshHome: string
  configPath: string
}

function makeFixture(): Fixture {
  const root = makeTempRoot()
  const workspace = join(root, 'workspace')
  return {
    root,
    workspace,
    dshHome: join(root, 'dsh-home'),
    configPath: join(workspace, GATEWAY_CONFIG_FILENAME),
  }
}

/** 写入配置文件（对象按 2 空格 JSON 序列化，字符串原样写入），返回最终文本。 */
function writeConfig(path: string, document: unknown): string {
  mkdirSync(dirname(path), { recursive: true })
  const text = typeof document === 'string' ? document : `${JSON.stringify(document, null, 2)}\n`
  writeFileSync(path, text, 'utf8')
  return text
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('loadGatewayConfigStore: template creation', () => {
  it('creates the workspace and v2 template on first start, then loads with zero instances', () => {
    const { workspace, dshHome, configPath } = makeFixture()
    expect(existsSync(workspace)).toBe(false)

    const store = loadGatewayConfigStore({ workspaceDir: workspace, dshHome })

    expect(store.createdTemplate).toBe(true)
    expect(store.migratedFromV1).toBe(false)
    expect(store.config.qqInstances).toEqual([])
    expect(existsSync(workspace)).toBe(true)
    expect(readFileSync(configPath, 'utf8')).toBe(createGatewayConfigTemplate())
  })
})

describe('loadGatewayConfigStore: existing v2 file', () => {
  it('loads instances with their enabled flags and derives stateDir/workspaceRoot', () => {
    const { workspace, dshHome, configPath } = makeFixture()
    const original = writeConfig(configPath, FULL_V2_CONFIG)

    const store = loadGatewayConfigStore({ workspaceDir: workspace, dshHome })

    expect(store.config.qqInstances).toEqual([
      { appId: 'file-app-id', appSecret: 'file-app-secret', enabled: true },
      { appId: 'disabled-app', appSecret: 'disabled-secret', enabled: false },
    ])
    expect(store.config.stateDir).toBe(join(workspace, 'state'))
    expect(store.config.workspaceRoot).toBe(join(workspace, 'users'))
    expect(store.config.maxConcurrent).toBe(7)
    expect('dshHome' in store.config).toBe(false)
    // 已有合法文件不被模板覆盖。
    expect(readFileSync(configPath, 'utf8')).toBe(original)
  })

  it('uses defaults for omitted optional fields', () => {
    const { workspace, dshHome, configPath } = makeFixture()
    writeConfig(configPath, {
      schemaVersion: 2,
      channels: { qq: [{ appId: 'file-app-id', appSecret: 'file-app-secret' }] },
    })

    const store = loadGatewayConfigStore({ workspaceDir: workspace, dshHome })

    expect(store.config.qqInstances).toEqual([
      { appId: 'file-app-id', appSecret: 'file-app-secret', enabled: true },
    ])
    expect(store.config).toMatchObject({
      debug: false,
      maxConcurrent: 4,
      maxPendingPerPeer: 3,
      maxPendingTotal: 100,
      maxPendingBytes: 8_388_608,
      idleAgentTtlMs: 900_000,
      maxLiveAgents: 32,
    })
  })

  it('keeps corrupted JSON, unknown fields, and invalid instances unchanged', () => {
    const cases: Array<{ document: unknown; pattern: RegExp }> = [
      { document: '{\n  "schemaVersion": 2,\n  "channels":', pattern: /invalid JSON/ },
      { document: { ...FULL_V2_CONFIG, extra: true }, pattern: /unknown field "extra"/ },
      {
        document: { schemaVersion: 2, channels: { qq: [{ appId: 'a', appSecret: '' }] } },
        pattern: /appSecret must be a non-empty string/,
      },
      {
        document: {
          schemaVersion: 2,
          channels: {
            qq: [
              { appId: 'a', appSecret: 's1' },
              { appId: 'a', appSecret: 's2' },
            ],
          },
        },
        pattern: /duplicate channels.qq appId/,
      },
      { document: { schemaVersion: 3 }, pattern: /unsupported version 3/ },
    ]
    for (const { document, pattern } of cases) {
      const { workspace, dshHome, configPath } = makeFixture()
      const original = writeConfig(configPath, document)
      expect(() => loadGatewayConfigStore({ workspaceDir: workspace, dshHome }), String(document)).toThrow(
        pattern,
      )
      expect(readFileSync(configPath, 'utf8')).toBe(original)
    }
  })
})

describe('loadGatewayConfigStore: v1 migration', () => {
  it('migrates a v1 file to v2, writes it back, and loads the migrated instance', () => {
    const { workspace, dshHome, configPath } = makeFixture()
    writeConfig(configPath, FULL_V1_CONFIG)

    const store = loadGatewayConfigStore({ workspaceDir: workspace, dshHome })

    expect(store.migratedFromV1).toBe(true)
    expect(store.createdTemplate).toBe(false)
    expect(store.config.qqInstances).toEqual([
      { appId: 'legacy-app', appSecret: 'legacy-secret', enabled: true },
    ])
    expect(store.config.debug).toBe(true)
    expect(store.config.maxConcurrent).toBe(7)
    // 磁盘已写回 v2 文档。
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as GatewayConfigFile
    expect(onDisk.schemaVersion).toBe(2)
    expect(onDisk.channels.qq).toEqual([{ appId: 'legacy-app', appSecret: 'legacy-secret', enabled: true }])
  })

  it('second load is idempotent: no migration flag, bytes unchanged', () => {
    const { workspace, dshHome, configPath } = makeFixture()
    writeConfig(configPath, FULL_V1_CONFIG)
    const first = loadGatewayConfigStore({ workspaceDir: workspace, dshHome })
    const migratedText = readFileSync(configPath, 'utf8')

    const second = loadGatewayConfigStore({ workspaceDir: workspace, dshHome })

    expect(second.migratedFromV1).toBe(false)
    expect(second.config).toEqual(first.config)
    expect(readFileSync(configPath, 'utf8')).toBe(migratedText)
  })

  it('migrates a v1 file with both credentials blank to v2 zero instances, then loads idempotently', () => {
    const { workspace, dshHome, configPath } = makeFixture()
    writeConfig(configPath, BLANK_CREDENTIALS_V1_CONFIG)

    const first = loadGatewayConfigStore({ workspaceDir: workspace, dshHome })

    expect(first.migratedFromV1).toBe(true)
    expect(first.createdTemplate).toBe(false)
    // 零实例启动，其余字段照常携带。
    expect(first.config.qqInstances).toEqual([])
    expect(first.config.debug).toBe(true)
    expect(first.config.maxConcurrent).toBe(7)
    // 磁盘已写回 v2 零实例文档。
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as GatewayConfigFile
    expect(onDisk.schemaVersion).toBe(2)
    expect(onDisk.channels.qq).toEqual([])
    const migratedText = readFileSync(configPath, 'utf8')

    const second = loadGatewayConfigStore({ workspaceDir: workspace, dshHome })

    expect(second.migratedFromV1).toBe(false)
    expect(second.config).toEqual(first.config)
    expect(readFileSync(configPath, 'utf8')).toBe(migratedText)
  })

  it('migrates a v1 file whose credentials are both whitespace-only after trim', () => {
    const { workspace, dshHome, configPath } = makeFixture()
    writeConfig(configPath, { ...BLANK_CREDENTIALS_V1_CONFIG, qqAppId: '  ', qqAppSecret: ' \t ' })

    const store = loadGatewayConfigStore({ workspaceDir: workspace, dshHome })

    expect(store.migratedFromV1).toBe(true)
    expect(store.config.qqInstances).toEqual([])
    expect((JSON.parse(readFileSync(configPath, 'utf8')) as GatewayConfigFile).channels.qq).toEqual([])
  })

  it('rejects an invalid v1 file without writing anything', () => {
    const { workspace, dshHome, configPath } = makeFixture()
    const original = writeConfig(configPath, { ...FULL_V1_CONFIG, qqAppSecret: '   ' })

    expect(() => loadGatewayConfigStore({ workspaceDir: workspace, dshHome })).toThrow(
      /qqAppSecret must be a non-empty string/,
    )
    expect(readFileSync(configPath, 'utf8')).toBe(original)
  })

  it('rejects a v1 file with exactly one blank credential in either direction, bytes unchanged', () => {
    // appId 有值、secret 为空（含 trim 后为空）。
    const blankSecret = makeFixture()
    const secretOriginal = writeConfig(blankSecret.configPath, {
      ...BLANK_CREDENTIALS_V1_CONFIG,
      qqAppId: 'legacy-app',
      qqAppSecret: '  ',
    })
    expect(() =>
      loadGatewayConfigStore({ workspaceDir: blankSecret.workspace, dshHome: blankSecret.dshHome }),
    ).toThrow(/qqAppSecret must be a non-empty string/)
    expect(readFileSync(blankSecret.configPath, 'utf8')).toBe(secretOriginal)

    // appId 为空、secret 有值。
    const blankAppId = makeFixture()
    const appIdOriginal = writeConfig(blankAppId.configPath, {
      ...BLANK_CREDENTIALS_V1_CONFIG,
      qqAppId: '',
      qqAppSecret: 'legacy-secret',
    })
    expect(() =>
      loadGatewayConfigStore({ workspaceDir: blankAppId.workspace, dshHome: blankAppId.dshHome }),
    ).toThrow(/qqAppId must be a non-empty string/)
    expect(readFileSync(blankAppId.configPath, 'utf8')).toBe(appIdOriginal)
  })
})

describe('loadGatewayConfigStore: workspace path validation', () => {
  it('rejects relative workspace and dsh home paths', () => {
    const absolute = join(makeTempRoot(), 'workspace')

    expect(() =>
      loadGatewayConfigStore({ workspaceDir: 'relative/workspace', dshHome: absolute }),
    ).toThrow(/gateway workspace must be an absolute path/)
    expect(() =>
      loadGatewayConfigStore({ workspaceDir: absolute, dshHome: 'relative/dsh-home' }),
    ).toThrow(/dsh home must be an absolute path/)
  })

  it('rejects overlapping workspace and dsh home', () => {
    const root = makeTempRoot()
    const dshHome = join(root, 'dsh-home')
    const workspace = join(dshHome, 'gateway')
    expect(() => loadGatewayConfigStore({ workspaceDir: workspace, dshHome })).toThrow(
      /must not overlap with dsh home/,
    )

    const root2 = makeTempRoot()
    const workspace2 = join(root2, 'workspace')
    expect(() =>
      loadGatewayConfigStore({ workspaceDir: workspace2, dshHome: join(workspace2, 'dsh-home') }),
    ).toThrow(/must not overlap with dsh home/)

    const same = join(makeTempRoot(), 'same')
    expect(() => loadGatewayConfigStore({ workspaceDir: same, dshHome: same })).toThrow(
      /must not overlap with dsh home/,
    )
  })

  it('allows sibling directories', () => {
    const { workspace, dshHome, configPath } = makeFixture()
    writeConfig(configPath, FULL_V2_CONFIG)
    expect(() => loadGatewayConfigStore({ workspaceDir: workspace, dshHome })).not.toThrow()
  })
})

describe('GatewayConfigStore.update: atomic save and drift detection', () => {
  it('persists a mutated document atomically and updates the snapshot', async () => {
    const { workspace, dshHome, configPath } = makeFixture()
    writeConfig(configPath, FULL_V2_CONFIG)
    const store = loadGatewayConfigStore({ workspaceDir: workspace, dshHome })

    const saved = await store.update((current) => ({
      ...current,
      channels: {
        ...current.channels,
        qq: [...current.channels.qq, { appId: 'new-app', appSecret: 'new-secret', enabled: true }],
      },
    }))

    expect(saved.channels.qq).toHaveLength(3)
    expect(store.file.channels.qq).toHaveLength(3)
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as GatewayConfigFile
    expect(onDisk.channels.qq.map((i) => i.appId)).toEqual([
      'file-app-id',
      'disabled-app',
      'new-app',
    ])
    // 原子写不留临时文件。
    expect(readdirSync(workspace).filter((name) => name.endsWith('.tmp'))).toEqual([])
    // 快照已更新：紧接的第二次保存不做漂移拒绝，且内容落盘。
    await store.update((current) => ({ ...current, debug: false }))
    expect((JSON.parse(readFileSync(configPath, 'utf8')) as GatewayConfigFile).debug).toBe(false)
  })

  it('rejects a save when the file was modified externally (409 path)', async () => {
    const { workspace, dshHome, configPath } = makeFixture()
    writeConfig(configPath, FULL_V2_CONFIG)
    const store = loadGatewayConfigStore({ workspaceDir: workspace, dshHome })

    writeConfig(configPath, {
      ...FULL_V2_CONFIG,
      channels: { qq: [{ appId: 'external-app', appSecret: 'external-secret', enabled: true }] },
    })

    await expect(store.update((current) => current)).rejects.toThrow(GatewayConfigConflictError)
    await expect(store.update((current) => current)).rejects.toThrow(/modified externally/)
    // 外部内容不被覆盖。
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as GatewayConfigFile
    expect(onDisk.channels.qq[0]!.appId).toBe('external-app')
  })

  it('rejects a mutation that produces an invalid document without writing', async () => {
    const { workspace, dshHome, configPath } = makeFixture()
    const original = writeConfig(configPath, FULL_V2_CONFIG)
    const store = loadGatewayConfigStore({ workspaceDir: workspace, dshHome })

    await expect(
      store.update(() => ({ schemaVersion: 3 } as unknown as GatewayConfigFile)),
    ).rejects.toThrow(GatewayConfigError)
    await expect(
      store.update((current) => ({ ...current, extra: true } as unknown as GatewayConfigFile)),
    ).rejects.toThrow(/unknown field "extra"/)
    expect(readFileSync(configPath, 'utf8')).toBe(original)
  })

  it('serializes concurrent updates: both land in order and neither is reported as drift', async () => {
    const { workspace, dshHome, configPath } = makeFixture()
    writeConfig(configPath, FULL_V2_CONFIG)
    const store = loadGatewayConfigStore({ workspaceDir: workspace, dshHome })

    const first = store.update((current) => ({
      ...current,
      channels: {
        ...current.channels,
        qq: [...current.channels.qq, { appId: 'concurrent-1', appSecret: 's1', enabled: true }],
      },
    }))
    const second = store.update((current) => ({
      ...current,
      channels: {
        ...current.channels,
        qq: [...current.channels.qq, { appId: 'concurrent-2', appSecret: 's2', enabled: true }],
      },
    }))
    const [savedFirst, savedSecond] = await Promise.all([first, second])

    // 串行链保证有序：第一次追加 concurrent-1 落盘，第二次基于其写回结果追加 concurrent-2；
    // Promise.all 未拒绝即两者都成功、无 GatewayConfigConflictError 漂移误报。
    expect(savedFirst.channels.qq.map((i) => i.appId)).toEqual([
      'file-app-id',
      'disabled-app',
      'concurrent-1',
    ])
    expect(savedSecond.channels.qq.map((i) => i.appId)).toEqual([
      'file-app-id',
      'disabled-app',
      'concurrent-1',
      'concurrent-2',
    ])
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as GatewayConfigFile
    expect(onDisk.channels.qq.map((i) => i.appId)).toEqual([
      'file-app-id',
      'disabled-app',
      'concurrent-1',
      'concurrent-2',
    ])
  })
})

describe('GatewayConfigStore store surface', () => {
  it('exposes configPath and workspaceDir', () => {
    const fixture = makeFixture()
    writeConfig(fixture.configPath, FULL_V2_CONFIG)
    const store: GatewayConfigStore = loadGatewayConfigStore({
      workspaceDir: fixture.workspace,
      dshHome: fixture.dshHome,
    })
    expect(store.configPath).toBe(fixture.configPath)
    expect(store.workspaceDir).toBe(fixture.workspace)
  })
})
