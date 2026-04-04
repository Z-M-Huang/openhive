# Suite E: Conversation Context + Threading (Scenarios 12, 14)

Verification script: `node src/e2e/verify-suite-context-threading.cjs --step <step>`

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

## Part 1: Conversation Context (from Scenario 12)

### 1A. Interaction Logging

**Step 1.** Send a message to main team and verify interactions are logged:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"What tools do you have available?","timeout":300000}
EOF
```
- OBSERVE: What did the AI respond?

**Step 2.** Verify inbound + outbound interactions logged to DB:
```bash
node -e "
const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
const rows = D.prepare(\"SELECT direction, channel_id, user_id, team_id, content_snippet FROM channel_interactions ORDER BY created_at DESC LIMIT 5\").all();
for (const r of rows) console.log(JSON.stringify(r));
D.close();
"
```
- Should see at least 2 rows: one `inbound` (user message) and one `outbound` (main team response)
- Inbound should have `user_id` set
- Outbound should have `team_id = 'main'`
- `content_snippet` should contain message text (truncated to 2000 chars)

**Step 3.** CRITICAL -- Verify the channel_id is the WS connection ID:
- Both inbound and outbound should share the same `channel_id` (starting with `ws:`)

### 1B. Sub-Team Notification Logging

**Step 4.** Create a sub-team and delegate a task:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Create a team called research-team for research tasks. Accept keywords: research, analysis.","timeout":300000}
EOF
```

**Step 5.** Wait for bootstrap:
```bash
for i in $(seq 1 20); do
  node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const r = D.prepare(\\"SELECT bootstrapped FROM org_tree WHERE name='research-team'\\").get();
    if (r && r.bootstrapped === 1) { console.log('BOOTSTRAPPED'); process.exit(0); }
    D.close();
    process.exit(1);
  " 2>/dev/null && break
  sleep 3
done
```

**Step 6.** Ask main to delegate to the sub-team:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Ask the research-team to analyze the benefits of microservices vs monolith architecture and report back.","timeout":300000}
EOF
```

**Step 7.** Wait for task completion notification:
```bash
sleep 30
curl -s localhost:9876/notifications -d '{"name":"main"}'
```
- Should receive a notification from research-team

**Step 8.** Verify outbound interaction logged with research-team attribution:
```bash
node -e "
const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
const rows = D.prepare(\"SELECT direction, team_id, content_snippet FROM channel_interactions WHERE team_id='research-team' ORDER BY created_at DESC LIMIT 3\").all();
for (const r of rows) console.log(JSON.stringify(r));
D.close();
"
```
- Should see at least 1 outbound row with `team_id = 'research-team'`

### 1C. Conversation Context in System Prompt

**Step 9.** Send a follow-up message and verify main sees the conversation context:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Can you tell me more about what the research-team found? I want the details of their analysis.","timeout":300000}
EOF
```
- **KEY VERIFICATION**: Main team's response should demonstrate awareness of the research-team's prior message
- The response should reference the microservices/monolith analysis topic
- If main says "I don't know what research-team found" or processes the question itself -- conversation context injection is NOT working

**Step 10.** Verify interaction count growing:
```bash
node -e "
const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
const count = D.prepare('SELECT COUNT(*) as c FROM channel_interactions').get();
console.log('Total interactions:', count.c);
const byDir = D.prepare('SELECT direction, COUNT(*) as c FROM channel_interactions GROUP BY direction').all();
for (const r of byDir) console.log(r.direction + ':', r.c);
D.close();
"
```

### 1D. 24-Hour Retention Cleanup

**Step 11.** Verify cleanup mechanism exists (check logs for interval setup):
```bash
sudo docker logs openhive 2>&1 | grep -i "cleanup\|retention\|interaction" | tail -5
```

**Step 12.** Manually verify cleanOlderThan works (insert old record, check deletion):
```bash
node -e "
const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db');
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

### Verify Part 1

```bash
node src/e2e/verify-suite-context-threading.cjs --step after-interactions
```

---

## Part 2: Threading (from Scenario 14)

### 2A. Topic Creation & Classification

**Step 13.** Send a first message (0 active topics -- auto-creates topic):
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Research the best Node.js logging libraries and compare them.","timeout":300000}
EOF
```

**Step 14.** Verify topic created in DB:
```bash
node -e "
const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
const rows = D.prepare(\"SELECT id, name, state, channel_id FROM topics ORDER BY created_at DESC LIMIT 5\").all();
console.log(JSON.stringify(rows, null, 2));
D.close();
"
```
- A row should exist with `state: 'active'` and a human-readable `name`
- `id` format should be `t-{random}`

**Step 15.** Verify WS response contains topic fields:
```bash
curl -s localhost:9876/traffic -d '{"name":"main","direction":"recv","limit":20}'
```
- Response frames should include `topic_id` (matching the DB row `id`) and `topic_name`

**Step 16.** Send an unrelated message (1 active topic -- agent evaluates inline):
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"What is the current weather forecast for San Francisco?","timeout":300000}
EOF
```

**Step 17.** Verify second topic created:
```bash
node -e "
const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
const rows = D.prepare(\"SELECT id, name, state FROM topics ORDER BY created_at DESC LIMIT 5\").all();
console.log(JSON.stringify(rows, null, 2));
D.close();
"
```
- Should now have 2 rows, each with a distinct `id` and `name`
- Both should have `state: 'active'`

**Step 18.** Send a message that matches the first topic (2+ active topics -- LLM classification):
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Actually, focus only on Winston and Pino for the logging comparison.","timeout":300000}
EOF
```

**Step 19.** Verify classification routed to the logging topic:
```bash
curl -s localhost:9876/traffic -d '{"name":"main","direction":"recv","limit":10}'
```
- The response `topic_id` should match the first topic's `id` (the logging research topic)
- The response `topic_name` should match the first topic's name

### Verify Part 2 (topic creation)

```bash
node src/e2e/verify-suite-context-threading.cjs --step after-topic-create
```

### 2B. Parallel Processing & Serialization

**Step 20.** Send messages to 2 different topics simultaneously (parallel processing):
```bash
curl -s localhost:9876/send -d '{"name":"main","content":"List the pros and cons of Winston.","timeout":300000}' &
PID1=$!
curl -s localhost:9876/send -d '{"name":"main","content":"What about the weather in New York?","timeout":300000}' &
PID2=$!
wait $PID1 $PID2
```

**Step 21.** Verify both processed (not rejected):
```bash
curl -s localhost:9876/traffic -d '{"name":"main","direction":"recv","limit":30}'
```
- Should see response frames from both topics (different `topic_id` values)
- Neither should have `type: "error"` with a "busy" or "rejected" message
- Both should have `type: "response"` terminal frames

**Step 22.** Send 2 messages to the SAME topic rapidly (serialization within topic):
```bash
curl -s localhost:9876/send -d '{"name":"main","content":"Now compare Winston performance benchmarks.","timeout":300000}' &
PID1=$!
sleep 0.5
curl -s localhost:9876/send -d '{"name":"main","content":"Also check Winston plugin ecosystem.","timeout":300000}' &
PID2=$!
wait $PID1 $PID2
```

**Step 23.** Verify second message was queued (not dropped):
```bash
curl -s localhost:9876/traffic -d '{"name":"main","direction":"recv","limit":30}'
```
- Both messages should eventually get responses (same `topic_id`)
- The second message may have been queued and processed after the first completes
- Neither should be silently dropped

### 2C. Topic Lifecycle

**Step 24.** Record the topic IDs from current state:
```bash
node -e "
const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
const rows = D.prepare(\"SELECT id, name, state, last_activity FROM topics ORDER BY created_at\").all();
console.log(JSON.stringify(rows, null, 2));
D.close();
"
```
- Record the topic IDs for later verification

**Step 25.** Wait for idle transition (topics should go idle after inactivity timeout):
```bash
echo "Waiting for topics to transition to idle..."
for i in $(seq 1 40); do
  IDLE_COUNT=$(node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const r = D.prepare(\"SELECT COUNT(*) as c FROM topics WHERE state='idle'\").get();
    console.log(r.c);
    D.close();
  " 2>/dev/null)
  if [ "$IDLE_COUNT" -gt "0" ]; then
    echo "At least $IDLE_COUNT topic(s) transitioned to idle after $((i * 5))s"
    break
  fi
  sleep 5
done
```

**Step 26.** Send a message that matches an idle topic (rehydration):
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Give me the final summary of the logging library comparison.","timeout":300000}
EOF
```

**Step 27.** Verify topic rehydrated from idle to active:
```bash
node -e "
const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
const rows = D.prepare(\"SELECT id, name, state FROM topics ORDER BY last_activity DESC LIMIT 5\").all();
console.log(JSON.stringify(rows, null, 2));
D.close();
"
```
- The logging topic should be back to `state: 'active'`

**Step 28.** Verify rehydrated session has filtered history from channel_interactions:
```bash
node -e "
const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
const topics = D.prepare(\"SELECT id, name FROM topics WHERE name LIKE '%log%' LIMIT 1\").get();
if (topics) {
  const interactions = D.prepare(\"SELECT COUNT(*) as c FROM channel_interactions WHERE topic_id=?\").get(topics.id);
  console.log('Topic:', topics.name, '- Interactions with topic_id:', interactions.c);
}
D.close();
"
```
- `channel_interactions` rows with the logging topic's `topic_id` should exist
- The response in step 26 should show awareness of prior logging discussion context

### 2D. Limits & Edge Cases

**Step 29.** Check current active topic count:
```bash
node -e "
const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
const r = D.prepare(\"SELECT COUNT(*) as c FROM topics WHERE state='active'\").get();
console.log('Active topics:', r.c);
D.close();
"
```

**Step 30.** Create additional topics to reach the limit of 5 active topics:
```bash
curl -s localhost:9876/send -d '{"name":"main","content":"Design a REST API for a bookstore application.","timeout":300000}'
curl -s localhost:9876/send -d '{"name":"main","content":"Write a Python script that generates Fibonacci numbers.","timeout":300000}'
curl -s localhost:9876/send -d '{"name":"main","content":"Explain the differences between TCP and UDP protocols.","timeout":300000}'
```

**Step 31.** Verify 5 active topics exist:
```bash
node -e "
const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
const rows = D.prepare(\"SELECT id, name, state FROM topics WHERE state='active'\").all();
console.log('Active count:', rows.length);
console.log(JSON.stringify(rows, null, 2));
D.close();
"
```
- Should show exactly 5 active topics (or close to it depending on idle transitions)

**Step 32.** Attempt to create a 6th topic (should be rejected):
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Tell me about quantum computing advancements in 2025.","timeout":300000}
EOF
```

**Step 33.** Verify rejection with topic list:
```bash
curl -s localhost:9876/traffic -d '{"name":"main","direction":"recv","limit":10}'
```
- Response should indicate max topics reached
- Response should list the active topics so the user knows which to close
- The message should NOT silently create a 6th topic

**Step 34.** Close a topic explicitly:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Close the weather topic, I'm done with that.","timeout":300000}
EOF
```

**Step 35.** Verify topic marked as done and excluded from classification:
```bash
node -e "
const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
const rows = D.prepare(\"SELECT id, name, state FROM topics ORDER BY last_activity DESC\").all();
console.log(JSON.stringify(rows, null, 2));
D.close();
"
```
- The weather topic should have `state: 'done'`
- Active count should now be 4

**Step 36.** Send an explicit @topicname: message (bypass classification):
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"@bookstore: Add pagination to the list endpoints.","timeout":300000}
EOF
```

**Step 37.** Verify bypass classification and direct routing:
```bash
curl -s localhost:9876/traffic -d '{"name":"main","direction":"recv","limit":10}'
```
- The response `topic_id` should match the bookstore API topic
- No classification call should have been needed (check container logs for absence of "Classifying message" when @topic prefix used)

### 2E. Recovery

**Step 38.** Record topic state before restart:
```bash
node -e "
const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
const rows = D.prepare(\"SELECT id, name, state FROM topics ORDER BY created_at\").all();
console.log(JSON.stringify(rows, null, 2));
D.close();
"
```

**Step 39.** Restart the container:
```bash
sudo docker restart openhive
for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
curl -s localhost:9876/reconnect -d '{"name":"main"}'
```

**Step 40.** Verify all previously active topics marked idle after restart:
```bash
node -e "
const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
const rows = D.prepare(\"SELECT id, name, state FROM topics WHERE state != 'done' ORDER BY created_at\").all();
console.log(JSON.stringify(rows, null, 2));
D.close();
"
```
- All previously `active` topics should now be `idle` (sessions were disposed on shutdown)
- Topics that were `done` before restart should remain `done`

**Step 41.** Send a message matching a previously active topic (rehydration post-restart):
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"What was the final verdict on Winston vs Pino?","timeout":300000}
EOF
```

**Step 42.** Verify topic rehydrated with history:
```bash
node -e "
const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
const rows = D.prepare(\"SELECT id, name, state FROM topics WHERE name LIKE '%log%'\").all();
console.log(JSON.stringify(rows, null, 2));
D.close();
"
```
- The logging topic should be back to `state: 'active'`
- The response in step 41 should demonstrate awareness of previous logging discussion

**Step 43.** Health check after recovery:
```bash
curl -sf http://localhost:8080/health | python3 -m json.tool
```
- Health should return 200 with "ok"

### Verify Part 2 (topic lifecycle)

```bash
node src/e2e/verify-suite-context-threading.cjs --step after-topic-lifecycle
```

---

## Report Checklist

- Inbound messages logged with userId?
- Outbound logged with teamId attribution?
- Sub-team notifications logged correctly?
- Follow-up messages show conversation awareness (main routes to right team)?
- Cleanup mechanism works (old records deleted, recent retained)?
- channel_interactions table populated correctly?
- Topics auto-created on first message?
- Second topic created for unrelated message?
- LLM classification routes correctly with 2+ topics?
- Parallel processing works across topics?
- Same-topic messages serialized (not dropped)?
- Idle transition occurs?
- Rehydration restores context?
- Max topic limit enforced with list?
- Closed topics excluded from classification?
- @topicname bypass works?
- Topics marked idle on restart?
- Post-restart rehydration works?
