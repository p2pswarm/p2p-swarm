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

export async function startDaemon ({ home = defaultHome(), port = Number(process.env.P2P_SWARM_PORT) || DEFAULT_PORT, bootstrap = parseBootstrap(process.env.P2P_SWARM_BOOTSTRAP) } = {}) {
  const node = await new SwarmNode({ home, bootstrap }).start()
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
    await node.stop().catch(() => {})
  }
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

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const daemon = await startDaemon()
  console.log(`p2p-swarm ${pkg.version} node ${daemon.node.id.slice(0, 10)} listening on 127.0.0.1:${daemon.info.port}`)
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => daemon.shutdown().then(() => process.exit(0)))
  }
}
