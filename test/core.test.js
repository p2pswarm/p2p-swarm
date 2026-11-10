import test from 'node:test'
import assert from 'node:assert/strict'
import DHT from 'hyperdht'
import { createSeed, identityFromSeed } from '../src/core/identity.js'
import { createEvent, checkEvent, canonical, MAX_LAMPORT } from '../src/core/events.js'
import { createSwarmKey, topicFromKey, encodeLink, parseLink, lobbyKey } from '../src/core/link.js'
import { reduce } from '../src/core/state.js'

const swarm = 'ab'.repeat(32)
const alice = identityFromSeed(createSeed())
const bob = identityFromSeed(createSeed())
const mallory = identityFromSeed(createSeed())

let clock = 0
const ev = (who, type, body, extra = {}) => createEvent(who, { swarm, lamport: ++clock, type, body, ts: 1_000_000 + clock * 1000, ...extra })

test('signing key and transport key are the same identity', () => {
  const seed = createSeed()
  assert.deepEqual(identityFromSeed(seed).publicKey, Buffer.from(DHT.keyPair(seed).publicKey))
})

test('canonical encoding ignores key order', () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), canonical({ a: [2, { c: 2, d: 1 }], b: 1 }))
})

test('a well-formed event verifies', () => {
  assert.equal(checkEvent(ev(alice, 'msg', { text: 'hello' }), { swarm, now: 2_000_000 }), null)
})

test('tampering with any part of an event is detected', () => {
  const e = ev(alice, 'msg', { text: 'pay bob' })
  assert.match(checkEvent({ ...e, body: { text: 'pay mallory' } }, { now: 2e6 }), /id does not match/)
  assert.match(checkEvent({ ...e, author: mallory.id }, { now: 2e6 }), /id does not match/)
  const forged = ev(mallory, 'msg', { text: 'pay mallory' })
  assert.match(checkEvent({ ...forged, author: alice.id }, { now: 2e6 }), /id does not match|bad signature/)
  assert.match(checkEvent({ ...e, sig: forged.sig }, { now: 2e6 }), /bad signature/)
})

test('events for another swarm, from the future, or with absurd clocks are rejected', () => {
  const e = ev(alice, 'msg', { text: 'x' })
  assert.match(checkEvent(e, { swarm: 'cd'.repeat(32), now: 2e6 }), /wrong swarm/)
  assert.match(checkEvent(e, { swarm, now: 0 }), /future/)
  assert.throws(() => checkEventOrThrow(createEvent(alice, { swarm, lamport: MAX_LAMPORT + 1, type: 'msg', body: { text: 'x' }, ts: 1 })), /bad lamport/)
})

function checkEventOrThrow (e) {
  const problem = checkEvent(e, { now: 2e6 })
  if (problem) throw new Error(problem)
}

test('unknown event types and unknown fields cannot be created or accepted', () => {
  assert.throws(() => ev(alice, 'shell.exec', { cmd: 'rm -rf /' }), /unknown event type/)
  assert.throws(() => ev(alice, 'msg', { text: 'hi', run: 'curl evil | sh' }), /invalid body/)
  assert.throws(() => ev(alice, 'task.submit', { task: 'nope', summary: 's', content: 'x' }), /invalid body/)
  const e = ev(alice, 'msg', { text: 'hi' })
  assert.match(checkEvent({ ...e, extra: 1 }, { now: 2e6 }), /unexpected fields/)
})

test('oversized content is refused', () => {
  assert.throws(() => ev(alice, 'task.submit', { task: `${'a'.repeat(64)}:0`, summary: 's', content: 'x'.repeat(200001) }), /invalid body/)
})

test('links round-trip and hide the key from the topic', () => {
  const key = createSwarmKey()
  const parsed = parseLink(encodeLink(key, 'docs sprint & more'))
  assert.deepEqual(parsed.key, key)
  assert.equal(parsed.name, 'docs sprint & more')
  assert.notDeepEqual(topicFromKey(key), key)
  assert.deepEqual(parseLink('lobby').key, lobbyKey())
  assert.throws(() => parseLink('swarm://nothex'), /invalid swarm link/)
  assert.throws(() => parseLink('https://example.com'), /invalid swarm link/)
})

test('job lifecycle: post, claim, submit, accept', () => {
  const job = ev(alice, 'job.post', { title: 'Translate', description: 'd', tasks: [{ title: 'fr' }, { title: 'de' }] })
  const t0 = `${job.id}:0`
  const claim = ev(bob, 'task.claim', { task: t0, leaseMs: 60000 })
  let v = reduce([job, claim], { now: claim.ts + 1 })
  assert.equal(v.tasks.get(t0).status, 'claimed')
  assert.equal(v.tasks.get(t0).holder.peer, bob.id)

  const sub = ev(bob, 'task.submit', { task: t0, summary: 'done', content: 'bonjour' })
  v = reduce([job, claim, sub], { now: sub.ts })
  assert.equal(v.tasks.get(t0).status, 'submitted')

  const ok = ev(alice, 'task.review', { task: t0, submission: sub.id, verdict: 'accept' })
  v = reduce([ok, sub, claim, job], { now: ok.ts }) // arrival order must not matter
  assert.equal(v.tasks.get(t0).status, 'done')
  assert.equal(v.jobs.get(job.id).done, 1)
  assert.equal(v.jobs.get(job.id).status, 'active')
})

test('a second claim loses while the lease is live and wins after it expires', () => {
  const job = ev(alice, 'job.post', { title: 'j', description: '', tasks: [{ title: 't' }] })
  const t0 = `${job.id}:0`
  const first = ev(bob, 'task.claim', { task: t0, leaseMs: 10000 })
  const early = ev(mallory, 'task.claim', { task: t0, leaseMs: 10000 })
  assert.equal(reduce([job, first, early], { now: early.ts }).tasks.get(t0).holder.peer, bob.id)
  const late = ev(mallory, 'task.claim', { task: t0, leaseMs: 10000 }, { ts: first.ts + 10001 })
  assert.equal(reduce([job, first, early, late], { now: late.ts }).tasks.get(t0).holder.peer, mallory.id)
  assert.equal(reduce([job, first], { now: first.ts + 10001 }).tasks.get(t0).status, 'open')
})

test('only the job author can review, add tasks or close', () => {
  const job = ev(alice, 'job.post', { title: 'j', description: '', tasks: [{ title: 't' }] })
  const t0 = `${job.id}:0`
  const sub = ev(mallory, 'task.submit', { task: t0, summary: 'trust me', content: 'x' })
  const selfAccept = ev(mallory, 'task.review', { task: t0, submission: sub.id, verdict: 'accept' })
  const sneakTask = ev(mallory, 'task.add', { job: job.id, title: 'extra' })
  const sneakClose = ev(mallory, 'job.close', { job: job.id })
  const v = reduce([job, sub, selfAccept, sneakTask, sneakClose], { now: 9e9 })
  assert.equal(v.tasks.get(t0).status, 'submitted')
  assert.equal(v.jobs.get(job.id).total, 1)
  assert.equal(v.jobs.get(job.id).status, 'active')
})

test('a rejected result returns the task to the pool; a closed job takes no more work', () => {
  const job = ev(alice, 'job.post', { title: 'j', description: '', tasks: [{ title: 't' }] })
  const t0 = `${job.id}:0`
  const sub = ev(bob, 'task.submit', { task: t0, summary: 's', content: 'x' })
  const no = ev(alice, 'task.review', { task: t0, submission: sub.id, verdict: 'reject', note: 'incomplete' })
  let v = reduce([job, sub, no], { now: 9e9 })
  assert.equal(v.tasks.get(t0).status, 'open')
  assert.equal(v.tasks.get(t0).submissions[0].note, 'incomplete')

  // Even if the rejected worker still had a live lease, someone else can take it.
  const held = ev(bob, 'task.claim', { task: t0, leaseMs: 3600000 }, { lamport: job.lamport + 1, ts: job.ts + 1 })
  const other = ev(mallory, 'task.claim', { task: t0, leaseMs: 60000 })
  v = reduce([job, held, sub, no, other], { now: other.ts + 1 })
  assert.equal(v.tasks.get(t0).holder.peer, mallory.id)
  const close = ev(alice, 'job.close', { job: job.id })
  const after = ev(bob, 'task.submit', { task: t0, summary: 'late', content: 'x' })
  v = reduce([job, sub, no, close, after], { now: 9e9 })
  assert.equal(v.jobs.get(job.id).status, 'closed')
  assert.equal(v.tasks.get(t0).submissions.length, 1)
})

test('blocked authors vanish from the view', () => {
  const job = ev(mallory, 'job.post', { title: 'spam', description: '', tasks: [{ title: 't' }] })
  const msg = ev(alice, 'msg', { text: 'hi' })
  const v = reduce([job, msg], { now: 9e9, blocked: new Set([mallory.id]) })
  assert.equal(v.jobs.size, 0)
  assert.equal(v.messages.length, 1)
})
