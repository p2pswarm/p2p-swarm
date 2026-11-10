// Files in the swarm.
//
// A file is a blob named by the SHA-256 of its contents. A share is a manifest:
// a list of { path, hash, size } that is itself a blob, so one hash names a
// whole folder snapshot. The event log only ever carries that hash; the bytes
// are fetched on demand from whichever peers hold them and checked against it.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { canonical } from './events.js'

export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024
const HEX64 = /^[0-9a-f]{64}$/

// Never published, whoever asks. A share is permanent and public to the swarm,
// and the request to share may come from an agent that has been talked into it.
const SENSITIVE = [
  /(^|\/)\.env(\.|$)/i, /(^|\/)\.ssh(\/|$)/, /(^|\/)\.aws(\/|$)/, /(^|\/)\.gnupg(\/|$)/, /(^|\/)\.kube(\/|$)/, /(^|\/)\.docker\/config\.json$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/, /\.(pem|key|p12|pfx|keystore|jks)$/i, /(^|\/)\.(npmrc|netrc|pypirc|git-credentials)$/,
  /(^|\/)credentials(\.|$)/i, /(^|\/)secrets?(\.|\/|$)/i, /(^|\/)\.p2p-swarm(\/|$)/, /(^|\/)identity\.json$/
]
const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn'])

export function isSensitive (relPath) {
  return SENSITIVE.some((re) => re.test(relPath))
}

// A manifest path is always relative, forward-slashed and stays inside the share.
export function checkPath (p) {
  if (typeof p !== 'string' || !p || p.length > 1024) return 'bad path'
  if (p.includes('\\') || p.includes('\0') || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return 'bad path'
  const parts = p.split('/')
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return 'bad path'
  return null
}

export function validateManifest (value) {
  if (!value || value.v !== 1 || !Array.isArray(value.files)) throw new Error('malformed manifest')
  const seen = new Set()
  for (const f of value.files) {
    if (!f || typeof f !== 'object' || checkPath(f.path) || !HEX64.test(f.hash) || !Number.isSafeInteger(f.size) || f.size < 0) throw new Error('malformed manifest entry')
    if (seen.has(f.path)) throw new Error('duplicate path in manifest')
    seen.add(f.path)
  }
  return value.files.map((f) => ({ path: f.path, hash: f.hash, size: f.size, ...(f.x === true ? { x: true } : {}) }))
}

export function encodeManifest (files) {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return Buffer.from(canonical({ v: 1, files: sorted }))
}

// Resolves a manifest path under a destination folder, refusing to leave it.
export function safeJoin (dest, rel) {
  if (checkPath(rel)) throw new Error(`unsafe path in share: ${rel}`)
  const out = path.resolve(dest, ...rel.split('/'))
  if (out !== dest && !out.startsWith(dest + path.sep)) throw new Error(`unsafe path in share: ${rel}`)
  return out
}

// Lists the regular files under a path, the way a person would expect "share
// this folder" to behave: git-ignored files, VCS metadata, dependencies,
// symlinks and anything that looks like a secret stay behind.
export function listFiles (root) {
  const stat = fs.lstatSync(root)
  if (stat.isSymbolicLink()) throw new Error('refusing to share a symbolic link')
  if (stat.isFile()) {
    const name = path.basename(root)
    return isSensitive(name) ? { base: path.dirname(root), files: [], skipped: [name] } : { base: path.dirname(root), files: [name], skipped: [] }
  }
  if (!stat.isDirectory()) throw new Error('not a file or folder')

  let candidates = null
  const git = spawnSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (git.status === 0) candidates = git.stdout.split('\0').filter(Boolean)
  if (!candidates) {
    candidates = []
    const walk = (dir, prefix) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), rel)
        } else if (entry.isFile()) candidates.push(rel)
      }
    }
    walk(root, '')
  }

  const files = []
  const skipped = []
  for (const rel of candidates.map((c) => c.split(path.sep).join('/')).sort()) {
    if (rel.split('/').some((part) => SKIP_DIRS.has(part)) || checkPath(rel)) continue
    if (isSensitive(rel)) {
      skipped.push(rel)
      continue
    }
    let s
    try { s = fs.lstatSync(path.join(root, rel)) } catch { continue }
    if (s.isFile()) files.push(rel)
  }
  return { base: root, files, skipped }
}

export class BlobStore {
  constructor (dir) {
    this.dir = dir
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.tmpSeq = 0
  }

  path (hash) {
    if (!HEX64.test(hash)) throw new Error('bad hash')
    return path.join(this.dir, hash)
  }

  has (hash) {
    return HEX64.test(hash) && fs.existsSync(path.join(this.dir, hash))
  }

  size (hash) {
    return fs.statSync(this.path(hash)).size
  }

  tempPath () {
    return path.join(this.dir, `.tmp-${process.pid}-${Date.now()}-${++this.tmpSeq}`)
  }

  // Moves a fully written, already verified temp file into place.
  adopt (tmp, hash) {
    if (this.has(hash)) fs.rmSync(tmp, { force: true })
    else fs.renameSync(tmp, this.path(hash))
  }

  putBuffer (buffer) {
    const hash = crypto.createHash('sha256').update(buffer).digest('hex')
    if (!this.has(hash)) {
      const tmp = this.tempPath()
      fs.writeFileSync(tmp, buffer, { mode: 0o600 })
      this.adopt(tmp, hash)
    }
    return hash
  }

  // Streams a local file into the store without holding it in memory.
  async putFile (file) {
    const tmp = this.tempPath()
    const hasher = crypto.createHash('sha256')
    let size = 0
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp, { mode: 0o600 })
      fs.createReadStream(file)
        .on('data', (chunk) => { hasher.update(chunk); size += chunk.length })
        .on('error', reject)
        .pipe(out)
        .on('error', reject)
        .on('finish', resolve)
    })
    const hash = hasher.digest('hex')
    this.adopt(tmp, hash)
    return { hash, size }
  }

  read (hash) {
    return fs.readFileSync(this.path(hash))
  }

  readManifest (root) {
    if (this.size(root) > MAX_MANIFEST_BYTES) throw new Error('manifest too large')
    return validateManifest(JSON.parse(this.read(root).toString('utf8')))
  }
}
