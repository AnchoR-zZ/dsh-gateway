import { mkdir, open, readFile as readFileFs, rename as renameFs } from 'node:fs/promises'
import { join } from 'node:path'

import { computeBindingId, GATEWAY_LIMITS, isValidBindingId } from '../contracts.js'
import type { GatewayLogger } from '../logging.js'

/**
 * core/state-store：平台身份到 dsh session 映射（`<stateDir>/bindings.json`）的 schema 校验、
 * 串行写事务与原子替换（设计文档 7 节）。core 的持久层，不保存消息正文、不知道 dsh session
 * 文件的存在、不做版本迁移（仅 schema 1，未来迁移走显式脚本）。
 *
 * 所有事务共享一个进程内串行队列；每个事务从最新已提交快照派生草稿，持久化序列全部成功后才
 * 发布新的内存快照（先写盘后改内存，不先改内存再后台保存）。持久化失败或超时后 store 转入
 * failed：保留最近已提交状态、`onFailed` 触发一次、后续事务直接拒绝；failed 不可自动恢复，
 * 只能重建 store——持久映射不可用时不能继续处理新消息（7.3）。
 */

/** 当前唯一支持的映射 schema 版本；未知版本在 load 时拒绝启动。T10 启动摘要日志引用。 */
export const SCHEMA_VERSION = 1

/** 映射文件中 bindings 值的形状；全部字段由调用方提供，store 不代填业务字段（含时间戳）。 */
export interface BindingRecord {
  readonly channelId: string
  readonly accountId: string
  readonly peerId: string
  readonly sessionId: string
  readonly generation: number
  readonly createdAt: string
  readonly updatedAt: string
}

/** 已提交快照；revision 由 store 在每次成功事务后 +1，mutate 不接触它。 */
export interface BindingsSnapshot {
  readonly schemaVersion: 1
  readonly revision: number
  readonly bindings: Readonly<Record<string, BindingRecord>>
}

/** 映射持久层；生命周期由 core/lifecycle 持有，failed 后只能重建，不能复用。 */
export interface StateStore {
  /**
   * 读取并校验 `<stateDir>/bindings.json`。目录或文件不存在视为首次部署，初始化内存空状态，
   * 不立即写文件（首个事务才落盘）；JSON 损坏、校验失败或读取 IO 错误抛 StateStoreError，
   * 由调用方决定停止，不能跳过坏记录继续启动。重复调用为 no-op（幂等口径）；
   * 首次失败后再次调用会重新尝试读取。
   */
  load(): Promise<void>
  /** 读当前已提交快照中的单条映射；load 前调用得到空态结果。 */
  getBinding(bindingId: string): BindingRecord | undefined
  /** 当前已提交快照；返回的 bindings 已冻结，只能通过 runTransaction 变更。 */
  snapshot(): BindingsSnapshot
  /**
   * 串行事务：mutate 直接修改从最新已提交快照派生的草稿 Map（set/delete），返回后按 7.3
   * 写入序列持久化，成功后发布新快照并 resolve。mutate 抛错或草稿校验失败 → 不写盘、
   * 状态不变、store 保持可用；持久化失败或超时 → 事务 reject 且 store 转 failed。
   * load 成功之前调用直接 reject。
   */
  runTransaction<T>(mutate: (draft: Map<string, BindingRecord>) => T | Promise<T>): Promise<T>
  /** 订阅 failed 转换；转换发生时每个已注册监听器恰好触发一次，failed 后注册的监听器不补发。 */
  onFailed(listener: (error: unknown) => void): void
  /**
   * 等待已提交的在途事务排空（正常停机路径；不产生新写入）。超时后被放弃的底层写操作
   * 无法从 JS 取消，不受 flushNow 等待——有界停机预算优先于无法完成的排空。
   */
  flushNow(): Promise<void>
  isFailed(): boolean
}

/** 状态存储错误：load 校验失败、事务前拒绝或持久化失败/超时；message 只含原因，不含记录内容。 */
export class StateStoreError extends Error {
  /** 超时类失败标记，内部用于与 IO 错误区分。 */
  readonly isTimeout: boolean

  constructor(message: string, options?: { isTimeout?: boolean; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'StateStoreError'
    this.isTimeout = options?.isTimeout ?? false
  }
}

/**
 * 文件系统接缝：默认实现走 node:fs/promises。独立成可注入接口是因为 Windows 上难以在测试中
 * 稳定复现 EPERM/EBUSY 文件占用与"卡住"的写操作，持久化失败与超时路径用替身验证。
 */
export interface StateStoreIo {
  /** 确保状态目录存在（recursive，首次落盘前调用一次）。 */
  ensureDir(path: string): Promise<void>
  /** 读取主文件；不存在时以 ENOENT 码拒绝。 */
  readFile(path: string): Promise<string>
  /** 以 open/write/fsync/close 的显式形式落盘单个文件（临时文件）。 */
  writeFile(path: string, content: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** 同步父目录；win32 上通常以 EPERM 失败（实测），由 store 降级为一次性告警。 */
  fsyncDir(path: string): Promise<void>
}

/** 默认文件系统实现；导出供测试包装替身与装配复用。 */
export function createDefaultStateStoreIo(): StateStoreIo {
  return {
    async ensureDir(path) {
      await mkdir(path, { recursive: true })
    },
    async readFile(path) {
      return await readFileFs(path, 'utf8')
    },
    async writeFile(path, content) {
      const handle = await open(path, 'w')
      try {
        await handle.writeFile(content, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
    },
    async rename(from, to) {
      await renameFs(from, to)
    },
    async fsyncDir(path) {
      const handle = await open(path, 'r')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    },
  }
}

export interface CreateStateStoreOptions {
  stateDir: string
  limits: typeof GATEWAY_LIMITS
  logger: GatewayLogger
  /** 单调时钟，用于事务期限判定；默认 performance.now()，测试可注入。 */
  now?: () => number
  /** 文件系统接缝；省略时使用 node:fs/promises 默认实现。 */
  io?: StateStoreIo
}

/** 主文件替换在 win32 文件占用（EPERM/EBUSY/ENOTEMPTY/EACCES）下的退避重试参数。 */
const RENAME_RETRY_ATTEMPTS = 3
const RENAME_RETRY_DELAY_MS = 100
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'])

/** sessionId：任意版本的 UUID（8-4-4-4-12 位十六进制）。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** createdAt/updatedAt：受限的 ISO 8601 形态，避免 Date.parse 接受的非 ISO 文本混入。 */
const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

function isRetryableRenameError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && RETRYABLE_RENAME_CODES.has(code)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_8601_PATTERN.test(value) && !Number.isNaN(Date.parse(value))
}

/** 把同步抛出的接缝调用统一成 rejected Promise，简化调用点的竞速处理。 */
function startOp<T>(start: () => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(start())
  } catch (err) {
    return Promise.reject(err)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 校验单个 binding 记录并返回冻结副本；bindingId 是身份键，可出现在错误消息中。 */
function validateAndCloneRecord(bindingId: string, value: unknown): BindingRecord {
  if (!isPlainObject(value)) {
    throw new StateStoreError(`binding ${bindingId}: record must be an object`)
  }
  for (const field of ['channelId', 'accountId', 'peerId'] as const) {
    if (typeof value[field] !== 'string' || value[field] === '') {
      throw new StateStoreError(`binding ${bindingId}: ${field} must be a non-empty string`)
    }
  }
  if (typeof value.sessionId !== 'string' || !UUID_PATTERN.test(value.sessionId)) {
    throw new StateStoreError(`binding ${bindingId}: sessionId is not a valid UUID`)
  }
  if (
    typeof value.generation !== 'number' ||
    !Number.isInteger(value.generation) ||
    value.generation < 1
  ) {
    throw new StateStoreError(`binding ${bindingId}: generation must be an integer >= 1`)
  }
  for (const field of ['createdAt', 'updatedAt'] as const) {
    if (!isValidTimestamp(value[field])) {
      throw new StateStoreError(`binding ${bindingId}: ${field} is not a valid ISO 8601 timestamp`)
    }
  }
  const identity = {
    channelId: value.channelId as string,
    accountId: value.accountId as string,
    peerId: value.peerId as string,
  }
  let expected: string
  try {
    expected = computeBindingId(identity)
  } catch (err) {
    throw new StateStoreError(
      `binding ${bindingId}: identity cannot form a binding id: ${errorMessage(err)}`,
    )
  }
  if (expected !== bindingId) {
    throw new StateStoreError(`binding ${bindingId}: key does not match identity`)
  }
  return Object.freeze({
    channelId: identity.channelId,
    accountId: identity.accountId,
    peerId: identity.peerId,
    sessionId: value.sessionId as string,
    generation: value.generation as number,
    createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string,
  })
}

/**
 * 校验键形态、记录字段与 sessionId 唯一性，返回规范化（逐条冻结）的 bindings 容器。
 * load 与事务草稿共用同一套规则；失败抛 StateStoreError，不跳过坏记录。
 */
function collectBindings(
  entries: Iterable<readonly [string, unknown]>,
): Readonly<Record<string, BindingRecord>> {
  const bindings: Record<string, BindingRecord> = {}
  const sessionIds = new Set<string>()
  for (const [key, value] of entries) {
    if (!isValidBindingId(key)) {
      throw new StateStoreError(
        'binding key must have the form <channelId>_<accountId>_<peerId> with safe characters',
      )
    }
    const record = validateAndCloneRecord(key, value)
    if (sessionIds.has(record.sessionId)) {
      throw new StateStoreError(`binding ${key}: sessionId is already used by another binding`)
    }
    sessionIds.add(record.sessionId)
    bindings[key] = record
  }
  return Object.freeze(bindings)
}

/** 校验整份文档（load 路径）；顶层缺 schemaVersion/revision 视为损坏，缺失 bindings 视为 {}。 */
function validateDocument(
  raw: string,
): { revision: number; bindings: Readonly<Record<string, BindingRecord>> } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new StateStoreError(`bindings.json is not valid JSON: ${errorMessage(err)}`)
  }
  if (!isPlainObject(parsed)) {
    throw new StateStoreError('bindings.json root must be an object')
  }
  if (parsed.schemaVersion === undefined) {
    throw new StateStoreError('bindings.json is missing schemaVersion')
  }
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new StateStoreError(
      `unsupported schemaVersion ${String(parsed.schemaVersion)}; only schema ${SCHEMA_VERSION} is supported`,
    )
  }
  if (parsed.revision === undefined) {
    throw new StateStoreError('bindings.json is missing revision')
  }
  if (
    typeof parsed.revision !== 'number' ||
    !Number.isInteger(parsed.revision) ||
    parsed.revision < 0
  ) {
    throw new StateStoreError(`revision must be a non-negative integer, got ${String(parsed.revision)}`)
  }
  const rawBindings: unknown = parsed.bindings === undefined ? {} : parsed.bindings
  if (!isPlainObject(rawBindings)) {
    throw new StateStoreError('bindings must be an object')
  }
  return { revision: parsed.revision, bindings: collectBindings(Object.entries(rawBindings)) }
}

/** 事务草稿校验：失败时以 "invalid draft" 前缀包装，与 load 的报错区分。 */
function validateDraft(draft: Map<string, BindingRecord>): Readonly<Record<string, BindingRecord>> {
  try {
    return collectBindings(draft.entries())
  } catch (err) {
    if (err instanceof StateStoreError) {
      throw new StateStoreError(`invalid draft: ${err.message}`)
    }
    throw err
  }
}

/** 主文件的规范化序列化形式；写盘与内存保存使用同一格式。 */
function serializeDocument(
  revision: number,
  bindings: Readonly<Record<string, BindingRecord>>,
): string {
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, revision, bindings }, null, 2)
}

export function createStateStore(options: CreateStateStoreOptions): StateStore {
  return new StateStoreImpl(options)
}

class StateStoreImpl implements StateStore {
  private readonly stateDir: string
  private readonly mainPath: string
  private readonly bakPath: string
  private readonly limits: typeof GATEWAY_LIMITS
  private readonly logger: GatewayLogger
  private readonly now: () => number
  private readonly io: StateStoreIo

  private loaded = false
  private failedError: unknown
  private readonly failureListeners: ((error: unknown) => void)[] = []
  /** 首次落盘前保证 stateDir 存在；load 从磁盘成功后目录必然存在。 */
  private dirEnsured = false
  private tmpSeq = 0

  private committedRevision = 0
  private committedBindings: Readonly<Record<string, BindingRecord>> = Object.freeze({})
  /** 最近成功写入主文件的内容；作为下一事务的备份来源（首次无快照时为 undefined）。 */
  private lastCommittedJson: string | undefined
  /** 串行事务队列尾；只关心排空，不关心成功失败。 */
  private queueTail: Promise<void> = Promise.resolve()
  /** 超时后被放弃但仍可能在途的底层写序列；排空追踪用。 */
  private pendingIo: Promise<unknown> | undefined
  /** 当前事务的单调时钟期限（now() 读数）。 */
  private deadlineAt = 0
  private dirFsyncWarningLogged = false

  constructor(options: CreateStateStoreOptions) {
    this.stateDir = options.stateDir
    this.mainPath = join(options.stateDir, 'bindings.json')
    this.bakPath = `${this.mainPath}.bak`
    this.limits = options.limits
    this.logger = options.logger
    this.now = options.now ?? (() => performance.now())
    this.io = options.io ?? createDefaultStateStoreIo()
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return
    }
    let raw: string
    try {
      raw = await this.io.readFile(this.mainPath)
    } catch (err) {
      if (isErrorCode(err, 'ENOENT')) {
        // 目录或文件不存在：首次部署。初始化内存空状态，不立即写文件，首个事务才落盘。
        this.loaded = true
        return
      }
      throw new StateStoreError(`failed to read bindings.json: ${errorMessage(err)}`, { cause: err })
    }
    const validated = validateDocument(raw)
    this.committedRevision = validated.revision
    this.committedBindings = validated.bindings
    this.lastCommittedJson = serializeDocument(validated.revision, validated.bindings)
    this.dirEnsured = true
    this.loaded = true
  }

  getBinding(bindingId: string): BindingRecord | undefined {
    return this.committedBindings[bindingId]
  }

  snapshot(): BindingsSnapshot {
    return {
      schemaVersion: SCHEMA_VERSION,
      revision: this.committedRevision,
      bindings: this.committedBindings,
    }
  }

  onFailed(listener: (error: unknown) => void): void {
    this.failureListeners.push(listener)
  }

  isFailed(): boolean {
    return this.failedError !== undefined
  }

  runTransaction<T>(mutate: (draft: Map<string, BindingRecord>) => T | Promise<T>): Promise<T> {
    if (this.failedError !== undefined) {
      return Promise.reject(new StateStoreError('state store has failed; manual recovery required'))
    }
    if (!this.loaded) {
      return Promise.reject(
        new StateStoreError('load() must succeed before running transactions'),
      )
    }
    // 排队执行：队列尾只在事务完全落定（含写盘与快照发布）后推进，事务间不交错。
    const run = this.queueTail.then(() => this.execute(mutate))
    this.queueTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async flushNow(): Promise<void> {
    await this.queueTail
  }

  private async execute<T>(mutate: (draft: Map<string, BindingRecord>) => T | Promise<T>): Promise<T> {
    if (this.failedError !== undefined) {
      throw new StateStoreError('state store has failed; manual recovery required')
    }
    const draft = new Map<string, BindingRecord>(Object.entries(this.committedBindings))
    const result = await mutate(draft)
    // 草稿校验失败属于调用方缺陷：不写盘、状态不变、store 保持可用。
    const bindings = validateDraft(draft)
    const revision = this.committedRevision + 1
    const doc = serializeDocument(revision, bindings)
    try {
      await this.persist(doc)
    } catch (err) {
      const wrapped =
        err instanceof StateStoreError
          ? err
          : new StateStoreError(`mapping write failed: ${errorMessage(err)}`, { cause: err })
      this.enterFailed(wrapped)
      throw wrapped
    }
    this.lastCommittedJson = doc
    this.committedRevision = revision
    this.committedBindings = bindings
    return result
  }

  /**
   * 7.3 写入序列：写临时文件 A → 上一份快照写 B 并原子替换 .bak（失败则不碰主文件）→
   * 原子替换主文件（win32 占用时退避重试，不先删旧主文件制造空窗）→ 尽力同步父目录。
   * 整个序列受事务单调期限约束；超时后事务失败，store 转 failed。
   */
  private async persist(doc: string): Promise<void> {
    this.deadlineAt = this.now() + this.limits.MAP_WRITE_TIMEOUT_MS
    const steps = this.persistSteps(doc)
    this.pendingIo = steps
    steps.then(
      () => {
        if (this.pendingIo === steps) {
          this.pendingIo = undefined
        }
      },
      () => {
        if (this.pendingIo === steps) {
          this.pendingIo = undefined
        }
      },
    )
    await this.withDeadline(steps)
  }

  private async persistSteps(doc: string): Promise<void> {
    if (!this.dirEnsured) {
      await this.withDeadline(startOp(() => this.io.ensureDir(this.stateDir)))
      this.dirEnsured = true
    }
    // 1. 完整新 JSON 写入同目录独占命名的临时文件 A，显式 fsync。
    const tmpMain = this.nextTmpPath()
    await this.withDeadline(startOp(() => this.io.writeFile(tmpMain, doc)))
    // 2. 上一份已提交快照写临时文件 B 并 fsync，原子替换备份；失败则不替换主文件。
    if (this.lastCommittedJson !== undefined) {
      const tmpBak = this.nextTmpPath()
      await this.withDeadline(startOp(() => this.io.writeFile(tmpBak, this.lastCommittedJson as string)))
      await this.withDeadline(startOp(() => this.io.rename(tmpBak, this.bakPath)))
    }
    // 3. 原子替换主文件；win32 文件占用在有界期限内退避重试。
    await this.renameMainWithRetry(tmpMain, this.mainPath)
    // 4. 尽力同步父目录；失败不回滚已成功的事务（win32 平台边界）。
    await this.fsyncParentDirBestEffort()
  }

  private nextTmpPath(): string {
    this.tmpSeq += 1
    return `${this.mainPath}.tmp-${this.tmpSeq}`
  }

  /** 主文件替换：可重试错误码最多退避重试 3 次、每次 100ms，全部计入事务期限。 */
  private async renameMainWithRetry(from: string, to: string): Promise<void> {
    let attempt = 0
    for (;;) {
      try {
        await this.withDeadline(startOp(() => this.io.rename(from, to)))
        return
      } catch (err) {
        if (err instanceof StateStoreError && err.isTimeout) {
          throw err
        }
        if (!isRetryableRenameError(err) || attempt >= RENAME_RETRY_ATTEMPTS) {
          throw err
        }
        attempt += 1
        await this.withDeadline(startOp(() => sleep(RENAME_RETRY_DELAY_MS)))
      }
    }
  }

  private async fsyncParentDirBestEffort(): Promise<void> {
    try {
      await this.withDeadline(startOp(() => this.io.fsyncDir(this.stateDir)))
    } catch (err) {
      // win32 目录 fsync 以 EPERM 失败（实测），不影响主文件已完成的原子替换：
      // 每个实例只告警一次，不让已成功的事务回滚（设计文档 7.3 平台边界）。
      if (!this.dirFsyncWarningLogged) {
        this.dirFsyncWarningLogged = true
        this.logger.logEvent('state_warning', {
          reason: `directory fsync failed on this platform: ${errorMessage(err)}`,
        })
      }
    }
  }

  /**
   * 把操作纳入当前事务期限：期限已过或到期仍未落定时以超时错误失败。
   * 预挂空 rejection 处理器，避免竞速失败后操作迟到 rejection 成为未处理拒绝。
   */
  private async withDeadline<T>(op: Promise<T>): Promise<T> {
    op.then(
      () => undefined,
      () => undefined,
    )
    const remaining = this.deadlineAt - this.now()
    if (remaining <= 0) {
      throw this.timeoutError()
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const onTimeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(this.timeoutError()), remaining)
    })
    try {
      return await Promise.race([op, onTimeout])
    } finally {
      clearTimeout(timer)
    }
  }

  private timeoutError(): StateStoreError {
    return new StateStoreError(
      `mapping write timed out after ${this.limits.MAP_WRITE_TIMEOUT_MS} ms`,
      { isTimeout: true },
    )
  }

  /** failed 是吸收态：只进入一次，保留最近已提交内存状态，需人工处理后重建 store。 */
  private enterFailed(error: unknown): void {
    if (this.failedError !== undefined) {
      return
    }
    this.failedError = error
    this.logger.logEvent('state_failed', {
      error: `state store failed: ${errorMessage(error)}`,
    })
    for (const listener of this.failureListeners) {
      try {
        listener(error)
      } catch {
        // 监听器自身的异常不阻断其余监听器，也不再递归记日志。
      }
    }
  }
}
