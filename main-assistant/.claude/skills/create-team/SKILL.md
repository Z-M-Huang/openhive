---
name: create-team
description: Create a team with a leader AID
---

Create a new team. The leader must already exist (use create_agent first).

## Parameters
- `slug` (string, required) — Lowercase, hyphens only. e.g. "weather"
- `leader_aid` (string, required) — AID from create_agent
- `parent_slug` (string, optional) — Parent team slug for nested teams

## Example
create_team(slug="weather", leader_aid="aid-weatherbot-abc12345")
→ { tid: "tid-weather-def67890", slug: "weather", status: "created" }

## Two-Step Pattern
1. create_agent → get AID
2. create_team with that AID → team created + container provisioned
