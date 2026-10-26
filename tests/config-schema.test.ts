import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildGatewayConfig,
  CHANNEL_APP_ID_MAX_LENGTH,
  CHANNEL_APP_SECRET_MAX_LENGTH,
  createGatewayConfigTemplate,
  DEFAULT_GATEWAY_WORKSPACE_DIRNAME,
  GATEWAY_CONFIG_SCHEMA_VERSION,
  GatewayConfigError,
  isPathOverlapping,
  migrateLegacyGatewayConfigDocument,
  parseGatewayConfigDocument,
  resolveGatewayWorkspace,
  serializeGatewayConfigFile,
} from '../src/config/schema.js'
import type { GatewayConfigFile } from '../src/config/schema.js'

/**
 * 纯函数配置测试：workspace 环境变量解析、v2 配置文件文档校验、v1→v2 迁移、模板与派生
 * 路径。不触碰文件系统；文件读取/模板创建/迁移写回/漂移检测在 tests/config-store.test.ts。
 */

const CONFIG_PATH = 'D:/dsh-gateway/gateway.config.json'

const FILE_DEFAULTS = {
  schemaVersion: GATEWAY_CONFIG_SCHEMA_VERSION,
  channels: { qq: [{ appId: 'app-id', appSecret: 'app-secret', enabled: true }] },
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
    schemaVersion: 2,
    channels: { qq: [{ appId: 'app-id', appSecret: 'app-secret' }] },
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

describe('parseGatewayConfigDocument: valid v2 documents', () => {
  it('applies all documented defaults when optional fields are absent', () => {
    const config = parseGatewayConfigDocument(validDocument(), CONFIG_PATH)
    expect(config).toEqual(FILE_DEFAULTS)
    expect(Object.isFrozen(config)).toBe(true)
  })

  it('accepts a document without channels (zero instances)', () => {
    const document = validDocument()
    delete document.channels
    const config = parseGatewayConfigDocument(document, CONFIG_PATH)
    expect(config.channels.qq).toEqual([])
  })

  it('accepts channels without the qq key (zero instances)', () => {
    const config = parseGatewayConfigDocument(validDocument({ channels: {} }), CONFIG_PATH)
    expect(config.channels.qq).toEqual([])
  })

  it('accepts an empty qq array (zero instances)', () => {
    const config = parseGatewayConfigDocument(validDocument({ channels: { qq: [] } }), CONFIG_PATH)
    expect(config.channels.qq).toEqual([])
  })

  it('accepts multiple instances, trims credentials, and defaults enabled to true', () => {
    const config = parseGatewayConfigDocument(
      validDocument({
        channels: {
          qq: [
            { appId: '  app-1  ', appSecret: '  secret-1  ' },
            { appId: 'app-2', appSecret: 'secret-2', enabled: false },
          ],
        },
        debug: true,
        maxConcurrent: 8,
        maxLiveAgents: 9,
      }),
      CONFIG_PATH,
    )
    expect(config.channels.qq).toEqual([
      { appId: 'app-1', appSecret: 'secret-1', enabled: true },
      { appId: 'app-2', appSecret: 'secret-2', enabled: false },
    ])
    expect(config.debug).toBe(true)
    expect(config.maxConcurrent).toBe(8)
  })

  it('accepts boundary-length credentials', () => {
    const appId = 'a'.repeat(CHANNEL_APP_ID_MAX_LENGTH)
    const appSecret = 's'.repeat(CHANNEL_APP_SECRET_MAX_LENGTH)
    const config = parseGatewayConfigDocument(
      validDocument({ channels: { qq: [{ appId, appSecret }] } }),
      CONFIG_PATH,
    )
    expect(config.channels.qq[0]).toEqual({ appId, appSecret, enabled: true })
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

  it.each([1, 3, 0, '2', null, true])('rejects unsupported schemaVersion %j', (value) => {
    expect(() =>
      parseGatewayConfigDocument(validDocument({ schemaVersion: value }), CONFIG_PATH),
    ).toThrow(GatewayConfigError)
    expect(() =>
      parseGatewayConfigDocument(validDocument({ schemaVersion: value }), CONFIG_PATH),
    ).toThrow(/schemaVersion must be 2; unsupported version/)
  })
})

describe('parseGatewayConfigDocument: channels and instances', () => {
  it('rejects the weixin channel type with a not-supported message', () => {
    expect(() =>
      parseGatewayConfigDocument(validDocument({ channels: { qq: [], weixin: [] } }), CONFIG_PATH),
    ).toThrow(GatewayConfigError)
    expect(() =>
      parseGatewayConfigDocument(validDocument({ channels: { qq: [], weixin: [] } }), CONFIG_PATH),
    ).toThrow(/unknown channel type "weixin"; only "qq" is supported \(weixin is not supported yet\)/)
  })

  it('rejects any other unknown channel type', () => {
    expect(() =>
      parseGatewayConfigDocument(validDocument({ channels: { telegram: [] } }), CONFIG_PATH),
    ).toThrow(/unknown channel type "telegram"/)
  })

  it('rejects non-object channels and non-array qq', () => {
    expect(() => parseGatewayConfigDocument(validDocument({ channels: [] }), CONFIG_PATH)).toThrow(
      /channels must be an object/,
    )
    expect(() => parseGatewayConfigDocument(validDocument({ channels: { qq: {} } }), CONFIG_PATH)).toThrow(
      /channels.qq must be an array/,
    )
    expect(() => parseGatewayConfigDocument(validDocument({ channels: { qq: 'x' } }), CONFIG_PATH)).toThrow(
      /channels.qq must be an array/,
    )
  })

  it('rejects malformed instances', () => {
    expect(() =>
      parseGatewayConfigDocument(validDocument({ channels: { qq: ['x'] } }), CONFIG_PATH),
    ).toThrow(/channels.qq\[0\] must be an object/)
    expect(() =>
      parseGatewayConfigDocument(validDocument({ channels: { qq: [null] } }), CONFIG_PATH),
    ).toThrow(/channels.qq\[0\] must be an object/)
  })

  it('rejects unknown instance fields', () => {
    expect(() =>
      parseGatewayConfigDocument(
        validDocument({ channels: { qq: [{ appId: 'a', appSecret: 's', label: 'bot' }] } }),
        CONFIG_PATH,
      ),
    ).toThrow(/channels.qq\[0\] unknown field "label"/)
  })

  it.each(['appId', 'appSecret'] as const)('rejects a missing or blank %s', (field) => {
    for (const value of [undefined, '', '   ', '\t\n', null, 1, false, {}, []]) {
      expect(
        () =>
          parseGatewayConfigDocument(
            validDocument({
              channels: { qq: [{ appId: 'app-id', appSecret: 'app-secret', [field]: value }] },
            }),
            CONFIG_PATH,
          ),
        `${field}=${JSON.stringify(value)}`,
      ).toThrow(new RegExp(`${field} must be a non-empty string`))
    }
  })

  it('rejects over-length credentials', () => {
    expect(() =>
      parseGatewayConfigDocument(
        validDocument({
          channels: { qq: [{ appId: 'a'.repeat(CHANNEL_APP_ID_MAX_LENGTH + 1), appSecret: 's' }] },
        }),
        CONFIG_PATH,
      ),
    ).toThrow(new RegExp(`appId must be at most ${CHANNEL_APP_ID_MAX_LENGTH} characters`))
    expect(() =>
      parseGatewayConfigDocument(
        validDocument({
          channels: { qq: [{ appId: 'a', appSecret: 's'.repeat(CHANNEL_APP_SECRET_MAX_LENGTH + 1) }] },
        }),
        CONFIG_PATH,
      ),
    ).toThrow(new RegExp(`appSecret must be at most ${CHANNEL_APP_SECRET_MAX_LENGTH} characters`))
  })

  it('rejects a non-boolean enabled', () => {
    for (const value of ['true', 1, 0, null, {}]) {
      expect(() =>
        parseGatewayConfigDocument(
          validDocument({ channels: { qq: [{ appId: 'a', appSecret: 's', enabled: value }] } }),
          CONFIG_PATH,
        ),
      ).toThrow(/enabled must be a boolean/)
    }
  })

  it('rejects duplicate appIds within the qq array', () => {
    expect(() =>
      parseGatewayConfigDocument(
        validDocument({
          channels: { qq: [{ appId: 'dup', appSecret: 'a' }, { appId: 'dup', appSecret: 'b' }] },
        }),
        CONFIG_PATH,
      ),
    ).toThrow(/duplicate channels.qq appId "dup"/)
  })

  it('rejects appIds outside the binding-scope charset, accepts letters/digits/hyphens', () => {
    for (const appId of ['bad_app', 'app.id', 'app id', '应用', 'app/1']) {
      expect(
        () =>
          parseGatewayConfigDocument(
            validDocument({ channels: { qq: [{ appId, appSecret: 's' }] } }),
            CONFIG_PATH,
          ),
        appId,
      ).toThrow(/appId must only contain \[A-Za-z0-9-\] characters/)
    }
    const valid = parseGatewayConfigDocument(
      validDocument({ channels: { qq: [{ appId: 'App-01-x', appSecret: 's' }] } }),
      CONFIG_PATH,
    )
    expect(valid.channels.qq[0]!.appId).toBe('App-01-x')
  })
})

describe('parseGatewayConfigDocument: unknown fields and types', () => {
  it('rejects unknown fields, including v1 credential names', () => {
    for (const field of ['extra', 'stateDir', 'workspaceRoot', 'dshHome', 'qqAppId', 'qqAppSecret']) {
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
    ['blank app id', { channels: { qq: [{ appId: '   ', appSecret: secret }] } }],
    ['unknown channel type', { channels: { weixin: [] } }],
    ['invalid debug', { debug: 'yes' }],
  ])('never includes the appSecret value in errors for %s', (_label, overrides) => {
    try {
      parseGatewayConfigDocument(validDocument({ ...overrides }), CONFIG_PATH)
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

describe('migrateLegacyGatewayConfigDocument (v1 -> v2)', () => {
  it('converts a valid v1 document into one enabled qq instance', () => {
    const migrated = migrateLegacyGatewayConfigDocument(
      {
        schemaVersion: 1,
        qqAppId: 'legacy-app',
        qqAppSecret: 'legacy-secret',
        debug: true,
        maxConcurrent: 7,
        maxLiveAgents: 9,
      },
      CONFIG_PATH,
    )
    expect(migrated).toEqual({
      schemaVersion: 2,
      channels: { qq: [{ appId: 'legacy-app', appSecret: 'legacy-secret', enabled: true }] },
      debug: true,
      maxConcurrent: 7,
      maxPendingPerPeer: 3,
      maxPendingTotal: 100,
      maxPendingBytes: 8_388_608,
      idleAgentTtlMs: 900_000,
      maxLiveAgents: 9,
    })
  })

  it('converts a v1 template with both credentials blank into zero qq instances', () => {
    for (const document of [
      { schemaVersion: 1, qqAppId: '', qqAppSecret: '', debug: true, maxConcurrent: 7, maxLiveAgents: 9 },
      { schemaVersion: 1, qqAppId: '  ', qqAppSecret: ' \t ' },
    ]) {
      const migrated = migrateLegacyGatewayConfigDocument(document, CONFIG_PATH)
      expect(migrated).toMatchObject({ schemaVersion: 2, channels: { qq: [] } })
    }
  })

  it('rejects a v1 document with exactly one blank credential', () => {
    expect(() =>
      migrateLegacyGatewayConfigDocument({ schemaVersion: 1, qqAppId: '  ', qqAppSecret: 's' }, CONFIG_PATH),
    ).toThrow(/qqAppId must be a non-empty string/)
    expect(() =>
      migrateLegacyGatewayConfigDocument({ schemaVersion: 1, qqAppId: 'a', qqAppSecret: ' ' }, CONFIG_PATH),
    ).toThrow(/qqAppSecret must be a non-empty string/)
  })

  it('rejects a v1 document with blank or missing credentials', () => {
    for (const document of [
      { schemaVersion: 1, qqAppId: '', qqAppSecret: 's' },
      { schemaVersion: 1, qqAppId: 'a' },
      { schemaVersion: 1 },
    ]) {
      expect(() => migrateLegacyGatewayConfigDocument(document, CONFIG_PATH)).toThrow(
        GatewayConfigError,
      )
    }
  })

  it('rejects a v1 document with unknown fields', () => {
    expect(() =>
      migrateLegacyGatewayConfigDocument(
        { schemaVersion: 1, qqAppId: 'a', qqAppSecret: 's', extra: true },
        CONFIG_PATH,
      ),
    ).toThrow(/unknown field "extra"/)
  })

  it('rejects a v1 qqAppId outside the binding-scope charset before writing back', () => {
    expect(() =>
      migrateLegacyGatewayConfigDocument(
        { schemaVersion: 1, qqAppId: 'legacy_app', qqAppSecret: 's' },
        CONFIG_PATH,
      ),
    ).toThrow(/qqAppId must only contain \[A-Za-z0-9-\] characters/)
  })

  it('rejects non-v1 schemaVersion values', () => {
    expect(() =>
      migrateLegacyGatewayConfigDocument(
        { schemaVersion: 2, qqAppId: 'a', qqAppSecret: 's' },
        CONFIG_PATH,
      ),
    ).toThrow(/must be 1 for legacy migration/)
  })
})

describe('buildGatewayConfig', () => {
  it('derives stateDir/workspaceRoot, copies scalar fields, and exposes qqInstances', () => {
    const workspaceDir = join(tmpdir(), 'dsh-gateway-workspace')
    const file: GatewayConfigFile = {
      schemaVersion: 2,
      channels: {
        qq: [
          { appId: 'app-1', appSecret: 'secret-1', enabled: true },
          { appId: 'app-2', appSecret: 'secret-2', enabled: false },
        ],
      },
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
      qqInstances: [
        { appId: 'app-1', appSecret: 'secret-1', enabled: true },
        { appId: 'app-2', appSecret: 'secret-2', enabled: false },
      ],
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

describe('createGatewayConfigTemplate and serializeGatewayConfigFile', () => {
  it('renders the v2 default document with an empty qq array', () => {
    expect(createGatewayConfigTemplate()).toBe(
      `${JSON.stringify(
        {
          schemaVersion: 2,
          channels: { qq: [] },
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

  it('is parseable v2 JSON with a trailing newline and no BOM', () => {
    const text = createGatewayConfigTemplate()
    expect(text.endsWith('\n')).toBe(true)
    expect(text.startsWith('\uFEFF')).toBe(false)
    expect(text.startsWith('{\n  "schemaVersion": 2,')).toBe(true)
    expect(parseGatewayConfigDocument(JSON.parse(text), CONFIG_PATH).channels.qq).toEqual([])
  })

  it('serializeGatewayConfigFile roundtrips through the parser', () => {
    const parsed = parseGatewayConfigDocument(validDocument(), CONFIG_PATH)
    const text = serializeGatewayConfigFile(parsed)
    expect(parseGatewayConfigDocument(JSON.parse(text), CONFIG_PATH)).toEqual(parsed)
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
