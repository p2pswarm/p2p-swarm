// Peer-to-peer file sharing: integrity, access, safety on disk.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { checkPath, validateManifest, safeJoin, isSensitive, listFiles } from '../src/core/blobs.js'
import { canonical } from '../src/core/events.js'
import { actions } from '../src/daemon/actions.js'
import { localPath } from '../src/mcp/tools.js'
import { encodeFrame } from '../src/net/wire.js'
import { testnet, until, ids, tmpHome } from './helpers.js'

const hashOf = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function makeProject () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-swarm-proj-'))
  const write = (rel, data, mode) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), data, mode ? { mode } : undefined)
  }
  write('README.md', '# demo\n')
  write('src/index.js', 'export const answer = 42\n')
  write('src/deep/nested/util.js', 'export const noop = () => {}\n')
  write('bin/run.sh', '#!/bin/sh\necho hi\n', 0o755)
  write('assets/big.bin', crypto.randomBytes(3 * 1024 * 1024 + 123)) // several chunks, not chunk-aligned
  write('empty.txt', '')
  write('ünïcödé ✓.txt', 'héllo\n')
  write('.env', 'API_KEY=supersecret\n')
  write('.env.production', 'DB_PASSWORD=hunter2\n')
  write('deploy/id_rsa', '-----BEGIN OPENSSH PRIVATE KEY-----\n')
  write('certs/server.pem', '-----BEGIN PRIVATE KEY-----\n')
  write('node_modules/dep/index.js', 'module.exports = 1\n')
  write('.git/config', '[core]\n')
  fs.symlinkSync('/etc/hosts', path.join(dir, 'escape-link'))
  return dir
}

test('paths that could escape a share are rejected everywhere', () => {
  for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', 'a//b', './a', 'a/.', 'a\\b', 'C:/x', 'a\0b', 'x'.repeat(1025), 5, null]) {
    assert.ok(checkPath(bad), `should reject ${JSON.stringify(bad)}`)
  }
  for (const ok of ['a', 'a/b.c', '.hidden', 'ünï ✓.txt', 'a/..b/c']) assert.equal(checkPath(ok), null, ok)
  const h = 'a'.repeat(64)
  assert.throws(() => validateManifest({ v: 1, files: [{ path: '../../.bashrc', hash: h, size: 1 }] }), /malformed/)
  assert.throws(() => validateManifest({ v: 1, files: [{ path: 'a', hash: h, size: 1 }, { path: 'a', hash: h, size: 1 }] }), /duplicate/)
  assert.throws(() => validateManifest({ v: 1, files: [{ path: 'a', hash: 'nope', size: 1 }] }), /malformed/)
  assert.throws(() => validateManifest({ v: 1, files: [{ path: 'a', hash: h, size: -1 }] }), /malformed/)
  assert.throws(() => validateManifest({ v: 2, files: [] }), /malformed/)
  assert.throws(() => safeJoin('/tmp/dest', '../outside'), /unsafe/)
  assert.equal(safeJoin('/tmp/dest', 'a/b'), path.join('/tmp/dest', 'a', 'b'))
})

test('secrets, dependencies, VCS data and symlinks never leave the machine', () => {
  for (const s of ['.env', 'app/.env.local', '.ssh/config', 'x/id_ed25519', 'a/b.pem', 'server.key', '.npmrc', '.aws/credentials', 'config/secrets.yml', 'secret/x', 'credentials.json', '.p2p-swarm/identity.json']) {
    assert.ok(isSensitive(s), s)
  }
  for (const s of ['src/environment.js', 'README.md', 'keyboard.js', 'docs/secretary.md', 'monkey.js']) assert.equal(isSensitive(s), false, s)

  const dir = makeProject()
  const { files, skipped } = listFiles(dir)
  assert.deepEqual(files, ['README.md', 'assets/big.bin', 'bin/run.sh', 'empty.txt', 'src/deep/nested/util.js', 'src/index.js', 'ünïcödé ✓.txt'])
  assert.deepEqual(skipped, ['.env', '.env.production', 'certs/server.pem', 'deploy/id_rsa'])
  assert.throws(() => listFiles(path.join(dir, 'escape-link')), /symbolic link/)
  assert.deepEqual(listFiles(path.join(dir, '.env')).files, [])
})

test('a folder travels peer to peer and arrives byte-identical; the log carries only its fingerprint', async (t) => {
  const net = await testnet(t)
  const alice = await net.node('alice')
  const bob = await net.node('bob')
  const swarm = alice.createSwarm('files')
  bob.joinSwarm(swarm.link)
  await until(() => bob.peers.get(alice.id)?.shared.has(swarm.topic), { label: 'connect' })

  const project = makeProject()
  const shared = await actions.share(alice, { path: project })
  assert.equal(shared.files, 7)
  assert.equal(shared.leftOut.count, 4)
  await until(() => ids(alice, swarm.topic) === ids(bob, swarm.topic), { label: 'announcement' })
  const logBytes = fs.statSync(bob.store.logFile(swarm.topic)).size
  assert.ok(logBytes < 4000, `the 3 MB folder must not be in the log (log is ${logBytes} bytes)`)

  const dest = path.join(tmpHome(), 'out')
  const got = await actions.fetch(bob, { share: shared.share, dest })
  assert.equal(got.files, 7)
  for (const rel of ['README.md', 'assets/big.bin', 'bin/run.sh', 'empty.txt', 'src/deep/nested/util.js', 'src/index.js', 'ünïcödé ✓.txt']) {
    assert.equal(hashOf(path.join(dest, rel)), hashOf(path.join(project, rel)), rel)
  }
  assert.equal(fs.statSync(path.join(dest, 'bin/run.sh')).mode & 0o111, 0o111, 'executable bit kept')
  assert.equal(fs.statSync(path.join(dest, 'README.md')).mode & 0o111, 0)
  for (const leak of ['.env', '.env.production', 'deploy/id_rsa', 'certs/server.pem', 'node_modules', '.git', 'escape-link']) {
    assert.equal(fs.existsSync(path.join(dest, leak)), false, `${leak} must not have been shared`)
  }
  await assert.rejects(actions.fetch(bob, { share: shared.share, dest }), /already has things in it/)
  // editing the fetched copy must not damage what bob serves to others
  fs.writeFileSync(path.join(dest, 'README.md'), 'changed')
  assert.equal(bob.blobs.read(crypto.createHash('sha256').update('# demo\n').digest('hex')).toString(), '# demo\n')
})

test('files keep flowing after the original sharer leaves', async (t) => {
  const net = await testnet(t)
  const alice = await net.node('alice')
  const bob = await net.node('bob')
  const swarm = alice.createSwarm('seeding')
  bob.joinSwarm(swarm.link)
  await until(() => bob.peers.get(alice.id)?.shared.has(swarm.topic), { label: 'connect' })
  const project = makeProject()
  const shared = await actions.share(alice, { path: project })
  await until(() => ids(alice, swarm.topic) === ids(bob, swarm.topic), { label: 'announcement' })
  await actions.fetch(bob, { share: shared.share, dest: path.join(tmpHome(), 'b') })
  await alice.stop()

  const carol = await net.node('carol')
  carol.joinSwarm(swarm.link)
  await until(() => carol.peers.get(bob.id)?.shared.has(swarm.topic) && carol.view(swarm.topic).shares.size === 1, { label: 'carol sees the share via bob' })
  const dest = path.join(tmpHome(), 'c')
  const got = await actions.fetch(carol, { share: shared.share, dest })
  assert.equal(got.files, 7)
  assert.equal(hashOf(path.join(dest, 'assets/big.bin')), hashOf(path.join(project, 'assets/big.bin')))
})

test('a peer that serves altered bytes is caught, penalised and routed around', async (t) => {
  const net = await testnet(t)
  const alice = await net.node('alice')
  const liar = await net.node('liar')
  const swarm = alice.createSwarm('integrity')
  liar.joinSwarm(swarm.link)
  await until(() => liar.peers.get(alice.id)?.shared.has(swarm.topic), { label: 'connect' })
  const shared = await actions.put_files(alice, { name: 'doc', files: [{ path: 'contract.txt', content: 'pay alice 10' }] })
  await until(() => ids(alice, swarm.topic) === ids(liar, swarm.topic), { label: 'announcement' })
  await actions.read_file(liar, { share: shared.share, path: 'contract.txt' }) // liar now holds a genuine copy...
  const hash = crypto.createHash('sha256').update('pay alice 10').digest('hex')
  fs.writeFileSync(liar.blobs.path(hash), 'pay liar 9999') // ...and tampers with it

  const dave = await net.node('dave')
  dave.joinSwarm(swarm.link)
  await until(() => dave.peers.get(alice.id)?.shared.has(swarm.topic) && dave.peers.get(liar.id)?.shared.has(swarm.topic) && dave.view(swarm.topic).shares.size === 1, { label: 'dave connected to both' })
  await dave.fetchBlob(swarm.topic, hash, { prefer: liar.id, limit: 100 }) // ask the liar first
  assert.equal(dave.blobs.read(hash).toString(), 'pay alice 10')
  assert.equal(dave.peers.get(liar.id).strikes, 1)
  assert.equal(dave.peers.get(alice.id).strikes, 0)
  assert.equal(fs.readdirSync(dave.blobs.dir).filter((f) => f.startsWith('.tmp-')).length, 0, 'no partial files left behind')

  // and a peer cannot make us write more than the file is supposed to be
  await assert.rejects(dave.fetchBlob(swarm.topic, (await alice.blobs.putFile(liar.blobs.path(hash))).hash, { limit: 3 }), /could not fetch/)
})

test('a member cannot pull files that their swarm never announced', async (t) => {
  const net = await testnet(t)
  const alice = await net.node('alice')
  const mallory = await net.node('mallory')
  const privateSwarm = alice.createSwarm('private')
  const shared = await actions.put_files(alice, { swarm: 'private', name: 'plans', files: [{ path: 'plan.txt', content: 'top secret plan' }] })
  const publicSwarm = alice.createSwarm('public')
  mallory.joinSwarm(publicSwarm.link) // mallory is only in the public swarm
  await until(() => mallory.peers.get(alice.id)?.shared.has(publicSwarm.topic), { label: 'connect' })

  const secretHash = crypto.createHash('sha256').update('top secret plan').digest('hex')
  const root = alice.view(privateSwarm.topic).shares.values().next().value.root
  assert.ok(alice.blobs.has(secretHash) && shared.share)
  for (const hash of [secretHash, root]) {
    await assert.rejects(mallory.fetchBlob(publicSwarm.topic, hash), /peer does not have it/)
    assert.equal(mallory.blobs.has(hash), false)
  }
  // nor by naming the private swarm's topic directly
  const conn = mallory.peers.get(alice.id).conn
  conn.write(encodeFrame({ t: 'blob.want', topic: privateSwarm.topic, hash: secretHash, req: 99 }))
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(mallory.blobs.has(secretHash), false)
})

test('agents collaborate on a codebase through snapshots, without touching a disk', async (t) => {
  const net = await testnet(t)
  const [owner, a1, a2] = await Promise.all(['owner', 'a1', 'a2'].map((n) => net.node(n)))
  const swarm = owner.createSwarm('code')
  a1.joinSwarm(swarm.link)
  a2.joinSwarm(swarm.link)
  await until(() => [owner, a1, a2].every((n) => [...n.peers.values()].filter((p) => p.shared.has(swarm.topic)).length === 2), { label: 'mesh' })
  const settled = () => until(() => new Set([owner, a1, a2].map((n) => ids(n, swarm.topic))).size === 1, { label: 'settled' })

  const job = actions.post_job(owner, { title: 'Improve the project', description: 'see shared files', tasks: ['fix index', 'add docs'] })
  const base = await actions.share(owner, { path: makeProject(), job: job.job, name: 'project' })
  await settled()

  // An agent is told about the files with its work, lists them and reads one.
  const w1 = await actions.next(a1, {})
  assert.equal(w1.files[0].ref, base.share)
  assert.match(w1.next, /swarm_files/)
  const listing = await actions.files(a1, { share: base.share, prefix: 'src/' })
  assert.deepEqual(listing.listing.map((f) => f.path), ['src/deep/nested/util.js', 'src/index.js'])
  const read = await actions.read_file(a1, { share: base.share, path: 'src/index.js' })
  assert.equal(read.text, 'export const answer = 42\n')
  assert.equal((await actions.read_file(a1, { share: base.share, path: 'assets/big.bin' })).binary, true)
  await assert.rejects(actions.read_file(a1, { share: base.share, path: '.env' }), /not in that share/)
  const slice = await actions.read_file(a1, { share: base.share, path: 'src/index.js', offset: 7, max_chars: 5 })
  assert.deepEqual([slice.text, slice.truncated, slice.nextOffset], ['const', true, 12])

  // Each agent publishes "the base plus my change", attached to its task.
  const s1 = await actions.put_files(a1, { base: base.share, task: w1.task.ref, files: [{ path: 'src/index.js', content: 'export const answer = 43\n' }], delete: ['empty.txt'], note: 'fixed' })
  actions.submit(a1, { task: w1.task.ref, summary: 'fix', result: `see share ${s1.share}` })
  await settled()
  const w2 = await actions.next(a2, {})
  const s2 = await actions.put_files(a2, { base: base.share, task: w2.task.ref, files: [{ path: 'docs/guide.md', content: '# Guide\n' }] })
  actions.submit(a2, { task: w2.task.ref, summary: 'docs', result: `see share ${s2.share}` })
  await settled()
  await assert.rejects(actions.put_files(a2, { base: base.share }), /nothing to publish/)
  await assert.rejects(actions.put_files(a2, { files: [{ path: '../evil', content: 'x' }] }), /unsafe/)

  // The changes are visible as a diff against the base.
  const d1 = await actions.files(a2, { share: s1.share })
  assert.deepEqual(d1.listing.filter((f) => f.change !== 'same').map((f) => [f.path, f.change]), [['src/index.js', 'modified']])
  assert.deepEqual(d1.deleted, ['empty.txt'])
  assert.equal(d1.basedOn, base.share)

  // Whoever takes the final task merges by reference: no file content is re-sent.
  const fin = await actions.next(a1, {})
  assert.equal(fin.task.final, true)
  assert.equal(fin.files.length, 3)
  const merged = await actions.put_files(a1, { base: s1.share, task: fin.task.ref, name: 'project', copy: [{ share: s2.share, path: 'docs/guide.md' }] })
  actions.submit(a1, { task: fin.task.ref, summary: 'merged', result: `final snapshot: share ${merged.share}` })
  await settled()

  // The owner, who has the real repo, pulls the finished snapshot to disk.
  const dest = path.join(tmpHome(), 'final')
  const got = await actions.fetch(owner, { share: merged.share, dest })
  assert.equal(got.files, 7) // 7 base files - empty.txt + guide.md
  assert.equal(fs.readFileSync(path.join(dest, 'src/index.js'), 'utf8'), 'export const answer = 43\n')
  assert.equal(fs.readFileSync(path.join(dest, 'docs/guide.md'), 'utf8'), '# Guide\n')
  assert.equal(fs.existsSync(path.join(dest, 'empty.txt')), false)
  assert.equal(fs.statSync(path.join(dest, 'assets/big.bin')).size, 3 * 1024 * 1024 + 123)
  assert.equal(owner.view(swarm.topic).jobs.values().next().value.status, 'complete')
})

test('a session can only share from, or write to, its own project folder and the temp folder', () => {
  const cwd = process.cwd()
  assert.equal(localPath('src', 'share from'), fs.realpathSync(path.join(cwd, 'src')))
  assert.equal(localPath(cwd, 'share from'), fs.realpathSync(cwd))
  assert.ok(localPath(path.join(os.tmpdir(), 'new', 'nested', 'dest'), 'write files').startsWith(fs.realpathSync(os.tmpdir())))
  for (const bad of [os.homedir(), '/', path.dirname(os.homedir()), '..', '../..', '/etc', '/etc/passwd', path.join(os.homedir(), '.ssh'), path.join(os.homedir(), 'Documents'), 'src/../../../etc']) {
    assert.throws(() => localPath(bad, 'share from'), /refusing to|can only/, `must refuse ${bad}`)
  }
  // a symlink inside the project that points outside does not smuggle a path in
  const link = path.join(os.tmpdir(), `p2p-swarm-link-${process.pid}`)
  fs.symlinkSync(os.homedir(), link)
  try {
    assert.throws(() => localPath(link, 'share from'), /refusing to/)
    assert.throws(() => localPath(path.join(link, '.ssh'), 'share from'), /can only/)
  } finally {
    fs.rmSync(link)
  }
  // a session opened in the home folder itself gets no project root
  const here = process.cwd()
  try {
    process.chdir(os.homedir())
    assert.throws(() => localPath('Documents', 'share from'), /can only/)
    assert.ok(localPath(path.join(os.tmpdir(), 'x'), 'write files'))
  } finally {
    process.chdir(here)
  }
})

test('an event type from a newer version is skipped without penalising whoever relayed it', async (t) => {
  const net = await testnet(t)
  const alice = await net.node('alice')
  const bob = await net.node('bob')
  const swarm = alice.createSwarm('compat')
  bob.joinSwarm(swarm.link)
  await until(() => bob.peers.get(alice.id)?.shared.has(swarm.topic), { label: 'connect' })
  const core = { v: 2, swarm: swarm.topic, author: bob.id, lamport: 50, ts: Date.now(), type: 'future.feature', body: { anything: true } }
  const id = crypto.createHash('sha256').update(canonical(core)).digest()
  const future = { ...core, id: id.toString('hex'), sig: bob.identity.sign(id).toString('hex') }
  bob.peers.get(alice.id).conn.write(encodeFrame({ t: 'events', topic: swarm.topic, events: [future] }))
  const ok = bob.publish(swarm.topic, 'msg', { text: 'after' })
  await until(() => alice.swarms.get(swarm.topic).events.has(ok.id), { label: 'later event' })
  assert.equal(alice.swarms.get(swarm.topic).events.has(future.id), false)
  assert.equal(alice.peers.get(bob.id).strikes, 0)
})
