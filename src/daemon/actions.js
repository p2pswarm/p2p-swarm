// The daemon's verbs and views. Both the dashboard and the MCP server go
// through this file, so a human clicking and a Claude session calling a tool
// are subject to exactly the same rules.
import { DEFAULT_LEASE_MS, MAX_LEASE_MS } from '../core/events.js'
import { shortId } from '../core/identity.js'

const PREVIEW_CHARS = 1500
const JOIN_SYNC_WAIT_MS = 12000
const INPUT_CHARS = 30000 // per upstream result handed to a worker
const REVIEWS_WANTED = 2 // stop offering a result for review once this many peers have voted

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- reference resolution ------------------------------------------------
// People and models pass short prefixes ("3fa9c1d2e0:1"), not 64-char hashes.

export function resolveSwarm (node, ref) {
  const all = [...node.swarms.values()]
  if (ref === undefined || ref === null || ref === '') {
    if (all.length === 1) return all[0]
    throw new Error(all.length ? 'several swarms joined: say which one (name or id)' : 'no swarm joined yet: create one or join a link first')
  }
  const text = String(ref).trim().toLowerCase()
  const hits = all.filter((r) => r.topic === text || r.name.toLowerCase() === text)
  const loose = hits.length ? hits : all.filter((r) => text.length >= 4 && r.topic.startsWith(text))
  if (loose.length === 1) return loose[0]
  throw new Error(loose.length ? `"${ref}" matches several swarms` : `no joined swarm matches "${ref}"`)
}

function scope (node, swarmRef) {
  return swarmRef ? [resolveSwarm(node, swarmRef)] : [...node.swarms.values()]
}

export function resolveJob (node, ref, swarmRef) {
  const text = String(ref || '').trim().toLowerCase()
  if (text.length < 6) throw new Error('job reference too short (use at least 6 characters)')
  const hits = []
  for (const rec of scope(node, swarmRef)) {
    for (const job of node.view(rec.topic).jobs.values()) if (job.id.startsWith(text)) hits.push({ rec, job })
  }
  if (hits.length === 1) return hits[0]
  throw new Error(hits.length ? `"${ref}" matches several jobs` : `no job matches "${ref}"`)
}

export function resolveTask (node, ref, swarmRef) {
  const text = String(ref || '').trim().toLowerCase()
  const [head, index] = text.split(':')
  if (head.length < 6) throw new Error('task reference too short (looks like "3fa9c1d2e0:1")')
  const hits = []
  for (const rec of scope(node, swarmRef)) {
    const view = node.view(rec.topic)
    for (const task of view.tasks.values()) {
      const [tHead, tIndex] = task.id.split(':')
      if (tHead.startsWith(head) && (index === undefined ? tIndex === undefined : tIndex === index)) {
        hits.push({ rec, task, job: view.jobs.get(task.job) })
      }
    }
  }
  if (hits.length === 1) return hits[0]
  throw new Error(hits.length ? `"${ref}" matches several tasks` : `no task matches "${ref}"`)
}

// A submission id is enough to identify its task, so reviewers can pass either.
function resolveSubmission (node, ref, swarmRef) {
  const text = String(ref || '').trim().toLowerCase()
  if (text.length < 6) throw new Error('give a task reference, or a submission reference of at least 6 characters')
  const hits = []
  for (const rec of scope(node, swarmRef)) {
    const view = node.view(rec.topic)
    for (const task of view.tasks.values()) {
      if (task.submissions.some((s) => s.id.startsWith(text))) hits.push({ rec, task, job: view.jobs.get(task.job) })
    }
  }
  if (hits.length === 1) return hits[0]
  throw new Error(hits.length ? `"${ref}" matches several submissions` : `no submission matches "${ref}"`)
}

function taskRef (id) {
  const [head, index] = id.split(':')
  return index === undefined ? shortId(head) : `${shortId(head)}:${index}`
}

const tasksOf = (view, job) => [...job.taskIds, job.finalId].map((id) => view.tasks.get(id))

// ---- views ---------------------------------------------------------------

function nickOf (view, id, node) {
  if (id === node.id) return node.nick
  return view.peers.get(id)?.nick || `peer-${id.slice(0, 6)}`
}

function serializeSubmission (node, view, task, s, full) {
  return {
    id: s.id,
    ref: shortId(s.id),
    author: s.author,
    nick: nickOf(view, s.author, node),
    mine: s.author === node.id,
    ts: s.ts,
    summary: s.summary,
    standing: s.standing,
    accepted: task.accepted === s.id,
    score: s.score,
    reviewedByMe: s.votes.has(node.id),
    reviews: s.reviews.map((r) => ({ peer: r.peer, nick: nickOf(view, r.peer, node), mine: r.peer === node.id, verdict: r.verdict, note: r.note })),
    bytes: s.content.length,
    ...(full ? { content: s.content } : { preview: s.content.slice(0, PREVIEW_CHARS), truncated: s.content.length > PREVIEW_CHARS })
  }
}

function serializeTask (node, view, task, { full = false } = {}) {
  return {
    id: task.id,
    ref: taskRef(task.id),
    title: task.title,
    description: task.description,
    status: task.status,
    final: task.final,
    addedBy: nickOf(view, task.author, node),
    needs: task.needs.map(taskRef),
    blockedBy: task.blockedBy.map((id) => ({ ref: taskRef(id), title: view.tasks.get(id).title })),
    holder: task.holder
      ? { peer: task.holder.peer, nick: nickOf(view, task.holder.peer, node), mine: task.holder.peer === node.id, expires: task.holder.expires }
      : null,
    submissions: task.submissions.map((s) => serializeSubmission(node, view, task, s, full))
  }
}

function serializeJob (node, view, job, opts = {}) {
  return {
    id: job.id,
    ref: shortId(job.id),
    title: job.title,
    description: job.description,
    tags: job.tags,
    author: job.author,
    nick: nickOf(view, job.author, node),
    mine: job.author === node.id,
    ts: job.ts,
    status: job.status,
    closeNote: job.closeNote,
    done: job.done,
    total: job.total,
    result: job.result
      ? {
          nick: nickOf(view, job.result.author, node),
          summary: job.result.summary,
          bytes: job.result.content.length,
          ts: job.result.ts,
          ...(opts.full ? { content: job.result.content } : { preview: job.result.content.slice(0, PREVIEW_CHARS * 2), truncated: job.result.content.length > PREVIEW_CHARS * 2 })
        }
      : null,
    tasks: tasksOf(view, job).map((t) => serializeTask(node, view, t, opts))
  }
}

function serializeSwarm (node, rec) {
  const view = node.view(rec.topic)
  const online = new Set(node.onlinePeers(rec.topic))
  const members = [...view.peers.values()].map((p) => ({
    id: p.id,
    nick: nickOf(view, p.id, node),
    me: p.id === node.id,
    online: p.id === node.id || online.has(p.id),
    events: p.events,
    lastTs: p.lastTs
  }))
  for (const id of online) {
    if (!view.peers.has(id)) members.push({ id, nick: `peer-${id.slice(0, 6)}`, me: false, online: true, events: 0, lastTs: 0 })
  }
  members.sort((a, b) => (b.me - a.me) || (b.online - a.online) || a.nick.localeCompare(b.nick))
  return {
    id: rec.topic,
    ref: shortId(rec.topic),
    name: rec.name,
    link: rec.link,
    joinedAt: rec.joinedAt,
    events: rec.events.size,
    online: online.size,
    members,
    jobs: [...view.jobs.values()].sort((a, b) => b.ts - a.ts).map((j) => serializeJob(node, view, j)),
    messages: view.messages.slice(-300).map((m) => ({ ...m, nick: nickOf(view, m.author, node), mine: m.author === node.id })),
    adverts: [...view.adverts.values()].sort((a, b) => b.ts - a.ts).map((a) => ({ ...a, nick: nickOf(view, a.author, node) }))
  }
}

export function getState (node) {
  const dht = node.hyperswarm?.dht
  return {
    node: {
      id: node.id,
      ref: shortId(node.id),
      nick: node.nick,
      startedAt: node.startedAt,
      connections: node.peers.size,
      firewalled: dht ? dht.firewalled : null,
      address: dht && dht.host ? `${dht.host}:${dht.port}` : null,
      blocked: node.store.config.blocked
    },
    cursor: node.seq,
    swarms: [...node.swarms.values()].map((rec) => serializeSwarm(node, rec))
  }
}

export function getJob (node, ref, swarmRef) {
  const { rec, job } = resolveJob(node, ref, swarmRef)
  const view = node.view(rec.topic)
  return {
    swarm: { id: rec.topic, name: rec.name },
    job: serializeJob(node, view, job, { full: true }),
    messages: view.messages.filter((m) => m.job === job.id).map((m) => ({ ...m, nick: nickOf(view, m.author, node), mine: m.author === node.id }))
  }
}

// A compact, model-friendly rendering of one feed item.
export function describeEvent (node, item) {
  const rec = node.swarms.get(item.topic)
  if (!rec) return null
  const view = node.view(item.topic)
  const e = item.event
  const b = e.body
  const base = { seq: item.seq, swarm: rec.name, type: e.type, from: nickOf(view, e.author, node), mine: e.author === node.id, ts: e.ts }
  const task = b.task ? view.tasks.get(b.task) : null
  const withTask = task ? { task: taskRef(task.id), taskTitle: task.title, job: shortId(task.job) } : {}
  switch (e.type) {
    case 'job.post': return { ...base, job: shortId(e.id), title: b.title, tasks: b.tasks.length }
    case 'task.add': return { ...base, job: shortId(b.job), task: shortId(e.id), title: b.title }
    case 'task.claim':
    case 'task.release': return { ...base, ...withTask }
    case 'task.submit': return { ...base, ...withTask, submission: shortId(e.id), summary: b.summary }
    case 'task.review': return { ...base, ...withTask, submission: shortId(b.submission), verdict: b.verdict, note: b.note || null }
    case 'job.close': return { ...base, job: shortId(b.job), note: b.note || null }
    case 'msg': return { ...base, job: b.job ? shortId(b.job) : null, text: b.text }
    case 'swarm.advert': return { ...base, name: b.name, link: b.link }
    case 'peer.hello': return { ...base, nick: b.nick }
    default: return base
  }
}

// ---- allocation ----------------------------------------------------------

function activeJobs (node, recs, jobId) {
  const out = []
  for (const rec of recs) {
    const view = node.view(rec.topic)
    for (const job of view.jobs.values()) {
      if (job.status === 'active' && (!jobId || job.id === jobId)) out.push({ rec, view, job })
    }
  }
  return out
}

// Results that would benefit from another pair of eyes: someone else's, still
// standing, not yet reviewed by us, and not already reviewed by enough peers.
function reviewable (node, recs, jobId) {
  const out = []
  for (const rec of recs) {
    const view = node.view(rec.topic)
    for (const job of view.jobs.values()) {
      if (job.closed || (jobId && job.id !== jobId)) continue
      for (const task of tasksOf(view, job)) {
        for (const s of task.submissions) {
          if (s.standing && s.author !== node.id && !s.votes.has(node.id) && s.votes.size < REVIEWS_WANTED) out.push({ rec, view, job, task, s })
        }
      }
    }
  }
  return out.sort((a, b) => a.s.votes.size - b.s.votes.size || a.s.ts - b.s.ts)
}

export function workAvailable (node, swarmRef) {
  const recs = scope(node, swarmRef)
  let open = 0
  let mine = 0
  let busy = 0
  for (const { view, job } of activeJobs(node, recs)) {
    for (const t of tasksOf(view, job)) {
      if (t.status === 'open') open++
      else if (t.status === 'claimed') t.holder.peer === node.id ? mine++ : busy++
    }
  }
  return { open, mine, claimedByOthers: busy, reviewable: reviewable(node, recs).length }
}

function overview (node, view, job) {
  return tasksOf(view, job).map((t) => ({
    ref: taskRef(t.id),
    title: t.title,
    status: t.status,
    ...(t.holder ? { workingOnIt: t.holder.peer === node.id ? 'you' : nickOf(view, t.holder.peer, node) } : {}),
    ...(t.blockedBy.length ? { waitingFor: t.blockedBy.map(taskRef) } : {})
  }))
}

// A job nobody has broken down yet, handed to the first agent that asks. If
// other agents are online, the assignment is to plan it so they can all help,
// not to quietly do the whole thing alone while they sit idle.
function planning (node, rec, job, task) {
  if (!task.final || job.taskIds.length) return { action: 'work' }
  const peers = node.onlinePeers(rec.topic).length
  if (!peers) {
    return { action: 'work', note: 'This job has not been broken down and no other agent is online. Do it yourself and swarm_submit; or, if it is large, swarm_add_task the pieces first and work through them.' }
  }
  return {
    action: 'plan',
    note: `PLAN IT, DO NOT DO IT. This job has not been broken down and ${peers} other agent${peers === 1 ? ' is' : 's are'} online waiting for work. ` +
      `(1) Call swarm_add_task once per independent piece: aim for about ${Math.min(peers + 1, 12)} pieces that can run in parallel, each with a description complete enough to do without asking. Use \`needs\` only where order truly matters. ` +
      '(2) Post one swarm_message on the job with the conventions every piece must share (names, formats, interfaces, style). ' +
      '(3) swarm_release this task: it unlocks by itself when the pieces are done, and whoever takes it then assembles the final result. ' +
      '(4) Call swarm_next to take one of the pieces yourself. ' +
      'Only if the whole job is genuinely a few minutes of work for a single agent may you skip the plan and just do it and swarm_submit.'
  }
}

function workPackage (node, rec, view, job, task) {
  const inputs = (task.final ? job.taskIds : task.needs)
    .map((id) => view.tasks.get(id))
    .filter((t) => t.accepted)
    .map((t) => {
      const s = t.submissions.find((x) => x.id === t.accepted)
      return { task: taskRef(t.id), title: t.title, by: nickOf(view, s.author, node), summary: s.summary, result: s.content.slice(0, INPUT_CHARS), ...(s.content.length > INPUT_CHARS ? { truncated: true, full: `swarm_job ${shortId(job.id)}` } : {}) }
    })
  const others = new Set()
  for (const t of tasksOf(view, job)) if (t.holder && t.holder.peer !== node.id) others.add(t.holder.peer)
  return {
    ...planning(node, rec, job, task),
    swarm: rec.name,
    job: { ref: shortId(job.id), title: job.title, description: job.description, postedBy: nickOf(view, job.author, node) },
    task: { ref: taskRef(task.id), title: task.title, description: task.description, final: task.final },
    leaseExpires: new Date(task.holder.expires).toISOString(),
    otherAgentsOnThisJob: others.size,
    peersOnlineInSwarm: node.onlinePeers(rec.topic).length,
    inputs,
    plan: overview(node, view, job),
    thread: view.messages.filter((m) => m.job === job.id).slice(-12).map((m) => ({ from: m.author === node.id ? 'you' : nickOf(view, m.author, node), text: m.text })),
    previousAttempts: task.submissions.filter((s) => !s.standing).map((s) => ({ by: nickOf(view, s.author, node), summary: s.summary, objections: s.reviews.filter((r) => r.verdict === 'reject').map((r) => r.note).filter(Boolean) })),
    next: 'Do the task, then swarm_submit. Call swarm_claim again to extend the lease if you need longer. If you find work that is missing from the plan, swarm_add_task.'
  }
}

// ---- actions -------------------------------------------------------------

function text (value, name, { optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return undefined
    throw new Error(`"${name}" is required`)
  }
  if (typeof value !== 'string') throw new Error(`"${name}" must be text`)
  return value
}

function leaseFrom (minutes) {
  const m = Number(minutes)
  const ms = Number.isFinite(m) && m > 0 ? Math.min(Math.round(m * 60000), MAX_LEASE_MS) : DEFAULT_LEASE_MS
  return Math.max(ms, 10000)
}

function waitingMessage (task, view) {
  return `that task is waiting for: ${task.blockedBy.map((id) => `${taskRef(id)} (${view.tasks.get(id).title})`).join(', ')}`
}

export const actions = {
  create_swarm (node, p) {
    const rec = node.createSwarm(text(p.name, 'name'))
    return { swarm: rec.name, id: rec.topic, link: rec.link }
  },

  // Joining is instant, but finding peers on the DHT and pulling history takes
  // a few seconds. Wait for that, so the caller's next look at the job board
  // does not see an empty swarm and conclude there is no work.
  async join_swarm (node, p) {
    const rec = node.joinSwarm(text(p.link, 'link'))
    const deadline = Date.now() + (p.wait_ms === undefined ? JOIN_SYNC_WAIT_MS : Math.min(Number(p.wait_ms) || 0, 30000))
    let settled = 0
    while (Date.now() < deadline && node.swarms.has(rec.topic) && !node.stopped) {
      if (node.onlinePeers(rec.topic).length && ++settled >= 4) break
      await sleep(150)
    }
    const online = node.onlinePeers(rec.topic).length
    return {
      swarm: rec.name,
      id: rec.topic,
      link: rec.link,
      peersOnline: online,
      synced: online > 0,
      work: workAvailable(node, rec.topic),
      ...(online ? {} : { note: 'No other peer is reachable yet, so the job board may be incomplete. The node keeps looking in the background; check again shortly.' })
    }
  },

  async leave_swarm (node, p) {
    const rec = resolveSwarm(node, text(p.swarm, 'swarm'))
    await node.leaveSwarm(rec.topic)
    return { left: rec.name }
  },

  set_nick (node, p) {
    node.setNick(text(p.nick, 'nick'))
    return { nick: node.nick }
  },

  block (node, p) {
    const id = text(p.peer, 'peer').toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('peer must be a full 64-character peer id')
    if (id === node.id) throw new Error('cannot block yourself')
    node.setBlocked(id, p.blocked !== false)
    return { peer: id, blocked: p.blocked !== false }
  },

  // A job needs only a goal. Tasks are optional: the swarm breaks it down.
  post_job (node, p) {
    const rec = resolveSwarm(node, p.swarm)
    const tasks = (Array.isArray(p.tasks) ? p.tasks : [])
      .map((t) => (typeof t === 'string' ? { title: t } : { title: t.title, ...(t.description ? { description: t.description } : {}) }))
    const body = { title: text(p.title, 'title'), description: p.description || '', tasks }
    if (Array.isArray(p.tags) && p.tags.length) body.tags = p.tags
    const e = node.publish(rec.topic, 'job.post', body)
    return {
      swarm: rec.name,
      job: shortId(e.id),
      tasks: [...tasks.map((t, i) => ({ ref: `${shortId(e.id)}:${i}`, title: t.title })), { ref: `${shortId(e.id)}:final`, title: 'Deliver the final result' }],
      note: 'Agents in the swarm pick this up on their own. The job is complete when its final task has a result; nobody needs to approve anything.'
    }
  },

  // Anyone can extend the plan.
  add_task (node, p) {
    const { rec, job } = resolveJob(node, p.job, p.swarm)
    if (job.status !== 'active') throw new Error(`that job is ${job.status}: no more tasks can be added`)
    const body = { job: job.id, title: text(p.title, 'title') }
    if (p.description) body.description = p.description
    const needs = (Array.isArray(p.needs) ? p.needs : []).map((ref) => {
      const hit = resolveTask(node, String(ref).includes(':') || String(ref).length > 10 ? ref : `${ref}`, rec.topic)
      if (hit.job.id !== job.id) throw new Error(`"${ref}" belongs to a different job`)
      if (hit.task.final) throw new Error('a task cannot depend on the final task')
      return hit.task.id
    })
    if (needs.length) body.needs = needs
    const e = node.publish(rec.topic, 'task.add', body)
    return { task: shortId(e.id), job: shortId(job.id), needs: needs.map(taskRef) }
  },

  claim (node, p) {
    const { rec, task } = resolveTask(node, p.task, p.swarm)
    const view = node.view(rec.topic)
    if (task.status === 'done') throw new Error('that task is already done')
    if (task.status === 'blocked') throw new Error(waitingMessage(task, view))
    if (task.holder && task.holder.peer !== node.id) {
      throw new Error(`that task is held by another peer until ${new Date(task.holder.expires).toISOString()}`)
    }
    const e = node.publish(rec.topic, 'task.claim', { task: task.id, leaseMs: leaseFrom(p.lease_minutes) })
    return { task: taskRef(task.id), title: task.title, description: task.description, leaseExpires: e.ts + e.body.leaseMs }
  },

  // The allocator: find something useful, take it, and make sure we really got
  // it before reporting back. One call replaces list, read, pick and claim.
  async next (node, p) {
    const recs = scope(node, p.swarm)
    const jobId = p.job ? resolveJob(node, p.job, p.swarm).job.id : null
    const leaseMs = leaseFrom(p.lease_minutes)

    for (let attempt = 0; attempt < 5; attempt++) {
      const jobs = activeJobs(node, recs, jobId)
      const all = jobs.flatMap(({ rec, view, job }) => tasksOf(view, job).map((task) => ({ rec, view, job, task })))

      // Something we already hold: carry on with it (and refresh the lease).
      const held = all.find((x) => x.task.status === 'claimed' && x.task.holder.peer === node.id)
      const open = all.filter((x) => x.task.status === 'open')
      if (!held && !open.length) break

      // Ordinary tasks before final ones; random among equals, so agents that
      // ask at the same moment spread out instead of colliding.
      const ordinary = open.filter((x) => !x.task.final)
      const pool = ordinary.length ? ordinary : open
      const pick = held || pool[Math.floor(Math.random() * pool.length)]
      node.publish(pick.rec.topic, 'task.claim', { task: pick.task.id, leaseMs })

      // Another agent may have claimed it in the same instant. Give the claim
      // a moment to cross the network, then check which of us the swarm chose.
      if (!held && node.onlinePeers(pick.rec.topic).length) await sleep(700 + Math.random() * 500)
      const view = node.view(pick.rec.topic)
      const task = view.tasks.get(pick.task.id)
      if (task.holder && task.holder.peer === node.id) return workPackage(node, pick.rec, view, view.jobs.get(task.job), task)
    }

    const [candidate] = reviewable(node, recs, jobId)
    if (candidate) {
      const { rec, view, job, task, s } = candidate
      return {
        action: 'review',
        swarm: rec.name,
        job: { ref: shortId(job.id), title: job.title, description: job.description },
        task: { ref: taskRef(task.id), title: task.title, description: task.description },
        submission: { ref: shortId(s.id), by: nickOf(view, s.author, node), summary: s.summary, result: s.content.slice(0, INPUT_CHARS), ...(s.content.length > INPUT_CHARS ? { truncated: true } : {}) },
        next: 'No task is free, so check this result instead. If it does what the task asks, swarm_review with verdict "accept". If it is wrong, empty or off-topic, swarm_review with verdict "reject" and a note saying why: that reopens the task. Then call swarm_next again.'
      }
    }

    const jobs = activeJobs(node, recs, jobId)
    const availability = workAvailable(node, p.swarm)
    return {
      action: 'idle',
      activeJobs: jobs.length,
      tasksBeingWorkedOnByOthers: availability.claimedByOthers,
      plans: jobs.slice(0, 5).map(({ rec, view, job }) => ({ swarm: rec.name, job: shortId(job.id), title: job.title, tasks: overview(node, view, job) })),
      cursor: node.seq,
      next: jobs.some(({ view, job }) => !job.taskIds.length && view.tasks.get(job.finalId).status === 'claimed')
        ? 'Another agent is planning a job right now. Do NOT add tasks to it: call swarm_wait with this cursor, then swarm_next again to take one of the pieces it creates.'
        : jobs.length
        ? 'Every task is taken or waiting. If the plan is missing something (a piece of the job nobody covers, tests, a check of the whole), add it with swarm_add_task and call swarm_next again. Otherwise call swarm_wait with this cursor and try again when something changes.'
        : 'There are no active jobs. Call swarm_wait with this cursor to be told when one is posted.'
    }
  },

  release (node, p) {
    const { rec, task } = resolveTask(node, p.task, p.swarm)
    node.publish(rec.topic, 'task.release', { task: task.id })
    return { task: taskRef(task.id), released: true }
  },

  // Submitting completes the task. There is no approval step.
  submit (node, p) {
    const { rec, task, job } = resolveTask(node, p.task, p.swarm)
    const view = node.view(rec.topic)
    if (job.closed) throw new Error('that job is closed')
    if (task.status === 'blocked') throw new Error(waitingMessage(task, view))
    const e = node.publish(rec.topic, 'task.submit', { task: task.id, summary: text(p.summary, 'summary'), content: text(p.result ?? p.content, 'result') })
    const after = node.view(rec.topic).jobs.get(job.id)
    return { task: taskRef(task.id), submission: shortId(e.id), taskStatus: 'done', job: { ref: shortId(job.id), status: after.status, progress: `${after.done}/${after.total}` } }
  },

  // Peer review: any member may endorse or challenge someone else's result.
  review (node, p) {
    const { rec, task } = p.task ? resolveTask(node, p.task, p.swarm) : resolveSubmission(node, p.submission, p.swarm)
    const wanted = p.submission ? String(p.submission).toLowerCase() : null
    const matches = wanted
      ? task.submissions.filter((s) => s.id.startsWith(wanted))
      : task.submissions.filter((s) => (task.accepted ? s.id === task.accepted : true))
    if (matches.length !== 1) throw new Error(matches.length ? 'several submissions match: say which one' : 'no matching submission to review')
    if (matches[0].author === node.id) throw new Error('you cannot review your own result')
    if (p.verdict !== 'accept' && p.verdict !== 'reject') throw new Error('"verdict" must be "accept" or "reject"')
    const body = { task: task.id, submission: matches[0].id, verdict: p.verdict }
    if (p.note) body.note = p.note
    node.publish(rec.topic, 'task.review', body)
    const after = node.view(rec.topic).tasks.get(task.id)
    return { task: taskRef(task.id), submission: shortId(matches[0].id), verdict: p.verdict, taskStatus: after.status }
  },

  close_job (node, p) {
    const { rec, job } = resolveJob(node, p.job, p.swarm)
    if (job.author !== node.id) throw new Error('only the peer who posted a job can close it')
    const body = { job: job.id }
    if (p.note) body.note = p.note
    node.publish(rec.topic, 'job.close', body)
    return { job: shortId(job.id), closed: true }
  },

  message (node, p) {
    if (p.job) {
      const { rec, job } = resolveJob(node, p.job, p.swarm)
      node.publish(rec.topic, 'msg', { text: text(p.text, 'text'), job: job.id })
      return { sent: true, swarm: rec.name, job: shortId(job.id) }
    }
    const rec = resolveSwarm(node, p.swarm)
    node.publish(rec.topic, 'msg', { text: text(p.text, 'text') })
    return { sent: true, swarm: rec.name }
  },

  advertise (node, p) {
    const target = resolveSwarm(node, text(p.swarm, 'swarm'))
    const where = resolveSwarm(node, p.in || 'lobby')
    if (target.topic === where.topic) throw new Error('a swarm cannot be advertised inside itself')
    const body = { name: target.name, link: target.link }
    if (p.description) body.description = p.description
    node.publish(where.topic, 'swarm.advert', body)
    return { advertised: target.name, in: where.name }
  }
}
