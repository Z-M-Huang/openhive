# Suite F: Cascade Deletion (Scenario 13)

Verification script: `node src/e2e/verify-suite-cascade-deletion.cjs --step <step>`

---

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

Reset harness and reconnect:
```bash
curl -s localhost:9876/reset
curl -s localhost:9876/connect -d '{"name":"main"}'
```

---

## Part 1: Create Hierarchy (main -> A1 -> A11)

**Step 1.** Create team A1:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Create a team called A1 for general tasks. Accept keywords: general, tasks.","timeout":300000}
EOF
```
- VERIFY: `.final` confirms team created

**Step 2.** Wait for A1 bootstrap:
```bash
for i in $(seq 1 20); do
  test -f /app/openhive/.run/teams/A1/memory/.bootstrapped && echo "BOOTSTRAPPED" && break
  sleep 3
done
```

**Step 3.** Ask A1 to spawn child A11:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Ask A1 to create a child team called A11 for subtasks. It should accept keywords: subtasks.","timeout":300000}
EOF
```

**Step 4.** Wait for A11 bootstrap:
```bash
for i in $(seq 1 20); do
  test -f /app/openhive/.run/teams/A11/memory/.bootstrapped && echo "BOOTSTRAPPED" && break
  sleep 3
done
```

**Step 5.** Verify hierarchy exists:
```bash
node -e "
const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
console.log('org_tree:', JSON.stringify(D.prepare('SELECT name, parent_id FROM org_tree').all()));
D.close();
"
```
- A1 with parent=main, A11 with parent=A1

**Step 6.** Verify filesystem dirs exist:
```bash
ls -d /app/openhive/.run/teams/A1/ /app/openhive/.run/teams/A11/ 2>&1
```

### Verify Part 1

```bash
node src/e2e/verify-suite-cascade-deletion.cjs --step after-hierarchy-create
```

---

## Part 2: Populate Data (triggers, tasks, interactions)

**Step 7.** Create a trigger for A1:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Create a schedule trigger for A1 called cleanup-check with cron */5 * * * * and task: Check cleanup status.","timeout":300000}
EOF
```

**Step 8.** Delegate a task to A11:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Ask A1 to delegate a task to A11: Run a quick subtask check.","timeout":300000}
EOF
```

**Step 9.** Verify data exists in all tables:
```bash
node -e "
const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
console.log('org_tree:', JSON.stringify(D.prepare(\"SELECT name FROM org_tree WHERE name IN ('A1','A11')\").all()));
console.log('scope_keywords:', JSON.stringify(D.prepare(\"SELECT * FROM scope_keywords WHERE team_id IN ('A1','A11')\").all()));
console.log('trigger_configs:', JSON.stringify(D.prepare(\"SELECT team, name FROM trigger_configs WHERE team IN ('A1','A11')\").all()));
console.log('task_queue:', JSON.stringify(D.prepare(\"SELECT team_id, status FROM task_queue WHERE team_id IN ('A1','A11')\").all()));
D.close();
"
```

### Verify Part 2

```bash
node src/e2e/verify-suite-cascade-deletion.cjs --step after-data-populate
```

---

## Part 3: Cascade Shutdown + Verification

**Step 10.** Shut down A1 with cascade:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Shut down team A1 with cascade to remove all its child teams too.","timeout":300000}
EOF
```
- VERIFY: `.final` confirms shutdown

**Step 11.** Verify ALL tables cleaned for A1 and A11:
```bash
node -e "
const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
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

**Step 12.** Verify filesystem dirs removed:
```bash
test -d /app/openhive/.run/teams/A1/ && echo "A1 DIR STILL EXISTS (FAIL)" || echo "A1 dir removed (PASS)"
test -d /app/openhive/.run/teams/A11/ && echo "A11 DIR STILL EXISTS (FAIL)" || echo "A11 dir removed (PASS)"
```

**Step 13.** Verify main still healthy:
```bash
curl -s localhost:9876/send -d '{"name":"main","content":"What teams do I have now?","timeout":300000}'
```
- VERIFY: `.final` -- A1 and A11 not listed. Main still operational.

**Step 14.** Health check:
```bash
curl -sf http://localhost:8080/health | python3 -m json.tool
```

### Verify Part 3

```bash
node src/e2e/verify-suite-cascade-deletion.cjs --step after-cascade-delete
```

---

## Report Checklist

- Hierarchy created (main -> A1 -> A11)?
- Data populated in all tables (org_tree, scope_keywords, trigger_configs, task_queue)?
- Filesystem directories exist for A1 and A11?
- Cascade shutdown succeeded?
- All 6 tables cleaned for both A1 and A11 (org_tree, scope_keywords, trigger_configs, task_queue, escalation_correlations, channel_interactions)?
- Filesystem dirs removed for A1 and A11?
- trigger_dedup NOT affected (still has rows)?
- log_entries NOT affected (still has rows)?
- Main team still healthy post-deletion?
