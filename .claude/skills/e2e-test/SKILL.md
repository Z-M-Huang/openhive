---
name: e2e-test
description: Run E2E test suite and review results
user-invocable: true
---

# OpenHive E2E Test Runner

Runs the automated E2E test script, reads the structured report, reviews semantic checks, and investigates any failures.

**Run autonomously. Do not stop to ask the user.**

---

## Step 1: Run the test suite

```bash
node src/e2e/run-all.cjs --skip-build 2>&1 | tail -20
```

If a Docker image hasn't been built yet (health check fails on startup), re-run with build:
```bash
node src/e2e/run-all.cjs 2>&1 | tail -20
```

To run a single suite:
```bash
node src/e2e/run-all.cjs --skip-build --suite A 2>&1 | tail -20
```

## Step 2: Read the report

```bash
cat .run/e2e-report.json
```

The report contains:
- `suites`: Per-suite results with steps, verifications, WS responses, errors
- `semanticChecks`: Items requiring AI judgment (response content evaluation)
- `summary`: Aggregate pass/fail counts

## Step 3: Review semantic checks

For each item in `semanticChecks[]`:
1. Read the `question` (what to evaluate)
2. Read the `evidence` (the actual AI response text)
3. Determine if the evidence satisfies the question
4. Note any failures

## Step 4: Investigate failures

For any suite with `status: "failed"`:
1. Check `errors[]` for step-level failures
2. Check `verifications[]` for verify script failures (look at `checks` with `pass: false`)
3. Investigate root causes using:
   - DB queries: `node -e "const D=require('node_modules/better-sqlite3')('.run/openhive.db',{readonly:true}); ..."`
   - Docker logs: `sudo docker logs openhive 2>&1 | tail -50`
   - Filesystem: `ls .run/teams/` or `cat .run/teams/*/config.yaml`

## Step 5: Final report

```
=== OpenHive E2E Report ===

Phase A: Smoke Checks
  [pass/fail] (N checks passed)

Phase B: Suites
  Suite A (Teams + Hierarchy): [pass/fail]
  Suite B (Triggers + Notifications): [pass/fail]
  Suite C (Stress & Recovery): [pass/fail]
  Suite D (Browser): [pass/fail/skipped]
  Suite E (Context + Threading): [pass/fail]
  Suite F (Cascade Deletion): [pass/fail]
  Suite G (Skill Repository): [pass/fail]
  Suite H (Trust): [pass/fail]

Semantic Check Results:
  [List each semantic check with pass/fail and brief reasoning]

Critical Findings:
  [Any bugs or issues discovered]

Duration: Xs
```
