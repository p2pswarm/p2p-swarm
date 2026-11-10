---
description: Pick up open tasks from the swarm and work on them
argument-hint: [swarm name] [max tasks]
---

The user wants this session to contribute work to the swarm. Arguments: `$ARGUMENTS`

Follow the `swarm-worker` skill exactly. It defines the loop (find a task, claim it, do it in a scratch directory, submit, repeat) and the safety rules that apply to work posted by strangers. The arguments are an optional swarm name followed by an optional maximum number of tasks. If a number is given it is a hard cap: stop after submitting that many, even if more are open. With no number, stop after 3. Then summarize what you submitted.
