# OpenHive

AI agent orchestration platform. User talks to an assistant via messaging channels. The assistant creates hierarchical teams of agents in Docker containers. Each container runs multiple Claude Agent SDK instances managed by a unified orchestrator. Single TypeScript/Bun codebase runs in all containers.

## Architecture

```
                           +-------------------+
                           |      User         |
                           +--------+----------+
                                    |
                              Discord / Slack
                                    |
                           +--------v----------+
                           |  Root Container   |
                           |  (OPENHIVE_IS_ROOT)|
                           |                   |
                           |  +- Channels      |
                           |  +- REST API      |
                           |  +- Web Portal    |
                           |  +- WS Hub        |
                           |  +- SQLite DB     |
                           |  +- Docker Socket |
                           |  +- Orchestrator  |
                           |  +- Main Assistant|
                           +--+-----+-----+----+
                              |     |     |
                      WS      |     |     |      WS
              +-------+       |     |     |       +-------+
              |               |     |     |               |
     +--------v------+  +----v-----v-+ +------v--------+
     | Team Container |  | Team Container | | Team Container |
     |                |  |                | |                |
     | +- Team Lead  |  | +- Team Lead   | | +- Team Lead   |
     | +- Agent A    |  | +- Agent X     | | +- Agent P     |
     | +- Agent B    |  | +- Agent Y     | | +- Agent Q     |
     | +- Orchestrator| | +- Orchestrator | | +- Orchestrator |
     +--------+-------+ +----------------+ +-------+--------+
              |                                     |
              | WS                                  | WS
     +--------v-------+                    +--------v-------+
     | Nested Team     |                    | Nested Team     |
     | Container       |                    | Container       |
     +----------------+                    +----------------+
```

**Key properties:**

- **Unified codebase** -- same TypeScript/Bun image in every container; `OPENHIVE_IS_ROOT=true` enables root-only services (channels, DB, REST API, web portal, WS hub, Docker socket)
- **Hub-and-spoke WebSocket** -- one persistent bidirectional JSON channel per container, authenticated by one-time token on HTTP upgrade
- **Hierarchical teams** -- recursively nestable; team lead always runs in the parent container
- **Single Docker image** -- `openhive:latest` for all containers (root and child)
- **Model tier system** -- skills specify haiku/sonnet/opus; providers map to actual models

## Quickstart

### Prerequisites

- [Bun](https://bun.sh/) >= 1.0
- [Node.js](https://nodejs.org/) >= 22 LTS
- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- A Discord bot token (if using the Discord channel)

### Clone

```bash
git clone https://github.com/your-org/openhive.git
cd openhive
```

### Configure

```bash
# Copy example configuration files
cp data/openhive.yaml.example data/openhive.yaml
cp data/providers.yaml.example data/providers.yaml
cp .env.example .env

# Edit .env with your secrets
#   OPENHIVE_MASTER_KEY  -- AES-256-GCM encryption key (min 32 chars)
#   DISCORD_BOT_TOKEN    -- your Discord bot token
```

### Run

```bash
# Build and start with Docker Compose
bun run docker

# Or run locally for development (see Dev Setup below)
```

## Dev Setup

```bash
# Install all workspace dependencies
bun install

# Build backend and web portal
bun run build

# Run the full test suite
bun run test

# Run phase-gate smoke tests only
bun run smoke

# Lint all workspaces
bun run lint
```

The project uses a monorepo with two workspaces:

| Workspace | Path       | Description                        |
|-----------|------------|------------------------------------|
| backend   | `backend/` | Orchestrator, API, channels, WS hub |
| web       | `web/`     | React SPA portal (shadcn/ui)        |

## Configuration

### Config files

| File                            | Purpose                              | Git-tracked |
|---------------------------------|--------------------------------------|-------------|
| `data/openhive.yaml`           | Main orchestrator configuration      | No (copy from `.example`) |
| `data/providers.yaml`          | AI provider presets and credentials  | No (copy from `.example`) |
| `.env`                         | Environment variables and secrets    | No (copy from `.example`) |
| `data/openhive.yaml.example`  | Example main config                  | Yes         |
| `data/providers.yaml.example` | Example provider config              | Yes         |
| `.env.example`                 | Example environment variables        | Yes         |

### Environment variables

| Variable                          | Required | Description                                  |
|-----------------------------------|----------|----------------------------------------------|
| `OPENHIVE_IS_ROOT`               | Yes      | Set `true` for the root container            |
| `OPENHIVE_MASTER_KEY`            | Yes      | AES-256-GCM master key (min 32 chars)        |
| `DISCORD_BOT_TOKEN`             | If Discord | Discord bot token                          |
| `OPENHIVE_LOG_LEVEL`            | No       | `trace\|debug\|info\|warn\|error\|fatal`      |
| `OPENHIVE_DATA_DIR`             | No       | Path to data directory (default: `data`)     |
| `OPENHIVE_RUN_DIR`              | No       | Path to runtime directory (default: `.run`)  |
| `OPENHIVE_SYSTEM_LISTEN_ADDRESS` | No       | REST API bind address (default: `127.0.0.1:8080`) |

## Backend Modules

```
backend/src/
  api/             REST API routes and middleware
  channels/        Messaging channel adapters (Discord, Slack stub)
  config/          Configuration loading and validation
  containers/      Docker container lifecycle management
  control-plane/   Team and agent orchestration
  domain/          Core domain types and interfaces
  executor/        SDK process lifecycle (sessions, hooks)
  logging/         Structured logging with DB persistence
  mcp/             MCP tool definitions
  phase-gates/     Phase-gate smoke tests
  security/        Encryption, token management, auth
  skills/          Skill registry and resolution
  storage/         Drizzle ORM + SQLite (WAL mode)
  triggers/        Cron, webhook, and channel event triggers
  websocket/       Hub-and-spoke WebSocket protocol
```

## Common Skills

Six built-in skills ship with every agent container:

| Skill               | Purpose                                    |
|---------------------|--------------------------------------------|
| `escalation`        | Escalate tasks to team lead or user        |
| `health-report`     | Report container and agent health status   |
| `integration-usage` | Track and report integration usage metrics |
| `memory-management` | Manage agent and team memory persistence   |
| `system-smoke`      | System-level smoke tests and diagnostics   |
| `task-completion`   | Mark tasks complete with structured output |

## TDD Implementation Roadmap

The v2 scaffold is designed for incremental test-driven implementation across 12 layers:

| Layer | Name                | Description                                       |
|-------|---------------------|---------------------------------------------------|
| L0    | Domain Types        | Core interfaces, value objects, type guards        |
| L1    | Configuration       | YAML loading, validation, env overlay              |
| L2    | Storage             | Drizzle schema, migrations, async write queue      |
| L3    | Logging             | Structured logger, DB sink, log archival           |
| L4    | Security            | AES-256-GCM encryption, token generation, auth     |
| L5    | Executor            | SDK process spawn, session management, hooks       |
| L6    | Skills              | Skill registry, resolution, common skill loading   |
| L7    | Control Plane       | Team CRUD, agent lifecycle, task DAG               |
| L8    | WebSocket           | Hub server, spoke client, message routing          |
| L9    | Containers          | Docker API, image build, container lifecycle       |
| L10   | Channels & Triggers | Discord adapter, cron/webhook/event triggers       |
| L11   | API & Portal        | REST endpoints, React SPA, integration tests       |

Each layer builds on the previous ones. Tests are written first (red), implementation follows (green), then refactored while tests pass.

## Wiki

Detailed design documentation is maintained in the project wiki:

- [Home](../../wiki/Home) -- wiki index and navigation
- [Vision](../../wiki/Vision) -- project vision and core concepts
- [Architecture](../../wiki/Architecture) -- unified orchestrator, hub-and-spoke WS, nested workspaces, DB schema
- [Architecture Decisions](../../wiki/Architecture-Decisions) -- numbered decisions with context and rationale
- [Configuration Schemas](../../wiki/Configuration-Schemas) -- openhive.yaml, providers.yaml, team.yaml, agent/skill files
- [Database Schema](../../wiki/Database-Schema) -- SQLite tables, indexes, and migrations
- [WebSocket Protocol](../../wiki/WebSocket-Protocol) -- message types, SDK tools, escalation routing
- [Technology Stack](../../wiki/Technology-Stack) -- runtime, frameworks, and tooling choices
- [Testing Standards](../../wiki/Testing-Standards) -- TDD methodology, coverage targets, test patterns
- [Skill Standards](../../wiki/Skill-Standards) -- skill file format, registry, resolution rules
- [Design Rules](../../wiki/Design-Rules) -- constraints and invariants (CON-01 through CON-12)
- [Control Plane](../../wiki/Control-Plane) -- team orchestration and agent lifecycle
- [MCP Tools](../../wiki/MCP-Tools) -- Model Context Protocol tool definitions
- [Plugin System](../../wiki/Plugin-System) -- plugin architecture and extension points
- [Extensibility](../../wiki/Extensibility) -- extension mechanisms and hooks
- [Glossary](../../wiki/Glossary) -- terminology and definitions
- [Agent as Feature](../../wiki/Agent-as-Feature) -- agent-driven feature development
- [Self-Evolution](../../wiki/Self-Evolution) -- self-modifying system capabilities
- [Self-Developing Integrations](../../wiki/Self-Developing-Integrations) -- auto-generated integrations

## Project Structure

```
openhive/
  backend/           Backend workspace (TypeScript/Bun)
    src/             Source modules (see Backend Modules above)
    tsconfig.json    TypeScript configuration
    package.json     Backend dependencies and scripts
  web/               Web portal workspace (React + Vite)
    src/             React SPA source
    package.json     Frontend dependencies and scripts
  common/            Shared assets across all containers
    skills/          Built-in skill definitions
    scripts/         Shared scripts
    templates/       Configuration templates
  data/              Configuration files (gitignored secrets)
  deployments/       Docker and deployment files
    Dockerfile       Multi-stage build for the unified image
    docker-compose.yml  Local development compose file
  package.json       Root workspace configuration
  .env.example       Environment variable template
  LICENSE            GPLv3 license
```

## License

This project is licensed under the GNU General Public License v3.0. See [LICENSE](LICENSE) for details.
