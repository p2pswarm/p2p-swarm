// Swarm links. A link is a capability: whoever holds it can find the swarm on
// the DHT, prove membership to other peers, and read/write its event log.
//
//   swarm://<64 hex chars of swarm key>?name=<display name>
//
// The DHT only ever sees `topic = H(key)`, never the key itself, so observing
// the DHT does not let you join.
import crypto from 'node:crypto'

const SCHEME = 'swarm://'
export const LOBBY_NAME = 'lobby'

export function createSwarmKey () {
  return crypto.randomBytes(32)
}

export function topicFromKey (key) {
  return crypto.createHash('sha256').update('p2p-swarm/topic/v1').update(key).digest()
}

// The lobby is a well-known public swarm that anyone can opt in to. It exists
// so that swarms can be advertised and discovered without any server.
export function lobbyKey () {
  return crypto.createHash('sha256').update('p2p-swarm/lobby/v1').digest()
}

export function encodeLink (key, name) {
  const base = SCHEME + key.toString('hex')
  return name ? `${base}?name=${encodeURIComponent(name)}` : base
}

export function parseLink (input) {
  if (typeof input !== 'string') throw new Error('swarm link must be a string')
  const text = input.trim()
  if (text.toLowerCase() === LOBBY_NAME) return { key: lobbyKey(), name: LOBBY_NAME }
  const body = text.toLowerCase().startsWith(SCHEME) ? text.slice(SCHEME.length) : text
  const [hex, query = ''] = body.split('?')
  const clean = hex.replace(/\/+$/, '')
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error('invalid swarm link: expected swarm://<64 hex characters>')
  }
  let name = null
  for (const part of query.split('&')) {
    const [k, v = ''] = part.split('=')
    if (k === 'name') {
      try { name = decodeURIComponent(v).slice(0, 80) } catch { name = null }
    }
  }
  return { key: Buffer.from(clean, 'hex'), name }
}
