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

**WebSocket messages** — run from the HOST (port 8080 is mapped). Use `process.exit(0)` after receiving the response so the script exits immediately instead of waiting for the timeout:
```bash
node -e "
const ws = new (require('ws'))('ws://localhost:8080/ws');
ws.on('open', () => ws.send(JSON.stringify({content:'YOUR MESSAGE HERE'})));
ws.on('message', (d) => { console.log(d.toString()); ws.close(); process.exit(0); });
ws.on('error', (e) => { console.error('WS_ERROR:', e.message); process.exit(1); });
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 240000);
"
```

**Database queries** — must run inside the container (SQLite is local):
```bash
sudo docker exec deployments-openhive-1 node -e "
const D = require('better-sqlite3')('/app/.run/openhive.db', {readonly:true});
// YOUR QUERY HERE
D.close();
"
```

**Filesystem checks** — must run inside the container:
```bash
sudo docker exec deployments-openhive-1 cat /app/.run/teams/main/config.yaml
```

---

## Phase A: Deterministic Smoke Checks

Execute ALL of these via Bash. No AI calls needed. Report pass/fail for each.

```
SMOKE CHECKS:

Infrastructure:
□ curl -sf http://localhost:8080/health → returns 200 with "ok"
□ Health JSON has storage, sessions, triggers, channels fields
□ Docker inspect health status = "healthy"
□ .run/teams/, .run/shared/, .run/backups/ directories exist in container
□ Main team config.yaml has name=main, mcp_servers includes org
□ Main team has all 5 subdirs: memory, org-rules, team-rules, skills, subagents
□ /data/rules/escalation-policy.md exists and contains "escalation"
□ /app/system-rules/ has .md files
□ Container logs contain "OpenHive v3 started"

Database:
□ org_tree has "main" entry: SELECT name FROM org_tree WHERE name='main'
□ task_queue accessible: SELECT COUNT(*) FROM task_queue
□ 10 concurrent SELECT COUNT(*) FROM org_tree — no errors

WebSocket:
□ Send {"content":"ping"} → get response (connection works)
□ Send invalid JSON → get error response, not crash
□ Send {"content":""} → get error response
□ Health still 200 after error messages

Report: N/16 smoke checks passed.

**STOP GATE:** If any smoke check fails, investigate container logs (`sudo docker logs deployments-openhive-1 2>&1`) and report root causes BEFORE proceeding to Phase B. Fix the skill expectations if the check is wrong (e.g., health format differs from expected). Only proceed to Phase B when all 16 pass or failures are understood and documented.
```

---

## Phase B: Investigative QA Scenarios

For each scenario: ACT → OBSERVE → VERIFY → INVESTIGATE → REPORT.

After every AI response, independently check filesystem + database. Don't trust the AI's claims — verify them.

### Clean Restart Helper

Before **every mutating scenario** (Scenarios 2-10), run a full clean restart to ensure state isolation:

```bash
cd /app/openhive
sudo docker compose -f deployments/docker-compose.yml down -v 2>&1 || true
sudo rm -rf .run && mkdir -p .run
# Reset data/rules to seed state
rm -f data/rules/*.md
cp common/seed-rules/* data/rules/ 2>/dev/null || true
sudo docker compose -f deployments/docker-compose.yml up -d 2>&1
for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
```

Scenario 1 runs on the Phase A state (already clean). All other scenarios get fresh state.

---

### Scenario 1: Identity & Capabilities

**Purpose:** Does OpenHive know what it is?

1. Send: "Who are you?"
   - VERIFY: Response mentions OpenHive or agent orchestration (not "I'm Claude" or generic assistant)
2. Send: "What tools do you have access to?"
   - VERIFY: Response mentions team management (spawn_team, delegate_task, etc.)
3. CHECK: Container logs have no errors during these interactions

**Report:** What identity did it claim? Did it know its tools? Any errors?

---

### Scenario 2: Memory Persistence (THE Critical Test)

**Run Clean Restart Helper before starting this scenario.**

**Purpose:** Does information persist across messages via MEMORY.md?

1. Send: "My name is Mark and I work at Acme Corp. Please save this to your memory file."
   - VERIFY RESPONSE: Did it acknowledge saving?
   - VERIFY FILESYSTEM: `cat .run/teams/main/memory/MEMORY.md`
     - Does the file exist?
     - Does it contain "Mark" and "Acme"?
     - If file doesn't exist: **INVESTIGATE** — the agent didn't write to memory. This is a critical failure. Check if the agent has Write tool access to memory/.

2. Send: "What is my name?"
   - VERIFY: Response says "Mark"
   - If it doesn't know: Read MEMORY.md content.
     - If "Mark" IS in MEMORY.md: memory injection isn't working → check query-options.ts wiring
     - If "Mark" is NOT in MEMORY.md: agent didn't save correctly

3. `sudo docker restart deployments-openhive-1` — wait for health

4. Send: "What is my name and where do I work?"
   - VERIFY: Response says Mark + Acme Corp (cross-session persistence)
   - VERIFY: MEMORY.md still exists on disk after restart
   - If it doesn't know: same investigation as step 2

5. CLEANUP: `rm .run/teams/main/memory/MEMORY.md`

**Report:** Did memory persist? Was MEMORY.md created? Did it survive restart? If any step failed, what was the root cause?

---

### Scenario 3: Team Creation — Deep Verification

**Run Clean Restart Helper before starting this scenario.**

**Purpose:** When AI says "team created," independently verify EVERYTHING.

1. Send: "Create a team called ops-team for monitoring production logs. Accept monitoring and logs topics."
   - OBSERVE: What did the AI claim?

2. INDEPENDENT VERIFICATION (don't trust the AI):
   - `ls .run/teams/ops-team/` → all 5 subdirs (memory, org-rules, team-rules, skills, subagents)?
   - `cat .run/teams/ops-team/config.yaml` → name correct? description? mcp_servers has org?
   - SQLite: `SELECT name, parent_id FROM org_tree WHERE name='ops-team'` → exists with parent=main?
   - SQLite: `SELECT keyword FROM scope_keywords WHERE team_id='ops-team'` → has monitoring+logs?
   - SQLite: `SELECT task, priority, status FROM task_queue WHERE team_id='ops-team'` → bootstrap task?

3. WAIT for bootstrap (poll every 3s for 60s):
   ```bash
   for i in $(seq 1 20); do
     sudo docker exec deployments-openhive-1 test -f /app/.run/teams/ops-team/memory/.bootstrapped 2>/dev/null && echo "BOOTSTRAPPED" && break
     sleep 3
   done
   ```

4. VERIFY BOOTSTRAP:
   - `ls .run/teams/ops-team/skills/` → any .md files created?
   - `cat .run/teams/ops-team/memory/MEMORY.md` → team identity written?
   - `.bootstrapped` marker exists?
   - If bootstrap didn't complete: check task_queue status + container logs → report WHY

5. Send: "What teams do you manage?"
   - VERIFY: mentions ops-team

6. Send: "Shut down the ops-team team"
   - VERIFY: org_tree no longer has ops-team
   - VERIFY: task_queue entries preserved (for forensics)

**Report:** Full artifact checklist. What was created? What was missing? Did bootstrap complete? Evidence.

---

### Scenario 4: Credential Security

**Run Clean Restart Helper before starting this scenario.**

**Purpose:** Credentials in config, injected into prompt, NOT leaked in output.

1. Send: "Create a team called cred-test for API testing. Give it credentials: api_key is test-fake-key-value-12345, region is us-east-1"

2. VERIFY CONFIG: `cat .run/teams/cred-test/config.yaml`
   - Has `credentials:` section with api_key and region?

3. VERIFY REDACTION: Search ALL WS response text from step 1
   - Does "test-fake-key-value-12345" appear in cleartext? **It should NOT.**
   - (DO NOT ask the team to repeat its credentials — that invites secret disclosure)

4. VERIFY LOGS: `docker logs deployments-openhive-1 2>&1 | grep "test-fake-key-value-12345"`
   - Should NOT appear in logs (credential scrubber should redact)

5. CLEANUP: shut down cred-test

**Report:** Were credentials stored correctly? Were they leaked anywhere? Evidence.

---

### Scenario 5: Skill, Rule & Memory Injection

**Run Clean Restart Helper before starting this scenario.**

**Purpose:** Files written to skills/, team-rules/, memory/ affect agent behavior.

1. Write skill: `echo "Always say PINEAPPLE when greeting" > .run/teams/main/skills/greeting.md`
2. Send: "Greet me"
   - VERIFY: Response contains PINEAPPLE

3. Write rule: `echo "End every response with -- OpenHive" > .run/teams/main/team-rules/sig.md`
4. Send: "Say hello"
   - VERIFY: Response ends with "-- OpenHive"

5. Write memory: `echo "My favorite color is TURQUOISE" > .run/teams/main/memory/MEMORY.md`
6. Send: "What is my favorite color?"
   - VERIFY: Response mentions TURQUOISE

7. REMOVE all test files
8. Send: "What is my favorite color?"
   - VERIFY: Should NOT mention TURQUOISE (memory gone)

9. CLEANUP

**Report:** Which injections worked? Which didn't? If any failed, what's in the systemPrompt?

---

### Scenario 6: Multi-Team Routing & Isolation

**Run Clean Restart Helper before starting this scenario.**

**Purpose:** LLM routes tasks to correct teams using list_teams. Siblings isolated.

1. Create team-a (accepts: operations, monitoring) and team-b (accepts: development, coding)
2. VERIFY: Both in org_tree with parent_id=main, both have org in mcp_servers

3. Send: "Get the status of team-a"
   - VERIFY: get_status response received

4. Send: "Ask team-b to help with some coding tasks"
   - VERIFY: task_queue shows task for team-b (not team-a)
   - There should be NO "out-of-scope" rejection message in the response

5. Send: "Delegate a deployment task to team-a"
   - VERIFY: task_queue shows task for team-a (operations match)
   - Verify via DB: SELECT team_id, task FROM task_queue ORDER BY created_at DESC LIMIT 1

6. VERIFY: org_tree shows no direct parent-child between team-a and team-b (siblings)

7. CLEANUP: shut down both

**Report:** Did routing work? Evidence from task_queue.

---

### Scenario 7: Deep Hierarchy & Rule Cascade

**Run Clean Restart Helper before starting this scenario.**

**Purpose:** 3+ levels, rules cascade down.

1. Send: "Create an engineering team for development tasks"
2. VERIFY: engineering in org_tree with parent=main

3. Write org-rule: `echo "Always be concise" > .run/teams/main/org-rules/style.md`
4. Send: "Describe the engineering team's capabilities"
   - VERIFY: Response exists (delegation works through hierarchy)
   - CHECK LOGS: Rule cascade loaded for engineering includes main's org-rules?

5. CLEANUP: rm org-rules/style.md, shut down engineering

**Report:** Did hierarchy work? Did rules cascade? Evidence.

---

### Scenario 8: Recovery & Durability

**Run Clean Restart Helper before starting this scenario.**

**Purpose:** Everything survives restart. System handles stress.

1. Create a team, verify it exists in org_tree
2. Write: `echo "Recovery test" > .run/teams/main/memory/MEMORY.md`
3. `sudo docker restart deployments-openhive-1` — wait for health

4. VERIFY:
   - org_tree still has all teams
   - config files still exist
   - MEMORY.md still exists and has correct content
   - Container logs show "Recovery: loaded org tree"

5. Send: "Who are you?" → system works after restart

6. STRESS: Send 5 messages rapidly without waiting between them
7. VERIFY: Health still 200 after stress

8. CLEANUP

**Report:** What survived? What didn't? Recovery log evidence.

---

### Scenario 9: Error Handling

**Run Clean Restart Helper before starting this scenario.**

**Purpose:** Bad inputs don't crash the system.

1. Send invalid JSON via WS → should get error response, not disconnect
2. Send `{"content":""}` → error response
3. Send: "Create a team called INVALID-UPPERCASE" → should be rejected gracefully
4. Create ops-team, then try creating ops-team again → duplicate rejection

5. VERIFY: Health still 200 after all errors
6. VERIFY: Send normal message → system still works

**Report:** How did each error case behave? Any crashes? Health after errors?

---

### Scenario 10: Full User Journey

**Run Clean Restart Helper before starting this scenario.**

**Purpose:** End-to-end as a real user.

1. Send: "Hi, I'm Sarah. I need help monitoring production logs."
   - OBSERVE: What does it offer?

2. Send: "Yes, create a monitoring team called my-monitor"
   - VERIFY ALL artifacts (same as Scenario 3 deep verification)
   - Wait for bootstrap

3. Send: "What teams do I have?"
   - VERIFY: mentions my-monitor

4. Send: "Ask my-monitor for a status report"
   - VERIFY: task_queue shows delegation to my-monitor

5. Send: "Remember that I prefer daily reports at 9am. Save this to memory."
   - VERIFY: MEMORY.md updated with preference

6. `sudo docker restart deployments-openhive-1` — wait for health

7. Send: "What is my name and what do I prefer for reports?"
   - VERIFY: Knows Sarah + daily reports (from MEMORY.md)
   - If not: investigate MEMORY.md content

8. Send: "Shut down my-monitor"
   - VERIFY: Removed from org_tree

9. Send: "What teams do I have now?"
   - VERIFY: my-monitor not listed

10. CLEANUP

**Report:** Complete user journey evidence. What worked, what didn't, root causes.

---

### Scenario 11: list_teams and LLM-Driven Routing

**Run Clean Restart Helper before starting this scenario.**

**Purpose:** LLM uses list_teams to discover teams and route tasks semantically.

1. Send: "Create a team called parent-ops for operations and monitoring"
2. VERIFY: parent-ops in org_tree with parent=main

3. Send: "Ask parent-ops to create a child team called child-logs for logs and archiving"
4. WAIT for child-logs bootstrap (poll .bootstrapped)

5. VERIFY team data via DB (list_teams is internal, verify its data sources):
   - SQLite: `SELECT keyword FROM scope_keywords WHERE team_id='parent-ops'` → [operations, monitoring]
   - SQLite: `SELECT keyword FROM scope_keywords WHERE team_id='child-logs'` → [logs, archiving]
   - SQLite: `SELECT parent_id FROM org_tree WHERE id='child-logs'` → parent-ops
   - Config: `cat .run/teams/parent-ops/config.yaml` → has description

6. Send: "I need to archive some old logs"
   - VERIFY: LLM routes task to parent-ops (which can sub-delegate to child-logs)
   - Check task_queue for evidence of routing

7. Send: "Ask parent-ops to shut down child-logs"
8. VERIFY: child-logs removed from org_tree

9. Send: "I need to archive some old logs"
   - VERIFY: LLM either handles differently (no logging child available) or creates a new team
   - There should be NO hard "out-of-scope" rejection

10. CLEANUP: shut down parent-ops

**Report:** Did LLM-driven routing work? Evidence from task_queue and org_tree.

---

### Scenario 12: list_teams Data Accuracy

**Run Clean Restart Helper before starting this scenario.**

**Purpose:** Verify list_teams returns correct metadata for LLM routing.

1. Create team-alpha (description: "API development", scope_accepts: [api, development])
2. Create team-beta (description: "Log monitoring", scope_accepts: [logs, monitoring])

3. Send: "What teams do you have?"
   - VERIFY: Response mentions both team-alpha and team-beta with descriptions
   - VERIFY: Response is not "I don't have any teams" (proves list_teams was called)

4. Send: "Delegate to team-alpha: build a REST endpoint for user profiles"
   - VERIFY DB: `SELECT team_id FROM task_queue ORDER BY created_at DESC LIMIT 1` → team-alpha
   - VERIFY: No "out-of-scope" error in response

5. Send: "Delegate to team-beta: check production logs for errors"
   - VERIFY DB: `SELECT team_id FROM task_queue ORDER BY created_at DESC LIMIT 1` → team-beta

6. CLEANUP: shut down both teams

**Report:** Did list_teams provide accurate data? Did routing work without scope admission?

---

### Scenario 13: Scheduled Loggly Monitoring — Team Setup & Trigger Configuration

**Run Clean Restart Helper before starting this scenario.**

**Purpose:** Create a team via the main assistant for Loggly log monitoring with credentials and a scheduled trigger. Verify all artifacts are correctly configured.

1. Send: "Create a team called loggly-monitor for monitoring Loggly logs. Its job is to fetch logs from Loggly and report a summary. Give it credentials: subdomain is test, api_key is xxxxxxx. Accept keywords: logs, monitoring, loggly."
   - OBSERVE: What did the main assistant claim? Did it mention credentials stored?

2. INDEPENDENT VERIFICATION (don't trust the AI):
   - `ls .run/teams/loggly-monitor/` → all 5 subdirs exist?
   - `cat .run/teams/loggly-monitor/config.yaml`:
     - Has `name: loggly-monitor`?
     - Has `credentials:` with `subdomain: test` and `api_key: xxxxxxx`?
     - Has `mcp_servers` includes `org`?
     - Has a `description` mentioning Loggly or log monitoring?
   - SQLite: `SELECT name, parent_id FROM org_tree WHERE name='loggly-monitor'` → exists with parent=main?
   - SQLite: `SELECT keyword FROM scope_keywords WHERE team_id='loggly-monitor'` → has loggly, logs, monitoring?

3. WAIT for bootstrap (poll every 3s for 60s):
   ```bash
   for i in $(seq 1 20); do
     sudo docker exec deployments-openhive-1 test -f /app/.run/teams/loggly-monitor/memory/.bootstrapped 2>/dev/null && echo "BOOTSTRAPPED" && break
     sleep 3
   done
   ```

4. VERIFY BOOTSTRAP:
   - `ls .run/teams/loggly-monitor/skills/` → any skill files created?
   - `cat .run/teams/loggly-monitor/memory/MEMORY.md` → team identity written?

5. Write a schedule trigger config to fire every 2 minutes:
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

6. Restart container to pick up the new trigger config:
   ```bash
   sudo docker restart deployments-openhive-1
   for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
   ```

7. VERIFY TRIGGER REGISTERED:
   - Container logs: `sudo docker logs deployments-openhive-1 2>&1 | grep -i "schedule\|trigger"`
     - Should see "Registered schedule trigger" or similar
   - Health endpoint: `curl -sf http://localhost:8080/health | python3 -m json.tool`
     - Check if triggers section shows registered trigger

**Report:** Was the team created correctly with all artifacts? Were credentials stored securely? Was the trigger registered? Evidence from filesystem, SQLite, and logs.

---

### Scenario 14: Scheduled Job Firing & Error Propagation

**NOTE: This scenario continues from Scenario 13's state. Do NOT run Clean Restart Helper.**

**Purpose:** Wait for the scheduled trigger to fire. Verify the task executes, errors out (bad API key), and errors propagate correctly to task_queue, docker logs, and SQL log database.

1. Record the current time and wait for the next 2-minute cron window (up to 150 seconds):
   ```bash
   echo "Waiting for scheduled trigger to fire (up to 150s)..."
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

2. VERIFY TASK ENQUEUED:
   ```bash
   sudo docker exec deployments-openhive-1 node -e "
   const D = require('better-sqlite3')('/app/.run/openhive.db', {readonly:true});
   const rows = D.prepare(\"SELECT id, team_id, task, status, priority, created_at FROM task_queue WHERE team_id='loggly-monitor' ORDER BY created_at DESC\").all();
   console.log(JSON.stringify(rows, null, 2));
   D.close();
   "
   ```
   - VERIFY: At least one task exists for loggly-monitor
   - VERIFY: task text mentions Loggly/logs

3. Wait for task execution (TaskConsumer polls every 5s, plus execution time — wait up to 60s):
   ```bash
   echo "Waiting for task execution..."
   for i in $(seq 1 12); do
     STATUS=$(sudo docker exec deployments-openhive-1 node -e "
       const D = require('better-sqlite3')('/app/.run/openhive.db', {readonly:true});
       const r = D.prepare(\"SELECT status FROM task_queue WHERE team_id='loggly-monitor' ORDER BY created_at DESC LIMIT 1\").get();
       console.log(r ? r.status : 'none');
       D.close();
     " 2>/dev/null)
     echo "  Task status: $STATUS"
     if [ "$STATUS" = "failed" ] || [ "$STATUS" = "completed" ]; then
       echo "Task finished with status: $STATUS"
       break
     fi
     sleep 5
   done
   ```

4. VERIFY TASK STATUS — expect `failed` (bad API key):
   ```bash
   sudo docker exec deployments-openhive-1 node -e "
   const D = require('better-sqlite3')('/app/.run/openhive.db', {readonly:true});
   const rows = D.prepare(\"SELECT id, status, task FROM task_queue WHERE team_id='loggly-monitor'\").all();
   console.log(JSON.stringify(rows, null, 2));
   D.close();
   "
   ```
   - VERIFY: status = `failed` (expected — fake API key should cause failure)

5. VERIFY ERROR IN DOCKER LOGS:
   ```bash
   sudo docker logs deployments-openhive-1 2>&1 | grep -i "loggly-monitor\|task.*fail\|error.*process" | tail -20
   ```
   - VERIFY: Logs contain error details related to loggly-monitor task failure
   - Should see "Task failed" or "Error processing" with task context

6. VERIFY ERROR IN SQL LOG DATABASE:
   ```bash
   sudo docker exec deployments-openhive-1 node -e "
   const D = require('better-sqlite3')('/app/.run/openhive.db', {readonly:true});
   const rows = D.prepare(\"SELECT level, message, context, created_at FROM log_entries WHERE message LIKE '%loggly%' OR message LIKE '%Task failed%' OR context LIKE '%loggly%' ORDER BY created_at DESC LIMIT 10\").all();
   console.log(JSON.stringify(rows, null, 2));
   D.close();
   "
   ```
   - VERIFY: log_entries table has error/info entries related to the failed task

7. VERIFY USER CAN QUERY ABOUT THE FAILURE via WS:
   Send: "What is the status of loggly-monitor?"
   - VERIFY: Response mentions the team exists and reports on its status
   - The response should indicate task activity (even if it can't detail the API error directly)

8. VERIFY CREDENTIALS NOT LEAKED in any error output:
   - Search docker logs: `sudo docker logs deployments-openhive-1 2>&1 | grep "xxxxxxx"` → should NOT appear
   - Search log_entries: verify no raw credential values in error context

9. CLEANUP:
   ```bash
   # Shut down the team
   # (send via WS): "Shut down the loggly-monitor team"
   # Remove trigger config
   sudo docker exec deployments-openhive-1 rm -f /app/.run/triggers.yaml
   ```

**Report:** Did the scheduled trigger fire on time? Did the task execute and fail as expected? Where did the error appear (task_queue, docker logs, SQL logs)? Were credentials protected? Evidence from all three error channels.

---

## Cleanup
```bash
sudo docker compose -f deployments/docker-compose.yml down -v 2>&1
```

## Final Report

Write a QA investigation report:

```
=== OpenHive QA Investigation Report ===

Phase A: Smoke Checks
  N/17 passed
  Failures: [list with evidence]

Phase B: Investigative Scenarios
  Scenario 1 (Identity):      [summary + evidence]
  Scenario 2 (Memory):        [summary + evidence]
  Scenario 3 (Team Creation): [summary + evidence]
  Scenario 4 (Credentials):   [summary + evidence]
  Scenario 5 (Injection):     [summary + evidence]
  Scenario 6 (Multi-Team):    [summary + evidence]
  Scenario 7 (Hierarchy):     [summary + evidence]
  Scenario 8 (Recovery):      [summary + evidence]
  Scenario 9 (Errors):        [summary + evidence]
  Scenario 10 (Journey):      [summary + evidence]
  Scenario 11 (LLM Routing):  [summary + evidence]
  Scenario 12 (list_teams):   [summary + evidence]
  Scenario 13 (Sched Setup):  [summary + evidence]
  Scenario 14 (Sched Fire):   [summary + evidence]

Critical Findings:
  [List any bugs found with root cause analysis]

Recommendations:
  [What should be fixed before production]
```
