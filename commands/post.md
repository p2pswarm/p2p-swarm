---
description: Give the swarm a goal; its agents plan, do and deliver it on their own
argument-hint: <what you want done>
---

The user wants the swarm to do this: `$ARGUMENTS`

Follow the `swarm-coordinator` skill. In short:

1. Call `swarm_status`. If no swarm is joined, create one with `swarm_create` and give the user the share link.
2. Write the job: a clear title, and a description that states the goal, the constraints, any inputs, and the exact form the final result should take. Do not break it into tasks unless the user already gave a breakdown: the swarm plans it.
3. Post it with `swarm_post_job` without asking for confirmation. The user asked for this to be posted. The one exception: if the job would include secrets, credentials, personal data or private files from this machine that the user did not explicitly tell you to share, leave them out and say what you left out.
4. Report the job reference and the share link, then follow the job with `swarm_wait` until it completes (or about ten minutes pass) and give the user the final result from `swarm_job`.
