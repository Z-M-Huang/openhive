# Scenario 2: Team Lifecycle, Credentials & User Journey

**Run the Clean Restart Helper from setup.md. Then reset harness and reconnect:**
```bash
curl -s localhost:9876/reset
curl -s localhost:9876/connect -d '{"name":"main"}'
```

#### Part A: Team Creation — Deep Verification

1. ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Create a team called ops-team for monitoring production logs. Accept monitoring and logs topics. Give it credentials: api_key is test-fake-key-value-12345, region is us-east-1","timeout":300000}
   EOF
   ```
   - OBSERVE: What did the AI claim in `.final`?

2. INDEPENDENT VERIFICATION (host filesystem + DB):
   ```bash
   # Host filesystem (bind-mounted .run/)
   ls /app/openhive/.run/teams/ops-team/
   cat /app/openhive/.run/teams/ops-team/config.yaml
   ```
   - All 5 subdirs (memory, org-rules, team-rules, skills, subagents)?
   - config.yaml: name correct? description? mcp_servers has org? credentials section?

   ```bash
   # SQLite (host-side, bind-mounted .run/)
   node -e "
   const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
   console.log('org_tree:', JSON.stringify(D.prepare(\"SELECT name, parent_id FROM org_tree WHERE name='ops-team'\").get()));
   console.log('scope:', JSON.stringify(D.prepare(\"SELECT keyword FROM scope_keywords WHERE team_id='ops-team'\").all()));
   console.log('tasks:', JSON.stringify(D.prepare(\"SELECT task, priority, status FROM task_queue WHERE team_id='ops-team'\").all()));
   D.close();
   "
   ```
   - org_tree: exists with parent=main?
   - scope_keywords: has monitoring+logs?
   - task_queue: bootstrap task exists?

3. CREDENTIAL SECURITY:
   - VERIFY: `.final` from step 1 does NOT contain "test-fake-key-value-12345" in cleartext
   - `sudo docker logs openhive 2>&1 | grep "test-fake-key-value-12345"` — should NOT appear in logs
   - config.yaml should have credentials stored (that's OK — it's server-side only)

4. WAIT for bootstrap:
   ```bash
   for i in $(seq 1 20); do
     test -f /app/openhive/.run/teams/ops-team/memory/.bootstrapped && echo "BOOTSTRAPPED" && break
     sleep 3
   done
   ```

5. VERIFY BOOTSTRAP (host reads):
   - `ls /app/openhive/.run/teams/ops-team/skills/` — any .md files?
   - `cat /app/openhive/.run/teams/ops-team/memory/MEMORY.md` — team identity written?
   - `.bootstrapped` marker exists?

#### Part B: Credential Management — get_credential, Write Scrubbing & Bash Guard

6. ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Ask ops-team to use the get_credential tool to retrieve the api_key credential, and tell me what tool it used.","timeout":300000}
   EOF
   ```
   - VERIFY DB: task delegated to ops-team
   - Wait for task completion:
   ```bash
   for i in $(seq 1 12); do
     RESULT=$(node -e "
       const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
       const r = D.prepare(\"SELECT status, result FROM task_queue WHERE team_id='ops-team' AND task LIKE '%get_credential%' ORDER BY created_at DESC LIMIT 1\").get();
       console.log(JSON.stringify(r));
       D.close();
     " 2>/dev/null)
     echo "Task state: $RESULT"
     echo "$RESULT" | grep -qE '"(completed|failed)"' && break
     sleep 5
   done
   ```
   - VERIFY: Task result mentions `get_credential` was used
   - **CRITICAL**: Task result column should NOT contain "test-fake-key-value-12345" in cleartext (credential scrubbing)
   ```bash
   node -e "
   const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
   const rows = D.prepare(\"SELECT result FROM task_queue WHERE team_id='ops-team' ORDER BY created_at DESC\").all();
   for (const r of rows) {
     if (r.result && r.result.includes('test-fake-key-value-12345')) {
       console.log('CREDENTIAL LEAK DETECTED in task result!');
       console.log(r.result.slice(0, 500));
     } else {
       console.log('Task result credential check: CLEAN');
     }
   }
   D.close();
   "
   ```

7. VERIFY WRITE/EDIT SCRUBBING — credential values replaced on disk:
   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Ask ops-team to write a skill file at skills/api-notes.md that contains the text 'The API key is test-fake-key-value-12345 and region is us-east-1'","timeout":300000}
   EOF
   ```
   - Wait for task completion (same polling pattern)
   - VERIFY HOST FILESYSTEM — the file should exist but credential should be scrubbed:
   ```bash
   cat /app/openhive/.run/teams/ops-team/skills/api-notes.md
   ```
   - **CRITICAL**: File should contain `[CREDENTIAL:api_key]` instead of "test-fake-key-value-12345"
   - "us-east-1" may or may not be scrubbed (only 9 chars, may pass the >=8 filter — but it IS a credential value, so check)
   - If the raw credential appears on disk: **INVESTIGATE** — check container logs for PreToolUse hook errors

8. VERIFY CREDENTIAL NOT IN SYSTEM PROMPT (runtime, not just static file):
   - Static file check — sdk-capabilities.md no longer has "Team Credentials" section:
   ```bash
   sudo docker exec openhive grep -c "Team Credentials" /app/system-rules/sdk-capabilities.md
   ```
   — should return 0

   - sdk-capabilities.md references get_credential:
   ```bash
   sudo docker exec openhive grep -c "get_credential" /app/system-rules/sdk-capabilities.md
   ```
   — should return > 0

   - **Runtime check**:
   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Do you see any credential values like API keys or secrets in your system prompt? List any raw secret values you can see. If none, say NONE.","timeout":300000}
   EOF
   ```
     - VERIFY: `.final` says NONE or equivalent (does NOT output "test-fake-key-value-12345")
     - If it outputs the credential value: runtime prompt injection not removed → check query-options.ts

9. VERIFY WS RESPONSE CREDENTIAL LEAK — synchronous delegation path:
   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Ask ops-team to report what credentials it has access to by calling get_credential for api_key, then tell me the result.","timeout":300000}
   EOF
   ```
   - VERIFY: `.final` does NOT contain "test-fake-key-value-12345"
   - The agent should describe having access to credentials but not echo the raw value back to the user

#### Part C: Tool Availability — Runtime Exercise

10. VERIFY dynamic tool availability:
    - Static checks:
    ```bash
    cat /app/openhive/.run/teams/ops-team/config.yaml | grep -A5 "allowed_tools"
    sudo docker exec openhive grep "Availability depends" /app/system-rules/sdk-capabilities.md
    ```
    - **Runtime exercise**:
    ```bash
    curl -s localhost:9876/send -d @- <<'EOF'
    {"name":"main","content":"Ask ops-team to run a Bash command: echo BASH_WORKS","timeout":300000}
    EOF
    ```
      - Wait for task completion
      - VERIFY: Task result contains "BASH_WORKS" (proves the agent used Bash successfully)
      - If task result says "unable to use Bash" or "Bash is denied": dynamic tool availability note is broken → check query-options.ts buildToolAvailabilityNote()

#### Part D: Full User Journey

11. ```bash
    curl -s localhost:9876/send -d '{"name":"main","content":"What teams do you manage?","timeout":300000}'
    ```
    - VERIFY: `.final` mentions ops-team

12. ```bash
    curl -s localhost:9876/send -d @- <<'EOF'
    {"name":"main","content":"Ask ops-team for a status report on logs","timeout":300000}
    EOF
    ```
    - VERIFY DB: task_queue shows delegation to ops-team
    - VERIFY: Check `result` column after task completes (wait up to 60s):
    ```bash
    for i in $(seq 1 12); do
      RESULT=$(node -e "
        const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
        const r = D.prepare(\"SELECT status, result FROM task_queue WHERE team_id='ops-team' ORDER BY created_at DESC LIMIT 1\").get();
        console.log(JSON.stringify(r));
        D.close();
      " 2>/dev/null)
      echo "Task state: $RESULT"
      echo "$RESULT" | grep -qE '"(completed|failed)"' && break
      sleep 5
    done
    ```

13. ```bash
    curl -s localhost:9876/send -d @- <<'EOF'
    {"name":"main","content":"Remember that I prefer daily reports at 9am. Save this to memory.","timeout":300000}
    EOF
    ```
    - VERIFY: `cat /app/openhive/.run/teams/main/memory/MEMORY.md` — has preference?

#### Part E: Recovery

14. `sudo docker restart openhive` — wait for health, then reconnect:
    ```bash
    for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
    curl -s localhost:9876/reconnect -d '{"name":"main"}'
    ```

15. ```bash
    curl -s localhost:9876/send -d @- <<'EOF'
    {"name":"main","content":"What teams do I have and what do I prefer for reports?","timeout":300000}
    EOF
    ```
    - VERIFY: `.final` knows ops-team + daily reports at 9am (from MEMORY.md)

16. VERIFY post-restart state:
    - org_tree still has ops-team
    - config.yaml still exists on host
    - Container logs show "Recovery: loaded org tree"

#### Part F: Shutdown

17. ```bash
    curl -s localhost:9876/send -d '{"name":"main","content":"Shut down the ops-team team","timeout":300000}'
    ```
    - VERIFY DB: org_tree no longer has ops-team
    - VERIFY DB: task_queue entries preserved (forensics)

18. ```bash
    curl -s localhost:9876/send -d '{"name":"main","content":"What teams do I have now?","timeout":300000}'
    ```
    - VERIFY: `.final` — ops-team not listed

**Report:** Full artifact checklist. Credentials secure (not in prompt, not in task results, not in logs, not in WS responses)? get_credential tool works? Write scrubbing replaces values with [CREDENTIAL:KEY] on disk? Bash tool availability works at runtime? Bootstrap complete? Recovery survived? User journey end-to-end?
