---
name: e2e-test
description: Investigative QA for OpenHive. Acts as a skeptical QA engineer — multi-message conversations, independent side-effect verification, root cause investigation.
user-invocable: true
---

# OpenHive Investigative QA

You are a **skeptical QA engineer**. Assume nothing works until you prove it does. After every AI response, independently verify filesystem and database state. When something fails, investigate WHY — don't just report "FAIL."

**Critical constraint:** Each WebSocket message spawns a FRESH session. There is NO multi-turn conversation state. "Memory" between messages works ONLY through MEMORY.md file persistence + system injection. Design all checks around this reality.

**Run everything autonomously. Never stop to ask the user if you should proceed.**

**CRITICAL: If Phase A has ANY failures, STOP and investigate root causes before proceeding to Phase B. Do not move on with broken infrastructure.**

---

## Setup

### 1. Build and Start
```bash
cd /app/openhive
sudo docker compose -f deployments/docker-compose.yml down -v 2>&1 || true
sudo rm -rf .run && mkdir -p .run
sudo docker system prune -af 2>&1 | tail -3
sudo docker build -t openhive:latest -f deployments/Dockerfile . 2>&1 | tail -5
sudo docker compose -f deployments/docker-compose.yml up -d 2>&1
```

### 2. Wait for Health
```bash
for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Server ready" && break; sleep 3; done
```

### 3. Helpers

#### Multi-Turn WebSocket Script Pattern

For each scenario, write a `.cjs` script that opens ONE WebSocket connection and sends multiple messages sequentially, waiting for each response before sending the next. **MUST use `.cjs` extension** (backend has `"type": "module"` in package.json).

Template — save as `/app/openhive/backend/ws-scenario-N.cjs`:
```javascript
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8080/ws');
const messages = [
  'First message here',
  'Second message here',
  // ... add more as needed
];
let idx = 0;
ws.on('open', () => ws.send(JSON.stringify({ content: messages[idx] })));
ws.on('message', (data) => {
  console.log(`---RESPONSE ${idx + 1}---`);
  console.log(data.toString());
  idx++;
  if (idx < messages.length) {
    ws.send(JSON.stringify({ content: messages[idx] }));
  } else {
    ws.close();
    process.exit(0);
  }
});
ws.on('error', (e) => { console.error('WS_ERROR:', e.message); process.exit(1); });
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 600000);
```

Run from host: `node /app/openhive/backend/ws-scenario-N.cjs`

**Important:** Each message still spawns a FRESH server-side session. The WS connection is persistent but the server treats each message independently. Memory between messages only works through MEMORY.md file persistence.

#### Single WS Message Helper

For quick one-off messages, use this inline pattern:
```bash
node -e "
const ws = new (require('/app/openhive/backend/node_modules/ws'))('ws://localhost:8080/ws');
ws.on('open', () => ws.send(JSON.stringify({content:'YOUR MESSAGE HERE'})));
ws.on('message', (d) => { console.log(d.toString()); ws.close(); process.exit(0); });
ws.on('error', (e) => { console.error('WS_ERROR:', e.message); process.exit(1); });
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 240000);
"
```

#### Database Queries — must run inside the container (SQLite is local):
```bash
sudo docker exec deployments-openhive-1 node -e "
const D = require('better-sqlite3')('/app/.run/openhive.db', {readonly:true});
// YOUR QUERY HERE
D.close();
"
```

#### Filesystem Checks — read from HOST via bind mount:
```bash
# .run/ is volume-mounted — read directly from host, no docker exec needed
cat /app/openhive/.run/teams/main/config.yaml
ls /app/openhive/.run/teams/ops-team/

# Use docker exec ONLY for container-baked files not on host:
sudo docker exec deployments-openhive-1 ls /app/system-rules/
sudo docker exec deployments-openhive-1 cat /data/rules/escalation-policy.md
```

---

## Phase A: Deterministic Smoke Checks

Execute ALL of these via Bash. No AI calls needed. Report pass/fail for each.

```
SMOKE CHECKS:

Infrastructure:
 1. curl -sf http://localhost:8080/health -> returns 200 with "ok"
 2. Health JSON has storage, sessions, triggers, channels fields
 3. Docker inspect health status = "healthy"
 4. .run/teams/, .run/shared/, .run/backups/ directories exist in container
 5. Main team config.yaml has name=main, mcp_servers includes org
 6. Main team has all 5 subdirs: memory, org-rules, team-rules, skills, subagents
 7. /data/rules/escalation-policy.md exists and contains "escalation"
 8. /app/system-rules/ has .md files
 9. Container logs contain "OpenHive v3 started"

Database:
10. org_tree has "main" entry: SELECT name FROM org_tree WHERE name='main'
11. task_queue accessible: SELECT COUNT(*) FROM task_queue
12. task_queue has result column: SELECT result FROM task_queue LIMIT 0
13. 10 concurrent SELECT COUNT(*) FROM org_tree -- no errors

WebSocket:
14. Send {"content":"ping"} -> get response (connection works)
15. Send invalid JSON -> get error response, not crash
16. Send {"content":""} -> get error response
17. Health still 200 after error messages

Report: N/17 smoke checks passed.

**STOP GATE:** If any smoke check fails, investigate container logs
(`sudo docker logs deployments-openhive-1 2>&1`) and report root causes
BEFORE proceeding to Phase B. Only proceed when all 17 pass or failures
are understood and documented.
```

---

## Phase B: Investigative QA Scenarios (5 Comprehensive Scenarios)

For each scenario: ACT -> OBSERVE -> VERIFY -> INVESTIGATE -> REPORT.

After every AI response, independently check filesystem + database. Don't trust the AI's claims — verify them.

### Clean Restart Helper

Before **every scenario** (except Scenario 4 step 2 which continues from step 1), run a full clean restart:

```bash
cd /app/openhive
sudo docker compose -f deployments/docker-compose.yml down -v 2>&1 || true
sudo rm -rf .run && mkdir -p .run
rm -f data/rules/*.md
cp common/seed-rules/* data/rules/ 2>/dev/null || true
sudo docker compose -f deployments/docker-compose.yml up -d 2>&1
for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
```

---

### Scenario 1: Core Platform (Identity + Memory + Injection + Recovery)

**Merges:** old Scenarios 1, 2, 5, parts of 8

**Run Clean Restart Helper.**

#### Part A: Identity & Tools

Write a multi-turn WS script with these messages:
1. "Who are you and what system do you run?"
2. "What tools do you have access to? List them."

Run it. VERIFY:
- Response 1 mentions OpenHive or agent orchestration (not generic "I'm Claude")
- Response 2 mentions team management tools (spawn_team, delegate_task, list_teams, etc.)
- Container logs have no errors

#### Part B: Memory Persistence

Continue using single WS messages (each is a fresh session):

3. Send: "My name is Mark and I work at Acme Corp. Please save this to your memory file."
   - VERIFY RESPONSE: Did it acknowledge saving?
   - VERIFY HOST FILESYSTEM: `cat /app/openhive/.run/teams/main/memory/MEMORY.md`
     - Does file exist? Does it contain "Mark" and "Acme"?
     - If missing: **INVESTIGATE** — check Write tool access, check container logs

4. Send: "What is my name?"
   - VERIFY: Response says "Mark"
   - If it doesn't know: check MEMORY.md content
     - If "Mark" IS in MEMORY.md: memory injection broken -> check context-builder.ts
     - If "Mark" NOT in MEMORY.md: agent didn't save correctly

5. `sudo docker restart deployments-openhive-1` — wait for health

6. Send: "What is my name and where do I work?"
   - VERIFY: Says Mark + Acme (cross-session persistence via MEMORY.md)
   - VERIFY: MEMORY.md still on disk after restart

#### Part C: Skill, Rule & Memory Injection

7. Write injection files on HOST:
   ```bash
   echo "Always say PINEAPPLE when greeting" > /app/openhive/.run/teams/main/skills/greeting.md
   echo "End every response with -- OpenHive" > /app/openhive/.run/teams/main/team-rules/sig.md
   echo "My favorite color is TURQUOISE" > /app/openhive/.run/teams/main/memory/MEMORY.md
   ```

8. Send: "Greet me"
   - VERIFY: Response contains PINEAPPLE

9. Send: "Say hello"
   - VERIFY: Response ends with "-- OpenHive"

10. Send: "What is my favorite color?"
    - VERIFY: Response mentions TURQUOISE

11. Remove all injection files:
    ```bash
    rm /app/openhive/.run/teams/main/skills/greeting.md
    rm /app/openhive/.run/teams/main/team-rules/sig.md
    rm /app/openhive/.run/teams/main/memory/MEMORY.md
    ```

12. Send: "What is my favorite color?"
    - VERIFY: Should NOT mention TURQUOISE (memory gone)

**Report:** Identity correct? Tools listed? Memory persisted across restart? All 3 injection types worked? Injection removal worked?

---

### Scenario 2: Team Lifecycle, Credentials & User Journey

**Merges:** old Scenarios 3, 4, 10

**Run Clean Restart Helper.**

#### Part A: Team Creation — Deep Verification

1. Send: "Create a team called ops-team for monitoring production logs. Accept monitoring and logs topics. Give it credentials: api_key is test-fake-key-value-12345, region is us-east-1"
   - OBSERVE: What did the AI claim?

2. INDEPENDENT VERIFICATION (host filesystem + DB):
   ```bash
   # Host filesystem (bind-mounted .run/)
   ls /app/openhive/.run/teams/ops-team/
   cat /app/openhive/.run/teams/ops-team/config.yaml
   ```
   - All 5 subdirs (memory, org-rules, team-rules, skills, subagents)?
   - config.yaml: name correct? description? mcp_servers has org? credentials section?

   ```bash
   # SQLite (must be inside container)
   sudo docker exec deployments-openhive-1 node -e "
   const D = require('better-sqlite3')('/app/.run/openhive.db', {readonly:true});
   console.log('org_tree:', JSON.stringify(D.prepare(\"SELECT name, parent_id FROM org_tree WHERE name='ops-team'\").get()));
   console.log('scope:', JSON.stringify(D.prepare(\"SELECT keyword FROM scope_keywords WHERE team_id='ops-team'\").all()));
   console.log('tasks:', JSON.stringify(D.prepare(\"SELECT task, priority, status FROM task_queue WHERE team_id='ops-team'\").all()));
   D.close();
   "
   ```
   - org_tree: exists with parent=main?
   - scope_keywords: has monitoring+logs?
   - task_queue: bootstrap task exists?

3. CREDENTIAL SECURITY:
   - VERIFY: WS response from step 1 does NOT contain "test-fake-key-value-12345" in cleartext
   - `sudo docker logs deployments-openhive-1 2>&1 | grep "test-fake-key-value-12345"` — should NOT appear
   - config.yaml should have credentials stored (that's OK — it's server-side only)

4. WAIT for bootstrap:
   ```bash
   for i in $(seq 1 20); do
     test -f /app/openhive/.run/teams/ops-team/memory/.bootstrapped && echo "BOOTSTRAPPED" && break
     sleep 3
   done
   ```

5. VERIFY BOOTSTRAP (host reads):
   - `ls /app/openhive/.run/teams/ops-team/skills/` — any .md files?
   - `cat /app/openhive/.run/teams/ops-team/memory/MEMORY.md` — team identity written?
   - `.bootstrapped` marker exists?

#### Part B: Full User Journey

6. Send: "What teams do you manage?"
   - VERIFY: mentions ops-team

7. Send: "Ask ops-team for a status report on logs"
   - VERIFY DB: task_queue shows delegation to ops-team
   - VERIFY: Check `result` column after task completes (wait up to 60s):
   ```bash
   for i in $(seq 1 12); do
     RESULT=$(sudo docker exec deployments-openhive-1 node -e "
       const D = require('better-sqlite3')('/app/.run/openhive.db', {readonly:true});
       const r = D.prepare(\"SELECT status, result FROM task_queue WHERE team_id='ops-team' ORDER BY created_at DESC LIMIT 1\").get();
       console.log(JSON.stringify(r));
       D.close();
     " 2>/dev/null)
     echo "Task state: $RESULT"
     echo "$RESULT" | grep -qE '"(completed|failed)"' && break
     sleep 5
   done
   ```

8. Send: "Remember that I prefer daily reports at 9am. Save this to memory."
   - VERIFY: `cat /app/openhive/.run/teams/main/memory/MEMORY.md` — has preference?

#### Part C: Recovery

9. `sudo docker restart deployments-openhive-1` — wait for health

10. Send: "What teams do I have and what do I prefer for reports?"
    - VERIFY: Knows ops-team + daily reports at 9am (from MEMORY.md)

11. VERIFY post-restart state:
    - org_tree still has ops-team
    - config.yaml still exists on host
    - Container logs show "Recovery: loaded org tree"

#### Part D: Shutdown

12. Send: "Shut down the ops-team team"
    - VERIFY DB: org_tree no longer has ops-team
    - VERIFY DB: task_queue entries preserved (forensics)

13. Send: "What teams do I have now?"
    - VERIFY: ops-team not listed

**Report:** Full artifact checklist. Credentials secure? Bootstrap complete? Recovery survived? User journey end-to-end?

---

### Scenario 3: Multi-Team, Hierarchy, Routing & Errors

**Merges:** old Scenarios 6, 7, 9, 11, 12

**Run Clean Restart Helper.**

#### Part A: Create Sibling Teams

Write a multi-turn WS script with these messages:
1. "Create a team called team-alpha for API development. Accept keywords: api, development, coding"
2. "Create a team called team-beta for operations and monitoring. Accept keywords: ops, monitoring, deployment"

Run it. Then VERIFY independently:
```bash
# Host filesystem
cat /app/openhive/.run/teams/team-alpha/config.yaml
cat /app/openhive/.run/teams/team-beta/config.yaml

# SQLite
sudo docker exec deployments-openhive-1 node -e "
const D = require('better-sqlite3')('/app/.run/openhive.db', {readonly:true});
console.log('alpha:', JSON.stringify(D.prepare(\"SELECT name, parent_id FROM org_tree WHERE name='team-alpha'\").get()));
console.log('beta:', JSON.stringify(D.prepare(\"SELECT name, parent_id FROM org_tree WHERE name='team-beta'\").get()));
console.log('alpha_scope:', JSON.stringify(D.prepare(\"SELECT keyword FROM scope_keywords WHERE team_id='team-alpha'\").all()));
console.log('beta_scope:', JSON.stringify(D.prepare(\"SELECT keyword FROM scope_keywords WHERE team_id='team-beta'\").all()));
D.close();
"
```
- Both have parent_id=main, both configs have mcp_servers including org
- Correct scope keywords for each

#### Part B: list_teams & Routing

3. Send: "What teams do you have?"
   - VERIFY: Response mentions both team-alpha and team-beta with descriptions
   - VERIFY: Response is NOT "I don't have any teams" (proves list_teams was called)

4. Send: "Delegate to team-alpha: build a REST endpoint for user profiles"
   - VERIFY DB: `SELECT team_id FROM task_queue ORDER BY created_at DESC LIMIT 1` -> team-alpha

5. Send: "Delegate to team-beta: check production logs for errors"
   - VERIFY DB: `SELECT team_id FROM task_queue ORDER BY created_at DESC LIMIT 1` -> team-beta

6. Send: "Get the status of team-alpha"
   - VERIFY: Response contains status info (not an error)

#### Part C: Hierarchy — Child Team Creation

7. Send: "Ask team-alpha to create a child team called alpha-child for frontend work. Accept keywords: frontend, ui"

8. Wait for alpha-child bootstrap:
   ```bash
   for i in $(seq 1 20); do
     test -f /app/openhive/.run/teams/alpha-child/memory/.bootstrapped && echo "BOOTSTRAPPED" && break
     sleep 3
   done
   ```

9. VERIFY hierarchy:
   ```bash
   sudo docker exec deployments-openhive-1 node -e "
   const D = require('better-sqlite3')('/app/.run/openhive.db', {readonly:true});
   console.log(JSON.stringify(D.prepare(\"SELECT name, parent_id FROM org_tree WHERE name='alpha-child'\").get()));
   D.close();
   "
   ```
   - parent_id should be team-alpha (NOT main)

#### Part D: Error Handling

10. Send invalid JSON via WS: send raw bytes `not json at all`
    - VERIFY: Get error response, connection still alive

11. Send: `{"content":""}`
    - VERIFY: Error response

12. Send: "Create a team called team-alpha for something"
    - VERIFY: Duplicate rejection (team-alpha already exists)

13. VERIFY: `curl -sf http://localhost:8080/health` still returns 200

14. Send: "Hello, are you still working?"
    - VERIFY: Normal response (system recovered from errors)

#### Part E: Shutdown Cascade

15. Send: "Shut down team-alpha"
    - VERIFY DB: team-alpha AND alpha-child both removed from org_tree

16. Send: "Shut down team-beta"
    - VERIFY DB: team-beta removed

17. VERIFY: Health still 200 after all operations

**Report:** Teams created? Routing correct? Hierarchy correct (parent_id)? Errors handled gracefully? Shutdown cascade worked?

---

### Scenario 4: Scheduled Jobs & Error Propagation

**Merges:** old Scenarios 13, 14

**Run Clean Restart Helper.**

#### Part A: Team Setup & Trigger Configuration

1. Send: "Create a team called loggly-monitor for monitoring Loggly logs. Give it credentials: subdomain is test, api_key is xxxxxxx. Accept keywords: logs, monitoring, loggly."
   - OBSERVE: What did the AI claim?

2. VERIFY (host filesystem + DB):
   ```bash
   ls /app/openhive/.run/teams/loggly-monitor/
   cat /app/openhive/.run/teams/loggly-monitor/config.yaml
   ```
   - Has credentials with subdomain and api_key?
   - Has mcp_servers including org?

   ```bash
   sudo docker exec deployments-openhive-1 node -e "
   const D = require('better-sqlite3')('/app/.run/openhive.db', {readonly:true});
   console.log('team:', JSON.stringify(D.prepare(\"SELECT name, parent_id FROM org_tree WHERE name='loggly-monitor'\").get()));
   console.log('scope:', JSON.stringify(D.prepare(\"SELECT keyword FROM scope_keywords WHERE team_id='loggly-monitor'\").all()));
   D.close();
   "
   ```

3. Wait for bootstrap:
   ```bash
   for i in $(seq 1 20); do
     test -f /app/openhive/.run/teams/loggly-monitor/memory/.bootstrapped && echo "BOOTSTRAPPED" && break
     sleep 3
   done
   ```

4. Write schedule trigger (inside container — triggers.yaml is read from /app/.run/):
   ```bash
   sudo docker exec deployments-openhive-1 bash -c 'cat > /app/.run/triggers.yaml << "YAML"
   triggers:
     - name: loggly-fetch
       type: schedule
       config:
         cron: "*/2 * * * *"
       team: loggly-monitor
       task: "Fetch recent logs from Loggly using your credentials (subdomain and api_key) and report a summary of any errors found. Use the Loggly Search API."
   YAML'
   ```

5. Restart to pick up trigger:
   ```bash
   sudo docker restart deployments-openhive-1
   for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
   ```

6. VERIFY TRIGGER REGISTERED:
   ```bash
   sudo docker logs deployments-openhive-1 2>&1 | grep -i "schedule\|trigger"
   curl -sf http://localhost:8080/health | python3 -m json.tool
   ```

#### Part B: Trigger Firing & Error Propagation (continues from Part A — NO restart)

7. Wait for cron fire (up to 150s):
   ```bash
   echo "Waiting for scheduled trigger to fire..."
   START=$(date +%s)
   FOUND=0
   for i in $(seq 1 30); do
     COUNT=$(sudo docker exec deployments-openhive-1 node -e "
       const D = require('better-sqlite3')('/app/.run/openhive.db', {readonly:true});
       const r = D.prepare(\"SELECT COUNT(*) as c FROM task_queue WHERE team_id='loggly-monitor' AND task LIKE '%Loggly%'\").get();
       console.log(r.c);
       D.close();
     " 2>/dev/null)
     if [ "$COUNT" -gt "0" ]; then
       echo "Task enqueued after $(($(date +%s) - START))s"
       FOUND=1
       break
     fi
     sleep 5
   done
   [ "$FOUND" = "0" ] && echo "TIMEOUT: No task enqueued after 150s"
   ```

8. Wait for execution (up to 60s):
   ```bash
   for i in $(seq 1 12); do
     STATUS=$(sudo docker exec deployments-openhive-1 node -e "
       const D = require('better-sqlite3')('/app/.run/openhive.db', {readonly:true});
       const r = D.prepare(\"SELECT status, result FROM task_queue WHERE team_id='loggly-monitor' ORDER BY created_at DESC LIMIT 1\").get();
       console.log(JSON.stringify(r));
       D.close();
     " 2>/dev/null)
     echo "  Task state: $STATUS"
     echo "$STATUS" | grep -qE '"(completed|failed)"' && break
     sleep 5
   done
   ```

9. VERIFY TASK OUTCOME:
   ```bash
   sudo docker exec deployments-openhive-1 node -e "
   const D = require('better-sqlite3')('/app/.run/openhive.db', {readonly:true});
   const rows = D.prepare(\"SELECT id, status, result, task FROM task_queue WHERE team_id='loggly-monitor'\").all();
   console.log(JSON.stringify(rows, null, 2));
   D.close();
   "
   ```
   - Task should be completed or failed
   - **`result` column should contain the LLM response text** (this verifies Bug 2 fix)

10. VERIFY ERROR PROPAGATION:
    - Docker logs: `sudo docker logs deployments-openhive-1 2>&1 | grep -i "loggly-monitor\|task.*fail\|task.*completed" | tail -20`
    - SQL log DB:
    ```bash
    sudo docker exec deployments-openhive-1 node -e "
    const D = require('better-sqlite3')('/app/.run/openhive.db', {readonly:true});
    const rows = D.prepare(\"SELECT level, message, context FROM log_entries WHERE message LIKE '%loggly%' OR context LIKE '%loggly%' ORDER BY created_at DESC LIMIT 10\").all();
    console.log(JSON.stringify(rows, null, 2));
    D.close();
    "
    ```

11. VERIFY CREDENTIALS NOT LEAKED:
    - `sudo docker logs deployments-openhive-1 2>&1 | grep "xxxxxxx"` — should NOT appear
    - Check result column text for credential values

12. Send: "What is the status of loggly-monitor?"
    - VERIFY: Response includes status info (latestResult should be surfaced)

13. CLEANUP:
    ```bash
    sudo docker exec deployments-openhive-1 rm -f /app/.run/triggers.yaml
    ```

**Report:** Trigger registered? Fired on time? Task enqueued and executed? Result column populated (Bug 2 fix verified)? Credentials protected? Error channels (task_queue, logs, SQL logs) all have evidence?

---

### Scenario 5: Stress, Recovery & Edge Cases

**Merges:** old Scenarios 8-stress, 9-extra

**Run Clean Restart Helper.**

#### Part A: Setup State

1. Send: "Create a team called stress-team for testing. Accept keywords: testing"
2. Write memory: `echo "Stress test baseline" > /app/openhive/.run/teams/main/memory/MEMORY.md`
3. VERIFY: stress-team in org_tree, MEMORY.md exists

#### Part B: Stress Test — 5 Rapid Concurrent Messages

4. Write a concurrent WS script (`/app/openhive/backend/ws-stress.cjs`):
   ```javascript
   const WebSocket = require('ws');
   const messages = [
     'What is 2+2?',
     'What is the capital of France?',
     'List 3 colors',
     'What teams do you have?',
     'Who are you?',
   ];
   let completed = 0;
   for (let i = 0; i < messages.length; i++) {
     const ws = new WebSocket('ws://localhost:8080/ws');
     ws.on('open', () => ws.send(JSON.stringify({ content: messages[i] })));
     ws.on('message', (d) => {
       console.log(`---RESPONSE ${i + 1}---`);
       console.log(d.toString().slice(0, 200));
       completed++;
       ws.close();
       if (completed === messages.length) process.exit(0);
     });
     ws.on('error', (e) => {
       console.error(`WS_ERROR ${i + 1}: ${e.message}`);
       completed++;
       if (completed === messages.length) process.exit(1);
     });
   }
   setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 300000);
   ```

   Run: `node /app/openhive/backend/ws-stress.cjs`

5. VERIFY: All 5 got responses (no crashes)
6. VERIFY: `curl -sf http://localhost:8080/health` returns 200

#### Part C: Recovery After Restart

7. `sudo docker restart deployments-openhive-1` — wait for health

8. VERIFY post-restart:
   ```bash
   # org_tree still has teams
   sudo docker exec deployments-openhive-1 node -e "
   const D = require('better-sqlite3')('/app/.run/openhive.db', {readonly:true});
   console.log(JSON.stringify(D.prepare('SELECT name FROM org_tree').all()));
   D.close();
   "
   # MEMORY.md still exists
   cat /app/openhive/.run/teams/main/memory/MEMORY.md
   # Config files intact
   cat /app/openhive/.run/teams/stress-team/config.yaml
   # Recovery log
   sudo docker logs deployments-openhive-1 2>&1 | grep "Recovery"
   ```

9. Send: "Hello, are you working?"
   - VERIFY: Normal response (system works after restart)

10. VERIFY: Health still 200

#### Part D: Cleanup

11. Send: "Shut down stress-team"
12. Remove test files:
    ```bash
    rm -f /app/openhive/.run/teams/main/memory/MEMORY.md
    rm -f /app/openhive/backend/ws-stress.cjs
    ```

**Report:** All 5 concurrent messages got responses? Health stable? Recovery preserved all state? System functional after stress?

---

## Cleanup
```bash
cd /app/openhive
sudo docker compose -f deployments/docker-compose.yml down -v 2>&1
rm -f backend/ws-scenario-*.cjs backend/ws-stress.cjs
```

## Final Report

Write a QA investigation report:

```
=== OpenHive QA Investigation Report ===

Phase A: Smoke Checks
  N/17 passed
  Failures: [list with evidence]

Phase B: Investigative Scenarios
  Scenario 1 (Core Platform):           [summary + evidence]
    - Identity: [pass/fail]
    - Memory persistence: [pass/fail]
    - Injection (skill/rule/memory): [pass/fail]
    - Injection removal: [pass/fail]
  Scenario 2 (Team Lifecycle):           [summary + evidence]
    - Team creation artifacts: [pass/fail]
    - Credential security: [pass/fail]
    - Bootstrap: [pass/fail]
    - Task delegation + result capture: [pass/fail]
    - Recovery: [pass/fail]
    - Shutdown: [pass/fail]
  Scenario 3 (Multi-Team & Routing):     [summary + evidence]
    - Sibling creation: [pass/fail]
    - list_teams + routing: [pass/fail]
    - Hierarchy (child team): [pass/fail]
    - Error handling: [pass/fail]
    - Shutdown cascade: [pass/fail]
  Scenario 4 (Scheduled Jobs):           [summary + evidence]
    - Team + trigger setup: [pass/fail]
    - Trigger firing: [pass/fail]
    - Task result captured (Bug 2 fix): [pass/fail]
    - Error propagation: [pass/fail]
    - Credential protection: [pass/fail]
  Scenario 5 (Stress & Recovery):        [summary + evidence]
    - Concurrent messages: [pass/fail]
    - Post-restart state: [pass/fail]
    - System stability: [pass/fail]

Critical Findings:
  [List any bugs found with root cause analysis]

Recommendations:
  [What should be fixed before production]
```
