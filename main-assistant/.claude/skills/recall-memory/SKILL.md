---
name: recall-memory
description: Search agent memories by keyword
---

Search the calling agent's memories by keyword query. Returns matching entries sorted by most recently updated. The `agent_aid` is injected from the authenticated context — do not pass it as an argument.

## Parameters
- `query` (string, required) — Search query (keyword-based substring match). Alias: `keyword`
- `limit` (number, optional) — Max results to return (default: 100)

## Returns
```json
[
  { "key": "user_preferences", "value": "Prefers dark mode", "updated_at": "2026-03-09T..." },
  { "key": "learned_patterns", "value": "...", "updated_at": "2026-03-08T..." }
]
```

## Example
recall_memory(query="preferences")
→ [{ key: "user_preferences", value: "Prefers dark mode and compact layout", updated_at: "2026-03-09T12:00:00.000Z" }]
