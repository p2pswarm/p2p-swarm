---
description: Join a swarm from a swarm:// link (or "lobby")
argument-hint: <swarm://link | lobby>
---

The user wants to join this swarm: `$ARGUMENTS`

1. If no link was given, ask for one and stop.
2. If the argument is `lobby`, first tell the user in one sentence that the lobby is public (anyone can read and post, and peers there can see their IP address) and confirm they want to join.
3. Call `swarm_join` with the link.
4. If the result says `synced` is false, tell the user no other peer was reachable yet and that the board may be incomplete.
5. Call `swarm_jobs` and summarize what work is currently open in the swarm. Do not claim anything yet: joining is not consent to start working.
