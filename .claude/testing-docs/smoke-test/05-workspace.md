---
name: Workspace Scaffolding
id: workspace
requires_rebuild: false
timeout: 300
---

## Overview

Verifies workspace directory structure is correctly scaffolded on team creation (both REST and SDK paths) and cleaned up on deletion.

## Setup

Clean up any leftover test team:
```bash
curl -s -X DELETE http://localhost:8080/api/v1/teams/smoke-ws-team 2>/dev/null || true
```

## Tests

### 1. Main Workspace Structure

**Run:**
```bash
docker compose -f deployments/docker-compose.yml exec openhive sh -c "
  ls -la /app/workspace/.claude/ 2>/dev/null && echo '---STRUCTURE---'
  test -f /app/workspace/CLAUDE.md && echo 'PASS: CLAUDE.md' || echo 'FAIL: CLAUDE.md'
  test -d /app/workspace/.claude/agents && echo 'PASS: agents/' || echo 'FAIL: agents/'
  test -d /app/workspace/.claude/skills && echo 'PASS: skills/' || echo 'FAIL: skills/'
  test -d /app/workspace/work/tasks && echo 'PASS: work/tasks/' || echo 'FAIL: work/tasks/'
  test -f /app/workspace/.claude/settings.json && echo 'PASS: settings.json' || echo 'FAIL: settings.json'
"
```

**Expected:**
- All five checks PASS

### 2. Workspace Scaffolded on REST Team Create

**Run:**
```bash
# Create team
curl -s -X POST http://localhost:8080/api/v1/teams \
  -H "Content-Type: application/json" \
  -d '{"slug":"smoke-ws-team","leader_aid":"aid-main-001"}'

# Verify workspace
docker compose -f deployments/docker-compose.yml exec openhive sh -c "
  TEAM=smoke-ws-team
  test -d /app/workspace/teams/\${TEAM}/.claude/agents && echo 'PASS: agents/' || echo 'FAIL: agents/'
  test -d /app/workspace/teams/\${TEAM}/.claude/skills && echo 'PASS: skills/' || echo 'FAIL: skills/'
  test -f /app/workspace/teams/\${TEAM}/CLAUDE.md && echo 'PASS: CLAUDE.md' || echo 'FAIL: CLAUDE.md'
  test -s /app/workspace/teams/\${TEAM}/CLAUDE.md && echo 'PASS: has content' || echo 'FAIL: empty'
  test -d /app/workspace/teams/\${TEAM}/work/tasks && echo 'PASS: work/tasks/' || echo 'FAIL: work/tasks/'
"
```

**Expected:**
- All five checks PASS

### 3. Workspace Removed on REST Team Delete

**Run:**
```bash
# Delete team
curl -s -X DELETE http://localhost:8080/api/v1/teams/smoke-ws-team

# Verify workspace gone
docker compose -f deployments/docker-compose.yml exec openhive \
  sh -c "test ! -d /app/workspace/teams/smoke-ws-team && echo 'PASS: removed' || echo 'FAIL: still exists'"
```

**Expected:**
- `PASS: removed`

### 4. Workspace Scaffolded on SDK Team Create

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use create_agent with name ws-bot and description \"workspace test agent\". Then use create_team with slug smoke-ws-team using that agent as leader. Report the result."}'
```

**Verify:**
```bash
docker compose -f deployments/docker-compose.yml exec openhive sh -c "
  TEAM=smoke-ws-team
  test -d /app/workspace/teams/\${TEAM}/.claude/agents && echo 'PASS: agents/' || echo 'FAIL: agents/'
  ls /app/workspace/teams/\${TEAM}/.claude/agents/*.md 2>/dev/null && echo 'PASS: agent file' || echo 'FAIL: no agent files'
"
```

**Expected:**
- agents/ directory exists
- At least one `.md` agent file present

### 5. Workspace Removed on SDK Team Delete

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use delete_team to delete smoke-ws-team."}'
```

**Verify:**
```bash
docker compose -f deployments/docker-compose.yml exec openhive \
  sh -c "test ! -d /app/workspace/teams/smoke-ws-team && echo 'PASS: removed' || echo 'FAIL: still exists'"
```

**Expected:**
- `PASS: removed`

## Teardown

```bash
curl -s -X DELETE http://localhost:8080/api/v1/teams/smoke-ws-team 2>/dev/null || true
```
