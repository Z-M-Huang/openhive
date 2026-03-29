# OpenHive Architecture Rules

## Channel Adapters
- All channel adapters MUST implement `IChannelAdapter` from `domain/interfaces.ts`
- All adapters that handle user-facing messages MUST support `onProgress` for streaming ack/progress
- The `ChannelRouter` is for routing and notification delivery only — NOT for message handling
- Each adapter owns its inbound message flow and calls `handleMessage()` directly with `onProgress`
- Never expose transport internals (sockets, connections) outside the adapter class

## Session Execution
- `handleMessage()` is the single entry point for spawning SDK sessions
- Session results MUST be returned as typed objects, not string-encoded errors
- Credential redaction MUST use the shared `scrubSecrets()` utility — never inline it
- Team config loading MUST use the shared `loadConfig()`/`safeLoadConfig()` from index.ts

## Lifecycle & Triggers
- Triggers are managed exclusively via MCP tools (create_trigger, enable_trigger, disable_trigger, list_triggers, test_trigger, update_trigger)
- The `TriggerEngine` MUST support dynamic registration (not just startup-time)
- At startup, `loadFromStore()` loads all active triggers from the SQLite `trigger_configs` table

## Error Handling
- `entrypoint.ts` MUST handle both `uncaughtException` and `unhandledRejection`
- Transient network errors (EPIPE, ECONNRESET, ETIMEDOUT, UND_ERR_CONNECT_TIMEOUT) MUST be survived, not crash the process
- All async handler paths MUST have top-level try-catch — never fire-and-forget without error handling

## Bootstrap & Composition
- The `ensureMainTeam()` function MUST seed `memory/MEMORY.md` if it doesn't exist
- New capabilities added to one adapter MUST be considered for all adapters
- Prefer injecting callbacks/interfaces over importing concrete classes across module boundaries
