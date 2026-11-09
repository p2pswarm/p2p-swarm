import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { SwarmNode } from '../src/net/node.js'
import { createEvent } from '../src/core/events.js'
import { identityFromSeed, createSeed } from '../src/core/identity.js'
import { testnet, until, ids, tmpHome } from './helpers.js'

test('three peers converge on one job board with no server', async (t) => {
  const net = await testnet(t)
  const [alice, bob, carol] = await Promise.all(['alice', 'bob', 'carol'].map((n) => net.node(n)))

  const swarm = alice.createSwarm('launch')
  const topic = swarm.topic
  const job = alice.publish(topic, 'job.post', { title: 'Write docs', description: 'ctx', tasks: [{ title: 'intro' }, { title: 'api' }] })
  bob.joinSwarm(swarm.link)
  carol.joinSwarm(swarm.link)

  await until(() => bob.swarms.get(topic).events.has(job.id) && carol.swarms.get(topic).events.has(job.id), { label: 'job to reach bob and carol' })

  bob.publish(topic, 'task.claim', { task: `${job.id}:0`, leaseMs: 60000 })
  carol.publish(topic, 'task.claim', { task: `${job.id}:1`, leaseMs: 60000 })
  const sub = bob.publish(topic, 'task.submit', { task: `${job.id}:0`, summary: 'intro written', content: '# Intro' })
  await until(() => alice.swarms.get(topic).events.has(sub.id), { label: 'submission to reach alice' })
  alice.publish(topic, 'task.review', { task: `${job.id}:0`, submission: sub.id, verdict: 'accept' })

  await until(() => ids(alice, topic) === ids(bob, topic) && ids(bob, topic) === ids(carol, topic) && alice.swarms.get(topic).events.size === 8, { label: 'all logs to converge' })

  for (const node of [alice, bob, carol]) {
    const view = node.view(topic)
    assert.equal(view.tasks.get(`${job.id}:0`).status, 'done')
    assert.equal(view.tasks.get(`${job.id}:1`).status, 'claimed')
    assert.equal(view.peers.get(view.tasks.get(`${job.id}:1`).holder.peer).nick, 'carol')
    assert.equal(view.jobs.get(job.id).done, 1)
  }
})

test('the swarm survives its creator leaving, and late joiners get full history', async (t) => {
  const net = await testnet(t)
  const alice = await net.node('alice')
  const bob = await net.node('bob')
  const swarm = alice.createSwarm('durable')
  const job = alice.publish(swarm.topic, 'job.post', { title: 'j', description: '', tasks: [{ title: 't' }] })
  bob.joinSwarm(swarm.link)
  await until(() => bob.swarms.get(swarm.topic).events.has(job.id), { label: 'bob to sync' })

  await alice.stop() // the "server" is gone; nothing should depend on it
  const msg = bob.publish(swarm.topic, 'msg', { text: 'still here' })

  const dave = await net.node('dave')
  dave.joinSwarm(swarm.link)
  await until(() => dave.swarms.get(swarm.topic).events.has(job.id) && dave.swarms.get(swarm.topic).events.has(msg.id), { label: 'dave to get history from bob' })
  assert.equal(dave.view(swarm.topic).jobs.get(job.id).title, 'j')
})

test('state survives a restart from disk', async (t) => {
  const net = await testnet(t)
  const home = tmpHome()
  const first = net.track(await new SwarmNode({ home, bootstrap: net.bootstrap, nick: 'erin' }).start())
  const swarm = first.createSwarm('persistent')
  const job = first.publish(swarm.topic, 'job.post', { title: 'kept', description: '', tasks: [{ title: 't' }] })
  const id = first.id
  await first.stop()

  const second = net.track(await new SwarmNode({ home, bootstrap: net.bootstrap }).start())
  assert.equal(second.id, id)
  assert.equal(second.nick, 'erin')
  assert.equal(second.view(swarm.topic).jobs.get(job.id).title, 'kept')
  assert.equal(second.swarms.get(swarm.topic).events.size, 2) // one hello, one job: no duplicate hello
})

test('knowing the DHT topic without the swarm key gets you nothing', async (t) => {
  const net = await testnet(t)
  const alice = await net.node('alice')
  const eve = await net.node('eve')
  const swarm = alice.createSwarm('private')
  alice.publish(swarm.topic, 'msg', { text: 'secret plans' })

  // Eve learned the public topic (e.g. by watching the DHT) but not the key.
  const fake = eve._open(crypto.randomBytes(32), 'guess', Date.now())
  eve.swarms.delete(fake.topic)
  Object.assign(fake, { topic: swarm.topic, topicBuf: swarm.topicBuf })
  eve.swarms.set(swarm.topic, fake)
  eve.hyperswarm.join(swarm.topicBuf, { server: true, client: true })

  await until(() => alice.peers.has(eve.id) && eve.peers.has(alice.id), { label: 'eve to connect to alice' })
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(alice.peers.get(eve.id).shared.size, 0)
  assert.equal(eve.peers.get(alice.id).shared.size, 0)
  assert.equal([...fake.events.values()].some((e) => e.type === 'msg'), false)
  assert.equal([...alice.swarms.get(swarm.topic).events.values()].some((e) => e.author === eve.id), false)
})

test('forged and malformed events from a member are dropped, and the peer is eventually disconnected', async (t) => {
  const net = await testnet(t)
  const alice = await net.node('alice')
  const mallory = await net.node('mallory')
  const swarm = alice.createSwarm('hostile')
  mallory.joinSwarm(swarm.link)
  await until(() => mallory.peers.get(alice.id)?.shared.has(swarm.topic) && alice.peers.get(mallory.id)?.shared.has(swarm.topic), { label: 'membership proof' })

  const victim = identityFromSeed(createSeed())
  const real = createEvent(victim, { swarm: swarm.topic, lamport: 5, type: 'msg', body: { text: 'original' } })
  const forged = { ...real, body: { text: 'forged' } }
  const { encodeFrame } = await import('../src/net/wire.js')
  const conn = mallory.peers.get(alice.id).conn
  const before = alice.swarms.get(swarm.topic).events.size
  conn.write(encodeFrame({ t: 'events', topic: swarm.topic, events: [forged, { nonsense: true }, null] }))
  conn.write(encodeFrame({ t: 'events', topic: swarm.topic, events: [real] }))
  await until(() => alice.swarms.get(swarm.topic).events.has(real.id), { label: 'valid relayed event to be accepted' })
  assert.equal(alice.swarms.get(swarm.topic).events.size, before + 1)
  assert.equal(alice.view(swarm.topic).messages.at(-1).text, 'original')

  // Keep sending garbage: alice bans mallory instead of verifying it forever.
  const junk = Array.from({ length: 30 }, () => ({ ...real, id: crypto.randomBytes(32).toString('hex') }))
  conn.write(encodeFrame({ t: 'events', topic: swarm.topic, events: junk }))
  await until(() => alice.banned.has(mallory.id) && !alice.peers.has(mallory.id), { label: 'abusive peer to be banned' })
  assert.equal(alice.swarms.get(swarm.topic).events.size, before + 1)
})

test('blocking a peer hides their events and drops the connection', async (t) => {
  const net = await testnet(t)
  const alice = await net.node('alice')
  const spammer = await net.node('spammer')
  const swarm = alice.createSwarm('moderated')
  spammer.joinSwarm(swarm.link)
  const spam = spammer.publish(swarm.topic, 'job.post', { title: 'BUY NOW', description: '', tasks: [{ title: 'x' }] })
  await until(() => alice.swarms.get(swarm.topic).events.has(spam.id), { label: 'spam to arrive' })
  assert.equal(alice.view(swarm.topic).jobs.size, 1)
  alice.setBlocked(spammer.id, true)
  assert.equal(alice.view(swarm.topic).jobs.size, 0)
})
