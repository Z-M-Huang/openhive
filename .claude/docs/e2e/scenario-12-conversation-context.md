# Scenario 12: Conversation Context & Routing

**Verifies that teams see recent channel conversation in their system prompt, enabling proper routing of follow-up messages.**

**Run the Clean Restart Helper from setup.md. Then reset harness and reconnect:**
```bash
curl -s localhost:9876/reset
curl -s localhost:9876/connect -d '{"name":"main"}'
```

#### Part A: Interaction Logging

1. Send a message to main team and verify interactions are logged:
   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"What tools do you have available?","timeout":300000}
   EOF
   ```
   - OBSERVE: What did the AI respond?

2. VERIFY inbound + outbound interactions logged to DB:
   ```bash
   node -e "
   const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
   const rows = D.prepare(\"SELECT direction, channel_id, user_id, team_id, content_snippet FROM channel_interactions ORDER BY created_at DESC LIMIT 5\").all();
   for (const r of rows) console.log(JSON.stringify(r));
   D.close();
   "
   ```
   - Should see at least 2 rows: one `inbound` (user message) and one `outbound` (main team response)
   - Inbound should have `user_id` set
   - Outbound should have `team_id = 'main'`
   - `content_snippet` should contain message text (truncated to 2000 chars)

3. **CRITICAL**: Verify the channel_id is the WS connection ID:
   - Both inbound and outbound should share the same `channel_id` (starting with `ws:`)

#### Part B: Sub-Team Notification Logging

4. Create a sub-team and delegate a task:
   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Create a team called research-team for research tasks. Accept keywords: research, analysis.","timeout":300000}
   EOF
   ```

5. Wait for bootstrap:
   ```bash
   for i in $(seq 1 20); do
     test -f /app/openhive/.run/teams/research-team/memory/.bootstrapped && echo "BOOTSTRAPPED" && break
     sleep 3
   done
   ```

6. Ask main to delegate to the sub-team:
   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Ask the research-team to analyze the benefits of microservices vs monolith architecture and report back.","timeout":300000}
   EOF
   ```

7. Wait for task completion notification:
   ```bash
   sleep 30
   curl -s localhost:9876/notifications -d '{"name":"main"}'
   ```
   - Should receive a notification from research-team

8. VERIFY outbound interaction logged with research-team attribution:
   ```bash
   node -e "
   const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
   const rows = D.prepare(\"SELECT direction, team_id, content_snippet FROM channel_interactions WHERE team_id='research-team' ORDER BY created_at DESC LIMIT 3\").all();
   for (const r of rows) console.log(JSON.stringify(r));
   D.close();
   "
   ```
   - Should see at least 1 outbound row with `team_id = 'research-team'`

#### Part C: Conversation Context in System Prompt

9. Now send a follow-up message and verify main sees the conversation context:
   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Can you tell me more about what the research-team found? I want the details of their analysis.","timeout":300000}
   EOF
   ```
   - **KEY VERIFICATION**: Main team's response should demonstrate awareness of the research-team's prior message
   - The response should reference the microservices/monolith analysis topic
   - If main says "I don't know what research-team found" or processes the question itself — conversation context injection is NOT working

10. VERIFY interaction count growing:
    ```bash
    node -e "
    const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const count = D.prepare('SELECT COUNT(*) as c FROM channel_interactions').get();
    console.log('Total interactions:', count.c);
    const byDir = D.prepare('SELECT direction, COUNT(*) as c FROM channel_interactions GROUP BY direction').all();
    for (const r of byDir) console.log(r.direction + ':', r.c);
    D.close();
    "
    ```

#### Part D: 24-Hour Retention Cleanup

11. VERIFY cleanup mechanism exists (check logs for interval setup):
    ```bash
    sudo docker logs openhive 2>&1 | grep -i "cleanup\|retention\|interaction" | tail -5
    ```

12. Manually verify cleanOlderThan works (insert old record, check deletion):
    ```bash
    node -e "
    const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db');
    // Insert a deliberately old record
    D.prepare(\"INSERT INTO channel_interactions (direction, channel_type, channel_id, content_snippet, created_at) VALUES ('inbound', 'test', 'test-cleanup', 'old message', '2020-01-01T00:00:00.000Z')\").run();
    const before = D.prepare('SELECT COUNT(*) as c FROM channel_interactions').get();
    console.log('Before cleanup:', before.c);
    // Delete records older than 24 hours
    const cutoff = new Date(Date.now() - 24*60*60*1000).toISOString();
    const result = D.prepare('DELETE FROM channel_interactions WHERE created_at < ?').run(cutoff);
    console.log('Deleted:', result.changes);
    const after = D.prepare('SELECT COUNT(*) as c FROM channel_interactions').get();
    console.log('After cleanup:', after.c);
    D.close();
    "
    ```
    - Old record should be deleted
    - Recent records should remain

**Report:** Inbound messages logged with userId? Outbound logged with teamId attribution? Sub-team notifications logged correctly? Follow-up messages show conversation awareness (main routes to right team)? Cleanup mechanism works? channel_interactions table populated correctly?
