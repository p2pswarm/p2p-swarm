// SwarmNode: one peer in the network.
//
// Discovery and transport come from Hyperswarm (a Kademlia DHT with UDP
// hole-punching and Noise-encrypted streams). On top of that this file runs a
// small replication protocol:
//
//   hello    -> prove which swarms we have in common, without naming them
//   summary  -> "I have N events with digest D" (cheap in-sync check)
//   have     -> the full list of event ids I hold
//   events   -> signed events (initial sync and live gossip)
//
// Peers are never trusted. Every event is validated and signature-checked on
// arrival, whoever relayed it.
import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import Hyperswarm from 'hyperswarm'
import DHT from 'hyperdht'
import { Store } from '../core/store.js'
import { createEvent, checkEvent, compareEvents, MAX_LAMPORT, PROTOCOL_VERSION } from '../core/events.js'
import { createSwarmKey, topicFromKey, encodeLink, parseLink, lobbyKey, LOBBY_NAME } from '../core/link.js'
import { reduce } from '../core/state.js'
import { encodeFrame, FrameDecoder } from './wire.js'

// A swarm's log has no size limit. The id list used for sync is sent in parts
// so that it never has to fit in one frame.
const HAVE_PART_IDS = 20000
const MAX_HAVE_PARTS = 100000
const MAX_STRIKES = 20
const BAN_MS = 10 * 60 * 1000
const BATCH_BYTES = 512 * 1024
const VIEW_TTL_MS = 2000
// Two peers that join within seconds of each other can both query the DHT
// before the other's announcement has landed. While a swarm is lonely we look
// again, backing off from 4s to 2 minutes.
const REDISCOVER_MIN_MS = 4000
const REDISCOVER_MAX_MS = 120000

function hmac (key, ...parts) {
  const h = crypto.createHmac('sha256', key)
  for (const p of parts) h.update(p)
  return h.digest('hex')
}

function safeEqualHex (a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

export class SwarmNode extends EventEmitter {
  constructor ({ home, bootstrap, nick } = {}) {
    super()
    this.store = new Store(home)
    this.identity = this.store.loadIdentity()
    this.bootstrap = bootstrap
    if (nick) this.store.config.nick = nick
    if (!this.store.config.nick) this.store.config.nick = `peer-${this.identity.id.slice(0, 6)}`
    this.swarms = new Map() // topic hex -> record
    this.peers = new Map() // peer id -> session
    this.feed = [] // arrival-ordered [{ seq, topic, event }]
    this.seq = 0
    this.waiters = new Set()
    this.banned = new Map() // peer id -> time the ban lifts (in memory only)
    this.startedAt = Date.now()
    this.stopped = false
    this.hyperswarm = null
  }

  get id () { return this.identity.id }
  get nick () { return this.store.config.nick }
  get blocked () { return new Set(this.store.config.blocked) }

  async start () {
    const keyPair = DHT.keyPair(this.identity.seed)
    if (!keyPair.publicKey.equals(this.identity.publicKey)) throw new Error('identity mismatch between transport and signing keys')
    this.hyperswarm = new Hyperswarm({ keyPair, bootstrap: this.bootstrap })
    this.hyperswarm.on('connection', (conn) => this._onConnection(conn))
    for (const saved of this.store.config.swarms) {
      this._open(Buffer.from(saved.key, 'hex'), saved.name, saved.joinedAt)
    }
    this.store.saveConfig()
    this.rediscoverTimer = setInterval(() => this._rediscover(), 2000)
    this.rediscoverTimer.unref()
    return this
  }

  _rediscover () {
    const now = Date.now()
    for (const rec of this.swarms.values()) {
      if (this.onlinePeers(rec.topic).length) {
        rec.backoff = REDISCOVER_MIN_MS
        rec.nextLookup = now + REDISCOVER_MAX_MS
      } else if (now >= rec.nextLookup) {
        rec.nextLookup = now + rec.backoff
        rec.backoff = Math.min(rec.backoff * 2, REDISCOVER_MAX_MS)
        rec.discovery.refresh({ client: true, server: true }).catch(() => {})
      }
    }
  }

  async stop () {
    this.stopped = true
    clearInterval(this.rediscoverTimer)
    for (const w of [...this.waiters]) w.finish()
    if (this.hyperswarm) await this.hyperswarm.destroy()
    this.hyperswarm = null
  }

  // Resolves once every joined topic has been announced to the DHT.
  async flush () {
    await Promise.all([...this.swarms.values()].map((s) => s.discovery.flushed()))
    await this.hyperswarm.flush()
  }

  // ---- swarm membership -------------------------------------------------

  createSwarm (name) {
    const clean = String(name || 'untitled swarm').trim().slice(0, 80) || 'untitled swarm'
    return this._join(createSwarmKey(), clean)
  }

  joinSwarm (link) {
    const { key, name } = parseLink(link)
    return this._join(key, name)
  }

  _join (key, name) {
    const topic = topicFromKey(key).toString('hex')
    const existing = this.swarms.get(topic)
    if (existing) return existing
    const isLobby = key.equals(lobbyKey())
    const rec = this._open(key, isLobby ? LOBBY_NAME : (name || `swarm-${topic.slice(0, 6)}`), Date.now())
    this.store.config.swarms.push({ key: key.toString('hex'), name: rec.name, joinedAt: rec.joinedAt })
    this.store.saveConfig()
    for (const peer of this.peers.values()) this._sendHello(peer)
    for (const peer of this.peers.values()) this._recomputeShared(peer)
    return rec
  }

  _open (key, name, joinedAt) {
    const topicBuf = topicFromKey(key)
    const topic = topicBuf.toString('hex')
    const rec = {
      key,
      topic,
      topicBuf,
      name,
      joinedAt,
      link: encodeLink(key, name),
      events: new Map(),
      digest: Buffer.alloc(32),
      lamport: 0,
      view: null,
      viewAt: 0,
      discovery: null,
      backoff: REDISCOVER_MIN_MS,
      nextLookup: Date.now() + REDISCOVER_MIN_MS
    }
    for (const e of this.store.loadEvents(topic)) {
      if (rec.events.has(e.id) || checkEvent(e, { swarm: topic, now: Infinity })) continue
      this._index(rec, e)
      this.feed.push({ seq: ++this.seq, topic, event: e })
    }
    this.swarms.set(topic, rec)
    rec.discovery = this.hyperswarm.join(topicBuf, { server: true, client: true })
    this._announceSelf(rec)
    return rec
  }

  async leaveSwarm (topic, { forget = true } = {}) {
    const rec = this.swarms.get(topic)
    if (!rec) throw new Error('not a member of that swarm')
    this.swarms.delete(topic)
    this.store.config.swarms = this.store.config.swarms.filter((s) => s.key !== rec.key.toString('hex'))
    this.store.saveConfig()
    if (forget) this.store.removeLog(topic)
    for (const peer of this.peers.values()) {
      peer.shared.delete(topic)
      this._sendHello(peer)
    }
    await this.hyperswarm.leave(rec.topicBuf).catch(() => {})
  }

  setNick (nick) {
    const clean = String(nick || '').trim().slice(0, 40)
    if (!clean) throw new Error('nickname cannot be empty')
    this.store.config.nick = clean
    this.store.saveConfig()
    for (const rec of this.swarms.values()) this._announceSelf(rec)
  }

  setBlocked (peerId, blocked) {
    const list = new Set(this.store.config.blocked)
    if (blocked) list.add(peerId)
    else list.delete(peerId)
    this.store.config.blocked = [...list]
    this.store.saveConfig()
    for (const rec of this.swarms.values()) rec.view = null
    if (blocked) this.peers.get(peerId)?.conn.destroy()
  }

  _announceSelf (rec) {
    let latest = null
    for (const e of rec.events.values()) {
      if (e.type === 'peer.hello' && e.author === this.id && (!latest || compareEvents(latest, e) < 0)) latest = e
    }
    if (latest?.body.nick === this.nick) return
    this.publish(rec.topic, 'peer.hello', { nick: this.nick, agent: 'claude-code' })
  }

  // ---- events -----------------------------------------------------------

  publish (topic, type, body) {
    const rec = this.swarms.get(topic)
    if (!rec) throw new Error('not a member of that swarm')
    const event = createEvent(this.identity, {
      swarm: topic,
      lamport: Math.min(rec.lamport + 1, MAX_LAMPORT),
      type,
      body
    })
    this._accept(rec, event, null)
    return event
  }

  _index (rec, e) {
    rec.events.set(e.id, e)
    const idBuf = Buffer.from(e.id, 'hex')
    for (let i = 0; i < 32; i++) rec.digest[i] ^= idBuf[i]
    if (e.lamport > rec.lamport) rec.lamport = e.lamport
    rec.view = null
  }

  _accept (rec, e, fromPeer) {
    if (rec.events.has(e.id)) return false
    this._index(rec, e)
    this.store.appendEvent(rec.topic, e)
    const item = { seq: ++this.seq, topic: rec.topic, event: e }
    this.feed.push(item)
    for (const w of this.waiters) w.finish()
    this.emit('event', item)
    const frame = encodeFrame({ t: 'events', topic: rec.topic, events: [e] })
    for (const peer of this.peers.values()) {
      if (peer !== fromPeer && peer.shared.has(rec.topic)) peer.conn.write(frame)
    }
    return true
  }

  // Returns null when accepted or already known, otherwise the rejection reason.
  _receive (rec, e) {
    if (e && typeof e.id === 'string' && rec.events.has(e.id)) return null
    const problem = checkEvent(e, { swarm: rec.topic })
    if (problem) return problem
    if (this.store.config.blocked.includes(e.author)) return null
    return undefined
  }

  view (topic) {
    const rec = this.swarms.get(topic)
    if (!rec) throw new Error('not a member of that swarm')
    const now = Date.now()
    if (!rec.view || now - rec.viewAt > VIEW_TTL_MS) {
      rec.view = reduce([...rec.events.values()], { now, blocked: this.blocked })
      rec.viewAt = now
    }
    return rec.view
  }

  eventsSince (since = 0, topic = null) {
    // seq is dense and 1-based, so the feed can be sliced directly.
    const out = []
    for (let i = Math.max(0, since); i < this.feed.length; i++) {
      const item = this.feed[i]
      if (!topic || item.topic === topic) out.push(item)
    }
    return out
  }

  async waitForEvents (since, timeoutMs, topic = null) {
    const ready = () => this.eventsSince(since, topic)
    let found = ready()
    if (found.length || timeoutMs <= 0) return found
    await new Promise((resolve) => {
      const waiter = {
        finish: () => {
          if (!ready().length && Date.now() < deadline && !this.stopped) return
          clearTimeout(timer)
          this.waiters.delete(waiter)
          resolve()
        }
      }
      const deadline = Date.now() + timeoutMs
      const timer = setTimeout(() => { this.waiters.delete(waiter); resolve() }, timeoutMs)
      this.waiters.add(waiter)
    })
    found = ready()
    return found
  }

  onlinePeers (topic) {
    const out = []
    for (const peer of this.peers.values()) if (peer.shared.has(topic)) out.push(peer.id)
    return out
  }

  // ---- wire protocol ----------------------------------------------------

  _onConnection (conn) {
    const id = conn.remotePublicKey.toString('hex')
    conn.on('error', () => {})
    if (this.store.config.blocked.includes(id) || this.banned.get(id) > Date.now()) return conn.destroy()
    const peer = { id, conn, shared: new Set(), entries: [], strikes: 0, since: Date.now(), haves: new Map() }
    const previous = this.peers.get(id)
    this.peers.set(id, peer)
    if (previous) previous.conn.destroy()

    const decoder = new FrameDecoder((message) => this._onMessage(peer, message))
    conn.on('data', (chunk) => {
      try {
        decoder.push(chunk)
      } catch {
        conn.destroy()
      }
    })
    conn.on('close', () => {
      if (this.peers.get(id) === peer) this.peers.delete(id)
      this.emit('peers')
    })
    this._sendHello(peer)
    this.emit('peers')
  }

  _tag (rec, conn) {
    return hmac(rec.topicBuf, 'tag', conn.handshakeHash)
  }

  _proof (rec, conn, publicKey) {
    return hmac(rec.key, 'proof', conn.handshakeHash, publicKey)
  }

  _sendHello (peer) {
    const swarms = []
    for (const rec of this.swarms.values()) {
      swarms.push({ tag: this._tag(rec, peer.conn), proof: this._proof(rec, peer.conn, peer.conn.publicKey) })
    }
    peer.conn.write(encodeFrame({ t: 'hello', v: PROTOCOL_VERSION, swarms }))
  }

  _recomputeShared (peer) {
    const byTag = new Map(peer.entries.map((x) => [x.tag, x.proof]))
    for (const rec of this.swarms.values()) {
      const proof = byTag.get(this._tag(rec, peer.conn))
      const ok = proof !== undefined && safeEqualHex(proof, this._proof(rec, peer.conn, peer.conn.remotePublicKey))
      if (ok && !peer.shared.has(rec.topic)) {
        peer.shared.add(rec.topic)
        this._sendSummary(peer, rec)
        this.emit('peers')
      } else if (!ok && peer.shared.delete(rec.topic)) {
        this.emit('peers')
      }
    }
  }

  _sendSummary (peer, rec) {
    peer.conn.write(encodeFrame({ t: 'summary', topic: rec.topic, count: rec.events.size, digest: rec.digest.toString('hex') }))
  }

  // Peers that keep sending invalid data are cut off for a while, so a broken
  // or hostile client cannot make us verify garbage forever.
  _strike (peer) {
    if (++peer.strikes < MAX_STRIKES) return
    this.banned.set(peer.id, Date.now() + BAN_MS)
    peer.conn.destroy()
  }

  _onMessage (peer, m) {
    if (m.t === 'hello') {
      if (m.v !== PROTOCOL_VERSION || !Array.isArray(m.swarms) || m.swarms.length > 512) return peer.conn.destroy()
      peer.entries = m.swarms.filter((x) => x && typeof x.tag === 'string' && typeof x.proof === 'string')
      return this._recomputeShared(peer)
    }

    // Everything below is scoped to a swarm this peer has proven membership of.
    const rec = typeof m.topic === 'string' && peer.shared.has(m.topic) ? this.swarms.get(m.topic) : null
    if (!rec) return

    if (m.t === 'summary') {
      if (m.digest !== rec.digest.toString('hex')) {
        const ids = [...rec.events.keys()]
        const size = this.havePartIds || HAVE_PART_IDS
        const parts = Math.max(1, Math.ceil(ids.length / size))
        for (let part = 0; part < parts; part++) {
          peer.conn.write(encodeFrame({ t: 'have', topic: rec.topic, part, parts, ids: ids.slice(part * size, (part + 1) * size) }))
        }
      }
      return
    }

    if (m.t === 'have') {
      const parts = m.parts === undefined ? 1 : m.parts
      const part = m.part === undefined ? 0 : m.part
      if (!Array.isArray(m.ids) || !Number.isInteger(parts) || !Number.isInteger(part) || parts < 1 || parts > MAX_HAVE_PARTS || part < 0 || part >= parts) return this._strike(peer)
      // Collect every part of the peer's id list before working out what it lacks.
      let pending = peer.haves.get(rec.topic)
      if (!pending || pending.parts !== parts || part === 0) {
        pending = { parts, seen: new Set(), ids: new Set() }
        peer.haves.set(rec.topic, pending)
      }
      pending.seen.add(part)
      for (const id of m.ids) if (typeof id === 'string') pending.ids.add(id)
      if (pending.seen.size < parts) return
      peer.haves.delete(rec.topic)
      const theirs = pending.ids
      const missing = [...rec.events.values()].filter((e) => !theirs.has(e.id)).sort(compareEvents)
      let batch = []
      let bytes = 0
      const flushBatch = () => {
        if (batch.length) peer.conn.write(encodeFrame({ t: 'events', topic: rec.topic, events: batch }))
        batch = []
        bytes = 0
      }
      for (const e of missing) {
        const size = JSON.stringify(e).length
        if (bytes + size > BATCH_BYTES) flushBatch()
        batch.push(e)
        bytes += size
      }
      flushBatch()
      return
    }

    if (m.t === 'events') {
      if (!Array.isArray(m.events)) return this._strike(peer)
      for (const e of m.events) {
        const verdict = this._receive(rec, e)
        if (verdict === undefined) this._accept(rec, e, peer)
        else if (verdict !== null) this._strike(peer)
      }
    }
  }
}
