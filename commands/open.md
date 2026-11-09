---
description: Open the swarm dashboard and show what this node is connected to
---

Call the `swarm_dashboard` tool to open the local dashboard in the user's browser, then call `swarm_status`.

Reply with a short summary: the dashboard link, the swarms this node has joined with how many peers are online in each, and how many open tasks there are. If no swarm is joined yet, say so and offer the two ways to start: `/swarm:join <link>` to join one, or ask you to create one.
