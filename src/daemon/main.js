#!/usr/bin/env node
// swarmd: the long-running local node. One per user; every Claude session and
// the dashboard talk to it over localhost.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { SwarmNode } from '../net/node.js'
import { defaultHome } from '../core/store.js'
import { createApi } from './api.js'
import { isMain } from '../core/main.js'

const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'))
export const DEFAULT_PORT = 7717

function parseBootstrap (text) {
  if (!text) return undefined
  return text.split(',').map((entry) => {
    const [host, port] = entry.trim().split(':')
    return { host, port: Number(port) }
  })
}

function listen (server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}

// One daemon per state directory. Two would share an identity, fight over the
// log file and overwrite each other's connection details, and it is easy to
// trigger: two Claude sessions starting at the same moment both try to launch one.
const heldLocks = new Set()

function processAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

function readPid (file) {
  try {
    return Number(fs.readFileSync(file, 'utf8').trim()) || 0
  } catch {
    return null // no such file
  }
}

// Atomic lock file. Three rules make it safe when several processes start in
// the same instant:
//   1. The lock is created by hard-linking a fully written temp file, so it is
//      never visible empty or half-written.
//   2. A stale lock (dead pid) is taken out of the way with rename, which only
//      one contender can win. If the file we renamed turns out to belong to a
//      live process (someone replaced the stale lock first), it is put back.
//   3. After acquiring, we wait briefly and re-read: if the lock no longer
//      names us, another process won a race and we stand down.
async function acquireLock (home) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const file = path.join(home, 'daemon.lock')
  const mine = String(process.pid)
  const tmp = `${file}.${mine}.tmp`
  const locked = (pid) => Object.assign(new Error(`another p2p-swarm daemon (pid ${pid}) is already running for ${home}`), { code: 'ELOCKED' })
  const isLive = (pid) => (pid === process.pid ? heldLocks.has(file) : pid > 0 && processAlive(pid))

  for (let attempt = 0; attempt < 8; attempt++) {
    fs.writeFileSync(tmp, mine, { mode: 0o600 })
    try {
      fs.linkSync(tmp, file)
    } catch (err) {
      fs.rmSync(tmp, { force: true })
      if (err.code !== 'EEXIST') throw err
      const owner = readPid(file)
      if (owner === null) continue // vanished between link and read: try again
      if (isLive(owner)) throw locked(owner)
      const aside = `${file}.${mine}.stale`
      try {
        fs.renameSync(file, aside)
      } catch {
        continue // someone else is already clearing it
      }
      const taken = readPid(aside)
      if (taken !== owner && isLive(taken)) {
        fs.renameSync(aside, file) // we grabbed a fresh lock by mistake: give it back
        throw locked(taken)
      }
      fs.rmSync(aside, { force: true })
      continue
    }
    fs.rmSync(tmp, { force: true })
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.floor(Math.random() * 60)))
    const owner = readPid(file)
    if (owner === process.pid) {
      heldLocks.add(file)
      return file
    }
    if (owner && isLive(owner)) throw locked(owner)
  }
  throw new Error(`could not acquire ${file}`)
}

function releaseLock (file) {
  if (!heldLocks.delete(file)) return
  if (readPid(file) === process.pid) fs.rmSync(file, { force: true })
}

export async function startDaemon ({ home = defaultHome(), port = Number(process.env.P2P_SWARM_PORT) || DEFAULT_PORT, bootstrap = parseBootstrap(process.env.P2P_SWARM_BOOTSTRAP) } = {}) {
  const lock = await acquireLock(home)
  let node
  try {
    node = await new SwarmNode({ home, bootstrap }).start()
  } catch (err) {
    releaseLock(lock)
    throw err
  }
  const token = crypto.randomBytes(24).toString('hex')
  const infoFile = path.join(home, 'daemon.json')
  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    try {
      const current = JSON.parse(fs.readFileSync(infoFile, 'utf8'))
      if (current.pid === process.pid) fs.rmSync(infoFile, { force: true })
    } catch {}
    server.close()
    server.closeAllConnections()
    // Tearing down the DHT mid-bootstrap can stall; never let that keep the
    // lock (and so block the next start).
    await Promise.race([node.stop().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5000))])
    releaseLock(lock)
  }
  process.once('exit', () => releaseLock(lock))
  const server = createApi(node, { token, version: pkg.version, onShutdown: () => shutdown().then(() => process.exit(0)) })
  try {
    await listen(server, port)
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err
    await listen(server, 0) // preferred port is taken: let the OS pick one
  }
  const info = { pid: process.pid, port: server.address().port, token, version: pkg.version, startedAt: new Date().toISOString() }
  fs.writeFileSync(infoFile, JSON.stringify(info, null, 2), { mode: 0o600 })
  return { node, server, info, shutdown, url: `http://127.0.0.1:${info.port}/#t=${token}` }
}

// Runs a daemon until SIGINT/SIGTERM. The signal handlers go in before the
// daemon starts, so a stop request can never land in a window where it would
// kill the process without cleaning up its lock and connection file.
export async function runForeground (options) {
  let daemon = null
  let stopRequested = false
  const stop = () => {
    stopRequested = true
    if (daemon) daemon.shutdown().then(() => process.exit(0))
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop)
  try {
    daemon = await startDaemon(options)
  } catch (err) {
    console.error(err.code === 'ELOCKED' ? err.message : err)
    process.exit(err.code === 'ELOCKED' ? 0 : 1)
  }
  if (stopRequested) return stop()
  console.log(`p2p-swarm ${pkg.version} node ${daemon.node.id.slice(0, 10)} listening on 127.0.0.1:${daemon.info.port}`)
  return daemon
}

if (isMain(import.meta.url)) runForeground()
