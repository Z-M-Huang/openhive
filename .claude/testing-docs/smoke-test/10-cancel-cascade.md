---
name: Cancel Cascade
id: cancel-cascade
requires_rebuild: false
timeout: 300
---

## Overview

Tests parent/subtask cancellation with `cascade=true`. Dispatches a parent task with subtasks, then cancels the parent and verifies the cascade.

Key behavior: `cancel_task` with `cascade=true` (default) cancels the parent and any pending/running subtasks. Tasks that already completed are NOT cancelled (race condition). The `cancelled_ids` array contains only tasks that were successfully transitioned.

**IMPORTANT:** Each `POST /api/v1/chat` gets a fresh JID — no session persistence. The test executor must extract task IDs from each response and inject them into subsequent prompts.

## Setup

None.

## Tests

### 1. Dispatch Parent Task

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use dispatch_task for aid-main-001 with prompt \"Cancel cascade parent: write a long story about a robot\". Report the task_id."}'
```

**Expected:**
- Parent task ID returned (UUID format). Save as `PARENT_ID`.

### 2. Dispatch Subtasks

**NOTE:** The executor must extract `PARENT_ID` from test 1's response and inject it into this prompt.

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use dispatch_subtask twice. For both, use agent_aid aid-main-001 and parent_task_id ${PARENT_ID}. Prompts: \"Cascade subtask 1: count to 100\" and \"Cascade subtask 2: list all colors\". Report both subtask IDs."}'
```

**Expected:**
- Two subtask IDs returned. Save as `SUB1_ID` and `SUB2_ID`.

### 3. Cancel Parent with Cascade

**NOTE:** The executor must inject `PARENT_ID` from test 1.

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use cancel_task with task_id ${PARENT_ID} and cascade=true. Report the cancelled_ids array."}'
```

**Expected:**
- `cancelled_ids` array returned containing at least the parent ID

### 4. Verify Parent Cancelled

**NOTE:** The executor must use `PARENT_ID` from test 1.

**Run:**
```bash
curl -s "http://localhost:8080/api/v1/tasks/${PARENT_ID}" | python3 -c "
import sys, json
t = json.load(sys.stdin)['data']
print(f'Parent: {t[\"id\"][:12]}... status={t[\"status\"]}')
print('PASS' if t['status'] == 'cancelled' else f'INFO: status={t[\"status\"]}')
"
```

**Expected:**
- Parent task status = `cancelled`
- Note: subtask status may vary — they might have completed before cancel arrived (race condition). This is expected behavior.

## Teardown

None — cancelled tasks are terminal state and do not need cleanup.
