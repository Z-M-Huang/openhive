---
name: Environment & Infrastructure
id: environment
requires_rebuild: false
timeout: 300
---

## Overview

Verifies the container started correctly: health endpoint, DB, workspace scaffolding, and schema.

## Setup

None — runs against the fresh container from the orchestrator's Step 1.

## Tests

### 1. Health Endpoint

**Run:**
```bash
curl -s http://localhost:8080/api/v1/health
```

**Expected:**
- HTTP 200
- JSON body with `data.status` = `"ok"`

### 2. Health Details

**Run:**
```bash
curl -s http://localhost:8080/api/v1/health | python3 -c "
import sys, json
d = json.load(sys.stdin)['data']
print(f'Status: {d[\"status\"]}')
print(f'Uptime: {d[\"uptime\"]}')
print(f'Version: {d[\"version\"]}')
"
```

**Expected:**
- Status: `ok`
- Version present (e.g., `0.1.0`)

### 3. Container Logs Accessible

**Run:**
```bash
docker compose -f deployments/docker-compose.yml logs --tail 5
```

**Expected:**
- Recent log lines from the running container (non-empty output)

### 4. Main Workspace Scaffolded

**Run:**
```bash
docker compose -f deployments/docker-compose.yml exec openhive sh -c "
  test -f /app/workspace/CLAUDE.md && echo 'PASS: CLAUDE.md' || echo 'FAIL: CLAUDE.md'
  test -d /app/workspace/.claude/agents && echo 'PASS: .claude/agents/' || echo 'FAIL: .claude/agents/'
  test -d /app/workspace/.claude/skills && echo 'PASS: .claude/skills/' || echo 'FAIL: .claude/skills/'
  test -d /app/workspace/work/tasks && echo 'PASS: work/tasks/' || echo 'FAIL: work/tasks/'
"
```

**Expected:**
- All four checks PASS

### 5. SQLite DB Exists

**Run:**
```bash
docker compose -f deployments/docker-compose.yml exec openhive sh -c "
  test -f /app/workspace/openhive.db && echo 'PASS: exists' || echo 'FAIL: missing'
  test \$(stat -c%s /app/workspace/openhive.db 2>/dev/null || echo 0) -gt 0 && echo 'PASS: non-empty' || echo 'FAIL: empty'
"
```

**Expected:**
- DB file exists and is non-empty

### 6. DB Schema — New Tables & Columns

Verify tables and columns from recent implementations:

**Run:**
```bash
docker compose -f deployments/docker-compose.yml exec openhive sh -c "
  sqlite3 /app/workspace/openhive.db '.schema escalations' | grep -q 'correlation_id' && echo 'PASS: escalations.correlation_id' || echo 'FAIL: escalations'
  sqlite3 /app/workspace/openhive.db '.schema agent_memories' | grep -q 'team_slug' && echo 'PASS: agent_memories.team_slug' || echo 'FAIL: agent_memories.team_slug'
  sqlite3 /app/workspace/openhive.db '.schema agent_memories' | grep -q 'deleted_at' && echo 'PASS: agent_memories.deleted_at' || echo 'FAIL: agent_memories.deleted_at'
  sqlite3 /app/workspace/openhive.db '.schema triggers' | grep -q 'webhook_path' && echo 'PASS: triggers.webhook_path' || echo 'FAIL: triggers.webhook_path'
  sqlite3 /app/workspace/openhive.db '.schema tasks' | grep -q 'blocked_by' && echo 'PASS: tasks.blocked_by' || echo 'FAIL: tasks.blocked_by'
  sqlite3 /app/workspace/openhive.db '.schema tasks' | grep -q 'retry_count' && echo 'PASS: tasks.retry_count' || echo 'FAIL: tasks.retry_count'
  sqlite3 /app/workspace/openhive.db '.schema tasks' | grep -q 'max_retries' && echo 'PASS: tasks.max_retries' || echo 'FAIL: tasks.max_retries'
  sqlite3 /app/workspace/openhive.db '.schema tasks' | grep -q 'priority' && echo 'PASS: tasks.priority' || echo 'FAIL: tasks.priority'
"
```

**Expected:**
- All eight checks PASS

## Teardown

None.
