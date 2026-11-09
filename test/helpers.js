import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { SwarmNode } from '../src/net/node.js'

export function tmpHome () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-swarm-test-'))
}

// A private DHT on localhost, so tests never touch the public network.
export async function testnet (t) {
  const net = await createTestnet(3)
  const nodes = []
  t.after(async () => {
    await Promise.all(nodes.map((n) => n.stop()))
    await net.destroy()
  })
  return {
    bootstrap: net.bootstrap,
    async node (nick) {
      const n = await new SwarmNode({ home: tmpHome(), bootstrap: net.bootstrap, nick }).start()
      nodes.push(n)
      return n
    },
    track (n) { nodes.push(n); return n }
  }
}

export async function until (check, { timeout = 20000, label = 'condition' } = {}) {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

export const ids = (node, topic) => [...node.swarms.get(topic).events.keys()].sort().join(',')
