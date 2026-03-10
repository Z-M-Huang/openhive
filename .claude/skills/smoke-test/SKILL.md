---
name: smoke-test
description: Smoke Test — comprehensive E2E testing against a live Docker container
---

# Smoke Test

Runs all E2E test scenarios from `.claude/testing-docs/smoke-test/` against a live Docker container.

## Architecture

```
.claude/skills/smoke-test/SKILL.md       <- This file (orchestrator)
.claude/testing-docs/smoke-test/          <- Test scenario docs
  00-environment.md ... 15-sdk-tools-extra.md
```

Each scenario doc is self-contained with its own setup, tests, and teardown. Read the `README.md` in the testing-docs folder for conventions and key reference facts.

## Execution

### Step 1: Initial Build & Start

Always start fresh. Detect host path, then clean + build + start:

```bash
export OPENHIVE_HOST_DIR=$(python3 -c "
import re
for line in open('/proc/1/mountinfo'):
    parts = line.split()
    if parts[4] == '/app':
        subpath = parts[3]
        opts = ' '.join(parts[9:])
        m = re.search(r'path=(.):',  opts)
        if m:
            print(f'/mnt/host/{m.group(1).lower()}{subpath}/openhive')
        else:
            print(f'{subpath}/openhive')
        break
" 2>/dev/null)

sudo chmod 666 /var/run/docker.sock
bun run docker:clean
bun run docker:build
bun run docker
```

Wait for health (up to 60s):

```bash
for i in $(seq 1 30); do
  if curl -sf http://localhost:8080/api/v1/health > /dev/null 2>&1; then
    echo "Server ready"; break
  fi
  sleep 2
done
```

### Step 2: Run Unit Tests (Pre-flight)

```bash
cd /app/openhive/backend && npx vitest run
```

All tests must pass before proceeding to scenario docs.

### Step 3: Execute Scenario Docs

1. Read `.claude/testing-docs/smoke-test/README.md` first — it contains key reference facts (error codes, container paths, API behavior) needed to interpret test assertions.
2. Read all numbered `*.md` files from `.claude/testing-docs/smoke-test/` in alphanumeric order (00, 01, ..., 14). Skip `README.md`.
3. For each scenario:
   - **Read** the file and parse YAML frontmatter (`name`, `id`, `requires_rebuild`, `timeout`)
   - **Rebuild** — if `requires_rebuild: true`, run the full teardown + rebuild from Step 1
   - **Setup** — execute the `## Setup` section (may be empty)
   - **Tests** — execute each test. For each:
     - Run the command(s) shown
     - Compare output against the `Expected:` assertion
     - Record PASS or FAIL
   - **Teardown** — execute `## Teardown` (even if tests failed)
4. Chat-based tests (using `POST /api/v1/chat`) use a 120s timeout. The agent needs time to invoke SDK tools via Claude SDK.
5. **Session persistence:** Each `POST /api/v1/chat` gets a fresh JID — no cross-request memory. When a test uses `${VARIABLE}` syntax, extract the value from the prior test's response and substitute it into the prompt before sending.

### Step 4: Report

Print a summary table after all scenarios complete:

```
| Scenario          | Test                     | Result | Notes          |
|-------------------|--------------------------|--------|----------------|
| 00-environment    | Health endpoint           | PASS   |                |
| 01-rest-api       | Security headers          | FAIL   | X-Frame missing |
| ...               | ...                      | ...    | ...            |
```

Totals: `N passed / M failed / K skipped`

On failure: include actual vs expected output AND relevant container logs (`docker compose -f deployments/docker-compose.yml logs --tail 50`).
