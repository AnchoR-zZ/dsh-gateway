import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeBindingId, GATEWAY_LIMITS } from '../src/contracts.js'
import {
  createDefaultStateStoreIo,
  createStateStore,
  type BindingRecord,
  type StateStore,
  type StateStoreIo,
  StateStoreError,
} from '../src/core/state-store.js'
import { createGatewayLogger } from '../src/logging.js'

const MAIN = 'bindings.json'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gw-state-'))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const IDENTITY_A = { channelId: 'qq', accountId: 'app-1', peerId: 'peer-A' }
const IDENTITY_B = { channelId: 'qq', accountId: 'app-1', peerId: 'peer-B' }

function makeRecord(
  overrides: Partial<BindingRecord> = {},
  identity: { channelId: string; accountId: string; peerId: string } = IDENTITY_A,
): BindingRecord {
  return {
    channelId: identity.channelId,
    accountId: identity.accountId,
    peerId: identity.peerId,
    sessionId: randomUUID(),
    generation: 1,
    createdAt: '2026-10-20T12:00:00.000Z',
    updatedAt: '2026-10-20T12:00:00.000Z',
    ...overrides,
  }
}

function makeStore(
  options: { io?: Partial<StateStoreIo>; now?: () => number; logs?: string[]; stateDir?: string } = {},
): StateStore {
  const logs = options.logs ?? []
  return createStateStore({
    stateDir: options.stateDir ?? dir,
    limits: GATEWAY_LIMITS,
    logger: createGatewayLogger({ debug: false, sink: (line) => logs.push(line) }),
    now: options.now,
    io: options.io ? { ...createDefaultStateStoreIo(), ...options.io } : undefined,
  })
}

function mainPath(): string {
  return join(dir, MAIN)
}

function bakPath(): string {
  return `${mainPath()}.bak`
}

function readMain(): Record<string, unknown> {
  return JSON.parse(readFileSync(mainPath(), 'utf8')) as Record<string, unknown>
}

function writeMain(content: string): void {
  writeFileSync(mainPath(), content, 'utf8')
}

function writeDocument(doc: unknown): void {
  writeMain(JSON.stringify(doc, null, 2))
}

function validDocument(): {
  schemaVersion: number
  revision: number
  bindings: Record<string, BindingRecord>
} {
  const record = makeRecord()
  return {
    schemaVersion: 1,
    revision: 3,
    bindings: { [computeBindingId(record)]: record },
  }
}

describe('state-store: load 与首次部署', () => {
  it('空目录 load 得到空快照，不产生任何文件', async () => {
    const store = makeStore()
    await store.load()
    expect(store.snapshot()).toEqual({ schemaVersion: 1, revision: 0, bindings: {} })
    expect(store.getBinding('qq_app-1_missing')).toBeUndefined()
    expect(readdirSync(dir)).toEqual([])
  })

  it('stateDir 不存在时 load 同样得到空态，首个事务落盘前补建目录', async () => {
    const nested = join(dir, 'nested')
    const store = makeStore({ stateDir: nested })
    await store.load()
    expect(store.snapshot().revision).toBe(0)
    const record = makeRecord()
    await store.runTransaction((draft) => {
      draft.set(computeBindingId(record), record)
    })
    expect(existsSync(join(nested, MAIN))).toBe(true)
  })

  it('首个事务创建 bindings.json：schemaVersion=1、revision=1、无临时文件残留', async () => {
    const store = makeStore()
    await store.load()
    const record = makeRecord()
    const bindingId = computeBindingId(record)
    await store.runTransaction((draft) => {
      draft.set(bindingId, record)
    })
    expect(readdirSync(dir)).toEqual([MAIN])
    const doc = readMain()
    expect(doc.schemaVersion).toBe(1)
    expect(doc.revision).toBe(1)
    expect(doc.bindings).toEqual({ [bindingId]: record })
    expect(store.snapshot().revision).toBe(1)
    expect(store.getBinding(bindingId)).toEqual(record)
  })

  it('重复 load 为 no-op，不重置已提交状态', async () => {
    const store = makeStore()
    await store.load()
    const record = makeRecord()
    await store.runTransaction((draft) => {
      draft.set(computeBindingId(record), record)
    })
    await store.load()
    expect(store.snapshot().revision).toBe(1)
    expect(store.getBinding(computeBindingId(record))).toEqual(record)
  })

  it('load 成功前 runTransaction 直接拒绝', async () => {
    const store = makeStore()
    await expect(store.runTransaction((draft) => draft.size)).rejects.toThrow(
      StateStoreError,
    )
    await expect(store.runTransaction((draft) => draft.size)).rejects.toThrow(/load\(\) must succeed/)
  })
})

describe('state-store: 事务串行与原子性', () => {
  it('并发事务排队执行：mutate 挂起时后续事务不开始，写盘完成才放行', async () => {
    const store = makeStore()
    await store.load()
    const recordA = makeRecord()
    const recordB = makeRecord({}, IDENTITY_B)
    const order: string[] = []
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const first = store.runTransaction(async (draft) => {
      order.push('first:mutate')
      draft.set(computeBindingId(recordA), recordA)
      await gate
      order.push('first:mutate-done')
    })
    const second = store.runTransaction((draft) => {
      order.push('second:mutate')
      draft.set(computeBindingId(recordB), recordB)
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(order).toEqual(['first:mutate'])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first:mutate', 'first:mutate-done', 'second:mutate'])
    expect(store.snapshot().revision).toBe(2)
    expect(store.snapshot().bindings[computeBindingId(recordA)]).toEqual(recordA)
    expect(store.snapshot().bindings[computeBindingId(recordB)]).toEqual(recordB)
  })

  it('mutate 抛错：事务失败、无写入、revision 与快照不变、store 不转 failed', async () => {
    const store = makeStore()
    await store.load()
    await expect(
      store.runTransaction(async (draft) => {
        draft.set(computeBindingId(makeRecord()), makeRecord())
        throw new Error('mutate boom')
      }),
    ).rejects.toThrow('mutate boom')
    expect(readdirSync(dir)).toEqual([])
    expect(store.snapshot()).toEqual({ schemaVersion: 1, revision: 0, bindings: {} })
    expect(store.isFailed()).toBe(false)
  })

  it('草稿含非法记录：校验失败拒绝且不写盘，store 保持可用', async () => {
    const store = makeStore()
    await store.load()
    const record = makeRecord()
    await expect(
      store.runTransaction((draft) => {
        draft.set(computeBindingId(record), { ...record, sessionId: 'not-a-uuid' })
      }),
    ).rejects.toThrow(StateStoreError)
    await expect(
      store.runTransaction((draft) => {
        draft.set('wrong-key', record)
      }),
    ).rejects.toThrow(/invalid draft: binding key/)
    expect(readdirSync(dir)).toEqual([])
    expect(store.isFailed()).toBe(false)
    await store.runTransaction((draft) => {
      draft.set(computeBindingId(record), record)
    })
    expect(store.snapshot().revision).toBe(1)
  })

  it('revision 随成功事务递增，getBinding/snapshot 与删除一致', async () => {
    const store = makeStore()
    await store.load()
    const recordA = makeRecord()
    const recordB = makeRecord({}, IDENTITY_B)
    const idA = computeBindingId(recordA)
    const idB = computeBindingId(recordB)
    await store.runTransaction((draft) => {
      draft.set(idA, recordA)
    })
    await store.runTransaction((draft) => {
      draft.set(idB, recordB)
    })
    expect(store.snapshot().revision).toBe(2)
    await store.runTransaction((draft) => {
      draft.delete(idA)
    })
    expect(store.snapshot().revision).toBe(3)
    expect(store.getBinding(idA)).toBeUndefined()
    expect(store.getBinding(idB)).toEqual(recordB)
    expect(Object.keys(store.snapshot().bindings)).toEqual([idB])
    expect(readMain().revision).toBe(3)
  })

  it('flushNow 等待在途事务完成后返回，不产生新写入', async () => {
    const store = makeStore()
    await store.load()
    const record = makeRecord()
    const txn = store.runTransaction((draft) => {
      draft.set(computeBindingId(record), record)
    })
    await store.flushNow()
    await expect(txn).resolves.toBeUndefined()
    expect(readMain().revision).toBe(1)
    const before = readdirSync(dir)
    await store.flushNow()
    expect(readdirSync(dir)).toEqual(before)
  })
})

describe('state-store: load 校验矩阵', () => {
  type Case = [name: string, mutateDoc: () => unknown | string, pattern: RegExp]

  const cases: Case[] = [
    [
      '损坏 JSON',
      () => '{oops',
      /not valid JSON/,
    ],
    [
      'schemaVersion 为 2',
      () => ({ ...validDocument(), schemaVersion: 2 }),
      /unsupported schemaVersion 2/,
    ],
    [
      '缺失 schemaVersion',
      () => {
        const doc = validDocument() as Record<string, unknown>
        delete doc.schemaVersion
        return doc
      },
      /missing schemaVersion/,
    ],
    [
      'revision 为负数',
      () => ({ ...validDocument(), revision: -1 }),
      /revision must be a non-negative integer/,
    ],
    [
      '缺失 revision',
      () => {
        const doc = validDocument() as Record<string, unknown>
        delete doc.revision
        return doc
      },
      /missing revision/,
    ],
    [
      'revision 为非整数',
      () => ({ ...validDocument(), revision: 1.5 }),
      /revision must be a non-negative integer/,
    ],
    [
      '根不是对象',
      () => '[]',
      /root must be an object/,
    ],
    [
      'bindings 是数组',
      () => ({ ...validDocument(), bindings: [] }),
      /bindings must be an object/,
    ],
    [
      'binding 键与身份不匹配',
      () => ({
        ...validDocument(),
        bindings: { [computeBindingId(makeRecord({}, IDENTITY_B))]: makeRecord() },
      }),
      /key does not match identity/,
    ],
    [
      'binding 键格式非法',
      () => {
        const doc = validDocument()
        const record = Object.values(doc.bindings)[0] as BindingRecord
        doc.bindings = { short: record }
        return doc
      },
      /binding key must have the form/,
    ],
    [
      'sessionId 非法 UUID',
      () => {
        const doc = validDocument()
        const [key, record] = Object.entries(doc.bindings)[0] as [string, BindingRecord]
        doc.bindings[key] = { ...record, sessionId: 'not-a-uuid' }
        return doc
      },
      /sessionId is not a valid UUID/,
    ],
    [
      '同一 sessionId 被两个 binding 共用',
      () => {
        const doc = validDocument()
        const shared = randomUUID()
        const recordA = makeRecord({ sessionId: shared })
        const recordB = makeRecord({ sessionId: shared }, IDENTITY_B)
        doc.bindings = {
          [computeBindingId(recordA)]: recordA,
          [computeBindingId(recordB)]: recordB,
        }
        return doc
      },
      /sessionId is already used by another binding/,
    ],
    [
      'createdAt 非法时间',
      () => {
        const doc = validDocument()
        const [key, record] = Object.entries(doc.bindings)[0] as [string, BindingRecord]
        doc.bindings[key] = { ...record, createdAt: 'not-a-date' }
        return doc
      },
      /createdAt is not a valid ISO 8601/,
    ],
    [
      'updatedAt 非法时间',
      () => {
        const doc = validDocument()
        const [key, record] = Object.entries(doc.bindings)[0] as [string, BindingRecord]
        doc.bindings[key] = { ...record, updatedAt: 'October 20, 2026' }
        return doc
      },
      /updatedAt is not a valid ISO 8601/,
    ],
    [
      'generation 为 0',
      () => {
        const doc = validDocument()
        const [key, record] = Object.entries(doc.bindings)[0] as [string, BindingRecord]
        doc.bindings[key] = { ...record, generation: 0 }
        return doc
      },
      /generation must be an integer >= 1/,
    ],
    [
      'channelId 为空串',
      () => {
        const doc = validDocument()
        const [key, record] = Object.entries(doc.bindings)[0] as [string, BindingRecord]
        doc.bindings[key] = { ...record, channelId: '' }
        return doc
      },
      /channelId must be a non-empty string/,
    ],
    [
      'channelId 含下划线，无法构成 bindingId',
      () => {
        const doc = validDocument()
        const [key, record] = Object.entries(doc.bindings)[0] as [string, BindingRecord]
        doc.bindings[key] = { ...record, channelId: 'q_q' }
        return doc
      },
      /identity cannot form a binding id/,
    ],
  ]

  it.each(cases)('%s：load 抛 StateStoreError 且 message 含原因类别', async (_name, mutateDoc, pattern) => {
    const content = mutateDoc()
    writeMain(typeof content === 'string' ? content : JSON.stringify(content, null, 2))
    const store = makeStore()
    await expect(store.load()).rejects.toThrow(StateStoreError)
    await expect(store.load()).rejects.toThrow(pattern)
    expect(store.isFailed()).toBe(false)
  })

  it('读取 IO 错误（非 ENOENT）抛 StateStoreError', async () => {
    const store = makeStore({
      io: {
        readFile: () => Promise.reject(Object.assign(new Error('EACCES: denied'), { code: 'EACCES' })),
      },
    })
    writeMain(JSON.stringify(validDocument(), null, 2))
    await expect(store.load()).rejects.toThrow(/failed to read bindings\.json/)
  })

  it('缺失 bindings 字段视为空对象，load 成功', async () => {
    const doc = validDocument() as Record<string, unknown>
    delete doc.bindings
    writeDocument(doc)
    const store = makeStore()
    await store.load()
    expect(store.snapshot()).toEqual({ schemaVersion: 1, revision: 3, bindings: {} })
  })
})

describe('state-store: round-trip 与 bak 序列', () => {
  it('写入后新建 store 重新 load 读回全部状态', async () => {
    const store = makeStore()
    await store.load()
    const recordA = makeRecord()
    const recordB = makeRecord({}, IDENTITY_B)
    const expected = {
      [computeBindingId(recordA)]: recordA,
      [computeBindingId(recordB)]: recordB,
    }
    await store.runTransaction((draft) => {
      draft.set(computeBindingId(recordA), recordA)
    })
    await store.runTransaction((draft) => {
      draft.set(computeBindingId(recordB), recordB)
    })
    const restored = makeStore()
    await restored.load()
    expect(restored.snapshot()).toEqual({ schemaVersion: 1, revision: 2, bindings: expected })
    expect(restored.getBinding(computeBindingId(recordA))).toEqual(recordA)
    // 恢复后的 store 可继续提交，revision 在磁盘值之上递增。
    const recordC = makeRecord({ sessionId: randomUUID() }, { channelId: 'qq', accountId: 'app-2', peerId: 'peer-C' })
    await restored.runTransaction((draft) => {
      draft.set(computeBindingId(recordC), recordC)
    })
    expect(restored.snapshot().revision).toBe(3)
    expect(readMain().revision).toBe(3)
  })

  it('首次成功事务不产生 bak；第二次事务后 bak 为上一份快照', async () => {
    const store = makeStore()
    await store.load()
    const record = makeRecord()
    const bindingId = computeBindingId(record)
    const firstSessionId = record.sessionId
    await store.runTransaction((draft) => {
      draft.set(bindingId, record)
    })
    expect(existsSync(bakPath())).toBe(false)
    const secondRecord = makeRecord({ sessionId: randomUUID(), generation: 2, updatedAt: '2026-10-20T13:00:00.000Z' })
    await store.runTransaction((draft) => {
      draft.set(bindingId, secondRecord)
    })
    expect(existsSync(bakPath())).toBe(true)
    const bak = JSON.parse(readFileSync(bakPath(), 'utf8')) as Record<string, unknown>
    expect(bak.schemaVersion).toBe(1)
    expect(bak.revision).toBe(1)
    expect((bak.bindings as Record<string, BindingRecord>)[bindingId].sessionId).toBe(firstSessionId)
    expect(readMain().revision).toBe(2)
    // bak 之后的主文件内容不受影响，tmp 文件全部 rename 离场。
    expect(readdirSync(dir).sort()).toEqual(['bindings.json', 'bindings.json.bak'])
  })
})

describe('state-store: 持久化失败转 failed', () => {
  function epermLock(): Error {
    return Object.assign(new Error('EPERM: fake file lock on rename'), { code: 'EPERM' })
  }

  it('主文件 rename 失败：事务 reject、退避重试后转 failed、内存快照保留', async () => {
    const logs: string[] = []
    let renameCalls = 0
    const store = makeStore({
      logs,
      io: {
        rename: (from, to) => {
          if (to === mainPath()) {
            renameCalls += 1
            return Promise.reject(epermLock())
          }
          return createDefaultStateStoreIo().rename(from, to)
        },
      },
    })
    await store.load()
    const failures: unknown[] = []
    store.onFailed((error) => {
      failures.push(error)
    })
    const record = makeRecord()
    await expect(
      store.runTransaction((draft) => {
        draft.set(computeBindingId(record), record)
      }),
    ).rejects.toThrow(/mapping write failed/)
    // 1 次初始 + 3 次退避重试后仍失败。
    expect(renameCalls).toBe(4)
    expect(store.isFailed()).toBe(true)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toBeInstanceOf(StateStoreError)
    await expect(
      store.runTransaction((draft) => {
        draft.set(computeBindingId(makeRecord({}, IDENTITY_B)), makeRecord({}, IDENTITY_B))
      }),
    ).rejects.toThrow(/has failed/)
    expect(store.snapshot()).toEqual({ schemaVersion: 1, revision: 0, bindings: {} })
    expect(existsSync(mainPath())).toBe(false)
    expect(logs.some((line) => line.includes('"state_failed"'))).toBe(true)
  })

  it('备份步骤失败：不替换主文件，事务失败并转 failed', async () => {
    // 先正常提交一份，使第二次事务进入备份分支。
    const store = makeStore()
    await store.load()
    const record = makeRecord()
    const bindingId = computeBindingId(record)
    await store.runTransaction((draft) => {
      draft.set(bindingId, record)
    })
    expect(existsSync(mainPath())).toBe(true)
    const before = readFileSync(mainPath(), 'utf8')
    const failing = makeStore({
      io: {
        rename: (from, to) => {
          if (to === bakPath()) {
            return Promise.reject(Object.assign(new Error('EBUSY: bak busy'), { code: 'EBUSY' }))
          }
          return createDefaultStateStoreIo().rename(from, to)
        },
      },
    })
    // failing store 未 load 过；直接构造已 load 的场景：与 store 共享同一目录重新 load。
    await failing.load()
    await expect(
      failing.runTransaction((draft) => {
        draft.set(bindingId, { ...record, sessionId: randomUUID(), generation: 2 })
      }),
    ).rejects.toThrow(/mapping write failed/)
    expect(failing.isFailed()).toBe(true)
    // 主文件保持上一份已提交内容。
    expect(readFileSync(mainPath(), 'utf8')).toBe(before)
  })

  it('目录 fsync 失败只告警一次，不回滚已成功的事务', async () => {
    const logs: string[] = []
    const store = makeStore({
      logs,
      io: {
        fsyncDir: () => Promise.reject(Object.assign(new Error('EPERM: dir fsync'), { code: 'EPERM' })),
      },
    })
    await store.load()
    const recordA = makeRecord()
    await store.runTransaction((draft) => {
      draft.set(computeBindingId(recordA), recordA)
    })
    const recordB = makeRecord({}, IDENTITY_B)
    await store.runTransaction((draft) => {
      draft.set(computeBindingId(recordB), recordB)
    })
    expect(store.isFailed()).toBe(false)
    expect(store.snapshot().revision).toBe(2)
    expect(readMain().revision).toBe(2)
    const warnings = logs.filter((line) => line.includes('"state_warning"'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('directory fsync failed')
  })

  it('写操作卡住超过 MAP_WRITE_TIMEOUT_MS：虚拟计时器推进下超时 reject 并转 failed', async () => {
    vi.useFakeTimers()
    let clock = 0
    const store = makeStore({
      now: () => clock,
      io: {
        ensureDir: () => Promise.resolve(),
        writeFile: () => new Promise<void>(() => {}),
      },
    })
    await store.load()
    const failures: unknown[] = []
    store.onFailed((error) => {
      failures.push(error)
    })
    const record = makeRecord()
    const txn = store.runTransaction((draft) => {
      draft.set(computeBindingId(record), record)
    })
    // 冲微任务，让队列启动、mutate 完成并进入卡住的写与期限定时器。
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(GATEWAY_LIMITS.MAP_WRITE_TIMEOUT_MS)
    await expect(txn).rejects.toThrow(/timed out/)
    expect(store.isFailed()).toBe(true)
    expect(failures).toHaveLength(1)
    expect((failures[0] as StateStoreError).isTimeout).toBe(true)
    expect(store.snapshot().revision).toBe(0)
    expect(store.snapshot().bindings).toEqual({})
    // failed 后新事务直接拒绝。
    await expect(
      store.runTransaction((draft) => {
        draft.set(computeBindingId(record), record)
      }),
    ).rejects.toThrow(/has failed/)
  })
})
