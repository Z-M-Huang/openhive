---
name: get-config
description: Read system configuration
---

Get the current system configuration.

## Parameters
- `section` (string, optional) — Config section: "system", "assistant", or "channels"

## Example
get_config(section="system")
→ { listen_address: ":8080", ... }

## Notes
- If no section is specified, returns the full configuration
