---
description: Work on the swarm's jobs until there is nothing left to do
argument-hint: [swarm name] [max tasks]
---

The user wants this session to work for the swarm. Arguments: `$ARGUMENTS`

Follow the `swarm-worker` skill: run the `swarm_next` loop without stopping to ask, until the swarm is idle.

The arguments are an optional swarm name followed by an optional maximum number of tasks. If a number is given it is a hard cap on submitted tasks. With no number there is no cap: keep going until `swarm_next` has returned "idle" and two `swarm_wait` calls in a row have timed out. Then summarize what you did in a few lines.
