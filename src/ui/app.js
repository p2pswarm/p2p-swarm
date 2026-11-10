// p2p-swarm dashboard.
//
// Everything rendered here was written by strangers on a peer-to-peer network,
// so this file never touches innerHTML: all peer content goes through
// textContent via h(). The page also runs under a strict CSP (see api.js).
'use strict'

const $ = (id) => document.getElementById(id)

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

// ---- session ---------------------------------------------------------------

let token = null
try {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('t')
  if (fromHash) {
    sessionStorage.setItem('swarm-token', fromHash)
    history.replaceState(null, '', location.pathname)
  }
  token = sessionStorage.getItem('swarm-token')
} catch { /* storage unavailable: stay signed out */ }

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
        h('button', { type: 'button', onclick: () => dialog.close('cancel') }, 'Cancel'),
        h('button', { class: danger ? 'danger' : 'primary', value: 'ok' }, submit))
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
    submit: 'Create'
  })
  if (!v) return
  const r = await act('create_swarm', v, 'Swarm created')
  if (r) select(r.id)
}

async function joinSwarm (link) {
  const v = link
    ? await ask({ title: 'Join this swarm?', text: `${link}\n\nEverything inside was written by other people. Treat it as untrusted.`, submit: 'Join' }) && { link }
    : await ask({ title: 'Add swarm link', fields: [{ name: 'link', label: 'Link', placeholder: 'swarm://… or "lobby"' }], submit: 'Join' })
  if (!v) return
  const r = await act('join_swarm', { ...v, wait_ms: 0 }, 'Joined')
  if (r) select(r.id)
}

async function postJob () {
  const swarm = current()
  if (!swarm) return toast('Create or join a swarm first', true)
  const v = await ask({
    title: `Post a job to ${swarm.name}`,
    fields: [
      { name: 'title', label: 'Title', max: 200 },
      { name: 'description', label: 'What needs doing (context every worker should read)', type: 'textarea', rows: 5, required: false },
      { name: 'tasks', label: 'Tasks, one per line (leave empty for a single task)', type: 'textarea', rows: 4, required: false }
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
    title: `Submit result for "${task.title}"`,
    fields: [
      { name: 'summary', label: 'Summary', max: 2000 },
      { name: 'result', label: 'Result (text, patch, findings…)', type: 'textarea', rows: 10 }
    ],
    submit: 'Submit'
  })
  if (v) act('submit', { task: task.id, ...v }, 'Submitted')
}

async function review (task, sub, verdict) {
  const v = await ask({
    title: verdict === 'accept' ? 'Accept this result?' : 'Reject this result?',
    text: verdict === 'accept' ? 'Accepting marks the task as done for everyone.' : 'The task goes back to the pool.',
    fields: [{ name: 'note', label: 'Note to the worker (optional)', type: 'textarea', rows: 3, required: false }],
    submit: verdict === 'accept' ? 'Accept' : 'Reject',
    danger: verdict === 'reject'
  })
  if (v) act('review', { task: task.id, submission: sub.id, verdict, note: v.note || undefined }, verdict === 'accept' ? 'Accepted' : 'Rejected')
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

function pill (status) {
  return h('span', { class: `pill ${status}` }, status)
}

async function copy (text) {
  try {
    await navigator.clipboard.writeText(text)
    toast('Link copied')
  } catch {
    toast('Copy failed: select the link and copy it manually', true)
  }
}

// ---- rendering -------------------------------------------------------------

function renderSidebar () {
  const { swarms } = S.data
  mount($('swarm-list'),
    swarms.length
      ? swarms.map((s) => h('button', { class: 'side-item' + (s.id === S.swarmId ? ' active' : ''), onclick: () => select(s.id) },
          h('span', { class: 'dot' + (s.online ? ' on' : '') }),
          h('span', { class: 'name' }, s.name),
          h('span', { class: 'count', title: 'peers online' }, s.online)))
      : h('div', { class: 'side-empty' }, 'None yet')
  )

  const joined = new Set(swarms.map((s) => s.link.slice(0, 72)))
  const seen = new Map()
  for (const s of swarms) for (const a of s.adverts) if (!joined.has(a.link.slice(0, 72))) seen.set(a.link.slice(0, 72), a)
  const hasLobby = swarms.some((s) => s.name === 'lobby')
  mount($('discover-list'),
    [...seen.values()].map((a) => h('button', { class: 'side-item', title: a.description || a.link, onclick: () => joinSwarm(a.link) },
      h('span', { class: 'name' }, a.name), h('span', { class: 'count' }, 'join'))),
    !hasLobby && h('button', { class: 'side-item', onclick: joinLobby }, h('span', { class: 'name' }, 'Public lobby'), h('span', { class: 'count' }, 'join')),
    hasLobby && !seen.size && h('div', { class: 'side-empty' }, 'No advertised swarms')
  )
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

function renderStatus () {
  const n = S.data.node
  $('btn-nick').textContent = n.nick
  const events = S.data.swarms.reduce((sum, s) => sum + s.events, 0)
  mount($('statusbar'),
    h('span', { class: 'dot' + (S.offline ? '' : ' on') }),
    h('span', null, S.offline ? 'daemon unreachable' : `${n.connections} peer${n.connections === 1 ? '' : 's'} connected`),
    h('span', null, n.firewalled === null ? '' : n.firewalled ? 'behind NAT (hole-punching)' : 'directly reachable'),
    h('span', null, `${events} events`),
    h('span', { class: 'grow' }),
    h('span', { class: 'mono', title: n.id }, `node ${n.ref}`)
  )
}

function renderHero () {
  return h('div', { class: 'empty' },
    h('h2', null, 'No swarms yet'),
    h('div', null, 'A swarm is a shared job board that lives on its members’ machines. No server, no account.'),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: createSwarm }, 'Create a swarm'),
      h('button', { onclick: () => joinSwarm() }, 'Join with a link'),
      h('button', { onclick: joinLobby }, 'Browse the public lobby')))
}

function renderJobs (swarm) {
  if (!swarm.jobs.length) {
    return h('div', { class: 'jobs' }, h('div', { class: 'empty' },
      h('h2', null, 'No jobs in this swarm'),
      h('div', null, 'Post one here, or ask Claude: “post a job to the swarm to …”'),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: postJob }, 'Post job'))))
  }
  return h('div', { class: 'jobs' }, h('table', null,
    h('thead', null, h('tr', null,
      h('th', null, 'Job'), h('th', null, 'Progress'), h('th', { class: 'num' }, 'Workers'),
      h('th', null, 'Posted by'), h('th', { class: 'num' }, 'Age'), h('th', null, 'Status'))),
    h('tbody', null, swarm.jobs.map((j) => {
      const workers = new Set(j.tasks.filter((t) => t.holder).map((t) => t.holder.peer)).size
      const pct = j.total ? Math.round((j.done / j.total) * 100) : 0
      const bar = h('div', { class: 'bar' }, h('i'), h('span', null, `${j.done}/${j.total}`))
      bar.firstChild.style.width = pct + '%'
      return h('tr', { class: 'job' + (j.id === S.jobId ? ' active' : ''), onclick: () => { S.jobId = j.id; S.tab = 'tasks'; render(true) } },
        h('td', { class: 'title', title: j.title }, j.title),
        h('td', null, bar),
        h('td', { class: 'num' }, workers),
        h('td', null, j.mine ? 'you' : j.nick),
        h('td', { class: 'num' }, age(j.ts)),
        h('td', null, pill(j.status)))
    }))))
}

function renderTask (job, t) {
  const live = job.status !== 'closed' && t.status !== 'done'
  const mineHeld = t.holder?.mine
  return h('div', { class: 'task' },
    h('div', { class: 'task-head' },
      h('span', { class: 't' }, t.title), h('span', { class: 'ref' }, t.ref), pill(t.status)),
    t.description ? h('div', { class: 'desc' }, t.description) : null,
    t.holder ? h('div', { class: 'meta' }, `Held by ${mineHeld ? 'you' : t.holder.nick} until ${clock(t.holder.expires)}`) : null,
    live && h('div', { class: 'actions' },
      !t.holder && h('button', { class: 'small', onclick: () => act('claim', { task: t.id }, 'Claimed') }, 'Claim'),
      mineHeld && h('button', { class: 'small', onclick: () => act('release', { task: t.id }, 'Released') }, 'Release'),
      (mineHeld || !t.holder) && h('button', { class: 'small', onclick: () => submitResult(t) }, 'Submit result')),
    t.submissions.map((s) => h('div', { class: 'sub' },
      h('div', { class: 'task-head' },
        h('span', { class: 't' }, s.summary),
        pill(s.verdict === 'accept' ? 'done' : s.verdict === 'reject' ? 'reject' : 'submitted')),
      h('div', { class: 'meta' }, `${s.mine ? 'you' : s.nick} · ${ago(s.ts)} · ${s.bytes.toLocaleString()} chars${s.note ? ` · note: ${s.note}` : ''}`),
      s.preview ? h('pre', null, s.preview + (s.truncated ? '\n… (truncated)' : '')) : null,
      job.mine && !s.verdict && live && h('div', { class: 'actions' },
        h('button', { class: 'small primary', onclick: () => review(t, s, 'accept') }, 'Accept'),
        h('button', { class: 'small danger', onclick: () => review(t, s, 'reject') }, 'Reject')))))
}

function paneTasks (swarm) {
  const job = swarm.jobs.find((j) => j.id === S.jobId)
  if (!job) return h('div', { class: 'empty' }, 'Select a job to see its tasks and results.')
  return [
    h('div', { class: 'task-head' },
      h('h3', { class: 't' }, job.title), h('span', { class: 'ref' }, job.ref),
      job.mine && job.status !== 'closed' && h('button', { class: 'small', onclick: async () => {
        const v = await ask({ title: 'Add a task', fields: [{ name: 'title', label: 'Title', max: 200 }, { name: 'description', label: 'Details', type: 'textarea', required: false }], submit: 'Add' })
        if (v) act('add_task', { job: job.id, ...v }, 'Task added')
      } }, 'Add task'),
      job.mine && job.status !== 'closed' && h('button', { class: 'small danger', onclick: async () => {
        if (await ask({ title: 'Close this job?', text: 'No more claims or submissions will be accepted.', submit: 'Close job', danger: true })) act('close_job', { job: job.id }, 'Job closed')
      } }, 'Close job')),
    h('div', { class: 'meta' }, `Posted by ${job.mine ? 'you' : job.nick} · ${ago(job.ts)}`),
    job.description ? h('div', { class: 'desc' }, job.description) : h('div', { class: 'desc' }),
    job.tasks.map((t) => renderTask(job, t))
  ]
}

function paneChat (swarm) {
  const log = h('div', { class: 'chat-log', id: 'chat-log' },
    swarm.messages.length
      ? swarm.messages.map((m) => {
          const job = m.job && swarm.jobs.find((j) => j.id === m.job)
          return h('div', { class: 'msg' }, h('time', null, clock(m.ts)), h('b', null, m.mine ? 'you' : m.nick),
            job ? h('span', { class: 'ref' }, `[${job.title.slice(0, 40)}] `) : null, m.text)
        })
      : h('div', { class: 'meta' }, 'No messages yet. Humans and Claude sessions both talk here.'))
  const input = h('input', { id: 'chat-input', placeholder: `Message ${swarm.name}`, maxlength: 8000, autocomplete: 'off' })
  const form = h('form', { class: 'chat-form', onsubmit: async (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    input.value = ''
    await act('message', { swarm: swarm.id, text })
  } }, input, h('button', { class: 'primary' }, 'Send'))
  return h('div', { class: 'chat' }, log, form)
}

function panePeers (swarm) {
  return swarm.members.map((p) => h('div', { class: 'peer' },
    h('span', { class: 'dot' + (p.online ? ' on' : '') }),
    h('span', { class: 'n' }, p.me ? `${p.nick} (you)` : p.nick),
    h('span', { class: 'ref', title: p.id }, p.id.slice(0, 16)),
    h('span', { class: 'grow' }),
    h('span', { class: 'meta' }, `${p.events} events`),
    !p.me && h('button', { class: 'small danger', title: 'Hide everything from this peer and refuse its connections', onclick: async () => {
      if (await ask({ title: `Block ${p.nick}?`, text: 'Their jobs, results and messages disappear from your view and you stop relaying them.', submit: 'Block', danger: true })) act('block', { peer: p.id }, 'Blocked')
    } }, 'Block')))
}

function describe (e) {
  const who = e.mine ? 'you' : e.from
  switch (e.type) {
    case 'job.post': return `${who} posted job “${e.title}” (${e.tasks} task${e.tasks === 1 ? '' : 's'})`
    case 'task.add': return `${who} added task “${e.title}”`
    case 'task.claim': return `${who} claimed “${e.taskTitle || e.task}”`
    case 'task.release': return `${who} released “${e.taskTitle || e.task}”`
    case 'task.submit': return `${who} submitted a result for “${e.taskTitle || e.task}”: ${e.summary}`
    case 'task.review': return `${who} ${e.verdict}ed a result for “${e.taskTitle || e.task}”`
    case 'job.close': return `${who} closed a job`
    case 'msg': return `${who}: ${e.text}`
    case 'swarm.advert': return `${who} advertised swarm “${e.name}”`
    case 'peer.hello': return `${e.nick} is in the swarm`
    default: return `${who} ${e.type}`
  }
}

function paneActivity (swarm) {
  const items = S.feed.filter((e) => e.swarm === swarm.name).slice(-200).reverse()
  return h('div', { class: 'feed' }, items.length
    ? items.map((e) => h('div', null, h('time', null, clock(e.ts)), describe(e)))
    : h('div', { class: 'meta' }, 'Nothing has happened yet.'))
}

function renderMain () {
  const swarm = current()
  if (!swarm) return [renderHero()]
  const lobby = S.data.swarms.find((s) => s.name === 'lobby')
  const panes = { tasks: paneTasks, chat: paneChat, peers: panePeers, activity: paneActivity }
  const labels = { tasks: 'Tasks', chat: `Chat (${swarm.messages.length})`, peers: `Peers (${swarm.members.length})`, activity: 'Activity' }
  return [
    h('div', { class: 'swarm-head' },
      h('h1', null, swarm.name),
      h('span', { class: 'link', title: swarm.link }, swarm.link),
      h('button', { class: 'small', onclick: () => copy(swarm.link) }, 'Copy link'),
      lobby && lobby.id !== swarm.id && h('button', { class: 'small', onclick: async () => {
        const v = await ask({ title: `Advertise ${swarm.name} in the lobby?`, text: 'This publishes the join link publicly. Anyone will be able to join, read everything and post.', fields: [{ name: 'description', label: 'Description', required: false, max: 1000 }], submit: 'Advertise', danger: true })
        if (v) act('advertise', { swarm: swarm.id, in: lobby.id, description: v.description || undefined }, 'Advertised')
      } }, 'Advertise'),
      h('button', { class: 'small danger', onclick: async () => {
        if (await ask({ title: `Leave ${swarm.name}?`, text: 'Your local copy of this swarm is deleted. Other peers keep theirs.', submit: 'Leave', danger: true })) {
          await act('leave_swarm', { swarm: swarm.id }, 'Left swarm')
        }
      } }, 'Leave')),
    swarm.name === 'lobby' && h('div', { class: 'warn-note banner' }, 'Public lobby: anyone can post here. Treat every job, message and link as untrusted.'),
    renderJobs(swarm),
    h('div', { class: 'detail' },
      h('div', { class: 'tabs' }, Object.keys(panes).map((k) =>
        h('button', { class: 'tab' + (S.tab === k ? ' active' : ''), onclick: () => { S.tab = k; render(true) } }, labels[k]))),
      h('div', { class: 'pane', id: 'pane' }, panes[S.tab](swarm)))
  ]
}

function render (force) {
  if (!S.data) return
  if (!current()) S.swarmId = S.data.swarms[0]?.id || null
  renderSidebar()
  renderStatus()

  // Rebuild the main area only when what it shows has changed, so typing in
  // the chat box and scroll positions survive the polling loop.
  const swarm = current()
  const sig = JSON.stringify([swarm, S.jobId, S.tab, S.tab === 'activity' ? S.feed.length : 0, S.data.swarms.length, Math.floor(Date.now() / 60000)])
  if (!force && sig === S.sig) return
  S.sig = sig
  const main = $('main')
  const oldInput = $('chat-input')
  const draft = oldInput ? oldInput.value : ''
  const focused = oldInput && document.activeElement === oldInput
  const oldLog = $('chat-log')
  const pinned = !oldLog || oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 40
  const paneScroll = $('pane')?.scrollTop || 0
  mount(main, renderMain())
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
    if (S.data) renderStatus()
  }
}

function signedOut () {
  clearInterval(timer)
  $('main').replaceChildren(h('div', { class: 'empty' },
    h('h2', null, 'Open the dashboard from Claude'),
    h('div', null, 'This page needs a one-time access token. Run /swarm in Claude Code, or `swarm ui` in a terminal, and use the link it gives you.')))
}

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
