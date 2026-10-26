import type { QrConnectCallbacks, QrConnectOptions } from '@tencent-connect/qqbot-connector'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 连接器适配层测试：mock 腾讯官方包，验证传给它的选项（不打印终端二维码、来源标识、取消
 * 信号）与回调映射（凭据只保留 appId/appSecret、空数组原样透传）。真实实现不联网。
 *
 * `vi.mock` 被提升到 import 之上，因此用 `vi.hoisted` 声明 mock 引用，避免工厂执行时变量
 * 尚未初始化。
 */
const mocks = vi.hoisted(() => ({ startQrConnect: vi.fn() }))

vi.mock('@tencent-connect/qqbot-connector', () => ({ startQrConnect: mocks.startQrConnect }))

import { QQ_BIND_SOURCE, createQQBindConnector } from '../src/channels/qq/qr-connect.js'

const startQrConnect = mocks.startQrConnect

/** 官方连接器收到的一对实参；mock 的 calls 不带原始类型，这里集中收窄。 */
type ConnectorCall = [QrConnectCallbacks, QrConnectOptions?]

function firstCall(): { wrapped: QrConnectCallbacks; options: QrConnectOptions } {
  const [wrapped, options] = startQrConnect.mock.calls[0] as unknown as ConnectorCall
  return { wrapped, options: options ?? {} }
}

describe('QQ 扫码连接器适配层', () => {
  beforeEach(() => {
    startQrConnect.mockReset()
    startQrConnect.mockImplementation(() => () => undefined)
  })

  it('以不打印终端二维码、固定 source 与调用方 signal 调用官方连接器', () => {
    const connector = createQQBindConnector()
    const controller = new AbortController()
    const callbacks = {
      onQrDisplayed: vi.fn(),
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
      onQrExpired: vi.fn(),
    }

    connector(callbacks, { signal: controller.signal })

    expect(startQrConnect).toHaveBeenCalledTimes(1)
    const { wrapped, options } = firstCall()
    expect(options.displayQrCodeToConsole).toBe(false)
    expect(options.source).toBe(QQ_BIND_SOURCE)
    expect(QQ_BIND_SOURCE).toBe('dsh-gateway')
    expect(options.signal).toBe(controller.signal)

    // 驱动被包装的回调，确认逐项转发给网关回调
    wrapped.onQrDisplayed?.('https://q.qq.com/qqbot/openclaw/connect.html?task_id=t')
    expect(callbacks.onQrDisplayed).toHaveBeenCalledWith(
      'https://q.qq.com/qqbot/openclaw/connect.html?task_id=t',
    )

    wrapped.onQrExpired?.()
    expect(callbacks.onQrExpired).toHaveBeenCalledTimes(1)

    const failure = new Error('upstream exploded')
    wrapped.onFailure(failure)
    expect(callbacks.onFailure).toHaveBeenCalledWith(failure)
  })

  it('成功回调只映射 appId/appSecret，丢弃 userOpenid 等其他字段', () => {
    const connector = createQQBindConnector()
    const callbackInputs: unknown[] = []
    const callbacks = {
      onQrDisplayed: vi.fn(),
      onSuccess: (credentials: readonly unknown[]) => {
        callbackInputs.push(credentials)
      },
      onFailure: vi.fn(),
      onQrExpired: vi.fn(),
    }

    connector(callbacks, { signal: new AbortController().signal })
    const { wrapped } = firstCall()

    wrapped.onSuccess([
      { appId: 'app-id', appSecret: 's3cr3t', userOpenid: 'openid-1' },
      { appId: 'ignored', appSecret: 'ignored' },
    ])

    expect(callbackInputs).toEqual([
      [
        { appId: 'app-id', appSecret: 's3cr3t' },
        { appId: 'ignored', appSecret: 'ignored' },
      ],
    ])
    // 只有凭据字段能进入会话；扫码用户 openid 被丢弃
    expect(JSON.stringify(callbackInputs)).not.toContain('openid-1')
  })

  it('空凭据数组原样透传，由会话状态机按"无有效凭据"失败', () => {
    const connector = createQQBindConnector()
    const callbacks = {
      onQrDisplayed: vi.fn(),
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
      onQrExpired: vi.fn(),
    }

    connector(callbacks, { signal: new AbortController().signal })
    const { wrapped } = firstCall()
    wrapped.onSuccess([])

    expect(callbacks.onSuccess).toHaveBeenCalledWith([])
  })

  it('调用方 abort 后原始 signal 变为 aborted（取消能力不被适配层吞掉）', () => {
    const connector = createQQBindConnector()
    const controller = new AbortController()
    connector(
      { onQrDisplayed: vi.fn(), onSuccess: vi.fn(), onFailure: vi.fn(), onQrExpired: vi.fn() },
      { signal: controller.signal },
    )

    controller.abort()

    const { options } = firstCall()
    expect(options.signal?.aborted).toBe(true)
  })
})