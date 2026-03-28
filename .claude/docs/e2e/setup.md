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

### 3. Helpers

#### WS Protocol

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

#### Multi-Turn Progressive WebSocket Script Pattern

For each scenario, write a `.cjs` script that opens ONE WebSocket connection and sends multiple messages sequentially. **MUST use `.cjs` extension** (backend has `"type": "module"` in package.json). The script collects ALL message types (ack, progress, response) per request.

Template — save as `/app/openhive/backend/ws-scenario-N.cjs`:
```javascript
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8080/ws');
const messages = [
  'First message here',
  'Second message here',
];
let idx = 0;
let allResponses = []; // Array of { messages: [{type, content/error}...] } per request

let currentExchange = [];

ws.on('open', () => ws.send(JSON.stringify({ content: messages[idx] })));
ws.on('message', (data) => {
  const parsed = JSON.parse(data.toString());
  // Skip async notification frames — they're from background tasks, not this request
  if (parsed.type === 'notification') {
    console.log(`  [msg ${idx + 1}] NOTIFICATION (skipped): ${(parsed.content || '').slice(0, 80)}`);
    return;
  }
  currentExchange.push(parsed);
  console.log(`  [msg ${idx + 1}] type=${parsed.type} content=${(parsed.content || parsed.error || '').slice(0, 120)}`);

  // Only advance to next message on 'response' or 'error' (terminal types)
  if (parsed.type === 'response' || parsed.type === 'error') {
    console.log(`---EXCHANGE ${idx + 1} COMPLETE (${currentExchange.length} messages)---`);
    allResponses.push({ messages: currentExchange });
    currentExchange = [];
    idx++;
    if (idx < messages.length) {
      ws.send(JSON.stringify({ content: messages[idx] }));
    } else {
      // Print summary
      console.log('\n=== SUMMARY ===');
      allResponses.forEach((ex, i) => {
        const types = ex.messages.map(m => m.type).join(' -> ');
        const final = ex.messages.find(m => m.type === 'response');
        console.log(`Exchange ${i+1}: ${types}`);
        console.log(`  Final: ${(final?.content || 'N/A').slice(0, 300)}`);
      });
      ws.close();
      process.exit(0);
    }
  }
});
ws.on('error', (e) => { console.error('WS_ERROR:', e.message); process.exit(1); });
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 600000);
```

Run from host: `node /app/openhive/backend/ws-scenario-N.cjs`

**Important:** Each message still spawns a FRESH server-side session. The WS connection is persistent but the server treats each message independently. Memory between messages only works through MEMORY.md file persistence.

#### Single WS Message Helper (Progressive)

For quick one-off messages, use this inline pattern. Collects all message types and exits on `response`:
```bash
node -e "
const ws = new (require('/app/openhive/backend/node_modules/ws'))('ws://localhost:8080/ws');
const msgs = [];
ws.on('open', () => ws.send(JSON.stringify({content:'YOUR MESSAGE HERE'})));
ws.on('message', (d) => {
  const p = JSON.parse(d.toString());
  if (p.type === 'notification') { console.log('NOTIFICATION_SKIPPED'); return; }
  msgs.push(p);
  console.log('TYPE=' + p.type + ' CONTENT=' + (p.content || p.error || '').slice(0, 200));
  if (p.type === 'response' || p.type === 'error') {
    console.log('TOTAL_MESSAGES=' + msgs.length);
    console.log('TYPES=' + msgs.map(m => m.type).join(','));
    ws.close();
    process.exit(0);
  }
});
ws.on('error', (e) => { console.error('WS_ERROR:', e.message); process.exit(1); });
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 240000);
"
```

**Interpreting output:** Look for `TYPES=` line. Expected patterns:
- Simple/fast request: `TYPES=response` (no ack needed)
- Normal request: `TYPES=ack,response` (AI acknowledged then answered)
- Long request: `TYPES=ack,progress,progress,response` (AI acknowledged, worked with tools, answered)
- Error: `TYPES=error`

#### Notification Listener Script

For testing background notifications (trigger results, task completions), use a script that stays connected and logs all incoming messages including `notification` type:
```javascript
// Save as ws-listener.cjs
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8080/ws');
ws.on('open', () => console.log('CONNECTED'));
ws.on('message', (d) => {
  const p = JSON.parse(d.toString());
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...p }));
});
ws.on('close', () => { console.log('DISCONNECTED'); process.exit(0); });
ws.on('error', (e) => { console.error('WS_ERROR:', e.message); process.exit(1); });
// Keep alive for up to 5 minutes
setTimeout(() => { console.log('LISTENER_TIMEOUT'); ws.close(); process.exit(0); }, 300000);
```

Run in background: `node /app/openhive/backend/ws-listener.cjs > /tmp/ws-notifications.log 2>&1 &`
Read later: `cat /tmp/ws-notifications.log`
Kill: `kill %1 2>/dev/null || true`

#### Database Queries — run from HOST (SQLite is in bind-mounted .run/):
```bash
node -e "
const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
// YOUR QUERY HERE
D.close();
"
```

#### Filesystem Checks — read from HOST via bind mount:
```bash
# .run/ is volume-mounted — read directly from host, no docker exec needed
cat /app/openhive/.run/teams/main/config.yaml
ls /app/openhive/.run/teams/ops-team/

# Use docker exec ONLY for container-baked files not on host:
sudo docker exec openhive ls /app/system-rules/
sudo docker exec openhive cat /data/rules/escalation-policy.md
```

### Clean Restart Helper

Before **every scenario** (except Scenario 4 Part B/C which continues from Part A), wipe runtime state and restart the container. **Do NOT rebuild** — the image was already built in Section 1.

```bash
cd /app/openhive
sudo docker compose -f deployments/docker-compose.yml down -v 2>&1 || true
sudo rm -rf .run && mkdir -p .run
rm -f data/rules/*.md
cp common/seed-rules/* data/rules/ 2>/dev/null || true
sudo docker compose -f deployments/docker-compose.yml up -d 2>&1
for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
```
