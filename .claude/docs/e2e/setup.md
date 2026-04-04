# E2E Setup

## Setup

### 1. Build and Start
```bash
cd /app/openhive
sudo docker compose -f deployments/docker-compose.yml down -v 2>&1 || true
sudo rm -rf .run && mkdir -p .run
sudo docker system prune -af 2>&1 | tail -3
sudo docker compose -f deployments/docker-compose.yml build --no-cache 2>&1 | tail -5
sudo docker compose -f deployments/docker-compose.yml up -d 2>&1
```

### 2. Wait for Health
```bash
for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Server ready" && break; sleep 3; done
```

### 3. Start Test Harness

Start the persistent WS test harness and open a default connection:
```bash
node /app/openhive/ws-harness.cjs &
HARNESS_PID=$!
sleep 1
curl -sf http://localhost:9876/status && echo "Harness ready" || echo "Harness failed to start"
curl -s localhost:9876/connect -d '{"name":"main"}'
```

If the harness crashes at any point, detect via `curl -sf http://localhost:9876/status` failure and restart:
```bash
node /app/openhive/ws-harness.cjs &
HARNESS_PID=$!
sleep 1
curl -s localhost:9876/connect -d '{"name":"main"}'
```

### 4. WS Protocol

The server sends multiple message types per request. Each WS message is a JSON object with a `type` field:

| type | When | Meaning |
|------|------|---------|
| `ack` | ~2-5s after request | AI's first text (acknowledgment, clarification, or direct answer) |
| `progress` | Every ~10-15s during tool use | Tool execution status ("Working with Read (5s)") |
| `response` | End of processing | Final complete result |
| `notification` | Asynchronous | Background task completion (trigger results, etc.) |
| `error` | On failure | Error message |

A typical flow for a complex request: `ack` → `progress` → `progress` → `response`.
A simple request may skip `ack`/`progress` and go straight to `response`.
Clients MUST wait for `type: "response"` before considering the request complete.

**Critical constraint:** Each WS message spawns a FRESH server-side session. The persistent connection is client-side convenience only — there is NO multi-turn state. "Memory" between messages works ONLY through MEMORY.md file persistence + system injection.

### 5. Harness Usage Reference

The harness proxies WS messages via HTTP on `localhost:9876`. All endpoints return JSON with `ok: true/false`.

#### Sending a message and waiting for response
```bash
curl -s localhost:9876/send -d '{"name":"main","content":"Who are you?","timeout":300000}'
```
Returns: `{ ok, exchange: [{seq, type, content, ts}...], final: "...", elapsed: N }`

The `exchange` array contains all frames (ack, progress, response) for this request. The `final` field is the content of the terminal frame. Notifications go to the notification buffer, not the exchange.

#### Sending messages with quotes or special characters
Use heredoc for complex JSON:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Create a team called \"ops-team\" with credentials: api_key is test-key","timeout":300000}
EOF
```

#### Sending raw/invalid payloads (for protocol tests)
```bash
curl -s localhost:9876/send_raw -d '{"name":"main","payload":"this is not json","timeout":30000}'
```

#### Fire-and-forget (for serialization tests)
Sends without blocking — does NOT enforce client-side serialization:
```bash
curl -s localhost:9876/send_fire -d '{"name":"main","content":"Tell me a long story"}'
```

#### Collecting frames after send_fire
```bash
curl -s localhost:9876/exchange -d '{"name":"main","since_seq":5,"timeout":300000}'
```
By default waits for 1 terminal frame (response/error). Use `terminal_count` to wait for more (e.g., serialization tests need 2 — the error + the response):
```bash
curl -s localhost:9876/exchange -d '{"name":"main","since_seq":5,"timeout":300000,"terminal_count":2}'
```
Notification frames are excluded from exchange results — use `/notifications` for those.

#### Checking notifications
```bash
curl -s localhost:9876/notifications -d '{"name":"main","since_seq":0}'
```

#### Multi-connection tests
```bash
curl -s localhost:9876/connect -d '{"name":"iso-a"}'
curl -s localhost:9876/connect -d '{"name":"iso-b"}'
curl -s localhost:9876/send -d '{"name":"iso-a","content":"Do something","timeout":300000}'
curl -s localhost:9876/notifications -d '{"name":"iso-a"}'   # Should have notification
curl -s localhost:9876/notifications -d '{"name":"iso-b"}'   # Should have ZERO
```

#### Querying traffic log
```bash
curl -s localhost:9876/traffic -d '{"name":"main","limit":50}'
curl -s localhost:9876/traffic -d '{"name":"main","type":"ack","direction":"recv"}'
```

### 6. Verification Scripts (PREFERRED over manual queries)

After each WS message, run the suite's verification script instead of manual DB/filesystem checks:
```bash
node src/e2e/verify-suite-teams-hierarchy.cjs --step after-team-create
```

Returns structured JSON:
```json
{
  "suite": "teams-hierarchy",
  "step": "after-team-create",
  "checks": [
    { "name": "org_tree_ops_team", "pass": true, "expected": "ops-team in org_tree", "actual": "found, parent=main-id" },
    { "name": "ops_team_dir", "pass": true, "expected": "directory exists", "actual": "exists" }
  ],
  "summary": { "total": 6, "passed": 6, "failed": 0 }
}
```

**If `summary.failed > 0`:** Investigate the failing checks. Use the `expected` vs `actual` fields to understand what went wrong. Only then fall back to manual queries if needed.

**If `summary.failed == 0`:** Proceed to the next step. No manual verification needed.

Available scripts:
- `src/e2e/verify-smoke.cjs` — Enhanced smoke checks
- `src/e2e/verify-suite-teams-hierarchy.cjs` — Suite A
- `src/e2e/verify-suite-triggers-notifications.cjs` — Suite B
- `src/e2e/verify-suite-stress.cjs` — Suite C
- `src/e2e/verify-suite-browser.cjs` — Suite D
- `src/e2e/verify-suite-context-threading.cjs` — Suite E
- `src/e2e/verify-suite-cascade-deletion.cjs` — Suite F
- `src/e2e/verify-suite-skill-repo.cjs` — Suite G

### 7. Database Queries — manual fallback (SQLite is in bind-mounted .run/):
```bash
node -e "
const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
// YOUR QUERY HERE
D.close();
"
```

### 8. Filesystem Checks — read from HOST via bind mount:
```bash
# .run/ is volume-mounted — read directly from host, no docker exec needed
cat /app/openhive/.run/teams/main/config.yaml
ls /app/openhive/.run/teams/ops-team/

# Use docker exec ONLY for container-baked files not on host:
sudo docker exec openhive ls /app/system-rules/
sudo docker exec openhive cat /data/rules/escalation-policy.md
```

### Clean Restart Helper

Before **every suite** (except continuations within a suite), wipe runtime state and restart the container. **Do NOT rebuild** — the image was already built in Section 1.

```bash
cd /app/openhive
sudo docker compose -f deployments/docker-compose.yml down -v 2>&1 || true
sudo rm -rf .run && mkdir -p .run
rm -f data/rules/*.md
cp seed-rules/* data/rules/ 2>/dev/null || true
sudo docker compose -f deployments/docker-compose.yml up -d 2>&1
for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
```

**After every Clean Restart**, the existing WS connections are dead. Reset harness state and reconnect:
```bash
curl -s localhost:9876/reset
curl -s localhost:9876/connect -d '{"name":"main"}'
```

**After `docker restart openhive`** (not full clean restart), reconnect without resetting traffic:
```bash
curl -s localhost:9876/reconnect -d '{"name":"main"}'
```
