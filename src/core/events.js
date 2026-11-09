// Signed events: the only thing that ever travels between peers.
//
// An event is an immutable, self-authenticating record. Its id is the hash of
// its canonical encoding and its signature covers that id, so any peer can
// relay any event without being trusted.
import crypto from 'node:crypto'
import { verifySignature } from './identity.js'

export const PROTOCOL_VERSION = 1
export const MAX_EVENT_BYTES = 256 * 1024
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000
export const MAX_LEASE_MS = 60 * 60 * 1000
export const DEFAULT_LEASE_MS = 15 * 60 * 1000
// Lamport clocks are author-supplied; cap them so one hostile event cannot push
// the clock out of safe-integer range for everybody else.
export const MAX_LAMPORT = 2 ** 40

const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/
const TASK_REF = /^[0-9a-f]{64}(:\d{1,3})?$/

export function canonical (value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  return '{' + Object.keys(value).sort()
    .filter((k) => value[k] !== undefined)
    .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
    .join(',') + '}'
}

function str (v, max, { min = 1 } = {}) {
  return typeof v === 'string' && v.length >= min && v.length <= max
}
function optStr (v, max) {
  return v === undefined || str(v, max, { min: 0 })
}
function onlyKeys (obj, keys) {
  return obj !== null && typeof obj === 'object' && !Array.isArray(obj) &&
    Object.keys(obj).every((k) => keys.includes(k))
}

// One validator per event type. Unknown types and unknown fields are rejected:
// peers must not be able to smuggle unreviewed data through the log.
const VALIDATORS = {
  'peer.hello': (b) => onlyKeys(b, ['nick', 'agent']) && str(b.nick, 40) && optStr(b.agent, 40),
  'job.post': (b) => onlyKeys(b, ['title', 'description', 'tasks', 'tags']) &&
    str(b.title, 200) && str(b.description, 20000, { min: 0 }) &&
    Array.isArray(b.tasks) && b.tasks.length >= 1 && b.tasks.length <= 64 &&
    b.tasks.every((t) => onlyKeys(t, ['title', 'description']) && str(t.title, 200) && optStr(t.description, 20000)) &&
    (b.tags === undefined || (Array.isArray(b.tags) && b.tags.length <= 8 && b.tags.every((t) => str(t, 32)))),
  'task.add': (b) => onlyKeys(b, ['job', 'title', 'description']) &&
    HEX64.test(b.job) && str(b.title, 200) && optStr(b.description, 20000),
  'task.claim': (b) => onlyKeys(b, ['task', 'leaseMs']) && TASK_REF.test(b.task) &&
    Number.isInteger(b.leaseMs) && b.leaseMs >= 10000 && b.leaseMs <= MAX_LEASE_MS,
  'task.release': (b) => onlyKeys(b, ['task']) && TASK_REF.test(b.task),
  'task.submit': (b) => onlyKeys(b, ['task', 'summary', 'content']) && TASK_REF.test(b.task) &&
    str(b.summary, 2000) && str(b.content, 200000, { min: 0 }),
  'task.review': (b) => onlyKeys(b, ['task', 'submission', 'verdict', 'note']) && TASK_REF.test(b.task) &&
    HEX64.test(b.submission) && (b.verdict === 'accept' || b.verdict === 'reject') && optStr(b.note, 4000),
  'job.close': (b) => onlyKeys(b, ['job', 'note']) && HEX64.test(b.job) && optStr(b.note, 4000),
  msg: (b) => onlyKeys(b, ['text', 'job']) && str(b.text, 8000) && (b.job === undefined || HEX64.test(b.job)),
  'swarm.advert': (b) => onlyKeys(b, ['name', 'description', 'link']) &&
    str(b.name, 80) && optStr(b.description, 1000) && str(b.link, 300) && /^swarm:\/\/[0-9a-f]{64}/.test(b.link)
}

export const EVENT_TYPES = Object.keys(VALIDATORS)

export function validateBody (type, body) {
  const check = VALIDATORS[type]
  if (!check) return `unknown event type "${type}"`
  try {
    return check(body) ? null : `invalid body for ${type}`
  } catch {
    return `invalid body for ${type}`
  }
}

function eventId (core) {
  return crypto.createHash('sha256').update(canonical(core)).digest()
}

function coreOf (e) {
  return { v: e.v, swarm: e.swarm, author: e.author, lamport: e.lamport, ts: e.ts, type: e.type, body: e.body }
}

export function createEvent (identity, { swarm, lamport, type, body, ts = Date.now() }) {
  const problem = validateBody(type, body)
  if (problem) throw new Error(problem)
  const core = { v: PROTOCOL_VERSION, swarm, author: identity.id, lamport, ts, type, body }
  const id = eventId(core)
  const event = { ...core, id: id.toString('hex'), sig: identity.sign(id).toString('hex') }
  if (Buffer.byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES) throw new Error('event too large')
  return event
}

// Returns null if the event is valid, otherwise a human readable reason.
export function checkEvent (e, { swarm, now = Date.now() } = {}) {
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return 'not an object'
  if (!onlyKeys(e, ['v', 'swarm', 'author', 'lamport', 'ts', 'type', 'body', 'id', 'sig'])) return 'unexpected fields'
  if (e.v !== PROTOCOL_VERSION) return 'unsupported version'
  if (!HEX64.test(e.swarm) || !HEX64.test(e.author) || !HEX64.test(e.id) || !HEX128.test(e.sig)) return 'malformed ids'
  if (swarm && e.swarm !== swarm) return 'wrong swarm'
  if (!Number.isSafeInteger(e.lamport) || e.lamport < 1 || e.lamport > MAX_LAMPORT) return 'bad lamport'
  if (!Number.isSafeInteger(e.ts) || e.ts < 0) return 'bad timestamp'
  if (e.ts > now + MAX_FUTURE_SKEW_MS) return 'timestamp too far in the future'
  if (typeof e.type !== 'string') return 'bad type'
  const problem = validateBody(e.type, e.body)
  if (problem) return problem
  let size
  try { size = Buffer.byteLength(JSON.stringify(e)) } catch { return 'unserializable' }
  if (size > MAX_EVENT_BYTES) return 'event too large'
  const id = eventId(coreOf(e))
  if (id.toString('hex') !== e.id) return 'id does not match content'
  if (!verifySignature(e.author, id, Buffer.from(e.sig, 'hex'))) return 'bad signature'
  return null
}

export function compareEvents (a, b) {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
