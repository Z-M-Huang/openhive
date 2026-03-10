---
name: Chat Channel & Message Routing
id: chat-channel
requires_rebuild: false
timeout: 300
---

## Overview

Tests the API channel (`POST /api/v1/chat`): single message, sequential independent sessions, channel registration, and routing log visibility.

The API channel generates a fresh JID per request (`api:1`, `api:2`, ...). Each request is an independent session with no cross-request memory.

## Setup

None — requires valid provider credentials in the container.

## Tests

### 1. Single Message (Agent Response)

**Run:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Reply with exactly the word: SMOKE_OK"}'
```

**Expected:**
- HTTP 200 with `data.response` containing "SMOKE_OK"

**On failure:** Check `docker compose -f deployments/docker-compose.yml logs --tail 100` for SDK/provider errors. Common cause: invalid OAuth token or API key in providers.yaml.

### 2. Sequential Requests (Independent Sessions)

**Request 1:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Reply with exactly: SMOKE_SEQ_1"}'
```

**Request 2:**
```bash
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Reply with exactly: SMOKE_SEQ_2"}'
```

**Expected:**
- Request 1 response contains "SMOKE_SEQ_1"
- Request 2 response contains "SMOKE_SEQ_2"
- Each gets a unique JID (no session carryover)

### 3. Channel Registration

**Run:**
```bash
curl -s http://localhost:8080/api/v1/config | python3 -c "
import sys, json
ch = json.load(sys.stdin)['data']['channels']
for name, cfg in ch.items():
    status = 'enabled' if cfg.get('enabled') else 'disabled'
    print(f'{name}: {status}')
"
```

**Expected:**
- Shows channel names with enabled/disabled status
- API channel is always active (verified by test 1 passing)

### 4. Message Routing Logs

**Run:**
```bash
curl -s "http://localhost:8080/api/v1/logs?limit=20" | python3 -c "
import sys, json
data = json.load(sys.stdin)
logs = data.get('logs', data if isinstance(data, list) else [])
routing = [l for l in logs if 'dispatch' in l.get('message', '').lower() or 'chat' in l.get('action', '').lower() or 'task' in l.get('action', '').lower()]
print(f'Routing-related logs: {len(routing)}')
for l in routing[:5]:
    print(f'  [{l.get(\"level\",\"\")}] {l.get(\"component\",\"\")}/{l.get(\"action\",\"\")}: {l.get(\"message\",\"\")[:60]}')
"
```

**Expected:**
- At least 1 routing-related log entry (message dispatch, task creation)
- Note: messages table has no REST endpoint — logs are the observability layer

## Teardown

None.
