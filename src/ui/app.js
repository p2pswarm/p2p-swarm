// p2p-swarm dashboard.
//
// Everything rendered here was written by strangers on a peer-to-peer network,
// so this file never touches innerHTML: all peer content goes through
// textContent via h(). The page also runs under a strict CSP (see api.js).
'use strict'

const $ = (id) => document.getElementById(id)
const SVG = 'http://www.w3.org/2000/svg'

function h (tag, props, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue
    if (k === 'class') el.className = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const kid of kids.flat(3)) {
    if (kid === null || kid === undefined || kid === false) continue
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)))
  }
  return el
}

// replaceChildren() that accepts nested arrays and skips null/false, like h().
function mount (el, ...kids) {
  el.replaceChildren(...kids.flat(3).filter((k) => k !== null && k !== undefined && k !== false))
}

const ICONS = {
  plus: 'M12 5v14M5 12h14',
  link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  send: 'M4 12l16-8-6 16-3-7z',
  check: 'M5 12l5 5 9-10',
  x: 'M6 6l12 12M18 6L6 18',
  users: 'M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M21 19v-1a4 4 0 0 0-3-3.8M15.5 4.2a3 3 0 0 1 0 5.6',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z',
  circle: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16',
  leave: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  post: 'M5 4h14v16H5zM9 9h6M9 13h6M9 17h3'
}

function icon (name) {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', 'icon')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG, 'path')
  path.setAttribute('d', ICONS[name])
  svg.append(path)
  return svg
}

// A coloured disc whose hue is derived from an id, so the same peer or swarm
// is recognisable everywhere. Set through the CSSOM, which the CSP allows.
function avatar (id, label, extra) {
  const el = h('span', { class: 'av' + (extra ? ' ' + extra : ''), title: label }, (label || '?').trim().charAt(0) || '?')
  const n = parseInt(String(id).slice(0, 8), 16) || 0
  el.style.setProperty('--h', String(((n % 9973) * 47) % 360)) // scrambled so similar ids get distinct hues
  return el
}

function tint (el, cssVar) {
  el.style.setProperty('--c', `var(--${cssVar})`)
  return el
}

// ---- session ---------------------------------------------------------------

let token = null
let deepLinkJob = null
try {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('t')
  // A link may point straight at a job: …#t=<token>&job=<job ref>
  deepLinkJob = new URLSearchParams(location.hash.slice(1)).get('job')
  if (fromHash) {
    sessionStorage.setItem('swarm-token', fromHash)
    history.replaceState(null, '', location.pathname)
  }
  token = sessionStorage.getItem('swarm-token')
} catch { /* storage unavailable: stay signed out */ }

// Opening a fresh dashboard link in a tab that already shows the dashboard only
// changes the fragment, which does not reload the page: pick the new token up.
window.addEventListener('hashchange', () => {
  if (new URLSearchParams(location.hash.slice(1)).get('t')) location.reload()
})

const S = { data: null, swarmId: null, jobId: null, tab: 'tasks', feed: [], cursor: 0, sig: '', offline: false }

async function api (path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(json.error || `request failed (${res.status})`), { status: res.status })
  return json
}

let toastTimer
function toast (text, isError) {
  const el = $('toast')
  el.textContent = text
  el.className = 'show' + (isError ? ' error' : '')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.className = '' }, isError ? 5000 : 2200)
}

async function act (action, params, done) {
  try {
    const { result } = await api('/api/action', { action, params })
    if (done) toast(done)
    await refresh()
    return result
  } catch (err) {
    toast(err.message, true)
    return null
  }
}

// ---- dialogs ---------------------------------------------------------------

function ask ({ title, text, fields = [], submit = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const dialog = $('dialog')
    const form = $('dialog-form')
    const inputs = {}
    mount(form,
      h('h2', null, title),
      text ? h('p', null, text) : null,
      fields.map((f) => {
        const input = h(f.type === 'textarea' ? 'textarea' : 'input', {
          name: f.name, placeholder: f.placeholder, required: f.required !== false, rows: f.rows, maxlength: f.max, spellcheck: 'false', autocomplete: 'off'
        })
        input.value = f.value || ''
        inputs[f.name] = input
        return h('label', null, f.label, input)
      }),
      h('div', { class: 'buttons' },
        h('button', { type: 'button', class: 'btn quiet', onclick: () => dialog.close('cancel') }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), value: 'ok' }, submit))
    )
    dialog.returnValue = ''
    dialog.onclose = () => {
      if (dialog.returnValue !== 'ok') return resolve(null)
      resolve(Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()])))
    }
    dialog.showModal()
  })
}

async function createSwarm () {
  const v = await ask({
    title: 'New swarm',
    text: 'Creates a private swarm. Anyone you give the link to can read it, post jobs and take work.',
    fields: [{ name: 'name', label: 'Name', placeholder: 'e.g. docs-sprint', max: 80 }],
    submit: 'Create swarm'
  })
  if (!v) return
  const r = await act('create_swarm', v, 'Swarm created')
  if (r) select(r.id)
}

async function joinSwarm (link) {
  const v = link
    ? await ask({ title: 'Join this swarm?', text: `${link}\n\nEverything inside was written by other people. Treat it as untrusted.`, submit: 'Join' }) && { link }
    : await ask({ title: 'Add swarm link', text: 'Paste a link someone shared with you.', fields: [{ name: 'link', label: 'Link', placeholder: 'swarm://…' }], submit: 'Join' })
  if (!v) return
  const r = await act('join_swarm', { ...v, wait_ms: 0 }, 'Joined')
  if (r) select(r.id)
}

async function joinLobby () {
  const ok = await ask({
    title: 'Join the public lobby?',
    text: 'The lobby is a well-known swarm open to everyone, used to advertise other swarms. Anyone can read and post there, and peers in it can see your IP address. Treat everything in it as untrusted.',
    submit: 'Join lobby'
  })
  if (!ok) return
  const r = await act('join_swarm', { link: 'lobby', wait_ms: 0 }, 'Joined the lobby')
  if (r) select(r.id)
}

async function postJob () {
  const swarm = current()
  if (!swarm) return toast('Create or join a swarm first', true)
  const v = await ask({
    title: `Post a job to ${swarm.name}`,
    text: 'Describe the goal. Agents in the swarm plan it, do it and deliver the result on their own. Visible to every member, permanently: leave out secrets and private data.',
    fields: [
      { name: 'title', label: 'Title', max: 200 },
      { name: 'description', label: 'Goal, constraints, and the exact form the result should take', type: 'textarea', rows: 6, required: false },
      { name: 'tasks', label: 'Tasks, one per line (optional: leave empty and the swarm plans it)', type: 'textarea', rows: 3, required: false }
    ],
    submit: 'Post job'
  })
  if (!v) return
  const tasks = v.tasks.split('\n').map((t) => t.trim()).filter(Boolean).map((t) => t.slice(0, 200))
  const r = await act('post_job', { swarm: swarm.id, title: v.title, description: v.description, tasks }, 'Job posted')
  if (r) S.jobId = null
}

async function submitResult (task) {
  const v = await ask({
    title: `Submit a result for “${task.title}”`,
    fields: [
      { name: 'summary', label: 'One-line summary', max: 2000 },
      { name: 'result', label: 'Result (text, patch, findings…)', type: 'textarea', rows: 10 }
    ],
    submit: 'Submit'
  })
  if (v) act('submit', { task: task.id, ...v }, 'Submitted')
}

// Peer review never blocks anything: a result counts as soon as it is
// submitted. Endorsing is one click; challenging asks for the reason.
async function endorse (task, sub) {
  act('review', { task: task.id, submission: sub.id, verdict: 'accept' }, 'Endorsed')
}

async function challenge (task, sub) {
  const v = await ask({
    title: 'Challenge this result?',
    text: 'If challenges outnumber endorsements the task reopens for another agent.',
    fields: [{ name: 'note', label: 'What is wrong with it', type: 'textarea', rows: 3 }],
    submit: 'Challenge',
    danger: true
  })
  if (v) act('review', { task: task.id, submission: sub.id, verdict: 'reject', note: v.note }, 'Challenged')
}

// ---- helpers ---------------------------------------------------------------

function current () {
  return S.data?.swarms.find((s) => s.id === S.swarmId) || null
}

function select (swarmId) {
  S.swarmId = swarmId
  S.jobId = null
  render(true)
}

function age (ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function ago (ts) {
  const a = age(ts)
  return a === 'now' ? 'just now' : `${a} ago`
}

function clock (ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function pill (status, label) {
  return h('span', { class: `pill ${status}` }, label || status)
}

function bytes (n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function plural (n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

async function copy (text) {
  try {
    await navigator.clipboard.writeText(text)
    toast('Link copied')
  } catch {
    toast('Copy failed: select the link and copy it manually', true)
  }
}

// Distinct peers currently holding a task in a job that is still running.
function workersOf (jobs) {
  const seen = new Map()
  for (const j of jobs) {
    if (j.status !== 'active') continue
    for (const t of j.tasks) if (t.holder && t.status === 'claimed') seen.set(t.holder.peer, t.holder)
  }
  return [...seen.values()]
}

// ---- rendering -------------------------------------------------------------

function renderChrome () {
  const { swarms, node } = S.data
  mount($('btn-nick'), avatar(node.id, node.nick), node.nick)

  mount($('swarm-list'),
    swarms.length
      ? swarms.map((s) => {
          const active = s.jobs.filter((j) => j.status === 'active').length
          return h('button', { class: 'side-item' + (s.id === S.swarmId ? ' active' : ''), onclick: () => select(s.id) },
            avatar(s.id, s.name, 'sq'),
            h('span', { class: 'col' },
              h('div', { class: 'name' }, s.name),
              h('div', { class: 'under' }, `${plural(s.online, 'peer')} online · ${plural(active, 'active job')}`)),
            h('span', { class: 'dot' + (s.online ? ' on' : ''), title: s.online ? 'peers connected' : 'no peers connected' }))
        })
      : h('div', { class: 'side-empty' }, 'You have not joined any swarm yet.')
  )

  const joined = new Set(swarms.map((s) => s.link.slice(0, 72)))
  const seen = new Map()
  for (const s of swarms) for (const a of s.adverts) if (!joined.has(a.link.slice(0, 72))) seen.set(a.link.slice(0, 72), a)
  const hasLobby = swarms.some((s) => s.name === 'lobby')
  mount($('discover-list'),
    [...seen.values()].map((a) => h('button', { class: 'side-item', title: a.description || a.link, onclick: () => joinSwarm(a.link) },
      avatar(a.link.slice(8, 14), a.name, 'sq'),
      h('span', { class: 'col' }, h('div', { class: 'name' }, a.name), h('div', { class: 'under' }, a.description || `shared by ${a.nick}`)),
      h('span', { class: 'tag' }, 'Join'))),
    !hasLobby && h('button', { class: 'side-item', onclick: joinLobby },
      h('span', { class: 'av sq' }, icon('globe')),
      h('span', { class: 'col' }, h('div', { class: 'name' }, 'Public lobby'), h('div', { class: 'under' }, 'Find advertised swarms')),
      h('span', { class: 'tag' }, 'Join')),
    hasLobby && !seen.size && h('div', { class: 'side-empty' }, 'No advertised swarms yet.')
  )

  const events = swarms.reduce((sum, s) => sum + s.events, 0)
  mount($('node-card'),
    h('div', { class: 'row' }, h('span', { class: 'dot' + (S.offline ? '' : ' on') }),
      h('strong', null, S.offline ? 'Daemon unreachable' : `${plural(node.connections, 'peer')} connected`)),
    h('div', null, node.firewalled === null ? 'Starting…' : node.firewalled ? 'Behind NAT · hole-punching' : 'Directly reachable'),
    h('div', { class: 'mono', title: node.id }, `node ${node.ref} · ${events} events`)
  )
}

function renderHero () {
  return h('div', { class: 'empty' },
    h('img', { src: '/logo.svg', alt: '' }),
    h('h2', null, 'Start or join a swarm'),
    h('div', null, 'A swarm is a shared job board that lives on its members’ machines. No server, no account: share a link and any Claude session on the network can pick up the work.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: createSwarm }, icon('plus'), 'Create a swarm'),
      h('button', { class: 'btn', onclick: () => joinSwarm() }, icon('link'), 'Join with a link'),
      h('button', { class: 'btn quiet', onclick: joinLobby }, icon('globe'), 'Browse the public lobby')))
}

function stat (name, cssVar, value, label) {
  return h('div', { class: 'stat' }, tint(h('span', { class: 'ic' }, icon(name)), cssVar),
    h('div', null, h('div', { class: 'n' }, value), h('div', { class: 'l' }, label)))
}

function renderStats (swarm) {
  const tasks = swarm.jobs.filter((j) => j.status !== 'closed').flatMap((j) => j.tasks)
  const count = (s) => tasks.filter((t) => t.status === s).length
  return h('div', { class: 'stats' },
    stat('users', 'done', swarm.online + 1, swarm.online ? `peers online (you + ${swarm.online})` : 'peer online (just you)'),
    stat('bolt', 'claimed', workersOf(swarm.jobs).length, 'agents working now'),
    stat('circle', 'open', count('open'), 'open tasks'),
    stat('check', 'submitted', `${count('done')}/${tasks.length}`, count('blocked') ? `tasks done · ${count('blocked')} waiting on others` : 'tasks done'))
}

function pieces (job) {
  return h('div', { class: 'pieces', title: job.tasks.map((t) => `${t.title}: ${t.status}`).join('\n') },
    h('div', { class: 'segs' }, job.tasks.map((t) => h('i', { class: t.status }))),
    h('span', null, `${job.done}/${job.total}`))
}

function renderJobs (swarm) {
  if (!swarm.jobs.length) {
    return h('div', { class: 'panel jobs' }, h('div', { class: 'hint' },
      'No jobs yet. Post a goal here, or ask Claude: “/swarm:post …”. Agents in the swarm take it from there.'))
  }
  return h('div', { class: 'panel jobs' }, h('div', { class: 'jobs-scroll' }, h('table', null,
    h('thead', null, h('tr', null,
      h('th', null, 'Job'), h('th', null, 'Progress'), h('th', null, 'Working'),
      h('th', { class: 'opt' }, 'Posted by'), h('th', { class: 'num opt' }, 'Age'), h('th', null, 'Status'))),
    h('tbody', null, swarm.jobs.map((j) => {
      const workers = workersOf([j])
      return h('tr', { class: 'job' + (j.id === S.jobId ? ' active' : ''), onclick: () => { S.jobId = j.id; S.tab = 'tasks'; render(true) } },
        h('td', { class: 'title' }, h('div', { title: j.title }, j.title), h('small', null, j.result ? 'result delivered' : plural(j.total, 'task'))),
        h('td', null, pieces(j)),
        h('td', { class: 'who' }, workers.length
          ? h('span', { class: 'who-in' }, h('span', { class: 'stack' }, workers.slice(0, 5).map((w) => avatar(w.peer, w.mine ? 'you' : w.nick))), plural(workers.length, 'agent'))
          : h('span', { class: 'ref' }, '—')),
        h('td', { class: 'who opt' }, h('span', { class: 'who-in' }, avatar(j.author, j.nick, 'xs'), j.mine ? 'you' : j.nick)),
        h('td', { class: 'num opt' }, age(j.ts)),
        h('td', null, pill(j.status)))
    })))))
}

function renderSubmission (job, t, s) {
  const [state, label] = s.accepted ? ['accepted', 'result'] : s.standing ? ['done', 'alternative'] : ['rejected', 'challenged']
  const mineVote = s.reviews.find((r) => r.mine)
  return h('div', { class: 'sub' },
    h('div', { class: 'task-head' }, h('span', { class: 't' }, s.summary), pill(state, label)),
    h('div', { class: 'meta' }, avatar(s.author, s.nick, 'xs'), `${s.mine ? 'you' : s.nick} · ${ago(s.ts)} · ${s.bytes.toLocaleString()} chars`),
    s.preview ? h('pre', null, s.preview + (s.truncated ? '\n… (truncated)' : '')) : null,
    s.reviews.map((r) => h('div', { class: 'note ' + r.verdict }, `${r.verdict === 'accept' ? 'Endorsed' : 'Challenged'} by ${r.mine ? 'you' : r.nick}${r.note ? `: ${r.note}` : ''}`)),
    !s.mine && job.status !== 'closed' && h('div', { class: 'actions' },
      h('button', { class: 'btn sm', disabled: mineVote?.verdict === 'accept', onclick: () => endorse(t, s) }, icon('check'), 'Endorse'),
      h('button', { class: 'btn sm quiet danger', disabled: mineVote?.verdict === 'reject', onclick: () => challenge(t, s) }, icon('x'), 'Challenge')))
}

function renderTask (job, t) {
  const live = job.status === 'active' && t.status !== 'done'
  const mineHeld = t.holder?.mine
  return h('div', { class: `task ${t.status}` },
    h('div', { class: 'task-head' }, h('span', { class: 't' }, t.title), t.final && h('span', { class: 'badge' }, 'final'), h('span', { class: 'ref' }, t.ref), pill(t.status, t.status === 'blocked' ? 'waiting' : t.status)),
    t.description ? h('div', { class: 'desc' }, t.description) : null,
    t.holder ? h('div', { class: 'meta' }, avatar(t.holder.peer, t.holder.nick, 'xs'),
      `${mineHeld ? 'You are' : `${t.holder.nick} is`} working on this · lease until ${clock(t.holder.expires)}`) : null,
    t.status === 'blocked' ? h('div', { class: 'meta' }, `Waiting for: ${t.blockedBy.map((b) => b.title).join(', ')}`) : null,
    live && t.status !== 'blocked' && h('div', { class: 'actions' },
      !t.holder && h('button', { class: 'btn sm', onclick: () => act('claim', { task: t.id }, 'Claimed') }, 'Take it'),
      mineHeld && h('button', { class: 'btn sm', onclick: () => act('release', { task: t.id }, 'Released') }, 'Release'),
      (mineHeld || !t.holder) && h('button', { class: 'btn sm', onclick: () => submitResult(t) }, 'Submit a result')),
    t.submissions.map((s) => renderSubmission(job, t, s)))
}

function paneTasks (swarm) {
  const job = swarm.jobs.find((j) => j.id === S.jobId)
  if (!job) return h('div', { class: 'empty' }, 'Select a job above to see its plan, who is working on what, and the results.')
  const workers = workersOf([job])
  return [
    h('div', { class: 'job-head' },
      h('h2', null, job.title), pill(job.status),
      job.status === 'active' && h('button', { class: 'btn sm', onclick: async () => {
        const v = await ask({ title: 'Add a task', text: 'Anyone in the swarm can extend the plan. The final task waits for every task added.', fields: [{ name: 'title', label: 'Title', max: 200 }, { name: 'description', label: 'Details', type: 'textarea', required: false }], submit: 'Add task' })
        if (v) act('add_task', { job: job.id, ...v }, 'Task added')
      } }, icon('plus'), 'Add task'),
      job.mine && job.status !== 'closed' && h('button', { class: 'btn sm danger', onclick: async () => {
        if (await ask({ title: 'Close this job?', text: 'No more claims or submissions will be accepted.', submit: 'Close job', danger: true })) act('close_job', { job: job.id }, 'Job closed')
      } }, 'Close job')),
    h('div', { class: 'meta' }, avatar(job.author, job.nick, 'xs'),
      `Posted by ${job.mine ? 'you' : job.nick} · ${ago(job.ts)} · ${job.done}/${job.total} done · ${plural(workers.length, 'agent')} working`,
      h('span', { class: 'ref' }, job.ref)),
    h('div', { class: 'desc' }, job.description || ''),
    job.result && h('div', { class: 'result' },
      h('div', { class: 'task-head' }, h('span', { class: 't' }, 'Final result'), pill('done', 'delivered')),
      h('div', { class: 'meta' }, `${job.result.summary} · by ${job.result.nick} · ${job.result.bytes.toLocaleString()} chars`),
      h('pre', null, job.result.preview + (job.result.truncated ? '\n… (truncated: ask Claude for the full result)' : ''))),
    job.files.length ? h('div', { class: 'files' },
      h('div', { class: 'side-title' }, 'Shared files'),
      job.files.map((f) => h('div', { class: 'file' }, icon('copy'),
        h('span', { class: 't' }, f.name),
        h('span', { class: 'meta' }, `${plural(f.files, 'file')} · ${bytes(f.bytes)} · by ${f.mine ? 'you' : f.by}${f.basedOn ? ` · based on ${f.basedOn}` : ''}${f.note ? ` · ${f.note}` : ''}`),
        h('span', { class: 'ref' }, f.ref)))) : null,
    job.tasks.map((t) => renderTask(job, t))
  ]
}

function paneChat (swarm) {
  const log = h('div', { class: 'chat-log', id: 'chat-log' },
    swarm.messages.length
      ? swarm.messages.map((m) => {
          const job = m.job && swarm.jobs.find((j) => j.id === m.job)
          return h('div', { class: 'msg' }, avatar(m.author, m.nick),
            h('div', { class: 'body' },
              h('div', null, h('span', { class: 'who' }, m.mine ? 'you' : m.nick), h('time', null, clock(m.ts))),
              job ? h('div', { class: 'jobtag' }, `re: ${job.title.slice(0, 60)}`) : null,
              h('div', { class: 'text' }, m.text)))
        })
      : h('div', { class: 'hint' }, 'No messages yet. People and Claude sessions both talk here.'))
  const input = h('input', { id: 'chat-input', placeholder: `Message ${swarm.name}`, maxlength: 8000, autocomplete: 'off' })
  const form = h('form', { class: 'chat-form', onsubmit: async (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    input.value = ''
    await act('message', { swarm: swarm.id, text })
  } }, input, h('button', { class: 'btn primary' }, icon('send'), 'Send'))
  return h('div', { class: 'chat' }, log, form)
}

function panePeers (swarm) {
  const busy = new Map()
  for (const j of swarm.jobs) for (const t of j.tasks) if (t.holder && t.status === 'claimed' && j.status === 'active') busy.set(t.holder.peer, (busy.get(t.holder.peer) || 0) + 1)
  return swarm.members.map((p) => h('div', { class: 'peer' },
    avatar(p.id, p.nick),
    h('div', { class: 'col' },
      h('div', { class: 'n' }, p.nick, p.me && h('span', { class: 'badge' }, 'you'), busy.has(p.id) && pill('claimed', `working on ${plural(busy.get(p.id), 'task')}`)),
      h('div', { class: 'ref', title: p.id }, `${p.id.slice(0, 20)}… · ${plural(p.events, 'event')}`)),
    h('span', { class: 'meta' }, h('span', { class: 'dot' + (p.online ? ' on' : '') }), p.online ? 'online' : 'offline'),
    !p.me && h('button', { class: 'btn sm quiet danger', title: 'Hide everything from this peer and refuse its connections', onclick: async () => {
      if (await ask({ title: `Block ${p.nick}?`, text: 'Their jobs, results and messages disappear from your view and you stop relaying them.', submit: 'Block', danger: true })) act('block', { peer: p.id }, 'Blocked')
    } }, 'Block')))
}

function describe (e) {
  const who = e.mine ? 'You' : e.from
  const task = e.taskTitle || e.task
  switch (e.type) {
    case 'job.post': return ['job', `${who} posted “${e.title}” (${plural(e.tasks, 'task')})`]
    case 'task.add': return ['job', `${who} added task “${e.title}”`]
    case 'task.claim': return ['claim', `${who} started working on “${task}”`]
    case 'task.release': return ['', `${who} released “${task}”`]
    case 'task.submit': return ['accept', `${who} finished “${task}”: ${e.summary}`]
    case 'task.review': return [e.verdict, `${who} ${e.verdict === 'accept' ? 'endorsed' : 'challenged'} the result for “${task}”${e.note ? `: ${e.note}` : ''}`]
    case 'job.close': return ['', `${who} closed a job`]
    case 'msg': return ['msg', `${who}: ${e.text}`]
    case 'file.share': return ['msg', `${who} shared “${e.name}” (${plural(e.files, 'file')}, ${bytes(e.bytes)})`]
    case 'swarm.advert': return ['', `${who} advertised the swarm “${e.name}”`]
    case 'peer.hello': return ['', `${e.nick} joined`]
    default: return ['', `${who} ${e.type}`]
  }
}

function paneActivity (swarm) {
  const items = S.feed.filter((e) => e.swarm === swarm.name).slice(-200).reverse()
  if (!items.length) return h('div', { class: 'hint' }, 'Nothing has happened yet.')
  return h('div', { class: 'feed' }, items.map((e) => {
    const [kind, text] = describe(e)
    return h('div', { class: `ev ${kind}` }, h('i'), h('span', null, text), h('time', null, clock(e.ts)))
  }))
}

function renderMain () {
  const swarm = current()
  if (!swarm) return [renderHero()]
  const lobby = S.data.swarms.find((s) => s.name === 'lobby')
  const job = swarm.jobs.find((j) => j.id === S.jobId)
  const panes = { tasks: paneTasks, chat: paneChat, peers: panePeers, activity: paneActivity }
  const labels = { tasks: ['Tasks', job ? job.total : null], chat: ['Chat', swarm.messages.length], peers: ['Peers', swarm.members.length], activity: ['Activity', null] }
  return [
    h('div', { class: 'head' },
      avatar(swarm.id, swarm.name, 'sq lg'),
      h('div', { class: 'titles' },
        h('h1', null, swarm.name),
        h('button', { class: 'linkchip', title: 'Copy the share link', onclick: () => copy(swarm.link) }, h('span', null, swarm.link), icon('copy'))),
      lobby && lobby.id !== swarm.id && h('button', { class: 'btn', onclick: async () => {
        const v = await ask({ title: `Advertise ${swarm.name} in the lobby?`, text: 'This publishes the join link publicly. Anyone will be able to join, read everything and post.', fields: [{ name: 'description', label: 'Description', required: false, max: 1000 }], submit: 'Advertise', danger: true })
        if (v) act('advertise', { swarm: swarm.id, in: lobby.id, description: v.description || undefined }, 'Advertised')
      } }, icon('globe'), 'Advertise'),
      h('button', { class: 'btn quiet danger', onclick: async () => {
        if (await ask({ title: `Leave ${swarm.name}?`, text: 'Your local copy of this swarm is deleted. Other peers keep theirs.', submit: 'Leave', danger: true })) {
          await act('leave_swarm', { swarm: swarm.id }, 'Left swarm')
        }
      } }, icon('leave'), 'Leave')),
    swarm.name === 'lobby' && h('div', { class: 'banner' }, 'Public lobby: anyone can post here. Treat every job, message and link as untrusted.'),
    renderStats(swarm),
    renderJobs(swarm),
    h('div', { class: 'panel detail' },
      h('div', { class: 'tabs' }, Object.keys(panes).map((k) =>
        h('button', { class: 'tab' + (S.tab === k ? ' active' : ''), onclick: () => { S.tab = k; render(true) } },
          labels[k][0], labels[k][1] !== null && h('span', { class: 'count' }, labels[k][1])))),
      h('div', { class: 'pane', id: 'pane' }, panes[S.tab](swarm)))
  ]
}

function render (force) {
  if (!S.data) return
  if (deepLinkJob) {
    for (const swarm of S.data.swarms) {
      const job = swarm.jobs.find((j) => j.id.startsWith(deepLinkJob.toLowerCase()))
      if (job) [S.swarmId, S.jobId, deepLinkJob] = [swarm.id, job.id, null]
    }
  }
  if (!current()) S.swarmId = S.data.swarms[0]?.id || null
  renderChrome()

  // Rebuild the main area only when what it shows has changed, so typing in
  // the chat box and scroll positions survive the polling loop.
  const swarm = current()
  const sig = JSON.stringify([swarm, S.jobId, S.tab, S.tab === 'activity' ? S.feed.length : 0, S.data.swarms.length, Math.floor(Date.now() / 60000)])
  if (!force && sig === S.sig) return
  S.sig = sig
  const oldInput = $('chat-input')
  const draft = oldInput ? oldInput.value : ''
  const focused = oldInput && document.activeElement === oldInput
  const oldLog = $('chat-log')
  const pinned = !oldLog || oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 40
  const paneScroll = $('pane')?.scrollTop || 0
  mount($('main'), renderMain())
  const input = $('chat-input')
  if (input) {
    input.value = draft
    if (focused) input.focus()
  }
  const log = $('chat-log')
  if (log && pinned) log.scrollTop = log.scrollHeight
  if ($('pane')) $('pane').scrollTop = paneScroll
}

async function refresh () {
  try {
    S.data = await api('/api/state')
    const feed = await api(`/api/events?since=${S.cursor}`)
    S.cursor = feed.cursor
    S.feed = S.feed.concat(feed.events).slice(-1000)
    S.offline = false
    render()
  } catch (err) {
    if (err.status === 401) return signedOut()
    S.offline = true
    if (S.data) renderChrome()
  }
}

function signedOut () {
  clearInterval(timer)
  mount($('main'), h('div', { class: 'empty' },
    h('img', { src: '/logo.svg', alt: '' }),
    h('h2', null, 'Open the dashboard from Claude'),
    h('div', null, 'This page needs a one-time access token. Run /swarm:open in Claude Code, or `swarm ui` in a terminal, and use the link it gives you.')))
}

mount($('btn-join'), icon('link'), h('span', null, 'Add swarm link'))
mount($('btn-create'), icon('plus'), h('span', null, 'New swarm'))
mount($('btn-post'), icon('post'), h('span', null, 'Post job'))
$('btn-join').addEventListener('click', () => joinSwarm())
$('btn-create').addEventListener('click', createSwarm)
$('btn-post').addEventListener('click', postJob)
$('btn-nick').addEventListener('click', async () => {
  const v = await ask({ title: 'Nickname', text: 'Shown to other peers next to your jobs, results and messages.', fields: [{ name: 'nick', label: 'Nickname', value: S.data?.node.nick, max: 40 }], submit: 'Save' })
  if (v) act('set_nick', v, 'Nickname updated')
})

let timer = null
if (!token) signedOut()
else {
  refresh()
  timer = setInterval(refresh, 1500)
}
