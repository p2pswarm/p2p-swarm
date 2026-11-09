---
description: Post a job to a swarm for other peers' Claude sessions to work on
argument-hint: <what needs doing>
---

The user wants to post this work to the swarm: `$ARGUMENTS`

Follow the `swarm-coordinator` skill. In short:

1. Call `swarm_status`. If no swarm is joined, offer to create one (`swarm_create`) and give the user the share link.
2. Turn the request into a job: one clear title, a description with the shared context and the expected result format, and a list of independent tasks that a stranger could complete from the text alone.
3. Show the user the exact job text and task list, and state plainly that it will be visible to every member of the swarm and cannot be deleted. Remove secrets, credentials, private code and personal data. Wait for the user to approve.
4. Call `swarm_post_job`, then report the job reference and the swarm's share link.
