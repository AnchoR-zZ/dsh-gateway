import { Buffer } from 'node:buffer'

import type { GatewayConfig } from '../config.js'
import type { ReplyPort } from '../contracts.js'
import { GATEWAY_LIMITS } from '../contracts.js'
import type { GatewayLogger } from '../logging.js'

/**
 * core/scheduler：每用户 FIFO、就绪用户轮转、全局执行槽与容量准入（设计文档 6.1、6.2、6.3）。
 * 纯内存模块：不依赖 dsh 与 state-store、不导入 QQ SDK、不创建或恢复会话，排队期间只保存
 * gateway DTO（不把待处理消息提前塞入 agent inbox）。回复出口全部经回调转交，本模块只在
 * "入队即过期"拒绝时直接 close port（无预算消耗、无发送）。
 *
 * 计数语义："等待"（pendingTotal / pendingBytes / 每用户条数）只统计仍在 FIFO、尚未出队的任务；
 * 一个任务从出队（execute 或 queueExpired 回调启动）到回调 promise settle 都占全局槽（6.1），
 * 其中 execute / queueExpired 也同时置该用户 busy（不变量 2：同一身份最多一个执行中任务，
 * 前一任务的执行、清理与出站处理结束后才处理下一条）。dropped（出队时已过期）不发送任何
 * 内容，不占槽、不置 busy，出队后立刻继续就绪轮转。
 *
 * 窗口判定用注入的墙钟 now()（匹配平台截止时间；进程内耗时与 turn 计时归 turn-runner 的
 * 单调时钟）。FIFO 为空且无执行中任务时移除该用户的临时调度条目（持久映射在 state-store，
 * 与此无关）。正常停止只丢弃尚未执行的内存队列（9.3：不为排队消息逐条发送停机广播，丢弃经
 * onStopDropped 回调由组装层决定如何记录与关闭 port）；运行中任务不受影响，槽位由其执行
 * promise 自然释放。
 */

/** 已接受、尚未执行完成的任务；seq 由 scheduler 在接受时同步分配（全局递增接受序号，6.1）。 */
export interface QueuedTask {
  /** 调用方（core 组装层）生成的请求标识。 */
  readonly requestId: string
  /** 唯一会话键（`<channelId>_<accountId>_<peerId>`），作为每用户 FIFO 的键。 */
  readonly bindingId: string
  /** 平台消息标识，仅追踪与被动回复锚点。 */
  readonly messageId: string
  /** 已去除首尾空白的正文；排队期间按 UTF-8 字节计入 pendingBytes。 */
  readonly text: string
  /** 墙钟 ms，入站时间。 */
  readonly receivedAt: number
  /** 墙钟 ms，平台被动回复截止（来自 ReplyPolicy）。 */
  readonly expiresAt: number
  /** 每条入站创建的回复出口；scheduler 只在丢弃路径转交回调关闭，不直接 deliver。 */
  readonly reply: ReplyPort
  /** 同步分配的全局递增接受序号；拒绝的任务不消耗序号。 */
  readonly seq: number
}

/**
 * scheduler 对执行与出队降级路径的全部外部依赖。回调 promise resolve 即该任务完成
 * （含组装层的清理与出站处理）；reject 按 settle 处理并记录，不得阻塞队列。
 */
export interface SchedulerCallbacks {
  /**
   * 正常执行一个任务：准备会话 → followup → 等待 → deliver。占全局槽与该用户 busy，
   * 直至 promise settle。实现自身的失败应在内部消化后 resolve（终态 envelope 由组装层负责），
   * reject 会被 scheduler 记为 `turn_failed`/`executor_error` 并释放槽。
   */
  execute(task: QueuedTask): Promise<void>
  /**
   * 出队时剩余窗口 < TURN_DEADLINE_MS + QQ_OUTBOUND_MARGIN_MS：不启动 turn。回调负责发送
   * queue-expired 提示（一次 deliver）并 close port。占全局槽与该用户 busy 直至 promise settle；
   * reject 同样按 settle 处理并记录。
   */
  queueExpired(task: QueuedTask): Promise<void>
  /**
   * 出队时已过 expiresAt：不发送任何内容。回调负责记日志 + close port；同步或 async 均可，
   * 不占执行槽、不置 busy——scheduler 不等待它完成（其 rejection 只记日志）。
   */
  dropped(task: QueuedTask, reason: 'expired'): void | Promise<void>
  /**
   * 正常停止时对每个尚未执行的排队任务恰调用一次；不发送 queue-expired 广播（9.3），
   * 如何记录与关闭 port 由组装层决定。同步回调；抛错只记日志，不中断其余任务的丢弃。
   */
  onStopDropped(task: QueuedTask): void
}

/** admit 输入；requestId / messageId / text / receivedAt / expiresAt 由组装层规范化后提供。 */
export interface AdmitInput {
  requestId: string
  bindingId: string
  messageId: string
  text: string
  receivedAt: number
  expiresAt: number
  reply: ReplyPort
}

/** 同步准入结果；拒绝不改变任何容量计数。 */
export type AdmitResult =
  /** 容量不足（用户条数 / 全局条数 / 全局字节任一超限），超限拒绝最新消息、不挤掉已接受任务。 */
  | { accepted: false; reason: 'busy' }
  /** 停止中（stop() 之后）。 */
  | { accepted: false; reason: 'stopping' }
  /** 入队时已过 expiresAt：scheduler 已直接 close 该 port，无内容可发、不经过回调。 */
  | { accepted: false; reason: 'expired' }
  | { accepted: true; task: QueuedTask }

/** 健康探针快照（设计文档 13.2：待处理数量与运行数量；waitingPeers 为附加维度）。 */
export interface SchedulerStats {
  /** 全局尚未出队的任务条数。 */
  readonly pendingTotal: number
  /** 全局尚未出队任务的正文 UTF-8 字节合计。 */
  readonly pendingBytes: number
  /** 当前占全局执行槽的任务数（execute 与 queueExpired 在飞合计）。 */
  readonly running: number
  /** 就绪用户数：FIFO 非空且当前无执行中任务的用户数（轮转就绪集合大小）。 */
  readonly waitingPeers: number
}

/** 每用户 FIFO + 全局槽调度器；生命周期由 core/lifecycle 持有。 */
export interface Scheduler {
  /**
   * 同步准入：在同一调用内原子完成全部容量检查（该用户 pending+1 ≤ maxPendingPerPeer、
   * 全局 pending+1 ≤ maxPendingTotal、pendingBytes+正文 UTF-8 字节 ≤ maxPendingBytes）。
   * 接受则入该用户 FIFO 并触发 pump（空闲槽可能同步出队执行）；任何拒绝不改变计数。
   * 已 stopping 时一律返回 stopping。
   */
  admit(input: AdmitInput): AdmitResult
  /** 当前计数快照；只读探针，不做调度动作。 */
  stats(): SchedulerStats
  /**
   * 置 stopping 并丢弃尚未执行的内存队列：每个排队任务恰一次 `onStopDropped`，随后
   * pending 计数归零；运行中任务不受影响（由组装层停止协调器处理），其槽位在执行
   * promise settle 后自然释放。幂等：重复调用为 no-op。
   */
  stop(): void
  /** 内部条目数等观测值；仅供测试与诊断，不属于健康探针契约。 */
  inspect(): { peerEntries: number }
}

/** FIFO 内部条目：任务与其 UTF-8 字节数（admit 时计算一次，出队时按此扣减）。 */
interface QueueEntry {
  readonly task: QueuedTask
  readonly bytes: number
}

/**
 * 每用户临时调度对象（6.3）：FIFO 队列、busy 标记与就绪队列成员标记。
 * FIFO 为空且 !busy 时整个条目从 peers Map 移除（持久映射在 state-store，与此无关）。
 */
interface PeerState {
  queue: QueueEntry[]
  busy: boolean
  /** 是否已在 readyOrder 中（避免重复入队；与 readyOrder 成员一一对应）。 */
  ready: boolean
}

/** 创建调度器；now 注入墙钟（默认 Date.now），测试用受控时钟驱动窗口判定。 */
export function createScheduler(options: {
  config: Pick<GatewayConfig, 'maxConcurrent' | 'maxPendingPerPeer' | 'maxPendingTotal' | 'maxPendingBytes'>
  limits: typeof GATEWAY_LIMITS
  logger: GatewayLogger
  callbacks: SchedulerCallbacks
  now?: () => number
}): Scheduler {
  const { config, limits, logger, callbacks } = options
  const now: () => number = options.now ?? Date.now
  /** 出队窗口下限：完整 turn 执行预算（TURN_DEADLINE_MS）加出站余量（QQ_OUTBOUND_MARGIN_MS）。 */
  const minWindowMs = limits.TURN_DEADLINE_MS + limits.QQ_OUTBOUND_MARGIN_MS

  const peers = new Map<string, PeerState>()
  /** 轮转就绪队列（bindingId，成员与 PeerState.ready 一一对应），队头为下一个应调度的用户。 */
  const readyOrder: string[] = []
  let pendingTotal = 0
  let pendingBytes = 0
  let running = 0
  let stopping = false
  let nextSeq = 1

  /** 用户转为就绪（FIFO 非空、不 busy、尚未在队列中）时排到轮转队列尾部。 */
  function markReady(bindingId: string, peer: PeerState): void {
    if (peer.busy || peer.queue.length === 0 || peer.ready) {
      return
    }
    peer.ready = true
    readyOrder.push(bindingId)
  }

  /**
   * 执行循环：有空闲槽且存在就绪用户时，按轮转顺序取队头用户的队头任务出队。
   * 出队即从 pending 计数扣除；窗口判定决定 execute / queueExpired（占槽、置 busy）或
   * dropped（不占槽，继续循环处理下一个）。settle 后由 settleOccupied 重新入轮转并再 pump。
   */
  function pump(): void {
    while (!stopping && running < config.maxConcurrent && readyOrder.length > 0) {
      const bindingId = readyOrder.shift()
      if (bindingId === undefined) {
        break
      }
      const peer = peers.get(bindingId)
      if (peer === undefined) {
        continue
      }
      peer.ready = false
      // 防御：理论不会出现 busy 或空 FIFO 的就绪成员，出现时跳过该陈旧条目。
      if (peer.busy || peer.queue.length === 0) {
        continue
      }

      const entry = peer.queue.shift()
      if (entry === undefined) {
        continue
      }
      pendingTotal -= 1
      pendingBytes -= entry.bytes
      const task = entry.task
      const nowMs = now()

      if (task.expiresAt <= nowMs) {
        // 已过期：不发送任何内容、不占槽、不置 busy；回调自行记录与 close port。
        if (peer.queue.length > 0) {
          markReady(bindingId, peer)
        } else {
          peers.delete(bindingId)
        }
        invokeDropped(task)
        continue
      }

      peer.busy = true
      running += 1
      const expiredWindow = task.expiresAt - nowMs < minWindowMs
      let promise: Promise<void>
      try {
        promise = expiredWindow ? callbacks.queueExpired(task) : callbacks.execute(task)
      } catch (error) {
        promise = Promise.reject(error)
      }
      promise.then(
        () => settleOccupied(bindingId),
        (error: unknown) => {
          logger.logEvent('turn_failed', {
            requestId: task.requestId,
            bindingId,
            messageId: task.messageId,
            reason: expiredWindow ? 'queue_expired_callback_error' : 'executor_error',
            error: toErrorMessage(error),
          })
          settleOccupied(bindingId)
        },
      )
    }
  }

  /** 占槽任务 settle（resolve 或 reject 后）：释放槽、清 busy、按剩余 FIFO 重新入轮转。 */
  function settleOccupied(bindingId: string): void {
    running -= 1
    const peer = peers.get(bindingId)
    if (peer !== undefined) {
      peer.busy = false
      if (peer.queue.length > 0) {
        markReady(bindingId, peer)
      } else {
        peers.delete(bindingId)
      }
    }
    pump()
  }

  /** 出队即过期路径：不占槽；rejection 只记日志，不阻塞队列（scheduler 不等待它完成）。 */
  function invokeDropped(task: QueuedTask): void {
    const logRejection = (error: unknown): void => {
      logger.logEvent('turn_failed', {
        requestId: task.requestId,
        bindingId: task.bindingId,
        messageId: task.messageId,
        reason: 'drop_callback_error',
        error: toErrorMessage(error),
      })
    }
    try {
      Promise.resolve(callbacks.dropped(task, 'expired')).catch(logRejection)
    } catch (error) {
      logRejection(error)
    }
  }

  function admit(input: AdmitInput): AdmitResult {
    if (stopping) {
      return { accepted: false, reason: 'stopping' }
    }
    if (input.expiresAt <= now()) {
      // 入队即过期：无内容可发，直接关闭 port（close 幂等），不经过回调、不占预算。
      input.reply.close()
      return { accepted: false, reason: 'expired' }
    }
    const bytes = Buffer.byteLength(input.text, 'utf8')
    const peerPending = peers.get(input.bindingId)?.queue.length ?? 0
    if (peerPending + 1 > config.maxPendingPerPeer) {
      return { accepted: false, reason: 'busy' }
    }
    if (pendingTotal + 1 > config.maxPendingTotal) {
      return { accepted: false, reason: 'busy' }
    }
    if (pendingBytes + bytes > config.maxPendingBytes) {
      return { accepted: false, reason: 'busy' }
    }

    const task: QueuedTask = {
      requestId: input.requestId,
      bindingId: input.bindingId,
      messageId: input.messageId,
      text: input.text,
      receivedAt: input.receivedAt,
      expiresAt: input.expiresAt,
      reply: input.reply,
      seq: nextSeq,
    }
    nextSeq += 1
    let peer = peers.get(input.bindingId)
    if (peer === undefined) {
      peer = { queue: [], busy: false, ready: false }
      peers.set(input.bindingId, peer)
    }
    peer.queue.push({ task, bytes })
    pendingTotal += 1
    pendingBytes += bytes
    markReady(input.bindingId, peer)
    pump()
    return { accepted: true, task }
  }

  function stats(): SchedulerStats {
    return { pendingTotal, pendingBytes, running, waitingPeers: readyOrder.length }
  }

  function stop(): void {
    if (stopping) {
      return
    }
    stopping = true
    readyOrder.length = 0
    for (const [bindingId, peer] of peers) {
      peer.ready = false
      for (const entry of peer.queue) {
        try {
          callbacks.onStopDropped(entry.task)
        } catch (error) {
          logger.logEvent('turn_failed', {
            requestId: entry.task.requestId,
            bindingId,
            messageId: entry.task.messageId,
            reason: 'stop_drop_callback_error',
            error: toErrorMessage(error),
          })
        }
      }
      peer.queue = []
      // busy 用户的条目保留到其执行 promise settle 后由 settleOccupied 回收。
      if (!peer.busy) {
        peers.delete(bindingId)
      }
    }
    pendingTotal = 0
    pendingBytes = 0
  }

  function inspect(): { peerEntries: number } {
    return { peerEntries: peers.size }
  }

  return { admit, stats, stop, inspect }
}

/** 错误转已脱敏前的字符串 message（logging.logEvent 的 error/reason 字段会再过一次 redact）。 */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
