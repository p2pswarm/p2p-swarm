// On-disk state for one node. Deliberately boring: JSON files and append-only
// JSONL logs, no native dependencies, trivially inspectable and backup-able.
//
//   <home>/identity.json        ed25519 seed (0600)
//   <home>/config.json          nickname, joined swarms, blocklist
//   <home>/swarms/<topic>.jsonl one signed event per line
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createSeed, identityFromSeed } from './identity.js'

export function defaultHome () {
  return process.env.P2P_SWARM_HOME || path.join(os.homedir(), '.p2p-swarm')
}

function readJson (file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonAtomic (file, value, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode })
  fs.renameSync(tmp, file)
}

export class Store {
  constructor (home = defaultHome()) {
    this.home = home
    fs.mkdirSync(path.join(home, 'swarms'), { recursive: true, mode: 0o700 })
    this.configFile = path.join(home, 'config.json')
    this.config = { nick: null, swarms: [], blocked: [], ...readJson(this.configFile, {}) }
  }

  loadIdentity () {
    const file = path.join(this.home, 'identity.json')
    const saved = readJson(file, null)
    if (saved?.seed) return identityFromSeed(Buffer.from(saved.seed, 'hex'))
    const seed = createSeed()
    writeJsonAtomic(file, { seed: seed.toString('hex'), created: new Date().toISOString() })
    return identityFromSeed(seed)
  }

  saveConfig () {
    writeJsonAtomic(this.configFile, this.config)
  }

  logFile (topic) {
    return path.join(this.home, 'swarms', `${topic}.jsonl`)
  }

  loadEvents (topic) {
    let text
    try {
      text = fs.readFileSync(this.logFile(topic), 'utf8')
    } catch {
      return []
    }
    const events = []
    for (const line of text.split('\n')) {
      if (!line) continue
      try { events.push(JSON.parse(line)) } catch { /* torn write at the tail: skip */ }
    }
    return events
  }

  appendEvent (topic, event) {
    fs.appendFileSync(this.logFile(topic), JSON.stringify(event) + '\n', { mode: 0o600 })
  }

  removeLog (topic) {
    fs.rmSync(this.logFile(topic), { force: true })
  }
}
