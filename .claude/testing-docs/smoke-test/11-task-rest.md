---
name: Task REST API Endpoints
id: task-rest
requires_rebuild: false
timeout: 180
---

## Overview

Tests task-related REST endpoints: paginated list, status filter, task by ID, task cancel, and invalid parameter handling.

## Setup

Ensure at least one completed task exists for GET-by-ID testing:
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Reply with exactly: TASK_REST_SEED"}'
```

## Tests

### 1. List Tasks (Default — Running Only)

**Run:**
```bash
curl -s "http://localhost:8080/api/v1/tasks"
```

**Expected:**
- JSON with `data.tasks` array, `data.total`, `data.has_more`, `data.limit` (default 50), `data.offset` (default 0)
- Note: without `?status=`, returns only `running` tasks

### 2. List Tasks with Status Filter

**Run:**
```bash
curl -s "http://localhost:8080/api/v1/tasks?status=completed&limit=5"
curl -s "http://localhost:8080/api/v1/tasks?status=cancelled&limit=5"
```

**Expected:**
- Both return valid paginated JSON
- Completed tasks from chat interactions may appear
- Cancelled tasks from cancel-cascade scenario may appear

### 3. List Tasks with Pagination

**Run:**
```bash
curl -s "http://localhost:8080/api/v1/tasks?limit=2&offset=0"
```

**Expected:**
- `data.limit` = 2, `data.offset` = 0
- If more than 2 tasks exist, `data.has_more` = true

### 4. Get Task by ID

Use a known task ID from prior scenarios (check `?status=completed&limit=1` first):

**Run:**
```bash
TASK_ID=$(curl -s "http://localhost:8080/api/v1/tasks?status=completed&limit=1" | python3 -c "
import sys, json
tasks = json.load(sys.stdin)['data']['tasks']
print(tasks[0]['id'] if tasks else '')
")

if [ -n "$TASK_ID" ]; then
  curl -s "http://localhost:8080/api/v1/tasks/${TASK_ID}" | python3 -c "
import sys, json
t = json.load(sys.stdin)['data']
print(f'Task: {t[\"id\"][:12]}... status={t[\"status\"]} team={t.get(\"team_slug\",\"\")}')
print(f'  Has subtasks field: {\"subtasks\" in t}')
"
else
  echo "SKIP: no completed tasks available"
fi
```

**Expected:**
- Task returned with all fields (id, status, team_slug, prompt, etc.)
- May include `subtasks` array (subtree)

### 5. Task Cancel via REST

**Run:**
```bash
# First dispatch a task via chat to get a task ID
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use dispatch_task for aid-main-001 with prompt \"REST cancel test: write a poem\". Report the task_id."}'
```

Extract the task ID, then cancel via REST:
```bash
curl -s -X POST "http://localhost:8080/api/v1/tasks/${TASK_ID}/cancel" \
  -H "Content-Type: application/json"
```

**Expected:**
- HTTP 200 with task in `cancelled` status
- Note: if the task completed before the cancel call arrived (race condition), it may return `completed` status instead — this is acceptable

### 6. Task Cancel — Wrong Content-Type

**Run:**
```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:8080/api/v1/tasks/00000000-0000-0000-0000-000000000000/cancel"
```

**Expected:**
- HTTP 415 (Content-Type must be application/json — CSRF protection)

### 7. Non-Existent Task

**Run:**
```bash
curl -s http://localhost:8080/api/v1/tasks/00000000-0000-0000-0000-000000000000
```

**Expected:**
- `NOT_FOUND` error

### 8. Invalid Query Params

**Run:**
```bash
curl -s -o /dev/null -w "%{http_code}" "http://localhost:8080/api/v1/tasks?limit=-1"
curl -s -o /dev/null -w "%{http_code}" "http://localhost:8080/api/v1/tasks?offset=abc"
```

**Expected:**
- Both return HTTP 400 (Fastify schema validation)

## Teardown

None.
