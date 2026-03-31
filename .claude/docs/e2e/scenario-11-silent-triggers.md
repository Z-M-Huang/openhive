# Scenario 11: Silent Triggers (notifyPolicy)

**Prerequisite:** Scenario 4 must have completed (loggly-monitor team and trigger exist).

**Run the Clean Restart Helper from setup.md. Then reset harness and reconnect:**
```bash
curl -s localhost:9876/reset
curl -s localhost:9876/connect -d '{"name":"main"}'
```

#### Part A: Create Silent Trigger (notifyPolicy=never)

1. Create a team with a silent trigger:
   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Create a team called health-checker for silent health monitoring. Give it credentials: api_key is fake-health-key-1234. Accept keywords: health, monitoring.","timeout":300000}
   EOF
   ```
   - VERIFY: Team created with config.yaml

2. Wait for bootstrap:
   ```bash
   for i in $(seq 1 20); do
     test -f /app/openhive/.run/teams/health-checker/memory/.bootstrapped && echo "BOOTSTRAPPED" && break
     sleep 3
   done
   ```

3. Create trigger with notify_policy=never:
   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Create a schedule trigger for health-checker called silent-check with cron */2 * * * * and task: Check if the health API is responding. Report status. Set notify_policy to never — this trigger should run silently without posting to any channel.","timeout":300000}
   EOF
   ```
   - VERIFY: `.final` confirms trigger created

4. Enable the trigger:
   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Enable the silent-check trigger for health-checker.","timeout":300000}
   EOF
   ```

5. VERIFY trigger has notify_policy in DB:
   ```bash
   node -e "
   const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
   const r = D.prepare(\"SELECT name, state, notify_policy FROM trigger_configs WHERE team='health-checker' AND name='silent-check'\").get();
   console.log(JSON.stringify(r));
   D.close();
   "
   ```
   - **CRITICAL**: `notify_policy` should be `'never'`
   - `state` should be `'active'`

6. Record baseline notifications:
   ```bash
   BASELINE=$(curl -s localhost:9876/notifications -d '{"name":"main"}' | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('notifications',[])))")
   echo "Baseline notifications: $BASELINE"
   ```

#### Part B: Verify Silent Execution

7. Wait for trigger to fire and task to complete (up to 150s):
   ```bash
   echo "Waiting for silent trigger to fire..."
   START=$(date +%s)
   FOUND=0
   for i in $(seq 1 30); do
     STATUS=$(node -e "
       const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
       const r = D.prepare(\"SELECT status, result FROM task_queue WHERE team_id='health-checker' ORDER BY created_at DESC LIMIT 1\").get();
       console.log(JSON.stringify(r || {}));
       D.close();
     " 2>/dev/null)
     echo "  Task state: $STATUS"
     echo "$STATUS" | grep -qE '"(completed|failed)"' && FOUND=1 && break
     sleep 5
   done
   [ "$FOUND" = "0" ] && echo "TIMEOUT: No task completed after 150s"
   ```

8. **CRITICAL VERIFICATION — Task ran but NO notification sent:**
   ```bash
   # Task should have a result (it actually executed)
   node -e "
   const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
   const r = D.prepare(\"SELECT id, status, result FROM task_queue WHERE team_id='health-checker' ORDER BY created_at DESC LIMIT 1\").get();
   console.log('Task:', JSON.stringify(r, null, 2));
   D.close();
   "
   ```
   - Task `status` should be `'completed'` or `'failed'`
   - Task `result` should be non-null (AI actually processed the task)

   ```bash
   # But NO new notification should have been sent
   AFTER=$(curl -s localhost:9876/notifications -d '{"name":"main"}' | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('notifications',[])))")
   echo "Notifications after: $AFTER (baseline was: $BASELINE)"
   ```
   - **PASS**: `$AFTER == $BASELINE` — no new notifications (silent trigger worked!)
   - **FAIL**: `$AFTER > $BASELINE` — notification was sent despite notifyPolicy=never

9. **VERIFY task options contain notify_policy:**
   ```bash
   node -e "
   const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
   const r = D.prepare(\"SELECT options FROM task_queue WHERE team_id='health-checker' ORDER BY created_at DESC LIMIT 1\").get();
   const opts = JSON.parse(r.options || '{}');
   console.log('Task options:', JSON.stringify(opts));
   console.log('notify_policy:', opts.notify_policy);
   D.close();
   "
   ```
   - `notify_policy` should be `'never'`

#### Part C: Update to on_error and Verify

10. Update trigger to on_error policy:
    ```bash
    curl -s localhost:9876/send -d @- <<'EOF'
    {"name":"main","content":"Update the silent-check trigger for health-checker to set notify_policy to on_error.","timeout":300000}
    EOF
    ```

11. VERIFY trigger updated in DB:
    ```bash
    node -e "
    const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const r = D.prepare(\"SELECT notify_policy FROM trigger_configs WHERE team='health-checker' AND name='silent-check'\").get();
    console.log('notify_policy:', r.notify_policy);
    D.close();
    "
    ```
    - Should now be `'on_error'`

**Report:** Silent trigger created with notify_policy=never? DB has correct policy? Task executed (result stored)? NO notification sent (silent)? Policy updatable via update_trigger? Task options propagate notify_policy?
