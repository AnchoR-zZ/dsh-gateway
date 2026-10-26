#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'

import { CHANNEL_ADD_PATH, CHANNEL_ENABLE_PATH, DEFAULT_GATEWAY_HTTP_PORT } from './http/protocol.js'

/**
 * `dsh-gateway` CLI：channel 管理子命令的瘦 HTTP 客户端。参数解析 → （缺失时交互输入）→
 * 组装请求打运行中网关进程的本机管理路由 → 按响应输出；不做业务判断、不做离线写配置。
 *
 * 命令集（本期）：`channel add qq`、`channel enable qq`。`appSecret` 缺参时交互输入且不
 * 回显；HTTP 用全局 fetch，不新增依赖。网关未运行（连接被拒等）时报错并提示先启动网关。
 */

const USAGE = [
  'usage: dsh-gateway channel add qq [--app-id <id>] [--app-secret <secret>] [--force] [--port <n>]',
  '       dsh-gateway channel enable qq [--app-id <id>] [--port <n>]',
  '       value options also accept the --flag=value form (e.g. --app-secret=xxx, --port=17890)',
].join('\n')

/** 已解析的子命令；`unsupported`/`invalid` 为不发起请求的失败形态。 */
export type ChannelCommand =
  | { kind: 'add'; appId?: string; appSecret?: string; force: boolean; port: number }
  | { kind: 'enable'; appId?: string; port: number }
  | { kind: 'unsupported'; message: string }
  | { kind: 'invalid'; message: string }

function invalid(message: string): ChannelCommand {
  return { kind: 'invalid', message }
}

/** 解析 `channel` 子命令参数（纯函数，不发请求、不读 stdin）。 */
export function parseChannelCommand(argv: readonly string[]): ChannelCommand {
  if (argv.length === 0 || argv[0] !== 'channel') {
    return invalid(USAGE)
  }
  const verb = argv[1]
  if (verb !== 'add' && verb !== 'enable') {
    return invalid(`unknown command "${verb ?? ''}"; ${USAGE}`)
  }
  const channelType = argv[2]
  if (channelType === 'weixin') {
    return { kind: 'unsupported', message: 'the weixin channel is not supported yet' }
  }
  if (channelType !== 'qq') {
    return invalid(`unknown channel type "${channelType ?? ''}"; only qq is supported`)
  }

  let appId: string | undefined
  let appSecret: string | undefined
  let force = false
  let port = DEFAULT_GATEWAY_HTTP_PORT
  const allowed = new Set<string>(verb === 'add' ? ['--app-id', '--app-secret', '--force', '--port'] : ['--app-id', '--port'])
  for (let i = 3; i < argv.length; i += 1) {
    const token = argv[i]!
    // 值参数支持 `--flag=value` 形式：以 `=` 内联的值不再按"下一个 token 是否以 -- 开头"
    // 判缺参，允许值本身以 `--` 开头（如 --app-secret=--weird）。
    const eq = token.indexOf('=')
    const flag = eq === -1 ? token : token.slice(0, eq)
    if (!allowed.has(flag)) {
      return invalid(`unknown option "${flag}" for "channel ${verb}"; ${USAGE}`)
    }
    if (flag === '--force') {
      if (eq !== -1) {
        return invalid(`option --force does not take a value; ${USAGE}`)
      }
      force = true
      continue
    }
    let value: string | undefined
    if (eq !== -1) {
      value = token.slice(eq + 1)
    } else {
      value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        return invalid(`option ${flag} requires a value; ${USAGE}`)
      }
      i += 1
    }
    if (flag === '--app-id') {
      appId = value
    } else if (flag === '--app-secret') {
      appSecret = value
    } else if (/^\d+$/.test(value)) {
      const parsedPort = Number.parseInt(value, 10)
      if (parsedPort < 1 || parsedPort > 65_535) {
        return invalid(`invalid port "${value}"; must be 1-65535`)
      }
      port = parsedPort
    } else {
      return invalid(`invalid port "${value}"; must be 1-65535`)
    }
  }
  return verb === 'add' ? { kind: 'add', appId, appSecret, force, port } : { kind: 'enable', appId, port }
}

/** CLI 的可注入 IO（测试替身用）；默认实现使用全局 fetch 与 readline。 */
export interface CliIO {
  fetch(url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{ status: number; text(): Promise<string> }>
  prompt(question: string, options?: { secret?: boolean }): Promise<string>
  print(text: string): void
}

interface AdminSuccessBody {
  ok?: unknown
  channel?: unknown
  state?: unknown
  detail?: unknown
}

interface AdminErrorBody {
  error?: { code?: unknown; message?: unknown }
}

function describeErrorBody(payload: unknown, rawText: string): string {
  const parsed = payload as AdminErrorBody | null
  const message = parsed?.error?.message
  const code = parsed?.error?.code
  const base = typeof message === 'string' && message !== '' ? message : rawText.slice(0, 200)
  return typeof code === 'string' && code !== '' ? `${base} [${code}]` : base
}

/**
 * 交互输入的一次提问；输入流不可用（stdin 关闭/EOF，prompt reject）时输出带参数形式的
 * 明确报错并返回 undefined（调用方以非零码退出），不把"没有输入"当空答案。
 */
async function promptOrReport(
  io: CliIO,
  question: string,
  secret: boolean,
): Promise<string | undefined> {
  try {
    return await io.prompt(question, secret ? { secret: true } : undefined)
  } catch {
    io.print(
      'error: interactive input is unavailable (stdin closed); pass --app-id/--app-secret explicitly (the --flag=value form also works)',
    )
    return undefined
  }
}

/**
 * 执行已解析的命令：缺参交互补齐 → POST 管理路由 → 输出结果。返回进程退出码；
 * `state: "blocked"` 视为明确报错（非零退出），其余失败路径同样非零。
 */
export async function runChannelCommand(command: ChannelCommand, io: CliIO): Promise<number> {
  if (command.kind === 'unsupported') {
    io.print(`error: ${command.message}`)
    return 1
  }
  if (command.kind === 'invalid') {
    io.print(`error: ${command.message}`)
    return 1
  }
  let appId = command.appId?.trim()
  let appSecret = command.kind === 'add' ? command.appSecret?.trim() : undefined
  if (command.kind === 'add') {
    if (appId === undefined || appId === '') {
      const input = await promptOrReport(io, 'QQ App ID: ', false)
      if (input === undefined) {
        return 1
      }
      appId = input.trim()
    }
    if (appId === '') {
      io.print('error: app id must not be empty')
      return 1
    }
    if (appSecret === undefined || appSecret === '') {
      const input = await promptOrReport(io, 'QQ App Secret: ', true)
      if (input === undefined) {
        return 1
      }
      appSecret = input.trim()
    }
    if (appSecret === '') {
      io.print('error: app secret must not be empty')
      return 1
    }
  }

  const path = command.kind === 'add' ? CHANNEL_ADD_PATH : CHANNEL_ENABLE_PATH
  const body =
    command.kind === 'add'
      ? { appId, appSecret, force: command.force }
      : appId !== undefined && appId !== ''
        ? { appId }
        : {}

  let response: { status: number; text(): Promise<string> }
  try {
    response = await io.fetch(`http://127.0.0.1:${command.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    io.print(`error: cannot reach the gateway at 127.0.0.1:${command.port}; start the gateway service first`)
    return 1
  }

  const rawText = await response.text()
  let payload: unknown = null
  try {
    payload = JSON.parse(rawText) as unknown
  } catch {
    payload = null
  }
  const success = payload as AdminSuccessBody | null
  if (response.status >= 200 && response.status < 300 && success?.ok === true) {
    const channel = typeof success.channel === 'string' ? success.channel : 'channel'
    const state = typeof success.state === 'string' ? success.state : 'unknown'
    const detail = typeof success.detail === 'string' ? success.detail : undefined
    if (state === 'blocked') {
      io.print(`error: ${channel} is blocked${detail === undefined ? '' : `: ${detail}`}`)
      return 1
    }
    io.print(`ok: ${channel} is ${state}${detail === undefined ? '' : ` (${detail})`}`)
    return 0
  }
  io.print(`error: ${describeErrorBody(payload, rawText)}`)
  return 1
}

/** 默认交互输入：readline；secret 提示经吞写 Writable 不回显。 */
function createReadlinePrompt(): CliIO['prompt'] {
  return (question, options?: { secret?: boolean }) =>
    new Promise<string>((resolve, reject) => {
      let muted = false
      const output = new Writable({
        write(chunk, _encoding, callback) {
          if (!muted) {
            process.stdout.write(chunk, () => undefined)
          }
          callback()
        },
      })
      const rl = createInterface({ input: process.stdin, output, terminal: true })
      muted = options?.secret === true
      let answered = false
      rl.question(question, (answer) => {
        answered = true
        rl.close()
        if (options?.secret === true) {
          process.stdout.write('\n')
        }
        resolve(answer)
      })
      // stdin 关闭（非 TTY/EOF）时 question 回调不会触发：reject 走明确的报错路径，
      // 避免进程悬挂或把"没有输入"静默当成空答案。
      rl.on('close', () => {
        if (!answered) {
          reject(new Error('stdin closed before an answer was provided'))
        }
      })
    })
}

function createDefaultIO(): CliIO {
  return {
    fetch: (url, init) => fetch(url, init) as unknown as Promise<{ status: number; text(): Promise<string> }>,
    prompt: createReadlinePrompt(),
    print: (text) => console.log(text),
  }
}

/** CLI 主流程；返回退出码，由入口写入 process.exitCode。 */
export async function main(argv: readonly string[]): Promise<number> {
  return runChannelCommand(parseChannelCommand(argv), createDefaultIO())
}

// 直接以 node 执行本模块时才运行 main（import 时不执行）。
const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
