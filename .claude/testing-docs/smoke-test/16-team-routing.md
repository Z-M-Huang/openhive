---
name: Team Routing and Scope Evolution
id: team-routing
requires_rebuild: false
timeout: 900
---

## Overview

Tests the team routing and scope evolution flow (Architecture Decision 77): the main assistant should check existing teams before creating new ones, and when extending a team's scope, the team lead autonomously creates new agents and updates its own definition + CLAUDE.md.

This scenario creates a weather team, then tests routing in two phases: first a **natural user request** (no hints) to verify the assistant discovers existing teams and recognizes scope overlap, then a **user confirmation** to trigger scope extension. This mirrors the real AD-77 flow: detect → ask → act.

**IMPORTANT:** Each `POST /api/v1/chat` gets a fresh JID — no session persistence. The test executor must extract IDs from responses and inject into subsequent prompts.

## Setup

Clean up any leftover weather team:
```bash
curl -s -X DELETE http://localhost:8080/api/v1/teams/weather 2>/dev/null || true
sleep 3
docker rm -f openhive-weather 2>/dev/null || true
sleep 2

# Verify clean state
curl -s http://localhost:8080/api/v1/teams/weather | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert 'error' in d, f'SETUP FAIL: weather team still exists: {d}'
print('Setup OK: no weather team')
"
```

## Tests

### 1. Create Initial Weather Team

Create a weather team with a coordinator-style lead and a purpose. This mirrors scenario 06 test 1.

**Run:**
```bash
curl -s -m 180 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Create a weather team. Use create_agent to create an agent named WeatherBot with description \"Coordinates weather data retrieval tasks by delegating to specialized worker agents\" and team_slug master. Then use create_team with slug weather, that agent as leader_aid, and purpose \"Fetch current weather data for any city using web search. Create at least one worker agent to handle weather queries.\". Report the agent AID, team slug, members list, and team status."}'
```

**Expected:**
- Team `weather` created with status `"operational"`
- At least 1 worker agent created by the lead
- Save the leader AID as `LEADER_AID`

**Verify:**
```bash
curl -s http://localhost:8080/api/v1/teams/weather | python3 -c "
import sys, json
d = json.load(sys.stdin)['data']
leader = d.get('leader_aid', '')
members = d.get('members', [])
status = d.get('status', '')
print(f'slug: {d.get(\"slug\")}')
print(f'leader: {leader}')
print(f'members: {members}')
print(f'status: {status}')
print(f'PASS: team created' if d.get('slug') == 'weather' and len(members) >= 1 and status == 'operational' else 'FAIL')
"
```

### 2. Capture Baseline Agent Count

Record how many agents exist in the weather team before the scope expansion.

**Run:**
```bash
docker compose -f deployments/docker-compose.yml exec openhive sh -c "
  ls /app/workspace/teams/weather/.claude/agents/*.md 2>/dev/null | wc -l
" | python3 -c "
import sys
count = int(sys.stdin.read().strip())
print(f'Baseline agent count: {count}')
print(f'PASS: has agents' if count >= 1 else 'FAIL: no agents')
"
```

**Expected:**
- At least 1 agent definition file (the worker created during team setup)
- Save count as `BASELINE_AGENT_COUNT`

### 3. Capture Baseline Lead Definition

Save the lead's current definition content for later comparison.

**Run:**
```bash
docker compose -f deployments/docker-compose.yml exec openhive sh -c "
  cat /app/workspace/teams/weather/CLAUDE.md
" | python3 -c "
import sys
content = sys.stdin.read()
print(f'CLAUDE.md length: {len(content)} chars')
# Check it does NOT mention irrigation yet
has_irrigation = 'irrigation' in content.lower()
print(f'PASS: no irrigation reference yet' if not has_irrigation else 'INFO: irrigation already mentioned')
"
```

**Expected:**
- CLAUDE.md exists and does NOT mention irrigation (baseline state)

### 4a. Natural Routing Request — Ambiguous Overlap

Send a **natural user request** about irrigation without any hints about the weather team. The main assistant should autonomously discover the weather team via `list_teams`/`get_team`, recognize the scope overlap, and decide how to handle it. Per AD-77, ambiguous fit should prompt for user confirmation.

**Run:**
```bash
curl -s -m 180 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Should I turn on my irrigation system in Miami today?"}'
```

**Expected (either outcome is valid):**
- **Path A (asks user):** Response mentions the weather team and asks whether to extend it or create a new team for irrigation — this is the AD-77 ambiguous-fit behavior
- **Path B (auto-routes):** Response routes to the weather team directly because irrigation is weather-adjacent

**Verify routing check happened (either path):**
```bash
curl -s "http://localhost:8080/api/v1/logs?limit=50" | python3 -c "
import sys, json
data = json.load(sys.stdin)
logs = data.get('logs', data if isinstance(data, list) else [])

# Check if list_teams or get_team was called during this request
routing_checks = [l for l in logs if
    'list_teams' in str(l.get('action', '')).lower() or
    'get_team' in str(l.get('action', '')).lower() or
    'list_teams' in str(l.get('message', '')).lower() or
    'get_team' in str(l.get('message', '')).lower()]

print(f'Routing check log entries: {len(routing_checks)}')
for l in routing_checks[:3]:
    print(f'  [{l.get(\"level\",\"\")}] {l.get(\"component\",\"\")}/{l.get(\"action\",\"\")}: {l.get(\"message\",\"\")[:80]}')
print(f'PASS: routing check detected' if routing_checks else 'INFO: no explicit routing logs (assistant may use tools internally)')
"
```

**Also verify no new irrigation team was created:**
```bash
curl -s http://localhost:8080/api/v1/teams | python3 -c "
import sys, json
data = json.load(sys.stdin)['data']
teams = data.get('teams', data if isinstance(data, list) else [])
slugs = [t.get('slug', '') for t in teams]
print(f'Teams after 4a: {slugs}')
irrigation_team = [s for s in slugs if 'irrigat' in s.lower()]
print(f'PASS: no irrigation team created' if not irrigation_team else f'FAIL: irrigation team exists: {irrigation_team}')
"
```

### 4b. User Confirms Extension

Simulates the user's confirmation to extend the weather team. This is a fresh stateless request that explicitly confirms the routing decision (as a user would in a real multi-turn conversation).

**Run:**
```bash
curl -s -m 180 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Extend the weather team to also handle irrigation recommendations. Have the weather team lead add an irrigation advisor agent, then answer: should I turn on my irrigation system in Miami today given current weather?"}'
```

**Expected:**
- Weather team lead creates a new irrigation agent
- Team lead updates its own definition and the team CLAUDE.md
- Response includes an irrigation recommendation based on weather data
- No new team created (still just `weather`)

### 5. Verify No New Team Created

**Run:**
```bash
curl -s http://localhost:8080/api/v1/teams | python3 -c "
import sys, json
data = json.load(sys.stdin)['data']
teams = data.get('teams', data if isinstance(data, list) else [])
slugs = [t.get('slug', '') for t in teams]
print(f'Teams: {slugs}')
irrigation_team = [s for s in slugs if 'irrigat' in s.lower()]
print(f'PASS: no irrigation team created' if not irrigation_team else f'FAIL: irrigation team exists: {irrigation_team}')
print(f'PASS: weather team exists' if 'weather' in slugs else 'FAIL: weather team missing')
"
```

**Expected:**
- No team with "irrigation" in the slug
- Weather team still exists

### 6. Verify New Agent Added to Weather Team

**Run:**
```bash
docker compose -f deployments/docker-compose.yml exec openhive sh -c "
  echo '=== Agent files ==='
  ls -la /app/workspace/teams/weather/.claude/agents/ 2>/dev/null

  echo '=== File count ==='
  ls /app/workspace/teams/weather/.claude/agents/*.md 2>/dev/null | wc -l

  echo '=== Agent content ==='
  for f in /app/workspace/teams/weather/.claude/agents/*.md; do
    echo \"--- \$f ---\"
    head -10 \"\$f\" 2>/dev/null
    echo
  done
" | python3 -c "
import sys, re
content = sys.stdin.read()
print(content[:1000])

file_paths = re.findall(r'--- (.+\.md) ---', content)
baseline = int('${BASELINE_AGENT_COUNT}')
current = len(file_paths)

checks = []
checks.append(('agent count increased', current > baseline))
checks.append(('irrigation-related agent exists', any('irrigat' in content.lower().split(f'--- {p} ---')[0] if f'--- {p} ---' in content else False for p in file_paths) or 'irrigat' in content.lower()))

for name, ok in checks:
    print(f'  {\"PASS\" if ok else \"FAIL\"}: {name}')
print(f'Baseline: {baseline}, Current: {current}')
print(f'Agent files: {file_paths}')
"
```

**Expected:**
- Agent count increased from baseline (new irrigation-related agent added)
- At least one agent definition mentions irrigation

### 7. Verify CLAUDE.md Updated with New Scope

**Run:**
```bash
docker compose -f deployments/docker-compose.yml exec openhive sh -c "
  cat /app/workspace/teams/weather/CLAUDE.md
" | python3 -c "
import sys
content = sys.stdin.read()
checks = []
checks.append(('mentions irrigation', 'irrigat' in content.lower()))
checks.append(('mentions weather', 'weather' in content.lower()))
checks.append(('has delegation instructions', 'delegate' in content.lower() or 'dispatch' in content.lower()))
checks.append(('non-trivial length', len(content) > 200))

for name, ok in checks:
    print(f'  {\"PASS\" if ok else \"FAIL\"}: {name}')
print(f'Content length: {len(content)} chars')
"
```

**Expected:**
- CLAUDE.md now mentions irrigation (scope expanded)
- Still mentions weather (original scope preserved)
- Has delegation instructions covering both capabilities

### 8. Verify Team Members via REST

**Run:**
```bash
curl -s http://localhost:8080/api/v1/teams/weather | python3 -c "
import sys, json
d = json.load(sys.stdin)['data']
leader = d.get('leader_aid', '')
members = d.get('members', [])
workers = [m for m in members if m != leader]

print(f'Leader: {leader}')
print(f'Total members: {len(members)}')
print(f'Workers: {workers}')

baseline = int('${BASELINE_AGENT_COUNT}')
print(f'PASS: more workers than baseline' if len(workers) > baseline else f'INFO: worker count {len(workers)} vs baseline {baseline}')
"
```

**Expected:**
- Members list includes the new irrigation agent
- Worker count is higher than baseline

### 9. Verify Delegation Chain for Irrigation Task

**NOTE:** The executor must inject `LEADER_AID` from test 1.

**Run:**
```bash
curl -s "http://localhost:8080/api/v1/tasks?limit=50" | python3 -c "
import sys, json
data = json.load(sys.stdin)['data']
tasks = data.get('tasks', [])
leader_aid = '${LEADER_AID}'

# Find irrigation-related tasks
irrigation = [t for t in tasks if
    'irrigat' in str(t.get('prompt','')).lower() or
    'irrigat' in str(t.get('result','')).lower()]

print(f'Irrigation-related tasks: {len(irrigation)}')
for t in irrigation:
    print(f'  Task: {t[\"id\"][:12]}...')
    print(f'    status:    {t[\"status\"]}')
    print(f'    agent_aid: {t.get(\"agent_aid\", \"<none>\")}')
    print(f'    team_slug: {t.get(\"team_slug\", \"<none>\")}')
    print(f'    parent_id: {t.get(\"parent_task_id\", \"<none>\")}')
    print(f'    prompt:    {str(t.get(\"prompt\",\"\"))[:80]}')
    print()

if not irrigation:
    print('FAIL: no irrigation tasks found')
else:
    # Check delegation
    worker_tasks = [t for t in irrigation if t.get('agent_aid') and t.get('agent_aid') != leader_aid]
    subtasks = [t for t in irrigation if t.get('parent_task_id')]

    checks = []
    checks.append(('routed to weather team', any(t.get('team_slug') == 'weather' for t in irrigation)))
    checks.append(('worker handled it (not leader)', len(worker_tasks) >= 1))
    checks.append(('subtask chain exists', len(subtasks) >= 1))

    for name, ok in checks:
        print(f'  {\"PASS\" if ok else \"FAIL\"}: {name}')
"
```

**Expected:**
- Irrigation task was routed to `weather` team (not a new team)
- A worker agent handled the task (not the leader)
- Subtask chain exists (parent_task_id set)

### 10. Cleanup — Delete Weather Team

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Use delete_team to delete the weather team. Confirm deletion."}'
```

Wait for container to stop:
```bash
sleep 5
```

**Verify:**
```bash
curl -s http://localhost:8080/api/v1/teams/weather | python3 -c "
import sys, json; d = json.load(sys.stdin)
print('PASS: team deleted (404)' if 'error' in d else 'FAIL: team still exists')
"

docker ps --filter "name=openhive-weather" --format "{{.Names}}" 2>/dev/null | python3 -c "
import sys
names = sys.stdin.read().strip()
print('PASS: container stopped' if not names else f'FAIL: container still running: {names}')
"
```

**Expected:**
- Team returns 404
- Container stopped

## Teardown

```bash
curl -s -X DELETE http://localhost:8080/api/v1/teams/weather 2>/dev/null || true
docker rm -f openhive-weather 2>/dev/null || true
```
