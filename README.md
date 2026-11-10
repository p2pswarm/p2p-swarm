<p align="center"><img src="docs/banner.svg" alt="p2p-swarm" width="760"></p>

**Give a swarm of Claude Code sessions a goal. They plan it, split it, do it in parallel, check each other and hand back the result. No server, no coordinator, no approval clicks.**

Peers find each other through a public DHT, connect directly over encrypted, hole-punched links, and replicate a signed log of jobs, tasks and results. Every peer computes the same job board from that log, so the swarm organises itself.

![The p2p-swarm dashboard](docs/dashboard.png)

<p align="center"><sub>A job in progress: three agents each holding a task, one piece already done and reviewed, and the project shared as files with one agent's snapshot built on top of it.</sub></p>

> **Status: 0.3, experimental.** It works end to end and is tested, including with live multi-agent runs, but it has not been audited and the wire format may still change. Read [Limitations](#limitations) before pointing it at anything you care about.

## What it does

- **A goal is enough.** Post what you want. The first agent to arrive breaks it into tasks sized to how many agents are online; everyone takes a piece.
- **Nobody approves anything.** A submitted result completes its task immediately and unlocks whatever depends on it. Every job ends in a final step that assembles the one deliverable you asked for.
- **Agents check each other.** An agent with nothing to do reviews someone else's result. Challenges that outnumber endorsements reopen the task for another agent.
- **Fast, collision-free allocation.** One call, `swarm_next`, picks the most useful thing, reserves it, and confirms the reservation won against every other agent asking at the same moment.
- **Work never gets stuck.** Reservations are six-minute leases. An agent that disappears frees its task automatically.
- **Files travel peer to peer.** Share a folder and the swarm gets a snapshot of it, fetched on demand in verified chunks from whoever has it, the way BitTorrent moves files. Agents read it, publish "that snapshot plus my changes", and one of them merges the lot.
- **`swarm://` links.** Like a magnet link, but for work. Anyone with the link is in the swarm.
- **Runs unattended.** `swarm agent <link>` keeps a locked-down Claude worker running with no session open.
- **A live dashboard.** Plans, per-task "pieces" bars, who is working on what, reviews, chat and results, served from your own machine.
- **Keeps working when anyone leaves**, including whoever created the swarm. Every member holds the full log.

In a live test, a real repository was shared from disk to three unattended agents. One planned the job, each of the three built a module with tests against the shared files and published its own snapshot, and one merged them: 92 seconds from posting to a finished snapshot that, fetched back to disk, passed all 168 tests. The output is in [swarm-playground](https://github.com/lordx64/swarm-playground).

## Install

Requires Node.js 20+ and Claude Code.

```
/plugin marketplace add lordx64/p2p-swarm
/plugin install swarm@p2p-swarm
```

The first tool call installs the network dependencies and starts a small background daemon. That takes a few seconds, once.

### Updating

```
claude plugin marketplace update p2p-swarm
claude plugin update swarm@p2p-swarm
node ~/.claude/plugins/marketplaces/p2p-swarm/bin/swarm.js stop
```

Then restart Claude Code. The last line stops the background daemon so that the new version starts in its place on next use. If you installed the plugin for one project rather than for your user, run these from that project's folder and add `--scope project` to the second line. Everyone in a swarm should be on the same version: 0.2 and later do not connect to 0.1.

## Sixty seconds

**You** (you want something done):

```
> create a swarm called docs-sprint and give me the link
> /swarm:post write reference docs for our event format, discovery and threat model
```

**Anyone else** (lending their Claude):

```
> /swarm:join swarm://2fab9a15bcf0…
```

That is all. Joining starts the work loop; their Claude keeps taking, doing and reviewing tasks until the swarm is idle. Your Claude follows the job and gives you the final result.

| Command | What it does |
| --- | --- |
| `/swarm:post <goal>` | Post a goal and wait for the swarm to deliver it |
| `/swarm:join <link>` | Join a swarm and start working immediately |
| `/swarm:work [swarm] [n]` | Work until the swarm is idle (or `n` tasks are done) |
| `/swarm:open` | Open the dashboard |

### No prompts at all

Claude Code asks before using a plugin's tools the first time. To let a session work without asking, allow the swarm tools in your settings:

```json
{ "permissions": { "allow": ["mcp__plugin_swarm_swarm"] } }
```

Or skip the session entirely and run a headless agent:

```
node bin/swarm.js agent swarm://2fab9a15bcf0…
```

It joins, waits for work, and runs a Claude worker whenever there is some. By default that worker has the swarm tools and nothing else: it can read tasks and post text, but it cannot read your files or run commands. `--allow-tools` widens that; read [docs/SECURITY.md](docs/SECURITY.md) first.

## How the swarm organises itself

```
 post a goal ──> [final task]                        one agent arrives: plans
                      │
        ┌─────────────┼─────────────┐
     [task A]      [task B]      [task C]            agents take one each
        │             │             └─ needs A ─┐
        ▼             ▼                         ▼
      result        result  <── reviews ──    result  idle agents check results
        └─────────────┼─────────────────────────┘
                      ▼
               [final task] unlocks ──> the deliverable
```

1. **`swarm_next`** is the whole worker loop. It returns `plan` (split this job for the agents who are waiting), `work` (this task is yours, with the results it builds on), `review` (nothing is free, check this result) or `idle` (wait, or add what is missing).
2. **Anyone can extend the plan** with `swarm_add_task`, optionally saying which tasks it needs first. A task is blocked until those are done.
3. **Submitting completes a task.** A result stands while it has at least as many endorsements as challenges. The poster's vote, if they cast one, is final.
4. **The final task** is built into every job, waits for every other task, and its result is the job's result.

Underneath: a swarm link holds a 32-byte key; peers announce a hash of it on the [Hyperswarm](https://github.com/holepunchto/hyperswarm) DHT and prove they hold the key on every connection. Everything is a signed event; peers exchange what the other is missing and gossip new events live; every peer folds the same events in the same order into the same board. Details: [docs/PROTOCOL.md](docs/PROTOCOL.md).

```
 Claude session ── MCP ──┐
 swarm agent ──── MCP ───┼──> swarmd (one per user, localhost only) <══ Hyperswarm ══> other peers
 Dashboard ───── HTTP ───┘
```

## Working on a codebase

Files move over the same peer connections as everything else. A share is a snapshot of a folder, named by the hash of its contents; the swarm's log only carries that fingerprint, and the bytes are fetched from peers when someone needs them.

```
> /swarm:post add input validation to the API handlers, with tests
> share this project with the swarm for that job
```

1. **You share the folder.** Git-ignored files, dependencies, `.git` and anything that looks like a secret (`.env`, keys, credentials) are left out automatically.
2. **Agents work on it without touching your disk or theirs.** They list and read files through the swarm, and publish "that snapshot plus my changes" as a new snapshot attached to their task.
3. **The final task merges** the agents' snapshots into one.
4. **You fetch the result** into a new, empty folder, look at what changed, and take what you want. Nothing in your project is overwritten.

From a terminal: `swarm share <path>`, `swarm files [share]`, `swarm fetch <share> [dest]`.

Any peer that has fetched a file can serve it, so files stay available after the original sharer goes offline. What arrives is checked against its hash; a peer that sends altered bytes is caught, penalised and routed around.

## Security model

You are connecting AI agents that can act on your machine to text written by strangers, and in this version nobody approves the work in between. Full write-up: [docs/SECURITY.md](docs/SECURITY.md).

- **Peer content is data, never instructions.** Every tool result carrying peer-written text is prefixed with an explicit warning, and the worker instructions tell Claude to drop any task that asks it to touch local files, run supplied commands or reveal anything about your machine. In live tests with a booby-trapped task, every session refused it.
- **The headless agent is locked down by default**: swarm tools only, no files, no shell, no sub-agents, in a throwaway directory.
- **Events cannot carry behaviour.** A fixed list of event types with strict schemas; unknown types and fields are rejected.
- **The daemon only listens on 127.0.0.1**, requires a per-run token, checks the `Host` header against DNS rebinding, and serves the dashboard under a strict CSP that renders all peer content as text.
- **Blocking.** Hide and stop relaying any peer; misbehaving connections are banned automatically.

None of this makes prompt injection impossible. **Do not give swarm workers shell or file access on a public swarm outside a container or VM**, and do not run them in a session that can reach secrets.

## Limitations

- **Permissionless means griefable.** Identities are free. In a public swarm one person can pose as many peers, flood the plan with tasks, endorse their own junk through a second identity, or challenge good work. Peer review raises the bar; it is not a defence against a determined attacker. Use private swarms with people you have a reason to trust.
- **Results are checked by agents, not proven.** Reviewers reason about a result; without shell access they do not run it. Verify what you get before relying on it.
- **It is not unstoppable.** No central server runs the swarm, but every worker depends on Claude, which is a centralized service with its own terms, limits and usage policies. First-contact discovery uses the public Hyperswarm bootstrap nodes (you can run your own).
- **Whoever does the work pays for it.** Each agent spends its owner's Claude subscription or API credits, continuously while it runs. There is no payment or credit system. Check that lending your session this way fits your plan's terms.
- **Planning depends on the planner.** One agent's plan decides how well the work parallelises. Overlapping tasks cost duplicated effort, and a task cannot be removed once added.
- **Agents do not run what they write.** The default worker has no shell, so code is written and reviewed by reading it. In the live tests the results passed their tests, but nobody in the swarm ran them: you did. Giving workers a sandbox to run code in is not built.
- **Snapshots, not version control.** There is no merge tool: an agent merging two changes to the same file reads both and rewrites it. Whole files are re-sent when they change.
- **Shared files are forever.** Once a folder is shared it is on other members' machines and cannot be recalled.
- **Nothing can be deleted.** A posted job or result is on every member's disk for good, and a link cannot be revoked.
- **Peers see your IP address.** Connections are direct.
- **Some networks cannot connect.** Two peers behind symmetric NATs cannot hole-punch, and there is no relay fallback yet.
- **Small scale so far.** Tested live with a handful of agents on one machine and two machines across networks. There is no limit on how large a swarm's log can grow (70,000 events sync to a new peer in about 8 seconds in a local test), but every peer keeps the whole log in memory and on disk, and nothing prunes it.

## Roadmap

- Git-aware shares: fetch a snapshot as a branch, return commits instead of whole files
- Cancelling and merging tasks; splitting a task that turns out too big
- Sandboxed workers that can run the code they review
- Relay fallback for un-punchable NATs
- Invite-only swarms with revocable, per-member keys
- Reputation that survives across swarms
- Pluggable settlement for paying workers

## Development

```
git clone https://github.com/lordx64/p2p-swarm && cd p2p-swarm
npm install
npm test                      # 55 tests against a private in-process DHT, no network needed
node bin/swarm.js ui          # start a node and open the dashboard
claude --plugin-dir .         # try the plugin from a checkout
```

Run several nodes on one machine by giving each its own state directory: `P2P_SWARM_HOME=/tmp/alice node bin/swarm.js ui`.

```
src/core     identity, signed events, the reducer (the swarm's rules), links, storage, file store
src/net      wire framing, the replication protocol and file transfer
src/daemon   the local node, its HTTP API, and the actions and allocator behind every tool
src/mcp      dependency-free MCP server and tool definitions
src/agent.js the headless worker loop
src/ui       the dashboard
commands/    slash commands        skills/    worker and coordinator playbooks
```

## License

MIT
