# OpenHive

Personal AI agent orchestration platform. Talk to an assistant via Discord or WhatsApp — it creates hierarchical teams of AI agents that collaborate on tasks in isolated Docker containers.

## What Is OpenHive

OpenHive lets you interact with a main assistant through any messaging channel. When you give it complex work, it dynamically creates teams of AI agents organized in a hierarchy. Each team runs in its own Docker container with multiple Claude Agent SDK instances, managed by a Go backend.

The assistant decomposes tasks, delegates to teams, and consolidates results — all through natural conversation. Teams can be nested (a team member can lead its own sub-team), enabling multi-level task decomposition for complex projects.

Think of it as a personal AI workforce you manage by chatting.

## Architecture

```
User → Discord / WhatsApp / ...
         ↓
┌─ Master Container ──────────────────────────────┐
│  Go Backend (PID 1)  ↔  Node.js Orchestrator    │
│  (API, channels,        (main assistant          │
│   Docker mgmt, DB)       + team leads)           │
└────────┬────────────────────────────────────────-┘
         ↕ WebSocket (Docker network)
    ┌────┴────┐
    Team A     Team B     ...
    Container  Container
    (agents)   (agents)
```

Go backend manages containers, routes messages, and persists data. Each container runs a Node.js orchestrator managing multiple Claude Agent SDK instances. All communication uses WebSocket.

For the full architecture diagram and data flow, see the [Architecture](https://github.com/Z-M-Huang/openhive/wiki/Architecture) wiki page.

## Key Concepts

| Concept | Description |
|---------|-------------|
| **User** | Person using the app — interacts via messaging channels |
| **Agent** | Claude Agent SDK instance with a role, skills, and provider config |
| **Team** | Group of agents in a Docker container with a designated lead |
| **Task** | Unit of work dispatched to a team, tracked as a DAG |
| **Provider** | AI model configuration (Anthropic direct or OAuth) |
| **Skill** | Set of tools and capabilities assigned to agents |

Everything reduces to three definitions: User, Agent, Team. See [Vision and Core Concepts](https://github.com/Z-M-Huang/openhive/wiki/Vision-and-Core-Concepts).

## Features

- **Conversational team creation** — tell the assistant what you need, it builds the team
- **Hierarchical teams** — unlimited nesting, team leads decompose work to members
- **Container isolation** — each team in its own Docker container
- **Multi-agent collaboration** — multiple SDK instances per container
- **Any messaging channel** — Discord, WhatsApp, extensible via interface
- **Global provider presets** — configure AI providers once, reference everywhere
- **Model tier system** — haiku/sonnet/opus tiers mapped to actual models
- **MCP server support** — 3rd-party MCP servers (GitHub, databases) per team
- **Nested workspaces** — parent teams see child team files
- **Verbose logging** — every action logged with full parameters to database
- **Web portal** — monitoring, configuration, log viewer (no AI in frontend)
- **Task DAG** — hierarchical task decomposition with status tracking

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Go 1.22+ |
| Agent Runtime | Node.js 22 / TypeScript |
| Package Manager | bun |
| Web Portal | React 18+ / Vite / shadcn/ui |
| Database | SQLite (WAL mode) via GORM |
| Containers | Docker (sibling containers) |
| Communication | WebSocket (gorilla/websocket + ws) |

Full dependency list: [Technology Stack](https://github.com/Z-M-Huang/openhive/wiki/Technology-Stack)

## Quick Start

```bash
# 1. Clone and configure
git clone https://github.com/Z-M-Huang/openhive.git
cd openhive
cp data/providers.yaml.example data/providers.yaml
# Edit data/providers.yaml with your provider credentials

# 2. Build and run
docker compose up -d

# 3. Connect via Discord or WhatsApp and say hello
```

## Configuration

Three main config files:

- **`data/openhive.yaml`** — system settings, assistant config, channel tokens
- **`data/providers.yaml`** — global AI provider presets (default: Claude Code OAuth)
- **`data/teams/<slug>/team.yaml`** — per-team agents, skills, MCP servers

Agent definitions use separate files (`.role.md` and `.prompt.md`) for role definitions and system prompts that can span thousands of lines.

Full schemas and examples: [Configuration Schemas](https://github.com/Z-M-Huang/openhive/wiki/Configuration-Schemas)

## Development

### Prerequisites

- Go 1.22+
- Node.js 22+
- bun
- Docker

### Commands

```bash
bun run build          # Build everything
bun run test           # Run all tests
bun run lint           # Lint all code
bun run dev            # Development mode
bun run docker:build   # Build Docker images
bun run generate       # Generate mocks
```

## Documentation

All design documentation lives in the [GitHub Wiki](https://github.com/Z-M-Huang/openhive/wiki):

| Document | Description |
|----------|-------------|
| [Vision and Core Concepts](https://github.com/Z-M-Huang/openhive/wiki/Vision-and-Core-Concepts) | Three core definitions, hierarchy, task DAG |
| [Architecture](https://github.com/Z-M-Huang/openhive/wiki/Architecture) | Master container, two-layer orchestration |
| [Configuration Schemas](https://github.com/Z-M-Huang/openhive/wiki/Configuration-Schemas) | All config file formats |
| [WebSocket Protocol](https://github.com/Z-M-Huang/openhive/wiki/WebSocket-Protocol) | Wire protocol, message types |
| [Technology Stack](https://github.com/Z-M-Huang/openhive/wiki/Technology-Stack) | Dependencies and build artifacts |
| [Core Interfaces](https://github.com/Z-M-Huang/openhive/wiki/Core-Interfaces) | Go service interfaces |
| [Testing Standards](https://github.com/Z-M-Huang/openhive/wiki/Testing-Standards) | 95% coverage, interface-first, phase gates |
| [Architecture Decisions](https://github.com/Z-M-Huang/openhive/wiki/Architecture-Decisions) | 50 documented decisions |
| [Future Features](https://github.com/Z-M-Huang/openhive/wiki/Future-Features) | Browser service, triggers, policies |

## License

[GPL v3](LICENSE)
