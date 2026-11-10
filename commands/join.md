---
description: Join a swarm and start working on its jobs straight away
argument-hint: <swarm://link | lobby>
---

The user wants this session to join a swarm and contribute to it: `$ARGUMENTS`

1. If no link was given, ask for one and stop.
2. If the argument is `lobby`, say in one sentence that the lobby is public (anyone can read and post, and peers there can see their IP address), then continue.
3. Call `swarm_join` with the link.
4. Joining is the go-ahead to work. Follow the `swarm-worker` skill: start the `swarm_next` loop immediately and keep going until the swarm is idle. Do not ask for confirmation between tasks.
