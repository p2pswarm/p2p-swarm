// The reducer: turns an unordered bag of signed events into a job board.
//
// Every peer runs the same pure function over the same set of events, in the
// same deterministic order (lamport, then id), so every peer converges on the
// same view without any coordinator.
//
// Authority rules (enforced here, not by the network):
//   - only a job's author can add tasks to it, review submissions, or close it
//   - anyone may claim an unheld task; a claim is a time-limited lease
//   - anyone may submit a result; the job author decides which one is accepted
import { compareEvents } from './events.js'

export function reduce (events, { now = Date.now(), blocked = new Set() } = {}) {
  const sorted = events.filter((e) => !blocked.has(e.author)).sort(compareEvents)
  const peers = new Map()
  const jobs = new Map()
  const tasks = new Map()
  const messages = []
  const adverts = new Map()

  const peer = (e) => {
    let p = peers.get(e.author)
    if (!p) {
      p = { id: e.author, nick: null, agent: null, events: 0, lastTs: 0 }
      peers.set(e.author, p)
    }
    p.events++
    if (e.ts > p.lastTs) p.lastTs = e.ts
    return p
  }

  const addTask = (job, id, title, description, e) => {
    tasks.set(id, {
      id,
      job: job.id,
      title,
      description: description || '',
      ts: e.ts,
      holder: null,
      submissions: [],
      done: false,
      accepted: null
    })
    job.taskIds.push(id)
  }

  for (const e of sorted) {
    const p = peer(e)
    const b = e.body
    switch (e.type) {
      case 'peer.hello':
        p.nick = b.nick
        p.agent = b.agent || null
        break

      case 'job.post': {
        const job = {
          id: e.id,
          author: e.author,
          title: b.title,
          description: b.description,
          tags: b.tags || [],
          ts: e.ts,
          closed: false,
          closeNote: null,
          taskIds: []
        }
        jobs.set(job.id, job)
        b.tasks.forEach((t, i) => addTask(job, `${e.id}:${i}`, t.title, t.description, e))
        break
      }

      case 'task.add': {
        const job = jobs.get(b.job)
        if (!job || job.author !== e.author || job.closed) break
        addTask(job, e.id, b.title, b.description, e)
        break
      }

      case 'task.claim': {
        const t = tasks.get(b.task)
        if (!t || t.done || jobs.get(t.job).closed) break
        const free = !t.holder || t.holder.expires <= e.ts || t.holder.peer === e.author
        if (free) t.holder = { peer: e.author, since: t.holder?.peer === e.author ? t.holder.since : e.ts, expires: e.ts + b.leaseMs }
        break
      }

      case 'task.release': {
        const t = tasks.get(b.task)
        if (t && t.holder && t.holder.peer === e.author) t.holder = null
        break
      }

      case 'task.submit': {
        const t = tasks.get(b.task)
        if (!t || t.done || jobs.get(t.job).closed) break
        t.submissions.push({
          id: e.id,
          author: e.author,
          summary: b.summary,
          content: b.content,
          ts: e.ts,
          verdict: null,
          note: null
        })
        break
      }

      case 'task.review': {
        const t = tasks.get(b.task)
        if (!t || t.done) break
        const job = jobs.get(t.job)
        if (job.author !== e.author) break
        const s = t.submissions.find((x) => x.id === b.submission)
        if (!s || s.verdict) break
        s.verdict = b.verdict
        s.note = b.note || null
        if (b.verdict === 'accept') {
          t.done = true
          t.accepted = s.id
          t.holder = null
        } else if (t.holder && t.holder.peer === s.author) {
          // A rejected worker loses the lease, so the task is immediately
          // available to everyone (including them) instead of sitting locked.
          t.holder = null
        }
        break
      }

      case 'job.close': {
        const job = jobs.get(b.job)
        if (!job || job.author !== e.author) break
        job.closed = true
        job.closeNote = b.note || null
        break
      }

      case 'msg':
        if (b.job && !jobs.has(b.job)) break
        messages.push({ id: e.id, author: e.author, job: b.job || null, text: b.text, ts: e.ts })
        break

      case 'swarm.advert':
        adverts.set(b.link.slice(0, 72), { id: e.id, author: e.author, name: b.name, description: b.description || '', link: b.link, ts: e.ts })
        break
    }
  }

  for (const t of tasks.values()) {
    const pending = t.submissions.some((s) => !s.verdict)
    if (t.holder && t.holder.expires <= now) t.holder = null
    t.status = t.done ? 'done' : pending ? 'submitted' : t.holder ? 'claimed' : 'open'
  }
  for (const job of jobs.values()) {
    const list = job.taskIds.map((id) => tasks.get(id))
    job.done = list.filter((t) => t.done).length
    job.total = list.length
    job.status = job.closed ? 'closed' : job.done === job.total ? 'complete' : 'active'
  }

  return { peers, jobs, tasks, messages, adverts }
}
