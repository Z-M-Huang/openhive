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
□ Main team has all 6 subdirs: workspace, memory, org-rules, team-rules, skills, subagents
□ /data/rules/escalation-policy.md exists and contains "escalation"
□ /app/system-rules/ has .md files
□ Container logs contain "Rule cascade loaded"
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

Report: N/17 smoke checks passed.

**STOP GATE:** If any smoke check fails, investigate container logs (`sudo docker logs deployments-openhive-1 2>&1`) and report root causes BEFORE proceeding to Phase B. Fix the skill expectations if the check is wrong (e.g., health format differs from expected). Only proceed to Phase B when all 17 pass or failures are understood and documented.
```

---

## Phase B: Investigative QA Scenarios

For each scenario: ACT → OBSERVE → VERIFY → INVESTIGATE → REPORT.

After every AI response, independently check filesystem + database. Don't trust the AI's claims — verify them.

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

**Purpose:** When AI says "team created," independently verify EVERYTHING.

1. Send: "Create a team called ops-team for monitoring production logs. Accept monitoring and logs topics."
   - OBSERVE: What did the AI claim?

2. INDEPENDENT VERIFICATION (don't trust the AI):
   - `ls .run/teams/ops-team/` → all 6 subdirs?
   - `cat .run/teams/ops-team/config.yaml` → name correct? description? scope has monitoring+logs? mcp_servers has org?
   - SQLite: `SELECT name, parent_id FROM org_tree WHERE name='ops-team'` → exists with parent=main?
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

### Scenario 6: Multi-Team Scope & Routing

**Purpose:** Scope admission works. Siblings isolated.

1. Create team-a (accepts: operations, monitoring) and team-b (accepts: development, coding)
2. VERIFY: Both in org_tree with parent_id=main, both have org in mcp_servers

3. Send: "Get the status of team-a"
   - VERIFY: get_status response received

4. Send: "Ask team-a about monitoring tasks"
   - VERIFY: task_queue shows task for team-a

5. Send: "Ask team-a to write some code"
   - VERIFY: Should be rejected or rerouted (coding is out of scope for team-a)

6. VERIFY: org_tree shows no direct parent-child between team-a and team-b (siblings)

7. CLEANUP: shut down both

**Report:** Did routing work? Was out-of-scope rejected? Evidence from task_queue.

---

### Scenario 7: Deep Hierarchy & Rule Cascade

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

Critical Findings:
  [List any bugs found with root cause analysis]

Recommendations:
  [What should be fixed before production]
```
