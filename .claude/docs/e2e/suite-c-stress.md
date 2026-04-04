# Suite C: Stress & Recovery

Consolidates scenario 5 (concurrent messages, per-socket serialization, restart recovery).

## Prerequisites

- Docker image already built
- WS harness running on localhost:9876
- Verification script: `node src/e2e/verify-suite-stress.cjs --step <step>`

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

```bash
curl -s localhost:9876/reset
curl -s localhost:9876/connect -d '{"name":"main"}'
```

---

## Step 1: Setup State

Create a team and write memory for recovery verification later:

```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Create a team called stress-team for testing. Accept keywords: testing","timeout":300000}
EOF
```

```bash
echo "Stress test baseline" > /app/openhive/.run/teams/main/memory/MEMORY.md
```

Verify stress-team exists:
```bash
node -e "
const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
console.log('org_tree:', JSON.stringify(D.prepare(\"SELECT name, parent_id FROM org_tree WHERE name='stress-team'\").get()));
D.close();
"
```

---

## Step 2: Open 5 Connections

```bash
for i in 1 2 3 4 5; do
  curl -s localhost:9876/connect -d "{\"name\":\"s$i\"}"
done
```

---

## Step 3: Send 5 Concurrent Messages

Fire all 5 in parallel using background processes:

```bash
curl -s localhost:9876/send -d '{"name":"s1","content":"What is 2+2?","timeout":300000}' > /tmp/stress1.json &
curl -s localhost:9876/send -d '{"name":"s2","content":"What is the capital of France?","timeout":300000}' > /tmp/stress2.json &
curl -s localhost:9876/send -d '{"name":"s3","content":"List 3 colors","timeout":300000}' > /tmp/stress3.json &
curl -s localhost:9876/send -d '{"name":"s4","content":"What teams do you have?","timeout":300000}' > /tmp/stress4.json &
curl -s localhost:9876/send -d '{"name":"s5","content":"Who are you?","timeout":300000}' > /tmp/stress5.json &
wait
```

---

## Step 4: Collect and Verify Responses

Check all 5 got valid responses:
```bash
for i in 1 2 3 4 5; do
  echo "=== Stress $i ==="
  cat /tmp/stress$i.json | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok:', d.get('ok'), 'final:', (d.get('final','')or'')[:100])" 2>/dev/null || echo "PARSE FAILED"
done
rm -f /tmp/stress*.json
```

**Verify:**
- Run: `node src/e2e/verify-suite-stress.cjs --step after-concurrent`
- Checks: health returns 200, all 5 connections still alive, stress-team still in org_tree

Disconnect stress connections:
```bash
for i in 1 2 3 4 5; do
  curl -s localhost:9876/disconnect -d "{\"name\":\"s$i\"}"
done
```

---

## Step 5: Per-Socket Request Serialization

Test that a second message on the same socket while the first is processing gets rejected with "request in progress".

Use `/send_fire` (no client-side serialization) to send two messages rapidly on the same connection, then collect results:

```bash
# Record current seq
SEQ_BEFORE=$(curl -s localhost:9876/traffic -d '{"name":"main","limit":1}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['entries'][-1]['seq'] if d['entries'] else 0)" 2>/dev/null || echo "0")

# Fire first message (long-running) -- does NOT block
curl -s localhost:9876/send_fire -d '{"name":"main","content":"Tell me a long story about dragons"}'

# Wait 100ms then fire second message -- server should reject with "request in progress"
sleep 0.1
curl -s localhost:9876/send_fire -d '{"name":"main","content":"What is 1+1?"}'

# Collect all frames -- wait for BOTH terminal frames (error + response) using terminal_count: 2
curl -s localhost:9876/exchange -d "{\"name\":\"main\",\"since_seq\":$SEQ_BEFORE,\"timeout\":300000,\"terminal_count\":2}"
```

**Verify:** Exchange frames contain both:
- A `type: "error"` frame with content containing "request in progress"
- A `type: "response"` frame with the story content

This proves per-socket request serialization works: the server rejects overlapping requests on the same connection.

---

## Step 6: Restart + Recovery

```bash
sudo docker restart openhive
for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
curl -s localhost:9876/reconnect -d '{"name":"main"}'
```

**Verify:**
- Run: `node src/e2e/verify-suite-stress.cjs --step after-restart`
- Checks: org_tree still has stress-team, MEMORY.md still exists with "Stress test baseline", config.yaml for stress-team intact, health returns 200, container logs contain "Recovery" messages

Post-restart sanity:
```bash
curl -s localhost:9876/send -d '{"name":"main","content":"Hello, are you working?","timeout":300000}'
```
**Observe:** `.final` contains a normal response (system functional after restart).

---

## Pass Criteria

All verification steps pass (summary.failed === 0 for each). Key outcomes:
- All 5 concurrent messages got valid responses
- Health stable under concurrent load
- Per-socket serialization rejects overlapping requests with "request in progress" error
- All state (org_tree, MEMORY.md, config files) survived docker restart
- System functional after stress + restart sequence
