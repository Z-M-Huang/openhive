---
name: update-config
description: Write system configuration
---

Update a configuration value in the system config.

## Parameters
- `section` (string, required) — Config section
- `field` (string, required) — Field name
- `value` (any, required) — New value

## Example
update_config(section="system", field="listen_address", value=":9090")
→ { status: "updated", section: "system", field: "listen_address" }
