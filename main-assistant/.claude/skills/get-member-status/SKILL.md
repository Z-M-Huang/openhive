---
name: get-member-status
description: Agent/member health status
---

Get the status of an agent or team from the org chart.

## Parameters
- `agent_aid` (string, optional) — Agent AID to query
- `team_slug` (string, optional) — Team slug to query

## Example
get_member_status(agent_aid="aid-weatherbot-abc12345")
→ { aid: "aid-weatherbot-...", name: "WeatherBot", status: "idle" }

## Notes
- Provide either agent_aid or team_slug (not both)
