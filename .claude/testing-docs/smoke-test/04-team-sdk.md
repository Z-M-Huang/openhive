---
name: Team & Agent Management via SDK Tools
id: team-sdk
requires_rebuild: false
timeout: 600
---

## Overview

Tests SDK custom tools via the chat interface: `list_teams`, `get_config`, `create_agent`, `create_team`, `get_team_info`, `delete_team`, `delete_agent`, `create_skill`. These tools are invoked by asking the main assistant via `POST /api/v1/chat`.

## Setup

Clean up any leftover `smoke-sdk-team`:
```bash
curl -s -X DELETE http://localhost:8080/api/v1/teams/smoke-sdk-team 2>/dev/null || true
```

## Tests

### 1. list_teams

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use your list_teams tool to show me all teams. Report the result."}'
```

**Expected:**
- Response indicates tool was called
- Reports empty or lists any existing teams

### 2. get_config

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use your get_config tool to show me the current system configuration. What is the log level?"}'
```

**Expected:**
- Response mentions the current log level (e.g., "debug")

### 3. create_agent + create_team

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use create_agent to create an agent with name smoke-researcher and description \"Smoke test research agent\". Then use create_team with slug smoke-sdk-team using that agent as leader. Report the agent AID and team details."}'
```

**Expected:**
- Response contains an AID (`aid-smoke-researcher-...`)
- Team created with slug `smoke-sdk-team`

**Verify via REST:**
```bash
curl -s http://localhost:8080/api/v1/teams/smoke-sdk-team
```
Should return team with `leader_aid` matching the created agent.

### 4. get_team

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use get_team for team smoke-sdk-team. Report the slug, tid, leader_aid, and agents list."}'
```

**Expected:**
- Response includes slug, tid, leader_aid for `smoke-sdk-team`

### 5. create_skill

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use create_skill to create a skill named test-skill in team smoke-sdk-team with description \"A test skill for smoke testing\" and body \"This skill does nothing — it is a smoke test placeholder.\". Report the result."}'
```

**Expected:**
- Skill created successfully

**Verify file exists:**
```bash
docker compose -f deployments/docker-compose.yml exec openhive \
  test -f /app/workspace/teams/smoke-sdk-team/.claude/skills/test-skill/SKILL.md && \
  echo "PASS" || echo "FAIL"
```

### 6. delete_team

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use delete_team to delete smoke-sdk-team. Confirm it was deleted."}'
```

**Expected:**
- Response confirms deletion

**Verify via REST:**
```bash
curl -s http://localhost:8080/api/v1/teams/smoke-sdk-team
```
Should return `NOT_FOUND`.

## Teardown

```bash
curl -s -X DELETE http://localhost:8080/api/v1/teams/smoke-sdk-team 2>/dev/null || true
```
