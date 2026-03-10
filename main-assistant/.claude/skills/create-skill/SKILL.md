---
name: create-skill
description: Create a skill definition
---

Create a skill definition file in a team workspace.

## Parameters
- `name` (string, required) — Skill name (lowercase, hyphens allowed)
- `body` (string, required) — Skill body / system prompt addition
- `team_slug` (string, required) — Team slug ("master" for root)
- `description` (string, optional) — Human-readable description
- `argument_hint` (string, optional) — Hint for the skill argument
- `allowed_tools` (string[], optional) — List of allowed tool names

## Example
create_skill(name="web-search", body="Search the web for ...", team_slug="weather")
→ { name: "web-search", status: "created" }
