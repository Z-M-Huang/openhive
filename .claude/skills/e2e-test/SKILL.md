---
name: e2e-test
description: Run OpenHive end-to-end regression tests across all phase gates and system scenarios. Use when the user asks to test the system, run regression tests, or validate changes.
user-invocable: true
---

# OpenHive E2E Test Runner

Run the full test suite: unit tests, phase gates, Docker build, live E2E suites.

## Execution Steps

### Step 1: Type Check
```bash
cd /app/openhive && npx tsc --noEmit --project backend/tsconfig.json 2>&1 | grep "error" | grep -v ".test.ts" | head -20
```
Report non-test type errors. Pre-existing Integration type errors can be ignored.

### Step 2: Run Backend Tests
```bash
cd /app/openhive/backend && ./node_modules/.bin/vitest run 2>&1
```
Expected: 1,200+ tests pass.

### Step 3: Docker Build + Live E2E

**Always run Docker E2E.** Check Docker availability first:
```bash
sudo docker info >/dev/null 2>&1 && echo "DOCKER_OK" || echo "DOCKER_UNAVAILABLE"
```

If `DOCKER_OK`:

**3a. Build the image ONCE:**
```bash
cd /app/openhive && sudo docker build -t openhive:latest -f deployments/Dockerfile . 2>&1 | tail -5
```

**3b. Start clean:**
```bash
cd /app/openhive && sudo docker compose -f deployments/docker-compose.yml down -v 2>&1 || true
sudo rm -rf /app/openhive/.run/workspace && mkdir -p /app/openhive/.run/workspace
sudo docker compose -f deployments/docker-compose.yml up -d 2>&1
```

**3c. Wait for health:**
```bash
for i in $(seq 1 30); do curl -sf http://localhost:8080/api/health >/dev/null 2>&1 && echo "Server ready" && break; sleep 3; done
```

**3d. Run live E2E tests** — execute the API and CLI tests described in the Live E2E section below.

**3e. Cleanup:**
```bash
sudo docker compose -f deployments/docker-compose.yml down -v 2>&1
```

If `DOCKER_UNAVAILABLE`: Report "Docker not available — skipping live E2E suites" and continue.

### Step 4: Phase Gate Summary
For each phase gate layer (0-11), extract from Step 2 results:
- Layer name and pass/fail count
- Any failures with error details

### Step 5: Report
```
=== OpenHive E2E Test Results ===

Type Check:       PASS/FAIL (N errors)
Backend Tests:    PASS/FAIL (N passed, N failed, N skipped)
Docker Build:     PASS/FAIL
Docker Runtime:   PASS/FAIL

Phase Gates:
  L0-L11 summary

Live E2E Suites:
  01 Basic Connectivity:   PASS/FAIL
  04 REST API Baseline:    PASS/FAIL
  ...

Failures: [details]
```

---

## Live E2E Test Suites

These run against the live Docker container started in Step 3. **Do NOT rebuild Docker per suite** — use the single running instance.

### Suite 01: Basic Connectivity
Test the full CLI pipeline:
```bash
echo 'Say exactly: PONG' | timeout 120 bun run cli/index.ts 2>&1
```
- PASS if output contains `[Assistant]`

### Suite 04: REST API Baseline
```bash
curl -sf http://localhost:8080/api/health   # expect: "healthy"
curl -sf http://localhost:8080/api/teams    # expect: "teams"
curl -sf http://localhost:8080/api/tasks    # expect: "tasks"
curl -sf http://localhost:8080/api/logs     # expect: "entries"
```

### Suite 06: Team CRUD
```bash
curl -sf http://localhost:8080/api/teams
```
- PASS if main team exists with health=running

### Suite 08: Logs & Settings
```bash
curl -sf http://localhost:8080/api/settings
```
- PASS if secrets are redacted (`"********"`)

### Suite 09: Team Creation (Docker-dependent)
```bash
curl -sf -X POST http://localhost:8080/api/teams \
  -H 'Content-Type: application/json' \
  -d '{"slug":"e2e-team","leader_aid":"aid-main-001"}'
```
- PASS if team created and visible in `GET /api/teams`
- Cleanup: `curl -sf -X DELETE http://localhost:8080/api/teams/e2e-team`

### Suite 13: Container Invariants
```bash
curl -sf http://localhost:8080/api/containers
```
- PASS if containers endpoint responds (check after Suite 09 creates a team)

### Suite 16: Configurable Limits
```bash
curl -sf http://localhost:8080/api/settings
```
- PASS if limits.max_depth=3, max_teams=10, max_agents_per_team=5

### Suite 17: Validation Errors
```bash
curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:8080/api/teams \
  -H 'Content-Type: application/json' -d '{}'          # expect: 400
curl -s -o /dev/null -w '%{http_code}' \
  http://localhost:8080/api/teams/nonexistent           # expect: 404
```

### Suite 19: Security
```bash
curl -sf http://localhost:8080/api/settings
```
- PASS if `encryption_key_path` and `token_ttl` have `isSecret: true` and value `"********"`

### Suite 25: Query Endpoints
```bash
curl -sf http://localhost:8080/api/health
```
- PASS if `dbStatus: "connected"`
