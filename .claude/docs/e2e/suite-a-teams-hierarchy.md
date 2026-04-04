# Suite A: Teams + Credentials + Hierarchy + Memory

Consolidates scenarios 1 (memory), 2 (teams/credentials), and 3 (hierarchy/routing).

## Prerequisites

- Docker image already built
- WS harness running on localhost:9876
- Verification script: `node src/e2e/verify-suite-teams-hierarchy.cjs --step <step>`

## Clean Restart

```bash
cd /app/openhive
sudo docker compose -f deployments/docker-compose.yml down -v 2>&1 || true
sudo rm -rf .run && mkdir -p .run
rm -f data/rules/*.md
cp seed-rules/* data/rules/ 2>/dev/null || true
sudo docker compose -f deployments/docker-compose.yml up -d 2>&1
for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
```

```bash
curl -s localhost:9876/reset
curl -s localhost:9876/connect -d '{"name":"main"}'
```

---

## Step 1: Memory Write

Write a fact to memory and verify it persists.

```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Remember: Alice is the product manager. Please save this to your memory file.","timeout":300000}
EOF
```

**Verify:**
- `.final` acknowledges saving
- Run: `node src/e2e/verify-suite-teams-hierarchy.cjs --step after-memory-write`
- Checks: MEMORY.md exists at `.run/teams/main/memory/MEMORY.md`, contains "Alice"

If verify fails on MEMORY.md missing: check container logs for Write tool errors. If "Alice" not in MEMORY.md: agent didn't save correctly.

---

## Step 2: Create ops-team with Credentials

```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Create a team called ops-team for monitoring production logs. Accept monitoring and logs topics. Give it credentials: api_key is test-fake-key-value-12345, region is us-east-1","timeout":300000}
EOF
```

Wait for bootstrap:
```bash
for i in $(seq 1 20); do
  test -f /app/openhive/.run/teams/ops-team/memory/.bootstrapped && echo "BOOTSTRAPPED" && break
  sleep 3
done
```

**Verify:**
- `.final` confirms team created (does NOT contain "test-fake-key-value-12345" in cleartext)
- Run: `node src/e2e/verify-suite-teams-hierarchy.cjs --step after-team-create`
- Checks: ops-team in org_tree with parent=main, scope_keywords contain monitoring+logs, config.yaml exists with credentials section, bootstrap task in task_queue, 5 subdirs exist (memory, org-rules, team-rules, skills, subagents)

---

## Step 3: Credential Retrieval

```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Ask ops-team to use the get_credential tool to retrieve the api_key credential, and tell me what tool it used.","timeout":300000}
EOF
```

Wait for task completion (up to 60s):
```bash
for i in $(seq 1 12); do
  RESULT=$(node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const r = D.prepare(\"SELECT status, result FROM task_queue WHERE team_id='ops-team' AND task LIKE '%get_credential%' ORDER BY created_at DESC LIMIT 1\").get();
    console.log(JSON.stringify(r));
    D.close();
  " 2>/dev/null)
  echo "Task state: $RESULT"
  echo "$RESULT" | grep -qE '"(completed|failed)"' && break
  sleep 5
done
```

**Observe:** `.final` mentions get_credential was used. The raw credential value should NOT appear in the WS response.

---

## Step 4: Create team-alpha and team-beta

```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Create a team called team-alpha for API development. Accept keywords: api, development, coding","timeout":300000}
EOF
```

```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Create a team called team-beta for operations and monitoring. Accept keywords: ops, monitoring, deployment","timeout":300000}
EOF
```

**Verify (part 1 -- siblings only, before child creation):**
- Run: `node src/e2e/verify-suite-teams-hierarchy.cjs --step after-hierarchy`
- Checks: team-alpha and team-beta in org_tree, both with parent_id=main, correct scope_keywords for each, config.yaml files exist

---

## Step 5: Create alpha-child under team-alpha

```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Ask team-alpha to create a child team called alpha-child for frontend work. Accept keywords: frontend, ui","timeout":300000}
EOF
```

Wait for alpha-child bootstrap:
```bash
for i in $(seq 1 20); do
  test -f /app/openhive/.run/teams/alpha-child/memory/.bootstrapped && echo "BOOTSTRAPPED" && break
  sleep 3
done
```

**Verify:**
- Run: `node src/e2e/verify-suite-teams-hierarchy.cjs --step after-hierarchy`
- Checks: alpha-child in org_tree with parent_id=team-alpha (NOT main), config.yaml exists, bootstrap marker present

---

## Step 6: List All Teams

```bash
curl -s localhost:9876/send -d '{"name":"main","content":"What teams do you have?","timeout":300000}'
```

**Observe:** `.final` mentions ops-team, team-alpha, and team-beta with descriptions. Must NOT say "I don't have any teams" (proves list_teams was called).

---

## Step 7: Delegation

```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Ask ops-team to check deployment status and report back","timeout":300000}
EOF
```

Wait for task completion (up to 60s):
```bash
for i in $(seq 1 12); do
  RESULT=$(node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const r = D.prepare(\"SELECT status, result FROM task_queue WHERE team_id='ops-team' ORDER BY created_at DESC LIMIT 1\").get();
    console.log(JSON.stringify(r));
    D.close();
  " 2>/dev/null)
  echo "Task state: $RESULT"
  echo "$RESULT" | grep -qE '"(completed|failed)"' && break
  sleep 5
done
```

**Verify:**
- Run: `node src/e2e/verify-suite-teams-hierarchy.cjs --step after-delegation`
- Checks: task_queue has delegation to ops-team with status completed or failed, result column is non-null

---

## Step 8: Credential Scrubbing

**Verify:**
- Run: `node src/e2e/verify-suite-teams-hierarchy.cjs --step after-credentials`
- Checks: "test-fake-key-value-12345" does NOT appear in task_queue result columns, does NOT appear in container logs (`docker logs openhive`), does NOT appear in WS notification content

Additional manual check:
```bash
sudo docker logs openhive 2>&1 | grep "test-fake-key-value-12345" && echo "CREDENTIAL LEAK IN LOGS!" || echo "Log credential check: CLEAN"
```

---

## Step 9: Restart + Memory Persistence

Restart the container (NOT a clean restart -- data must survive):
```bash
sudo docker restart openhive
for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
curl -s localhost:9876/reconnect -d '{"name":"main"}'
```

```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Who is the product manager?","timeout":300000}
EOF
```

**Verify:**
- `.final` says "Alice" (cross-session persistence via MEMORY.md)
- Run: `node src/e2e/verify-suite-teams-hierarchy.cjs --step after-restart`
- Checks: MEMORY.md still on disk, org_tree still has ops-team + team-alpha + team-beta + alpha-child, config.yaml files intact, health returns 200, container logs contain "Recovery" or "loaded" messages

---

## Pass Criteria

All verification steps pass (summary.failed === 0 for each). Key outcomes:
- Memory written and persisted across restart
- Team created with credentials, bootstrap completed
- get_credential tool used successfully
- Hierarchy correct: alpha-child parent is team-alpha, not main
- Delegation routed correctly
- Credentials never leaked to logs, task results, or WS responses
- All state survived docker restart
