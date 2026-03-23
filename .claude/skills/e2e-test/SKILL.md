# E2E Test Skill

Run OpenHive v3 tests. Two modes: `quick` (vitest only) and `docker` (full Docker E2E).

## Quick Mode (default)

Run unit/integration tests without Docker:

```bash
cd /app/openhive/backend
npx tsc --noEmit                    # Type check
npx eslint src/ --max-warnings 0    # Lint
npx vitest run                      # All tests
```

Report: tsc errors, eslint warnings, test pass/fail count.

## Docker Mode

Run full E2E tests against a running Docker container:

```bash
cd /app/openhive/backend
npx tsx src/e2e/runner.ts --tier1-only
```

This will:
1. Build the Docker image from `deployments/Dockerfile`
2. Start a container with E2E fixtures (test config, no real API keys)
3. Wait for the health endpoint to return 200
4. Run Tier 1 suites:
   - Health endpoint returns 200 with storage OK
   - Container started successfully (.run/ structure created)
   - Triggers component initialized
   - POST /api/message endpoint works
   - Seed rules applied without errors
5. Tear down container and clean up

### Tier 2 (requires ANTHROPIC_API_KEY)

For AI integration tests, remove `--tier1-only`:

```bash
ANTHROPIC_API_KEY=sk-ant-... npx tsx src/e2e/runner.ts
```

## Prerequisites

- Docker and docker compose must be available
- For Docker mode: port 18080 must be free
- For Tier 2: valid Anthropic API key

## Troubleshooting

If Docker tests fail:
1. Check container logs: `docker compose -f <test-dir>/docker-compose.yml logs`
2. Verify Docker is running: `docker info`
3. Check port availability: `lsof -i :18080`
