# Scenario 4: Scheduled Jobs, Notifications & Error Propagation

**Run the Clean Restart Helper from setup.md. Then reset harness and reconnect:**
```bash
curl -s localhost:9876/reset
curl -s localhost:9876/connect -d '{"name":"main"}'
```

#### Part A: Team Setup & Trigger Configuration

1. ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Create a team called loggly-monitor for monitoring Loggly logs. Give it credentials: subdomain is test, api_key is fake-loggly-apikey-9876. Accept keywords: logs, monitoring, loggly.","timeout":300000}
   EOF
   ```
   - OBSERVE: What did the AI claim in `.final`?

2. VERIFY (host filesystem + DB):
   ```bash
   ls /app/openhive/.run/teams/loggly-monitor/
   cat /app/openhive/.run/teams/loggly-monitor/config.yaml
   ```
   - Has credentials with subdomain and api_key?

   ```bash
   node -e "
   const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
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

4. Create and activate a trigger via MCP tools:
   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Create a schedule trigger for loggly-monitor called loggly-fetch with cron */2 * * * * and task: Fetch recent logs from Loggly using your credentials (subdomain and api_key) and report a summary of any errors found. Use the Loggly Search API.","timeout":300000}
   EOF
   ```
   - VERIFY: `.final` confirms trigger created in pending state

   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Enable the loggly-fetch trigger for loggly-monitor.","timeout":300000}
   EOF
   ```
   - VERIFY: `.final` confirms trigger enabled/activated

   VERIFY trigger in DB:
   ```bash
   node -e "
   const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
   console.log('trigger:', JSON.stringify(D.prepare(\"SELECT name, type, state, task FROM trigger_configs WHERE team='loggly-monitor'\").get()));
   D.close();
   "
   ```
   - Trigger should exist with state='active'

5. Record current notification state (baseline for detecting new notifications):
   ```bash
   curl -s localhost:9876/notifications -d '{"name":"main"}'
   ```
   Note the count — this is the baseline before trigger fires.

6. VERIFY TRIGGER REGISTERED (no restart needed):
   ```bash
   sudo docker logs openhive 2>&1 | grep -i "Registered schedule\|schedule\|trigger" | tail -10
   curl -sf http://localhost:8080/health | python3 -m json.tool
   ```
   - Health should show `"registered": 1` or higher
   - Container logs should contain "Registered schedule trigger"

#### Part B: Trigger Firing, Notifications & Error Propagation (continues from Part A — NO restart)

8. Wait for cron fire (up to 150s):
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

9. Wait for execution (up to 60s):
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

10. VERIFY TASK OUTCOME — agent must have ATTEMPTED the HTTP call:
    ```bash
    node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const rows = D.prepare(\"SELECT id, status, result, task FROM task_queue WHERE team_id='loggly-monitor'\").all();
    console.log(JSON.stringify(rows, null, 2));
    D.close();
    "
    ```
    - Task should be completed or failed
    - **`result` column should contain the LLM response text** (task result capture)
    - **CRITICAL — Validate result quality.** The credentials are fake, so the Loggly API SHOULD return an auth error (401/403). This is the EXPECTED outcome — it PROVES the agent successfully executed the HTTP call.
      - **PASS indicators** (agent reached the API): result mentions `401`, `403`, `Unauthorized`, `Forbidden`, `authentication failed`, `invalid token`, `loggly.com`, `curl`, `HTTP`, or similar API error responses
      - **FAIL indicators** (env/PATH broken — regression): result mentions `not found`, `command not found`, `no HTTP client tools`, `unable to complete`, `doesn't have the necessary`, or `cannot execute`
      - If FAIL indicators are present, the `process.env` spread in `query-options.ts:164` may have regressed — investigate immediately

10b. VERIFY LOG QUALITY — entries must contain metadata:
    ```bash
    node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const rows = D.prepare(\"SELECT message, context FROM log_entries WHERE message IN ('PreToolUse','PostToolUse') ORDER BY created_at DESC LIMIT 5\").all();
    for (const r of rows) {
      const ctx = JSON.parse(r.context || '{}');
      console.log(JSON.stringify({ msg: r.message, tool: ctx.tool, hasParams: !!ctx.params, hasDuration: !!ctx.durationMs }));
    }
    D.close();
    "
    ```
    - PreToolUse MUST have `tool` field (e.g., "Read", "Bash")
    - PostToolUse MUST have `tool` + `durationMs`
    - If bare `{"msg":"PreToolUse"}` only → adaptLogger() broken

11. **VERIFY WS NOTIFICATION RECEIVED:**
    ```bash
    curl -s localhost:9876/notifications -d '{"name":"main"}'
    ```
    - Should have received a notification (count > baseline from step 5)
    - Notification content should mention "loggly-monitor" and "Task completed"
    - **CRITICAL**: Notification content should NOT contain credential values ("fake-loggly-apikey-9876")

11c. **VERIFY NOTIFICATION ROUTING ISOLATION (sourceChannelId):**
    This test verifies that task completion notifications go ONLY to the originating WS connection, not broadcast to all.

    ```bash
    # Open two connections
    curl -s localhost:9876/connect -d '{"name":"iso-a"}'
    curl -s localhost:9876/connect -d '{"name":"iso-b"}'
    ```

    ```bash
    # Send a delegate_task request from iso-a
    curl -s localhost:9876/send -d @- <<'EOF'
    {"name":"iso-a","content":"Ask loggly-monitor to check recent error logs right now.","timeout":300000}
    EOF
    ```

    Wait for task completion (check DB), then verify notification isolation:
    ```bash
    curl -s localhost:9876/notifications -d '{"name":"iso-a"}'
    curl -s localhost:9876/notifications -d '{"name":"iso-b"}'
    ```

    **Expected:**
    - `iso-a` notifications count > 0 — originator got the notification
    - `iso-b` notifications count === 0 — passive listener did NOT
    - If iso-b has notifications: The `sourceChannelId` threading is broken — notifications are still broadcasting to all connections.

    ```bash
    curl -s localhost:9876/disconnect -d '{"name":"iso-a"}'
    curl -s localhost:9876/disconnect -d '{"name":"iso-b"}'
    ```

11e. **VERIFY test_trigger NOTIFICATION ROUTING (sourceChannelId via scoped queue):**
    This test verifies that `test_trigger` correctly routes notifications only to the originating WS connection.

    ```bash
    curl -s localhost:9876/connect -d '{"name":"trig-a"}'
    curl -s localhost:9876/connect -d '{"name":"trig-b"}'
    ```

    ```bash
    curl -s localhost:9876/send -d @- <<'EOF'
    {"name":"trig-a","content":"Test-fire the loggly-fetch trigger for loggly-monitor.","timeout":300000}
    EOF
    ```

    Wait for test-fired task completion, then verify:
    ```bash
    curl -s localhost:9876/notifications -d '{"name":"trig-a"}'
    curl -s localhost:9876/notifications -d '{"name":"trig-b"}'
    ```

    **Expected:** `trig-a` has notification, `trig-b` does NOT (`isolation_pass`).

    Also verify the test-fired task has sourceChannelId in DB:
    ```bash
    node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const r = D.prepare(\"SELECT id, source_channel_id, options FROM task_queue WHERE correlation_id LIKE 'test-trigger:%' ORDER BY created_at DESC LIMIT 1\").get();
    console.log(JSON.stringify(r, null, 2));
    D.close();
    "
    ```
    - `source_channel_id` should be non-null (a `ws:` prefixed value)
    - `options` JSON should contain both `max_turns` and `sourceChannelId`

    ```bash
    curl -s localhost:9876/disconnect -d '{"name":"trig-a"}'
    curl -s localhost:9876/disconnect -d '{"name":"trig-b"}'
    ```

11d. VERIFY TASK CONSUMER LOGS contain team context:
    ```bash
    node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const rows = D.prepare(\"SELECT message, context FROM log_entries WHERE message LIKE '%Task%' ORDER BY created_at DESC LIMIT 3\").all();
    for (const r of rows) {
      const ctx = JSON.parse(r.context || '{}');
      console.log(JSON.stringify({ msg: r.message, team: ctx.team, taskId: ctx.taskId }));
    }
    D.close();
    "
    ```
    - 'Task completed'/'Task failed' MUST have `team` and `taskId` in context

12. VERIFY CREDENTIALS NOT LEAKED:
    - `sudo docker logs openhive 2>&1 | grep "fake-loggly-apikey-9876"` — should NOT appear
    - Check result column text for credential values
    - Check notification content for credential values:
    ```bash
    curl -s localhost:9876/notifications -d '{"name":"main"}' | grep "fake-loggly-apikey-9876" && echo "CREDENTIAL LEAK IN NOTIFICATION!" || echo "Notification credential check: CLEAN"
    ```

#### Part C: Trigger Persistence Across Restart (continues — NO clean restart)

13. Record current task count:
    ```bash
    BEFORE=$(node -e "
      const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
      const r = D.prepare(\"SELECT COUNT(*) as c FROM task_queue WHERE team_id='loggly-monitor' AND task LIKE '%Loggly%'\").get();
      console.log(r.c);
      D.close();
    ")
    echo "Tasks before restart: $BEFORE"
    ```

14. Restart the container and reconnect:
    ```bash
    sudo docker restart openhive
    for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
    curl -s localhost:9876/reconnect -d '{"name":"main"}'
    ```

15. VERIFY TRIGGER STILL REGISTERED after restart (loaded from SQLite trigger_configs):
    ```bash
    sudo docker logs openhive 2>&1 | grep -i "Loaded triggers from store\|schedule\|trigger" | tail -5
    curl -sf http://localhost:8080/health | python3 -m json.tool
    ```
    - Should see "Loaded triggers from store" with active=1 in post-restart logs
    - Should see "Registered schedule trigger" in post-restart logs
    - Health should show `"registered": 1`

16. Wait for another cron fire after restart (up to 150s):
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

17. VERIFY the new task executes:
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
    - Task should complete/fail with result populated (trigger survived restart)
    - Apply the same result quality check as step 10: look for PASS indicators (401, Unauthorized, curl, HTTP) vs FAIL indicators (not found, unable to complete)

18. ```bash
    curl -s localhost:9876/send -d @- <<'EOF'
    {"name":"main","content":"What is the status of loggly-monitor?","timeout":300000}
    EOF
    ```
    - VERIFY: `.final` includes status info (latestResult should be surfaced)

**Report:** Trigger created and enabled via MCP tools? Fired on time? Result column populated? WS notification received? Notification content correct (task summary, no credentials)? Credentials protected (logs, DB, notifications)? Notification routing isolation works? **Trigger survived restart and fired again?**
