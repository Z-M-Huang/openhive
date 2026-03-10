---
name: REST API Foundation
id: rest-api
requires_rebuild: false
timeout: 120
---

## Overview

Tests core REST endpoints: security headers, config CRUD, providers, auth, error handling, WebSocket upgrade, and JSON validity across all endpoints.

## Setup

None.

## Tests

### 1. Security Headers

**Run:**
```bash
curl -sI http://localhost:8080/api/v1/health
```

**Expected:**
- `Content-Security-Policy` header present
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-Request-Id` header present (UUID format)

### 2. Config Read

**Run:**
```bash
curl -s http://localhost:8080/api/v1/config
```

**Expected:**
- JSON with `data.system` and `data.channels` sections

### 3. Config Update & Restore

**Run:**
```bash
# Read original
ORIGINAL=$(curl -s http://localhost:8080/api/v1/config | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['system']['log_level'])")

# Update
curl -s -X PUT http://localhost:8080/api/v1/config \
  -H "Content-Type: application/json" \
  -d '{"system":{"log_level":"info"}}'

# Verify changed
UPDATED=$(curl -s http://localhost:8080/api/v1/config | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['system']['log_level'])")

echo "ORIGINAL=$ORIGINAL UPDATED=$UPDATED"

# Restore
curl -s -X PUT http://localhost:8080/api/v1/config \
  -H "Content-Type: application/json" \
  -d "{\"system\":{\"log_level\":\"$ORIGINAL\"}}"
```

**Expected:**
- UPDATED = `info` (changed from original)
- Restored back to original value

### 4. Providers Read (Secret Masking)

**Run:**
```bash
curl -s http://localhost:8080/api/v1/providers
```

**Expected:**
- Provider entries returned
- Token/key values masked (`****` prefix)

### 5. Auth Unlock Validation

**Run:**
```bash
curl -s -X POST http://localhost:8080/api/v1/auth/unlock \
  -H "Content-Type: application/json" \
  -d '{"master_key":"short"}'
```

**Expected:**
- HTTP 400 with validation error about key length (min 16 chars)

### 6. Error: Bad JSON

**Run:**
```bash
curl -s -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d 'not json'
```

**Expected:**
- HTTP 400 error response (bad JSON body)

### 7. Error: Empty Content

**Run:**
```bash
curl -s -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":""}'
```

**Expected:**
- HTTP 400 with `INVALID_REQUEST` error code (API channel validates content before routing)

### 8. Portal WebSocket Upgrade

**Run:**
```bash
timeout 2 curl -sv --no-buffer \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  http://localhost:8080/api/v1/portal/ws 2>&1 | grep "101 Switching"
```

**Expected:**
- Output contains `101 Switching Protocols`

### 9. All Endpoints Return Valid JSON

**Run:**
```bash
for endpoint in health config providers teams tasks logs; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/v1/$endpoint)
  VALID=$(curl -s http://localhost:8080/api/v1/$endpoint | python3 -c "import sys,json; json.load(sys.stdin); print('valid')" 2>&1)
  echo "$endpoint: HTTP $STATUS, JSON $VALID"
done
```

**Expected:**
- All return HTTP 200 with `valid` JSON

## Teardown

None.
