# Scenario 4: Scheduled Jobs, Notifications & Error Propagation

**Run the Clean Restart Helper from setup.md.**

#### Part A: Team Setup & Trigger Configuration

1. Send: "Create a team called loggly-monitor for monitoring Loggly logs. Give it credentials: subdomain is test, api_key is fake-loggly-apikey-9876. Accept keywords: logs, monitoring, loggly."
   - OBSERVE: What did the AI claim?

2. VERIFY (host filesystem + DB):
   ```bash
   ls /app/openhive/.run/teams/loggly-monitor/
   cat /app/openhive/.run/teams/loggly-monitor/config.yaml
   ```
   - Has credentials with subdomain and api_key?
   - Has mcp_servers including org?

   ```bash
   node -e "
   const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
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

4. Create and activate a trigger via MCP tools (from WS connection):
   Send: "Create a schedule trigger for loggly-monitor called loggly-fetch with cron */2 * * * * and task: Fetch recent logs from Loggly using your credentials (subdomain and api_key) and report a summary of any errors found. Use the Loggly Search API."
   - VERIFY: Response confirms trigger created in pending state

   Send: "Enable the loggly-fetch trigger for loggly-monitor."
   - VERIFY: Response confirms trigger enabled/activated

   VERIFY trigger in DB:
   ```bash
   node -e "
   const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
   console.log('trigger:', JSON.stringify(D.prepare(\"SELECT name, type, state, task FROM trigger_configs WHERE team='loggly-monitor'\").get()));
   D.close();
   "
   ```
   - Trigger should exist with state='active'

5. **START NOTIFICATION LISTENER** — open a WS connection in background to capture notifications:
   ```bash
   cat > /app/openhive/backend/ws-listener.cjs << 'EOF'
   const WebSocket = require('ws');
   const ws = new WebSocket('ws://localhost:8080/ws');
   ws.on('open', () => console.log('LISTENER_CONNECTED'));
   ws.on('message', (d) => {
     const p = JSON.parse(d.toString());
     console.log(JSON.stringify({ ts: new Date().toISOString(), type: p.type, content: (p.content || p.error || '').slice(0, 300) }));
   });
   ws.on('close', () => { console.log('DISCONNECTED'); process.exit(0); });
   ws.on('error', (e) => { console.error('WS_ERROR:', e.message); process.exit(1); });
   setTimeout(() => { console.log('LISTENER_TIMEOUT'); ws.close(); process.exit(0); }, 300000);
   EOF
   node /app/openhive/backend/ws-listener.cjs > /tmp/ws-notifications.log 2>&1 &
   LISTENER_PID=$!
   echo "Listener PID: $LISTENER_PID"
   sleep 2
   cat /tmp/ws-notifications.log  # Should show LISTENER_CONNECTED
   ```

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
       const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
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
       const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
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
    const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
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
    const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
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
    echo "=== Notification log ==="
    cat /tmp/ws-notifications.log
    echo "=== Checking for notification type ==="
    grep '"type":"notification"' /tmp/ws-notifications.log && echo "NOTIFICATION RECEIVED" || echo "NO NOTIFICATION"
    ```
    - The listener should have received a `{ type: "notification" }` message after the background task completed
    - The notification content should mention "loggly-monitor" and "Task completed"
    - **CRITICAL**: Notification content should NOT contain credential values ("fake-loggly-apikey-9876")

11c. **VERIFY NOTIFICATION ROUTING ISOLATION (sourceChannelId):**
    This test verifies that task completion notifications go ONLY to the originating WS connection, not broadcast to all.

    ```bash
    # Create two-connection isolation test script
    cat > /app/openhive/backend/ws-isolation.cjs << 'ISOEOF'
    const WebSocket = require('ws');
    // Connection A: sends a delegate_task request
    const wsA = new WebSocket('ws://localhost:8080/ws');
    // Connection B: passive listener (should NOT receive task notification)
    const wsB = new WebSocket('ws://localhost:8080/ws');
    const notifsA = [];
    const notifsB = [];
    let ready = 0;

    function onReady() {
      ready++;
      if (ready === 2) {
        // Both connected — send a message from A that triggers delegate_task
        wsA.send(JSON.stringify({ content: 'Ask loggly-monitor to check recent error logs right now.' }));
      }
    }

    wsA.on('open', onReady);
    wsB.on('open', onReady);

    wsA.on('message', (d) => {
      const p = JSON.parse(d.toString());
      if (p.type === 'notification') notifsA.push(p);
    });
    wsB.on('message', (d) => {
      const p = JSON.parse(d.toString());
      if (p.type === 'notification') notifsB.push(p);
    });

    // Wait up to 180s for task to complete and notification to arrive
    setTimeout(() => {
      console.log(JSON.stringify({
        connectionA_notifications: notifsA.length,
        connectionB_notifications: notifsB.length,
        isolation_pass: notifsA.length > 0 && notifsB.length === 0,
        a_content: notifsA.map(n => (n.content || '').slice(0, 200)),
        b_content: notifsB.map(n => (n.content || '').slice(0, 200)),
      }, null, 2));
      wsA.close(); wsB.close();
      process.exit(0);
    }, 180000);

    wsA.on('error', (e) => { console.error('A_ERROR:', e.message); });
    wsB.on('error', (e) => { console.error('B_ERROR:', e.message); });
    ISOEOF
    node /app/openhive/backend/ws-isolation.cjs > /tmp/ws-isolation.log 2>&1 &
    ISOLATION_PID=$!
    echo "Isolation test PID: $ISOLATION_PID"
    ```

    After the task completes (check DB for status), stop the script and verify:
    ```bash
    kill $ISOLATION_PID 2>/dev/null || true
    echo "=== Isolation test result ==="
    cat /tmp/ws-isolation.log
    ```

    **Expected:**
    - `connectionA_notifications > 0` — originator got the notification
    - `connectionB_notifications === 0` — passive listener did NOT
    - `isolation_pass === true`

    **If `isolation_pass` is false:** The `sourceChannelId` threading is broken — notifications are still broadcasting to all connections.

    ```bash
    rm -f /app/openhive/backend/ws-isolation.cjs /tmp/ws-isolation.log
    ```

11e. **VERIFY test_trigger NOTIFICATION ROUTING (sourceChannelId via scoped queue):**
    This test verifies that `test_trigger` (which was previously broken — missing sourceChannelId threading)
    now correctly routes notifications only to the originating WS connection via the registry's `scopeQueue` wrapper.

    ```bash
    cat > /app/openhive/backend/ws-scenario-4-trigger.cjs << 'TRIGEOF'
    const WebSocket = require('ws');
    // Connection A: sends test_trigger request
    const wsA = new WebSocket('ws://localhost:8080/ws');
    // Connection B: passive listener (should NOT receive notification)
    const wsB = new WebSocket('ws://localhost:8080/ws');
    const notifsA = [];
    const notifsB = [];
    let ready = 0;

    function onReady() {
      ready++;
      if (ready === 2) {
        wsA.send(JSON.stringify({ content: 'Test-fire the loggly-fetch trigger for loggly-monitor.' }));
      }
    }

    wsA.on('open', onReady);
    wsB.on('open', onReady);

    wsA.on('message', (d) => {
      const p = JSON.parse(d.toString());
      if (p.type === 'notification') notifsA.push(p);
    });
    wsB.on('message', (d) => {
      const p = JSON.parse(d.toString());
      if (p.type === 'notification') notifsB.push(p);
    });

    setTimeout(() => {
      console.log(JSON.stringify({
        test: 'test_trigger_routing',
        connectionA_notifications: notifsA.length,
        connectionB_notifications: notifsB.length,
        isolation_pass: notifsA.length > 0 && notifsB.length === 0,
      }, null, 2));
      wsA.close(); wsB.close();
      process.exit(0);
    }, 180000);

    wsA.on('error', (e) => { console.error('A_ERROR:', e.message); });
    wsB.on('error', (e) => { console.error('B_ERROR:', e.message); });
    TRIGEOF
    node /app/openhive/backend/ws-scenario-4-trigger.cjs > /tmp/ws-trigger-isolation.log 2>&1 &
    TRIGGER_ISO_PID=$!
    echo "test_trigger isolation PID: $TRIGGER_ISO_PID"
    ```

    After the test-fired task completes, stop and verify:
    ```bash
    kill $TRIGGER_ISO_PID 2>/dev/null || true
    echo "=== test_trigger isolation result ==="
    cat /tmp/ws-trigger-isolation.log
    ```

    **Expected:** `isolation_pass === true` (Connection A got notification, Connection B did not).

    Also verify the test-fired task has sourceChannelId in DB:
    ```bash
    node -e "
    const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const r = D.prepare(\"SELECT id, source_channel_id, options FROM task_queue WHERE correlation_id LIKE 'test-trigger:%' ORDER BY created_at DESC LIMIT 1\").get();
    console.log(JSON.stringify(r, null, 2));
    D.close();
    "
    ```
    - `source_channel_id` should be non-null (a `ws:` prefixed value)
    - `options` JSON should contain both `max_turns` and `sourceChannelId`

    ```bash
    rm -f /app/openhive/backend/ws-scenario-4-trigger.cjs /tmp/ws-trigger-isolation.log
    ```

11d. VERIFY TASK CONSUMER LOGS contain team context:
    ```bash
    node -e "
    const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
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
    - Check notification log for credential values:
    ```bash
    grep "fake-loggly-apikey-9876" /tmp/ws-notifications.log && echo "CREDENTIAL LEAK IN NOTIFICATION!" || echo "Notification credential check: CLEAN"
    ```

#### Part C: Trigger Persistence Across Restart (continues — NO clean restart)

13. Kill the notification listener and record current task count:
    ```bash
    kill $LISTENER_PID 2>/dev/null || true
    BEFORE=$(node -e "
      const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
      const r = D.prepare(\"SELECT COUNT(*) as c FROM task_queue WHERE team_id='loggly-monitor' AND task LIKE '%Loggly%'\").get();
      console.log(r.c);
      D.close();
    ")
    echo "Tasks before restart: $BEFORE"
    ```

14. Restart the container:
    ```bash
    sudo docker restart openhive
    for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
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
        const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
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
        const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
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

18. Send: "What is the status of loggly-monitor?"
    - VERIFY: Response includes status info (latestResult should be surfaced)

19. CLEANUP:
    ```bash
    rm -f /app/openhive/backend/ws-listener.cjs
    rm -f /tmp/ws-notifications.log
    ```

**Report:** Trigger created and enabled via MCP tools? Fired on time? Result column populated? WS notification received? Notification content correct (task summary, no credentials)? Credentials protected (logs, DB, notifications)? **Trigger survived restart and fired again?**
