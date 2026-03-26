# Scenario 3: Multi-Team, Hierarchy, Routing & Errors

**Run the Clean Restart Helper from setup.md.**

#### Part A: Create Sibling Teams

Write a multi-turn WS script with these messages:
1. "Create a team called team-alpha for API development. Accept keywords: api, development, coding"
2. "Create a team called team-beta for operations and monitoring. Accept keywords: ops, monitoring, deployment"

Run it. Then VERIFY independently:
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

3. Send: "What teams do you have?"
   - VERIFY: Response mentions both team-alpha and team-beta with descriptions
   - VERIFY: Response is NOT "I don't have any teams" (proves list_teams was called)

4. Send: "Delegate to team-alpha: build a REST endpoint for user profiles"
   - VERIFY DB: `SELECT team_id FROM task_queue ORDER BY created_at DESC LIMIT 1` -> team-alpha

5. Send: "Delegate to team-beta: check production logs for errors"
   - VERIFY DB: `SELECT team_id FROM task_queue ORDER BY created_at DESC LIMIT 1` -> team-beta

6. Send: "Get the status of team-alpha"
   - VERIFY: Response contains status info (not an error)

#### Part C: Hierarchy — Child Team Creation

7. Send: "Ask team-alpha to create a child team called alpha-child for frontend work. Accept keywords: frontend, ui"

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

10. Send invalid JSON via WS: send raw bytes `not json at all`
    - VERIFY: Get error response, connection still alive

11. Send: `{"content":""}`
    - VERIFY: Error response

12. Send: "Create a team called team-alpha for something"
    - VERIFY: Duplicate rejection (team-alpha already exists)

13. VERIFY: `curl -sf http://localhost:8080/health` still returns 200

14. Send: "Hello, are you still working?"
    - VERIFY: Normal response (system recovered from errors)

#### Part E: Shutdown Cascade

15. Send: "Shut down team-alpha"
    - VERIFY DB: team-alpha AND alpha-child both removed from org_tree

16. Send: "Shut down team-beta"
    - VERIFY DB: team-beta removed

17. VERIFY: Health still 200 after all operations

**Report:** Teams created? Routing correct? Hierarchy correct (parent_id)? Errors handled gracefully? Shutdown cascade worked?
