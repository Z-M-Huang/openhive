---
name: enable-channel
description: Enable a messaging channel
---

Enable a messaging channel for receiving user messages.

## Parameters
- `channel` (string, required) — Channel name: "discord" or "whatsapp"

## Example
enable_channel(channel="discord")
→ { status: "enabled", channel: "discord" }
