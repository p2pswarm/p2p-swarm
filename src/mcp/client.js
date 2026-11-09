// Finds, starts and talks to the local daemon. Zero dependencies on purpose:
// this module is loaded by the MCP server, which must start instantly even on
// a fresh plugin install where `npm install` has not run yet.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export function homeDir () {
  return process.env.P2P_SWARM_HOME || path.join(os.homedir(), '.p2p-swarm')
}

function readInfo () {
  try {
    return JSON.parse(fs.readFileSync(path.join(homeDir(), 'daemon.json'), 'utf8'))
  } catch {
    return null
  }
}

async function call (info, route, body, timeoutMs = 10000) {
  const res = await fetch(`http://127.0.0.1:${info.port}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${info.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || `daemon returned ${res.status}`)
  return json
}

export async function findDaemon () {
  const info = readInfo()
  if (!info) return null
  try {
    const pong = await call(info, '/api/ping', null, 1500)
    return pong.name === 'p2p-swarm' ? info : null
  } catch {
    return null
  }
}

function run (command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options)
    let output = ''
    child.stdout?.on('data', (d) => { output += d })
    child.stderr?.on('data', (d) => { output += d })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(output) : reject(new Error(`${command} exited with ${code}: ${output.slice(-400)}`))))
  })
}

let installing = null
function ensureDependencies () {
  if (fs.existsSync(path.join(ROOT, 'node_modules', 'hyperswarm', 'package.json'))) return Promise.resolve()
  installing ||= run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: ROOT, shell: process.platform === 'win32' })
    .finally(() => { installing = null })
  return installing
}

let starting = null
export function ensureDaemon () {
  starting ||= (async () => {
    let info = await findDaemon()
    if (info) return info
    await ensureDependencies()
    fs.mkdirSync(homeDir(), { recursive: true, mode: 0o700 })
    const log = fs.openSync(path.join(homeDir(), 'daemon.log'), 'a', 0o600)
    spawn(process.execPath, [path.join(ROOT, 'src', 'daemon', 'main.js')], {
      detached: true,
      stdio: ['ignore', log, log],
      env: process.env
    }).unref()
    fs.closeSync(log)
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      info = await findDaemon()
      if (info) return info
    }
    throw new Error(`the swarm daemon did not start; see ${path.join(homeDir(), 'daemon.log')}`)
  })().finally(() => { starting = null })
  return starting
}

export async function api (route, body, timeoutMs) {
  return call(await ensureDaemon(), route, body, timeoutMs)
}

export async function action (name, params) {
  return (await api('/api/action', { action: name, params })).result
}

export async function dashboardUrl () {
  const info = await ensureDaemon()
  return `http://127.0.0.1:${info.port}/#t=${info.token}`
}

export function openInBrowser (url) {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
    return true
  } catch {
    return false
  }
}
