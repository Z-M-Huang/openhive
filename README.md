# OpenHive v4

AI agent orchestration platform built on the **Agent as a Feature** principle -- every user message
flows directly to an AI agent that decides how to respond.

## What Is It

OpenHive manages a tree of autonomous AI teams. You talk to a main assistant via WebSocket, Discord,
or CLI. The assistant delegates work to specialized child teams, each running as a
Vercel AI SDK session with its own rules, skills, memory, and credentials.

## Key Principles

- **Agent as a Feature** -- Messages go to AI first. No hardcoded routing or static responses.
  The agent decides: acknowledge, clarify, answer, or delegate.
- **Rules-first** -- Behavior is defined in markdown rule files, not code.
- **Uniform recursive design** -- Every team has identical structure. Teams spawn children
  identical to themselves.
- **Disposable sessions, durable state** -- Each message is a fresh session. State lives in
  files and SQLite.

## Architecture

```
User --> Channel (WS/Discord/CLI)
              |
              v
         Main Agent --> inline tools (team management)
           |-- team-alpha (API dev)
           |     '-- alpha-child (frontend)
           '-- team-beta (operations)
                 '-- triggers -> scheduled tasks
```

### v4 Changes from v3

- **Inline AI SDK tools** replace HTTP MCP transport -- tools are `tool()` definitions passed directly to `streamText()`
- **Typed task queue** -- `TaskType` enum routes tasks; `sourceChannelId` is a first-class column
- **Prompt cache boundary** -- system prompt split into static/dynamic parts for Anthropic cache optimization
- **Tool audit logging** -- three-tier logging (debug/trace/info) via `withAudit()`
- **OrgToolContext** -- interface-first dependency injection for all tool builders

## Quick Start

```bash
# Docker (recommended)
docker compose -f deployments/docker-compose.yml up -d

# Or build from source
bun install
bun run build
bun run test

# Health check
curl http://localhost:8080/health

# Connect via WebSocket
wscat -c ws://localhost:8080/ws
```

## Documentation

See the [wiki](../../wiki) for full documentation:
- [Design Principles](../../wiki/Design-Principles) -- Core philosophy
- [Architecture](../../wiki/Architecture) -- Technical reference
- [Rules Architecture](../../wiki/Rules-Architecture) -- Rule system
- [Architecture Decisions](../../wiki/Architecture-Decisions) -- ADR log
