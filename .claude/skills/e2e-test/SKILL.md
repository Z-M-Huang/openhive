# E2E Test Skill

Run the full OpenHive v3 test suite.

## Steps
1. Type check: `cd /app/openhive/backend && npx tsc --noEmit`
2. Lint: `npx eslint src/`
3. Tests with coverage: `npx vitest run --coverage`
4. Verify 95% coverage threshold
5. Report results
