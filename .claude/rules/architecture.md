# OpenHive Architecture Rules

## Channel Adapters
- All channel adapters MUST implement `IChannelAdapter` from `domain/interfaces.ts`
- All adapters that handle user-facing messages MUST support `onProgress` for streaming ack/progress
- The `ChannelRouter` is for routing and notification delivery only — NOT for message handling
- Each adapter owns its inbound message flow and calls `handleMessage()` directly with `onProgress`
- Never expose transport internals (sockets, connections) outside the adapter class

## Session Execution
- `handleMessage()` is the single entry point for spawning SDK sessions
- Tools are provided as inline AI SDK `tool()` definitions via `OrgToolContext` — no HTTP MCP transport
- `assembleTools()` calls `buildOrgTools()`, `buildTriggerTools()`, `buildBrowserTools()`, `buildWebFetchTool()` plus built-in tools
- `resolveActiveTools()` filters the combined tool set against the team's `allowed_tools` config (deny-by-default)
- Session results MUST be returned as typed objects, not string-encoded errors
- Credential redaction MUST use the shared `scrubSecrets()` utility — never inline it
- Team config loading MUST use the shared `loadConfig()`/`safeLoadConfig()` from index.ts

## Task Queue
- Tasks are typed: `TaskType = 'delegate' | 'trigger' | 'escalation' | 'bootstrap'`
- `sourceChannelId` is a first-class column on `task_queue` — never smuggle it through JSON options
- `TaskOptions` is a typed interface (`{ maxTurns?: number }`) — never pass raw JSON strings
- `task-consumer.ts` routes on `task.type` — no hack patterns (correlationId prefix, options.internal)

## Tool System
- All tools MUST be wrapped with `withAudit()` from `sessions/tools/tool-audit.ts` for three-tier logging
- Tool builders receive `OrgToolContext` (interface-first) — all fields are domain interfaces
- Each handler defines its own narrowed `*Deps` interface — never pass the full context
- Tool names are bare (`spawn_team`, not `mcp__org__spawn_team`)

## Prompt System
- `buildSystemPrompt()` returns `{ staticPrefix, dynamicSuffix }` for cache optimization
- Static prefix: system rules + admin org-rules + tool usage guide + HTTP rules
- Dynamic suffix: core instructions + tool availability + credentials + team rules + skills + memory + history
- Anthropic provider gets cache hints on static prefix; other providers get concatenated string

## Lifecycle & Triggers
- Triggers are managed exclusively via inline tools (create_trigger, enable_trigger, disable_trigger, list_triggers, test_trigger, update_trigger)
- The `TriggerEngine` MUST support dynamic registration (not just startup-time)
- At startup, `loadFromStore()` loads all active triggers from the SQLite `trigger_configs` table

## Error Handling
- `entrypoint.ts` MUST handle both `uncaughtException` and `unhandledRejection`
- Transient network errors (EPIPE, ECONNRESET, ETIMEDOUT, UND_ERR_CONNECT_TIMEOUT) MUST be survived, not crash the process
- All async handler paths MUST have top-level try-catch — never fire-and-forget without error handling
- All catch blocks MUST log the error — never silently swallow exceptions

## Bootstrap & Composition
- The `ensureMainTeam()` function MUST seed `memory/MEMORY.md` if it doesn't exist
- Default team configs have `mcp_servers: []` — no org MCP injection
- New capabilities added to one adapter MUST be considered for all adapters
- Prefer injecting callbacks/interfaces over importing concrete classes across module boundaries
