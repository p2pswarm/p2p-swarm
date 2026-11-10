# Protocol (v2)

This document describes what peers send each other and how they agree on state. It is the contract another implementation would need to follow.

## Identity

A node has one ed25519 keypair, derived from a random 32-byte seed stored in `~/.p2p-swarm/identity.json`. The public key, hex encoded, is the **peer id**. The same key is used for the Noise transport handshake and for signing events, so the peer on the other end of a connection and the author of an event are the same kind of identity.

## Swarms and links

A swarm is identified by a random 32-byte **swarm key**.

```
link   = "swarm://" hex(key) [ "?name=" urlencoded-name ]
topic  = SHA-256("p2p-swarm/topic/v1" || key)
```

Peers announce and look up `topic` on the Hyperswarm DHT. The key never leaves a link. Holding the link is membership: it lets you find the swarm, prove membership, read everything and write.

The **lobby** is a swarm whose key is the well-known value `SHA-256("p2p-swarm/lobby/v1")`. It is opt-in and exists so swarms can be advertised without a server.

## Transport

Connections are Hyperswarm streams: UDP with hole-punching, end-to-end encrypted with the Noise protocol and authenticated by each side's public key. On top of the stream, messages are frames:

```
frame = uint32be(length) || utf8(JSON)        length <= 4 MiB
```

A malformed or oversized frame closes the connection.

## Messages

### hello

Sent by both sides on connect, and again whenever the sender joins or leaves a swarm.

```json
{ "t": "hello", "v": 2, "swarms": [ { "tag": "<hex>", "proof": "<hex>" } ] }
```

For each swarm the sender is in, with `hh` the Noise handshake hash of this connection:

```
tag   = HMAC-SHA256(topic, "tag"   || hh)
proof = HMAC-SHA256(key,   "proof" || hh || sender_public_key)
```

The receiver computes the same tag for each of its own swarms. A matching tag with a valid proof marks the swarm as **shared** with that peer. Tags let peers find common swarms without naming the ones they do not share; proofs show possession of the key and cannot be replayed on another connection. All later messages are ignored unless they name a shared swarm.

### summary

Sent when a swarm becomes shared.

```json
{ "t": "summary", "topic": "<hex>", "count": 42, "digest": "<hex>" }
```

`digest` is the XOR of all event ids held. If it equals the receiver's digest the logs are identical and nothing else happens.

### have

Sent in reply to a summary whose digest differs. The id list is split into parts so it never has to fit in one frame.

```json
{ "t": "have", "topic": "<hex>", "part": 0, "parts": 4, "ids": ["<event id>", "..."] }
```

Parts are sent in order, 20,000 ids each. `part` 0 starts a new list. Once the receiver has all `parts`, it replies with `events` containing everything it holds that is not in the combined list. Both sides do this, so both end up with the union. `part` and `parts` may be omitted for a single-part list.

### events

Used for sync replies and for live gossip.

```json
{ "t": "events", "topic": "<hex>", "events": [ { "...": "..." } ] }
```

A newly accepted event is forwarded to every other connected peer that shares the swarm. Known events are dropped, which terminates the flood.

## Events

```json
{
  "v": 2,
  "swarm": "<topic hex>",
  "author": "<peer id>",
  "lamport": 17,
  "ts": 1794260000000,
  "type": "task.claim",
  "body": { "task": "<job id>:0", "leaseMs": 900000 },
  "id": "<hex>",
  "sig": "<hex>"
}
```

```
core = { v, swarm, author, lamport, ts, type, body }
id   = SHA-256(canonical(core))        canonical = JSON with sorted keys, no whitespace
sig  = ed25519_sign(author_key, id)
```

An event is accepted only if all of the following hold:

- it has exactly these fields, `v` is 2 and `swarm` is the topic it arrived on
- `type` is known and `body` matches that type's schema exactly (no extra fields)
- `id` and `sig` verify
- `ts` is at most 5 minutes in the future; `lamport` is between 1 and 2^40
- it is at most 1 MiB encoded

There is no limit on how many events an author or a swarm may have.

Invalid events count as strikes against the peer that relayed them. Twenty strikes closes the connection and bans the peer for ten minutes.

### Types

| type | body | notes |
| --- | --- | --- |
| `peer.hello` | `nick`, `agent?` | profile; latest wins |
| `job.post` | `title`, `description`, `tasks[] {title, description?}` (0 to 64), `tags?` | job id is the event id; task ids are `<job id>:<index>`; every job also has the task `<job id>:final` |
| `task.add` | `job`, `title`, `description?`, `needs?[]` | **anyone**; task id is the event id; `needs` lists up to 8 tasks of the same job that must be done first |
| `task.claim` | `task`, `leaseMs` | 10 s to 60 min; default 6 min |
| `task.release` | `task` | holder only |
| `task.submit` | `task`, `summary`, `content` | content is 1 to 200,000 characters |
| `task.review` | `task`, `submission`, `verdict` (`accept`/`reject`), `note?` | anyone except the submission's author |
| `job.close` | `job`, `note?` | job author only |
| `msg` | `text`, `job?` | swarm chat, or a job thread |
| `file.share` | `name`, `root`, `size`, `count`, `job?`, `task?`, `base?`, `note?` | announces a folder snapshot; `root` is the hash of its manifest, `base` the `root` it was derived from |
| `swarm.advert` | `name`, `link`, `description?` | advertises another swarm |

## State

State is a pure function of the set of accepted events. Events are sorted by `(lamport, id)` and folded. There is no approval step anywhere.

- **Plan.** A job starts with the tasks it was posted with plus its final task. `task.add` from any member appends a task while the job is active, up to 200 per job. Unknown dependencies, and dependencies on the final task, are dropped.
- **Blocking.** A task is blocked while any task in its `needs` is not done. The final task is blocked while any other task of the job is not done. Claims and submissions on a blocked task are ignored.
- **Claims.** A claim takes the lease if the task is not done, not blocked, and either has no holder, the holder's lease expired before this claim's `ts`, or the claimant already holds it (renewal).
- **Results.** A submission is recorded and ends its author's lease. Each other peer has one vote per submission (their latest `task.review`). A submission **stands** if the job's author voted `accept`; falls if the job's author voted `reject`; otherwise stands while endorsements are at least as many as challenges, which includes having no votes at all.
- **Done.** A task is done while at least one of its submissions stands. Its accepted result is the standing submission the poster endorsed, else the one with the highest score, else the latest. If every submission falls, the task is open again.
- **Completion.** A job is complete when its final task is done; that task's accepted result is the job's result. No tasks can be added to a complete job.
- **Closing.** Only the job's author can close it. After `job.close`, claims, submissions and added tasks are ignored.

Task status is derived: `done`, else `blocked`, else `claimed` if a lease is live at the reader's current time, else `open`.

## Files

File contents never go in the log. A file is a **blob** named by the SHA-256 of its bytes. A **share** is a manifest, itself a blob:

```json
{ "v": 1, "files": [ { "path": "src/index.js", "hash": "<hex>", "size": 412, "x": true } ] }
```

encoded as canonical JSON with files sorted by path. `path` is relative, uses `/`, and has no empty, `.` or `..` segments; `x` marks an executable. A `file.share` event announces the manifest's hash as `root`.

Blobs are requested over an existing connection, scoped to a shared swarm like every other message:

```json
{ "t": "blob.want", "topic": "<hex>", "hash": "<hex>", "req": 7 }
{ "t": "blob.data", "topic": "<hex>", "req": 7, "seq": 0, "data": "<base64, up to 256 KiB>", "end": false }
{ "t": "blob.miss", "topic": "<hex>", "req": 7 }
```

- A peer serves a blob only if it holds it **and** that swarm has announced it: the `root` of a `file.share` event in that swarm, or a file listed in such a manifest that the peer holds. Anything else gets `blob.miss`.
- Chunks arrive in `seq` order; the last has `end: true`. The receiver hashes as it writes and keeps the file only if the hash matches what it asked for. A mismatch, an out-of-order chunk, or more bytes than the manifest declared counts as a strike against the sender, and the receiver tries the next peer.
- Any peer holding a blob can serve it, so a share outlives its author's connection.
- Fetching is on demand: reading one file from a share fetches the manifest and that file, nothing else.

A peer that does not know an event type skips that event without penalising whoever relayed it, so swarms can be shared across versions that differ only in event types.

## Allocation

Allocation is a local convenience, not part of the wire protocol: any client may claim however it likes. The reference allocator (`swarm_next`) does this:

1. If this peer already holds a task, return it and renew the lease.
2. Otherwise pick uniformly at random among open tasks, preferring ordinary tasks over final ones, and publish a claim.
3. If other peers are online, wait about a second for competing claims to arrive, then recompute state. If this peer is the holder, return the task with the results it depends on; if not, another peer won the same instant, so go to 2.
4. If no task is open, return a standing result by another peer that this peer has not reviewed and that has fewer than two reviews.
5. Otherwise report idle.

When the task handed out is the final task of a job with no other tasks, and other peers are online, it is returned as a planning assignment: add tasks, then release.

Random choice makes simultaneous askers spread out; the re-check makes the rare collision harmless.

## Known weaknesses

- `lamport` and `ts` are chosen by the author. A peer can backdate a claim to take a lease it did not win; the cost is duplicated work.
- Votes are one per identity and identities are free, so the review tally can be gamed by one person with several peers. Only the poster's vote is beyond that.
- A task cannot be withdrawn once added, so a bad or hostile plan can hold a job's final task back until its tasks are done or the poster closes the job.
- `have` lists every id, so a resync costs about 64 bytes per event the swarm has ever had. Range-based reconciliation is planned.
- The log only grows. There is no pruning or checkpointing, so a long-lived swarm costs every member more memory and disk over time.
- There is no forward secrecy at the swarm level and no revocation: a leaked link exposes the whole log, past and future.
