import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildGatewayConfig,
  createGatewayConfigTemplate,
  DEFAULT_GATEWAY_WORKSPACE_DIRNAME,
  GATEWAY_CONFIG_SCHEMA_VERSION,
  GatewayConfigError,
  isPathOverlapping,
  parseGatewayConfigDocument,
  resolveGatewayWorkspace,
} from '../src/config.js'
import type { GatewayConfigFile } from '../src/config.js'

/**
 * 纯函数配置测试：workspace 环境变量解析、配置文件文档校验、模板与派生路径。
 * 不触碰文件系统；文件读取/模板创建在 tests/config-file.test.ts。
 */

const CONFIG_PATH = 'D:/dsh-gateway/gateway.config.json'

const FILE_DEFAULTS = {
  schemaVersion: GATEWAY_CONFIG_SCHEMA_VERSION,
  qqAppId: 'app-id',
  qqAppSecret: 'app-secret',
  debug: false,
  maxConcurrent: 4,
  maxPendingPerPeer: 3,
  maxPendingTotal: 100,
  maxPendingBytes: 8_388_608,
  idleAgentTtlMs: 900_000,
  maxLiveAgents: 32,
} as const

/** 最小合法文档；overrides 可替换任意字段或追加未知字段。 */
function validDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    qqAppId: 'app-id',
    qqAppSecret: 'app-secret',
    ...overrides,
  }
}

const INTEGER_FIELDS = [
  'maxConcurrent',
  'maxPendingPerPeer',
  'maxPendingTotal',
  'maxPendingBytes',
  'idleAgentTtlMs',
  'maxLiveAgents',
] as const

const INVALID_INTEGERS = [
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
  '4',
  null,
  true,
  {},
  [],
]

describe('resolveGatewayWorkspace', () => {
  const homeDir = join(tmpdir(), 'dsh-gateway-home')

  it('defaults to <home>/.dsh-gateway when the variable is unset or blank', () => {
    const expected = resolve(join(homeDir, DEFAULT_GATEWAY_WORKSPACE_DIRNAME))
    expect(resolveGatewayWorkspace({}, homeDir)).toBe(expected)
    expect(resolveGatewayWorkspace({ DSH_GATEWAY_WORKSPACE: undefined }, homeDir)).toBe(expected)
    expect(resolveGatewayWorkspace({ DSH_GATEWAY_WORKSPACE: '' }, homeDir)).toBe(expected)
    expect(resolveGatewayWorkspace({ DSH_GATEWAY_WORKSPACE: '   ' }, homeDir)).toBe(expected)
    expect(resolveGatewayWorkspace({ DSH_GATEWAY_WORKSPACE: '\t\n' }, homeDir)).toBe(expected)
  })

  it('keeps an explicit absolute path, trimming surrounding whitespace', () => {
    const workspace = join(tmpdir(), 'dsh-gateway-workspace')
    expect(resolveGatewayWorkspace({ DSH_GATEWAY_WORKSPACE: workspace }, homeDir)).toBe(
      resolve(workspace),
    )
    expect(
      resolveGatewayWorkspace({ DSH_GATEWAY_WORKSPACE: `  ${workspace}  ` }, homeDir),
    ).toBe(resolve(workspace))
  })

  it('rejects relative paths instead of resolving them against the process cwd', () => {
    for (const value of ['relative/workspace', './gateway', '../gateway', 'gateway']) {
      expect(
        () => resolveGatewayWorkspace({ DSH_GATEWAY_WORKSPACE: value }, homeDir),
        `DSH_GATEWAY_WORKSPACE=${JSON.stringify(value)}`,
      ).toThrow(GatewayConfigError)
      expect(() =>
        resolveGatewayWorkspace({ DSH_GATEWAY_WORKSPACE: value }, homeDir),
      ).toThrow(/DSH_GATEWAY_WORKSPACE must be an absolute path/)
    }
  })

  it('does not expand ~ or ~/...', () => {
    for (const value of ['~', '~/gateway', '~\\gateway', '~user/gateway']) {
      expect(
        () => resolveGatewayWorkspace({ DSH_GATEWAY_WORKSPACE: value }, homeDir),
        `DSH_GATEWAY_WORKSPACE=${JSON.stringify(value)}`,
      ).toThrow(GatewayConfigError)
    }
  })

  it('ignores every other environment variable', () => {
    const expected = resolve(join(homeDir, DEFAULT_GATEWAY_WORKSPACE_DIRNAME))
    expect(
      resolveGatewayWorkspace(
        {
          DSH_HOME: 'D:/dsh/home',
          DSH_GATEWAY_WORKSPACE_ROOT: 'D:/dsh/workspaces',
          DSH_GATEWAY_STATE_DIR: 'D:/dsh/state',
          DSH_GATEWAY_QQ_APP_ID: 'env-app-id',
        },
        homeDir,
      ),
    ).toBe(expected)
  })
})

describe('parseGatewayConfigDocument: valid documents', () => {
  it('applies all documented defaults when optional fields are absent', () => {
    const config = parseGatewayConfigDocument(validDocument(), CONFIG_PATH)
    expect(config).toEqual(FILE_DEFAULTS)
    expect(Object.isFrozen(config)).toBe(true)
  })

  it('accepts every provided field and trims the QQ credentials', () => {
    const config = parseGatewayConfigDocument(
      {
        schemaVersion: 1,
        qqAppId: '  app-id  ',
        qqAppSecret: '  app-secret  ',
        debug: true,
        maxConcurrent: 8,
        maxPendingPerPeer: 5,
        maxPendingTotal: 50,
        maxPendingBytes: 1_024,
        idleAgentTtlMs: 1_000,
        maxLiveAgents: 9,
      },
      CONFIG_PATH,
    )

    expect(config).toEqual({
      schemaVersion: 1,
      qqAppId: 'app-id',
      qqAppSecret: 'app-secret',
      debug: true,
      maxConcurrent: 8,
      maxPendingPerPeer: 5,
      maxPendingTotal: 50,
      maxPendingBytes: 1_024,
      idleAgentTtlMs: 1_000,
      maxLiveAgents: 9,
    })
  })

  it('accepts the positive boundary 1 and the largest safe integer', () => {
    const ones = validDocument(Object.fromEntries(INTEGER_FIELDS.map((field) => [field, 1])))
    expect(parseGatewayConfigDocument(ones, CONFIG_PATH)).toMatchObject(
      Object.fromEntries(INTEGER_FIELDS.map((field) => [field, 1])),
    )

    const maxSafe = validDocument(
      Object.fromEntries(INTEGER_FIELDS.map((field) => [field, Number.MAX_SAFE_INTEGER])),
    )
    expect(parseGatewayConfigDocument(maxSafe, CONFIG_PATH)).toMatchObject(
      Object.fromEntries(INTEGER_FIELDS.map((field) => [field, Number.MAX_SAFE_INTEGER])),
    )
  })

  it('accepts maxLiveAgents equal to maxConcurrent', () => {
    const config = parseGatewayConfigDocument(
      validDocument({ maxConcurrent: 8, maxLiveAgents: 8 }),
      CONFIG_PATH,
    )
    expect(config.maxConcurrent).toBe(8)
    expect(config.maxLiveAgents).toBe(8)
  })
})

describe('parseGatewayConfigDocument: root and schemaVersion', () => {
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'config'],
    ['a number', 1],
    ['a boolean', true],
  ])('rejects %s root with a path-scoped error', (_label, value) => {
    expect(() => parseGatewayConfigDocument(value, CONFIG_PATH)).toThrow(GatewayConfigError)
    expect(() => parseGatewayConfigDocument(value, CONFIG_PATH)).toThrow(
      `${CONFIG_PATH}: root must be an object`,
    )
  })

  it('requires schemaVersion', () => {
    const document = validDocument()
    delete document.schemaVersion
    expect(() => parseGatewayConfigDocument(document, CONFIG_PATH)).toThrow(
      `${CONFIG_PATH}: schemaVersion is required`,
    )
  })

  it.each([2, 0, '1', null, true])('rejects unsupported schemaVersion %j', (value) => {
    expect(() =>
      parseGatewayConfigDocument(validDocument({ schemaVersion: value }), CONFIG_PATH),
    ).toThrow(GatewayConfigError)
    expect(() =>
      parseGatewayConfigDocument(validDocument({ schemaVersion: value }), CONFIG_PATH),
    ).toThrow(/schemaVersion must be 1; unsupported version/)
  })
})

describe('parseGatewayConfigDocument: required QQ credentials', () => {
  it.each(['qqAppId', 'qqAppSecret'] as const)('rejects a missing %s', (field) => {
    const document = validDocument()
    delete document[field]
    expect(() => parseGatewayConfigDocument(document, CONFIG_PATH)).toThrow(
      new RegExp(`${field} must be a non-empty string`),
    )
  })

  it.each(['qqAppId', 'qqAppSecret'] as const)('rejects invalid %s values', (field) => {
    for (const value of ['', '   ', '\t\n', null, 1, false, {}, []]) {
      expect(
        () => parseGatewayConfigDocument(validDocument({ [field]: value }), CONFIG_PATH),
        `${field}=${JSON.stringify(value)}`,
      ).toThrow(new RegExp(`${field} must be a non-empty string`))
    }
  })
})

describe('parseGatewayConfigDocument: unknown fields and types', () => {
  it('rejects unknown fields, including old configuration names', () => {
    for (const field of ['extra', 'stateDir', 'workspaceRoot', 'dshHome']) {
      expect(() =>
        parseGatewayConfigDocument(validDocument({ [field]: true }), CONFIG_PATH),
      ).toThrow(`${CONFIG_PATH}: unknown field "${field}"`)
    }
  })

  it('rejects debug when it is not a boolean', () => {
    for (const value of [null, 'true', 1, 0, {}]) {
      expect(() =>
        parseGatewayConfigDocument(validDocument({ debug: value }), CONFIG_PATH),
      ).toThrow(/debug must be a boolean/)
    }
  })

  it.each(INTEGER_FIELDS)('rejects every non-positive-integer value for %s', (field) => {
    for (const value of INVALID_INTEGERS) {
      expect(
        () => parseGatewayConfigDocument(validDocument({ [field]: value }), CONFIG_PATH),
        `${field}=${String(value)}`,
      ).toThrow(new RegExp(`${field} must be a positive integer`))
    }
  })
})

describe('parseGatewayConfigDocument: cross-field validation', () => {
  it('rejects maxLiveAgents below maxConcurrent', () => {
    expect(() =>
      parseGatewayConfigDocument(
        validDocument({ maxConcurrent: 8, maxLiveAgents: 7 }),
        CONFIG_PATH,
      ),
    ).toThrow(/maxLiveAgents must be >= maxConcurrent/)
  })

  it('rejects raising maxConcurrent above the default maxLiveAgents', () => {
    expect(() =>
      parseGatewayConfigDocument(validDocument({ maxConcurrent: 33 }), CONFIG_PATH),
    ).toThrow(/maxLiveAgents must be >= maxConcurrent/)
  })

  it('uses the provided maxLiveAgents when only maxConcurrent is raised', () => {
    const config = parseGatewayConfigDocument(
      validDocument({ maxConcurrent: 33, maxLiveAgents: 33 }),
      CONFIG_PATH,
    )
    expect(config.maxConcurrent).toBe(33)
    expect(config.maxLiveAgents).toBe(33)
  })
})

describe('parseGatewayConfigDocument: credential privacy', () => {
  const secret = 'super-secret-do-not-leak'

  it.each([
    ['invalid integer', { maxConcurrent: 1.5 }],
    ['unknown field', { extra: true }],
    ['blank app id', { qqAppId: '   ' }],
    ['invalid debug', { debug: 'yes' }],
  ])('never includes qqAppSecret in errors for %s', (_label, overrides) => {
    try {
      parseGatewayConfigDocument(validDocument({ qqAppSecret: secret, ...overrides }), CONFIG_PATH)
      expect.unreachable('expected GatewayConfigError')
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayConfigError)
      expect((error as GatewayConfigError).message).not.toContain(secret)
    }
  })

  it('exposes a distinguishable error class and name', () => {
    try {
      parseGatewayConfigDocument({}, CONFIG_PATH)
      expect.unreachable('expected GatewayConfigError')
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayConfigError)
      expect((error as Error).name).toBe('GatewayConfigError')
    }
  })
})

describe('buildGatewayConfig', () => {
  it('derives stateDir and workspaceRoot from the workspace and copies file fields', () => {
    const workspaceDir = join(tmpdir(), 'dsh-gateway-workspace')
    const file: GatewayConfigFile = {
      schemaVersion: 1,
      qqAppId: 'app-id',
      qqAppSecret: 'app-secret',
      debug: true,
      maxConcurrent: 6,
      maxPendingPerPeer: 2,
      maxPendingTotal: 20,
      maxPendingBytes: 2_048,
      idleAgentTtlMs: 60_000,
      maxLiveAgents: 10,
    }

    const config = buildGatewayConfig(workspaceDir, file)

    expect(config).toEqual({
      stateDir: join(workspaceDir, 'state'),
      workspaceRoot: join(workspaceDir, 'users'),
      qqAppId: 'app-id',
      qqAppSecret: 'app-secret',
      debug: true,
      maxConcurrent: 6,
      maxPendingPerPeer: 2,
      maxPendingTotal: 20,
      maxPendingBytes: 2_048,
      idleAgentTtlMs: 60_000,
      maxLiveAgents: 10,
    })
    expect('dshHome' in config).toBe(false)
  })
})

describe('createGatewayConfigTemplate', () => {
  it('renders the full default document with blank QQ credentials', () => {
    expect(createGatewayConfigTemplate()).toBe(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          qqAppId: '',
          qqAppSecret: '',
          debug: false,
          maxConcurrent: 4,
          maxPendingPerPeer: 3,
          maxPendingTotal: 100,
          maxPendingBytes: 8_388_608,
          idleAgentTtlMs: 900_000,
          maxLiveAgents: 32,
        },
        null,
        2,
      )}\n`,
    )
  })

  it('is parseable JSON with a trailing newline and no BOM', () => {
    const text = createGatewayConfigTemplate()
    expect(text.endsWith('\n')).toBe(true)
    expect(text.startsWith('\uFEFF')).toBe(false)
    expect(text.startsWith('{\n  "schemaVersion": 1,')).toBe(true)
    expect(JSON.parse(text)).toMatchObject({
      schemaVersion: 1,
      qqAppId: '',
      qqAppSecret: '',
      debug: false,
      maxConcurrent: 4,
      maxLiveAgents: 32,
    })
  })
})

describe('isPathOverlapping', () => {
  it('rejects equal, nested, and reverse-nested paths', () => {
    expect(isPathOverlapping('D:/dsh/home', 'D:/dsh/home')).toBe(true)
    expect(isPathOverlapping('D:/dsh/home', 'D:/dsh/home/gateway')).toBe(true)
    expect(isPathOverlapping('D:/dsh/home/gateway', 'D:/dsh/home')).toBe(true)
  })

  it('allows siblings and similarly prefixed directory names', () => {
    expect(isPathOverlapping('D:/dsh/home', 'D:/dsh/workspace')).toBe(false)
    expect(isPathOverlapping('D:/dsh/state', 'D:/dsh/state-sibling')).toBe(false)
    expect(isPathOverlapping('D:/dsh/state', 'D:/dsh/other/..ws')).toBe(false)
  })

  it('treats a child named ..ws as nested, not as outside the parent', () => {
    expect(isPathOverlapping('D:/dsh/state', 'D:/dsh/state/..ws')).toBe(true)
  })
})
