---
name: Log Observability & Diagnostics
id: logging
requires_rebuild: false
timeout: 120
---

## Overview

Verifies the logging system gives users clear visibility: structured fields, correlation IDs, verbose params, error context, and secret redaction.

## Setup

Generate fresh log entries to avoid depending on prior scenarios:
```bash
# Fire a simple chat request to ensure recent log entries exist
curl -s -m 120 -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"Reply with exactly: LOG_SEED_OK"}'

# Hit a few REST endpoints to generate API logs
curl -s http://localhost:8080/api/v1/health > /dev/null
curl -s http://localhost:8080/api/v1/config > /dev/null
curl -s http://localhost:8080/api/v1/teams > /dev/null
```

## Tests

### 1. Startup Stage Progression

**Run:**
```bash
curl -s "http://localhost:8080/api/v1/logs?limit=50" | python3 -c "
import sys, json
data = json.load(sys.stdin)
logs = data.get('logs', data if isinstance(data, list) else [])
markers = ['startup:', 'workspace', 'backend started']
found = []
for log in logs:
    msg = log.get('message', '')
    for m in markers:
        if m in msg and m not in found:
            found.append(m)
print(f'Startup markers: {len(found)}/{len(markers)}')
for m in markers:
    print(f'  {\"FOUND\" if m in found else \"MISSING\"}: {m}')
"
```

**Expected:**
- At least 2 of 3 startup markers found

### 2. Structured Fields (component, action)

**Run:**
```bash
curl -s "http://localhost:8080/api/v1/logs?limit=10" | python3 -c "
import sys, json
data = json.load(sys.stdin)
logs = data.get('logs', data if isinstance(data, list) else [])
if not logs:
    print('FAIL: No logs'); sys.exit(1)
for log in logs[:5]:
    print(f'  [{log.get(\"level\",\"?\")}] {log.get(\"component\",\"<none>\")}/{log.get(\"action\",\"<none>\")}: {log.get(\"message\",\"\")[:60]}')
has_comp = any(log.get('component') for log in logs)
has_act = any(log.get('action') for log in logs)
print(f'Has component: {has_comp}, Has action: {has_act}')
"
```

**Expected:**
- Both `component` and `action` fields present in logs

### 3. API Request Correlation IDs

**Run:**
```bash
curl -s "http://localhost:8080/api/v1/logs?limit=20" | python3 -c "
import sys, json
data = json.load(sys.stdin)
logs = data.get('logs', data if isinstance(data, list) else [])
api_logs = [l for l in logs if l.get('component') == 'api' or l.get('request_id')]
has_rid = any(l.get('request_id') for l in api_logs)
print(f'API logs: {len(api_logs)}, Has request_id: {has_rid}')
"
```

**Expected:**
- API log entries have `request_id` field

### 4. Verbose Params Logged

**Run:**
```bash
curl -s "http://localhost:8080/api/v1/logs?limit=20" | python3 -c "
import sys, json
data = json.load(sys.stdin)
logs = data.get('logs', data if isinstance(data, list) else [])
with_params = [l for l in logs if l.get('params')]
print(f'Logs with params: {len(with_params)}/{len(logs)}')
if with_params:
    s = with_params[0]
    print(f'Sample: [{s[\"level\"]}] {s.get(\"component\",\"\")}/{s.get(\"action\",\"\")}: params={json.dumps(s[\"params\"])[:80]}...')
"
```

**Expected:**
- At least some log entries have populated `params` field

### 5. Error Logs Are Actionable

**Run:**
```bash
curl -s "http://localhost:8080/api/v1/logs?level=error&limit=10" | python3 -c "
import sys, json
data = json.load(sys.stdin)
logs = data.get('logs', data if isinstance(data, list) else [])
if not logs:
    print('No error logs (clean run)'); sys.exit(0)
print(f'Error logs: {len(logs)}')
for l in logs[:5]:
    print(f'  [{l.get(\"component\",\"?\")}/{l.get(\"action\",\"?\")}] {l.get(\"message\",\"\")}')
has_ctx = all(l.get('component') and (l.get('error') or l.get('message')) for l in logs)
print(f'All have context: {has_ctx}')
"
```

**Expected:**
- Error logs (if any) include `component`, `action`, `message` fields

### 6. Sensitive Data Redacted

**Run:**
```bash
curl -s "http://localhost:8080/api/v1/logs?limit=50" | python3 -c "
import sys, json
raw = sys.stdin.read()
patterns = ['sk-ant-', 'ghp_', 'oauth_token', 'api_key']
found = [p for p in patterns if p in raw and '****' not in raw]
if found:
    print(f'WARNING: Possible unredacted secrets: {found}'); sys.exit(1)
print('No raw secret patterns in logs')
"
```

**Expected:**
- No raw secret patterns found

### 7. Logs with Filters

**Run:**
```bash
curl -s "http://localhost:8080/api/v1/logs?level=info&limit=5"
curl -s "http://localhost:8080/api/v1/logs?level=error&limit=5"
```

**Expected:**
- Both return valid JSON (may be empty for error level)

## Teardown

None.
