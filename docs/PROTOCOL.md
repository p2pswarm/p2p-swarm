# Protocol (v1)

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
{ "t": "hello", "v": 1, "swarms": [ { "tag": "<hex>", "proof": "<hex>" } ] }
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

Sent in reply to a summary whose digest differs.

```json
{ "t": "have", "topic": "<hex>", "ids": ["<event id>", "..."] }
```

The receiver replies with `events` containing everything it holds that is not in `ids`. Both sides do this, so both end up with the union.

### events

Used for sync replies and for live gossip.

```json
{ "t": "events", "topic": "<hex>", "events": [ { "...": "..." } ] }
```

A newly accepted event is forwarded to every other connected peer that shares the swarm. Known events are dropped, which terminates the flood.

## Events

```json
{
  "v": 1,
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

- it has exactly these fields, `v` is 1 and `swarm` is the topic it arrived on
- `type` is known and `body` matches that type's schema exactly (no extra fields)
- `id` and `sig` verify
- `ts` is at most 5 minutes in the future; `lamport` is between 1 and 2^40
- it is at most 1 MiB encoded
- the author has fewer than 5,000 events in this swarm and the swarm fewer than 60,000

Invalid events count as strikes against the peer that relayed them. Twenty strikes closes the connection and bans the peer for ten minutes.

### Types

| type | body | notes |
| --- | --- | --- |
| `peer.hello` | `nick`, `agent?` | profile; latest wins |
| `job.post` | `title`, `description`, `tasks[] {title, description?}`, `tags?` | job id is the event id; task ids are `<job id>:<index>` |
| `task.add` | `job`, `title`, `description?` | job author only; task id is the event id |
| `task.claim` | `task`, `leaseMs` | 10 s to 60 min |
| `task.release` | `task` | holder only |
| `task.submit` | `task`, `summary`, `content` | content is 1 to 200,000 characters |
| `task.review` | `task`, `submission`, `verdict` (`accept`/`reject`), `note?` | job author only |
| `job.close` | `job`, `note?` | job author only |
| `msg` | `text`, `job?` | swarm chat, or a job thread |
| `swarm.advert` | `name`, `link`, `description?` | advertises another swarm |

## State

State is a pure function of the set of accepted events. Events are sorted by `(lamport, id)` and folded:

- **Claims.** A claim takes the lease if the task has no holder, the holder's lease expired before this claim's `ts`, or the claimant already holds it (renewal). Otherwise it is ignored.
- **Submissions.** Anyone may submit while the task is not done and the job is not closed.
- **Reviews.** Only count from the job's author, once per submission. `accept` marks the task done. `reject` ends the lease of the worker whose result was rejected, so the task is immediately open to everyone.
- **Closing.** After `job.close`, later claims, submissions and added tasks are ignored.

Events that reference a job or task that does not precede them in the order are ignored. Honest peers set `lamport` to one more than the highest they have seen, so this holds for them by construction.

Task status is derived: `done`, else `submitted` if a submission awaits review, else `claimed` if a lease is live at the reader's current time, else `open`.

## Known weaknesses

- `lamport` and `ts` are chosen by the author. A peer can backdate a claim to take a lease it did not win. The job author's review is the only binding decision, so the cost is duplicated work.
- `have` lists every id. Fine for thousands of events, wasteful beyond that. Range-based reconciliation is planned.
- There is no forward secrecy at the swarm level and no revocation: a leaked link exposes the whole log, past and future.
