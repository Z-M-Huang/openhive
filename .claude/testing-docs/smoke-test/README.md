# Smoke Test Scenarios

Test docs for the `smoke-test` skill. Each file is a self-contained scenario with setup, tests, and teardown.

## Conventions

### File Format

```yaml
---
name: Human Readable Name
id: short-id
requires_rebuild: false   # true = full Docker teardown+rebuild before this scenario
timeout: 120              # max seconds for the entire scenario (0 = no limit)
---
```

Sections: `## Overview`, `## Setup`, `## Tests`, `## Teardown`.

### Test Step Format

```markdown
### N. Test Name

**Run:**
\`\`\`bash
command here
\`\`\`

**Expected:**
- Assertion 1
- Assertion 2
```

### Pass/Fail Rules

- **PASS** — all assertions met
- **FAIL** — any assertion not met (include actual output)
- **SKIP** — scenario timeout or dependency not met

## Key Reference Facts

These facts are verified against the codebase. Test assertions MUST match these.

### Container Paths (Two Paths Only)

| Inside Container | Purpose |
|-----------------|---------|
| `/app/workspace` | Team workspace (root mounts `.run/workspace/`) |
| `/app/data` | Config files (root only, mounts `data/`) |

Team workspaces nest: `/app/workspace/teams/<slug>/` inside root container.
SQLite DB: `/app/workspace/openhive.db` (root only).

### API Error Codes

| Source | Code | When |
|--------|------|------|
| API channel (`POST /api/v1/chat`) | `INVALID_REQUEST` | Missing/empty content |
| API channel | `TIMEOUT` | Agent didn't respond in 5 min |
| API channel | `CHANNEL_UNAVAILABLE` | Channel not connected |
| Domain: `ValidationError` | `VALIDATION_ERROR` | Input validation fails |
| Domain: `NotFoundError` | `NOT_FOUND` | Resource doesn't exist |
| Domain: `ConflictError` | `CONFLICT` | Duplicate resource |
| Domain: `RateLimitedError` | `RATE_LIMITED` | Rate limit exceeded (429) |
| Domain: `EncryptionLockedError` | `ENCRYPTION_LOCKED` | Master key not set (423) |
| Fastify schema validation | `Bad Request` (default format) | Query/param schema fails |
| Catch-all | `INTERNAL_ERROR` | Unhandled error (500) |

### API Response Envelope

- Success: `{ "data": <payload> }`
- Error: `{ "error": { "code": "...", "message": "..." } }`
- Fastify schema errors use Fastify's default format: `{ "statusCode": 400, "error": "Bad Request", "message": "..." }`

### Task Status Enum

Valid: `pending`, `running`, `completed`, `failed`, `cancelled`, `escalated`

REST filter (`GET /api/v1/tasks?status=X`): only `pending`, `running`, `completed`, `failed`, `cancelled` (NOT `escalated`).

Default (no filter): returns `running` tasks only.

### Task Dispatch Behavior

- `dispatch_task` / `dispatch_subtask` create task as `pending`
- If `blocked_by` is empty: task is dispatched to container via WS and promoted to `running`
- If `blocked_by` is non-empty: task stays `pending` — NOT dispatched until all blockers complete
- When a blocker completes, the orchestrator removes it from dependents' `blocked_by` arrays
- When a task's `blocked_by` becomes empty, the orchestrator auto-dispatches and promotes to `running`
- `MAX_BLOCKED_BY = 50` — validation error if exceeded
- Cycle detection via `wouldCreateCycle()` before task creation

### API Channel Sessions

- Each `POST /api/v1/chat` gets a unique JID (`api:1`, `api:2`, ...)
- No cross-request session persistence
- Multi-turn conversation requires persistent channels (Discord, WhatsApp)

### OrgChart

- Synthetic `main` team exists internally but is excluded from `getOrgChart()`
- `GET /api/v1/teams` returns `[]` when no configured teams exist
- Main assistant AID: `aid-main-001` (configured in `data/openhive.yaml`)
- Main assistant has NO supervisor — `getSupervisor('aid-main-001')` returns `null`

### Team Lifecycle

- Two-step creation: `create_agent` first (returns AID), then `create_team` (uses that AID as leader)
- `create_agent` uses `description` param (not `role_file`). Agent `.md` file written to `.claude/agents/<name>.md`
- `deleteTeam` marks in-progress tasks as `failed` (not `cancelled`) with error "team deleted"
- Team lead runs in the PARENT container (not the team's own container)

### Cancel Cascade

- `cancel_task(task_id, cascade=true)` cancels parent + pending/running subtasks
- Tasks that already completed are NOT cancelled (race condition possible)
- Returns `cancelled_ids` array (only IDs that were actually cancelled)

### Escalation

- `escalate` tool delegates to `EscalationRouter.handleEscalation()`
- Router resolves supervisor via OrgChart, then marks task as `escalated`
- If no supervisor exists, throws BEFORE marking task — task status unchanged
- `MAX_ESCALATION_DEPTH = 10`

### Webhooks

- Endpoint: `POST /api/v1/hooks/:path`
- Looks up trigger by `webhook_path` in TriggerStore
- Returns 404 if no matching trigger
- No SDK tool or REST endpoint to CREATE triggers — only unit-testable for happy path

### Rate Limiting

- `SlidingWindowRateLimiter` with per-action limits
- Defaults: `create_team=5`, `dispatch_task=30`, `dispatch_subtask=30`, `escalate=10`
- Window: configurable (default varies)

## Session Persistence Warning

Each `POST /api/v1/chat` request gets a fresh JID (`api:1`, `api:2`, ...) — **no session persistence** across requests. When a test depends on data from a prior test (e.g., task IDs), the test executor must extract values from responses and inject them into subsequent prompts. Tests that ask the agent to do two things "in one prompt" (dispatch + escalate) work because both happen within a single agent session.

## Scenario Index

| # | File | Tests | Rebuild? |
|---|------|-------|----------|
| 00 | environment | Health, DB, workspace, schema | No |
| 01 | rest-api | Endpoints, headers, config, auth | No |
| 02 | chat-channel | API channel, routing logs | No |
| 03 | team-rest | Team CRUD via REST | No |
| 04 | team-sdk | Team CRUD via SDK tools | No |
| 05 | workspace | Scaffolding verification | No |
| 06 | team-e2e | **Deep** weather team E2E (14 tests) | No |
| 07 | logging | Structured logs, correlation, redaction | No |
| 08 | memory | save/recall_memory, consolidate | No |
| 09 | task-dag | blocked_by, retry, limits | No |
| 10 | cancel-cascade | Parent/subtask cancellation | No |
| 11 | task-rest | Task REST endpoints | No |
| 12 | escalation | Escalation error path | No |
| 13 | webhooks | Webhook error paths | No |
| 14 | rate-limiting | Rate limit enforcement (optional) | No |
| 15 | sdk-tools-extra | update_config SDK, delete_agent, update_team, get_member_status, dispatch_task_and_wait, get_task_status, get_system_status, list_channels | No |
