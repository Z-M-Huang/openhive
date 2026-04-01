# Scenario 13: Team Deletion Cleanup

**Run the Clean Restart Helper from setup.md. Then reset harness and reconnect:**
```bash
curl -s localhost:9876/reset
curl -s localhost:9876/connect -d '{"name":"main"}'
```

#### Part A: Create Hierarchy (main → A1 → A11)

1. Create team A1:
   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Create a team called A1 for general tasks. Accept keywords: general, tasks.","timeout":300000}
   EOF
   ```
   - VERIFY: `.final` confirms team created

2. Wait for A1 bootstrap:
   ```bash
   for i in $(seq 1 20); do
     test -f /app/openhive/.run/teams/A1/memory/.bootstrapped && echo "BOOTSTRAPPED" && break
     sleep 3
   done
   ```

3. Ask A1 to spawn child A11:
   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Ask A1 to create a child team called A11 for subtasks. It should accept keywords: subtasks.","timeout":300000}
   EOF
   ```

4. Wait for A11 bootstrap:
   ```bash
   for i in $(seq 1 20); do
     test -f /app/openhive/.run/teams/A11/memory/.bootstrapped && echo "BOOTSTRAPPED" && break
     sleep 3
   done
   ```

5. VERIFY hierarchy exists:
   ```bash
   node -e "
   const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
   console.log('org_tree:', JSON.stringify(D.prepare('SELECT name, parent_id FROM org_tree').all()));
   D.close();
   "
   ```
   - A1 with parent=main, A11 with parent=A1

#### Part B: Populate Data (triggers, tasks, interactions)

6. Create a trigger for A1:
   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Create a schedule trigger for A1 called cleanup-check with cron */5 * * * * and task: Check cleanup status.","timeout":300000}
   EOF
   ```

7. Delegate a task to A11:
   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Ask A1 to delegate a task to A11: Run a quick subtask check.","timeout":300000}
   EOF
   ```

8. VERIFY data exists in all tables:
   ```bash
   node -e "
   const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
   console.log('org_tree:', JSON.stringify(D.prepare(\"SELECT name FROM org_tree WHERE name IN ('A1','A11')\").all()));
   console.log('scope_keywords:', JSON.stringify(D.prepare(\"SELECT * FROM scope_keywords WHERE team_id IN ('A1','A11')\").all()));
   console.log('trigger_configs:', JSON.stringify(D.prepare(\"SELECT team, name FROM trigger_configs WHERE team IN ('A1','A11')\").all()));
   console.log('task_queue:', JSON.stringify(D.prepare(\"SELECT team_id, status FROM task_queue WHERE team_id IN ('A1','A11')\").all()));
   D.close();
   "
   ```

9. VERIFY filesystem dirs exist:
   ```bash
   ls -d /app/openhive/.run/teams/A1/ /app/openhive/.run/teams/A11/ 2>&1
   ```

#### Part C: Cascade Shutdown + Verification

10. Shut down A1 with cascade:
    ```bash
    curl -s localhost:9876/send -d @- <<'EOF'
    {"name":"main","content":"Shut down team A1 with cascade to remove all its child teams too.","timeout":300000}
    EOF
    ```
    - VERIFY: `.final` confirms shutdown

11. VERIFY ALL tables cleaned for A1 and A11:
    ```bash
    node -e "
    const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const checks = {
      org_tree: D.prepare(\"SELECT name FROM org_tree WHERE name IN ('A1','A11')\").all(),
      scope_keywords: D.prepare(\"SELECT * FROM scope_keywords WHERE team_id IN ('A1','A11')\").all(),
      trigger_configs: D.prepare(\"SELECT * FROM trigger_configs WHERE team IN ('A1','A11')\").all(),
      task_queue: D.prepare(\"SELECT * FROM task_queue WHERE team_id IN ('A1','A11')\").all(),
      escalation_correlations: D.prepare(\"SELECT * FROM escalation_correlations WHERE source_team IN ('A1','A11') OR target_team IN ('A1','A11')\").all(),
      channel_interactions: D.prepare(\"SELECT * FROM channel_interactions WHERE team_id IN ('A1','A11')\").all(),
    };
    for (const [table, rows] of Object.entries(checks)) {
      console.log(table + ':', rows.length === 0 ? 'CLEAN' : 'ORPHANED (' + rows.length + ' rows)');
    }
    // Verify trigger_dedup and log_entries NOT affected
    console.log('trigger_dedup:', D.prepare('SELECT count(*) as c FROM trigger_dedup').get());
    console.log('log_entries:', D.prepare('SELECT count(*) as c FROM log_entries').get());
    D.close();
    "
    ```
    - **CRITICAL**: All 6 tables should show CLEAN (0 rows for A1/A11)
    - trigger_dedup and log_entries should NOT be affected

12. VERIFY filesystem dirs removed:
    ```bash
    test -d /app/openhive/.run/teams/A1/ && echo "A1 DIR STILL EXISTS (FAIL)" || echo "A1 dir removed (PASS)"
    test -d /app/openhive/.run/teams/A11/ && echo "A11 DIR STILL EXISTS (FAIL)" || echo "A11 dir removed (PASS)"
    ```

13. VERIFY main still healthy:
    ```bash
    curl -s localhost:9876/send -d '{"name":"main","content":"What teams do I have now?","timeout":300000}'
    ```
    - VERIFY: `.final` — A1 and A11 not listed. Main still operational.

**Report:** Hierarchy created (main→A1→A11)? Data populated in all tables? Cascade shutdown succeeded? All 6 tables cleaned for both A1 and A11? Filesystem dirs removed? trigger_dedup/log_entries unaffected? Main still healthy post-deletion?
