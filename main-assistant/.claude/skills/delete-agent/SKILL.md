---
name: delete-agent
description: Delete an agent by AID + team_slug
---

Delete an agent from a team. Fails if the agent leads a team.

## Parameters
- `aid` (string, required) — Agent AID to delete
- `team_slug` (string, required) — Team slug where agent resides ("master" for top-level)

## Example
delete_agent(aid="aid-weatherbot-abc12345", team_slug="master")
→ { status: "deleted", aid: "aid-weatherbot-abc12345" }

## Notes
- If the agent leads a team, you must delete that team first
