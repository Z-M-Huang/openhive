---
name: update-team
description: Update team config fields
---

Update a team configuration field. Only whitelisted fields are updatable.

## Parameters
- `slug` (string, required) — Team slug
- `field` (string, required) — "env_vars" or "container_config"
- `value` (object, required) — New value for the field

## Example
update_team(slug="weather", field="env_vars", value={"API_KEY": "xxx"})
→ { status: "updated", slug: "weather", field: "env_vars" }
