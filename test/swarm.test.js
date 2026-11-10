// The swarm running itself: allocation, planning, review and delivery with no
// approvals and nobody in charge.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { actions, workAvailable } from '../src/daemon/actions.js'
import { startDaemon } from '../src/daemon/main.js'
import { runAgent } from '../src/agent.js'
import { testnet, until, ids, tmpHome } from './helpers.js'

async function mesh (t, names) {
  const net = await testnet(t)
  const nodes = await Promise.all(names.map((n) => net.node(n)))
  const swarm = nodes[0].createSwarm('hive')
  for (const n of nodes.slice(1)) n.joinSwarm(swarm.link)
  await until(() => nodes.every((n) => [...n.peers.values()].filter((p) => p.shared.has(swarm.topic)).length === nodes.length - 1), { label: 'full mesh' })
  const settled = () => until(() => new Set(nodes.map((n) => ids(n, swarm.topic))).size === 1, { label: 'convergence' })
  return { nodes, swarm, settled }
}

test('eight agents asking at the same instant each get a different task', async (t) => {
  const { nodes, swarm, settled } = await mesh(t, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
  const posted = actions.post_job(nodes[0], { title: 'Big one', description: 'x', tasks: Array.from({ length: 8 }, (_, i) => `piece ${i}`) })
  await settled()

  const got = await Promise.all(nodes.map((n) => actions.next(n, {})))
  await settled()
  assert.ok(got.every((g) => g.action === 'work'), JSON.stringify(got.map((g) => g.action)))
  assert.equal(new Set(got.map((g) => g.task.ref)).size, 8, 'no two agents share a task')
  assert.ok(got.every((g) => !g.task.final))
  const view = nodes[3].view(swarm.topic)
  got.forEach((g, i) => {
    const task = [...view.tasks.values()].find((x) => x.title === g.task.title && !x.final)
    assert.equal(task.holder.peer, nodes[i].id, 'every node agrees who holds what')
  })

  // A ninth request finds nothing free: the agent is told the swarm is busy.
  const extra = await actions.next(nodes[0], { job: posted.job })
  assert.equal(extra.action, 'work') // it still holds its own task: resume, don't double up
  assert.equal(extra.task.ref, got[0].task.ref)
})

test('a bare goal becomes a plan, parallel work, peer review and a delivered result, with no approvals', async (t) => {
  const { nodes, swarm, settled } = await mesh(t, ['poster', 'w1', 'w2', 'w3'])
  const [poster, ...workers] = nodes
  const posted = actions.post_job(poster, { title: 'Write the handbook', description: 'Three chapters, joined into one document.' })
  await settled()

  // First agent on the scene gets the un-broken-down job and plans it.
  const first = await actions.next(workers[0], {})
  assert.equal(first.action, 'plan') // others are online: split it, don't hoard it
  assert.equal(first.task.final, true)
  assert.match(first.note, /PLAN IT, DO NOT DO IT.*3 other agents are online/)
  const ch1 = actions.add_task(workers[0], { job: posted.job, title: 'chapter 1' })
  actions.add_task(workers[0], { job: posted.job, title: 'chapter 2' })
  actions.add_task(workers[0], { job: posted.job, title: 'chapter 3', needs: [ch1.task] })
  actions.message(workers[0], { job: posted.job, text: 'Plan: three chapters, ch3 builds on ch1.' })
  actions.release(workers[0], { task: first.task.ref })
  await settled()

  // Every agent just loops on next(). Nobody approves anything.
  const log = []
  const agent = async (node, name) => {
    for (let step = 0; step < 12; step++) {
      const n = await actions.next(node, {})
      if (n.action === 'work' || n.action === 'plan') {
        const inputs = n.inputs.map((i) => i.result).join(' + ')
        actions.submit(node, { task: n.task.ref, summary: `${n.task.title} by ${name}`, result: n.task.final ? `HANDBOOK[${inputs}]` : `<${n.task.title}${inputs ? ` after ${inputs}` : ''}>` })
        log.push(`${name} did ${n.task.title}`)
      } else if (n.action === 'review') {
        actions.review(node, { submission: n.submission.ref, verdict: 'accept' })
        log.push(`${name} reviewed ${n.task.title}`)
      } else {
        if (node.view(swarm.topic).jobs.values().next().value.status === 'complete') return
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  await Promise.all(workers.map((w, i) => agent(w, `w${i + 1}`)))
  await settled()

  const job = poster.view(swarm.topic).jobs.values().next().value
  assert.equal(job.status, 'complete', log.join('; '))
  assert.match(job.result.content, /^HANDBOOK\[/)
  for (const ch of ['<chapter 1>', '<chapter 2>', '<chapter 3 after <chapter 1>>']) assert.ok(job.result.content.includes(ch), job.result.content)
  assert.equal(log.filter((l) => l.includes(' did ')).length, 4, 'each task done exactly once: ' + log.join('; '))
  assert.ok(log.some((l) => l.includes('reviewed')), 'idle agents reviewed instead of waiting')
  // the poster never acted after posting
  const posterEvents = [...poster.swarms.get(swarm.topic).events.values()].filter((e) => e.author === poster.id).map((e) => e.type)
  assert.deepEqual(posterEvents.sort(), ['job.post', 'peer.hello'])
})

test('when nothing is free an agent is given a result to check, and a challenge puts the task back in play', async (t) => {
  const { nodes, swarm, settled } = await mesh(t, ['poster', 'sloppy', 'careful'])
  const [poster, sloppy, careful] = nodes
  actions.post_job(poster, { title: 'README', description: 'A real README', tasks: ['write it'] })
  await settled()

  const w = await actions.next(sloppy, {})
  actions.submit(sloppy, { task: w.task.ref, summary: 'LL', result: 'BB' })
  await settled()

  // The final task is now open; ordinary work comes before reviews.
  const c1 = await actions.next(careful, {})
  assert.equal(c1.action, 'work')
  assert.equal(c1.task.final, true)
  assert.equal(c1.inputs[0].result, 'BB') // and it can see what it would be building on
  actions.release(careful, { task: c1.task.ref })
  await settled()
  actions.claim(poster, { task: c1.task.ref }) // someone else takes the final task
  await settled()

  const c2 = await actions.next(careful, {})
  assert.equal(c2.action, 'review')
  assert.equal(c2.submission.result, 'BB')
  const verdict = actions.review(careful, { submission: c2.submission.ref, verdict: 'reject', note: 'two letters is not a README' })
  assert.equal(verdict.taskStatus, 'open')
  await settled()

  // The task is back, with the objection attached for whoever takes it next.
  const c3 = await actions.next(careful, {})
  assert.equal(c3.action, 'work')
  assert.equal(c3.task.title, 'write it')
  assert.deepEqual(c3.previousAttempts[0].objections, ['two letters is not a README'])
  assert.equal(poster.view(swarm.topic).tasks.get([...poster.view(swarm.topic).tasks.keys()].find((k) => k.endsWith(':final'))).status, 'blocked')
})

test('an abandoned task frees itself when its short lease runs out', async (t) => {
  const { nodes, swarm, settled } = await mesh(t, ['poster', 'flaky', 'steady'])
  const [poster, flaky, steady] = nodes
  actions.post_job(poster, { title: 'j', description: '', tasks: ['only task'] })
  await settled()
  const w = await actions.next(flaky, { lease_minutes: 0.2 }) // 12 seconds
  await settled()
  assert.equal((await actions.next(steady, {})).action, 'idle')
  assert.equal(workAvailable(steady).claimedByOthers, 1)
  // flaky disappears; jump the clock past the lease
  const realNow = Date.now
  t.after(() => { Date.now = realNow })
  Date.now = () => realNow() + 13000
  for (const n of nodes) n.swarms.get(swarm.topic).view = null
  const taken = await actions.next(steady, {})
  assert.equal(taken.action, 'work')
  assert.equal(taken.task.ref, w.task.ref)
})

test('the headless agent starts a locked-down Claude worker only when there is work', async (t) => {
  const net = await createTestnet(3)
  const home = tmpHome()
  const daemon = await startDaemon({ home, port: 0, bootstrap: net.bootstrap })
  const record = path.join(home, 'claude-args.json')
  const fake = path.join(home, 'fake-claude.js')
  fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }))\nconsole.log('did 1 task')\n`, { mode: 0o755 })
  const saved = { home: process.env.P2P_SWARM_HOME, bin: process.env.SWARM_CLAUDE_BIN }
  process.env.P2P_SWARM_HOME = home
  process.env.SWARM_CLAUDE_BIN = fake
  t.after(async () => {
    process.env.P2P_SWARM_HOME = saved.home ?? ''
    if (saved.home === undefined) delete process.env.P2P_SWARM_HOME
    if (saved.bin === undefined) delete process.env.SWARM_CLAUDE_BIN
    else process.env.SWARM_CLAUDE_BIN = saved.bin
    await daemon.shutdown()
    await net.destroy()
  })
  const lines = []
  const log = (line) => lines.push(line)

  actions.create_swarm(daemon.node, { name: 'quiet' })
  assert.equal(await runAgent({ once: true, log }), true)
  assert.equal(fs.existsSync(record), false, 'no work, so Claude is never started')

  actions.post_job(daemon.node, { title: 'something to do', description: 'x' })
  assert.equal(await runAgent({ once: true, swarm: 'quiet', model: 'sonnet', log }), true)
  const { args, cwd } = JSON.parse(fs.readFileSync(record, 'utf8'))
  assert.equal(args[0], '-p')
  assert.match(args[1], /running unattended/)
  assert.match(args[1], /swarm_next/)
  assert.match(args[1], /Work only in the swarm named "quiet"/)
  assert.ok(!args[1].startsWith('---'), 'skill front matter is stripped')
  assert.ok(args.includes('--strict-mcp-config'))
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__swarm', 'swarm tools only: no files, no shell')
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet')
  assert.equal(args[args.indexOf('--disallowedTools') + 1], 'Agent,Task,Workflow', 'no sub-agents')
  assert.match(JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.swarm.args[0], /src\/mcp\/server\.js$/)
  assert.notEqual(fs.realpathSync(path.dirname(cwd)), fs.realpathSync(process.cwd()), 'runs in a throwaway directory')
  assert.ok(lines.some((l) => l.includes('did 1 task')))
})
