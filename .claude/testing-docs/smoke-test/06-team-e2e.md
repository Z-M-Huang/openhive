---
name: Team E2E — Full Dispatch Chain (Deep)
id: team-e2e
requires_rebuild: false
timeout: 900
---

## Overview

Full end-to-end test of the **team creation architectural contract**: the main assistant creates a coordinator-style team lead with a `purpose` parameter. The blocking `create_team` call dispatches the purpose to the lead, who autonomously creates worker agents. The test verifies the team returns `status: "operational"` with workers, then dispatches a real weather question and verifies the **delegation chain** (main → lead → worker via `dispatch_subtask`).

Also verifies: ALL scaffolded files at exact paths with correct content, full message flow through logs, task lifecycle, and clean teardown.

Team leader runs in the PARENT container (main). Workers run in the team container. The leader decides at runtime how many workers to create — the test does NOT hardcode worker count but asserts at least 1 worker exists.

## Setup

Clean up any leftover weather team and wait for container removal:
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

docker compose -f deployments/docker-compose.yml exec openhive \
  sh -c "test ! -d /app/workspace/teams/weather && echo 'Setup OK: no workspace' || echo 'SETUP WARN: workspace dir exists'"
```

## Tests

### 1. Create Weather Team via Chat

The prompt instructs the assistant to create a **coordinator-style** team lead (not a domain specialist). The `purpose` parameter tells the lead what agents to create. Per the wiki, `create_team` is **blocking** — it dispatches the purpose to the lead, the lead creates worker agents, and returns only when the team is "fully staffed and operational."

**Run:**
```bash
curl -s -m 180 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Create a weather team. Use create_agent to create an agent named WeatherBot with description \"Coordinates weather data retrieval tasks by delegating to specialized worker agents\" and team_slug master. Then use create_team with slug weather, that agent as leader_aid, and purpose \"Fetch current weather data for any city using web search. Create at least one worker agent to handle weather queries.\". Report the agent AID, team slug, members list, and team status."}'
```

**Expected:**
- Response contains an AID (`aid-weatherbot-...`) and team slug `weather`
- Response mentions `members` with at least one worker agent
- Response mentions status `"operational"` (team is fully staffed)
- Save the leader AID for later assertions (as `LEADER_AID`)

### 2. Verify Team via REST — Fields + Workers

**Run:**
```bash
curl -s http://localhost:8080/api/v1/teams/weather | python3 -c "
import sys, json
d = json.load(sys.stdin)['data']
leader = d.get('leader_aid', '')

checks = []
checks.append(('slug', d.get('slug') == 'weather'))
checks.append(('tid prefix', str(d.get('tid','')).startswith('tid-')))
checks.append(('leader_aid prefix', str(leader).startswith('aid-')))
checks.append(('leader_aid contains weatherbot', 'weatherbot' in str(leader).lower()))

# Members: must have at least 1 worker (agent != leader)
members = d.get('members', [])
worker_aids = [m for m in members if m != leader]
checks.append(('has members list', isinstance(members, list) and len(members) >= 1))
checks.append(('has at least 1 worker', len(worker_aids) >= 1))

# Status: must be operational (blocking create_team completed)
status = d.get('status', '')
checks.append(('status is operational', status == 'operational'))

for name, ok in checks:
    print(f'  {\"PASS\" if ok else \"FAIL\"}: {name}')

print(f'Full: slug={d.get(\"slug\")} tid={d.get(\"tid\")} leader={leader}')
print(f'Members ({len(members)}): {members}')
print(f'Workers ({len(worker_aids)}): {worker_aids}')
print(f'Status: {status}')
"
```

**Expected:**
- `slug` = `"weather"`, `tid` starts with `tid-`
- `leader_aid` starts with `aid-` and contains `weatherbot`
- `members` list has at least 1 worker AID (not the leader)
- `status` = `"operational"` (team lead finished creating workers)

### 3. Verify Workspace Directory Structure

**Run:**
```bash
docker compose -f deployments/docker-compose.yml exec openhive sh -c "
  TEAM=/app/workspace/teams/weather

  echo '=== Directory Structure ==='
  test -d \${TEAM} && echo 'PASS: teams/weather/' || echo 'FAIL: teams/weather/'
  test -d \${TEAM}/.claude/agents && echo 'PASS: .claude/agents/' || echo 'FAIL: .claude/agents/'
  test -d \${TEAM}/.claude/skills && echo 'PASS: .claude/skills/' || echo 'FAIL: .claude/skills/'
  test -d \${TEAM}/work/tasks && echo 'PASS: work/tasks/' || echo 'FAIL: work/tasks/'
  test -f \${TEAM}/CLAUDE.md && echo 'PASS: CLAUDE.md exists' || echo 'FAIL: CLAUDE.md'
  test -f \${TEAM}/.claude/settings.json && echo 'PASS: settings.json exists' || echo 'FAIL: settings.json'
"
```

**Expected:**
- All six directory/file checks PASS

### 4. Verify CLAUDE.md Content

**Run:**
```bash
docker compose -f deployments/docker-compose.yml exec openhive sh -c "
  cat /app/workspace/teams/weather/CLAUDE.md
" | python3 -c "
import sys
content = sys.stdin.read()
checks = []
checks.append(('has Weather title', '# Weather' in content))
checks.append(('has team leader section', 'Team Leader' in content or 'team leader' in content.lower()))
checks.append(('has delegation instructions', 'delegate' in content.lower() or 'dispatch' in content.lower()))
checks.append(('has team slug reference', 'weather' in content))
checks.append(('non-trivial length', len(content) > 100))
for name, ok in checks:
    print(f'  {\"PASS\" if ok else \"FAIL\"}: {name}')
print(f'Content length: {len(content)} chars')
"
```

**Expected:**
- Title contains `Weather` (auto-derived from slug)
- Contains team leader instructions and delegation guidance
- References team slug `weather`
- Non-trivial content (>100 chars)

### 5. Verify settings.json Content

**Run:**
```bash
docker compose -f deployments/docker-compose.yml exec openhive sh -c "
  cat /app/workspace/teams/weather/.claude/settings.json
" | python3 -c "
import sys, json
d = json.load(sys.stdin)
has_key = 'allowedTools' in d
is_list = isinstance(d.get('allowedTools'), list)
print(f'PASS: allowedTools key exists' if has_key else 'FAIL: missing allowedTools')
print(f'PASS: allowedTools is array' if is_list else 'FAIL: not array')
print(f'Content: {json.dumps(d)}')
"
```

**Expected:**
- `allowedTools` key exists and is an array (initially empty `[]`)

### 6. Verify Agent Definition Files (Leader + Workers)

The team lead creates worker agent definition files during the blocking `create_team` call. The workspace should contain at least one worker `.md` file in addition to any lead-related files.

**Run:**
```bash
docker compose -f deployments/docker-compose.yml exec openhive sh -c "
  echo '=== Agent files ==='
  ls -la /app/workspace/teams/weather/.claude/agents/ 2>/dev/null || echo 'NO FILES'

  echo '=== File count ==='
  FILE_COUNT=\$(ls /app/workspace/teams/weather/.claude/agents/*.md 2>/dev/null | wc -l)
  echo \"Agent definition files: \$FILE_COUNT\"

  echo '=== Agent content ==='
  for f in /app/workspace/teams/weather/.claude/agents/*.md; do
    echo \"--- \$f ---\"
    cat \"\$f\" 2>/dev/null
    echo
  done
" | python3 -c "
import sys
content = sys.stdin.read()
print(content[:800])

# Count .md files
import re
file_paths = re.findall(r'--- (.+\.md) ---', content)
sections = content.split('--- /app/workspace')

checks = []
checks.append(('has .md files', len(file_paths) >= 1 and 'NO FILES' not in content))
checks.append(('has at least 1 worker agent file', len(file_paths) >= 1))
checks.append(('has frontmatter delimiters', content.count('---') >= 4))  # 2 per file minimum
checks.append(('has name field', 'name:' in content.lower()))
checks.append(('has description field', 'description:' in content.lower()))
checks.append(('mentions weather', 'weather' in content.lower()))

for name, ok in checks:
    print(f'  {\"PASS\" if ok else \"FAIL\"}: {name}')
print(f'Agent files found: {file_paths}')
"
```

**Expected:**
- At least one `.md` file exists in `.claude/agents/` (worker agents created by the lead)
- Each file has YAML frontmatter with `---` delimiters
- Contains `name:` and `description:` fields
- Description mentions weather-related content

### 7. Verify Team Container Running

**Run:**
```bash
# Check Docker container
docker ps --filter "name=openhive-weather" --format "{{.Names}}: {{.Status}}" 2>/dev/null

# Check container connection in logs
docker compose -f deployments/docker-compose.yml logs --tail 50 2>&1 | python3 -c "
import sys
lines = sys.stdin.readlines()
connected = [l for l in lines if 'container' in l.lower() and ('connect' in l.lower() or 'provision' in l.lower() or 'weather' in l.lower())]
print(f'Container activity lines: {len(connected)}')
for l in connected[:5]:
    print(f'  {l.strip()[:120]}')
print('PASS' if connected else 'INFO: no container activity in last 50 log lines')
"
```

**Expected:**
- Container `openhive-weather` is running, OR container provisioning activity visible in logs
- Note: container may take a few seconds to start. If this fails, wait 10s and retry once.

### 8. Verify Child Container Workspace

**Run:**
```bash
docker exec openhive-weather sh -c "
  test -d /app/workspace && echo 'PASS: /app/workspace exists' || echo 'FAIL: /app/workspace missing'
  test -f /app/workspace/CLAUDE.md && echo 'PASS: CLAUDE.md' || echo 'FAIL: CLAUDE.md missing'
  test -d /app/workspace/.claude && echo 'PASS: .claude/' || echo 'FAIL: .claude/ missing'
  ls /app/workspace/ 2>/dev/null
" 2>/dev/null || echo "INFO: child container not accessible (may not be running yet)"
```

**Expected:**
- `/app/workspace` exists inside child container with CLAUDE.md and `.claude/` directory
- If container isn't accessible, record as INFO (not FAIL) — container lifecycle is tested in test 7

### 9. Weather Question — E2E Dispatch

**Run:**
```bash
curl -s -m 180 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"What is the current weather in Boca Raton, Florida?"}'
```

**Expected:**
- Valid JSON with `data.response`
- Response does NOT contain "dispatch system", "not connected", or "configuration issue"
- Response DOES contain at least one of: "Boca Raton", "temperature", "weather", "degrees", "F", "C", "humid", "wind"

**On failure:** Check task dispatches and container logs:
```bash
curl -s "http://localhost:8080/api/v1/tasks?limit=10"
docker compose -f deployments/docker-compose.yml logs --tail 50 2>&1 | grep -i "connected\|dispatch\|weather\|error"
```

### 10. Verify Task Lifecycle + Delegation Chain

This test verifies the full delegation chain: main assistant dispatches to team lead, team lead uses `dispatch_subtask` to delegate to a worker. The worker's `agent_aid` must differ from `LEADER_AID`, and the subtask must have a `parent_task_id` linking to the lead's task.

**NOTE:** The executor must inject `LEADER_AID` from test 1's response.

**Run:**
```bash
# Get all tasks — check both running and completed
curl -s "http://localhost:8080/api/v1/tasks?limit=50" | python3 -c "
import sys, json
data = json.load(sys.stdin)['data']
tasks = data.get('tasks', [])
leader_aid = '${LEADER_AID}'

# Find weather-related tasks
weather = [t for t in tasks if
    'weather' in str(t.get('team_slug','')).lower() or
    'weather' in str(t.get('prompt','')).lower() or
    'boca' in str(t.get('prompt','')).lower()]

print(f'Total tasks: {len(tasks)}')
print(f'Weather-related: {len(weather)}')
print(f'Leader AID: {leader_aid}')
print()

for t in weather:
    tid = t['id']
    print(f'Task: {tid[:12]}...')
    print(f'  status:       {t[\"status\"]}')
    print(f'  team_slug:    {t.get(\"team_slug\", \"<none>\")}')
    print(f'  agent_aid:    {t.get(\"agent_aid\", \"<none>\")}')
    print(f'  prompt:       {str(t.get(\"prompt\",\"\"))[:80]}')
    print(f'  parent_id:    {t.get(\"parent_task_id\", \"<none>\")}')
    print()

# Assertions
if not weather:
    print('FAIL: no weather tasks found')
else:
    # Find subtasks (tasks with parent_task_id set)
    subtasks = [t for t in weather if t.get('parent_task_id')]
    # Find tasks handled by workers (agent_aid != leader)
    worker_tasks = [t for t in weather if t.get('agent_aid') and t.get('agent_aid') != leader_aid]

    checks = []
    checks.append(('has weather tasks', len(weather) >= 1))
    checks.append(('has team_slug', any(t.get('team_slug') for t in weather)))
    checks.append(('has agent_aid', any(t.get('agent_aid') for t in weather)))
    checks.append(('worker handled task (aid != leader)', len(worker_tasks) >= 1))
    checks.append(('subtask exists (parent_task_id set)', len(subtasks) >= 1))

    for name, ok in checks:
        print(f'  {\"PASS\" if ok else \"FAIL\"}: {name}')

    if worker_tasks:
        w = worker_tasks[0]
        print(f'  Worker AID: {w.get(\"agent_aid\")} (leader: {leader_aid})')
    if subtasks:
        s = subtasks[0]
        print(f'  Subtask parent: {s.get(\"parent_task_id\",\"\")[:12]}...')
"
```

Also check running tasks in case they haven't completed:
```bash
curl -s "http://localhost:8080/api/v1/tasks?status=running&limit=10" | python3 -c "
import sys, json
tasks = json.load(sys.stdin)['data'].get('tasks', [])
weather = [t for t in tasks if 'weather' in str(t.get('team_slug','')).lower() or 'boca' in str(t.get('prompt','')).lower()]
print(f'Still running weather tasks: {len(weather)}')
for t in weather:
    print(f'  {t[\"id\"][:12]}... agent={t.get(\"agent_aid\",\"\")} team={t.get(\"team_slug\",\"\")}')
"
```

**Expected:**
- At least 1 weather-related task exists
- Task has `team_slug` set (dispatched to the weather team)
- At least 1 task has `agent_aid` ≠ `LEADER_AID` (worker handled it, not the lead)
- At least 1 subtask has `parent_task_id` set (proves delegation via `dispatch_subtask`)
- Together these prove: main → lead → worker delegation chain

### 11. Trace Full Message Flow in Logs

**Run:**
```bash
curl -s "http://localhost:8080/api/v1/logs?limit=100" | python3 -c "
import sys, json
data = json.load(sys.stdin)
logs = data.get('logs', data if isinstance(data, list) else [])

# Look for the key stages of the dispatch chain
stages = {
    'chat_received': [],    # API channel received message
    'task_dispatch': [],     # Task dispatched to team
    'ws_send': [],          # WebSocket message sent to container
    'ws_receive': [],       # WebSocket message received from container
    'agent_exec': [],       # Agent executor activity
    'task_complete': [],    # Task completion
}

for l in logs:
    msg = l.get('message', '').lower()
    action = str(l.get('action', '')).lower()
    comp = str(l.get('component', '')).lower()

    if 'chat' in action or 'channel' in comp:
        stages['chat_received'].append(l)
    if 'dispatch' in msg or 'dispatch' in action:
        stages['task_dispatch'].append(l)
    if 'ws' in comp or 'websocket' in comp or 'send' in action:
        stages['ws_send'].append(l)
    if 'receive' in action or 'incoming' in msg:
        stages['ws_receive'].append(l)
    if 'agent' in comp or 'executor' in comp or 'sdk' in comp:
        stages['agent_exec'].append(l)
    if 'complete' in msg or 'completed' in action:
        stages['task_complete'].append(l)

print('=== Message Flow Trace ===')
total_stages = 0
for stage, entries in stages.items():
    has = len(entries) > 0
    if has:
        total_stages += 1
    print(f'{\"PASS\" if has else \"INFO\"}: {stage} ({len(entries)} entries)')
    for e in entries[:2]:
        print(f'  [{e.get(\"level\",\"?\")}] {e.get(\"component\",\"?\")}/{e.get(\"action\",\"?\")}: {e.get(\"message\",\"\")[:80]}')

print()
print(f'Stages with activity: {total_stages}/6')
print('PASS: message flow visible' if total_stages >= 4 else 'WARN: limited flow visibility (check log level)')
"
```

**Expected:**
- At least 4 of 6 message flow stages visible in logs
- Should see: chat received → task dispatch → WebSocket send → agent execution or completion
- Full 6-stage trace depends on log level configuration

### 12. Verify Team-Scoped Log Entries

**Run:**
```bash
curl -s "http://localhost:8080/api/v1/logs?limit=100" | python3 -c "
import sys, json
data = json.load(sys.stdin)
logs = data.get('logs', data if isinstance(data, list) else [])

# Filter for weather-team-specific entries
weather_logs = [l for l in logs if
    'weather' in str(l.get('params', {})).lower() or
    'weather' in l.get('message', '').lower() or
    'weather' in str(l.get('team_slug', '')).lower()]

print(f'Weather-team log entries: {len(weather_logs)}')
for l in weather_logs[:5]:
    print(f'  [{l.get(\"level\",\"\")}] {l.get(\"component\",\"\")}/{l.get(\"action\",\"\")}: {l.get(\"message\",\"\")[:80]}')

print()
print('PASS: weather activity logged' if weather_logs else 'INFO: no weather-specific logs (may be at different verbosity)')
"
```

**Expected:**
- Weather-team-related log entries exist (team creation, task dispatch, etc.)

### 13. Cleanup — Delete Weather Team

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

### 14. Verify Full Cleanup

**Run:**
```bash
echo "=== REST API ==="
curl -s http://localhost:8080/api/v1/teams/weather | python3 -c "
import sys, json; d = json.load(sys.stdin)
print('PASS: team deleted (404)' if 'error' in d else 'FAIL: team still exists')
"

echo "=== Workspace ==="
docker compose -f deployments/docker-compose.yml exec openhive sh -c "
  test ! -d /app/workspace/teams/weather && echo 'PASS: workspace removed' || echo 'FAIL: workspace still exists'
  test ! -d /app/workspace/teams/weather/.claude && echo 'PASS: .claude removed' || echo 'FAIL: .claude still exists'
"

echo "=== Container ==="
docker ps --filter "name=openhive-weather" --format "{{.Names}}" 2>/dev/null | python3 -c "
import sys
names = sys.stdin.read().strip()
print('PASS: container stopped' if not names else f'FAIL: container still running: {names}')
"

echo "=== Tasks marked failed ==="
curl -s "http://localhost:8080/api/v1/tasks?status=failed&limit=20" | python3 -c "
import sys, json
tasks = json.load(sys.stdin)['data'].get('tasks', [])
weather_failed = [t for t in tasks if 'weather' in str(t.get('team_slug','')).lower()]
if weather_failed:
    print(f'INFO: {len(weather_failed)} weather tasks marked failed (expected — team deleted)')
    for t in weather_failed[:3]:
        print(f'  {t[\"id\"][:12]}... status={t[\"status\"]}')
else:
    print('INFO: no failed weather tasks (all may have completed before deletion)')
"
```

**Expected:**
- Team returns 404 via REST
- Workspace directory fully removed (including `.claude/` subtree)
- Container stopped (not listed in `docker ps`)
- Any in-progress tasks marked `failed` (not `cancelled`) with error "team deleted"

## Teardown

```bash
curl -s -X DELETE http://localhost:8080/api/v1/teams/weather 2>/dev/null || true
docker rm -f openhive-weather 2>/dev/null || true
```
