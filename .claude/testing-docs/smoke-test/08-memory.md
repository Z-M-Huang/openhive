---
name: Agent Memory & Coordination Tools
id: memory
requires_rebuild: false
timeout: 600
---

## Overview

Tests `save_memory`, `recall_memory`, and `consolidate_results` SDK tools. These run against the main assistant directly — no team hierarchy needed.

Memory uses a file-oriented model: `save_memory(content, memory_type)` writes to either `MEMORY.md` (curated, overwrite) or a daily log (daily, append). No `key` parameter — the agent's curated memory is a single file rewritten each time.

## Setup

None.

## Tests

### 1. save_memory (Curated)

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use your save_memory tool with content \"User prefers dark mode and concise responses\" and memory_type \"curated\". Report the memory_id and status."}'
```

**Expected:**
- Response mentions `memory_id` (UUID) and `status: "created"`

### 2. recall_memory (Search)

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use your recall_memory tool with query \"dark mode\". Report what memories you found."}'
```

**Expected:**
- Returns the memory from test 1 mentioning "dark mode"

### 3. save_memory (Curated Overwrite)

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use save_memory with content \"User prefers light mode and detailed responses\" and memory_type \"curated\". This should overwrite the previous curated memory. Report the status."}'
```

**Expected:**
- Response indicates the curated memory was overwritten (MEMORY.md replaced)
- `memory_id` returned

### 4. save_memory (Daily Log)

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use save_memory with content \"Smoke test daily entry: tested memory tools\" and memory_type \"daily\". Report the result."}'
```

**Expected:**
- Entry appended to today's daily log file
- `memory_id` returned

### 5. recall_memory (Empty Result)

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use recall_memory with query \"xyzzy_nonexistent_term_42\". Report whether any memories were found."}'
```

**Expected:**
- No memories found (empty array)

### 6. consolidate_results (Known Task IDs)

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"First check what tasks exist using list_tasks. Then use consolidate_results with 2-3 of those task IDs. Report the status of each task in the result."}'
```

**Expected:**
- Response contains a `tasks` array with entries showing `task_id` and `status`

### 7. consolidate_results (Not Found)

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use consolidate_results with task_ids [\"00000000-0000-0000-0000-000000000000\"]. Report what status is returned for the non-existent task."}'
```

**Expected:**
- Response indicates `status: "not_found"` for the fake task ID

## Teardown

Clean up test memories by overwriting curated memory with minimal content:
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use save_memory with content \"\" and memory_type \"curated\" to clear the test memory."}' > /dev/null 2>&1 || true
```
