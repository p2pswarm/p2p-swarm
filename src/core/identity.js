// Node identity: a single ed25519 keypair derived from a 32-byte seed.
//
// The same key is used for (a) the Noise transport handshake in Hyperswarm and
// (b) signing swarm events, so "the peer I am connected to" and "the author of
// this event" are the same cryptographic identity.
import crypto from 'node:crypto'

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export function createSeed () {
  return crypto.randomBytes(32)
}

export function identityFromSeed (seed) {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) throw new Error('identity seed must be 32 bytes')
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8'
  })
  const publicKey = crypto
    .createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
  return {
    seed,
    publicKey: Buffer.from(publicKey),
    id: Buffer.from(publicKey).toString('hex'),
    sign (data) {
      return crypto.sign(null, data, privateKey)
    }
  }
}

export function verifySignature (publicKeyHex, data, signature) {
  try {
    const raw = Buffer.from(publicKeyHex, 'hex')
    if (raw.length !== 32) return false
    const key = crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, raw]),
      format: 'der',
      type: 'spki'
    })
    return crypto.verify(null, data, key, signature)
  } catch {
    return false
  }
}

export function shortId (id) {
  return typeof id === 'string' ? id.slice(0, 10) : ''
}
