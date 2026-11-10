// The reducer: turns an unordered bag of signed events into a job board.
//
// Every peer runs the same pure function over the same set of events, in the
// same deterministic order (lamport, then id), so every peer converges on the
// same view without any coordinator.
//
// The rules are built for a swarm that runs itself:
//   - Anyone may add tasks to a job, so agents break work down as they go.
//   - A task may depend on others (`needs`) and is blocked until they are done.
//   - Every job has a built-in final task that unlocks when all the others are
//     done. Its result is the job's result.
//   - Anyone may claim a free task; a claim is a short lease.
//   - A submitted result completes its task at once. Nobody has to approve it.
//   - Any other peer may endorse or challenge a result. A result stands while
//     it has at least as many endorsements as challenges; the job's poster,
//     if they vote, has the final word. A task whose results have all fallen
//     is open again.
//   - Only the poster can close a job.
import { compareEvents } from './events.js'

export const MAX_TASKS_PER_JOB = 200
export const FINAL_TITLE = 'Deliver the final result'
export const FINAL_DESCRIPTION =
  'Produce the single deliverable this job asks for, using the results of the other tasks. ' +
  'If the job has no other tasks yet, either do the whole job here, or split it into tasks first.'

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

  const scoreOf = (s) => {
    let score = 0
    for (const v of s.votes.values()) score += v === 'accept' ? 1 : -1
    return score
  }
  const stands = (job, s) => {
    const posterVote = s.author !== job.author ? s.votes.get(job.author) : undefined
    return posterVote ? posterVote === 'accept' : scoreOf(s) >= 0
  }
  const isDone = (t) => {
    const job = jobs.get(t.job)
    return t.submissions.some((s) => stands(job, s))
  }
  const waitingOn = (t) => {
    const job = jobs.get(t.job)
    const deps = t.final ? job.taskIds : t.needs
    return deps.filter((id) => !isDone(tasks.get(id)))
  }

  const addTask = (job, id, title, description, e, extra = {}) => {
    tasks.set(id, {
      id,
      job: job.id,
      title,
      description: description || '',
      author: e.author,
      ts: e.ts,
      needs: [],
      final: false,
      holder: null,
      submissions: [],
      ...extra
    })
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
          taskIds: [],
          finalId: `${e.id}:final`
        }
        jobs.set(job.id, job)
        b.tasks.forEach((t, i) => {
          addTask(job, `${e.id}:${i}`, t.title, t.description, e)
          job.taskIds.push(`${e.id}:${i}`)
        })
        addTask(job, job.finalId, FINAL_TITLE, FINAL_DESCRIPTION, e, { final: true })
        break
      }

      case 'task.add': {
        const job = jobs.get(b.job)
        if (!job || job.closed || job.taskIds.length >= MAX_TASKS_PER_JOB) break
        if (isDone(tasks.get(job.finalId))) break // the job is finished
        const needs = [...new Set(b.needs || [])].filter((id) => id !== job.finalId && tasks.get(id)?.job === job.id)
        addTask(job, e.id, b.title, b.description, e, { needs })
        job.taskIds.push(e.id)
        break
      }

      case 'task.claim': {
        const t = tasks.get(b.task)
        if (!t || jobs.get(t.job).closed || isDone(t) || waitingOn(t).length) break
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
        if (!t || jobs.get(t.job).closed || waitingOn(t).length) break
        t.submissions.push({ id: e.id, author: e.author, summary: b.summary, content: b.content, ts: e.ts, votes: new Map(), reviews: [] })
        if (t.holder && t.holder.peer === e.author) t.holder = null
        break
      }

      case 'task.review': {
        const t = tasks.get(b.task)
        const s = t && t.submissions.find((x) => x.id === b.submission)
        if (!s || s.author === e.author) break // nobody reviews their own work
        s.votes.set(e.author, b.verdict)
        s.reviews = s.reviews.filter((r) => r.peer !== e.author)
        s.reviews.push({ peer: e.author, verdict: b.verdict, note: b.note || null, ts: e.ts })
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

  for (const job of jobs.values()) {
    for (const id of [...job.taskIds, job.finalId]) {
      const t = tasks.get(id)
      let best = null
      for (const s of t.submissions) {
        s.score = scoreOf(s)
        s.standing = stands(job, s)
        s.posterVote = s.author !== job.author ? s.votes.get(job.author) || null : null
        if (!s.standing) continue
        const rank = (x) => [x.posterVote === 'accept' ? 1 : 0, x.score, x.ts]
        const a = rank(s)
        const c = best && rank(best)
        if (!best || a[0] > c[0] || (a[0] === c[0] && (a[1] > c[1] || (a[1] === c[1] && a[2] >= c[2])))) best = s
      }
      t.done = Boolean(best)
      t.accepted = best ? best.id : null
    }
  }
  for (const job of jobs.values()) {
    const all = [...job.taskIds, job.finalId].map((id) => tasks.get(id))
    for (const t of all) {
      t.blockedBy = t.done ? [] : (t.final ? job.taskIds : t.needs).filter((id) => !tasks.get(id).done)
      if (t.holder && (t.done || t.holder.expires <= now)) t.holder = null
      t.status = t.done ? 'done' : t.blockedBy.length ? 'blocked' : t.holder ? 'claimed' : 'open'
    }
    const final = tasks.get(job.finalId)
    job.done = all.filter((t) => t.done).length
    job.total = all.length
    job.status = job.closed ? 'closed' : final.done ? 'complete' : 'active'
    const result = final.done ? final.submissions.find((s) => s.id === final.accepted) : null
    job.result = result ? { id: result.id, author: result.author, summary: result.summary, content: result.content, ts: result.ts } : null
  }

  return { peers, jobs, tasks, messages, adverts }
}
