#!/usr/bin/env node
/**
 * Dev-only launcher for the gateway dsh profile.
 *
 * Builds the plugin, then runs `dsh --profile gateway` in the foreground with
 * the fixed development data root `tmp/local-test`: `dsh-home/` is `DSH_HOME`
 * and `gateway-workspace/` is `DSH_GATEWAY_WORKSPACE`. Neither path can be
 * overridden. The `dsh` command is taken from `PATH`; no config file or
 * environment variable selects it.
 *
 * It only serves local integration testing; deployment starts dsh directly.
 */
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const DEV_ROOT = join(REPO_ROOT, 'tmp', 'local-test')
const PROFILE = 'gateway'
const DSH_HOME = join(DEV_ROOT, 'dsh-home')
const WORKSPACE = join(DEV_ROOT, 'gateway-workspace')

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function waitForExit(child) {
  return new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', (code) => {
      resolveExit(code ?? 1)
    })
  })
}

async function runCommand(command, args, options) {
  const code = await waitForExit(spawn(command, args, options))
  if (code !== 0) {
    throw new Error(`${[command, ...args].join(' ')} exited with ${String(code)}`)
  }
}

async function build() {
  console.log('gateway dev: building plugin (pnpm build)')
  const options = { stdio: 'inherit', cwd: REPO_ROOT, env: process.env }
  // pnpm may be a native executable or a shim depending on the installation;
  // going through the shell covers both forms.
  if (process.platform === 'win32') {
    await runCommand('pnpm build', [], { ...options, shell: true })
    return
  }
  await runCommand('pnpm', ['build'], options)
}

function spawnDsh(args, env) {
  const options = { stdio: 'inherit', cwd: REPO_ROOT, env }
  // `dsh` is a .cmd shim on Windows and needs the shell for PATHEXT lookup.
  // A single command string avoids passing an argument array to a shell.
  if (process.platform === 'win32') {
    return spawn(['dsh', ...args].join(' '), [], { ...options, shell: true })
  }
  return spawn('dsh', args, options)
}

async function launch() {
  const env = {
    ...process.env,
    DSH_HOME,
    DSH_GATEWAY_WORKSPACE: WORKSPACE,
    DSH_TELEMETRY_DISABLED: '1',
  }
  console.log(`gateway dev: DSH_HOME=${DSH_HOME}`)
  console.log(`gateway dev: DSH_GATEWAY_WORKSPACE=${WORKSPACE}`)
  console.log(`gateway dev: dsh --profile ${PROFILE}`)
  const child = spawnDsh(['--profile', PROFILE], env)
  // Ctrl+C reaches dsh through the console as well; swallow the first one so
  // the launcher waits for dsh to shut down. A second Ctrl+C exits directly.
  process.once('SIGINT', () => {})
  return waitForExit(child)
}

async function main() {
  await build()
  const code = await launch()
  process.exit(code)
}

main().catch((error) => {
  console.error(`gateway dev: ${errorMessage(error)}`)
  process.exit(1)
})
