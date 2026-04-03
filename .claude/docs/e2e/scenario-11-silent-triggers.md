# Scenario 11: LLM-Based Trigger Notification Decisions

**Prerequisite:** Scenario 4 must have completed (loggly-monitor team and trigger exist).

**Run the Clean Restart Helper from setup.md. Then reset harness and reconnect:**
```bash
curl -s localhost:9876/reset
curl -s localhost:9876/connect -d '{"name":"main"}'
```

#### Part A: Create Team + Trigger, Verify Notification Instruction

1. Create a team for notification testing:
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

3. Create a schedule trigger:
   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Create a schedule trigger for health-checker called silent-check with cron */2 * * * * and task: Check if the health API is responding. Report status.","timeout":300000}
   EOF
   ```
   - VERIFY: `.final` confirms trigger created

4. Enable the trigger:
   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Enable the silent-check trigger for health-checker.","timeout":300000}
   EOF
   ```

5. VERIFY trigger exists in DB:
   ```bash
   node -e "
   const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
   const r = D.prepare(\"SELECT name, state, task FROM trigger_configs WHERE team='health-checker' AND name='silent-check'\").get();
   console.log(JSON.stringify(r));
   D.close();
   "
   ```
   - `state` should be `'active'`
   - `task` should contain the health check instruction

6. Record baseline notifications:
   ```bash
   BASELINE=$(curl -s localhost:9876/notifications -d '{"name":"main"}' | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('notifications',[])))")
   echo "Baseline notifications: $BASELINE"
   ```

7. Wait for trigger to fire and task to complete (up to 150s):
   ```bash
   echo "Waiting for trigger to fire..."
   START=$(date +%s)
   FOUND=0
   for i in $(seq 1 30); do
     STATUS=$(node -e "
       const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
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

8. **CRITICAL VERIFICATION — Task includes notification instruction:**
   ```bash
   node -e "
   const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
   const r = D.prepare(\"SELECT id, status, result FROM task_queue WHERE team_id='health-checker' ORDER BY created_at DESC LIMIT 1\").get();
   console.log('Task:', JSON.stringify(r, null, 2));
   D.close();
   "
   ```
   - Task `status` should be `'completed'` or `'failed'`
   - Task `result` should be non-null (AI actually processed the task)
   - The task prompt delivered to the agent should include a notification instruction asking the LLM to decide whether to notify

#### Part B: Verify LLM notify=false Suppresses Notification

9. Create a trigger whose task instructs the LLM to suppress notification:
   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Create a schedule trigger for health-checker called quiet-check with cron */2 * * * * and task: Run a routine background health check. This is a silent monitoring task — there is nothing noteworthy to report unless something is broken.","timeout":300000}
   EOF
   ```

10. Enable the trigger:
    ```bash
    curl -s localhost:9876/send -d @- <<'EOF'
    {"name":"main","content":"Enable the quiet-check trigger for health-checker.","timeout":300000}
    EOF
    ```

11. Record baseline and wait for task completion:
    ```bash
    BASELINE_B=$(curl -s localhost:9876/notifications -d '{"name":"main"}' | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('notifications',[])))")
    echo "Baseline B notifications: $BASELINE_B"
    ```

    ```bash
    echo "Waiting for quiet-check to fire..."
    FOUND=0
    for i in $(seq 1 30); do
      STATUS=$(node -e "
        const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
        const r = D.prepare(\"SELECT id, status, result FROM task_queue WHERE team_id='health-checker' ORDER BY created_at DESC LIMIT 1\").get();
        console.log(JSON.stringify(r || {}));
        D.close();
      " 2>/dev/null)
      echo "  Task state: $STATUS"
      echo "$STATUS" | grep -qE '"(completed|failed)"' && FOUND=1 && break
      sleep 5
    done
    [ "$FOUND" = "0" ] && echo "TIMEOUT: No task completed after 150s"
    ```

12. **VERIFY — LLM returned notify=false and notification was suppressed:**
    ```bash
    node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const r = D.prepare(\"SELECT id, status, result FROM task_queue WHERE team_id='health-checker' ORDER BY created_at DESC LIMIT 1\").get();
    console.log('Task result:', r.result);
    D.close();
    "
    ```
    - Check whether the LLM's response includes a `{"notify": false}` JSON block

    ```bash
    AFTER_B=$(curl -s localhost:9876/notifications -d '{"name":"main"}' | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('notifications',[])))")
    echo "Notifications after: $AFTER_B (baseline was: $BASELINE_B)"
    ```
    - **PASS**: `$AFTER_B == $BASELINE_B` — no new notifications (LLM chose to suppress)
    - **FAIL**: `$AFTER_B > $BASELINE_B` — notification was sent despite LLM choosing not to notify

#### Part C: Verify LLM notify=true Delivers Notification

13. Create a trigger whose task has something noteworthy to report:
    ```bash
    curl -s localhost:9876/send -d @- <<'EOF'
    {"name":"main","content":"Create a schedule trigger for health-checker called alert-check with cron */2 * * * * and task: Check the health API status. This is a critical monitoring check — always report the result to the team channel.","timeout":300000}
    EOF
    ```

14. Enable the trigger:
    ```bash
    curl -s localhost:9876/send -d @- <<'EOF'
    {"name":"main","content":"Enable the alert-check trigger for health-checker.","timeout":300000}
    EOF
    ```

15. Record baseline and wait for task completion:
    ```bash
    BASELINE_C=$(curl -s localhost:9876/notifications -d '{"name":"main"}' | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('notifications',[])))")
    echo "Baseline C notifications: $BASELINE_C"
    ```

    ```bash
    echo "Waiting for alert-check to fire..."
    FOUND=0
    for i in $(seq 1 30); do
      STATUS=$(node -e "
        const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
        const r = D.prepare(\"SELECT id, status, result FROM task_queue WHERE team_id='health-checker' ORDER BY created_at DESC LIMIT 1\").get();
        console.log(JSON.stringify(r || {}));
        D.close();
      " 2>/dev/null)
      echo "  Task state: $STATUS"
      echo "$STATUS" | grep -qE '"(completed|failed)"' && FOUND=1 && break
      sleep 5
    done
    [ "$FOUND" = "0" ] && echo "TIMEOUT: No task completed after 150s"
    ```

16. **VERIFY — LLM returned notify=true and notification was delivered:**
    ```bash
    node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const r = D.prepare(\"SELECT id, status, result FROM task_queue WHERE team_id='health-checker' ORDER BY created_at DESC LIMIT 1\").get();
    console.log('Task result:', r.result);
    D.close();
    "
    ```
    - Check whether the LLM's response includes a `{"notify": true}` JSON block

    ```bash
    AFTER_C=$(curl -s localhost:9876/notifications -d '{"name":"main"}' | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('notifications',[])))")
    echo "Notifications after: $AFTER_C (baseline was: $BASELINE_C)"
    ```
    - **PASS**: `$AFTER_C > $BASELINE_C` — notification delivered (LLM chose to notify)
    - **FAIL**: `$AFTER_C == $BASELINE_C` — notification not delivered despite LLM choosing to notify

#### Part D: Verify Missing JSON Block Triggers Fail-Safe Notification

17. **VERIFY fail-safe behavior** — check that if the LLM response does NOT contain a valid `{"notify": ...}` JSON block, the system defaults to delivering the notification (fail-safe = always notify).

    Review the completed tasks from Parts B and C:
    ```bash
    node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const rows = D.prepare(\"SELECT id, status, result FROM task_queue WHERE team_id='health-checker' ORDER BY created_at DESC LIMIT 5\").all();
    rows.forEach(r => {
      const hasBlock = r.result && /\{[^}]*\"notify\"\s*:/.test(r.result);
      console.log('Task', r.id, '- status:', r.status, '- has notify block:', hasBlock);
    });
    D.close();
    "
    ```
    - For any task where the LLM did NOT include a `{"notify": ...}` block, a notification should have been delivered (fail-safe behavior)
    - **PASS**: Missing block = notification delivered
    - **FAIL**: Missing block = notification suppressed (fail-safe is broken)

18. **VERIFY JSON block stripped from stored content:**
    ```bash
    node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const rows = D.prepare(\"SELECT id, result FROM task_queue WHERE team_id='health-checker' ORDER BY created_at DESC LIMIT 5\").all();
    rows.forEach(r => {
      const hasBlock = r.result && /\{[^}]*\"notify\"\s*:/.test(r.result);
      console.log('Task', r.id, '- notify block in stored result:', hasBlock);
      if (hasBlock) console.log('  WARNING: JSON block should be stripped from stored content');
    });
    D.close();
    "
    ```
    - **PASS**: No `{"notify": ...}` block found in stored result text (it was extracted and stripped)
    - **FAIL**: JSON block still present in stored result

**Report:** Trigger task includes notification instruction? LLM notify=false suppresses notification? LLM notify=true delivers notification? Missing JSON block triggers fail-safe (notification delivered)? JSON block stripped from stored content?
