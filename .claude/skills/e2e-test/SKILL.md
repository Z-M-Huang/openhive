---
name: e2e-test
description: Run OpenHive end-to-end regression tests. Quick mode (vitest) and Docker mode (live interaction via WebSocket).
user-invocable: true
---

# OpenHive E2E Test Runner

Run the FULL test suite. **Never skip any test. Never stop to ask the user if you should proceed — run everything end-to-end autonomously.** If a suite fails, log it and continue to the next suite. Report all results at the end.

## Execution Steps

### Step 1: Type Check
```bash
cd /app/openhive/backend && npx tsc --noEmit 2>&1 | head -20
```

### Step 2: Lint
```bash
npx eslint src/ --max-warnings 0 2>&1 | head -20
```

### Step 3: Unit + Integration Tests
```bash
npx vitest run 2>&1
```
Expected: 300+ tests pass.

### Step 4: Quick E2E Tests (no Docker)
```bash
npx vitest run src/e2e/ 2>&1
```
These test bootstrap wiring with mock queryFn. No API key needed.

### Step 5: Docker E2E (live interaction)

Check Docker availability:
```bash
sudo docker info >/dev/null 2>&1 && echo "DOCKER_OK" || echo "DOCKER_UNAVAILABLE"
```

If `DOCKER_OK`:

**5a. Clean runtime state, prune, and build the image:**
```bash
cd /app/openhive && sudo docker compose -f deployments/docker-compose.yml down -v 2>&1 || true
sudo rm -rf .run && mkdir -p .run
sudo docker system prune -af 2>&1 | tail -3
sudo docker build -t openhive:latest -f deployments/Dockerfile . 2>&1 | tail -5
```
The `.run/` cleanup ensures no stale teams, org tree entries, or memory files carry over from previous runs.

**5b. Start clean:**
```bash
sudo docker compose -f deployments/docker-compose.yml up -d 2>&1
```

**5c. Wait for health:**
```bash
for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Server ready" && break; sleep 3; done
```

**5d. Run ALL test suites** — read each `.yaml` file in `.claude/skills/e2e-test/test-suites/` in order. For each suite:
1. Read the YAML file
2. Execute setup commands
3. For each test case, execute the steps and verify expected outcomes
4. Execute teardown commands
5. If a suite requires a clean start (noted in the file), restart the container first

**For suites that need WebSocket interaction:**
Use `websocat` or a Node.js one-liner to connect to `ws://localhost:8080/ws`, send JSON `{"content":"..."}`, and read the response.

**For suites that need database verification:**
Use `sudo docker exec openhive-openhive-1 node -e "..."` to run SQLite queries.

**For suites that need filesystem verification:**
Use `sudo docker exec openhive-openhive-1 ls /path/...` or `cat`.

**5e. Cleanup:**
```bash
sudo docker compose -f deployments/docker-compose.yml down -v 2>&1
```

### Step 6: Report
```
=== OpenHive E2E Test Results ===

Type Check:       PASS/FAIL
Lint:             PASS/FAIL
Unit Tests:       PASS/FAIL (N passed, N failed)
Quick E2E:        PASS/FAIL
Docker Build:     PASS/FAIL
Docker Runtime:   PASS/FAIL

Live E2E Suites:
  01 Health & Structure:      PASS/FAIL
  02 WebSocket:               PASS/FAIL
  03 Team Spawn:              PASS/FAIL
  04 Scope Admission:         PASS/FAIL
  05 Trigger Fire:            PASS/FAIL
  06 Rule Cascade:            PASS/FAIL
  07 Escalation:              PASS/FAIL
  08 Recovery:                PASS/FAIL
  09 Seed Rules:              PASS/FAIL
  10 Weather Team UAT:        PASS/FAIL
  11 Scheduled Tasks:         PASS/FAIL
  12 Multi-Team Routing:      PASS/FAIL
  13 Task Lifecycle:          PASS/FAIL
  14 Concurrent Resilience:   PASS/FAIL

Total: N/14 suites passed
Failures: [details]
```
