# OpenHive

Personal AI agent orchestration platform. Users interact with a main assistant via any messaging channel (Discord, WhatsApp, etc.). The assistant dynamically creates hierarchical teams of AI agents that collaborate on tasks. Each team runs in an isolated Docker container with multiple Claude Agent SDK instances. A unified orchestrator runs identically in every container. The root container (`OPENHIVE_IS_ROOT=true`) additionally runs messaging channels, database, REST API, and web portal.

## Architecture

```
User → Messaging Channel (Discord/WhatsApp/...)
         ↓
┌─ ROOT CONTAINER (OPENHIVE_IS_ROOT=true) ────────┐
│  Unified Orchestrator                            │
│  (agent executors, WS hub, channels, DB, API)    │
│         ↕                                        │
│    Docker API (socket)                           │
└─────────┬────────────────────────────────────────┘
          ↕ WebSocket (openhive-network)
  ┌───────┴───────┐
  Team A Container  Team B Container  ...
  (same image,      (same image,
   orchestrator      orchestrator
   + agent execs)    + agent execs)
```

All containers run the same `openhive` image. The root container's orchestrator manages the WS hub, messaging channels, SQLite database, REST API, and web portal. Non-root containers connect to root via WebSocket. All inter-container communication goes through root — no direct container-to-container.

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
├── backend/                          # TypeScript/Bun unified codebase
│   ├── src/
│   │   ├── index.ts                  # Entry point
│   │   ├── api/                      # REST API handlers (Fastify) [root-only]
│   │   ├── channel/                  # Discord, WhatsApp adapters [root-only]
│   │   ├── config/                   # YAML config management
│   │   ├── container/                # Docker container lifecycle (dockerode) [root-only]
│   │   ├── crypto/                   # AES-256-GCM key encryption
│   │   ├── domain/                   # Domain types, errors, enums
│   │   ├── event/                    # Event bus (pub/sub)
│   │   ├── logging/                  # DB-backed structured logging [root-only]
│   │   ├── orchestrator/             # Unified orchestrator, agent executor, SDK tools
│   │   ├── store/                    # Drizzle ORM + SQLite layer [root-only]
│   │   └── ws/                       # WebSocket hub (root) + client (non-root)
│   ├── package.json
│   ├── tsconfig.json
│   └── vitest.config.ts
├── web/                              # React SPA (monitoring + config)
├── deployments/
│   ├── Dockerfile                    # Single image (OPENHIVE_IS_ROOT=true enables extras)
│   └── docker-compose.yml
├── data/
│   ├── openhive.yaml                 # System config
│   └── providers.yaml                # Global AI provider presets
├── .run/                             # Runtime state (gitignored)
│   └── workspace/                    # Root workspace (→ /app/workspace in root container)
│       ├── CLAUDE.md
│       ├── .claude/
│       │   ├── settings.json         # {"allowedTools":[]} (scaffolded)
│       │   ├── agents/               # Agent definition files
│       │   │   └── <name>.md         # YAML frontmatter + free-form content
│       │   └── skills/               # Skill definition files
│       │       └── <name>/
│       │           └── SKILL.md
│       ├── work/
│       │   └── tasks/
│       └── teams/                    # Child team workspaces (recursive)
│           └── <team-slug>/
│               ├── team.yaml
│               └── ...               # Same structure recursively
├── package.json
└── README.md
```

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Backend + Agent Runtime | TypeScript/Bun (Node.js 22, strict) | Orchestration, agent execution, Docker API, REST API, channels, DB |
| Package Manager | bun | Dependency management (backend, web) |
| Web Portal | React 18+ / Vite / shadcn/ui | Monitoring + configuration (no AI) |
| Database | Drizzle ORM + SQLite (WAL) | Runtime data (tasks, messages, logs) |
| Containers | Docker (sibling, not DinD) | Team isolation |
| WebSocket | ws (Node.js) | All root ↔ container communication |

Full stack: [Wiki — Technology Stack](https://github.com/Z-M-Huang/openhive/wiki/Technology-Stack)

## Key Conventions

### TypeScript (unified codebase)
- TypeScript strict mode — no `any` or `unknown` types. All values must be strongly typed with explicit interfaces. Use type guards and discriminated unions instead of type assertions.
- bun for package management and scripts
- vitest for testing (run with `npx vitest run` or `bun run test`)
- Interfaces for all services; manual test doubles (no mockery)
- Fastify for HTTP (root container), ws for WebSocket
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) — one SDK instance per agent (standalone process)
- Built-in tools exposed via in-process MCP server, forwarded over WebSocket to root

### Workspace Directories
- Runtime state lives under `.run/` (gitignored, not `data/`)
- Recursive nesting: `.run/workspace/teams/<slug>/teams/<child>/`
- Agent definitions: `.run/workspace/teams/<slug>/.claude/agents/<name>.md`
- Skill definitions: `.run/workspace/teams/<slug>/.claude/skills/<name>/SKILL.md`
- Task work dirs: `.run/workspace/teams/<slug>/work/tasks/<task-id>/`
- Workspaces are scaffolded on team creation; never pre-created at startup (except main assistant)

### React (web portal)
- shadcn/ui (Radix primitives)
- TanStack Query for data fetching
- React Router for navigation
- vitest + React Testing Library

## Critical Patterns

These are architecture decisions that MUST be followed. Not suggestions — requirements.

1. **Hub-and-Spoke WebSocket** — All root ↔ container communication uses WebSocket (single connection per container). Root routes all messages based on the org chart. No stdin/stdout markers, no file-based IPC, no polling. [Wiki — WebSocket Protocol](https://github.com/Z-M-Huang/openhive/wiki/WebSocket-Protocol)

2. **Built-in Tools via In-Process MCP Server** — 24 internal management tools (create_team, dispatch_task, get_config, update_config, etc.) are exposed to the Claude Agent SDK as an in-process MCP server (`openhive-tools`). The MCPBridge forwards tool calls over WebSocket to root's SDKToolHandler and returns results. Each tool also has a SKILL.md file in `main-assistant/.claude/skills/` for agent-facing documentation. External MCP servers (GitHub, databases) are configured separately per-team.

3. **Team Lead in Parent Container** — Team lead ALWAYS runs in the parent container. Never in the child team's container. Child team's `leader_aid` references an AID from the parent team's config.

4. **Two-Step Team Creation** — `create_agent` first (creates lead in parent team, returns AID), then `create_team` (creates team referencing that AID). Agent identity established before team structure.

5. **Global Provider Presets** — AI providers are global in `data/providers.yaml`, NOT per-team. Default = Claude Code OAuth subscription. Agents reference presets by name. Root resolves presets → flattened credentials per agent in `container_init`.

6. **Recursive Nested Workspaces** — Workspace tree lives under `.run/workspace/`, mirrors team hierarchy recursively (`.run/workspace/teams/<slug>/teams/<child>/`). Parent containers see child team workspaces. Cross-team file transfer = root copies files (logged). Task-scoped folders: `.run/workspace/teams/<slug>/work/tasks/<task-id>/`.

7. **Team Identity is Slug** — Slug (directory name) is the canonical identity. Display name auto-derived (hyphens → spaces, title case). No `name` field in team.yaml. Wire protocol uses TID; all workspace lookups use slug. Reserved slug `main` is blocked in all create-team code paths.

8. **OAuth Runtime Mapping** — `type: "oauth"` → sets `CLAUDE_CODE_OAUTH_TOKEN`. `type: "anthropic_direct"` → sets `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL`.

9. **Model Tier System** — Skills specify `haiku`/`sonnet`/`opus`. Providers map tiers to actual model names. Env vars: `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL`.

10. **Verbose by Default** — All WebSocket messages carry full detail. All actions logged to DB with ALL parameters. No brief-only messages in the protocol.

11. **Agent Definition Files** — Each agent is defined by a single `.claude/agents/<name>.md` file in the team workspace (`<name>` = slug). The file has YAML frontmatter (`name`, `description`, optional `model`, `tools`) followed by optional free-form content. Written to the team's recursive workspace path (e.g., `.run/workspace/teams/<slug>/.claude/agents/<name>.md`). NOT inline in YAML, NOT in `data/teams/`.

12. **Skill Definition Files** — Each skill lives in `.claude/skills/<name>/SKILL.md` within the team workspace. YAML frontmatter (`name`, `description`, optional `argumentHint`, `allowedTools`, `model`) followed by the skill body. Written to the team's recursive workspace path (e.g., `.run/workspace/teams/<slug>/.claude/skills/<name>/SKILL.md`). Hard cutover — no config-dir fallback.

13. **MCP Env Template Syntax** — Config files use `{secrets.GITHUB_TOKEN}` for secret references.

## Configuration Files

| File | Scope | Purpose |
|------|-------|---------|
| `data/openhive.yaml` | Global | System settings, assistant, channels |
| `data/providers.yaml` | Global | AI provider presets |
| `.run/workspace/teams/<slug>/team.yaml` | Per-team | Team config (agents, MCP servers) |
| `.run/workspace/teams/<slug>/.claude/agents/<name>.md` | Per-agent | Agent definition (YAML frontmatter + content) |
| `.run/workspace/teams/<slug>/.claude/skills/<name>/SKILL.md` | Per-skill | Skill definition (YAML frontmatter + body) |
| `.run/workspace/teams/<slug>/.claude/settings.json` | Per-team | Allowed tools (scaffolded on team creation) |

Full schemas: [Wiki — Configuration Schemas](https://github.com/Z-M-Huang/openhive/wiki/Configuration-Schemas)

## Docker Image

| Image | Base | Contents |
|-------|------|----------|
| `openhive` | `node:22-bookworm-slim` + Python 3 | Compiled JS + production deps. `OPENHIVE_IS_ROOT=true` enables channels, DB, API, web portal |

Containers contain **only compiled code** — no TypeScript source, no devDependencies. Multi-stage Docker builds enforce this.

## Build & Run

```bash
bun run build          # Compile TypeScript (backend) + build React SPA
bun run test           # Run all tests (backend + web)
bun run lint           # Run linters (eslint across all packages)
bun run docker         # Build image + start via docker compose

# Per-package test (from within backend/):
npx vitest run         # Run vitest tests for that package
bun run test:coverage  # Run tests with coverage report
```

## Design Documentation

All detailed design docs live in the [GitHub Wiki](https://github.com/Z-M-Huang/openhive/wiki) (single source of truth):

- [Vision and Core Concepts](https://github.com/Z-M-Huang/openhive/wiki/Vision-and-Core-Concepts) — Three definitions, hierarchy, escalation, task DAG
- [Architecture](https://github.com/Z-M-Huang/openhive/wiki/Architecture) — Root container, unified orchestration, data flow
- [Configuration Schemas](https://github.com/Z-M-Huang/openhive/wiki/Configuration-Schemas) — openhive.yaml, providers.yaml, team.yaml, agent files
- [WebSocket Protocol](https://github.com/Z-M-Huang/openhive/wiki/WebSocket-Protocol) — Wire protocol, message types, built-in tools, MCP servers
- [Technology Stack](https://github.com/Z-M-Huang/openhive/wiki/Technology-Stack) — TypeScript/Bun, Node.js, React, Docker, dependencies
- [Core Interfaces](https://github.com/Z-M-Huang/openhive/wiki/Core-Interfaces) — Service interfaces for all components
- [Logging](https://github.com/Z-M-Huang/openhive/wiki/Logging) — DB-backed verbose logging, auto-archive
- [Reference Patterns](https://github.com/Z-M-Huang/openhive/wiki/Reference-Patterns) — NanoClaw/dev-buddy patterns adapted
- [Testing Standards](https://github.com/Z-M-Huang/openhive/wiki/Testing-Standards) — 95% coverage, interface-first, phase gate tests
- [Architecture Decisions](https://github.com/Z-M-Huang/openhive/wiki/Architecture-Decisions) — 64 documented decisions with context
- [Future Features](https://github.com/Z-M-Huang/openhive/wiki/Future-Features) — Browser service, triggers, policies, etc.
