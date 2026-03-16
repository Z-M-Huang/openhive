---
name: e2e-test
description: Run OpenHive end-to-end regression tests across all phase gates and system scenarios. Use when the user asks to test the system, run regression tests, or validate changes.
user-invocable: true
---

# OpenHive E2E Test Runner

Run the full test suite for the OpenHive project — unit tests, phase gate integration tests, and system-level validation.

## Test Layers

1. **Unit tests** (vitest) — per-module, fast, mocked boundaries
2. **Phase gate tests** (vitest, layers 0-11) — integration tests proving each architectural layer
3. **Type check** — TypeScript strict compilation
4. **System validation** — verify the root process can start and respond

## Execution Steps

### Step 1: Type Check
```bash
cd /app/openhive && npx tsc --noEmit --project backend/tsconfig.json 2>&1 | grep "error" | grep -v ".test.ts" | head -20
```
Report any non-test type errors. Pre-existing Integration type errors are known and can be ignored.

### Step 2: Run Backend Tests
```bash
cd /app/openhive/backend && ./node_modules/.bin/vitest run 2>&1
```
Expected: 1,200+ tests pass. Report pass/fail counts per test file.

### Step 3: Run Web Tests
```bash
cd /app/openhive && bun run test 2>&1
```
Expected: 170+ web tests pass. Some may have pre-existing failures.

### Step 4: Phase Gate Summary
For each phase gate layer (0-11), report:
- Layer name and purpose
- Number of tests and pass/fail
- Any failures with error details

### Step 5: Failure Analysis
For any failing tests:
1. Read the test file to understand what's being tested
2. Read the corresponding source file
3. Identify root cause (code bug vs test bug vs known issue)
4. Suggest a fix

## Optional: Docker Smoke Test
If Docker is available and the user requests it:
```bash
cd /app/openhive && docker build -t openhive:latest -f deployments/Dockerfile . 2>&1 | tail -20
```
Report whether the image builds successfully.

## Reporting Format
```
=== OpenHive E2E Test Results ===

Type Check:     PASS/FAIL (N errors)
Backend Tests:  PASS/FAIL (N passed, N failed, N skipped)
Web Tests:      PASS/FAIL (N passed, N failed)

Phase Gates:
  L0  Stub scaffold:      SKIP (1 todo)
  L1  Config + logging:    PASS (N tests)
  L2  Storage:             PASS (N tests)
  ...
  L11 Integration:         PASS (N tests)

Failures: [details]
```

---

## E2E Test Suites

End-to-end test suites live as YAML files in `test-suites/` (relative to this skill). Each suite is a self-contained scenario with its own setup, teardown, and ordered test cases.

### How It Works

1. **Discover suites** -- List all `*.yaml` files in `test-suites/`, sorted by filename. Naming convention: `NN-suite-name.yaml` (e.g., `01-basic-connectivity.yaml`).
2. **For each suite, in order:**
   a. Print `=== Suite: <name> ===`
   b. Run all **setup** steps sequentially. If any setup step fails, mark the entire suite as FAILED and skip to teardown.
   c. Run each **test case** in order:
      - Execute each step's `command`
      - Check the output against `expected` (substring match unless otherwise noted)
      - Record PASS or FAIL per case
      - Continue to the next case even if one fails (test cases share the setup; no restart between cases)
   d. Run all **teardown** steps sequentially (always runs, even if setup or cases failed).
   e. Print suite summary: N passed, N failed out of N cases.
3. **Print final summary** across all suites.

### Clean-Start Semantics

Every suite begins with an absolutely clean environment. The first setup step should always be `docker compose down -v` (or equivalent) to remove all containers, volumes, and leftover state. This ensures no test pollution between suites.

Test cases **within** a suite share the environment created by setup. This avoids redundant startup costs -- group related cases that need the same running system into one suite.

### Suite YAML Format

```yaml
name: Suite Name
description: What this suite tests

setup:
  - command: "cd /app/openhive && docker compose -f deployments/docker-compose.yml down -v"
    description: "Clean start -- remove all containers and volumes"
  - command: "cd /app/openhive && bun run docker"
    description: "Build and start the server"
  - command: "sleep 10"
    description: "Wait for server to be ready"

teardown:
  - command: "cd /app/openhive && docker compose -f deployments/docker-compose.yml down -v"
    description: "Clean up -- remove all containers and volumes"

test_cases:
  - name: Test case name
    description: What this case verifies
    steps:
      - action: "Describe what this step does"
        command: "shell command to execute"
        expected: "Substring or pattern expected in stdout/stderr"
    expected_outcome: "Human-readable description of what success looks like"
```

**Field reference:**

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Suite display name |
| `description` | yes | What the suite tests (one sentence) |
| `setup` | yes | Ordered list of shell commands to prepare the environment |
| `setup[].command` | yes | Shell command to run |
| `setup[].description` | yes | What this setup step does |
| `teardown` | yes | Ordered list of shell commands to clean up (always runs) |
| `teardown[].command` | yes | Shell command to run |
| `teardown[].description` | yes | What this teardown step does |
| `test_cases` | yes | Ordered list of test cases |
| `test_cases[].name` | yes | Test case display name |
| `test_cases[].description` | yes | What this case verifies |
| `test_cases[].steps` | yes | Ordered list of actions within the case |
| `test_cases[].steps[].action` | yes | Human-readable description of the step |
| `test_cases[].steps[].command` | yes | Shell command to execute |
| `test_cases[].steps[].expected` | no | Expected substring in output (omit for fire-and-forget steps) |
| `test_cases[].expected_outcome` | yes | Human-readable success criteria for the whole case |

### E2E Suite Execution Steps

After running the unit tests, phase gates, and type checks described above, execute the E2E suites:

#### Step 6: Run E2E Test Suites
```bash
ls /app/openhive/.claude/skills/e2e-test/test-suites/*.yaml 2>/dev/null | sort
```

If no suite files exist, skip this section and report "No E2E test suites found."

For each suite file (sorted by name):
1. Read and parse the YAML file
2. Print the suite name and description
3. Execute setup steps in order; abort suite on failure
4. Execute each test case:
   - Run each step's command
   - If `expected` is present, check that stdout or stderr contains the expected substring
   - Record PASS/FAIL per case
5. Execute teardown steps (always, regardless of pass/fail)
6. Report results for this suite

#### Step 7: E2E Suite Results
Append to the test report:
```
E2E Suites:
  01-basic-connectivity:     PASS (3/3 cases)
  02-team-lifecycle:         FAIL (2/4 cases)
    FAILED: Create weather team — expected "team created" in output
  03-task-routing:           SKIP (setup failed)

E2E Suite Total: 2 suites passed, 1 failed
```
