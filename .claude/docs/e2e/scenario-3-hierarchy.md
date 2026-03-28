# Scenario 3: Multi-Team, Hierarchy, Routing & Errors

**Run the Clean Restart Helper from setup.md. Then reset harness and reconnect:**
```bash
curl -s localhost:9876/reset
curl -s localhost:9876/connect -d '{"name":"main"}'
```

#### Part A: Create Sibling Teams

1. ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Create a team called team-alpha for API development. Accept keywords: api, development, coding","timeout":300000}
   EOF
   ```

2. ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Create a team called team-beta for operations and monitoring. Accept keywords: ops, monitoring, deployment","timeout":300000}
   EOF
   ```

VERIFY independently:
```bash
# Host filesystem
cat /app/openhive/.run/teams/team-alpha/config.yaml
cat /app/openhive/.run/teams/team-beta/config.yaml

# SQLite (host-side, bind-mounted .run/)
node -e "
const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
console.log('alpha:', JSON.stringify(D.prepare(\"SELECT name, parent_id FROM org_tree WHERE name='team-alpha'\").get()));
console.log('beta:', JSON.stringify(D.prepare(\"SELECT name, parent_id FROM org_tree WHERE name='team-beta'\").get()));
console.log('alpha_scope:', JSON.stringify(D.prepare(\"SELECT keyword FROM scope_keywords WHERE team_id='team-alpha'\").all()));
console.log('beta_scope:', JSON.stringify(D.prepare(\"SELECT keyword FROM scope_keywords WHERE team_id='team-beta'\").all()));
D.close();
"
```
- Both have parent_id=main, both configs have mcp_servers including org
- Correct scope keywords for each

#### Part B: list_teams & Routing

3. ```bash
   curl -s localhost:9876/send -d '{"name":"main","content":"What teams do you have?","timeout":300000}'
   ```
   - VERIFY: `.final` mentions both team-alpha and team-beta with descriptions
   - VERIFY: `.final` is NOT "I don't have any teams" (proves list_teams was called)

4. ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Delegate to team-alpha: build a REST endpoint for user profiles","timeout":300000}
   EOF
   ```
   - VERIFY DB: `SELECT team_id FROM task_queue ORDER BY created_at DESC LIMIT 1` -> team-alpha

5. ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Delegate to team-beta: check production logs for errors","timeout":300000}
   EOF
   ```
   - VERIFY DB: `SELECT team_id FROM task_queue ORDER BY created_at DESC LIMIT 1` -> team-beta

6. ```bash
   curl -s localhost:9876/send -d '{"name":"main","content":"Get the status of team-alpha","timeout":300000}'
   ```
   - VERIFY: `.final` contains status info (not an error)

#### Part C: Hierarchy — Child Team Creation

7. ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Ask team-alpha to create a child team called alpha-child for frontend work. Accept keywords: frontend, ui","timeout":300000}
   EOF
   ```

8. Wait for alpha-child bootstrap:
   ```bash
   for i in $(seq 1 20); do
     test -f /app/openhive/.run/teams/alpha-child/memory/.bootstrapped && echo "BOOTSTRAPPED" && break
     sleep 3
   done
   ```

9. VERIFY hierarchy:
   ```bash
   node -e "
   const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
   console.log(JSON.stringify(D.prepare(\"SELECT name, parent_id FROM org_tree WHERE name='alpha-child'\").get()));
   D.close();
   "
   ```
   - parent_id should be team-alpha (NOT main)

#### Part D: Error Handling

10. Send invalid JSON via harness:
    ```bash
    curl -s localhost:9876/send_raw -d '{"name":"main","payload":"not json at all","timeout":10000}'
    ```
    - VERIFY: `.exchange` contains an error frame, connection still alive

11. Send empty content:
    ```bash
    curl -s localhost:9876/send_raw -d '{"name":"main","payload":"{\"content\":\"\"}","timeout":10000}'
    ```
    - VERIFY: Error response

12. ```bash
    curl -s localhost:9876/send -d @- <<'EOF'
    {"name":"main","content":"Create a team called team-alpha for something","timeout":300000}
    EOF
    ```
    - VERIFY: Duplicate rejection (team-alpha already exists)

13. VERIFY: `curl -sf http://localhost:8080/health` still returns 200

14. ```bash
    curl -s localhost:9876/send -d '{"name":"main","content":"Hello, are you still working?","timeout":300000}'
    ```
    - VERIFY: Normal response (system recovered from errors)

#### Part E: Shutdown Cascade

15. ```bash
    curl -s localhost:9876/send -d '{"name":"main","content":"Shut down team-alpha","timeout":300000}'
    ```
    - VERIFY DB: team-alpha AND alpha-child both removed from org_tree

16. ```bash
    curl -s localhost:9876/send -d '{"name":"main","content":"Shut down team-beta","timeout":300000}'
    ```
    - VERIFY DB: team-beta removed

17. VERIFY: Health still 200 after all operations

**Report:** Teams created? Routing correct? Hierarchy correct (parent_id)? Errors handled gracefully? Shutdown cascade worked?
