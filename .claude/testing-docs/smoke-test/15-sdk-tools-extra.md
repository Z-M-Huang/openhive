---
name: SDK Tools — Extended Coverage
id: sdk-tools-extra
requires_rebuild: false
timeout: 600
---

## Overview

Tests SDK custom tools not covered by other scenarios: `delete_agent`, `update_team`, `get_member_status`, `dispatch_task_and_wait`, `get_task_status`, `get_system_status`, `list_channels`. These are invoked via `POST /api/v1/chat`.

**IMPORTANT:** Each `POST /api/v1/chat` gets a fresh JID — no session persistence. The test executor must extract IDs from responses and inject into subsequent prompts.

## Setup

Clean up any leftover test team:
```bash
curl -s -X DELETE http://localhost:8080/api/v1/teams/smoke-extra 2>/dev/null || true
```

## Tests

### 1. get_system_status

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use your get_system_status tool and report what it returns. Include uptime, active teams, and running tasks if available."}'
```

**Expected:**
- Response mentions system status information (uptime, team count, or similar)
- Tool was invoked successfully (no error about unknown tool)

### 2. list_channels

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use your list_channels tool and report all configured channels with their enabled/disabled status."}'
```

**Expected:**
- Response lists channels (at minimum the API channel)
- Each channel has an enabled/disabled status

### 3. Create Agent + Team for Subsequent Tests

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use create_agent with name extra-bot and description \"Extended SDK test agent\". Then use create_team with slug smoke-extra using that agent as leader_aid. Report the agent AID and team details."}'
```

**Expected:**
- Agent AID returned (save as `AGENT_AID`)
- Team `smoke-extra` created

**Verify:**
```bash
curl -s http://localhost:8080/api/v1/teams/smoke-extra | python3 -c "
import sys, json
d = json.load(sys.stdin)['data']
print(f'PASS: team exists' if d.get('slug') == 'smoke-extra' else 'FAIL: team not found')
print(f'leader_aid: {d.get(\"leader_aid\",\"\")}')
"
```

### 4. get_member_status

**NOTE:** The executor must inject the `AGENT_AID` from test 3.

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use get_member_status with aid ${AGENT_AID}. Report the agent status details including name, role, and current state."}'
```

**Expected:**
- Response includes agent status detail for the specific AID
- Mentions the agent's name (`extra-bot`) and current state

### 5. update_team

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use update_team for smoke-extra to set env_vars with field \"env_vars\" and value {\"SMOKE_TEST\": \"true\"}. Report the result."}'
```

**Expected:**
- Team updated successfully
- No errors

**Verify via REST:**
```bash
curl -s http://localhost:8080/api/v1/teams/smoke-extra | python3 -c "
import sys, json
d = json.load(sys.stdin)['data']
print(f'slug: {d.get(\"slug\")}')
env = d.get('env_vars', {})
print(f'env_vars: {env}')
print(f'PASS' if env.get('SMOKE_TEST') == 'true' else 'FAIL: env_vars not set')
"
```

### 6. dispatch_task_and_wait

**Run:**
```bash
curl -s -m 180 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use dispatch_task_and_wait for aid-main-001 with prompt \"Say hello world\". This tool should wait for the task to complete and return the result. Report the task_id and final status."}'
```

**Expected:**
- Response includes a task_id and indicates the task completed
- `dispatch_task_and_wait` blocks until task finishes (unlike `dispatch_task` which returns immediately)

### 7. get_task_status (SDK tool)

**NOTE:** The executor must inject a task ID from test 6's response.

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use get_task_status with task_id ${TASK_ID}. Report the status, agent_aid, and any result."}'
```

**Expected:**
- Response includes task status (`completed` expected), agent_aid, and possibly a result summary

### 8. update_config (SDK tool)

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use your update_config tool to set the system log_level to \"info\". Then use get_config to verify it changed. Report both results. Finally, set it back to \"debug\"."}'
```

**Expected:**
- Config updated successfully via SDK tool (not REST)
- get_config confirms log_level changed to "info"
- Restored back to "debug"

### 9. delete_agent

**NOTE:** The executor must inject the `AGENT_AID` from test 3.

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use delete_agent to delete the agent with AID ${AGENT_AID}. Report the result."}'
```

**Expected:**
- Agent deleted successfully
- Note: this may fail if the agent is the team leader — in that case, record the error message (expected constraint)

### 10. Cleanup — Delete Team

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use delete_team to delete smoke-extra. Confirm deletion."}'
```

**Verify:**
```bash
curl -s http://localhost:8080/api/v1/teams/smoke-extra | python3 -c "
import sys, json; d = json.load(sys.stdin)
print('PASS: deleted' if 'error' in d else 'FAIL: still exists')
"
```

**Expected:**
- Team deleted, returns 404

## Teardown

```bash
curl -s -X DELETE http://localhost:8080/api/v1/teams/smoke-extra 2>/dev/null || true
```
