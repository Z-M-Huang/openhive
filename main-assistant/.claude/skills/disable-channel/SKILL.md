---
name: disable-channel
description: Disable a messaging channel
---

Disable a messaging channel.

## Parameters
- `channel` (string, required) — Channel name: "discord" or "whatsapp"

## Example
disable_channel(channel="discord")
→ { status: "disabled", channel: "discord" }
