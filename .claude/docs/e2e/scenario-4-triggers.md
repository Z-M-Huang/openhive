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

4. Write per-team triggers.yaml to the team's directory (host filesystem via bind mount):
   ```bash
   cat > /app/openhive/.run/teams/loggly-monitor/triggers.yaml << 'YAML'
   triggers:
     - name: loggly-fetch
       type: schedule
       config:
         cron: "*/2 * * * *"
       task: "Fetch recent logs from Loggly using your credentials (subdomain and api_key) and report a summary of any errors found. Use the Loggly Search API."
   YAML
   ```

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

6. Send WS (from a SEPARATE connection): "Sync the triggers for loggly-monitor team. Call sync_team_triggers with team loggly-monitor."
   - VERIFY: Response acknowledges trigger sync

7. VERIFY TRIGGER REGISTERED (no restart needed):
   ```bash
   sudo docker logs deployments-openhive-1 2>&1 | grep -i "Synced team triggers\|schedule\|trigger" | tail -10
   curl -sf http://localhost:8080/health | python3 -m json.tool
   ```
   - Health should show `"registered": 1` or higher
   - Container logs should contain "Synced team triggers"

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

10. VERIFY TASK OUTCOME:
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

12. VERIFY CREDENTIALS NOT LEAKED:
    - `sudo docker logs deployments-openhive-1 2>&1 | grep "fake-loggly-apikey-9876"` — should NOT appear
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
    sudo docker restart deployments-openhive-1
    for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
    ```

15. VERIFY TRIGGER STILL REGISTERED after restart (loaded from per-team file):
    ```bash
    sudo docker logs deployments-openhive-1 2>&1 | grep -i "Loaded team triggers\|schedule\|trigger" | tail -5
    curl -sf http://localhost:8080/health | python3 -m json.tool
    ```
    - Should see "Loaded team triggers" with team=loggly-monitor in post-restart logs
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

18. Send: "What is the status of loggly-monitor?"
    - VERIFY: Response includes status info (latestResult should be surfaced)

19. CLEANUP:
    ```bash
    rm -f /app/openhive/.run/teams/loggly-monitor/triggers.yaml
    rm -f /app/openhive/backend/ws-listener.cjs
    rm -f /tmp/ws-notifications.log
    ```

**Report:** Trigger registered via sync_team_triggers? Fired on time? Result column populated? WS notification received? Notification content correct (task summary, no credentials)? Credentials protected (logs, DB, notifications)? **Trigger survived restart and fired again?**
