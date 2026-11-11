#!/usr/bin/env node
// Builds self-contained release archives: the app, its dependencies and a Node
// runtime for the target platform, so nothing needs to be installed first.
//
//   node scripts/build-release.js                      every target
//   node scripts/build-release.js darwin-arm64 win-x64 just these
//
// The network libraries ship prebuilt binaries for every platform inside their
// npm packages, so all targets can be built from any one machine.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const NODE_LINE = process.env.RELEASE_NODE_LINE || 'latest-v22.x'

// target -> how Node names it, and which prebuilt native folders to keep
const TARGETS = {
  'darwin-arm64': { node: 'darwin-arm64', ext: 'tar.gz', prebuilds: ['darwin-arm64'] },
  'darwin-x64': { node: 'darwin-x64', ext: 'tar.gz', prebuilds: ['darwin-x64'] },
  'linux-x64': { node: 'linux-x64', ext: 'tar.gz', prebuilds: ['linux-x64', 'linux-x64-musl'] },
  'linux-arm64': { node: 'linux-arm64', ext: 'tar.gz', prebuilds: ['linux-arm64', 'linux-arm64-musl'] },
  'win-x64': { node: 'win-x64', ext: 'zip', prebuilds: ['win32-x64'] }
}
const APP_FILES = ['bin', 'src', 'commands', 'skills', '.claude-plugin', '.mcp.json', 'package.json', 'package-lock.json', 'LICENSE', 'README.md']

// On Windows, always the system's bsdtar: it reads and writes zip, and unlike
// the GNU tar that ships with Git it does not read "C:" as a remote host.
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], ...opts })
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

async function download (url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
}

// The Node runtime for a target, checked against nodejs.org's published hashes.
async function nodeRuntime (target, cache) {
  const sumsFile = path.join(cache, 'SHASUMS256.txt')
  if (!fs.existsSync(sumsFile)) await download(`https://nodejs.org/dist/${NODE_LINE}/SHASUMS256.txt`, sumsFile)
  const sums = fs.readFileSync(sumsFile, 'utf8')
  const t = TARGETS[target]
  const archiveExt = t.node.startsWith('win') ? 'zip' : 'tar.gz'
  const line = sums.split('\n').find((l) => l.endsWith(`-${t.node}.${archiveExt}`))
  if (!line) throw new Error(`no Node build listed for ${t.node}`)
  const [expected, name] = line.trim().split(/\s+/)
  const archive = path.join(cache, name)
  if (!fs.existsSync(archive)) await download(`https://nodejs.org/dist/${NODE_LINE}/${name}`, archive)
  if (sha256(archive) !== expected) {
    fs.rmSync(archive)
    throw new Error(`checksum mismatch for ${name}`)
  }
  const out = path.join(cache, `extract-${target}`)
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })
  const inner = name.replace(/\.(tar\.gz|zip)$/, '')
  // Relative paths throughout: some tar builds read "C:\\..." as a remote host.
  const rel = (p) => path.relative(cache, p).split(path.sep).join('/')
  if (archiveExt === 'zip') {
    if (process.platform === 'win32') run(TAR, ['-xf', rel(archive), '-C', rel(out), `${inner}/node.exe`], { cwd: cache })
    else run('unzip', ['-q', '-o', rel(archive), `${inner}/node.exe`, '-d', rel(out)], { cwd: cache })
    return { file: path.join(out, inner, 'node.exe'), version: name.match(/node-(v[\d.]+)-/)[1] }
  }
  run(TAR, ['-xzf', rel(archive), '-C', rel(out), `${inner}/bin/node`], { cwd: cache })
  return { file: path.join(out, inner, 'bin', 'node'), version: name.match(/node-(v[\d.]+)-/)[1] }
}

// Production dependencies, installed once and reused for every target.
function productionModules (cache) {
  const dir = path.join(cache, 'prod')
  const stamp = path.join(dir, '.lock-hash')
  const want = sha256(path.join(ROOT, 'package-lock.json'))
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === want) return path.join(dir, 'node_modules')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f))
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir, shell: process.platform === 'win32' })
  fs.writeFileSync(stamp, want)
  return path.join(dir, 'node_modules')
}

// Drop the prebuilt binaries of every other platform: they are most of the size.
function prunePrebuilds (modules, keep) {
  for (const name of fs.readdirSync(modules)) {
    const dir = path.join(modules, name, 'prebuilds')
    if (!fs.existsSync(dir)) continue
    for (const platform of fs.readdirSync(dir)) {
      if (!keep.includes(platform)) fs.rmSync(path.join(dir, platform), { recursive: true, force: true })
    }
    if (!fs.readdirSync(dir).length) throw new Error(`${name} has no prebuilt binary for ${keep.join('/')}`)
  }
}

const UNIX_LAUNCHER = `#!/bin/sh
# p2p-swarm launcher: runs the bundled app on the bundled Node runtime.
SELF="$0"
while [ -L "$SELF" ]; do
  TARGET="$(readlink "$SELF")"
  case "$TARGET" in /*) SELF="$TARGET" ;; *) SELF="$(dirname "$SELF")/$TARGET" ;; esac
done
DIR="$(cd "$(dirname "$SELF")" && pwd)"
exec "$DIR/runtime/node" "$DIR/bin/swarm.js" "$@"
`
const WINDOWS_LAUNCHER = '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0bin\\swarm.js" %*\r\n'

async function build (target, cache) {
  const t = TARGETS[target]
  const stage = path.join(DIST, 'stage', target)
  const app = path.join(stage, 'p2p-swarm')
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(path.join(app, 'runtime'), { recursive: true })

  for (const f of APP_FILES) fs.cpSync(path.join(ROOT, f), path.join(app, f), { recursive: true })
  fs.cpSync(productionModules(cache), path.join(app, 'node_modules'), { recursive: true })
  prunePrebuilds(path.join(app, 'node_modules'), t.prebuilds)

  const runtime = await nodeRuntime(target, cache)
  const windows = target.startsWith('win')
  fs.copyFileSync(runtime.file, path.join(app, 'runtime', windows ? 'node.exe' : 'node'))
  if (windows) fs.writeFileSync(path.join(app, 'swarm.cmd'), WINDOWS_LAUNCHER)
  else {
    fs.chmodSync(path.join(app, 'runtime', 'node'), 0o755)
    fs.writeFileSync(path.join(app, 'swarm'), UNIX_LAUNCHER, { mode: 0o755 })
  }
  fs.writeFileSync(path.join(app, 'VERSION'), `${pkg.version}\n`)
  fs.writeFileSync(path.join(app, 'BUILD.json'), JSON.stringify({ version: pkg.version, target, node: runtime.version }, null, 2) + '\n')

  // Unversioned names, so https://github.com/<repo>/releases/latest/download/<name> always works.
  const out = path.join(DIST, `p2p-swarm-${target}.${t.ext}`)
  fs.rmSync(out, { force: true })
  const outRel = path.relative(stage, out).split(path.sep).join('/')
  if (t.ext === 'zip') {
    if (process.platform === 'win32') run(TAR, ['-a', '-cf', outRel, 'p2p-swarm'], { cwd: stage }) // bsdtar writes zip by extension
    else run('zip', ['-q', '-r', '-X', outRel, 'p2p-swarm'], { cwd: stage })
    // A zip always starts with "PK": catch a mis-built archive here, not on a user's machine.
    if (fs.readFileSync(out).subarray(0, 2).toString() !== 'PK') throw new Error(`${out} is not a zip archive`)
  } else run(TAR, ['-czf', outRel, 'p2p-swarm'], { cwd: stage, env: { ...process.env, COPYFILE_DISABLE: '1' } })
  return { target, file: out, node: runtime.version }
}

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const targets = wanted.length ? wanted : Object.keys(TARGETS)
for (const t of targets) if (!TARGETS[t]) throw new Error(`unknown target "${t}". Known: ${Object.keys(TARGETS).join(', ')}`)

const cache = path.join(DIST, '.cache')
fs.mkdirSync(cache, { recursive: true })
const built = []
for (const target of targets) {
  const b = await build(target, cache)
  built.push(b)
  console.log(`${path.basename(b.file).padEnd(34)} ${(fs.statSync(b.file).size / 1e6).toFixed(1).padStart(6)} MB   node ${b.node}`)
}
// Checksums cover every archive present, so partial rebuilds keep the list complete.
const archives = fs.readdirSync(DIST).filter((f) => /^p2p-swarm-.*\.(tar\.gz|zip)$/.test(f)).sort()
fs.writeFileSync(path.join(DIST, 'SHA256SUMS'), archives.map((f) => `${sha256(path.join(DIST, f))}  ${f}`).join('\n') + '\n')
console.log(`\nv${pkg.version}: ${archives.length} archive(s) and SHA256SUMS in ${path.relative(process.cwd(), DIST) || '.'}/ (host ${os.platform()}-${os.arch()})`)
