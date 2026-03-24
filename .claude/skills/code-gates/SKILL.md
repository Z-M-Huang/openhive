---
name: code-gates
description: Run code quality gates — type check, lint, unit tests. Fast, no Docker needed.
user-invocable: true
---

# Code Quality Gates

Fast code-level quality checks. No Docker, no API keys needed.

## Steps

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

### Step 4: Quick E2E Tests (no Docker)
```bash
npx vitest run src/e2e/ 2>&1
```

### Step 5: Report
```
=== Code Gates Report ===
Type Check:    PASS/FAIL
Lint:          PASS/FAIL
Unit Tests:    PASS/FAIL (N passed, N failed)
Quick E2E:     PASS/FAIL (N passed)
```
