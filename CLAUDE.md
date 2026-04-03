# OpenHive v4 — Development Guide

## Architecture Overview

OpenHive is an AI agent orchestration platform. Teams form a tree (org-tree), each running
Vercel AI SDK sessions with inline tools, rules, memory, and credentials.

### Core Components

```
src/
  index.ts              -- Bootstrap, Fastify server, graceful shutdown
  entrypoint.ts         -- Process-level error handling
  bootstrap-helpers.ts  -- ensureMainTeam(), migrateAllowedTools()
  domain/               -- Types, interfaces, errors, safe-json, credential-utils, org-tree
  storage/              -- SQLite via Drizzle ORM (schema.ts = source of truth)
    stores/             -- 8 store implementations (task-queue, credentials, triggers, etc.)
  sessions/
    message-handler.ts  -- Single entry point: handleMessage() -> assembleTools() -> runSession()
    ai-engine.ts        -- Vercel AI SDK streamText() with tool loop
    prompt-builder.ts   -- {staticPrefix, dynamicSuffix} for cache optimization
    task-consumer.ts    -- Dequeue loop, routes on TaskType
    tools/
      org-tools.ts      -- 10 org management tools (delegate, escalate, spawn, etc.)
      trigger-tools.ts  -- 6 trigger management tools
      browser-tools.ts  -- 8 browser automation tools
      web-fetch-tool.ts -- HTTP fetch with SSRF protection
      active-tools.ts   -- resolveActiveTools() deny-by-default filter
      guards.ts         -- assertCallerIsParent(), assertBrowserEnabled()
      tool-audit.ts     -- withAudit() three-tier logging
      tool-guards.ts    -- Governance: classifyPath, OWN_TEAM_PREFIXES
  channels/             -- WebSocket, Discord, CLI adapters + router
  triggers/             -- TriggerEngine, dedup, rate-limiter
  rules/                -- cascade.ts (Tier 1-4 rule loading)
  handlers/tools/       -- 17 handler functions (business logic, interface-first deps)
  config/               -- loader.ts (team config YAML)
system-rules/           -- Tier 1 immutable rules (baked into Docker)
seed-rules/             -- Default org-rules copied on first start
```

### Key Patterns

- **Inline AI SDK tools**: Tools are `tool()` definitions from Vercel AI SDK, passed to `streamText()`.
  No HTTP MCP transport.
- **OrgToolContext**: Interface-first dependency bag for tool builders.
  Each handler defines its own narrowed `*Deps` interface.
- **Typed task queue**: `TaskType = 'delegate' | 'trigger' | 'escalation' | 'bootstrap'`.
  `sourceChannelId` is a first-class DB column.
- **Prompt cache**: Static prefix (system rules + admin rules) cached across teams.
  Dynamic suffix (team rules + credentials + memory) varies per request.
- **Tool audit**: All tools wrapped with `withAudit()` for debug/trace/info logging.
- **Rules cascade**: Tier 1 (system) + Tier 2 (admin org) = static.
  Tier 3 (ancestor org) + Tier 4 (team) = dynamic.

## Development Commands

```bash
bun install          # Install dependencies
bun run build        # TypeScript compile (tsc)
bun run test         # Run vitest
bun run lint         # ESLint
bun run smoke        # Phase gate tests only
```

## Coding Standards

See `.claude/rules/coding-standards.md` for detailed rules. Key points:
- Use `safeJsonParse()` instead of bare `JSON.parse()`
- Use `errorMessage()` instead of `instanceof Error` checks
- Use `extractStringCredentials()` for credential extraction
- Never spread `process.env` into child processes
- All tools must be wrapped with `withAudit()`
- Schema changes go through Drizzle `schema.ts`

## Testing

- Tests live next to modules (`*.test.ts`)
- E2E tests in `src/e2e/`
- Run specific tests: `npx vitest run src/path/to/test.ts`
- Mock patterns in `src/handlers/__test-helpers.ts`
