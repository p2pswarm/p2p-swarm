// A headless swarm agent: keeps a Claude worker running against the swarm with
// no session open and nobody clicking anything.
//
// It watches the local node for available work and, whenever there is some,
// runs `claude -p` with the worker instructions until the swarm goes quiet.
// The worker is given the swarm tools and nothing else by default: it can read
// tasks and post text, but cannot touch files or run commands on this machine.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { api, action, ROOT } from './mcp/client.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function workerPrompt (swarm) {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'swarm-worker', 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\s*/, '')
  return [
    'You are running unattended as a p2p-swarm agent. There is no human to ask: never ask questions, never wait for confirmation.',
    swarm ? `Work only in the swarm named "${swarm}": pass swarm: "${swarm}" to swarm_next.` : 'Work across every swarm this node has joined.',
    'You are ONE agent. Do everything yourself with the swarm tools: never spawn sub-agents or background tasks, and make one plan, not several.',
    'Run the loop below now. When you stop, reply with one line per task you submitted or reviewed.',
    '',
    skill
  ].join('\n')
}

function runClaude ({ prompt, model, extraTools, log }) {
  const config = JSON.stringify({ mcpServers: { swarm: { command: process.execPath, args: [path.join(ROOT, 'src', 'mcp', 'server.js')] } } })
  // No sub-agents: a worker that delegates to copies of itself plans and claims
  // twice, and the copies do not share what the first one already did.
  const args = ['-p', prompt, '--mcp-config', config, '--strict-mcp-config', '--allowedTools', ['mcp__swarm', ...extraTools].join(','), '--disallowedTools', 'Agent,Task,Workflow']
  if (model) args.push('--model', model)
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-agent-'))
  return new Promise((resolve) => {
    const child = spawn(process.env.SWARM_CLAUDE_BIN || 'claude', args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('error', (err) => resolve({ ok: false, out: `could not start claude: ${err.message}` }))
    child.on('close', (code) => {
      fs.rmSync(cwd, { recursive: true, force: true })
      resolve({ ok: code === 0, out: out.trim() })
    })
    log(`worker started (pid ${child.pid})`)
  })
}

export async function runAgent ({ link, swarm, model, extraTools = [], once = false, log = (line) => console.log(`[${new Date().toLocaleTimeString()}] ${line}`) } = {}) {
  if (link) {
    const joined = await action('join_swarm', { link })
    swarm = swarm || joined.swarm
    log(`joined ${joined.swarm} (${joined.synced ? `${joined.peersOnline} peer(s) online` : 'no peers reachable yet'})`)
  }
  const query = swarm ? `?swarm=${encodeURIComponent(swarm)}` : ''
  const prompt = workerPrompt(swarm)
  let cursor = (await api('/api/state')).cursor
  let failures = 0
  log(`agent ready${swarm ? ` for ${swarm}` : ''}; waiting for work (Ctrl-C to stop)`)

  for (;;) {
    let work
    try {
      work = await api(`/api/work${query}`)
    } catch (err) {
      // The daemon restarting or the machine sleeping must not kill the agent.
      log(`node unreachable (${err.message}); retrying`)
      if (once) return false
      await sleep(3000)
      continue
    }
    if (work.open || work.mine || work.reviewable) {
      log(`work available: ${work.open} open, ${work.reviewable} to review`)
      const result = await runClaude({ prompt, model, extraTools, log })
      for (const line of result.out.split('\n').slice(-12)) if (line.trim()) log(`  ${line}`)
      failures = result.ok ? 0 : failures + 1
      if (once) return result.ok
      // Back off if Claude keeps failing (not logged in, rate limited, offline).
      if (failures) await sleep(Math.min(300000, 5000 * 2 ** failures))
      cursor = await api('/api/state').then((st) => st.cursor, () => cursor)
      continue
    }
    if (once) return true
    try {
      cursor = (await api(`/api/events?since=${cursor}&wait=50&others=1`, null, 60000)).cursor
    } catch {
      await sleep(3000)
    }
  }
}
