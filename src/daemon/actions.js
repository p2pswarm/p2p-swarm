// The daemon's verbs and views. Both the dashboard and the MCP server go
// through this file, so a human clicking and a Claude session calling a tool
// are subject to exactly the same rules.
import { DEFAULT_LEASE_MS, MAX_LEASE_MS } from '../core/events.js'
import { shortId } from '../core/identity.js'

const PREVIEW_CHARS = 1500
const JOIN_SYNC_WAIT_MS = 12000

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

// ---- views ---------------------------------------------------------------

function nickOf (view, id, node) {
  if (id === node.id) return node.nick
  return view.peers.get(id)?.nick || `peer-${id.slice(0, 6)}`
}

function serializeTask (node, view, task, { full = false } = {}) {
  return {
    id: task.id,
    ref: taskRef(task.id),
    title: task.title,
    description: task.description,
    status: task.status,
    holder: task.holder
      ? { peer: task.holder.peer, nick: nickOf(view, task.holder.peer, node), mine: task.holder.peer === node.id, expires: task.holder.expires }
      : null,
    submissions: task.submissions.map((s) => ({
      id: s.id,
      ref: shortId(s.id),
      author: s.author,
      nick: nickOf(view, s.author, node),
      mine: s.author === node.id,
      ts: s.ts,
      summary: s.summary,
      verdict: s.verdict,
      note: s.note,
      bytes: s.content.length,
      ...(full ? { content: s.content } : { preview: s.content.slice(0, PREVIEW_CHARS), truncated: s.content.length > PREVIEW_CHARS })
    }))
  }
}

function serializeJob (node, view, job, opts) {
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
    tasks: job.taskIds.map((id) => serializeTask(node, view, view.tasks.get(id), opts))
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

// ---- actions -------------------------------------------------------------

function text (value, name, { optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return undefined
    throw new Error(`"${name}" is required`)
  }
  if (typeof value !== 'string') throw new Error(`"${name}" must be text`)
  return value
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
      if (node.onlinePeers(rec.topic).length) {
        // connected: give the initial exchange a moment to finish arriving
        if (++settled >= 4) break
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    const online = node.onlinePeers(rec.topic).length
    return {
      swarm: rec.name,
      id: rec.topic,
      link: rec.link,
      peersOnline: online,
      synced: online > 0,
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

  post_job (node, p) {
    const rec = resolveSwarm(node, p.swarm)
    const tasks = Array.isArray(p.tasks) && p.tasks.length
      ? p.tasks.map((t) => (typeof t === 'string' ? { title: t } : { title: t.title, ...(t.description ? { description: t.description } : {}) }))
      : [{ title: text(p.title, 'title') }]
    const body = { title: text(p.title, 'title'), description: p.description || '', tasks }
    if (Array.isArray(p.tags) && p.tags.length) body.tags = p.tags
    const e = node.publish(rec.topic, 'job.post', body)
    return { swarm: rec.name, job: shortId(e.id), tasks: tasks.map((t, i) => ({ ref: `${shortId(e.id)}:${i}`, title: t.title })) }
  },

  add_task (node, p) {
    const { rec, job } = resolveJob(node, p.job, p.swarm)
    if (job.author !== node.id) throw new Error('only the peer who posted a job can add tasks to it')
    const body = { job: job.id, title: text(p.title, 'title') }
    if (p.description) body.description = p.description
    const e = node.publish(rec.topic, 'task.add', body)
    return { task: shortId(e.id), job: shortId(job.id) }
  },

  claim (node, p) {
    const { rec, task } = resolveTask(node, p.task, p.swarm)
    if (task.status === 'done') throw new Error('that task is already done')
    if (task.holder && task.holder.peer !== node.id) {
      throw new Error(`that task is held by another peer until ${new Date(task.holder.expires).toISOString()}`)
    }
    const minutes = Number(p.lease_minutes)
    const leaseMs = Number.isFinite(minutes) && minutes > 0 ? Math.min(Math.round(minutes * 60000), MAX_LEASE_MS) : DEFAULT_LEASE_MS
    const e = node.publish(rec.topic, 'task.claim', { task: task.id, leaseMs: Math.max(leaseMs, 10000) })
    return { task: taskRef(task.id), title: task.title, description: task.description, leaseExpires: e.ts + e.body.leaseMs }
  },

  release (node, p) {
    const { rec, task } = resolveTask(node, p.task, p.swarm)
    node.publish(rec.topic, 'task.release', { task: task.id })
    return { task: taskRef(task.id), released: true }
  },

  submit (node, p) {
    const { rec, task } = resolveTask(node, p.task, p.swarm)
    if (task.status === 'done') throw new Error('that task is already done')
    const e = node.publish(rec.topic, 'task.submit', { task: task.id, summary: text(p.summary, 'summary'), content: text(p.result ?? p.content, 'result') })
    return { task: taskRef(task.id), submission: shortId(e.id) }
  },

  review (node, p) {
    const { rec, task, job } = p.task ? resolveTask(node, p.task, p.swarm) : resolveSubmission(node, p.submission, p.swarm)
    if (job.author !== node.id) throw new Error('only the peer who posted a job can review its submissions')
    const pending = task.submissions.filter((s) => !s.verdict)
    const wanted = p.submission ? String(p.submission).toLowerCase() : null
    const matches = wanted ? task.submissions.filter((s) => s.id.startsWith(wanted)) : pending
    if (matches.length !== 1) throw new Error(matches.length ? 'several submissions match: say which one' : 'no matching submission to review')
    if (p.verdict !== 'accept' && p.verdict !== 'reject') throw new Error('"verdict" must be "accept" or "reject"')
    const body = { task: task.id, submission: matches[0].id, verdict: p.verdict }
    if (p.note) body.note = p.note
    node.publish(rec.topic, 'task.review', body)
    return { task: taskRef(task.id), submission: shortId(matches[0].id), verdict: p.verdict }
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
