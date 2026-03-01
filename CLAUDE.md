# OpenHive

Personal AI agent orchestration platform. Users interact with a main assistant via any messaging channel (Discord, WhatsApp, etc.). The assistant dynamically creates hierarchical teams of AI agents that collaborate on tasks. Each team runs in an isolated Docker container with multiple Claude Agent SDK instances. Go backend orchestrates everything.

## Architecture

```
User → Messaging Channel (Discord/WhatsApp/...)
         ↓
┌─ MASTER CONTAINER ──────────────────────────────┐
│  Go Backend (PID 1) ←── WebSocket ──→ Node.js   │
│  (orchestrator, API,     (localhost)  Orchestrator│
│   channels, DB)                      (main asst  │
│         ↕                             + leads)   │
│    Docker API (socket)                           │
└─────────┬────────────────────────────────────────┘
          ↕ WebSocket (openhive-network)
  ┌───────┴───────┐
  Team A Container  Team B Container  ...
  (Node.js orch    (Node.js orch
   + agent SDKs)    + agent SDKs)
```

Go backend is PID 1 in the master container, spawns Node.js orchestrator as a child process. Team containers connect to Go via WebSocket over Docker network. All inter-container communication goes through Go — no direct container-to-container.

Full architecture: [Wiki — Architecture](https://github.com/Z-M-Huang/openhive/wiki/Architecture)

## Three Core Definitions

| Concept | What It Is | Identifier |
|---------|-----------|------------|
| **User** | Person using the app, "team lead" of root level | N/A |
| **Agent** | Claude Agent SDK instance (standalone process) | AID (`aid-xxx-xxx`) |
| **Team** | Group of agents with a designated lead, runs in Docker container | TID (`tid-xxx-xxx`) |

Every AI entity is an agent — main assistant, team leads, team members. Team lead always runs in the parent container (fixed placement). Team scope = lead agent's role definition.

Full details: [Wiki — Vision and Core Concepts](https://github.com/Z-M-Huang/openhive/wiki/Vision-and-Core-Concepts)

## Project Structure

```
openhive/
├── cmd/openhive/main.go              # Go entry point
├── internal/
│   ├── api/                          # REST API handlers
│   ├── channel/                      # Discord, WhatsApp adapters
│   ├── config/                       # YAML config management
│   ├── container/                    # Docker container lifecycle
│   ├── crypto/                       # AES-256-GCM key encryption
│   ├── domain/                       # Domain types, errors, enums
│   ├── event/                        # Event bus (pub/sub)
│   ├── logging/                      # DB-backed structured logging
│   ├── orchestrator/                 # Task dispatch, Go orchestrator
│   ├── store/                        # GORM database layer
│   └── ws/                           # WebSocket hub (Go side)
├── agent-runner/                     # Node.js code inside containers
│   ├── src/
│   │   ├── index.ts                  # Entry point
│   │   ├── orchestrator.ts           # Container orchestrator
│   │   ├── agent-executor.ts         # SDK wrapper (one per agent)
│   │   ├── ws-client.ts              # WebSocket client
│   │   ├── sdk-tools.ts              # SDK custom tool handlers
│   │   └── types.ts                  # Shared types
│   ├── package.json
│   └── tsconfig.json
├── web/                              # React SPA (monitoring + config)
├── deployments/
│   ├── Dockerfile                    # Master image (team + Go binary)
│   ├── Dockerfile.team               # Team base image
│   └── docker-compose.yml
├── data/
│   ├── openhive.yaml                 # Master config
│   ├── providers.yaml                # Global AI provider presets
│   ├── teams/                        # Per-team configs
│   │   └── <team-slug>/
│   │       ├── team.yaml
│   │       ├── agents/               # .role.md + .prompt.md files
│   │       └── skills/               # Skill YAML files
│   └── workspaces/                   # Nested workspace tree
├── Makefile
├── go.mod
└── README.md
```

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Backend | Go 1.22+ | Orchestration, Docker SDK, API, channels |
| Agent Runtime | Node.js 22 (TypeScript strict) | Container orchestrator + Agent SDK |
| Package Manager | bun | Node.js dependency management |
| Web Portal | React 18+ / Vite / shadcn/ui | Monitoring + configuration (no AI) |
| Database | GORM + SQLite (WAL) | Runtime data (tasks, messages, logs) |
| Containers | Docker (sibling, not DinD) | Team isolation |
| WebSocket | gorilla/websocket (Go), ws (Node.js) | All backend ↔ container communication |

Full stack: [Wiki — Technology Stack](https://github.com/Z-M-Huang/openhive/wiki/Technology-Stack)

## Key Conventions

### Go
- All packages under `internal/` — nothing exported
- chi router for HTTP, GORM for persistence, slog for stdout logging
- Interfaces for all services → mockery for test mocks
- 100% test coverage with in-memory SQLite
- `testify` for assertions

### Node.js (agent-runner)
- TypeScript strict mode
- bun for package management and scripts
- vitest for testing
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- One SDK instance per agent (standalone process)

### React (web portal)
- shadcn/ui (Radix primitives)
- TanStack Query for data fetching
- React Router for navigation
- vitest + React Testing Library

## Critical Patterns

These are architecture decisions that MUST be followed. Not suggestions — requirements.

1. **WebSocket, NOT IPC/stdin** — All Go ↔ container communication uses WebSocket. No stdin/stdout markers, no file-based IPC, no polling. [Wiki — WebSocket Protocol](https://github.com/Z-M-Huang/openhive/wiki/WebSocket-Protocol)

2. **SDK Custom Tools via MCP Bridge** — Internal management tools (create_team, dispatch_task, get_config, update_config, etc.) are exposed to the Claude Agent SDK as an MCP server process. The MCP bridge runs in each container, receives tool calls from the SDK, forwards them via WebSocket to the Go backend's SDKToolHandler, and returns results. External MCP servers (GitHub, databases) are configured separately per-team.

3. **Team Lead in Parent Container** — Team lead ALWAYS runs in the parent container. Never in the child team's container. Child team's `leader_aid` references an AID from the parent team's config.

4. **Two-Step Team Creation** — `create_agent` first (creates lead in parent team, returns AID), then `create_team` (creates team referencing that AID). Agent identity established before team structure.

5. **Global Provider Presets** — AI providers are global in `data/providers.yaml`, NOT per-team. Default = Claude Code OAuth subscription. Agents reference presets by name. Go resolves presets → flattened credentials per agent in `container_init`.

6. **Nested Workspaces** — Workspace tree mirrors team hierarchy. Parent containers see child team workspaces. Cross-team file transfer = Go copies files (logged). Task-scoped folders: `work/tasks/<task-id>/`.

7. **Team Naming** — Slug (directory name) is canonical. Display name auto-derived (hyphens → spaces, title case). No `name` field in team.yaml. Wire protocol uses TID.

8. **OAuth Runtime Mapping** — `type: "oauth"` → sets `CLAUDE_CODE_OAUTH_TOKEN`. `type: "anthropic_direct"` → sets `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL`.

9. **Model Tier System** — Skills specify `haiku`/`sonnet`/`opus`. Providers map tiers to actual model names. Env vars: `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL`.

10. **Verbose by Default** — All WebSocket messages carry full detail. All actions logged to DB with ALL parameters. No brief-only messages in the protocol.

11. **Agent Definition Files** — Role definitions in `.role.md`, system prompts in `.prompt.md` (can be thousands of lines). NOT inline in YAML.

12. **MCP Env Template Syntax** — Config files use `{secrets.GITHUB_TOKEN}` for secret references.

## Configuration Files

| File | Scope | Purpose |
|------|-------|---------|
| `data/openhive.yaml` | Global | System settings, assistant, channels |
| `data/providers.yaml` | Global | AI provider presets |
| `data/teams/<slug>/team.yaml` | Per-team | Team config (agents, skills, MCP servers) |
| `data/teams/<slug>/agents/*.role.md` | Per-agent | Role definition |
| `data/teams/<slug>/agents/*.prompt.md` | Per-agent | System prompt |
| `data/teams/<slug>/skills/*.yaml` | Per-team | Skill definitions |

Full schemas: [Wiki — Configuration Schemas](https://github.com/Z-M-Huang/openhive/wiki/Configuration-Schemas)

## Docker Images

| Image | Base | Contents |
|-------|------|----------|
| `openhive-team` | `node:22-bookworm-slim` + Python 3 | Compiled JS + production node_modules + pip + uvx |
| `openhive` (master) | extends `openhive-team` | + Go binary (static) with embedded React SPA |

Containers contain **only compiled code** — no TypeScript source, no Go source, no devDependencies. Multi-stage Docker builds enforce this.

## Build & Run

```bash
make build          # Build Go binary + compile TypeScript + build React SPA
make test           # Run all tests (Go + Node.js + React)
make lint           # Run linters (golangci-lint + eslint)
make dev            # Development mode
make docker-build   # Build both Docker images
make generate       # Generate mocks (mockery)
```

## Design Documentation

All detailed design docs live in the [GitHub Wiki](https://github.com/Z-M-Huang/openhive/wiki) (single source of truth):

- [Vision and Core Concepts](https://github.com/Z-M-Huang/openhive/wiki/Vision-and-Core-Concepts) — Three definitions, hierarchy, escalation, task DAG
- [Architecture](https://github.com/Z-M-Huang/openhive/wiki/Architecture) — Master container, two-layer orchestration, data flow
- [Configuration Schemas](https://github.com/Z-M-Huang/openhive/wiki/Configuration-Schemas) — openhive.yaml, providers.yaml, team.yaml, agent files
- [WebSocket Protocol](https://github.com/Z-M-Huang/openhive/wiki/WebSocket-Protocol) — Wire protocol, message types, SDK custom tools
- [Technology Stack](https://github.com/Z-M-Huang/openhive/wiki/Technology-Stack) — Go, Node.js, React, Docker, dependencies
- [Core Interfaces](https://github.com/Z-M-Huang/openhive/wiki/Core-Interfaces) — Go interfaces for all components
- [Logging](https://github.com/Z-M-Huang/openhive/wiki/Logging) — DB-backed verbose logging, auto-archive
- [Reference Patterns](https://github.com/Z-M-Huang/openhive/wiki/Reference-Patterns) — NanoClaw/dev-buddy patterns adapted
- [Testing Standards](https://github.com/Z-M-Huang/openhive/wiki/Testing-Standards) — 95% coverage, interface-first, phase gate tests
- [Architecture Decisions](https://github.com/Z-M-Huang/openhive/wiki/Architecture-Decisions) — 50 documented decisions with context
- [Future Features](https://github.com/Z-M-Huang/openhive/wiki/Future-Features) — Browser service, triggers, policies, etc.
