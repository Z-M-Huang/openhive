# Suite B: Triggers + Notifications

Consolidates scenario 4 (triggers, firing, notifications) and scenario 11 (LLM-based notify decisions).

## Prerequisites

- Docker image already built
- WS harness running on localhost:9876
- Verification script: `node src/e2e/verify-suite-triggers-notifications.cjs --step <step>`

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

# Part 1: Trigger Lifecycle (from scenario 4)

## Step 1: Create loggly-monitor Team

```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Create a team called loggly-monitor for monitoring Loggly logs. Give it credentials: subdomain is test, api_key is fake-loggly-apikey-9876. Accept keywords: logs, monitoring, loggly.","timeout":300000}
EOF
```

**Observe:** `.final` confirms team created.

## Step 2: Wait for Bootstrap

```bash
for i in $(seq 1 20); do
  node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const r = D.prepare(\\"SELECT bootstrapped FROM org_tree WHERE name='loggly-monitor'\\").get();
    if (r && r.bootstrapped === 1) { console.log('BOOTSTRAPPED'); process.exit(0); }
    D.close();
    process.exit(1);
  " 2>/dev/null && break
  sleep 3
done
```

## Step 3: Create and Enable Trigger

Create the trigger:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Create a schedule trigger for loggly-monitor called loggly-fetch with cron */2 * * * * and task: Fetch recent logs from Loggly using your credentials (subdomain and api_key) and report a summary of any errors found. Use the Loggly Search API.","timeout":300000}
EOF
```

**Observe:** `.final` confirms trigger created in pending state.

Enable the trigger:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Enable the loggly-fetch trigger for loggly-monitor.","timeout":300000}
EOF
```

**Observe:** `.final` confirms trigger enabled/activated.

**Verify:**
- Run: `node src/e2e/verify-suite-triggers-notifications.cjs --step after-trigger-setup`
- Checks: loggly-monitor in org_tree, trigger_configs has loggly-fetch with state='active', config.yaml has credentials, health endpoint shows registered >= 1, container logs contain "Registered schedule trigger"

Record baseline notifications:
```bash
curl -s localhost:9876/notifications -d '{"name":"main"}'
```
Note the count -- this is the baseline before the trigger fires.

## Step 4: Wait for Cron Fire

Wait up to 150s for the cron to fire and enqueue a task:
```bash
echo "Waiting for scheduled trigger to fire..."
START=$(date +%s)
FOUND=0
for i in $(seq 1 30); do
  COUNT=$(node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
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

Wait for task execution (up to 60s):
```bash
for i in $(seq 1 12); do
  STATUS=$(node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const r = D.prepare(\"SELECT status, result FROM task_queue WHERE team_id='loggly-monitor' ORDER BY created_at DESC LIMIT 1\").get();
    console.log(JSON.stringify(r));
    D.close();
  " 2>/dev/null)
  echo "  Task state: $STATUS"
  echo "$STATUS" | grep -qE '"(completed|failed)"' && break
  sleep 5
done
```

**Verify:**
- Run: `node src/e2e/verify-suite-triggers-notifications.cjs --step after-trigger-fire`
- Checks: task_queue has loggly-monitor task with status completed or failed, result column is non-null, result contains PASS indicators (401, Unauthorized, Forbidden, curl, HTTP -- proves agent attempted API call with fake creds) rather than FAIL indicators (not found, command not found, unable to complete)

**CRITICAL result quality note:** The credentials are fake, so the Loggly API SHOULD return an auth error (401/403). This is the EXPECTED outcome -- it PROVES the agent executed the HTTP call. If result says "not found" or "command not found", the `process.env` spread may have regressed.

## Step 5: Audit Logs

**Verify:**
- Run: `node src/e2e/verify-suite-triggers-notifications.cjs --step after-audit-logs`
- Checks: log_entries table has PreToolUse/PostToolUse entries with tool field in context, PostToolUse has durationMs, task consumer logs contain team and taskId in context

## Step 6: Credential Leak Check

**Verify:**
- Run: `node src/e2e/verify-suite-triggers-notifications.cjs --step after-credential-check`
- Checks: "fake-loggly-apikey-9876" does NOT appear in container logs, does NOT appear in task_queue result columns, does NOT appear in WS notification content

Additional manual check:
```bash
sudo docker logs openhive 2>&1 | grep "fake-loggly-apikey-9876" && echo "CREDENTIAL LEAK!" || echo "CLEAN"
curl -s localhost:9876/notifications -d '{"name":"main"}' | grep "fake-loggly-apikey-9876" && echo "CREDENTIAL LEAK IN NOTIFICATION!" || echo "Notification check: CLEAN"
```

## Step 7: Notification Routing Isolation

Open isolated connections and test that notifications route only to the originator:

```bash
curl -s localhost:9876/connect -d '{"name":"iso-a"}'
curl -s localhost:9876/connect -d '{"name":"iso-b"}'
```

Send a delegation from iso-a:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"iso-a","content":"Ask loggly-monitor to check recent error logs right now.","timeout":300000}
EOF
```

Wait for task completion (check DB), then test-fire the trigger from iso-a:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"iso-a","content":"Test-fire the loggly-fetch trigger for loggly-monitor.","timeout":300000}
EOF
```

Wait for test-fired task to complete (up to 60s):
```bash
for i in $(seq 1 12); do
  STATUS=$(node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const r = D.prepare(\"SELECT status FROM task_queue WHERE team_id='loggly-monitor' ORDER BY created_at DESC LIMIT 1\").get();
    console.log(JSON.stringify(r));
    D.close();
  " 2>/dev/null)
  echo "  Task state: $STATUS"
  echo "$STATUS" | grep -qE '"(completed|failed)"' && break
  sleep 5
done
```

**Verify:**
- Run: `node src/e2e/verify-suite-triggers-notifications.cjs --step after-notification-test`
- Checks: iso-a notifications count > 0 (originator got notifications), iso-b notifications count === 0 (passive listener did NOT), test-fired task has non-null source_channel_id in DB

If iso-b has notifications: sourceChannelId threading is broken -- notifications are broadcasting to all connections.

Cleanup:
```bash
curl -s localhost:9876/disconnect -d '{"name":"iso-a"}'
curl -s localhost:9876/disconnect -d '{"name":"iso-b"}'
```

## Step 8: Restart + Trigger Persistence

Record current task count:
```bash
BEFORE=$(node -e "
  const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
  const r = D.prepare(\"SELECT COUNT(*) as c FROM task_queue WHERE team_id='loggly-monitor' AND task LIKE '%Loggly%'\").get();
  console.log(r.c);
  D.close();
")
echo "Tasks before restart: $BEFORE"
```

Restart (NOT clean restart):
```bash
sudo docker restart openhive
for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
curl -s localhost:9876/reconnect -d '{"name":"main"}'
```

Wait for another cron fire after restart (up to 150s):
```bash
echo "Waiting for post-restart trigger fire..."
START=$(date +%s)
FOUND=0
for i in $(seq 1 30); do
  AFTER=$(node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const r = D.prepare(\"SELECT COUNT(*) as c FROM task_queue WHERE team_id='loggly-monitor' AND task LIKE '%Loggly%'\").get();
    console.log(r.c);
    D.close();
  " 2>/dev/null)
  if [ "$AFTER" -gt "$BEFORE" ]; then
    echo "New task enqueued after restart ($(($(date +%s) - START))s)"
    FOUND=1
    break
  fi
  sleep 5
done
[ "$FOUND" = "0" ] && echo "TIMEOUT: No new task after restart"
```

Wait for the post-restart task to execute:
```bash
for i in $(seq 1 12); do
  STATUS=$(node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const r = D.prepare(\"SELECT status, result FROM task_queue WHERE team_id='loggly-monitor' ORDER BY created_at DESC LIMIT 1\").get();
    console.log(JSON.stringify(r));
    D.close();
  " 2>/dev/null)
  echo "  Post-restart task: $STATUS"
  echo "$STATUS" | grep -qE '"(completed|failed)"' && break
  sleep 5
done
```

**Verify:**
- Run: `node src/e2e/verify-suite-triggers-notifications.cjs --step after-restart`
- Checks: container logs show "Loaded triggers from store" and "Registered schedule trigger" post-restart, health shows registered >= 1, new task enqueued and completed after restart (trigger survived)

---

# Part 2: LLM-Based Notify Decisions (from scenario 11)

This part tests that the LLM can decide whether to send a notification based on task results.

## Step 9: Create health-checker Team

```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Create a team called health-checker for silent health monitoring. Give it credentials: api_key is fake-health-key-1234. Accept keywords: health, monitoring.","timeout":300000}
EOF
```

Wait for bootstrap:
```bash
for i in $(seq 1 20); do
  node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const r = D.prepare(\\"SELECT bootstrapped FROM org_tree WHERE name='health-checker'\\").get();
    if (r && r.bootstrapped === 1) { console.log('BOOTSTRAPPED'); process.exit(0); }
    D.close();
    process.exit(1);
  " 2>/dev/null && break
  sleep 3
done
```

## Step 10: Create and Enable Silent Trigger

Create a trigger with a routine task (LLM should decide notify=false):
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Create a schedule trigger for health-checker called quiet-check with cron */2 * * * * and task: Run a routine background health check. This is a silent monitoring task — there is nothing noteworthy to report unless something is broken.","timeout":300000}
EOF
```

Enable it:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Enable the quiet-check trigger for health-checker.","timeout":300000}
EOF
```

Create a trigger with a critical task (LLM should decide notify=true):
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Create a schedule trigger for health-checker called alert-check with cron */2 * * * * and task: Check the health API status. This is a critical monitoring check — always report the result to the team channel.","timeout":300000}
EOF
```

Enable it:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Enable the alert-check trigger for health-checker.","timeout":300000}
EOF
```

## Step 11: Verify Notify Decisions

Record baseline:
```bash
BASELINE=$(curl -s localhost:9876/notifications -d '{"name":"main"}' | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('notifications',[])))")
echo "Baseline notifications: $BASELINE"
```

Wait for both triggers to fire and tasks to complete (up to 150s):
```bash
echo "Waiting for health-checker tasks..."
FOUND=0
for i in $(seq 1 30); do
  STATUS=$(node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const rows = D.prepare(\"SELECT id, status, result FROM task_queue WHERE team_id='health-checker' ORDER BY created_at DESC LIMIT 2\").all();
    console.log(JSON.stringify(rows));
    D.close();
  " 2>/dev/null)
  echo "  Tasks: $STATUS"
  COMPLETED=$(echo "$STATUS" | python3 -c "import json,sys; rows=json.load(sys.stdin); print(sum(1 for r in rows if r.get('status') in ('completed','failed')))" 2>/dev/null || echo "0")
  [ "$COMPLETED" -ge "2" ] && FOUND=1 && break
  sleep 5
done
[ "$FOUND" = "0" ] && echo "TIMEOUT: Not all tasks completed after 150s"
```

**Verify:**
- Run: `node src/e2e/verify-suite-triggers-notifications.cjs --step after-notify-decisions`
- Checks: health-checker team and both triggers exist in DB, tasks completed with non-null results, task results examined for `{"notify": false}` / `{"notify": true}` JSON blocks, notify block stripped from stored result text

Expected behavior:
- **quiet-check** (routine, nothing noteworthy): LLM should return `{"notify": false}` -- notification suppressed
- **alert-check** (critical, always report): LLM should return `{"notify": true}` -- notification delivered
- **Missing JSON block** (fail-safe): If the LLM omits the notify block entirely, the system defaults to delivering the notification

---

## Pass Criteria

All verification steps pass (summary.failed === 0 for each). Key outcomes:
- Trigger created and enabled via inline tools
- Cron trigger fired on schedule (within 150s)
- Task result populated with LLM response
- Audit logs have tool metadata (tool name, durationMs)
- Credentials never leaked to logs, task results, or notifications
- Notification routing is isolated (only originator connection receives)
- Trigger survived docker restart and fired again
- LLM notify decisions work: false suppresses, true delivers, missing = fail-safe deliver
