---
name: save-memory
description: Save a memory entry for the calling agent
---

Save a key-value memory entry for the calling agent. If a memory with the same key already exists for this agent, it is updated (upsert). The `agent_aid` is injected from the authenticated context — do not pass it as an argument.

## Parameters
- `key` (string, required) — Memory key (e.g. "user_preferences", "learned_patterns")
- `content` (string, required) — Memory content to save
- `memory_type` (string, optional) — "curated" or "daily" (default: "curated")

## Returns
```json
{ "memory_id": "uuid", "key": "user_preferences", "status": "created" }
```

`status` is either `"created"` (new entry) or `"updated"` (existing entry overwritten).

## Example
save_memory(key="user_preferences", content="Prefers dark mode and compact layout", memory_type="curated")
→ { memory_id: "550e8400-...", key: "user_preferences", status: "created" }
