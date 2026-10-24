import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeBindingId, GATEWAY_LIMITS } from '../src/contracts.js'
import {
  createSessionManager,
  resolveWorkspaceDir,
  type AgentHandleLike,
  type AgentHost,
  type CreateAgentInput,
  type PreparedSession,
  type ResumeAgentInput,
  type SessionLike,
} from '../src/core/session-manager.js'
import { createDefaultStateStoreIo, createStateStore, type StateStore, type StateStoreIo } from '../src/core/state-store.js'
import { createGatewayLogger } from '../src/logging.js'

/**
 * 会话管理器测试：FakeHost 替身 + 真实 StateStore（临时目录）+ 真实 fs 目录 + 可注入
 * now（墙钟，映射时间戳）/mono（单调时钟，预算与空闲 TTL）/uuid。
 * Windows 上 symlink 需要特权，逃逸用例使用 junction 形式（`fs.symlinkSync(target, path, 'junction')`）。
 */

let dir: string
let wsRoot: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gw-sm-'))
  wsRoot = join(dir, 'ws')
  mkdirSync(wsRoot, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function identity(n: number): { channelId: string; accountId: string; peerId: string } {
  return { channelId: 'qq', accountId: 'app-1', peerId: `peer-${n}` }
}

function freshSignal(): AbortSignal {
  return new AbortController().signal
}

/** 确定性 UUID 序列（state-store 的 UUID_PATTERN 兼容形态）。 */
function uuidSeq(): () => string {
  let n = 0
  return () => {
    n += 1
    return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  }
}

/** 逐 sessionId 记录 agent/handle 操作顺序的替身宿主。 */
class FakeHost implements AgentHost {
  readonly created: CreateAgentInput[] = []
  readonly resumed: ResumeAgentInput[] = []
  readonly flushCalls: SessionLike[] = []
  readonly liveSessions = new Set<string>()
  readonly ops = new Map<string, string[]>()
  flushResult: boolean = true
  /** 恢复默认行为：返回 header.cwd 为该值的 handle（需先加入 liveSessions）。 */
  resumeCwd: string | undefined
  createImpl: ((input: CreateAgentInput) => Promise<AgentHandleLike>) | undefined
  resumeImpl: ((input: ResumeAgentInput) => Promise<AgentHandleLike>) | undefined

  currentModelSelection(): { provider: string; model: string } {
    return { provider: 'deepseek-official', model: 'deepseek-flash' }
  }

  record(sessionId: string, op: string): void {
    const list = this.ops.get(sessionId) ?? []
    list.push(op)
    this.ops.set(sessionId, list)
  }

  opsFor(sessionId: string): string[] {
    return this.ops.get(sessionId) ?? []
  }

  makeHandle(
    sessionId: string,
    cwd: string,
    opts: { hangingDispose?: boolean; keepLive?: boolean; rejectDispose?: boolean } = {},
  ): AgentHandleLike {
    return {
      agent: {
        id: sessionId,
        session: { id: sessionId, header: { cwd } },
        followup: (): void => {
          this.record(sessionId, 'followup')
        },
        cancel: (): void => {
          this.record(sessionId, 'cancel')
        },
        whenIdle: (): Promise<void> => {
          this.record(sessionId, 'whenIdle')
          return Promise.resolve()
        },
        inbox: {
          clear: (): void => {
            this.record(sessionId, 'inbox.clear')
          },
        },
        status: 'idle' as const,
      },
      dispose: (): Promise<void> => {
        this.record(sessionId, 'dispose')
        if (opts.hangingDispose === true) {
          return new Promise<void>(() => undefined)
        }
        if (opts.rejectDispose === true) {
          return Promise.reject(new Error('dispose rejected by host'))
        }
        if (opts.keepLive !== true) {
          this.liveSessions.delete(sessionId)
        }
        return Promise.resolve()
      },
    }
  }

  async createAgent(input: CreateAgentInput): Promise<AgentHandleLike> {
    this.created.push(input)
    if (this.createImpl !== undefined) {
      return await this.createImpl(input)
    }
    this.liveSessions.add(input.sessionId)
    return this.makeHandle(input.sessionId, input.cwd)
  }

  async resumeAgent(input: ResumeAgentInput): Promise<AgentHandleLike> {
    this.resumed.push(input)
    if (this.resumeImpl !== undefined) {
      return await this.resumeImpl(input)
    }
    if (this.resumeCwd !== undefined) {
      this.liveSessions.add(input.sessionId)
      return this.makeHandle(input.sessionId, this.resumeCwd)
    }
    throw new Error('FakeHost: resume behavior not configured (resumeImpl/resumeCwd)')
  }

  async flushSession(session: SessionLike): Promise<boolean> {
    this.flushCalls.push(session)
    this.record(session.id, 'flush')
    return this.flushResult
  }

  isAgentLive(sessionId: string): boolean {
    return this.liveSessions.has(sessionId)
  }
}

interface ManagerOptions {
  host?: FakeHost
  store?: StateStore
  config?: { idleAgentTtlMs?: number; maxLiveAgents?: number; maxConcurrent?: number }
  now?: () => number
  mono?: () => number
  uuid?: () => string
  reapIntervalMs?: number
}

function makeManager(options: ManagerOptions = {}): {
  manager: ReturnType<typeof createSessionManager>
  host: FakeHost
  store: StateStore
  logs: string[]
} {
  const logs: string[] = []
  const logger = createGatewayLogger({ debug: false, sink: (line) => logs.push(line) })
  const host = options.host ?? new FakeHost()
  const store =
    options.store ??
    createStateStore({ stateDir: join(dir, 'state'), limits: GATEWAY_LIMITS, logger })
  const manager = createSessionManager({
    host,
    store,
    workspaceRoot: wsRoot,
    config: {
      idleAgentTtlMs: options.config?.idleAgentTtlMs ?? 900_000,
      maxLiveAgents: options.config?.maxLiveAgents ?? 32,
      maxConcurrent: options.config?.maxConcurrent ?? 4,
    },
    limits: GATEWAY_LIMITS,
    logger,
    now: options.now,
    mono: options.mono,
    uuid: options.uuid,
    reapIntervalMs: options.reapIntervalMs,
  })
  return { manager, host, store, logs }
}

async function makeReadyManager(options: ManagerOptions = {}) {
  const made = makeManager(options)
  await made.store.load()
  return made
}

/** resolve 成功结果；失败时直接让用例炸出。 */
function expectPrepared(
  result: PreparedSession | { error: { kind: string } },
): PreparedSession {
  if ('error' in result) {
    throw new Error(`expected prepared session, got error: ${result.error.kind}`)
  }
  return result
}

function expectError(
  result: PreparedSession | { error: { kind: string } },
): { kind: string } {
  if (!('error' in result)) {
    throw new Error('expected error result, got prepared session')
  }
  return result.error
}

/** 预置一条映射记录（真实 store 事务）。 */
async function seedRecord(
  store: StateStore,
  ident: { channelId: string; accountId: string; peerId: string },
  sessionId: string,
  generation = 1,
): Promise<void> {
  const bindingId = computeBindingId(ident)
  const timestamp = '2026-10-20T12:00:00.000Z'
  await store.runTransaction((draft) => {
    draft.set(bindingId, {
      channelId: ident.channelId,
      accountId: ident.accountId,
      peerId: ident.peerId,
      sessionId,
      generation,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
  })
}

describe('session-manager: 首次创建（7.4.2-7.4.3）', () => {
  it('全链路：目录创建、createAgent 入参、flush true、映射提交 generation=1、ISO 时间戳', async () => {
    const ident = identity(1)
    const bindingId = computeBindingId(ident)
    const { manager, host, store, logs } = await makeReadyManager({ uuid: uuidSeq() })

    const prepared = expectPrepared(await manager.prepare({ identity: ident, signal: freshSignal() }))

    expect(prepared.recreated).toBe(false)
    expect(prepared.reusedCached).toBe(false)
    expect(prepared.bindingId).toBe(bindingId)
    expect(prepared.generation).toBe(1)
    expect(prepared.sessionId).toBe('00000000-0000-4000-8000-000000000001')

    expect(existsSync(join(wsRoot, bindingId))).toBe(true)
    expect(host.created).toHaveLength(1)
    expect(host.created[0].sessionId).toBe(prepared.sessionId)
    expect(host.created[0].cwd).toBe(resolveWorkspaceDir(wsRoot, bindingId))
    expect(host.created[0].agentOptions).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
    expect(host.flushCalls.map((s) => s.id)).toEqual([prepared.sessionId])

    const record = store.getBinding(bindingId)
    if (record === undefined) {
      throw new Error('binding record missing after prepare')
    }
    expect(record).toMatchObject({
      channelId: 'qq',
      accountId: 'app-1',
      peerId: 'peer-1',
      sessionId: prepared.sessionId,
      generation: 1,
    })
    expect(record.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
    expect(record.updatedAt).toBe(record.createdAt)
    expect(logs.some((line) => line.includes('"session_created"'))).toBe(true)
    expect(manager.stats()).toEqual({ liveHandles: 1, busyHandles: 1 })
  })

  it('身份段非法 → creation-failed，不创建目录、agent 或映射', async () => {
    const { manager, host, store, logs } = await makeReadyManager({ uuid: uuidSeq() })
    const error = expectError(
      await manager.prepare({
        identity: { channelId: 'qq', accountId: 'app_1', peerId: 'peer-1' },
        signal: freshSignal(),
      }),
    )

    expect(error.kind).toBe('creation-failed')
    expect(host.created).toHaveLength(0)
    expect(store.snapshot().bindings).toEqual({})
    expect(logs.some((line) => line.includes('invalid identity'))).toBe(true)
  })

  it('flush false → creation-failed，映射不提交，handle 尽力 dispose', async () => {
    const ident = identity(2)
    const bindingId = computeBindingId(ident)
    const { manager, host, store } = await makeReadyManager({ uuid: uuidSeq() })
    host.flushResult = false

    const error = expectError(await manager.prepare({ identity: ident, signal: freshSignal() }))

    expect(error.kind).toBe('creation-failed')
    expect(store.getBinding(bindingId)).toBeUndefined()
    const sessionId = host.created[0].sessionId
    await vi.waitFor(() => {
      expect(host.opsFor(sessionId)).toContain('dispose')
    })
    expect(manager.stats().liveHandles).toBe(0)
  })
})

describe('session-manager: 缓存复用（7.4.1）', () => {
  it('同身份二次 prepare 返回同一 handle；generation 变化后不命中并走恢复', async () => {
    const ident = identity(3)
    const bindingId = computeBindingId(ident)
    const { manager, host, store } = await makeReadyManager({ uuid: uuidSeq() })

    const first = expectPrepared(await manager.prepare({ identity: ident, signal: freshSignal() }))
    manager.markIdle(first.handle)

    const second = expectPrepared(await manager.prepare({ identity: ident, signal: freshSignal() }))
    expect(second.handle).toBe(first.handle)
    expect(second.reusedCached).toBe(true)
    expect(second.generation).toBe(1)
    expect(host.created).toHaveLength(1)
    expect(host.resumed).toHaveLength(0)

    // 手动改映射 generation：缓存条目不再健康 → 走恢复路径。
    await store.runTransaction((draft) => {
      const record = draft.get(bindingId)
      if (record === undefined) {
        throw new Error('record missing')
      }
      draft.set(bindingId, { ...record, generation: 2 })
    })
    host.resumeCwd = resolveWorkspaceDir(wsRoot, bindingId)

    const third = expectPrepared(await manager.prepare({ identity: ident, signal: freshSignal() }))
    expect(third.reusedCached).toBe(false)
    expect(third.handle).not.toBe(first.handle)
    expect(third.generation).toBe(2)
    expect(host.resumed).toHaveLength(1)
    expect(host.resumed[0].sessionId).toBe(first.sessionId)
    // 旧缓存 handle 被异步释放，缓存仍只有一条。
    await vi.waitFor(() => {
      expect(host.opsFor(first.sessionId)).toContain('dispose')
    })
    expect(manager.stats().liveHandles).toBe(1)
  })
})

describe('session-manager: 恢复与重建（7.4.4、7.5）', () => {
  it('恢复路径：resumeAgent 收到映射 sessionId，cwd 一致时 inbox.clear 并成功', async () => {
    const ident = identity(4)
    const bindingId = computeBindingId(ident)
    const { manager, host, store, logs } = await makeReadyManager({ uuid: uuidSeq() })
    const oldSessionId = '11111111-2222-4333-8444-555555555555'
    await seedRecord(store, ident, oldSessionId)
    host.resumeCwd = resolveWorkspaceDir(wsRoot, bindingId)

    const prepared = expectPrepared(await manager.prepare({ identity: ident, signal: freshSignal() }))

    expect(host.resumed).toHaveLength(1)
    expect(host.resumed[0].sessionId).toBe(oldSessionId)
    expect(host.created).toHaveLength(0)
    expect(host.resumed[0].agentOptions).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
    expect(host.opsFor(oldSessionId)).toContain('inbox.clear')
    expect(prepared.recreated).toBe(false)
    expect(prepared.reusedCached).toBe(false)
    expect(prepared.sessionId).toBe(oldSessionId)
    expect(prepared.generation).toBe(1)
    expect(logs.some((line) => line.includes('"session_resumed"'))).toBe(true)
  })

  it('持久 cwd 不一致 → 重建：新 sessionId、generation+1、recreated=true、旧 handle 释放', async () => {
    const ident = identity(5)
    const bindingId = computeBindingId(ident)
    const { manager, host, store, logs } = await makeReadyManager({ uuid: uuidSeq() })
    const oldSessionId = '11111111-2222-4333-8444-666666666666'
    await seedRecord(store, ident, oldSessionId)
    const elsewhere = join(dir, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    host.resumeCwd = elsewhere

    const prepared = expectPrepared(await manager.prepare({ identity: ident, signal: freshSignal() }))

    expect(prepared.recreated).toBe(true)
    expect(prepared.sessionId).not.toBe(oldSessionId)
    expect(prepared.generation).toBe(2)
    expect(host.resumed).toHaveLength(1)
    expect(host.created).toHaveLength(1)
    const record = store.getBinding(bindingId)
    if (record === undefined) {
      throw new Error('record missing')
    }
    expect(record.sessionId).toBe(prepared.sessionId)
    expect(record.generation).toBe(2)
    // 重建提示事件记录旧 session 与原因；cwd 不一致的旧 handle 释放且不清 inbox。
    expect(
      logs.some((line) => line.includes('"session_recreated"') && line.includes(oldSessionId) && line.includes('cwd_mismatch')),
    ).toBe(true)
    await vi.waitFor(() => {
      expect(host.opsFor(oldSessionId)).toContain('dispose')
    })
    expect(host.opsFor(oldSessionId)).not.toContain('inbox.clear')
  })

  it('resumeAgent 抛错 → 重建：generation+1、新 sessionId、recreated=true', async () => {
    const ident = identity(6)
    const bindingId = computeBindingId(ident)
    const { manager, host, store } = await makeReadyManager({ uuid: uuidSeq() })
    const oldSessionId = '11111111-2222-4333-8444-777777777777'
    await seedRecord(store, ident, oldSessionId)
    host.resumeImpl = (): Promise<AgentHandleLike> => Promise.reject(new Error('session log unreadable'))

    const prepared = expectPrepared(await manager.prepare({ identity: ident, signal: freshSignal() }))

    expect(prepared.recreated).toBe(true)
    expect(prepared.generation).toBe(2)
    expect(host.created).toHaveLength(1)
    expect(host.created[0].sessionId).toBe(prepared.sessionId)
    const record = store.getBinding(bindingId)
    expect(record?.sessionId).toBe(prepared.sessionId)
    expect(record?.generation).toBe(2)
  })

  it('重建后新建也失败 → creation-failed，旧映射记录保持不变', async () => {
    const ident = identity(7)
    const { manager, host, store, logs } = await makeReadyManager({ uuid: uuidSeq() })
    const oldSessionId = '11111111-2222-4333-8444-888888888888'
    await seedRecord(store, ident, oldSessionId)
    const before = JSON.stringify(store.snapshot())
    host.resumeImpl = (): Promise<AgentHandleLike> => Promise.reject(new Error('gone'))
    host.createImpl = (): Promise<AgentHandleLike> => Promise.reject(new Error('dsh create failed'))

    const error = expectError(await manager.prepare({ identity: ident, signal: freshSignal() }))

    expect(error.kind).toBe('creation-failed')
    expect(JSON.stringify(store.snapshot())).toBe(before)
    expect(host.created).toHaveLength(1)
    expect(host.flushCalls).toHaveLength(0)
    expect(logs.some((line) => line.includes('"session_recreated"'))).toBe(true)
    expect(logs.some((line) => line.includes('agent recreate failed'))).toBe(true)
  })

  it('state-store failed → fatal', async () => {
    const ident = identity(8)
    const logs: string[] = []
    const logger = createGatewayLogger({ debug: false, sink: (line) => logs.push(line) })
    const io: StateStoreIo = {
      ...createDefaultStateStoreIo(),
      writeFile: async () => {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      },
    }
    const store = createStateStore({ stateDir: join(dir, 'state-broken'), limits: GATEWAY_LIMITS, logger, io })
    await store.load()
    const host = new FakeHost()
    const manager = createSessionManager({
      host,
      store,
      workspaceRoot: wsRoot,
      config: { idleAgentTtlMs: 900_000, maxLiveAgents: 32, maxConcurrent: 4 },
      limits: GATEWAY_LIMITS,
      logger,
      uuid: uuidSeq(),
    })

    const error = expectError(await manager.prepare({ identity: ident, signal: freshSignal() }))

    expect(error.kind).toBe('fatal')
    expect(store.isFailed()).toBe(true)
    // 已创建的 handle 尽力释放。
    const sessionId = host.created[0].sessionId
    await vi.waitFor(() => {
      expect(host.opsFor(sessionId)).toContain('dispose')
    })
  })
})

describe('session-manager: 中止与晚到 handle（7.4.5）', () => {
  it('createAgent 在 abort 后才 resolve → aborted、handle 已释放、无缓存、无映射', async () => {
    const ident = identity(9)
    const bindingId = computeBindingId(ident)
    const { manager, host, store } = await makeReadyManager({ uuid: uuidSeq() })
    host.createImpl = (input: CreateAgentInput): Promise<AgentHandleLike> => {
      return new Promise((resolve) => {
        input.signal.addEventListener('abort', () => {
          setTimeout(() => resolve(host.makeHandle(input.sessionId, input.cwd)), 0)
        })
      })
    }
    const controller = new AbortController()
    const pending = manager.prepare({ identity: ident, signal: controller.signal })
    await vi.waitFor(() => {
      expect(host.created).toHaveLength(1)
    })

    controller.abort()
    const error = expectError(await pending)

    expect(error.kind).toBe('aborted')
    const sessionId = host.created[0].sessionId
    await vi.waitFor(() => {
      expect(host.opsFor(sessionId)).toContain('dispose')
    })
    expect(manager.stats()).toEqual({ liveHandles: 0, busyHandles: 0 })
    expect(store.getBinding(bindingId)).toBeUndefined()
  })

  it('signal 已中止时直接返回 aborted，不触发任何宿主调用', async () => {
    const ident = identity(10)
    const { manager, host } = await makeReadyManager({ uuid: uuidSeq() })
    const controller = new AbortController()
    controller.abort()

    const error = expectError(await manager.prepare({ identity: ident, signal: controller.signal }))

    expect(error.kind).toBe('aborted')
    expect(host.created).toHaveLength(0)
  })
})

describe('session-manager: LRU 容量（6.3）', () => {
  it('maxLiveAgents=2：插入第 3 个时空闲 LRU 被逐出（Map 移除、释放异步）；全忙时等待 markIdle', async () => {
    const { manager, host } = await makeReadyManager({
      config: { maxLiveAgents: 2 },
      uuid: uuidSeq(),
    })
    const identA = identity(21)
    const identB = identity(22)
    const identC = identity(23)
    const bindingA = computeBindingId(identA)

    const a = expectPrepared(await manager.prepare({ identity: identA, signal: freshSignal() }))
    manager.markIdle(a.handle)
    const b = expectPrepared(await manager.prepare({ identity: identB, signal: freshSignal() }))
    manager.markIdle(b.handle)
    expect(manager.stats()).toEqual({ liveHandles: 2, busyHandles: 0 })

    // 第 3 个身份：最久未使用的空闲 entry（A）被同步逐出、异步释放。
    const c = expectPrepared(await manager.prepare({ identity: identC, signal: freshSignal() }))
    expect(manager.stats()).toEqual({ liveHandles: 2, busyHandles: 1 })
    await vi.waitFor(() => {
      expect(host.opsFor(a.sessionId)).toContain('dispose')
    })

    // A 的映射仍在，恢复 A（resume 路径）会逐出空闲的 B，缓存变为全忙（C、A2）。
    host.resumeCwd = resolveWorkspaceDir(wsRoot, bindingA)
    expectPrepared(await manager.prepare({ identity: identA, signal: freshSignal() }))
    expect(manager.stats()).toEqual({ liveHandles: 2, busyHandles: 2 })

    // 全忙：第 3 个准备等待执行槽释放，尚未到达 createAgent。
    const identE = identity(25)
    const controller = new AbortController()
    const pendingE = manager.prepare({ identity: identE, signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 30))
    // uuid 序列：a=1、b=2、c=3，A2 走恢复不消耗 uuid，E 应为 4。
    expect(host.created.filter((input) => input.sessionId.endsWith('000000000004'))).toHaveLength(0)

    // 某个 entry markIdle 后等待者继续：逐出刚空闲的 C，插入 E。
    manager.markIdle(c.handle)
    const e = expectPrepared(await pendingE)
    expect(e.sessionId).toBe('00000000-0000-4000-8000-000000000004')
    expect(manager.stats().liveHandles).toBe(2)

    // 等待中的 prepare 在 signal abort 后返回 aborted。
    const identF = identity(26)
    const controllerF = new AbortController()
    const pendingF = manager.prepare({ identity: identF, signal: controllerF.signal })
    await new Promise((resolve) => setTimeout(resolve, 20))
    controllerF.abort()
    expect(expectError(await pendingF).kind).toBe('aborted')
  })
})

describe('session-manager: 空闲回收（6.3）', () => {
  it('空闲超过 idleAgentTtlMs 被 releaseHandle 回收；busy entry 不回收', async () => {
    let fakeMono = 0
    const { manager, host } = await makeReadyManager({
      config: { idleAgentTtlMs: 1_000 },
      mono: () => fakeMono,
      reapIntervalMs: 10,
      uuid: uuidSeq(),
    })
    const identA = identity(31)
    const identB = identity(32)

    const a = expectPrepared(await manager.prepare({ identity: identA, signal: freshSignal() }))
    manager.markIdle(a.handle)
    const b = expectPrepared(await manager.prepare({ identity: identB, signal: freshSignal() }))

    manager.start()
    try {
      fakeMono += 1_001
      await vi.waitFor(() => {
        expect(manager.stats().liveHandles).toBe(1)
      })
      await vi.waitFor(() => {
        expect(host.opsFor(a.sessionId)).toContain('dispose')
      })
      // busy entry（B）不回收（唯一操作是创建路径的 publish flush）。
      expect(host.opsFor(b.sessionId)).toEqual(['flush'])
      fakeMono += 5_000
      await new Promise((resolve) => setTimeout(resolve, 40))
      expect(manager.stats()).toEqual({ liveHandles: 1, busyHandles: 1 })
      expect(host.opsFor(b.sessionId)).toEqual(['flush'])
    } finally {
      await manager.stop()
    }
  })

  it('stop 后不再回收', async () => {
    let fakeMono = 0
    const { manager, host } = await makeReadyManager({
      config: { idleAgentTtlMs: 1_000 },
      mono: () => fakeMono,
      reapIntervalMs: 10,
      uuid: uuidSeq(),
    })
    const a = expectPrepared(await manager.prepare({ identity: identity(33), signal: freshSignal() }))
    manager.markIdle(a.handle)
    manager.start()
    await manager.stop()
    fakeMono += 5_000
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(manager.stats().liveHandles).toBe(1)
    // 只剩创建路径的 publish flush，无任何释放操作。
    expect(host.opsFor(a.sessionId)).toEqual(['flush'])
  })

  it('空闲 TTL 只看单调时钟：墙钟大幅前进不触发回收', async () => {
    const fakeMono = 10_000_000
    let fakeNow = 0
    const { manager, host } = await makeReadyManager({
      config: { idleAgentTtlMs: 1_000 },
      now: () => fakeNow,
      mono: () => fakeMono,
      reapIntervalMs: 10,
      uuid: uuidSeq(),
    })
    const a = expectPrepared(await manager.prepare({ identity: identity(34), signal: freshSignal() }))
    manager.markIdle(a.handle)
    manager.start()
    try {
      fakeNow += 10_000_000
      await new Promise((resolve) => setTimeout(resolve, 40))
      expect(manager.stats().liveHandles).toBe(1)
      expect(host.opsFor(a.sessionId)).toEqual(['flush'])
    } finally {
      await manager.stop()
    }
  })
})

describe('session-manager: releaseHandle（9.2）', () => {
  it('cancelled 路径按 cancel→whenIdle→flush→dispose 顺序执行；成功且退出 live registry 后移除缓存', async () => {
    const { manager, host } = await makeReadyManager({ uuid: uuidSeq() })
    const a = expectPrepared(await manager.prepare({ identity: identity(41), signal: freshSignal() }))

    const outcome = await manager.releaseHandle(a.handle, { cancelled: true, deadlineMs: 2_000 })

    expect(outcome).toBe('disposed')
    // 首个 flush 是创建路径的 publish flush；随后是释放序列 cancel→whenIdle→flush→dispose。
    expect(host.opsFor(a.sessionId)).toEqual(['flush', 'cancel', 'whenIdle', 'flush', 'dispose'])
    expect(host.flushCalls.map((s) => s.id)).toContain(a.sessionId)
    expect(manager.stats()).toEqual({ liveHandles: 0, busyHandles: 0 })
  })

  it('dispose 挂起 → timeout 且 entry 标记 stuck；重复调用不再释放尝试', async () => {
    const { manager, host, logs } = await makeReadyManager({ uuid: uuidSeq() })
    const ident = identity(42)
    host.createImpl = (input: CreateAgentInput): Promise<AgentHandleLike> => {
      host.liveSessions.add(input.sessionId)
      return Promise.resolve(host.makeHandle(input.sessionId, input.cwd, { hangingDispose: true }))
    }
    const a = expectPrepared(await manager.prepare({ identity: ident, signal: freshSignal() }))

    const outcome = await manager.releaseHandle(a.handle, { deadlineMs: 60 })

    expect(outcome).toBe('timeout')
    expect(manager.stats()).toEqual({ liveHandles: 1, busyHandles: 1 })
    expect(logs.some((line) => line.includes('"manual_restart_required"'))).toBe(true)
    const opsAfterTimeout = host.opsFor(a.sessionId).slice()
    expect(opsAfterTimeout).toContain('dispose')

    const again = await manager.releaseHandle(a.handle, { deadlineMs: 2_000 })
    expect(again).toBe('timeout')
    expect(host.opsFor(a.sessionId)).toEqual(opsAfterTimeout)
  })

  it('dispose 以 reject 失败 → timeout、entry 标 stuck、缓存不被移除（9.2.5）', async () => {
    const { manager, host, logs } = await makeReadyManager({ uuid: uuidSeq() })
    const ident = identity(45)
    host.createImpl = (input: CreateAgentInput): Promise<AgentHandleLike> => {
      host.liveSessions.add(input.sessionId)
      return Promise.resolve(host.makeHandle(input.sessionId, input.cwd, { rejectDispose: true }))
    }
    const a = expectPrepared(await manager.prepare({ identity: ident, signal: freshSignal() }))

    const outcome = await manager.releaseHandle(a.handle, { deadlineMs: 2_000 })

    // dispose rejected = 清理未成功结束：不得移除缓存放行下一次 resume。
    expect(outcome).toBe('timeout')
    expect(manager.stats()).toEqual({ liveHandles: 1, busyHandles: 1 })
    expect(logs.some((line) => line.includes('handle dispose rejected'))).toBe(true)
    expect(
      logs.some((line) => line.includes('"manual_restart_required"') && line.includes('did not converge')),
    ).toBe(true)
    const opsAfterFailure = host.opsFor(a.sessionId).slice()
    expect(opsAfterFailure).toContain('dispose')

    // stuck：重复调用不再尝试释放。
    const again = await manager.releaseHandle(a.handle, { deadlineMs: 2_000 })
    expect(again).toBe('timeout')
    expect(host.opsFor(a.sessionId)).toEqual(opsAfterFailure)
  })

  it('dispose 成功但 isAgentLive=true → 不移除缓存并记日志', async () => {
    const { manager, host, logs } = await makeReadyManager({ uuid: uuidSeq() })
    const ident = identity(43)
    host.createImpl = (input: CreateAgentInput): Promise<AgentHandleLike> => {
      // dispose 正常结束但保留 liveSessions，模拟 registry 未退出。
      host.liveSessions.add(input.sessionId)
      return Promise.resolve(host.makeHandle(input.sessionId, input.cwd, { keepLive: true }))
    }
    const a = expectPrepared(await manager.prepare({ identity: ident, signal: freshSignal() }))

    const outcome = await manager.releaseHandle(a.handle, { deadlineMs: 2_000 })

    expect(outcome).toBe('disposed')
    expect(manager.stats()).toEqual({ liveHandles: 1, busyHandles: 1 })
    // 仍 live 属需人工处理信号（修复后与 stuck/未收敛一致用 manual_restart_required）。
    expect(
      logs.some((line) => line.includes('"manual_restart_required"') && line.includes('still live in registry')),
    ).toBe(true)
  })

  it('markIdle 未知 handle 为 no-op', async () => {
    const { manager, host } = await makeReadyManager({ uuid: uuidSeq() })
    const a = expectPrepared(await manager.prepare({ identity: identity(44), signal: freshSignal() }))
    await manager.releaseHandle(a.handle, { deadlineMs: 2_000 })
    expect(() => manager.markIdle(a.handle)).not.toThrow()
    expect(host.opsFor(a.sessionId)).toEqual(['flush', 'whenIdle', 'flush', 'dispose'])
  })

  it('释放预算走单调时钟：mono 越过 deadline 即 timeout，墙钟推进不参与判定（6.2/9.1）', async () => {
    const fixedWall = Date.parse('2026-10-21T08:00:00.000Z')
    let monoValue = 1_000_000
    const { manager, host, store } = await makeReadyManager({
      now: () => fixedWall,
      mono: () => {
        monoValue += 100_000
        return monoValue
      },
      uuid: uuidSeq(),
    })
    const ident = identity(46)
    const a = expectPrepared(await manager.prepare({ identity: ident, signal: freshSignal() }))
    // 映射的持久化时间戳仍取墙钟，不随单调时钟推进。
    expect(store.getBinding(computeBindingId(ident))?.updatedAt).toBe(
      new Date(fixedWall).toISOString(),
    )

    const outcome = await manager.releaseHandle(a.handle, { deadlineMs: 60 })

    expect(outcome).toBe('timeout')
    // whenIdle 已启动但预算即刻耗尽：flush 与 dispose 均未尝试。
    expect(host.opsFor(a.sessionId)).toEqual(['flush', 'whenIdle'])
  })
})

describe('session-manager: 目录逃逸（11.2）', () => {
  it('身份目录是指向外部目录的 junction/symlink → creation-failed 并记日志', async () => {
    const ident = identity(51)
    const bindingId = computeBindingId(ident)
    // Windows 上 symlink 需要特权；junction 无需特权（本机为 Windows，用 junction 形式，
    // 非 win32 环境退回普通 symlink）。
    const outside = mkdtempSync(join(tmpdir(), 'gw-outside-'))
    try {
      try {
        symlinkSync(outside, join(wsRoot, bindingId), 'junction')
      } catch {
        symlinkSync(outside, join(wsRoot, bindingId))
      }

      const { manager, host, logs } = await makeReadyManager({ uuid: uuidSeq() })
      const error = expectError(await manager.prepare({ identity: ident, signal: freshSignal() }))

      expect(error.kind).toBe('creation-failed')
      expect(host.created).toHaveLength(0)
      expect(logs.some((line) => line.includes('escapes the identity boundary'))).toBe(true)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('resolveWorkspaceDir 正常路径返回 root/bindingId 的 realpath', () => {
    const bindingId = computeBindingId(identity(52))
    const resolved = resolveWorkspaceDir(wsRoot, bindingId)
    expect(resolved).toBe(join(realpathSync(wsRoot), bindingId))
    expect(existsSync(resolved)).toBe(true)
  })

  it('bindingId 非法时直接拒绝', () => {
    for (const bindingId of ['../escape', 'qq_app-1', 'qq_app-1_', 'qq_app-1_peer/child', '0'.repeat(64)]) {
      expect(() => resolveWorkspaceDir(wsRoot, bindingId)).toThrow(/invalid bindingId/)
    }
  })
})
