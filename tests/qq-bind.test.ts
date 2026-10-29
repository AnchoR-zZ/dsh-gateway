import { describe, expect, it, vi } from 'vitest'

import type { QQBindCallbacks, QQBindConnector, QQBindCredentials } from '../src/channels/qq/qr-connect.js'
import {
  BIND_ABORTED_MESSAGE,
  BIND_EXPIRED_MESSAGE,
  BIND_NOT_STARTED_MESSAGE,
  createQQBindingService,
} from '../src/management/binding.js'
import type { QQBindingService } from '../src/management/binding.js'
import { ManagementError } from '../src/management/contracts.js'
import type { ChannelChangeResult } from '../src/management/contracts.js'

/**
 * QQ 扫码绑定会话状态机单元测试：只驱动 `createQQBindingService` 与替身连接器，
 * 不触真实腾讯网络、不使用真实计时器。测试显式触发连接器回调（二维码展示/成功/失败/过期），
 * 每个用例的推进顺序完全确定；绑定服务本身没有超时，等待不会自行结束。
 *
 * 真实上游在 `onQrExpired` 后因 AbortSignal 终止轮询并回调 `onFailure`（见
 * `src/channels/qq/qr-connect.ts` 的注释与 `@tencent-connect/qqbot-connector` 的实现），
 * 替身连接器复现同一收尾顺序，使"过期 = 会话终态"的契约可被直接断言。
 */

const BIND_URL = 'https://q.qq.com/qqbot/connect?task=1'

interface FakeBindCall {
  readonly callbacks: QQBindCallbacks
  readonly signal: AbortSignal
}

interface FakeBindConnector {
  readonly connector: QQBindConnector
  /** 每次连接器调用的回调与取消信号，按调用顺序排列。 */
  readonly calls: FakeBindCall[]
  /** 最近一次调用的记录；尚未调用时抛错。 */
  readonly latest: FakeBindCall
  /** 触发二维码 URL 就绪。 */
  display(url: string): void
  /** 触发扫码成功，返回给定凭据（原样交给被测服务，由它负责裁剪与校验）。 */
  succeed(credentials: readonly QQBindCredentials[]): void
  /** 触发上游失败。 */
  fail(error: Error): void
  /** 模拟二维码过期：先回调过期，再像真实上游一样因 abort 以 onFailure 收尾。 */
  expire(): void
}

function createFakeConnector(): FakeBindConnector {
  const calls: FakeBindCall[] = []
  const connector: QQBindConnector = (callbacks, options) => {
    calls.push({ callbacks, signal: options.signal })
  }
  function latest(): FakeBindCall {
    const call = calls[calls.length - 1]
    if (call === undefined) {
      throw new Error('the fake QQ bind connector has not been invoked yet')
    }
    return call
  }
  return {
    connector,
    get calls(): FakeBindCall[] {
      return calls
    },
    get latest(): FakeBindCall {
      return latest()
    },
    display(url: string): void {
      latest().callbacks.onQrDisplayed(url)
    },
    succeed(credentials: readonly QQBindCredentials[]): void {
      latest().callbacks.onSuccess(credentials)
    },
    fail(error: Error): void {
      latest().callbacks.onFailure(error)
    },
    expire(): void {
      const call = latest()
      call.callbacks.onQrExpired()
      // 真实上游在被 abort 后停止轮询并以 onFailure 收尾；复用同一收尾路径。
      call.callbacks.onFailure(new Error('已取消'))
    },
  }
}

interface BindHarness {
  service: QQBindingService
  fake: FakeBindConnector
  apply: ReturnType<typeof vi.fn>
  /** `applyCredentials` 收到的参数，按调用顺序排列。 */
  applied: [string, string][]
}

function makeHarness(options?: {
  applyCredentials?: (appId: string, appSecret: string) => Promise<ChannelChangeResult>
}): BindHarness {
  const fake = createFakeConnector()
  const applied: [string, string][] = []
  const apply = vi.fn(async (appId: string, appSecret: string): Promise<ChannelChangeResult> => {
    applied.push([appId, appSecret])
    if (options?.applyCredentials !== undefined) {
      return options.applyCredentials(appId, appSecret)
    }
    return { channel: `qq:${appId}`, saved: true, state: 'online' }
  })
  const service = createQQBindingService({ connector: fake.connector, applyCredentials: apply })
  return { service, fake, apply, applied }
}

/** 启动会话并让替身返回二维码 URL，停在"等待扫码"的活动状态。 */
async function startAndDisplay(h: BindHarness, url = BIND_URL): Promise<void> {
  const starting = h.service.start()
  h.fake.display(url)
  await starting
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

describe('QQ 扫码绑定会话：启动与幂等复用', () => {
  it('start 返回 onQrDisplayed 的 URL；等待期间重复 start 只触发一次连接器', async () => {
    const h = makeHarness()

    const first = h.service.start()
    const second = h.service.start()
    expect(h.fake.calls).toHaveLength(1)

    h.fake.display(BIND_URL)

    await expect(first).resolves.toEqual({ url: BIND_URL })
    await expect(second).resolves.toEqual({ url: BIND_URL })
    // URL 已就绪、会话仍在等待终态：重复 start 同样复用，不新建上游任务。
    await expect(h.service.start()).resolves.toEqual({ url: BIND_URL })
    expect(h.fake.calls).toHaveLength(1)
  })

  it('单会话只有一张二维码：新 start 只在上一会话进入终态后才创建上游任务', async () => {
    const h = makeHarness()
    await startAndDisplay(h)

    const waiting = h.service.wait()
    h.fake.succeed([{ appId: 'app-1', appSecret: 'secret-1' }])
    await expect(waiting).resolves.toEqual({ channel: 'qq:app-1', saved: true, state: 'online' })

    // 成功是终态；此后的 start 才是新会话。
    const restarted = h.service.start()
    expect(h.fake.calls).toHaveLength(2)
    const nextUrl = 'https://q.qq.com/qqbot/connect?task=2'
    h.fake.display(nextUrl)
    await expect(restarted).resolves.toEqual({ url: nextUrl })
  })
})

describe('QQ 扫码绑定会话：扫码成功', () => {
  it('wait 成功：applyCredentials 收到 trim 后的凭据，结果原样返回且重复 wait 不再落盘', async () => {
    const h = makeHarness()
    await startAndDisplay(h)

    const waiting = h.service.wait()
    h.fake.succeed([{ appId: '  app-1  ', appSecret: '  secret-1  ' }])

    const result = await waiting
    expect(result).toEqual({ channel: 'qq:app-1', saved: true, state: 'online' })
    expect(h.applied).toEqual([['app-1', 'secret-1']])

    // 终态保留：重复 wait 立即返回同一结果，不再调用 applyCredentials。
    await expect(h.service.wait()).resolves.toEqual(result)
    expect(h.applied).toHaveLength(1)
    expect(h.fake.calls).toHaveLength(1)
  })

  it('applyCredentials 的 ManagementError 原样传递（config_write_failed），不包装为 bind_failed', async () => {
    const h = makeHarness({
      applyCredentials: async () => {
        throw new ManagementError('config_write_failed', 'failed to write the gateway config: disk full')
      },
    })
    await startAndDisplay(h)

    const waiting = h.service.wait()
    h.fake.succeed([{ appId: 'app-1', appSecret: 'secret-1' }])

    const error = await captureManagementError(waiting)
    expect(error.code).toBe('config_write_failed')
    expect(error.message).toBe('failed to write the gateway config: disk full')
    expect(h.applied).toHaveLength(1)
  })

  it('applyCredentials 的其他异常收敛为 bind_failed，消息脱敏', async () => {
    const h = makeHarness({
      applyCredentials: async () => {
        throw new Error('apply blew up; appSecret=top-secret-value')
      },
    })
    await startAndDisplay(h)

    const waiting = h.service.wait()
    h.fake.succeed([{ appId: 'app-1', appSecret: 'top-secret-value' }])

    const error = await captureManagementError(waiting)
    expect(error.code).toBe('bind_failed')
    expect(error.message).toContain('the QR binding failed')
    expect(error.message).not.toContain('top-secret-value')
    expect(error.message).toContain('[REDACTED]')
  })
})

describe('QQ 扫码绑定会话：二维码过期', () => {
  it('过期即终止：连接器 signal 被 abort，wait 以 bind_expired 结束，再次 start 开新会话', async () => {
    const h = makeHarness()
    await startAndDisplay(h)
    const firstSignal = h.fake.latest.signal

    const waiting = h.service.wait()
    h.fake.expire()

    expect(firstSignal.aborted).toBe(true)
    const error = await captureManagementError(waiting)
    expect(error.code).toBe('bind_expired')
    expect(error.message).toBe(BIND_EXPIRED_MESSAGE)
    expect(h.apply).not.toHaveBeenCalled()

    // 过期后手动刷新 = 再发一次 POST：新会话、新连接器调用、新 signal。
    const restarted = h.service.start()
    expect(h.fake.calls).toHaveLength(2)
    expect(h.fake.latest.signal).not.toBe(firstSignal)
    expect(firstSignal.aborted).toBe(true)

    const nextUrl = 'https://q.qq.com/qqbot/connect?task=2'
    h.fake.display(nextUrl)
    await expect(restarted).resolves.toEqual({ url: nextUrl })
  })

  it('URL 就绪前过期：挂起的 start 以 bind_expired 拒绝而不是挂死', async () => {
    const h = makeHarness()

    const starting = h.service.start()
    const waiting = h.service.wait()
    h.fake.expire()

    const startError = await captureManagementError(starting)
    expect(startError.code).toBe('bind_expired')
    expect(startError.message).toBe(BIND_EXPIRED_MESSAGE)
    const waitError = await captureManagementError(waiting)
    expect(waitError.code).toBe('bind_expired')
    expect(h.fake.latest.signal.aborted).toBe(true)
  })

  it('过期终态保留：重复 wait 立即返回同一错误，不重新等待也不重发二维码', async () => {
    const h = makeHarness()
    await startAndDisplay(h)

    h.fake.expire()
    const first = await captureManagementError(h.service.wait())
    const second = await captureManagementError(h.service.wait())

    expect(first.code).toBe('bind_expired')
    expect(second.code).toBe(first.code)
    expect(second.message).toBe(first.message)
    expect(h.fake.calls).toHaveLength(1)
    expect(h.apply).not.toHaveBeenCalled()
  })
})

describe('QQ 扫码绑定会话：上游失败与非法凭据', () => {
  it('等待期间上游失败：wait 以 bind_failed 拒绝，applyCredentials 不被调用', async () => {
    const h = makeHarness()
    await startAndDisplay(h)

    const waiting = h.service.wait()
    h.fake.fail(new Error('polling failed with HTTP 500'))

    const error = await captureManagementError(waiting)
    expect(error.code).toBe('bind_failed')
    expect(error.message).toContain('the QR binding flow failed')
    expect(error.message).toContain('HTTP 500')
    expect(h.apply).not.toHaveBeenCalled()
  })

  it('URL 就绪前上游失败：start 以 bind_failed 拒绝', async () => {
    const h = makeHarness()

    const starting = h.service.start()
    h.fake.fail(new Error('create bind task failed'))

    const error = await captureManagementError(starting)
    expect(error.code).toBe('bind_failed')
    expect(error.message).toContain('the QR binding flow failed')
    expect(error.message).toContain('create bind task failed')
  })

  it('失败终态保留：重复 wait 立即返回同一错误', async () => {
    const h = makeHarness()
    await startAndDisplay(h)

    h.fake.fail(new Error('boom'))
    const first = await captureManagementError(h.service.wait())
    const second = await captureManagementError(h.service.wait())

    expect(first.code).toBe('bind_failed')
    expect(second.code).toBe(first.code)
    expect(second.message).toBe(first.message)
    expect(h.fake.calls).toHaveLength(1)
  })

  it('上游返回非法凭据：wait 以 bind_failed 拒绝且不落盘', async () => {
    const cases: readonly QQBindCredentials[][] = [
      [],
      [{ appId: '', appSecret: 'secret-1' }],
      [{ appId: 'bad_app', appSecret: 'secret-1' }],
      [{ appId: 'app-1', appSecret: '   ' }],
    ]
    for (const credentials of cases) {
      const h = makeHarness()
      await startAndDisplay(h)

      const waiting = h.service.wait()
      h.fake.succeed(credentials)

      const error = await captureManagementError(waiting)
      expect(error.code, JSON.stringify(credentials)).toBe('bind_failed')
      expect(error.message).toMatch(/the QR flow returned (no credentials|an invalid appId|an invalid appSecret)/)
      expect(h.apply).not.toHaveBeenCalled()
    }
  })

  it('上游返回非字符串字段：按非法凭据失败，不产生未处理拒绝', async () => {
    const h = makeHarness()
    await startAndDisplay(h)

    const waiting = h.service.wait()
    // 上游返回值按不可信形状防御：非字符串字段必须收敛为 bind_failed，而不是让等待方永久挂起。
    h.fake.succeed([
      { appId: 42 as unknown as string, appSecret: 'secret-1' } as unknown as QQBindCredentials,
    ])

    const error = await captureManagementError(waiting)
    expect(error.code).toBe('bind_failed')
    expect(error.message).toContain('the QR flow returned invalid credentials')
    expect(h.apply).not.toHaveBeenCalled()
  })

  it('连接器同步抛错：start 以 bind_failed 拒绝，不触发落盘', async () => {
    const apply = vi.fn(
      async (appId: string): Promise<ChannelChangeResult> => ({
        channel: `qq:${appId}`,
        saved: true,
        state: 'online',
      }),
    )
    const service = createQQBindingService({
      connector: () => {
        throw new Error('connector exploded')
      },
      applyCredentials: apply,
    })

    const error = await captureManagementError(service.start())
    expect(error.code).toBe('bind_failed')
    expect(error.message).toContain('failed to start')
    expect(apply).not.toHaveBeenCalled()
  })
})

describe('QQ 扫码绑定会话：未启动、停机与终态', () => {
  it('从未启动会话时 wait 以 bind_not_started 拒绝', async () => {
    const h = makeHarness()

    const error = await captureManagementError(h.service.wait())
    expect(error.code).toBe('bind_not_started')
    expect(error.message).toBe(BIND_NOT_STARTED_MESSAGE)
  })

  it('等待期间 abort：wait 以 gateway_stopping 结束，并中止连接器 signal', async () => {
    const h = makeHarness()
    await startAndDisplay(h)

    const waiting = h.service.wait()
    h.service.abort()

    const error = await captureManagementError(waiting)
    expect(error.code).toBe('gateway_stopping')
    expect(error.message).toBe(BIND_ABORTED_MESSAGE)
    expect(h.fake.latest.signal.aborted).toBe(true)
    expect(h.apply).not.toHaveBeenCalled()
  })

  it('URL 就绪前停机：不依赖上游取消回调，start 与 wait 均拒绝，迟到回调无效', async () => {
    const h = makeHarness()
    const starting = h.service.start()
    const waiting = h.service.wait()
    h.service.abort()

    expect((await captureManagementError(starting)).code).toBe('gateway_stopping')
    expect((await captureManagementError(waiting)).code).toBe('gateway_stopping')
    expect(h.fake.latest.signal.aborted).toBe(true)
    h.fake.display(BIND_URL)
    h.fake.succeed([{ appId: 'late-app', appSecret: 'late-secret' }])
    h.fake.fail(new Error('late upstream failure'))
    expect((await captureManagementError(h.service.wait())).code).toBe('gateway_stopping')
    expect(h.apply).not.toHaveBeenCalled()
  })

  it('终态后 abort 是 no-op：不改变已保留的成功结果', async () => {
    const h = makeHarness()
    await startAndDisplay(h)

    const waiting = h.service.wait()
    h.fake.succeed([{ appId: 'app-1', appSecret: 'secret-1' }])
    const result = await waiting

    expect(() => h.service.abort()).not.toThrow()
    // abort 没有新增终态，重复 wait 仍返回成功结果。
    await expect(h.service.wait()).resolves.toEqual(result)
    expect(h.fake.latest.signal.aborted).toBe(false)
  })
})

describe('QQ 扫码绑定会话：凭证不泄露', () => {
  it('上游失败消息中的 appSecret 被 redact 脱敏', async () => {
    const secret = 'supersecret'
    const h = makeHarness()
    await startAndDisplay(h)

    const waiting = h.service.wait()
    h.fake.fail(new Error(`boom secret=${secret}`))

    const error = await captureManagementError(waiting)
    expect(error.code).toBe('bind_failed')
    expect(error.message).not.toContain(secret)
    expect(error.message).toContain('[REDACTED]')
    expect(String(error)).not.toContain(secret)
    expect(h.apply).not.toHaveBeenCalled()
  })

  it('成功结果与非法凭据错误都不回显 appSecret', async () => {
    // 成功路径：applyCredentials 返回的结果字符串不含连接器给的 secret。
    const success = makeHarness()
    await startAndDisplay(success)
    const waiting = success.service.wait()
    success.fake.succeed([{ appId: 'app-1', appSecret: 'bind-secret' }])
    const result = await waiting
    expect(JSON.stringify(result)).not.toContain('bind-secret')

    // 非法凭据：错误只描述字段，不带原始值。
    const invalid = makeHarness()
    await startAndDisplay(invalid)
    const invalidWaiting = invalid.service.wait()
    invalid.fake.succeed([{ appId: 'bad_app', appSecret: 'bind-secret' }])
    const error = await captureManagementError(invalidWaiting)
    expect(error.code).toBe('bind_failed')
    expect(error.message).not.toContain('bind-secret')
    expect(error.message).not.toContain('bad_app')
  })
})
