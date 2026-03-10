---
name: Task DAG — Dependencies & Retry Fields
id: task-dag
requires_rebuild: false
timeout: 300
---

## Overview

Tests task dependency graphs (`blocked_by`), retry field storage, and the `MAX_BLOCKED_BY=50` limit. Uses `dispatch_task` via chat and verifies via `GET /api/v1/tasks/:id`.

Key behavior: `dispatch_task` creates as `pending`. If `blocked_by` is empty, the task is dispatched to the container and promoted to `running`. If `blocked_by` is non-empty, the task stays `pending` until all blockers complete — the orchestrator auto-dispatches when `blocked_by` clears.

## Setup

None.

## Tests

### 1. Dispatch with Retry Fields

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use dispatch_task to create a task for aid-main-001 with prompt \"DAG smoke: blocker task A\" and max_retries=2. Report the task_id."}'
```

Save the returned task ID as `TASK_A_ID`.

**Verify via REST:**
```bash
curl -s "http://localhost:8080/api/v1/tasks/${TASK_A_ID}" | python3 -c "
import sys, json
t = json.load(sys.stdin)['data']
print(f'Task: {t[\"id\"]}')
print(f'  status: {t[\"status\"]}')
print(f'  retry_count: {t.get(\"retry_count\", \"MISSING\")}')
print(f'  max_retries: {t.get(\"max_retries\", \"MISSING\")}')
print(f'  blocked_by: {t.get(\"blocked_by\", \"MISSING\")}')
"
```

**Expected:**
- `status`: `running` (promoted immediately)
- `retry_count`: `0`
- `max_retries`: `2`
- `blocked_by`: `[]`

### 2. Dispatch with blocked_by

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use dispatch_task to create a task for aid-main-001 with prompt \"DAG smoke: dependent task B\" and blocked_by set to the task ID from task A (the one with prompt containing \"blocker task A\"). Report the task_id and confirm blocked_by is set."}'
```

Save the returned task ID as `TASK_B_ID`.

**Verify via REST:**
```bash
curl -s "http://localhost:8080/api/v1/tasks/${TASK_B_ID}" | python3 -c "
import sys, json
t = json.load(sys.stdin)['data']
blocked = t.get('blocked_by', [])
print(f'Task B: {t[\"id\"][:12]}...')
print(f'  status: {t[\"status\"]}')
print(f'  blocked_by: {blocked}')
print(f'  PASS' if len(blocked) > 0 else '  FAIL: no blocked_by')
"
```

**Expected:**
- `blocked_by` contains Task A's ID
- `status`: `pending` (task stays pending until all blockers complete)

### 3. blocked_by Limit Exceeded (MAX_BLOCKED_BY=50)

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Try to use dispatch_task for aid-main-001 with prompt \"limit test\" and blocked_by containing 51 fake UUIDs (like 00000000-0000-0000-0000-000000000001 through 00000000-0000-0000-0000-000000000051). Report any error about exceeding the limit."}'
```

**Expected:**
- Error about exceeding the maximum 50 dependencies limit (`VALIDATION_ERROR` on `blocked_by`)

## Teardown

None — tasks will complete or time out on their own.
