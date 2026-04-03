# Scenario 5: Stress, Recovery & Edge Cases

**Run the Clean Restart Helper from setup.md. Then reset harness and reconnect:**
```bash
curl -s localhost:9876/reset
curl -s localhost:9876/connect -d '{"name":"main"}'
```

#### Part A: Setup State

1. ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Create a team called stress-team for testing. Accept keywords: testing","timeout":300000}
   EOF
   ```
2. Write memory: `echo "Stress test baseline" > /app/openhive/.run/teams/main/memory/MEMORY.md`
3. VERIFY: stress-team in org_tree, MEMORY.md exists

#### Part B: Stress Test — 5 Rapid Concurrent Messages

4. Open 5 connections and send in parallel:
   ```bash
   for i in 1 2 3 4 5; do
     curl -s localhost:9876/connect -d "{\"name\":\"s$i\"}"
   done
   ```

   Fire all 5 sends in parallel:
   ```bash
   curl -s localhost:9876/send -d '{"name":"s1","content":"What is 2+2?","timeout":300000}' > /tmp/stress1.json &
   curl -s localhost:9876/send -d '{"name":"s2","content":"What is the capital of France?","timeout":300000}' > /tmp/stress2.json &
   curl -s localhost:9876/send -d '{"name":"s3","content":"List 3 colors","timeout":300000}' > /tmp/stress3.json &
   curl -s localhost:9876/send -d '{"name":"s4","content":"What teams do you have?","timeout":300000}' > /tmp/stress4.json &
   curl -s localhost:9876/send -d '{"name":"s5","content":"Who are you?","timeout":300000}' > /tmp/stress5.json &
   wait
   ```

5. VERIFY: All 5 got responses:
   ```bash
   for i in 1 2 3 4 5; do
     echo "=== Stress $i ==="
     cat /tmp/stress$i.json | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok:', d.get('ok'), 'final:', (d.get('final','')or'')[:100])" 2>/dev/null || echo "PARSE FAILED"
   done
   rm -f /tmp/stress*.json
   ```
   - All 5 should have `ok: true`

6. VERIFY: `curl -sf http://localhost:8080/health` returns 200

   ```bash
   for i in 1 2 3 4 5; do
     curl -s localhost:9876/disconnect -d "{\"name\":\"s$i\"}"
   done
   ```

#### Part C: Per-Socket Request Serialization

7. Test that a second message on the same socket while the first is processing gets rejected.
   Use `/send_fire` (no client-side serialization) to send two messages rapidly on the same connection, then collect the results:

   ```bash
   # Record current seq
   SEQ_BEFORE=$(curl -s localhost:9876/traffic -d '{"name":"main","limit":1}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['entries'][-1]['seq'] if d['entries'] else 0)" 2>/dev/null || echo "0")

   # Fire first message (long-running) — does NOT block
   curl -s localhost:9876/send_fire -d '{"name":"main","content":"Tell me a long story about dragons"}'

   # Wait 100ms then fire second message — server should reject with "request in progress"
   sleep 0.1
   curl -s localhost:9876/send_fire -d '{"name":"main","content":"What is 1+1?"}'

   # Collect all frames — wait for BOTH terminal frames (error + response) using terminal_count: 2
   curl -s localhost:9876/exchange -d "{\"name\":\"main\",\"since_seq\":$SEQ_BEFORE,\"timeout\":300000,\"terminal_count\":2}"
   ```

   - VERIFY: Exchange frames contain both:
     - A `type: "error"` frame with content containing "request in progress"
     - A `type: "response"` frame with the story content
   - This proves per-socket request serialization works

#### Part D: Recovery After Restart

8. `sudo docker restart openhive` — wait for health, then reconnect:
   ```bash
   for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
   curl -s localhost:9876/reconnect -d '{"name":"main"}'
   ```

9. VERIFY post-restart:
   ```bash
   # org_tree still has teams
   node -e "
   const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
   console.log(JSON.stringify(D.prepare('SELECT name FROM org_tree').all()));
   D.close();
   "
   # MEMORY.md still exists
   cat /app/openhive/.run/teams/main/memory/MEMORY.md
   # Config files intact
   cat /app/openhive/.run/teams/stress-team/config.yaml
   # Recovery log
   sudo docker logs openhive 2>&1 | grep "Recovery"
   ```

10. ```bash
    curl -s localhost:9876/send -d '{"name":"main","content":"Hello, are you working?","timeout":300000}'
    ```
    - VERIFY: `.final` contains normal response (system works after restart)

11. VERIFY: Health still 200

#### Part E: Cleanup

12. ```bash
    curl -s localhost:9876/send -d '{"name":"main","content":"Shut down stress-team","timeout":300000}'
    ```
13. Remove test files:
    ```bash
    rm -f /app/openhive/.run/teams/main/memory/MEMORY.md
    ```

**Report:** All 5 concurrent messages got responses? Per-socket serialization works? Health stable? Recovery preserved all state? System functional after stress?
