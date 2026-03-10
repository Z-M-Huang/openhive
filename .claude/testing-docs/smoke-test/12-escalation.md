---
name: Escalation — Error Path
id: escalation
requires_rebuild: false
timeout: 300
---

## Overview

Tests the `escalate` SDK tool. The main assistant (`aid-main-001`) has NO supervisor in the org chart — `getSupervisor()` returns `null`. Escalation WILL fail with a clear error. This tests the error path.

The EscalationRouter throws BEFORE marking the task as `escalated` when no supervisor exists, so the task status stays unchanged.

## Setup

None.

## Tests

### 1. Escalate Tool — No Supervisor Error

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use dispatch_task for aid-main-001 with prompt \"Escalation test task\". Then use the escalate tool on that task with reason \"Testing escalation flow\" and context \"smoke test\". Report the correlation_id and any errors."}'
```

**Expected:**
- The `escalate` tool returns an error about "no supervisor found for agent aid-main-001"
- This is the correct behavior — the main assistant has no supervisor

Save the task ID from dispatch_task as `TASK_ID` for test 2. The executor must extract this from the response.

### 2. Verify Task Status Unchanged

**NOTE:** The executor must inject `TASK_ID` from test 1's response.

**Run:**
```bash
curl -s "http://localhost:8080/api/v1/tasks/${TASK_ID}" | python3 -c "
import sys, json
t = json.load(sys.stdin)['data']
print(f'Task: {t[\"id\"][:12]}... status={t[\"status\"]}')
# Escalation failed before marking, so status should be running or completed
print('PASS' if t['status'] in ('running', 'completed') else f'UNEXPECTED: {t[\"status\"]}')
"
```

**Expected:**
- Task status is `running` or `completed` (NOT `escalated`)
- EscalationRouter throws before `taskStore.update({ status: 'escalated' })` when no supervisor exists

### 3. Escalation Activity in Logs

**Run:**
```bash
curl -s "http://localhost:8080/api/v1/logs?limit=30" | python3 -c "
import sys, json
data = json.load(sys.stdin)
logs = data.get('logs', data if isinstance(data, list) else [])
esc = [l for l in logs if 'escalat' in l.get('message', '').lower() or 'escalat' in str(l.get('action', '')).lower()]
print(f'Escalation logs: {len(esc)}')
for l in esc[:5]:
    print(f'  [{l.get(\"level\",\"\")}] {l.get(\"component\",\"\")}/{l.get(\"action\",\"\")}: {l.get(\"message\",\"\")[:80]}')
if esc:
    print('PASS: escalation activity logged')
else:
    print('INFO: no escalation logs (expected if escalation failed at SDK tool level before reaching router)')
"
```

**Expected:**
- Escalation-related log entries may or may not appear (depends on whether the error is caught at the SDK tool level or the router level)

## Teardown

None.
