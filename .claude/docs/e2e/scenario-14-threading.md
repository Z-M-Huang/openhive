# Scenario 14: Conversation Threading (Topics)

**Run the Clean Restart Helper from setup.md. Then reset harness and reconnect:**
```bash
curl -s localhost:9876/reset
curl -s localhost:9876/connect -d '{"name":"main"}'
```

This scenario tests topic-based conversation threading: topic creation, classification, parallel processing, lifecycle transitions, limits, and recovery after restart.

#### Part A: Topic Creation & Classification

1. Send a first message (0 active topics -- auto-creates topic):
   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Research the best Node.js logging libraries and compare them.","timeout":300000}
   EOF
   ```

2. VERIFY topic created in DB:
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

3. VERIFY WS response contains topic fields:
   ```bash
   curl -s localhost:9876/traffic -d '{"name":"main","direction":"recv","limit":20}'
   ```
   - Response frames should include `topic_id` (matching the DB row `id`) and `topic_name`

4. Send an unrelated message (1 active topic -- agent evaluates inline):
   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"What is the current weather forecast for San Francisco?","timeout":300000}
   EOF
   ```

5. VERIFY second topic created:
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

6. Send a message that matches the first topic (2+ active topics -- LLM classification):
   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Actually, focus only on Winston and Pino for the logging comparison.","timeout":300000}
   EOF
   ```

7. VERIFY classification routed to the logging topic:
   ```bash
   curl -s localhost:9876/traffic -d '{"name":"main","direction":"recv","limit":10}'
   ```
   - The response `topic_id` should match the first topic's `id` (the logging research topic)
   - The response `topic_name` should match the first topic's name

#### Part B: Parallel Processing & Serialization

8. Send messages to 2 different topics simultaneously (parallel processing):
   ```bash
   curl -s localhost:9876/send -d '{"name":"main","content":"List the pros and cons of Winston.","timeout":300000}' &
   PID1=$!
   curl -s localhost:9876/send -d '{"name":"main","content":"What about the weather in New York?","timeout":300000}' &
   PID2=$!
   wait $PID1 $PID2
   ```

9. VERIFY both processed (not rejected):
   ```bash
   curl -s localhost:9876/traffic -d '{"name":"main","direction":"recv","limit":30}'
   ```
   - Should see response frames from both topics (different `topic_id` values)
   - Neither should have `type: "error"` with a "busy" or "rejected" message
   - Both should have `type: "response"` terminal frames

10. Send 2 messages to the SAME topic rapidly (serialization within topic):
    ```bash
    curl -s localhost:9876/send -d '{"name":"main","content":"Now compare Winston performance benchmarks.","timeout":300000}' &
    PID1=$!
    sleep 0.5
    curl -s localhost:9876/send -d '{"name":"main","content":"Also check Winston plugin ecosystem.","timeout":300000}' &
    PID2=$!
    wait $PID1 $PID2
    ```

11. VERIFY second message was queued (not dropped):
    ```bash
    curl -s localhost:9876/traffic -d '{"name":"main","direction":"recv","limit":30}'
    ```
    - Both messages should eventually get responses (same `topic_id`)
    - The second message may have been queued and processed after the first completes
    - Neither should be silently dropped

#### Part C: Topic Lifecycle

12. Record the topic IDs from current state:
    ```bash
    node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const rows = D.prepare(\"SELECT id, name, state, last_activity FROM topics ORDER BY created_at\").all();
    console.log(JSON.stringify(rows, null, 2));
    D.close();
    "
    ```
    - Record the topic IDs for later verification

13. Wait for idle transition (topics should go idle after inactivity timeout):
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

14. Send a message that matches an idle topic (rehydration):
    ```bash
    curl -s localhost:9876/send -d @- <<'EOF'
    {"name":"main","content":"Give me the final summary of the logging library comparison.","timeout":300000}
    EOF
    ```

15. VERIFY topic rehydrated from idle to active:
    ```bash
    node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const rows = D.prepare(\"SELECT id, name, state FROM topics ORDER BY last_activity DESC LIMIT 5\").all();
    console.log(JSON.stringify(rows, null, 2));
    D.close();
    "
    ```
    - The logging topic should be back to `state: 'active'`

16. VERIFY rehydrated session has filtered history from channel_interactions:
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
    - The response in step 14 should show awareness of prior logging discussion context

#### Part D: Limits & Edge Cases

17. Check current active topic count and create topics up to the limit (max 5):
    ```bash
    node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const r = D.prepare(\"SELECT COUNT(*) as c FROM topics WHERE state='active'\").get();
    console.log('Active topics:', r.c);
    D.close();
    "
    ```

18. Create additional topics to reach the limit of 5 active topics:
    ```bash
    curl -s localhost:9876/send -d '{"name":"main","content":"Design a REST API for a bookstore application.","timeout":300000}'
    curl -s localhost:9876/send -d '{"name":"main","content":"Write a Python script that generates Fibonacci numbers.","timeout":300000}'
    curl -s localhost:9876/send -d '{"name":"main","content":"Explain the differences between TCP and UDP protocols.","timeout":300000}'
    ```

19. VERIFY 5 active topics exist:
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

20. Attempt to create a 6th topic (should be rejected):
    ```bash
    curl -s localhost:9876/send -d @- <<'EOF'
    {"name":"main","content":"Tell me about quantum computing advancements in 2025.","timeout":300000}
    EOF
    ```

21. VERIFY rejection with topic list:
    ```bash
    curl -s localhost:9876/traffic -d '{"name":"main","direction":"recv","limit":10}'
    ```
    - Response should indicate max topics reached
    - Response should list the active topics so the user knows which to close
    - The message should NOT silently create a 6th topic

22. Close a topic explicitly:
    ```bash
    curl -s localhost:9876/send -d @- <<'EOF'
    {"name":"main","content":"Close the weather topic, I'm done with that.","timeout":300000}
    EOF
    ```

23. VERIFY topic marked as done and excluded from classification:
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

24. Send an explicit @topicname: message (bypass classification):
    ```bash
    curl -s localhost:9876/send -d @- <<'EOF'
    {"name":"main","content":"@bookstore: Add pagination to the list endpoints.","timeout":300000}
    EOF
    ```

25. VERIFY bypass classification and direct routing:
    ```bash
    curl -s localhost:9876/traffic -d '{"name":"main","direction":"recv","limit":10}'
    ```
    - The response `topic_id` should match the bookstore API topic
    - No classification call should have been needed (check container logs for absence of "Classifying message" when @topic prefix used)

#### Part E: Recovery

26. Record topic state before restart:
    ```bash
    node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const rows = D.prepare(\"SELECT id, name, state FROM topics ORDER BY created_at\").all();
    console.log(JSON.stringify(rows, null, 2));
    D.close();
    "
    ```

27. Restart the container:
    ```bash
    sudo docker restart openhive
    for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
    curl -s localhost:9876/reconnect -d '{"name":"main"}'
    ```

28. VERIFY all previously active topics marked idle after restart:
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

29. Send a message matching a previously active topic (rehydration post-restart):
    ```bash
    curl -s localhost:9876/send -d @- <<'EOF'
    {"name":"main","content":"What was the final verdict on Winston vs Pino?","timeout":300000}
    EOF
    ```

30. VERIFY topic rehydrated with history:
    ```bash
    node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const rows = D.prepare(\"SELECT id, name, state FROM topics WHERE name LIKE '%log%'\").all();
    console.log(JSON.stringify(rows, null, 2));
    D.close();
    "
    ```
    - The logging topic should be back to `state: 'active'`
    - The response in step 29 should demonstrate awareness of previous logging discussion

31. VERIFY health after recovery:
    ```bash
    curl -sf http://localhost:8080/health | python3 -m json.tool
    ```
    - Health should return 200 with "ok"

**Report:** Topics auto-created on first message? Second topic created for unrelated message? LLM classification routes correctly with 2+ topics? Parallel processing works across topics? Same-topic messages serialized? Idle transition occurs? Rehydration restores context? Max topic limit enforced with list? Closed topics excluded? @topicname bypass works? Topics marked idle on restart? Post-restart rehydration works?
