// Local control plane: HTTP on 127.0.0.1 only.
//
// Any web page the user visits can make requests to localhost, so this server
// defends itself: a strict Host check (DNS rebinding), a bearer token for every
// API call (CSRF), no CORS headers, and a locked-down CSP for the dashboard.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { actions, getState, getJob, describeEvent, workAvailable } from './actions.js'

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui')
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/logo.svg': ['logo.svg', 'image/svg+xml']
}
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const MAX_BODY = 16 * 1024 * 1024 // room for an agent to publish a batch of text files
const MAX_DRAIN = 32 * 1024 * 1024
const MAX_WAIT_S = 55

function send (res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(body)
}

function httpError (status, message) {
  return Object.assign(new Error(message), { status })
}

// Reads a JSON body. An oversized body is drained and answered with 413 rather
// than cutting the socket, so the caller sees a real error.
function readBody (req) {
  return new Promise((resolve, reject) => {
    let size = 0
    let chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_DRAIN) return req.destroy()
      if (size > MAX_BODY) chunks = null
      else if (chunks) chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks) return reject(httpError(413, 'request too large'))
      let value
      try {
        value = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
      } catch {
        return reject(httpError(400, 'invalid JSON'))
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return reject(httpError(400, 'request body must be a JSON object'))
      resolve(value)
    })
    req.on('error', reject)
  })
}

export function createApi (node, { token, version, onShutdown }) {
  const tokenBuf = Buffer.from(token)
  const authorized = (req) => {
    const header = req.headers.authorization || ''
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
    return given.length === tokenBuf.length && crypto.timingSafeEqual(given, tokenBuf)
  }

  const server = http.createServer(async (req, res) => {
    try {
      const port = server.address().port
      const host = req.headers.host
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: 'forbidden host' })
      const url = new URL(req.url, `http://${host}`)

      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname]
        res.writeHead(200, {
          'content-type': type,
          'content-security-policy': CSP,
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'cache-control': 'no-store'
        })
        return res.end(fs.readFileSync(path.join(UI_DIR, file)))
      }

      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' })
      if (!authorized(req)) return send(res, 401, { error: 'missing or invalid token' })

      if (req.method === 'GET') {
        if (url.pathname === '/api/ping') return send(res, 200, { ok: true, name: 'p2p-swarm', version, id: node.id })
        if (url.pathname === '/api/state') return send(res, 200, getState(node))
        if (url.pathname === '/api/work') return send(res, 200, workAvailable(node, url.searchParams.get('swarm') || undefined))
        if (url.pathname === '/api/job') return send(res, 200, getJob(node, url.searchParams.get('ref'), url.searchParams.get('swarm')))
        if (url.pathname === '/api/events') {
          const since = Math.max(0, Number(url.searchParams.get('since')) || 0)
          const wait = Math.min(MAX_WAIT_S, Math.max(0, Number(url.searchParams.get('wait')) || 0))
          const othersOnly = url.searchParams.get('others') === '1'
          const deadline = Date.now() + wait * 1000
          let cursor = since
          let out = []
          for (;;) {
            const items = await node.waitForEvents(cursor, Math.max(0, deadline - Date.now()))
            if (items.length) cursor = items[items.length - 1].seq
            out = items
              .filter((it) => !othersOnly || (it.event.author !== node.id && it.event.type !== 'peer.hello'))
              .map((it) => describeEvent(node, it))
              .filter(Boolean)
            if (out.length || Date.now() >= deadline || node.stopped) break
          }
          return send(res, 200, { cursor, events: out.slice(-200) })
        }
        return send(res, 404, { error: 'not found' })
      }

      if (req.method === 'POST') {
        const body = await readBody(req)
        if (url.pathname === '/api/action') {
          const fn = Object.hasOwn(actions, body.action) ? actions[body.action] : null
          if (!fn) return send(res, 400, { error: `unknown action "${body.action}"` })
          try {
            const params = body.params === undefined ? {} : body.params
            if (params === null || typeof params !== 'object' || Array.isArray(params)) throw new Error('"params" must be an object')
            return send(res, 200, { ok: true, result: await fn(node, params) })
          } catch (err) {
            return send(res, 400, { error: err.message })
          }
        }
        if (url.pathname === '/api/shutdown') {
          send(res, 200, { ok: true })
          return onShutdown()
        }
      }
      return send(res, 404, { error: 'not found' })
    } catch (err) {
      if (!res.headersSent) send(res, err.status || 500, { error: err.message })
    }
  })

  return server
}
