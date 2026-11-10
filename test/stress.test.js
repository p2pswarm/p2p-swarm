// Harder scenarios: scale, contention, partitions, hostile input, lifecycle.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import createTestnet from 'hyperdht/testnet.js'
import { SwarmNode } from '../src/net/node.js'
import { startDaemon } from '../src/daemon/main.js'
import { encodeFrame, FrameDecoder, MAX_FRAME_BYTES } from '../src/net/wire.js'
import { reduce } from '../src/core/state.js'
import { testnet, until, ids, tmpHome } from './helpers.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const digest = (node, topic) => node.swarms.get(topic).digest.toString('hex')

test('a late joiner pulls a 3,000 event history and ends byte-identical', async (t) => {
  const net = await testnet(t)
  const alice = await net.node('alice')
  const swarm = alice.createSwarm('big')
  for (let i = 0; i < 300; i++) {
    const job = alice.publish(swarm.topic, 'job.post', { title: `job ${i}`, description: 'x'.repeat(200), tasks: [{ title: 'a' }, { title: 'b' }] })
    for (let k = 0; k < 9; k++) alice.publish(swarm.topic, 'msg', { text: `note ${i}.${k}`, job: job.id })
  }
  const total = alice.swarms.get(swarm.topic).events.size
  assert.equal(total, 3001)

  const bob = await net.node('bob')
  const started = Date.now()
  bob.joinSwarm(swarm.link)
  await until(() => bob.swarms.get(swarm.topic).events.size === total + 1 && alice.swarms.get(swarm.topic).events.size === total + 1, { label: 'full history', timeout: 30000 })
  t.diagnostic(`synced ${total} events in ${Date.now() - started}ms`)
  assert.equal(digest(alice, swarm.topic), digest(bob, swarm.topic))
  assert.equal(bob.view(swarm.topic).jobs.size, 300)
  assert.equal(bob.view(swarm.topic).messages.length, 2700)
})

test('sync works when the id list has to be sent in many parts', async (t) => {
  const net = await testnet(t)
  const alice = await net.node('alice')
  const bob = await net.node('bob')
  alice.havePartIds = 400 // force a multi-part exchange without needing a huge log
  bob.havePartIds = 400
  const swarm = alice.createSwarm('parts')
  for (let i = 0; i < 2500; i++) alice.publish(swarm.topic, 'msg', { text: `a${i}` })
  // bob has its own history that alice lacks, so both directions are exercised
  bob.joinSwarm(swarm.link)
  for (let i = 0; i < 1300; i++) bob.publish(swarm.topic, 'msg', { text: `b${i}` })
  await until(() => alice.swarms.get(swarm.topic).events.size === 3802 && bob.swarms.get(swarm.topic).events.size === 3802, { label: 'two-way multi-part sync', timeout: 30000 })
  assert.equal(digest(alice, swarm.topic), digest(bob, swarm.topic))

  // malformed part numbers are a protocol violation, not a crash
  const conn = bob.peers.get(alice.id).conn
  for (const bad of [{ part: 5, parts: 2 }, { part: -1, parts: 2 }, { part: 0, parts: 0 }, { part: 0.5, parts: 2 }, { part: 0, parts: 1e9 }]) {
    conn.write(encodeFrame({ t: 'have', topic: swarm.topic, ids: [], ...bad }))
  }
  const ok = alice.publish(swarm.topic, 'msg', { text: 'still fine' })
  await until(() => bob.swarms.get(swarm.topic).events.has(ok.id), { label: 'alice still serving' })
  assert.equal(alice.peers.get(bob.id).strikes, 5)
})

test('one busy peer can write far more than any old per-author limit', async (t) => {
  const net = await testnet(t)
  const alice = await net.node('alice')
  const swarm = alice.createSwarm('prolific')
  for (let i = 0; i < 7000; i++) alice.publish(swarm.topic, 'msg', { text: `m${i}` })
  const bob = await net.node('bob')
  bob.joinSwarm(swarm.link)
  await until(() => bob.swarms.get(swarm.topic).events.size === 7002, { label: 'all 7,000 from one author', timeout: 30000 })
  assert.equal(bob.view(swarm.topic).messages.length, 7000)
  assert.equal(bob.peers.get(alice.id).strikes, 0) // and relaying them is not held against anyone
  assert.equal(bob.banned.size, 0)
})

test('five peers racing for one task all agree on a single winner', async (t) => {
  const net = await testnet(t)
  const nodes = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((n) => net.node(n)))
  const swarm = nodes[0].createSwarm('race')
  const job = nodes[0].publish(swarm.topic, 'job.post', { title: 'j', description: '', tasks: [{ title: 'contested' }] })
  for (const n of nodes.slice(1)) n.joinSwarm(swarm.link)
  await until(() => nodes.every((n) => n.swarms.get(swarm.topic).events.has(job.id)), { label: 'job everywhere' })

  // Everyone claims in the same tick, before hearing about anyone else.
  for (const n of nodes) n.publish(swarm.topic, 'task.claim', { task: `${job.id}:0`, leaseMs: 60000 })
  await until(() => new Set(nodes.map((n) => ids(n, swarm.topic))).size === 1 && nodes[0].swarms.get(swarm.topic).events.size === 11, { label: 'convergence' })

  const winners = new Set(nodes.map((n) => n.view(swarm.topic).tasks.get(`${job.id}:0`).holder.peer))
  assert.equal(winners.size, 1)
})

test('two halves that worked while partitioned merge without losing anything', async (t) => {
  const net = await testnet(t)
  const alice = await net.node('alice')
  const bob = await net.node('bob')
  const swarm = alice.createSwarm('split')
  bob.joinSwarm(swarm.link)
  await until(() => bob.peers.get(alice.id)?.shared.has(swarm.topic), { label: 'connect' })

  // Partition: keep both running but cut the link and stop them finding each other.
  const bobHome = bob.store.home
  await bob.stop()
  const aJob = alice.publish(swarm.topic, 'job.post', { title: 'from alice', description: '', tasks: [{ title: 't' }] })
  const offline = new SwarmNode({ home: bobHome, bootstrap: [{ host: '127.0.0.1', port: 9 }] })
  await offline.start()
  const bJob = offline.publish(swarm.topic, 'job.post', { title: 'from bob', description: '', tasks: [{ title: 't' }] })
  offline.publish(swarm.topic, 'msg', { text: 'written offline' })
  await offline.stop()

  // Heal.
  const back = net.track(await new SwarmNode({ home: bobHome, bootstrap: net.bootstrap }).start())
  await until(() => ids(alice, swarm.topic) === ids(back, swarm.topic) && alice.swarms.get(swarm.topic).events.has(bJob.id), { label: 'merge' })
  for (const n of [alice, back]) {
    const v = n.view(swarm.topic)
    assert.ok(v.jobs.has(aJob.id) && v.jobs.has(bJob.id))
    assert.equal(v.messages.at(-1).text, 'written offline')
  }
})

test('maximum-size results and unicode survive the trip intact', async (t) => {
  const net = await testnet(t)
  const alice = await net.node('alice')
  const bob = await net.node('bob')
  const swarm = alice.createSwarm('heavy')
  const job = alice.publish(swarm.topic, 'job.post', { title: 'Übersetzung 翻訳 🐝', description: 'ligne\n\ttab "quotes" \\ back slash', tasks: [{ title: 'ต' }] })
  bob.joinSwarm(swarm.link)
  await until(() => bob.swarms.get(swarm.topic).events.has(job.id), { label: 'job' })
  const big = '🐝é漢'.repeat(30000) + 'x'.repeat(200000 - 120000) // exactly 200,000 UTF-16 units
  assert.equal(big.length, 200000)
  const subs = [0, 1, 2, 3].map((i) => bob.publish(swarm.topic, 'task.submit', { task: `${job.id}:0`, summary: `big ${i}`, content: big }))
  await until(() => subs.every((s) => alice.swarms.get(swarm.topic).events.has(s.id)), { label: 'big results', timeout: 30000 })
  const v = alice.view(swarm.topic)
  assert.equal(v.jobs.get(job.id).title, 'Übersetzung 翻訳 🐝')
  assert.equal(v.jobs.get(job.id).description, 'ligne\n\ttab "quotes" \\ back slash')
  assert.equal(v.tasks.get(`${job.id}:0`).submissions.length, 4)
  assert.ok(v.tasks.get(`${job.id}:0`).submissions.every((s) => s.content === big))
  assert.throws(() => bob.publish(swarm.topic, 'task.submit', { task: `${job.id}:0`, summary: 's', content: big + 'x' }), /invalid body/)
  // pathological escaping can still overflow the byte cap: that must be a clear error, not a crash
  assert.throws(() => bob.publish(swarm.topic, 'task.submit', { task: `${job.id}:0`, summary: 's', content: '\u0001'.repeat(200000) }), /too large to publish/)
})

test('leaving forgets a swarm; rejoining restores it from peers', async (t) => {
  const net = await testnet(t)
  const alice = await net.node('alice')
  const bob = await net.node('bob')
  const swarm = alice.createSwarm('revolving')
  const job = alice.publish(swarm.topic, 'job.post', { title: 'j', description: '', tasks: [{ title: 't' }] })
  bob.joinSwarm(swarm.link)
  await until(() => bob.swarms.get(swarm.topic).events.has(job.id), { label: 'sync' })
  await bob.leaveSwarm(swarm.topic)
  assert.equal(bob.swarms.size, 0)
  assert.equal(fs.existsSync(bob.store.logFile(swarm.topic)), false)
  assert.throws(() => bob.publish(swarm.topic, 'msg', { text: 'x' }), /not a member/)
  await until(() => !alice.peers.get(bob.id)?.shared.has(swarm.topic), { label: 'alice to notice' })
  bob.joinSwarm(swarm.link)
  await until(() => bob.swarms.get(swarm.topic)?.events.has(job.id), { label: 'resync' })
})

test('one connection carries several swarms and keeps them apart', async (t) => {
  const net = await testnet(t)
  const alice = await net.node('alice')
  const bob = await net.node('bob')
  const shared1 = alice.createSwarm('one')
  const shared2 = alice.createSwarm('two')
  const secret = alice.createSwarm('alice-only')
  const hidden = alice.publish(secret.topic, 'msg', { text: 'not for bob' })
  bob.joinSwarm(shared1.link)
  bob.joinSwarm(shared2.link)
  const m1 = alice.publish(shared1.topic, 'msg', { text: 'in one' })
  const m2 = bob.publish(shared2.topic, 'msg', { text: 'in two' })
  await until(() => bob.swarms.get(shared1.topic).events.has(m1.id) && alice.swarms.get(shared2.topic).events.has(m2.id), { label: 'both swarms' })
  assert.equal(alice.peers.get(bob.id).shared.size, 2)
  assert.equal(bob.swarms.has(secret.topic), false)
  for (const rec of bob.swarms.values()) assert.equal(rec.events.has(hidden.id), false)
  assert.equal(bob.swarms.get(shared1.topic).events.has(m2.id), false)
})

test('the frame decoder handles any chunking and rejects garbage', () => {
  const messages = [{ t: 'a', n: 1 }, { t: 'b', text: 'é'.repeat(5000) }, { t: 'c', list: Array(100).fill('x') }]
  const stream = Buffer.concat(messages.map(encodeFrame))
  for (const size of [1, 2, 3, 7, 64, 4096, stream.length]) {
    const got = []
    const decoder = new FrameDecoder((m) => got.push(m))
    for (let i = 0; i < stream.length; i += size) decoder.push(stream.subarray(i, i + size))
    assert.deepEqual(got, messages, `chunk size ${size}`)
  }
  const huge = Buffer.alloc(4)
  huge.writeUInt32BE(MAX_FRAME_BYTES + 1)
  assert.throws(() => new FrameDecoder(() => {}).push(huge), /oversized/)
  const notJson = Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from('{{{')])
  assert.throws(() => new FrameDecoder(() => {}).push(notJson))
  const notObject = Buffer.concat([Buffer.from([0, 0, 0, 4]), Buffer.from('null')])
  assert.throws(() => new FrameDecoder(() => {}).push(notObject), /bad frame/)
})

test('a peer sending protocol garbage cannot crash a node', async (t) => {
  const net = await testnet(t)
  const alice = await net.node('alice')
  const mallory = await net.node('mallory')
  const swarm = alice.createSwarm('fuzz')
  mallory.joinSwarm(swarm.link)
  await until(() => mallory.peers.get(alice.id)?.shared.has(swarm.topic), { label: 'connect' })
  const conn = mallory.peers.get(alice.id).conn
  const junk = [
    { t: 'events' }, { t: 'events', topic: swarm.topic }, { t: 'events', topic: swarm.topic, events: 'nope' },
    { t: 'events', topic: swarm.topic, events: [1, 'x', [], {}, { id: 5 }, { id: {} }] },
    { t: 'have', topic: swarm.topic }, { t: 'have', topic: swarm.topic, ids: [null, {}, 5] },
    { t: 'summary', topic: swarm.topic }, { t: 'summary', topic: 12 }, { t: 'summary', topic: '__proto__' },
    { t: '__proto__' }, { t: 'hello', v: 1, swarms: [null, 5, {}, { tag: 1, proof: 2 }] }, {}, { t: 'unknown' }
  ]
  for (const m of junk) conn.write(encodeFrame(m))
  const ok = alice.publish(swarm.topic, 'msg', { text: 'still alive' })
  await until(() => mallory.swarms.get(swarm.topic).events.has(ok.id), { label: 'alice still serving' })
  assert.equal(alice.swarms.get(swarm.topic).events.size, mallory.swarms.get(swarm.topic).events.size)
})

test('the reducer is order-independent and total on arbitrary valid histories', async (t) => {
  const net = await testnet(t)
  const nodes = await Promise.all(['a', 'b', 'c'].map((n) => net.node(n)))
  const swarm = nodes[0].createSwarm('chaos')
  for (const n of nodes.slice(1)) n.joinSwarm(swarm.link)
  await until(() => nodes.every((n) => n.peers.size === 2 && [...n.peers.values()].every((p) => p.shared.has(swarm.topic))), { label: 'mesh' })

  let seed = 42
  const rnd = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n
  const jobs = []
  const subs = []
  for (let i = 0; i < 400; i++) {
    const n = nodes[rnd(3)]
    const job = jobs[rnd(jobs.length || 1)]
    const roll = rnd(10)
    try {
      if (!job || roll === 0) jobs.push({ e: n.publish(swarm.topic, 'job.post', { title: `j${i}`, description: '', tasks: [{ title: 'x' }, { title: 'y' }] }), owner: n })
      else if (roll < 4) n.publish(swarm.topic, 'task.claim', { task: `${job.e.id}:${rnd(2)}`, leaseMs: 10000 + rnd(50000) })
      else if (roll < 6) { const task = `${job.e.id}:${rnd(2)}`; subs.push({ task, job, e: n.publish(swarm.topic, 'task.submit', { task, summary: 's', content: 'c' }) }) }
      else if (roll < 8 && subs.length) { const s = subs[rnd(subs.length)]; n.publish(swarm.topic, 'task.review', { task: s.task, submission: s.e.id, verdict: rnd(2) ? 'accept' : 'reject' }) }
      else if (roll === 8 && rnd(2)) n.publish(swarm.topic, 'task.add', { job: job.e.id, title: `extra ${i}`, needs: [`${job.e.id}:${rnd(2)}`] })
      else if (roll === 8) n.publish(swarm.topic, 'task.release', { task: `${job.e.id}:${rnd(2)}` })
      else if (rnd(8) === 0) job.owner.publish(swarm.topic, 'job.close', { job: job.e.id })
      else n.publish(swarm.topic, 'msg', { text: `m${i}`, job: job.e.id })
    } catch (err) { assert.fail(`publish threw: ${err.message}`) }
    if (i % 25 === 0) await new Promise((resolve) => setTimeout(resolve, 5))
  }
  await until(() => new Set(nodes.map((n) => ids(n, swarm.topic))).size === 1, { label: 'chaos convergence' })

  const snapshot = (events) => {
    const v = reduce(events, { now: 0 })
    return JSON.stringify([[...v.jobs.values()], [...v.tasks.values()], v.messages.length])
  }
  const events = [...nodes[0].swarms.get(swarm.topic).events.values()]
  const reference = snapshot(events)
  for (let round = 0; round < 5; round++) {
    const shuffled = [...events].sort(() => rnd(3) - 1)
    assert.equal(snapshot(shuffled), reference)
  }
  for (const n of nodes) assert.equal(snapshot([...n.swarms.get(swarm.topic).events.values()]), reference)
  const v = reduce(events, { now: 0 })
  for (const task of v.tasks.values()) {
    assert.ok(['open', 'claimed', 'blocked', 'done'].includes(task.status))
    assert.equal(task.done, task.submissions.some((s) => s.standing))
    assert.equal(task.done, task.accepted !== null)
    if (task.status === 'blocked') assert.ok(task.blockedBy.length > 0)
    if (task.final && task.done) assert.ok(v.jobs.get(task.job).taskIds.every((id) => v.tasks.get(id).submissions.length > 0))
  }
})

test('the local API survives hostile and malformed requests', async (t) => {
  const net = await createTestnet(3)
  const daemon = await startDaemon({ home: tmpHome(), port: 0, bootstrap: net.bootstrap })
  t.after(async () => { await daemon.shutdown(); await net.destroy() })
  const base = `http://127.0.0.1:${daemon.info.port}`
  const headers = { authorization: `Bearer ${daemon.info.token}`, 'content-type': 'application/json' }
  const post = (body, raw) => fetch(`${base}/api/action`, { method: 'POST', headers, body: raw ?? JSON.stringify(body) })

  assert.equal((await post(null, '{not json')).status, 400)
  assert.equal((await post(null, '[]')).status, 400)
  assert.equal((await post(null, 'null')).status >= 400, true)
  for (const action of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '', 5, null, { a: 1 }]) {
    assert.equal((await post({ action, params: {} })).status, 400, `action ${JSON.stringify(action)}`)
  }
  for (const params of [null, 'str', 5, [], { name: 5 }, { name: { $gt: '' } }, { name: '' }]) {
    const r = await post({ action: 'create_swarm', params })
    assert.equal(r.status, 400, `params ${JSON.stringify(params)}`)
  }
  assert.equal((await post(null, JSON.stringify({ action: 'create_swarm', params: { name: 'x'.repeat(3 * 1024 * 1024) } }))).status, 413)
  assert.equal((await fetch(`${base}/api/../../etc/passwd`, { headers })).status, 404)
  assert.equal((await fetch(`${base}/app.js/../../../package.json`)).status, 404)
  assert.equal((await fetch(`${base}/api/job?ref=zz`, { headers })).status >= 400, true)
  assert.equal((await fetch(`${base}/api/events?since=-5&wait=abc`, { headers })).status, 200)
  assert.equal((await fetch(`${base}/api/state`, { method: 'DELETE', headers })).status, 404)

  // still healthy, and none of that created anything
  const state = await (await fetch(`${base}/api/state`, { headers })).json()
  assert.equal(state.swarms.length, 0)
  const ok = await (await post({ action: 'create_swarm', params: { name: '  spaced   name  ' } })).json()
  assert.equal(ok.result.swarm, 'spaced   name')
  assert.equal({}.polluted, undefined)
})

test('short references are resolved safely', async (t) => {
  const net = await createTestnet(3)
  const daemon = await startDaemon({ home: tmpHome(), port: 0, bootstrap: net.bootstrap })
  t.after(async () => { await daemon.shutdown(); await net.destroy() })
  const headers = { authorization: `Bearer ${daemon.info.token}`, 'content-type': 'application/json' }
  const act = async (action, params) => {
    const r = await fetch(`http://127.0.0.1:${daemon.info.port}/api/action`, { method: 'POST', headers, body: JSON.stringify({ action, params }) })
    const j = await r.json()
    if (!r.ok) throw new Error(j.error)
    return j.result
  }
  await act('create_swarm', { name: 'Alpha' })
  await act('create_swarm', { name: 'beta' })
  await assert.rejects(act('post_job', { title: 't', description: '' }), /several swarms joined/)
  const job = await act('post_job', { swarm: 'ALPHA', title: 't', description: '', tasks: ['one', 'two'] })
  await assert.rejects(act('claim', { task: job.job.slice(0, 3) }), /too short/)
  await assert.rejects(act('claim', { task: job.job }), /no task matches/) // a job ref is not a task ref
  await assert.rejects(act('claim', { task: `${job.job}:7` }), /no task matches/)
  await assert.rejects(act('claim', { task: `${job.job}:1`, swarm: 'beta' }), /no task matches/)
  assert.equal((await act('claim', { task: `${job.job.toUpperCase()}:1` })).title, 'two')
  await assert.rejects(act('submit', { task: `${job.job}:1`, summary: 's' }), /"result" is required/)
  await assert.rejects(act('submit', { task: `${job.job}:1`, summary: 's', result: '' }), /"result" is required/)
  await assert.rejects(act('review', { task: `${job.job}:1`, verdict: 'accept' }), /no matching submission/)
  await assert.rejects(act('claim', { task: `${job.job}:final` }), /waiting for/)
  await act('submit', { task: `${job.job}:1`, summary: 's', result: 'r1' })
  await assert.rejects(act('claim', { task: `${job.job}:1` }), /already done/)
  await assert.rejects(act('review', { task: `${job.job}:1`, verdict: 'accept' }), /cannot review your own/)
  await assert.rejects(act('add_task', { job: job.job, title: 'x', needs: [`${job.job}:final`] }), /cannot depend on the final task/)
  await assert.rejects(act('add_task', { job: job.job, title: 'x', needs: ['ffffffffff:0'] }), /no task matches/)
  assert.deepEqual((await act('add_task', { job: job.job, title: 'x', needs: [`${job.job}:0`] })).needs, [`${job.job}:0`])
  await assert.rejects(act('leave_swarm', { swarm: 'nope' }), /no joined swarm/)
  await assert.rejects(act('advertise', { swarm: 'Alpha' }), /no joined swarm matches "lobby"/)
  await assert.rejects(act('advertise', { swarm: 'Alpha', in: 'Alpha' }), /inside itself/)
  assert.equal((await act('advertise', { swarm: 'Alpha', in: 'beta', description: 'come help' })).in, 'beta')
  await assert.rejects(act('block', { peer: 'short' }), /64-character/)
  await assert.rejects(act('block', { peer: daemon.node.id }), /yourself/)
  await assert.rejects(act('set_nick', { nick: '   ' }), /required|empty/)
})

test('only one daemon can own a state directory', async (t) => {
  const net = await createTestnet(3)
  const home = tmpHome()
  const env = { ...process.env, P2P_SWARM_HOME: home, P2P_SWARM_PORT: '0', P2P_SWARM_BOOTSTRAP: net.bootstrap.map((b) => `${b.host}:${b.port}`).join(',') }
  const children = []
  t.after(async () => { for (const c of children) c.kill('SIGKILL'); await net.destroy() })
  const launch = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src/daemon/main.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    let out = ''
    child.stdout.on('data', (d) => { out += d; if (out.includes('listening')) resolve({ child, out, running: true }) })
    child.stderr.on('data', (d) => { out += d })
    child.on('exit', (code) => resolve({ child, out, running: false, code }))
  })
  // Race many launches, as several Claude sessions opening at once would.
  const results = await Promise.all(Array.from({ length: 12 }, launch))
  const running = results.filter((r) => r.running)
  assert.equal(running.length, 1, results.map((r) => r.out).join('|'))
  for (const r of results.filter((x) => !x.running)) {
    assert.equal(r.code, 0)
    assert.match(r.out, /already running/)
  }
  const info = JSON.parse(fs.readFileSync(path.join(home, 'daemon.json'), 'utf8'))
  assert.equal(info.pid, running[0].child.pid)

  // A crashed daemon leaves its lock behind; the next start must take over.
  running[0].child.kill('SIGKILL')
  await new Promise((resolve) => running[0].child.on('exit', resolve))
  assert.ok(fs.existsSync(path.join(home, 'daemon.lock')))
  const identity = fs.readFileSync(path.join(home, 'identity.json'), 'utf8')
  // ...and when several try to take over at once, still exactly one wins.
  const takeover = await Promise.all(Array.from({ length: 8 }, launch))
  assert.equal(takeover.filter((r) => r.running).length, 1, takeover.map((r) => r.out).join('|'))
  const next = takeover.find((r) => r.running)
  assert.equal(fs.readFileSync(path.join(home, 'identity.json'), 'utf8'), identity, 'identity unchanged')
  assert.equal(fs.readdirSync(home).filter((f) => /\.(tmp|stale)$/.test(f)).length, 0, 'no lock debris')
  next.child.kill('SIGTERM')
  const [code, signal] = await new Promise((resolve) => next.child.on('exit', (c, sig) => resolve([c, sig])))
  assert.deepEqual([code, signal], [0, null], 'clean exit on SIGTERM')
  assert.equal(fs.existsSync(path.join(home, 'daemon.lock')), false, 'lock released')
  assert.equal(fs.existsSync(path.join(home, 'daemon.json')), false, 'connection info removed')
})

test('stop followed immediately by start works, repeatedly', async (t) => {
  const net = await createTestnet(3)
  const home = tmpHome()
  const env = { ...process.env, P2P_SWARM_HOME: home, P2P_SWARM_PORT: '0', P2P_SWARM_BOOTSTRAP: net.bootstrap.map((b) => `${b.host}:${b.port}`).join(',') }
  const cli = (...args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/swarm.js'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('exit', (code) => resolve({ code, out: out.trim() }))
  })
  t.after(async () => { await cli('stop'); await net.destroy() })

  const created = await cli('create', 'restartable')
  assert.equal(created.code, 0, created.out)
  const id = (await cli('status')).out.match(/node (\w+)/)[1]
  for (let i = 0; i < 3; i++) {
    assert.equal((await cli('stop')).out, 'daemon stopped')
    const status = await cli('status') // must relaunch the daemon on its own
    assert.equal(status.code, 0, status.out)
    assert.ok(status.out.includes(`node ${id}`) && status.out.includes('restartable'), status.out)
  }
  // and without waiting for stop to finish: fire the next command while it shuts down
  const [stopped, status] = await Promise.all([cli('stop'), new Promise((resolve) => setTimeout(resolve, 150)).then(() => cli('status'))])
  assert.equal(stopped.code, 0, stopped.out)
  assert.equal(status.code, 0, status.out)
  assert.ok(status.out.includes('restartable'), status.out)
  assert.equal((await cli('stop')).out, 'daemon stopped')
  assert.equal((await cli('stop')).out, 'daemon is not running')
})
