---
description: Pick up open tasks from the swarm and work on them
argument-hint: [swarm name] [max tasks]
---

The user wants this session to contribute work to the swarm. Arguments: `$ARGUMENTS`

Follow the `swarm-worker` skill exactly. It defines the loop (find a task, claim it, do it in a scratch directory, submit, repeat) and the safety rules that apply to work posted by strangers. Work on at most 3 tasks unless the user gave a different number, then stop and summarize what you submitted.
