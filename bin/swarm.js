#!/usr/bin/env node
// swarm: command line front end for the local daemon.
import path from 'node:path'
import { api, action, dashboardUrl, openInBrowser, stopDaemon } from '../src/mcp/client.js'

const [command = 'help', ...args] = process.argv.slice(2)

function flag (name) {
  const out = []
  for (let i = 0; i < args.length; i++) if (args[i] === `--${name}` && args[i + 1]) out.push(args[++i])
  return out
}
function positional () {
  const out = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--once') continue
    if (args[i].startsWith('--')) i++
    else out.push(args[i])
  }
  return out
}

const HELP = `p2p-swarm: a serverless job swarm for Claude Code sessions

Usage: swarm <command>

  ui                         open the dashboard in your browser
  status                     show this node and its swarms
  create <name>              create a swarm and print its link
  join <link|lobby>          join a swarm
  leave <swarm>              leave a swarm
  jobs [swarm]               list jobs and tasks
  post <title> [--swarm s] [--desc text] [--task title]...
                             post a job
  share <path> [--swarm s] [--job j] [--name n]
                             share a file or folder with the swarm
  files [share]              list shared files, or the contents of one share
  fetch <share> [dest]       download a share into a new folder
  say <text> [--swarm s]     send a chat message
  nick <name>                set your nickname
  agent [link] [--swarm s] [--model m] [--allow-tools a,b] [--once]
                             run an unattended Claude worker: it joins the swarm
                             (if a link is given) and works whenever there is work
  stop                       stop the background daemon
  daemon                     run the daemon in the foreground
  mcp                        run the MCP server on stdio (used by the plugin)

State lives in ~/.p2p-swarm (override with P2P_SWARM_HOME).`

const commands = {
  help: async () => console.log(HELP),
  async ui () {
    const url = await dashboardUrl()
    openInBrowser(url)
    console.log(url)
  },
  async status () {
    const s = await api('/api/state')
    console.log(`${s.node.nick}  node ${s.node.ref}  ${s.node.connections} peers connected`)
    for (const w of s.swarms) {
      console.log(`\n${w.name}  (${w.online} online, ${w.members.length} members, ${w.jobs.length} jobs)\n  ${w.link}`)
    }
    if (!s.swarms.length) console.log('\nNo swarms yet. Try: swarm create my-swarm')
  },
  async create () { console.log((await action('create_swarm', { name: positional().join(' ') })).link) },
  async join () {
    const r = await action('join_swarm', { link: positional()[0] })
    console.log(`joined ${r.swarm} (${r.synced ? `${r.peersOnline} peer${r.peersOnline === 1 ? '' : 's'} online` : 'no peers reachable yet'})`)
  },
  async leave () { console.log(`left ${(await action('leave_swarm', { swarm: positional()[0] })).left}`) },
  async jobs () {
    const s = await api('/api/state')
    const want = positional()[0]?.toLowerCase()
    for (const w of s.swarms.filter((x) => !want || x.name.toLowerCase() === want)) {
      console.log(`\n${w.name}`)
      for (const j of w.jobs) {
        console.log(`  ${j.ref}  [${j.status} ${j.done}/${j.total}]  ${j.title}  (${j.mine ? 'you' : j.nick})`)
        for (const t of j.tasks) console.log(`      ${t.ref.padEnd(14)} ${t.status.padEnd(9)} ${t.title}${t.holder ? `  <- ${t.holder.nick}` : ''}`)
      }
      if (!w.jobs.length) console.log('  (no jobs)')
    }
  },
  async post () {
    const r = await action('post_job', { swarm: flag('swarm')[0], title: positional().join(' '), description: flag('desc')[0] || '', tasks: flag('task') })
    console.log(`posted ${r.job} to ${r.swarm}`)
    for (const t of r.tasks) console.log(`  ${t.ref}  ${t.title}`)
  },
  async share () {
    const target = positional()[0]
    if (!target) throw new Error('give a file or folder to share')
    const r = await action('share', { path: path.resolve(target), swarm: flag('swarm')[0], job: flag('job')[0], name: flag('name')[0] })
    console.log(`shared ${r.name} as ${r.share} to ${r.swarm}: ${r.files} file(s), ${r.bytes} bytes`)
    if (r.leftOut) console.log(`left out ${r.leftOut.count} file(s) that looked like secrets, e.g. ${r.leftOut.examples.slice(0, 3).join(', ')}`)
  },
  async files () {
    const r = await action('files', { share: positional()[0], swarm: flag('swarm')[0] })
    if (r.shares) {
      for (const x of r.shares) console.log(`${x.ref}  ${x.name}  ${x.files} file(s), ${x.bytes} bytes  by ${x.mine ? 'you' : x.by}${x.job ? `  job ${x.job}` : ''}${x.basedOn ? `  based on ${x.basedOn}` : ''}`)
      if (!r.shares.length) console.log('nothing has been shared yet')
    } else {
      console.log(`${r.name} (${r.ref}): ${r.files} file(s), ${r.bytes} bytes`)
      for (const f of r.listing) console.log(`  ${(f.change && f.change !== 'same' ? f.change[0].toUpperCase() : ' ')} ${String(f.size).padStart(9)}  ${f.path}`)
      for (const d of r.deleted || []) console.log(`  D            ${d}`)
    }
  },
  async fetch () {
    const [share, dest] = positional()
    if (!share) throw new Error('give a share reference')
    const r = await action('fetch', { share, dest: path.resolve(dest || `swarm-${share.slice(0, 10)}`), swarm: flag('swarm')[0] })
    console.log(`fetched ${r.files} file(s), ${r.bytes} bytes into ${r.path}`)
  },
  async say () { await action('message', { swarm: flag('swarm')[0], text: positional().join(' ') }) },
  async nick () { console.log((await action('set_nick', { nick: positional().join(' ') })).nick) },
  async agent () {
    const { runAgent } = await import('../src/agent.js')
    const ok = await runAgent({
      link: positional()[0],
      swarm: flag('swarm')[0],
      model: flag('model')[0],
      extraTools: (flag('allow-tools')[0] || '').split(',').map((t) => t.trim()).filter(Boolean),
      once: args.includes('--once')
    })
    process.exit(ok ? 0 : 1)
  },
  async stop () {
    console.log((await stopDaemon()) ? 'daemon stopped' : 'daemon is not running')
  },
  daemon: () => import('../src/daemon/main.js').then(async ({ runForeground }) => {
    const d = await runForeground()
    if (d) console.log(d.url)
  }),
  mcp: () => import('../src/mcp/server.js').then((m) => m.startStdio())
}

const run = commands[command]
if (!run) {
  console.error(`unknown command "${command}"\n\n${HELP}`)
  process.exit(1)
}
run().catch((err) => {
  console.error(`error: ${err.message}`)
  process.exit(1)
})
