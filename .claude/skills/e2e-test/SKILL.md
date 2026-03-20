---
name: e2e-test
description: Run OpenHive end-to-end regression tests across all phase gates and system scenarios. Use when the user asks to test the system, run regression tests, or validate changes.
user-invocable: true
---

# OpenHive E2E Test Runner

Run the FULL test suite: unit tests, phase gates, Docker build, ALL live E2E suites. **Never skip any test.**

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

**Always run Docker E2E. Never skip suites.**

Check Docker availability:
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

**3d. Run ALL live E2E tests** — execute every suite below in order. Do NOT skip any.

**3e. Cleanup:**
```bash
sudo docker compose -f deployments/docker-compose.yml down -v 2>&1
```

If `DOCKER_UNAVAILABLE`: Report error — Docker is required for E2E testing.

### Step 4: Phase Gate Summary
Extract from Step 2 results: layer name, pass/fail count, any failures.

### Step 5: Report
```
=== OpenHive E2E Test Results ===

Type Check:       PASS/FAIL
Backend Tests:    PASS/FAIL (N passed, N failed)
Docker Build:     PASS/FAIL
Docker Runtime:   PASS/FAIL

Phase Gates: L0-L11 summary

Live E2E Suites (ALL must run):
  01 Basic Connectivity:       PASS/FAIL
  04 REST API Baseline:        PASS/FAIL
  ...
  32 Identity & Channel:       PASS/FAIL

Total: N/N suites passed
Failures: [details]
```

---

## Live E2E Test Suites

**Run ALL suites. Never skip any.** These run against the single Docker instance from Step 3.

Note on suites that modify state (09, 28, 29, 30, 31): run them in order, clean up after each. If a suite leaves the server degraded (e.g., fast cron trigger), restart the Docker instance before the next suite:
```bash
sudo docker compose -f deployments/docker-compose.yml down -v 2>&1 || true
sudo rm -rf /app/openhive/.run/workspace && mkdir -p /app/openhive/.run/workspace
sudo docker compose -f deployments/docker-compose.yml up -d 2>&1
# wait for health
```

### Suite 01: Basic Connectivity
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

### Suite 09: Team Creation
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
- PASS if containers endpoint responds

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

### Suite 28: Live Integration Invocation
Test `invoke_integration` with a real HTTP call to Open-Meteo weather API (free, no key).
```bash
echo 'Use create_integration to create an HTTP integration called weather-check with base_url https://api.open-meteo.com and a GET endpoint named forecast at path /v1/forecast?latitude=26.37&longitude=-80.13&current_weather=true with no auth needed. Then test_integration, activate_integration, and invoke_integration forecast endpoint to get the current weather for Boca Raton.' | timeout 300 bun run cli/index.ts 2>&1
```
- PASS if response contains `[Assistant]` and integration appears in `GET /api/integrations`
- Timeout: 300s (integration lifecycle is multi-step)

### Suite 29: Cron Trigger Fire
Test trigger→task→result chain. Register a fast cron, verify it creates a task.
```bash
echo 'Use the register_trigger tool to create a trigger named health-pulse with schedule */10 * * * * * targeting team main with prompt Report system health briefly' | timeout 300 bun run cli/index.ts 2>&1
```
- Wait 15s, then poll `GET /api/tasks` for task with title containing "Triggered:"
- PASS if triggered task found
- **Important:** This suite leaves a fast cron running. Restart Docker before the next suite.

### Suite 30: Container Restart via API
Test container restart + recovery using the REST API directly.
```bash
# Create team via API
curl -sf -X POST http://localhost:8080/api/teams \
  -H 'Content-Type: application/json' \
  -d '{"slug":"resilience-test","leader_aid":"aid-main-001"}'
sleep 5
# Restart
curl -sf -X POST http://localhost:8080/api/containers/resilience-test/restart \
  -H 'Content-Type: application/json' -d '{"reason":"e2e-test"}'
# Wait for recovery (poll every 5s for 60s)
# Verify health still OK
# Cleanup: DELETE /api/teams/resilience-test
```
- PASS if container restarts and system health remains healthy

### Suite 31: Tool-First Behavior
Verify the assistant uses MCP tools (save_memory, create_agent) instead of direct file writes.
```bash
echo 'Remember that my favorite programming language is Rust and I work at SpaceX' | timeout 120 bun run cli/index.ts 2>&1
```
- Check `GET /api/logs?limit=50` — search `params` field for `save_memory`
- PASS if save_memory tool was called
```bash
echo 'Create an agent called code-helper that reviews TypeScript code for the main team. Give it a detailed description.' | timeout 300 bun run cli/index.ts 2>&1
```
- Check `GET /api/logs?limit=50` — search `params` field for `create_agent`
- PASS if create_agent tool was called
- Note: tool names appear in `params` field as `mcp__openhive-tools__<tool_name>`, not in `action` field

### Suite 32: Identity & Channel Awareness
Regression test for identity and channel context fixes.
```bash
echo 'Who are you? What is your name? Answer in one sentence.' | timeout 120 bun run cli/index.ts 2>&1
```
- PASS if response contains "OpenHive"
- FAIL if response contains "Claude Code"
```bash
echo 'Send me a weather update for Miami every 5 minutes' | timeout 120 bun run cli/index.ts 2>&1
```
- PASS if response does NOT contain "how would you like to receive" or "which channel"

### Suite 33: Web Browsing Tool
Test browse_web MCP tool with Playwright against https://example.com.
```bash
echo 'Use the browse_web tool with action fetch on url https://example.com' | timeout 120 bun run cli/index.ts 2>&1
```
- PASS if response contains "Example Domain"
```bash
echo 'Use browse_web with action extract_links on url https://example.com' | timeout 120 bun run cli/index.ts 2>&1
```
- PASS if response contains "iana.org"
```bash
echo 'Use browse_web with action screenshot on url https://example.com' | timeout 120 bun run cli/index.ts 2>&1
```
- PASS if response mentions screenshot file path
