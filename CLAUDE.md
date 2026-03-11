# OpenHive v2 -- Developer Reference

AI agent orchestration platform. User talks to an assistant via messaging channels. The assistant creates hierarchical teams of agents in Docker containers. Each container runs multiple Claude Agent SDK instances managed by a unified orchestrator. Single TypeScript/Bun codebase runs in all containers.

---

## Three Core Definitions

| Entity | Definition |
|--------|-----------|
| **User** | External human who interacts via messaging channels. Ultimate authority: can override any policy, cancel any task, reshape any team. Not containerized. Final escalation target. |
| **Agent** | A Claude Agent SDK instance (standalone process) with AID (`aid-name-hexchars`), definition file, model tier, skills, and timeout. Every AI entity is an agent -- main assistant, team leads, members. Role is an assignment, not a type hierarchy. |
| **Team** | A group of agents with a designated lead, running in an isolated Docker container. Unit of isolation, deployment, and capability scoping. Identified by TID (`tid-name-hexchars`) and slug. Recursively nestable. |

---

## Three-Layer Architecture

```
Skills Layer (20-30 SKILL.md files)
  |  LLM reads skills, calls tools
  v
MCP Tools Layer (~22 built-in tools)
  |  Tools execute against infrastructure
  v
Infrastructure Layer (~4,000-5,000 lines TypeScript)
```

**Skills** define what agents do and when (orchestration, behavior, integration playbooks). **MCP Tools** provide validated, schema-checked I/O between LLM and infrastructure. **Infrastructure** enforces invariants, manages lifecycle, persists state.

Behavioral decisions live in skills. Structural guarantees live in code. This separation is governed by the invariants-vs-policies framework: invariants are things that must always hold true (code); policies depend on judgment and context (skills).

---

## Design Invariants (MUST NEVER violate)

| ID | Rule | Description |
|----|------|-------------|
| INV-01 | Team lead in parent container | Team lead always executes in the parent container, never in the team's own container. |
| INV-02 | All messages through root WS hub | All inter-container messages route through root's WebSocket hub. |
| INV-03 | No container-to-container communication | ICC disabled. All traffic goes through root. No direct links between non-root containers. |
| INV-04 | Single SQLite writer | Only the root container writes to SQLite. Non-root containers forward data via WebSocket. |
| INV-05 | Root spawns all containers | All container spawning goes through root's Docker socket. Non-root containers request creation via WS. |
| INV-06 | Same image everywhere | Single `openhive` image. `OPENHIVE_IS_ROOT=true` toggles root-only services. |
| INV-07 | Per-agent memory | Agent memory is scoped per-agent, not per-team. Agents share a workspace but have separate memory directories. |
| INV-08 | Team-scoped skill copies | Skills are team-scoped local copies. Can be sourced from registries but never shared live references between teams. |
| INV-09 | Invariants in code, policies in skills | Code enforces invariants (security, isolation, data integrity). Skills encode policies (when to escalate, how to prioritize, what tone to use). |
| INV-10 | Root is a control plane | The root process orchestrates, validates, and audits. It is not a pass-through message bus. Every tool call is validated at root before execution. |

---

## Configurable Constraints

Defaults tuneable per deployment. Changing a default requires a new ADR.

| ID | Rule | Default | Config key |
|----|------|---------|------------|
| CON-01 | Max team nesting depth | 3 | `limits.max_depth` |
| CON-02 | Max teams per parent | 10 | `limits.max_teams` |
| CON-03 | Max agents per team | 5 | `limits.max_agents_per_team` |
| CON-04 | File watcher debounce | 500 ms | Hard-coded in ConfigLoader |
| CON-05 | Heartbeat interval | 30 s | Hard-coded in container health monitor |
| CON-06 | Unhealthy threshold | 90 s (3 missed heartbeats) | Hard-coded in container health monitor |
| CON-07 | Proactive check minimum interval | 5 min | `proactive_interval_minutes` in team.yaml / agent config |
| CON-08 | Proactive check default interval | 30 min | `proactive_interval_minutes` in team.yaml (default: 30) |
| CON-09 | Tool timeout: query tools | 10 s | Implementation-defined |
| CON-10 | Tool timeout: mutating tools | 60 s | Implementation-defined |
| CON-11 | Tool timeout: blocking tools | 5 min | Implementation-defined |
| CON-12 | Skill files max 500 lines | ~500 lines | Per-skill convention |

---

## Technology Stack

| Component | Technology | Notes |
|-----------|-----------|-------|
| Language | TypeScript 5.x | Strict mode enforced (`strict: true`, `noUnusedLocals`, `noImplicitReturns`) |
| Dev runtime / Package manager | **Bun 1.3+** | All installs, scripts, and test execution via `bun` |
| Production runtime | Node.js 22 LTS | `node:22-bookworm-slim` base image |
| Agent SDK | @anthropic-ai/claude-agent-sdk 0.2.x | One SDK instance per agent |
| MCP SDK | @modelcontextprotocol/sdk 1.8.x | In-process MCP server for built-in tools |
| Database | SQLite (better-sqlite3 9.x) + Drizzle ORM 0.41.x | WAL mode, single-writer (INV-04) |
| WebSocket | ws 8.x | Hub-and-spoke topology |
| HTTP server | Fastify 5.x | REST API + web portal serving |
| Validation | Zod 3.x | Runtime schema validation |
| Logging | Pino 9.x | Structured JSON logging to stdout |
| Containers | Docker 24+, dockerode 4.x | Sibling containers (no DinD) |
| Config parsing | yaml 2.x | YAML config file parsing |
| File watching | chokidar 4.x | Config/skill file hot-reload |
| Scheduling | node-cron 3.x | Cron-based trigger scheduling |
| Encryption | Node.js crypto (AES-256-GCM) + argon2 0.43.x | Master key derivation |
| Web portal | React 18.x + Vite 6.x + shadcn/ui + TanStack Query 5.x | Monitoring SPA, no AI in frontend |
| Testing | vitest 3.x + @vitest/coverage-v8 | Interface-first test doubles |
| E2E testing | Playwright 1.50.x | Web portal E2E |
| Linting | ESLint 8.x + @typescript-eslint 8.x | Code quality |

**Provider model:** Anthropic-protocol only. Skills specify model tier (`haiku`/`sonnet`/`opus`); providers map tiers to actual model names.

---

## Conventions

- **Strict TypeScript** -- no `any`, no `as` casts without justification, strict null checks
- **Interface-first** -- every external dependency behind an interface in `src/domain/interfaces.ts`
- **Test doubles** -- manual mock objects implementing interfaces via `vi.fn()`, no mock libraries
- **File naming** -- kebab-case for all files (skills, agents, source)
- **Slug format** -- `^[a-z0-9]+(-[a-z0-9]+)*$`, 3-50 chars
- **ID formats** -- `aid-name-hexchars`, `tid-name-hexchars`
- **Reserved slugs** -- `main`, `admin`, `system`, `root`, `openhive`
- **Test co-location** -- `foo.test.ts` next to `foo.ts`
- **Coverage** -- 95% for core domain (`domain/`, `orchestrator/`, `executor/`, `store/`), 80% for API/WS/web
- **Package manager** -- `bun` (not npm, not yarn)
- **Test runner** -- `npx vitest run` (not `bun test`)

---

## Project Structure

```
openhive/
+-- package.json              # Workspace root (workspaces: backend, web)
+-- backend/
|   +-- package.json
|   +-- tsconfig.json
|   +-- vitest.config.ts
|   +-- src/
|       +-- index.ts                        # Entry point (checks OPENHIVE_IS_ROOT)
|       +-- domain/                         # Core types, interfaces, errors, enums
|       |   +-- domain.ts                   # Domain types
|       |   +-- interfaces.ts               # All interfaces (single file)
|       |   +-- errors.ts                   # Domain error classes
|       |   +-- enums.ts                    # Enums (TaskStatus, LogLevel, etc.)
|       |   +-- index.ts                    # Barrel export
|       +-- control-plane/                  # Root orchestration
|       |   +-- orchestrator.ts             # Unified orchestrator
|       |   +-- router.ts                   # Two-tier routing
|       |   +-- event-bus.ts                # In-memory pub/sub
|       |   +-- org-chart.ts                # Hierarchy tracking
|       |   +-- workspace-lock.ts           # Workspace mutex
|       +-- executor/                       # SDK process lifecycle
|       |   +-- executor.ts                 # Agent executor
|       |   +-- session.ts                  # SDK session management
|       |   +-- hooks.ts                    # PreToolUse/PostToolUse hooks
|       +-- containers/                     # Docker management (root-only)
|       |   +-- runtime.ts                  # Container create/start/stop
|       |   +-- manager.ts                  # Lifecycle coordination
|       |   +-- provisioner.ts              # Workspace provisioning
|       |   +-- health.ts                   # Health checks, stuck agent detection
|       +-- mcp/                            # MCP tool implementations
|       |   +-- tools/index.ts              # ~22 tool handlers
|       |   +-- bridge.ts                   # WebSocket <-> MCP bridge
|       |   +-- registry.ts                 # Tool registration and discovery
|       +-- websocket/                      # WS server + hub
|       |   +-- server.ts                   # WS hub server (root-only)
|       |   +-- hub.ts                      # Connection registry, message routing
|       |   +-- connection.ts               # WS client connection wrapper
|       |   +-- protocol.ts                 # Wire format, direction validation
|       |   +-- token-manager.ts            # One-time auth tokens
|       +-- storage/                        # SQLite + file storage (root-only)
|       |   +-- database.ts                 # Drizzle ORM setup, WAL mode
|       |   +-- schema.ts                   # Drizzle schema definitions
|       |   +-- stores/index.ts             # Store implementations
|       +-- channels/                       # External messaging adapters (root-only)
|       |   +-- adapter.ts                  # Channel adapter interface
|       |   +-- discord.ts                  # Discord adapter
|       |   +-- router.ts                   # Message routing
|       +-- api/                            # REST API (root-only)
|       |   +-- server.ts                   # Fastify server setup
|       |   +-- routes/index.ts             # Route handlers
|       |   +-- portal-ws.ts                # Web portal WebSocket relay
|       +-- config/                         # Configuration loading
|       |   +-- loader.ts                   # YAML config loader
|       |   +-- defaults.ts                 # Default config values
|       |   +-- validation.ts               # Zod schema validation
|       +-- logging/                        # Logging infrastructure
|       |   +-- logger.ts                   # Pino logger setup
|       |   +-- sinks.ts                    # DB sink, file sink
|       +-- security/                       # Credentials, auth
|       |   +-- key-manager.ts              # AES-256-GCM encryption
|       +-- skills/                         # Skill management
|       |   +-- loader.ts                   # Skill file loader
|       |   +-- registry.ts                 # Skill registry
|       +-- triggers/                       # Event triggers
|       |   +-- scheduler.ts                # Cron, webhook, event triggers
|       +-- phase-gates/                    # Integration tests (L0-L11)
|           +-- layer-0.test.ts .. layer-11.test.ts
+-- web/                                    # React SPA (monitoring portal)
|   +-- package.json
|   +-- tsconfig.json
|   +-- vite.config.ts
|   +-- src/
+-- common/                                 # Baked into Docker image at /app/common/
|   +-- skills/                             # 6 common skills
|   |   +-- escalation/SKILL.md
|   |   +-- health-report/SKILL.md
|   |   +-- integration-usage/SKILL.md
|   |   +-- memory-management/SKILL.md
|   |   +-- system-smoke/SKILL.md
|   |   +-- task-completion/SKILL.md
|   +-- scripts/                            # Utility helpers (.gitkeep)
|   +-- templates/                          # Standard format templates (.gitkeep)
+-- data/                                   # Config files (version-controlled)
|   +-- openhive.yaml                       # Not in git (has secrets) -- see example
|   +-- providers.yaml                      # Not in git (has API keys) -- see example
+-- deployments/
|   +-- Dockerfile                          # Multi-stage build
|   +-- docker-compose.yml                  # Development orchestration
|   +-- openhive.yaml.example               # Example config
|   +-- providers.yaml.example              # Example providers
+-- .env.example                            # Environment variables template
```

The same codebase ships in every container. `OPENHIVE_IS_ROOT=true` activates: channels, database, REST API, WebSocket hub server, Docker socket access. Non-root containers run: orchestrator, agent executors, WebSocket client.

---

## Configuration Files

| File | Scope | Location | Purpose |
|------|-------|----------|---------|
| `openhive.yaml` | Global | `data/openhive.yaml` | System settings, assistant config, channels, limits, triggers |
| `providers.yaml` | Global | `data/providers.yaml` | AI provider presets (API keys -- gitignored) |
| `team.yaml` | Per-team | `<workspace>/team.yaml` | Team config (agents, MCP servers, triggers) |
| Agent `.md` files | Per-agent | `<workspace>/.claude/agents/<name>.md` | Agent definition (YAML frontmatter + system prompt) |
| `CLAUDE.md` | Per-team | `<workspace>/.claude/CLAUDE.md` | Team instructions for agents |
| `settings.json` | Per-team | `<workspace>/.claude/settings.json` | Allowed tools for Claude Agent SDK |
| Integration YAML | Per-team | `<workspace>/integrations/<name>.yaml` | Declarative integration configs |
| `.env` | Global | Project root | Environment variable overrides |

**Config resolution order:** Compiled defaults -> YAML files -> `OPENHIVE_*` env vars. Containers receive resolved config via `container_init` WebSocket message.

---

## Container Architecture

```
Root Container (OPENHIVE_IS_ROOT=true):
  +-- Main Assistant (agent)
  +-- Team-A Lead (agent)          <-- leads Team A, runs HERE (INV-01)
  +-- Team-B Lead (agent)          <-- leads Team B, runs HERE (INV-01)
  +-- WebSocket Hub Server         (INV-02)
  +-- REST API + Web Portal
  +-- SQLite Database              (INV-04)
  +-- Channel Adapters (Discord)

Team-A Container:
  +-- Member-1 (agent)
  +-- Member-2 (agent)
  +-- Sub-Team-A1 Lead (agent)     <-- leads Sub-Team-A1, runs HERE (INV-01)

Sub-Team-A1 Container:
  +-- Member-3 (agent)
  +-- Member-4 (agent)
```

All containers run from the same Docker image (INV-06). ICC disabled (INV-03). All traffic through root hub (INV-02).

---

## Workspace Layout

```
.run/                              # Runtime directory (gitignored)
+-- workspace/                     # Root container mounts this at /app/workspace
    +-- openhive.db                # SQLite database (root only)
    +-- .claude/                   # Root agent config
    |   +-- agents/
    |   +-- skills/
    |   +-- settings.json
    |   +-- CLAUDE.md
    +-- teams/
        +-- weather-team/          # Team-A workspace -> container /app/workspace
        |   +-- team.yaml
        |   +-- .claude/
        |   +-- memory/
        |   +-- work/
        |   +-- teams/             # Sub-teams nest here
        |       +-- forecast-team/
        +-- code-review-team/      # Team-B workspace
```

Every container mounts its workspace at `/app/workspace` (fixed internal path). Parent containers see all descendant workspaces. Deletion cascades via filesystem removal.

---

## WebSocket Protocol Summary

Hub-and-spoke topology. One persistent bidirectional JSON channel per container. Wire format uses snake_case; codebase uses camelCase with conversion at boundary.

**Root-to-Container (7 types):** `container_init`, `task_dispatch`, `shutdown`, `tool_result`, `agent_added`, `escalation_response`, `task_cancel`

**Container-to-Root (9 types):** `ready`, `heartbeat`, `task_result`, `escalation`, `log_event`, `tool_call`, `status_update`, `agent_ready`, `org_chart_update`

**Authentication:** One-time tokens (32 bytes hex, 5-min TTL, single-use). Token is the only secret passed as env var; all other secrets delivered over established WebSocket via `container_init`.

**Reconnection:** Exponential backoff (1s base, 2x multiplier, 30s max, +/-20% jitter). On root restart: tokens invalidated, containers reconnect with fresh tokens, state re-synced.

**Connection limits:** 256-message write queue, 100 msgs/sec rate limit, 1 MB max message size, ping/pong every 30s.

See wiki: WebSocket-Protocol.md

---

## MCP Tools (~22 built-in)

| Category | Tools | Count |
|----------|-------|-------|
| Container | `spawn_container`, `stop_container`, `list_containers` | 3 |
| Team | `create_team`, `create_agent` | 2 |
| Task | `create_task`, `dispatch_subtask`, `update_task_status` | 3 |
| Messaging | `send_message` | 1 |
| Orchestration | `escalate` | 1 |
| Memory | `save_memory`, `recall_memory` | 2 |
| Integration | `create_integration`, `test_integration`, `activate_integration` | 3 |
| Secrets | `get_credential`, `set_credential` | 2 |
| Query | `get_team`, `get_task`, `get_health`, `inspect_topology` | 4 |
| Events | `register_webhook` | 1 |

**Timeout tiers:** Query (10s) / Mutating (60s) / Blocking (5 min).

**Role access:** Main Assistant has full access. Team Leads have team-scoped access (no container tools). Members have minimal access (update status, send message, escalate, memory, read credentials, query own tasks).

**Tool call flow:** Agent SDK -> in-process MCP server -> MCPBridge -> WebSocket -> Root Hub -> SDKToolHandler -> validate + execute -> response back via same path. Every call authorized against org chart at root.

See wiki: MCP-Tools.md

---

## Database Schema Summary

SQLite in WAL mode via Drizzle ORM. Root container only (INV-04).

| Table | Purpose |
|-------|---------|
| `tasks` | Task DAG with `blocked_by` JSON array, status state machine |
| `messages` | Chat messages from messaging channels |
| `chat_sessions` | Active chat sessions per channel |
| `log_entries` | Unified log table (all events) |
| `task_events` | Task lifecycle transitions (FK to log_entries) |
| `tool_calls` | Tool invocation records (FK to log_entries) |
| `decisions` | LLM decision audit trail (FK to log_entries) |
| `agent_memories` | Searchable memory index (per-agent) |
| `integrations` | Integration configs and lifecycle status |
| `credentials` | AES-256-GCM encrypted credentials (per-team) |

**Task states:** `pending` -> `active` -> `completed` | `failed` | `escalated` | `cancelled`

**Tiered log retention:** audit=permanent, error=90d, warn=30d, info=30d, debug=7d, trace=3d

See wiki: Database-Schema.md

---

## 12-Layer TDD Roadmap

Each layer builds on prior layers. Phase gate tests prove end-to-end integration at each boundary.

| Layer | Name | What It Covers |
|-------|------|---------------|
| L0 | Stub scaffold | TypeScript compiles, vitest runs, all stubs present |
| L1 | Config + logging | ConfigLoader, Zod validation, Pino logger, DB logger sink |
| L2 | Storage | Drizzle schema, all store implementations, async write queue |
| L3 | Domain core | Domain types, OrgChart, EventBus, error hierarchy |
| L4 | WebSocket | Protocol, Connection, Hub, TokenManager, direction enforcement |
| L5 | Containers | ContainerRuntime (dockerode), Manager, Provisioner, health monitor |
| L6 | MCP tools | All ~22 tool handlers, MCPBridge, SDKToolHandler, tool registry |
| L7 | Executor | Agent executor, session management, PreToolUse/PostToolUse hooks |
| L8 | Orchestrator | Unified orchestrator, two-tier router, task dispatch chain |
| L9 | Channels | Discord adapter, message router, channel lifecycle |
| L10 | API + portal | Fastify REST API, web portal WebSocket relay, React SPA |
| L11 | Integration | End-to-end: Docker compose, health check, SPA loads, full flow |

**Phase gate tests** live in `backend/src/phase-gates/layer-{N}.test.ts`. Each gate proves the layer works end-to-end with all prior layers using real implementations where possible and mocking only external dependencies (Docker, Claude SDK, Discord).

---

## Build Commands

```bash
bun install                    # Install all dependencies (workspace root)
bun run build                  # Compile TypeScript + build React SPA
bun run test                   # Run all tests (backend + web)
bun run lint                   # Run ESLint across all packages
bun run smoke                  # Run phase gate integration tests
bun run docker                 # Build image + start via docker compose
```

**Docker build:** Multi-stage. Builder stage (`node:22-bookworm-slim`) installs Bun, compiles TypeScript, builds SPA. Final stage has compiled JS + production deps + common/ folder. No TypeScript source in production image.

---

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `OPENHIVE_IS_ROOT` | Yes (root) | Set to `true` for the root container |
| `OPENHIVE_MASTER_KEY` | Yes | AES-256-GCM master key (min 32 chars) |
| `DISCORD_BOT_TOKEN` | If Discord enabled | Discord bot token |
| `OPENHIVE_LOG_LEVEL` | No | Override log level (default: info) |
| `OPENHIVE_DATA_DIR` | No | Override data directory path |
| `OPENHIVE_RUN_DIR` | No | Override runtime directory path |
| `OPENHIVE_SYSTEM_LISTEN_ADDRESS` | No | Override API listen address (default: 127.0.0.1:8080) |

---

## Key Design Patterns

- **Two-tier routing** -- config-defined slug mappings (fast, deterministic) + LLM judgment routing (novel/ambiguous requests)
- **Agent-as-Feature** -- capabilities are compositions of Teams + Agents + Skills + Triggers, not coded services
- **Hub-and-spoke WebSocket** -- single persistent connection per container, all through root
- **Team creation two-step** -- `create_agent` first (lead in parent), then `create_team` (blocking, provisions container)
- **Escalation chain** -- bottom-up through hierarchy, each hop logged, max 10 hops before direct-to-user
- **Proactive behavior** -- orchestrator-driven timers, skip-if-busy, idempotent check IDs
- **Self-developing integrations** -- agents create, test, and activate their own declarative integration configs

---

## Wiki Reference

Full design documentation lives in the wiki at `/app/openhive.wiki/`:

| File | Content |
|------|---------|
| Architecture.md | Three-layer architecture, dispatch chain, escalation, task state machine, source layout |
| Vision.md | Core philosophy, three definitions, Agent-as-Feature, key principles |
| Design-Rules.md | Invariants (INV-01 to INV-10), constraints (CON-01 to CON-12), conventions |
| Technology-Stack.md | All runtime/dev/infra dependencies with versions |
| WebSocket-Protocol.md | 16 message types, wire format, auth, reconnection, tool call flow |
| Database-Schema.md | All tables, indexes, store interfaces, task dependency system |
| MCP-Tools.md | 22 tools across 10 categories, role-based access, timeout tiers |
| Configuration-Schemas.md | openhive.yaml, providers.yaml, team.yaml schemas |
| Testing-Standards.md | Coverage requirements, test patterns, phase gate tests |
| Control-Plane.md | Root internals, container infrastructure, workspace layout, logging |
| Skill-Standards.md | SKILL.md format, memory conventions, PROACTIVE.md |
| Architecture-Decisions.md | ADR log with context and rationale |
| Agent-as-Feature.md | Features as team+agent+skill compositions |
| Self-Developing-Integrations.md | Staged integration lifecycle |
| Extensibility.md | Runtime extension surfaces |
| Self-Evolution.md | Self-evolution patterns |
