---
name: load-skill
description: Load a skill for use
---

Load a skill definition from a team workspace. Returns the skill content
including frontmatter and body.

## Parameters
- `skill_name` (string, required) — Skill name (matches directory name)
- `team_slug` (string, required) — Team slug whose workspace contains the skill

## Example
load_skill(skill_name="web-search", team_slug="weather")
→ { name: "web-search", description: "...", body: "..." }
