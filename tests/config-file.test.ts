import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGatewayConfigTemplate, GatewayConfigError } from '../src/config.js'
import { GATEWAY_CONFIG_FILENAME, loadGatewayConfig } from '../src/config-file.js'

/**
 * 配置文件加载测试：模板创建、已有文件保护、schema 错误、workspace 与 dsh home 的重叠校验。
 * 所有路径都在 mkdtempSync 临时根下，测试结束统一删除。
 */

const FULL_CONFIG = {
  schemaVersion: 1,
  qqAppId: 'file-app-id',
  qqAppSecret: 'file-app-secret',
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

describe('loadGatewayConfig: template creation', () => {
  it('creates the workspace and template on first start, then fails with edit instructions', () => {
    const { workspace, dshHome, configPath } = makeFixture()
    expect(existsSync(workspace)).toBe(false)

    let error: unknown
    try {
      loadGatewayConfig({ workspaceDir: workspace, dshHome })
      expect.unreachable('expected GatewayConfigError')
    } catch (err) {
      error = err
    }

    expect(error).toBeInstanceOf(GatewayConfigError)
    const message = (error as GatewayConfigError).message
    expect(message).toContain('qqAppId must be a non-empty string')
    expect(message).toContain(`created a template at ${configPath}`)
    expect(message).toContain('set qqAppId and qqAppSecret, then restart')
    expect(existsSync(workspace)).toBe(true)
    expect(readFileSync(configPath, 'utf8')).toBe(createGatewayConfigTemplate())
  })
})

describe('loadGatewayConfig: existing valid file', () => {
  it('loads the file and derives stateDir/workspaceRoot from the workspace', () => {
    const { workspace, dshHome, configPath } = makeFixture()
    const original = writeConfig(configPath, FULL_CONFIG)

    const config = loadGatewayConfig({ workspaceDir: workspace, dshHome })

    const { schemaVersion: _schemaVersion, ...configValues } = FULL_CONFIG
    expect(config).toEqual({
      stateDir: join(workspace, 'state'),
      workspaceRoot: join(workspace, 'users'),
      ...configValues,
    })
    expect('dshHome' in config).toBe(false)
    // 已有合法文件不被模板覆盖。
    expect(readFileSync(configPath, 'utf8')).toBe(original)
  })

  it('uses defaults for omitted optional fields', () => {
    const { workspace, dshHome, configPath } = makeFixture()
    writeConfig(configPath, {
      schemaVersion: 1,
      qqAppId: 'file-app-id',
      qqAppSecret: 'file-app-secret',
    })

    const config = loadGatewayConfig({ workspaceDir: workspace, dshHome })

    expect(config).toMatchObject({
      qqAppId: 'file-app-id',
      qqAppSecret: 'file-app-secret',
      debug: false,
      maxConcurrent: 4,
      maxPendingPerPeer: 3,
      maxPendingTotal: 100,
      maxPendingBytes: 8_388_608,
      idleAgentTtlMs: 900_000,
      maxLiveAgents: 32,
    })
  })
})

describe('loadGatewayConfig: existing files are never overwritten', () => {
  it('keeps a corrupted JSON file unchanged', () => {
    const { workspace, dshHome, configPath } = makeFixture()
    const original = writeConfig(configPath, '{\n  "schemaVersion": 1,\n  "qqAppId":')

    expect(() => loadGatewayConfig({ workspaceDir: workspace, dshHome })).toThrow(
      /invalid JSON/,
    )
    expect(readFileSync(configPath, 'utf8')).toBe(original)
  })

  it('keeps a file with an unknown field unchanged', () => {
    const { workspace, dshHome, configPath } = makeFixture()
    const original = writeConfig(configPath, { ...FULL_CONFIG, extra: true })

    expect(() => loadGatewayConfig({ workspaceDir: workspace, dshHome })).toThrow(
      /unknown field "extra"/,
    )
    expect(readFileSync(configPath, 'utf8')).toBe(original)
  })

  it.each(['qqAppId', 'qqAppSecret'] as const)(
    'keeps a file with a blank %s unchanged',
    (field) => {
      const { workspace, dshHome, configPath } = makeFixture()
      const original = writeConfig(configPath, { ...FULL_CONFIG, [field]: '   ' })

      expect(() => loadGatewayConfig({ workspaceDir: workspace, dshHome })).toThrow(
        new RegExp(`${field} must be a non-empty string`),
      )
      expect(readFileSync(configPath, 'utf8')).toBe(original)
    },
  )

  it('keeps a file missing required credentials unchanged instead of repairing it', () => {
    const { workspace, dshHome, configPath } = makeFixture()
    const { qqAppId: _omitted, ...withoutAppId } = FULL_CONFIG
    const original = writeConfig(configPath, withoutAppId)

    expect(() => loadGatewayConfig({ workspaceDir: workspace, dshHome })).toThrow(
      /qqAppId must be a non-empty string/,
    )
    expect(readFileSync(configPath, 'utf8')).toBe(original)
  })
})

describe('loadGatewayConfig: workspace path validation', () => {
  it('rejects relative workspace and dsh home paths', () => {
    const absolute = join(makeTempRoot(), 'workspace')

    expect(() =>
      loadGatewayConfig({ workspaceDir: 'relative/workspace', dshHome: absolute }),
    ).toThrow(/gateway workspace must be an absolute path/)
    expect(() =>
      loadGatewayConfig({ workspaceDir: absolute, dshHome: 'relative/dsh-home' }),
    ).toThrow(/dsh home must be an absolute path/)
  })

  it('rejects a workspace nested inside dsh home', () => {
    const root = makeTempRoot()
    const dshHome = join(root, 'dsh-home')
    const workspace = join(dshHome, 'gateway')

    expect(() => loadGatewayConfig({ workspaceDir: workspace, dshHome })).toThrow(
      GatewayConfigError,
    )
    expect(() => loadGatewayConfig({ workspaceDir: workspace, dshHome })).toThrow(
      /must not overlap with dsh home/,
    )
    expect(existsSync(workspace)).toBe(false)
  })

  it('rejects a dsh home nested inside the workspace', () => {
    const root = makeTempRoot()
    const workspace = join(root, 'workspace')
    const dshHome = join(workspace, 'dsh-home')

    expect(() => loadGatewayConfig({ workspaceDir: workspace, dshHome })).toThrow(
      /must not overlap with dsh home/,
    )
    expect(existsSync(workspace)).toBe(false)
  })

  it('rejects a workspace equal to dsh home', () => {
    const root = makeTempRoot()
    const same = join(root, 'same')

    expect(() => loadGatewayConfig({ workspaceDir: same, dshHome: same })).toThrow(
      /must not overlap with dsh home/,
    )
    expect(existsSync(same)).toBe(false)
  })

  it('allows sibling directories', () => {
    const { workspace, dshHome, configPath } = makeFixture()
    writeConfig(configPath, FULL_CONFIG)

    expect(() => loadGatewayConfig({ workspaceDir: workspace, dshHome })).not.toThrow()
  })

  it('allows siblings whose names share a prefix', () => {
    const root = makeTempRoot()
    const workspace = join(root, 'gateway')
    const dshHome = join(root, 'gateway-sibling')
    const configPath = join(workspace, GATEWAY_CONFIG_FILENAME)
    writeConfig(configPath, FULL_CONFIG)

    expect(() => loadGatewayConfig({ workspaceDir: workspace, dshHome })).not.toThrow()
  })
})
