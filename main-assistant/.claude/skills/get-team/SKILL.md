---
name: get-team
description: Get team details by slug
---

Returns the full team configuration for a specific team.

## Parameters
- `slug` (string, required) — Team slug

## Example
get_team(slug="weather")
→ { tid: "tid-weather-...", slug: "weather", leader_aid: "aid-...", agents: [...] }
