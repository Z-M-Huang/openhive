# OpenHive Coding Standards

## Shared Utilities First
Before writing inline logic, check `src/domain/` for existing utilities. If the same logic appears in 2+ files, it MUST be extracted to `src/domain/`.

Available utilities:
- `domain/credential-utils.ts` — `extractStringCredentials()` for credential value extraction
- `domain/errors.ts` — `errorMessage()` for safe error message extraction
- `domain/safe-json.ts` — `safeJsonParse<T>()` for JSON parsing with error handling

## No Bare JSON.parse
Always use `safeJsonParse<T>()` from `domain/safe-json.ts` or wrap in try-catch with logging. Bare `JSON.parse()` crashes the process on malformed input.

```typescript
// BAD
const data = JSON.parse(rawString);

// GOOD
import { safeJsonParse } from '../domain/safe-json.js';
const data = safeJsonParse<MyType>(rawString, 'context-description') ?? {};
```

## No process.env Spreading
Bash tool and subprocesses MUST receive an explicit env allowlist. Never pass `{ ...process.env }` — it leaks API keys and secrets to child processes.

```typescript
// BAD
env: { ...process.env }

// GOOD — use the ENV_ALLOWLIST in sessions/tools/bash.ts
```

## Credential Handling
All credential extraction MUST go through `extractStringCredentials()` from `domain/credential-utils.ts`. Do not inline the `typeof v === 'string' && v.length >= 8` pattern.

```typescript
// BAD
const secrets = Object.values(creds).filter((v): v is string => typeof v === 'string' && v.length >= 8);

// GOOD
import { extractStringCredentials } from '../domain/credential-utils.js';
const secrets = extractStringCredentials(creds);
```

## Error Handling
All error message extraction MUST use `errorMessage()` from `domain/errors.ts`. Do not inline the `instanceof Error` check.

```typescript
// BAD
const msg = err instanceof Error ? err.message : String(err);

// GOOD
import { errorMessage } from '../domain/errors.js';
const msg = errorMessage(err);
```

## New Tools Must Be Audited
Every tool added to the registry MUST be wrapped with audit hooks via `withAudit()` from `sessions/tools/tool-audit.ts`. This applies to built-in tools, MCP tools, and browser tools. Audit logs must include callerId, tool name, timestamp, and outcome.

## Schema Changes
Database schema changes MUST go through Drizzle `schema.ts` as the single source of truth. Do not add raw DDL in `database.ts`. The `tableToSQL()` function generates DDL from the Drizzle schema at runtime.

## Governance Logic
Governance classification logic (`OWN_TEAM_PREFIXES`, `classifyPath`, `classifyOwnTeamPath`) MUST be defined in `sessions/tools/tool-guards.ts` only. Do not duplicate governance rules in other files.
