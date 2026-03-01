# OpenHive - GitHub Issues Plan

## Summary

49 issues across 10 phases + 4 investigation tickets. Each issue references the architecture decisions it implements.

All design documents are in the [GitHub Wiki](https://github.com/Z-M-Huang/openhive/wiki).

## Testing Standards

All issues follow the [Testing Standards](https://github.com/Z-M-Huang/openhive/wiki/Testing-Standards) wiki page. Key rules:

- **95% minimum unit test coverage** per package (Go and TypeScript)
- **Interface-first:** every external dependency and cross-package boundary behind an interface, mocked in tests
- **Phase gate test:** each phase ends with an integration test proving the phase works end-to-end
- **No testing debt:** phase is not complete until all tests pass
- **Playwright E2E** for web portal (Phase 6+)

Every issue's "Done When" section includes test requirements.

## Implementation Order

```
Phase 1  (Foundation):          #1 → #2 → #3, #4, #5, #7 (parallel) → #6 → #8 → #9
Phase 2  (Main Assistant):      #10 → #11, #14 (parallel) → #12 → #13, #15 (parallel) → #16
Phase 3  (Channels):            #17, #18 (parallel) → #19
Phase 4  (Team Containers):     #20 → #21 → #22 → #23
Phase 5  (Team Orchestration):  #24, #25 (parallel) → #26 → #27 → #28
Phase 6  (Web Portal):          #29 → #30, #31, #32, #33 (parallel)
Phase 7  (Distribution):        #34 → #35
Phase 8  (Hardening):           #36 → #37 → #38 → #39
Phase 9  (Documentation):       #40, #41 (can start anytime)
Phase 10 (Future Spikes):       #42–#49 (independent, on demand)
```

## Issue Index

### Phase 1: Foundation
| # | Title | Dependencies |
|---|-------|-------------|
| 1 | Project Scaffolding & Build System | None |
| 2 | Core Domain Types & Service Interfaces | #1 |
| 3 | Master Configuration System (openhive.yaml) | #2 |
| 4 | Team Configuration System | #2 |
| 5 | Provider Presets System (providers.yaml) | #2 |
| 6 | Database Layer (GORM/SQLite) | #2, #3 |
| 7 | API Key Encryption (KeyManager) | #2 |
| 8 | REST API Framework & Base Router | #2 |
| 9 | Verbose Structured Logging System | #6, #8 |

### Phase 2: Main Assistant
| # | Title | Dependencies |
|---|-------|-------------|
| 10 | WebSocket Hub (Go Side) | #2, #8 |
| 11 | WebSocket Protocol Messages | #10 |
| 12 | Container Orchestrator (Node.js) | #11 |
| 13 | Agent Executor (SDK Wrapper) | #12 |
| 14 | CLI Channel | #2 |
| 15 | Message Router & Main Assistant Dispatch | #6, #10, #11, #14 |
| 16 | Admin SDK Custom Tools | #3, #12, #13, #15 |

### Phase 3: Communication Channels
| # | Title | Dependencies |
|---|-------|-------------|
| 17 | Discord Channel Integration | #15 |
| 18 | WhatsApp Channel Integration | #15 |
| 19 | Message Store & Session Management | #6, #15 |

### Phase 4: Team Containers
| # | Title | Dependencies |
|---|-------|-------------|
| 20 | Docker Container Runtime | #2, #3 |
| 21 | Container Lifecycle Manager | #9, #20 |
| 22 | Docker Images (Team + Master) | #13, #21 |
| 23 | Heartbeat & Health Monitoring | #10, #11 |

### Phase 5: Team Orchestration
| # | Title | Dependencies |
|---|-------|-------------|
| 24 | Team SDK Custom Tools | #13, #25 |
| 25 | Internal API for Container-Backend Communication | #4, #8, #10 |
| 26 | Task Dispatch & Go Orchestrator | #6, #10, #11, #25 |
| 27 | Skill Loading (URL + YAML) | #4, #25 |
| 28 | Event Bus & Portal WebSocket Streaming | #6, #8 |

### Phase 6: Web Portal
| # | Title | Dependencies |
|---|-------|-------------|
| 29 | React SPA Scaffolding | #8 |
| 30 | Log Viewer UI | #9, #29 |
| 31 | Team Visualization & Management UI | #4, #25, #29 |
| 32 | Task Monitoring UI | #26, #28, #29 |
| 33 | Settings & Configuration UI | #3, #29 |

### Phase 7: Distribution
| # | Title | Dependencies |
|---|-------|-------------|
| 34 | Docker Compose Packaging | All backend issues |
| 35 | npm CLI Package | #34 |

### Phase 8: Production Hardening
| # | Title | Dependencies |
|---|-------|-------------|
| 36 | Error Handling & Recovery | All core issues |
| 37 | Coverage Enforcement | #1 |
| 38 | End-to-End Integration Tests | All issues |
| 39 | Config Export & Import | #3, #4, #8 |

### Phase 9: Documentation
| # | Title | Dependencies |
|---|-------|-------------|
| 40 | CLAUDE.md Project Configuration | Can start early |
| 41 | README.md & User Documentation | Can start early |

### Phase 10: Future Feature Spikes
| # | Title | Status |
|---|-------|--------|
| 42 | Spike: Browser Service (Shared Sidecar + MCP Bridge) | Decided |
| 43 | Spike: Trigger System (Cron + Webhooks + Events) | Decided |
| 44 | Spike: Policy Inheritance (Cascading Metadata + Rules) | Conceptual |
| 45 | Spike: Approval Gates (Human-in-the-Loop) | Conceptual |
| 46 | Spike: Notifications & Alerts | Conceptual |
| 47 | Spike: Team Templates (Blueprints) | Conceptual |
| 48 | Spike: Reporting & Analytics | Conceptual |
| 49 | Spike: Priority Queuing & Rate Limiting | Conceptual |

---

## Phase 1: Foundation

---

### Issue #1: Project Scaffolding & Build System

**Story:** As a developer, I want a well-structured monorepo with a consistent build system.

**Decisions:** 32 (bun), 33 (no CI/CD)

**Acceptance Criteria:**
- Go module: `github.com/Z-M-Huang/openhive`
- Node.js project in `agent-runner/` with bun (Decision 32)
- React project in `web/`
- Makefile: `build`, `test`, `lint`, `dev`, `docker-build`, `generate`, `coverage`
- golangci-lint, eslint, prettier configs
- `.gitignore` for Go, Node, build artifacts
- No CI/CD pipeline (Decision 33)

**Directory Structure:**
```
openhive/
├── cmd/openhive/main.go
├── internal/
│   ├── api/          # REST API handlers
│   ├── channel/      # Channel adapters + message router
│   ├── config/       # Config file management
│   ├── container/    # Docker container management
│   ├── crypto/       # Key encryption
│   ├── domain/       # Domain types & errors
│   ├── event/        # Event bus
│   ├── logging/      # Structured logging & DB logger
│   ├── orchestrator/ # Task & message orchestration
│   ├── store/        # GORM database layer
│   └── ws/           # WebSocket hub
├── agent-runner/src/
│   ├── index.ts, orchestrator.ts, agent-executor.ts
│   ├── ws-client.ts, sdk-tools.ts, types.ts
├── web/              # React SPA
├── deployments/      # Dockerfiles + docker-compose.yml
├── data/             # Runtime data directory
├── Makefile
└── go.mod
```

**Done When:**
- `make build` compiles Go + TypeScript + React without errors
- `make lint` passes all linters
- `make test` runs (even if no tests yet)
- `make coverage` generates coverage reports
- Directory structure matches plan

---

### Issue #2: Core Domain Types & Service Interfaces

**Story:** As a developer, I want well-defined domain types and mockable interfaces so all components can be developed and tested independently.

**Decisions:** 15 (three definitions), 16 (AIDs), 34 (TIDs)

**Acceptance Criteria:**
- Domain types in `internal/domain/`:
  - `Team` (tid, slug, parent, leader_aid, children, agents, container config)
  - `Agent` (aid, name, role_file, prompt_file, provider, model_tier, skills, max_turns, timeout, leads_team)
  - `Provider` (name, type, base_url, api_key/api_key_env, oauth_token_env, models map)
  - `Skill` (name, description, model_tier, tools, system_prompt_addition)
  - `Task`, `TaskResult`, `TaskEvent` (runtime DB models)
  - `Message`, `ChatSession` (messaging DB models)
  - `LogEntry` (structured log DB model)
- Enum types: TaskStatus, EventType, ProviderType, LogLevel, ContainerState, ModelTier, AgentStatusType
- Custom errors: NotFoundError, ValidationError, ConflictError, EncryptionLockedError
- All service interfaces from [Core Interfaces](https://github.com/Z-M-Huang/openhive/wiki/Core-Interfaces):
  - ConfigManager, AgentRegistry, GoOrchestrator, WSHub, ContainerRuntime, ContainerManager
  - HeartbeatMonitor, SDKToolHandler, ChannelAdapter, MessageRouter, EventBus, KeyManager
  - TaskStore, MessageStore, LogStore, SessionStore
- Mock generation: `mockery --all --with-expecter --output ./internal/mocks`

**Done When:**
- All types compile and have validation methods
- All interfaces compile
- `make generate` produces mocks for every interface
- Enum validation tests: ≥95% coverage
- Custom error tests: ≥95% coverage

---

### Issue #3: Master Configuration System (openhive.yaml)

**Story:** As a user, I want a single YAML config file for system settings, assistant definition, top-level agents, and channel tokens.

**Decisions:** 1, 2, 5, 9, 20, 29, 43

**Acceptance Criteria:**
- `openhive.yaml` sections: `system`, `assistant`, `agents`, `channels`
- `assistant`: name, aid, role_file, prompt_file, provider (preset ref), model_tier, max_turns, timeout_minutes
- `agents`: top-level team leads (aid, name, role_file, prompt_file, provider, model_tier, leads_team)
- Config loading: compiled defaults → YAML → env vars (`OPENHIVE_` prefix)
- Validation at startup (schema rules from [Configuration Schemas](https://github.com/Z-M-Huang/openhive/wiki/Configuration-Schemas))
- Hot-reload on file change (fsnotify)
- Agent definition files: `.role.md` and `.prompt.md` (Decision 29)

**Done When:**
- Load valid config → returns parsed struct
- Load with env overrides → env wins
- Load invalid config → returns specific ValidationError
- Hot-reload → callback fires with new config
- Missing file → clear error message
- ≥95% coverage on `internal/config/` (master config portion)

---

### Issue #4: Team Configuration System

**Story:** As a team lead (or assistant), I want each team to have its own config file so the architecture is recursive.

**Decisions:** 8, 21, 25, 29, 30, 34, 35, 37, 43, 48

**Acceptance Criteria:**
- `team.yaml` schema: tid, parent, leader_aid, skills, agents, mcp_servers, children, env_vars, container
- No `name` field — display name auto-derived from slug (Decision 48)
- `leader_aid` references AID from PARENT team's config (Decision 43)
- Agents list contains ONLY members (leader NOT listed)
- Config CRUD via ConfigManager
- Team creation auto-creates: `data/teams/<slug>/` with `team.yaml`, `agents/`, `skills/`, `CLAUDE.md`
- Workspace creation SEPARATE at `data/workspaces/` (Decision 38)
- Validation: unique AIDs globally, unique agent names within team, valid provider refs, valid skill refs, no circular parents, slug must be lowercase hyphen-separated

**Done When:**
- Create team → directory + files created
- Load team config → parsed correctly, display name derived from slug
- Validate invalid config → specific error (duplicate AID, circular parent, bad leader_aid)
- Delete team → directory removed
- List teams → returns all team slugs
- Org chart → correct parent-child tree
- ≥95% coverage on `internal/config/` (team config portion)

---

### Issue #5: Provider Presets System (providers.yaml)

**Story:** As a user, I want global AI provider presets that any agent can reference, with Claude Code OAuth as default.

**Decisions:** 22, 31, 44, 45, 50

**Acceptance Criteria:**
- `data/providers.yaml` with named provider presets
- Default preset: `type: "oauth"`, uses `CLAUDE_CODE_OAUTH_TOKEN`
- Provider types: `anthropic_direct` and `oauth`
- Model tier mapping: `models: { haiku: "...", sonnet: "...", opus: "..." }`
- Runtime resolution: preset name → flattened credentials per agent (Decision 44)
- OAuth mapping: `type: "oauth"` → `CLAUDE_CODE_OAUTH_TOKEN`; `type: "anthropic_direct"` → `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` (Decision 50)
- Startup validation: at least one provider with valid credentials, clear error if not
- ConfigManager methods: LoadProviders, SaveProviders, ValidateProviders, WatchProviders

**Done When:**
- Load valid providers.yaml → parsed, all presets accessible by name
- Resolve provider for agent → flattened credentials with correct env var mapping
- OAuth provider → `CLAUDE_CODE_OAUTH_TOKEN` set
- Direct provider → `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` set
- Model tier resolution → correct `ANTHROPIC_DEFAULT_*_MODEL` vars
- No valid providers → clear startup error message
- ≥95% coverage

---

### Issue #6: Database Layer (GORM/SQLite)

**Story:** As a developer, I want GORM-backed persistence for runtime data.

**Decisions:** 6

**Acceptance Criteria:**
- GORM models: Task, TaskResult, TaskEvent, Message, ChatSession, LogEntry, ContainerSession, AgentSession
- Auto-migration on startup
- SQLite driver with WAL mode
- All Store interfaces implemented (TaskStore, MessageStore, LogStore, SessionStore)
- Transaction support
- Connection cleanup on shutdown

**Done When:**
- Create/Read/Update/Delete works for all models
- Filter queries (by team, status, date range) return correct results
- Transaction: commit succeeds, rollback on error
- Task DAG queries: get subtree, blocked tasks, unblocked tasks
- In-memory SQLite tests (no file I/O)
- ≥95% coverage on `internal/store/`

---

### Issue #7: API Key Encryption (KeyManager)

**Story:** As a user, I want API keys encrypted at rest in config files.

**Acceptance Criteria:**
- AES-256-GCM encryption with Argon2id key derivation
- Encrypted format: `enc:` prefix + base64(nonce || ciphertext || tag)
- Master key from env var `OPENHIVE_MASTER_KEY`
- Support `api_key_env` (env var reference) and `api_key` (inline encrypted)
- Unlock endpoint: `POST /api/v1/auth/unlock`

**Done When:**
- Encrypt → Decrypt round-trip returns original plaintext
- Wrong master key → returns EncryptionLockedError
- Corrupted ciphertext → returns error (not panic)
- `api_key_env` → resolves from env var (no decryption)
- `api_key` with `enc:` prefix → decrypts with master key
- Locked state → all operations return EncryptionLockedError
- ≥95% coverage on `internal/crypto/`

---

### Issue #8: REST API Framework & Base Router

**Story:** As a developer, I want a consistent HTTP API framework.

**Decisions:** 13, 41

**Acceptance Criteria:**
- chi router
- Middleware: request ID, structured logging, CORS, panic recovery, timing
- JSON error format: `{"error": {"code": "...", "message": "..."}}`
- Success format: `{"data": {...}}`
- Health check: `GET /api/v1/health`
- React SPA served at `/` via `//go:embed` (Decision 41)
- Graceful shutdown
- WebSocket upgrade endpoints registered (actual handlers in later issues)

**Done When:**
- `GET /api/v1/health` returns 200 with JSON body
- Invalid route → 404 with JSON error format
- Panic in handler → 500 with JSON error format (not raw stack trace)
- Request ID header present in all responses
- CORS headers correct for configured origins
- Graceful shutdown: in-flight requests complete before exit
- ≥95% coverage on `internal/api/` (middleware + router)

---

### Issue #9: Verbose Structured Logging System

**Story:** As a user, I want all actions logged verbosely with full parameters, with automatic archival.

**Decisions:** 10, 36

**Acceptance Criteria:**
- DB-backed logger writing LogEntry records via GORM
- Log levels: debug, info, warn, error
- Every action logged with ALL parameters as JSON
- Fields: level, component, action, message, params, team_name, task_id, agent_name, request_id, error, duration_ms
- Auto-archive goroutine (5-min check, export oldest to `.json.gz`, keep N copies, delete from DB)
- Dual output: DB + stdout (slog)
- Sensitive field redaction (api_key, tokens)

**Done When:**
- Log entry created → stored in DB with all fields
- Below log level → not stored
- Sensitive params → redacted in DB and stdout
- Archive trigger → oldest logs exported to `.json.gz`, deleted from DB
- Archive count > keep_copies → oldest archive deleted
- Dual output → same entry in DB and stdout
- ≥95% coverage on `internal/logging/`

---

### Phase 1 Gate Test

**Integration test proving Phase 1 works end-to-end:**

```
1. Load openhive.yaml (with defaults) + providers.yaml
2. Validate both configs pass
3. Initialize GORM/SQLite (in-memory)
4. Write a log entry via DBLogger → verify in DB
5. Encrypt/decrypt an API key → verify round-trip
6. Start HTTP server → GET /api/v1/health returns 200
7. Create a team config → verify directory + files created
8. Resolve a provider preset for an agent → verify flattened credentials
```

**All tests pass with ≥95% per-package coverage.**

---

## Phase 2: Main Assistant

The goal of Phase 2 is: **start the system, get a CLI prompt, chat with the main assistant.** The assistant can read and modify system configuration via admin tools.

The main assistant runs in the master container — Go spawns Node.js as a child process, they communicate over localhost WebSocket. No Docker containers needed for this phase.

---

### Issue #10: WebSocket Hub (Go Side)

**Story:** As the Go backend, I need a WebSocket hub managing persistent connections to containers (starting with the master container's localhost connection).

**Decisions:** 24, 47

**Acceptance Criteria:**
- `WSHub` implementation from [Core Interfaces](https://github.com/Z-M-Huang/openhive/wiki/Core-Interfaces)
- Endpoint: `GET /ws/container?team=<team-id>&token=<one-time-token>`
- Auth: team ID + one-time token (consumed on connection, Decision 47)
- Connection registry: track active connections per team ID
- Send/receive JSON messages with `type` field
- `gorilla/websocket` with ping/pong keep-alive
- Master container: `ws://localhost:8080/ws/container?team=main`
- Team containers: `ws://openhive:8080/ws/container?team=<tid>` (used in Phase 4+)

**Done When:**
- Valid token → connection accepted, token consumed
- Invalid/reused token → connection rejected (401)
- Send message → received by connected client
- Client disconnects → connection removed from registry
- Ping/pong → connection kept alive
- ≥95% coverage on `internal/ws/`

---

### Issue #11: WebSocket Protocol Messages

**Story:** I need well-defined message types for all Go ↔ container communication.

**Decisions:** 24, 25, 27, 36, 37, 44, 50

**Acceptance Criteria:**
- All message types from [WebSocket Protocol](https://github.com/Z-M-Huang/openhive/wiki/WebSocket-Protocol):
  - Go → Container: `container_init`, `task_dispatch`, `shutdown`, `tool_result`
  - Container → Go: `ready`, `heartbeat`, `task_result`, `escalation`, `tool_call`, `status_update`
- `container_init`: is_main_assistant, team_config, agents (with flattened provider_config), secrets, mcp_servers
- `heartbeat`: per-agent status (idle/busy/error/starting), detail, elapsed_seconds
- All messages verbose by default (Decision 36)
- Go-side serialization/deserialization
- Node.js-side TypeScript interfaces in `agent-runner/src/types.ts`

**Done When:**
- Every message type serializes → deserializes round-trip correctly (Go)
- Every message type has TypeScript interface (Node.js)
- Invalid message type → error (not panic)
- Missing required fields → validation error
- ≥95% coverage on message serialization code (both Go and TypeScript)

---

### Issue #12: Container Orchestrator (Node.js)

**Story:** I need an orchestrator inside each container that manages WebSocket communication and agent lifecycle. Phase 2 focuses on master-mode (child process, localhost WebSocket).

**Decisions:** 17, 18, 24, 26, 37

**Acceptance Criteria:**
- `agent-runner/src/orchestrator.ts`
- `agent-runner/src/ws-client.ts` — WebSocket client to Go backend
- On startup: connect WebSocket → wait for `container_init` → initialize agents
- Start 3rd-party MCP server processes if configured (Decision 37)
- Agent lifecycle: create/start/stop SDK instances on demand
- SDK custom tool registration per agent role (Decision 26)
- Tool call flow: agent → orchestrator → WebSocket → Go → result returned
- Heartbeat: send every 30 seconds with per-agent verbose status
- Handle `task_dispatch`: route to correct agent
- Handle `shutdown`: graceful shutdown
- Container orchestrator is infrastructure, NOT an agent (Decision 17)
- Master-mode: spawned as child process by Go, connects to `ws://localhost:8080/ws/container?team=main`
- Team-mode (Phase 4+): started by Docker, connects to `ws://openhive:8080/ws/container?team=<tid>`

**Done When:**
- Mock WebSocket server + mock SDK → orchestrator starts, connects, receives container_init
- Agents initialized from container_init config
- Task dispatched → routed to correct agent
- Tool call → forwarded via WebSocket, result returned to agent
- Heartbeat sent every 30s with correct agent statuses
- Shutdown signal → agents stopped, WebSocket closed
- ≥95% coverage on orchestrator + ws-client

---

### Issue #13: Agent Executor (SDK Wrapper)

**Story:** I need a wrapper around the Claude Agent SDK handling execution, sessions, and tool interception.

**Decisions:** 18, 29, 31, 42, 50

**Acceptance Criteria:**
- `agent-runner/src/agent-executor.ts`
- One SDK instance per agent (Decision 18)
- Auth: `CLAUDE_CODE_OAUTH_TOKEN` for oauth, `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` for direct (Decision 50)
- Model tier env vars: `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL` (Decision 31)
- Working directory: `/workspace/work/tasks/<task-id>/` (Decision 42)
- Session resume via session ID
- Tool interception: custom tool calls routed to orchestrator
- `permissionMode: 'bypassPermissions'`

**Done When:**
- OAuth provider → `CLAUDE_CODE_OAUTH_TOKEN` set in SDK env
- Direct provider → `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` set
- Model tier → correct `ANTHROPIC_DEFAULT_MODEL` set
- Task execution → SDK `query()` called with correct cwd, prompt, tools
- Session resume → SDK called with resume session ID
- Custom tool call → intercepted and forwarded to orchestrator
- ≥95% coverage on agent-executor

---

### Issue #14: CLI Channel

**Story:** As a developer, I want a CLI interface to interact with the main assistant during development, before any messaging channels are configured.

**Decisions:** 20

**Acceptance Criteria:**
- `ChannelAdapter` implementation for stdin/stdout in `internal/channel/cli.go`
- REPL loop: read line(s) from stdin → send to message callback → print response to stdout
- JID format: `cli:local`
- Multi-line input support (e.g., paste mode or delimiter-based)
- Always available — runs alongside other channels
- Typing indicator: print `...` or spinner while waiting for response
- Clean exit on Ctrl+C / Ctrl+D
- No external dependencies (stdlib only)
- Can be used as reference implementation for new channel adapters

**Done When:**
- Input line → callback fires with correct JID and content
- Response received → printed to stdout
- Ctrl+C → clean shutdown (Disconnect called)
- Adapter conforms to ChannelAdapter interface
- ≥95% coverage

---

### Issue #15: Message Router & Main Assistant Dispatch

**Story:** I need the message routing pipeline that connects channels to the main assistant — the end-to-end path from user input to AI response.

**Decisions:** 20

**Acceptance Criteria:**
- `MessageRouter` implementation from [Core Interfaces](https://github.com/Z-M-Huang/openhive/wiki/Core-Interfaces)
  - Register any number of channel adapters
  - OnMessage / OnMetadata callbacks
  - Route outbound response to correct channel via JID prefix
  - Per-chat cursor management (lastTimestamp, lastAgentTimestamp)
  - Trigger pattern matching (configurable per channel)
- Basic dispatch to main assistant:
  - Incoming message → create Task in DB → send `task_dispatch` via WSHub to master orchestrator
  - Receive `task_result` via WSHub → extract response → route back through MessageRouter → channel
- Message formatting: messages → XML format for agent consumption
- Response formatting: strip internal tags before sending to channel

**Done When:**
- Register CLI channel → send message → routed to main assistant via WebSocket
- Main assistant response → received via WebSocket → printed to CLI
- Register multiple channels → response routed to correct channel by JID
- Trigger pattern → matched correctly (message with trigger processed, without trigger ignored)
- Cursor management: cursor advances after successful response
- ≥95% coverage on `internal/channel/` (router + dispatch)

---

### Issue #16: Admin SDK Custom Tools

**Story:** As the main assistant, I need tools to read and modify system configuration so users can set up channels and providers through conversation.

**Decisions:** 26

**Acceptance Criteria:**
- SDK custom tools registered with the main assistant (NOT MCP, Decision 26)
- Tool definitions in `agent-runner/src/sdk-tools.ts` (admin section)
- Tools:
  - `get_config(section)` — read any config section (system, assistant, channels, providers). Secrets redacted.
  - `update_config(section, path, value)` — modify any config field. Triggers hot-reload via ConfigManager.
  - `get_system_status()` — health overview: connected channels, active agents, DB size, uptime
  - `list_channels()` — channel statuses (connected/disconnected/disabled/not-configured)
  - `enable_channel(name, config?)` — update channel config + trigger hot-reload → channel starts
  - `disable_channel(name)` — disable channel → hot-reload → channel stops
- Tool call flow: assistant → orchestrator → WebSocket → Go SDKToolHandler → ConfigManager/MessageRouter
- Config changes take effect via hot-reload — NO backend restart needed
- All tool calls logged verbosely

**Done When:**
- `get_config("channels")` → returns channel config with secrets redacted
- `update_config("channels", "discord.enabled", true)` → config updated, hot-reload fires
- `enable_channel("discord", {token_env: "DISCORD_TOKEN"})` → Discord adapter starts
- `disable_channel("discord")` → Discord adapter stops
- `get_system_status()` → returns health info
- Invalid config change → ValidationError returned to assistant
- All tools: correct request sent via WebSocket, correct response parsed
- ≥95% coverage on admin tool handlers (Go side + TypeScript side)

---

### Phase 2 Gate Test

**Integration test proving the main assistant is reachable via CLI:**

```
1. Start Phase 1 infrastructure (config, DB, API, logging)
2. Start WebSocket Hub on localhost
3. Go spawns Node.js orchestrator as child process
4. Orchestrator connects via WebSocket → Go sends container_init with main assistant config
5. Orchestrator creates Agent Executor → SDK instance ready (mocked SDK in test)
6. CLI channel started
7. Send message via CLI → MessageRouter → Go dispatch → WebSocket → orchestrator → Agent Executor
8. Mock SDK returns response → flows back through WebSocket → Go → MessageRouter → CLI output
9. Assistant calls get_config admin tool → tool_call via WebSocket → Go handles → tool_result returned
10. Assistant calls update_config → config file updated → hot-reload callback fires
```

**After Phase 2: you can start the system, open a CLI, and chat with the main assistant. The assistant can configure the system.**

---

## Phase 3: Communication Channels

Phase 3 adds Discord and WhatsApp as channel adapters. After this phase, the assistant configured Discord via CLI in Phase 2 → Discord channel is live → users can chat via Discord.

The `ChannelAdapter` interface and `MessageRouter` are already built in Phase 2. Phase 3 just plugs in new adapters and adds message persistence.

---

### Issue #17: Discord Channel Integration

**Story:** As a user, I want to interact with the assistant via Discord.

**Decisions:** 1

**Acceptance Criteria:**
- Discord adapter using `github.com/bwmarrin/discordgo`
- Implements `ChannelAdapter` interface (from Phase 2)
- Bot token from config `channels.discord.token_env`
- Message receiving: text, attachments (placeholder), replies
- Message sending with 2000-char split
- Typing indicators
- JID format: `discord:<channel_id>`
- Group and DM support
- Enable/disable via `channels.discord.enabled`
- Hot-reload: when config changes enable Discord, adapter starts dynamically

**Done When:**
- Mock discordgo session → message received → callback fires with correct JID + content
- Long message → split at 2000 chars
- Bot messages → ignored
- Trigger pattern → detected correctly
- Disabled in config → adapter not started
- Enabled via hot-reload → adapter starts without restart
- ≥95% coverage on Discord adapter

---

### Issue #18: WhatsApp Channel Integration

**Story:** As a user, I want to interact with the assistant via WhatsApp.

**Decisions:** 1

**Acceptance Criteria:**
- WhatsApp adapter using `go.mau.fi/whatsmeow`
- Implements `ChannelAdapter` interface (from Phase 2)
- QR code auth with session persistence at `channels.whatsapp.store_path`
- Message receiving: text, media captions
- Message sending with text splitting
- Typing indicators (presence updates)
- Reconnection with exponential backoff

**Done When:**
- Mock whatsmeow client → message received → callback fires
- QR code flow → session persisted to store_path
- Disconnect → reconnects with backoff
- Protocol messages (no text) → filtered out
- ≥95% coverage on WhatsApp adapter

---

### Issue #19: Message Store & Session Management

**Story:** Messages need to be persisted and sessions tracked per chat for conversation continuity.

**Acceptance Criteria:**
- Store all messages from registered chats in DB
- Per-chat session tracking (container, agent session ID)
- Cursor management: lastTimestamp, lastAgentTimestamp
- Cursor persistence in DB (survive restarts)
- Crash recovery: rollback cursor if processing fails before response sent

**Done When:**
- Message stored → retrievable by chatJID + time range
- Cursor advances → persisted in DB
- Restart → cursors restored from DB
- Processing fails → cursor NOT advanced (rollback)
- ≥95% coverage

---

### Phase 3 Gate Test

```
1. Start Phase 1+2 infrastructure (main assistant reachable via CLI)
2. Register mock Discord adapter + mock WhatsApp adapter
3. Simulate Discord message with trigger → routed to assistant
4. Assistant responds → response sent via mock Discord
5. Message stored in DB → verify
6. Cursor advances → verify in DB
7. Simulate WhatsApp message → routed to same assistant, response via WhatsApp
8. Restart system → cursors restored → no duplicate processing
```

**After Phase 3: you can chat with the assistant via CLI, Discord, or WhatsApp.**

---

## Phase 4: Team Containers

Phase 4 adds Docker container management. After this phase, the Go backend can spawn team containers that connect back via WebSocket. The Container Orchestrator (built in Phase 2) runs inside team containers — same code, different mode.

---

### Issue #20: Docker Container Runtime

**Story:** As a system component, I need to manage Docker containers via the Docker SDK.

**Decisions:** 3, 39

**Acceptance Criteria:**
- `ContainerRuntime` implementation via Docker SDK for Go
- Operations: create, start, stop, remove, logs, inspect, list
- Docker network management (`openhive-network`)
- Container naming: `openhive-<team-slug>`
- Resource limits (memory, CPU) from config
- Generate one-time auth token per container spawn (Decision 47)

**Done When:**
- Mock Docker client → create container → returns container ID
- Network created if not exists
- Container named correctly from team slug
- Resource limits applied correctly
- Auth token generated and passed as env var
- ≥95% coverage on `internal/container/` (runtime portion)

---

### Issue #21: Container Lifecycle Manager

**Story:** As a system operator, I want containers automatically started, health-checked, and cleaned up.

**Decisions:** 3, 38, 42

**Acceptance Criteria:**
- `ContainerManager` wrapping ContainerRuntime
- EnsureRunning: start if not running, return container info
- Auto-stop after idle timeout
- Restart on failure (max retries with backoff)
- Orphan cleanup on startup
- Concurrent start protection (one container per team)
- Global concurrency limit
- Workspace mounts: nested workspace tree (Decision 38)
- Config mounts: team config read-only

**Open Question:** Container lifecycle model — should containers be long-lived with restart policies, or short-lived (start per task, stop when idle)? Current design assumes idle timeout, but long-lived containers with Docker restart policies may be more resilient. Needs investigation.

**Done When:**
- EnsureRunning → starts container if not running, returns info
- Already running → returns existing info (no duplicate)
- Idle timeout → container stopped
- Failure → restart with backoff (up to max retries)
- Startup → orphaned containers cleaned up
- Max concurrent reached → EnsureRunning blocks or returns error
- ≥95% coverage on `internal/container/` (manager portion)

---

### Issue #22: Docker Images (Team + Master)

**Story:** I need two Docker images: team base and master.

**Decisions:** 40, 41

**Acceptance Criteria:**
- `deployments/Dockerfile.team` — multi-stage:
  - Base: `node:22-bookworm-slim` + Python 3
  - Compiled JS + production node_modules + pip + uvx
  - Non-root user, health check endpoint
  - No source code (Decision 41), size < 300MB
- `deployments/Dockerfile` — master:
  - Extends `openhive-team`
  - + Go binary (static) with embedded React SPA
  - Go PID 1, spawns Node.js child (Decision 39)
  - Size < 320MB

**Done When:**
- `make docker-build` builds both images without error
- Team image: starts, health check returns 200, no `.ts` files present
- Master image: starts, Go serves SPA at `/`, health check works
- Both images: `npx` and `uvx` available, non-root user
- Image sizes within target

---

### Issue #23: Heartbeat & Health Monitoring

**Story:** I want real-time visibility into agent status with automatic unhealthy detection.

**Decisions:** 27

**Acceptance Criteria:**
- `HeartbeatMonitor` implementation from [Core Interfaces](https://github.com/Z-M-Huang/openhive/wiki/Core-Interfaces)
- Record heartbeats (every 30s from containers)
- Per-agent status: idle, busy (task_id + detail + elapsed_seconds), error, starting
- Unhealthy: 3 missed heartbeats (90s) → container marked unhealthy
- Timeout: agent busy past `timeout_minutes` → killed, task failed, escalated
- Status queryable: per-agent, per-team, all

**Done When:**
- Heartbeat recorded → agent status updated
- No heartbeat for 90s → container returned by `GetUnhealthyContainers()`
- Agent busy past timeout → returned by `GetTimedOutAgents()`
- Query agent status → returns current status with correct fields
- ≥95% coverage

---

### Phase 4 Gate Test

```
1. Start Phase 1+2+3 infrastructure
2. Create team config via assistant (admin tools)
3. Mock Docker client → "start container"
4. Container "connects" via WebSocket with valid token
5. Go sends container_init → container receives it
6. Container sends heartbeat → Go records it, status queryable
7. Go sends task_dispatch → container receives it
8. Container sends task_result → Go receives it
9. Go sends shutdown → container acknowledges and disconnects
```

**Open Question:** Should we use a real Docker container for the gate test or mock the Docker API? Recommendation: mock Docker in automated tests, use real containers in manual validation.

**After Phase 4: the system can spawn and manage team containers.**

---

## Phase 5: Team Orchestration

Phase 5 adds team creation, task dispatch, and multi-level orchestration. After this phase, the assistant can create teams, delegate tasks, and consolidate results.

---

### Issue #24: Team SDK Custom Tools

**Story:** As the main assistant, I need SDK custom tools to create teams, manage agents, and dispatch tasks.

**Decisions:** 9, 26, 28, 49

**Acceptance Criteria:**
- SDK custom tools (NOT MCP, Decision 26) in `agent-runner/src/sdk-tools.ts` (team section)
- Main assistant tools:
  - `create_agent` — add agent to parent team, create definition files, return AID
  - `create_team` — create team dir + config, reference lead AID (two-step, Decision 49)
  - `delete_team` — with cascade warnings (Decision 28)
  - `delete_agent` — cascade to led team if applicable (Decision 28)
  - `list_teams` — hierarchy view
  - `dispatch_task`, `get_task_status`, `send_message`, `register_chat`
- Team lead tools: `dispatch_subtask`, `get_member_status`, `escalate`, `consolidate_results`
- Tool call flow: agent → orchestrator → WebSocket → Go → result

**Done When:**
- `create_agent` → Go creates agent files, returns AID
- `create_team` with valid lead AID → team created
- `create_team` without prior `create_agent` → error
- `delete_team` with child teams → cascade warning returned
- `dispatch_task` → task created in DB, dispatched to container
- Each tool: correct request sent via WebSocket, correct response parsed
- ≥95% coverage on sdk-tools (team section)

---

### Issue #25: Internal API for Container-Backend Communication

**Story:** I need internal API endpoints that containers call via SDK custom tools.

**Decisions:** 9, 49

**Acceptance Criteria:**
- Internal endpoints (Docker network only):
  - CRUD: agents, teams, tasks, messages, chats, skills
  - Callback: results from containers
  - See full list in [WebSocket Protocol](https://github.com/Z-M-Huang/openhive/wiki/WebSocket-Protocol) tool definitions
- Also callable via WebSocket `tool_call` / `tool_result` messages
- Internal token auth (one-time token per container)
- All operations logged verbosely

**Done When:**
- Each endpoint: valid request → correct response
- Each endpoint: invalid request → JSON error with correct code
- Auth: missing/invalid token → 401
- Create team → directory + files created, logged
- Delete team with cascade → warning returned, logged
- ≥95% coverage on internal API handlers

---

### Issue #26: Task Dispatch & Go Orchestrator

**Story:** When a task is assigned to a team, the Go orchestrator dispatches it, handles results, and manages the task DAG.

**Decisions:** 17, 19, 23, 42

**Acceptance Criteria:**
- `GoOrchestrator` implementation from [Core Interfaces](https://github.com/Z-M-Huang/openhive/wiki/Core-Interfaces)
- Dispatch: validate team → find leader → ensure container → send `task_dispatch` via WS
- Result: receive `task_result` → store in DB → check subtasks → report up
- Subtask decomposition: leader returns subtasks → orchestrator creates → dispatches
- Consolidation: all subtasks done → consolidation prompt to leader
- Multi-level: child team result → parent team leader
- Hierarchy enforcement: validate communication paths (Decision 19)
- File copy: Go copies between task folders (Decision 42)
- Task cancellation via `shutdown` message

**Done When:**
- Dispatch task → stored in DB, sent to container via WS
- Task result received → stored, parent notified
- Subtask decomposition → subtasks created and dispatched
- All subtasks complete → consolidation triggered
- Invalid route (non-supervisor to non-subordinate) → error
- File copy between teams → files exist in target, logged
- Cancel task → shutdown sent, task marked cancelled
- ≥95% coverage on `internal/orchestrator/`

---

### Issue #27: Skill Loading (URL + YAML)

**Story:** I want to load skills from URLs and add them to teams.

**Decisions:** 11, 21

**Acceptance Criteria:**
- Fetch URL content (HTTP GET)
- Parse: YAML, JSON, SKILL.md formats
- Validate tool names against known SDK tools
- Validate model_tier: haiku/sonnet/opus
- Save to team's `skills/` directory as YAML
- Error handling: invalid URL, unparseable, invalid tools

**Done When:**
- Valid YAML URL → skill file created in team's skills/
- Valid JSON URL → converted to YAML, saved
- SKILL.md format → parsed and saved
- Invalid tool name → ValidationError
- Unreachable URL → clear error
- ≥95% coverage

---

### Issue #28: Event Bus & Portal WebSocket Streaming

**Story:** The web portal needs real-time updates of what's happening across all teams.

**Acceptance Criteria:**
- `EventBus`: in-memory pub/sub
- Portal WebSocket: `GET /api/v1/ws`
- Events: task lifecycle, agent activity, container status, team creation, heartbeat
- Filtering: by team_name, task_id
- Events also written to LogEntry DB

**Done When:**
- Publish event → all subscribers receive it
- Subscribe with filter → only matching events received
- Portal WebSocket → events streamed to connected client
- Client disconnects → subscription cleaned up
- ≥95% coverage

---

### Phase 5 Gate Test

```
1. Start Phase 1+2+3+4 infrastructure (with mocked Docker + SDK)
2. Mock message triggers assistant
3. Assistant calls create_agent (SDK custom tool) → agent created
4. Assistant calls create_team → team created with lead AID
5. Assistant calls dispatch_task → task created, sent to container
6. Mock container returns task_result → stored in DB
7. Result propagated back to assistant → response sent to channel
8. Event bus → events received by portal WebSocket client
```

**After Phase 5: full team orchestration — create teams, dispatch tasks, multi-level decomposition.**

---

## Phase 6: Web Portal

---

### Issue #29: React SPA Scaffolding

**Story:** I want a web interface for monitoring and configuration.

**Decisions:** 13

**Acceptance Criteria:**
- React 18+ / Vite / TypeScript
- Pages: Dashboard, Teams, Tasks, Logs, Settings
- shadcn/ui, TanStack Query, React Router
- WebSocket hook for real-time events
- Dark/light mode, sidebar navigation
- No AI in frontend (Decision 13)

**Done When:**
- `bun run build` → production bundle without errors
- All pages render with mock data
- WebSocket hook connects and receives events
- Dark/light toggle works
- Component tests: ≥95% coverage
- Playwright: navigate to all pages → no errors

---

### Issue #30: Log Viewer UI

**Story:** I want to view system logs with filtering and search.

**Acceptance Criteria:**
- Log list: timestamp, level, component, action, message, team, task, duration
- Filters: level, component, team, date range, search
- Auto-refresh via WebSocket
- Log detail: full params JSON
- Archive browser, pagination

**Done When:**
- Component tests: filter changes → API called with correct params
- Log detail click → full params displayed
- Playwright: navigate to logs → apply filter → verify results change
- ≥95% component test coverage

---

### Issue #31: Team Visualization & Management UI

**Story:** I want to see my team hierarchy and manage configurations.

**Acceptance Criteria:**
- Org chart tree visualization
- Team detail: slug, display name, TID, leader, agents, skills, container status
- CRUD: create/edit/delete teams
- Start/stop containers, agent management
- Real-time agent status from heartbeat

**Done When:**
- Component tests: org chart renders correct tree structure
- Create team form → API called with correct payload
- Playwright: navigate to teams → see tree → click team → see details
- ≥95% component test coverage

---

### Issue #32: Task Monitoring UI

**Story:** I want to view task execution history and real-time progress.

**Acceptance Criteria:**
- Task list with filters (status, team, date)
- Task detail: status, agent, result, duration, events timeline
- Task tree view (subtask DAG)
- Real-time log from WebSocket
- Cancel running tasks

**Done When:**
- Component tests: task tree renders DAG correctly
- Cancel button → API called
- Playwright: navigate to tasks → filter → see task detail → see subtask tree
- ≥95% component test coverage

---

### Issue #33: Settings & Configuration UI

**Story:** I want to edit system settings and provider presets from the web portal.

**Decisions:** 45

**Acceptance Criteria:**
- Master config editor
- Provider presets CRUD (Decision 45)
- Channel status (Discord connected, WhatsApp QR)
- Master key unlock form
- System status: DB size, container count, archive status

**Done When:**
- Component tests: edit provider → API called with updated config
- Playwright: navigate to settings → edit provider → save → verify change persisted
- ≥95% component test coverage

---

### Phase 6 Gate Test (Playwright)

```
1. Start backend with test fixtures (seeded DB)
2. Playwright: load dashboard → verify stats rendered
3. Navigate to Teams → org chart visible with correct team count
4. Click a team → detail panel shows agents and status
5. Navigate to Tasks → task list renders
6. Click a task → subtask tree and events timeline visible
7. Navigate to Logs → filter by level=error → verify filtered results
8. Navigate to Settings → provider list visible
9. Toggle dark mode → verify theme changes
```

---

## Phase 7: Distribution

---

### Issue #34: Docker Compose Packaging

**Story:** I want to install OpenHive with `docker compose up`.

**Decisions:** 39, 40

**Acceptance Criteria:**
- `docker-compose.yml`: openhive service, volumes (data, docker socket), network, env from `.env`
- `.env.example` with all required variables
- First-run: creates DB, directories, network

**Done When:**
- `docker compose up` → container starts, health check passes
- SPA loads at `http://localhost:8080`
- `data/` directory created with default configs
- Stop and restart → data persists

---

### Issue #35: npm CLI Package

**Story:** I want to install OpenHive via npm.

**Acceptance Criteria:**
- `npm install -g openhive`
- `openhive start` / `openhive stop` / `openhive status`
- Downloads platform-specific Go binary on postinstall
- Supports: linux-amd64, linux-arm64, darwin-amd64, darwin-arm64

**Done When:**
- Install → binary downloaded for correct platform
- `openhive start` → Docker Compose started
- `openhive status` → shows running/stopped

---

### Phase 7 Gate Test

```
1. docker compose up → health check passes within 30s
2. SPA loads → dashboard page renders
3. CLI channel available → send message → assistant responds
4. Create team via CLI → team appears in web portal
5. Dispatch task → task visible in task monitoring UI
6. docker compose down && docker compose up → data persists
```

---

## Phase 8: Production Hardening

---

### Issue #36: Error Handling & Recovery

**Story:** I want graceful failure handling with automatic recovery.

**Acceptance Criteria:**
- Container crash → restart with backoff
- Task failure → propagate to parent tasks
- Orphaned container cleanup
- Stale task detection (past timeout → mark failed)
- Channel reconnection on disconnect
- Cursor crash recovery
- All errors logged verbosely

**Done When:**
- Container crash simulated → restarted within backoff period
- Task fails → parent task notified, status updated
- Orphaned container found on startup → removed
- Stale task → marked failed, escalated
- ≥95% coverage on recovery code paths

---

### Issue #37: Coverage Enforcement

**Story:** I want coverage enforcement for Go and TypeScript.

**Decisions:** 33

**Acceptance Criteria:**
- `make coverage` runs all tests with coverage reporting
- Coverage gate: Go ≥95% per package, TypeScript ≥95% per file
- `go test -coverprofile`, `vitest --coverage`
- `govulncheck`, `bun audit` for security

**Done When:**
- `make coverage` → generates reports, fails if below 95%
- Security scan → runs without errors

---

### Issue #38: End-to-End Integration Tests

**Story:** I want full E2E tests verifying the complete flow.

**Acceptance Criteria:**
- Test flow: configure → start → create team → dispatch task → verify result
- Mock AI provider (canned responses)
- Mock Discord/WhatsApp channels
- Full cleanup after tests
- Skippable with `go test -short`

**Done When:**
- Single-level task: message → team → result → response
- Multi-level: message → team → subtask to child team → consolidated result
- Failure: task fails → error propagated → user notified
- Concurrent: multiple tasks dispatched simultaneously → all complete

---

### Issue #39: Config Export & Import

**Story:** I want to backup and restore my full configuration.

**Acceptance Criteria:**
- `GET /api/v1/config/export` → tarball (keys redacted)
- `POST /api/v1/config/import` → import from tarball
- Validate all configs on import
- Schema version for compatibility

**Done When:**
- Export → tarball contains all configs, keys redacted
- Import → configs restored, validated
- Round-trip: export → import → configs identical (except redacted keys)
- Invalid import → validation error, no changes applied
- ≥95% coverage

---

## Phase 9: Documentation

---

### Issue #40: CLAUDE.md Project Configuration

**Done When:**
- Architecture summary with wiki links
- Tech stack, project structure, conventions
- Critical patterns (12 items)
- Build commands
- Links to all wiki pages

---

### Issue #41: README.md & User Documentation

**Done When:**
- Project overview, architecture diagram
- Key concepts, features, tech stack
- Quick start (Docker Compose, 3 steps)
- Configuration overview with wiki links
- Development guide, license (GPL v3)

---

## Phase 10: Future Feature Spikes

Each spike produces a design document and identifies implementation tickets. All features are **additive**.

Full details: [Wiki — Future Features](https://github.com/Z-M-Huang/openhive/wiki/Future-Features)

---

### Issue #42: Spike: Browser Service (Shared Sidecar + MCP Bridge)

**Status:** Decided (Option C)
**Goal:** Design the `openhive-browser` container (Playwright, MCP bridge, session isolation).
**Output:** Design doc with: container architecture, MCP protocol, connection pooling, resource limits, security model.

---

### Issue #43: Spike: Trigger System (Cron + Webhooks + Events)

**Status:** Decided (approach)
**Goal:** Design trigger config schema, cron scheduler, webhook endpoints, event pattern matching.
**Output:** Design doc with: YAML config schema, Go implementation plan, webhook auth model.

---

### Issue #44: Spike: Policy Inheritance (Cascading Metadata + Rules)

**Status:** Conceptual
**Goal:** Design cascading policy system (budget, rate limits, approval thresholds).
**Output:** Design doc with: policy schema, resolution algorithm, enforcement points, UI for effective policies.

---

### Issue #45: Spike: Approval Gates (Human-in-the-Loop)

**Status:** Conceptual
**Goal:** Design approval flow for high-stakes actions.
**Output:** Design doc with: WS message types, task state machine, approval delivery, timeout behavior.

---

### Issue #46: Spike: Notifications & Alerts

**Status:** Conceptual
**Goal:** Design push notification system via existing channel adapters.
**Output:** Design doc with: notification types, preferences config, channel routing rules.

---

### Issue #47: Spike: Team Templates (Blueprints)

**Status:** Conceptual
**Goal:** Design template format and `create_team_from_template` SDK tool.
**Output:** Design doc with: template schema, storage, SDK tool contract, built-in templates.

---

### Issue #48: Spike: Reporting & Analytics

**Status:** Conceptual
**Goal:** Design reporting system (cost, task completion, agent utilization).
**Output:** Design doc with: report types, data sources, delivery methods, web portal dashboards.

---

### Issue #49: Spike: Priority Queuing & Rate Limiting

**Status:** Conceptual
**Goal:** Design priority queue and rate limiting integrated with policy system.
**Output:** Design doc with: priority levels, queue ordering, rate limit counters, cost estimation.

---

## Investigation Tickets

1. **WhatsApp library evaluation** — Verify `go.mau.fi/whatsmeow` suitability. Check API stability, QR auth, message types, session persistence.

2. **Claude Agent SDK container integration** — Verify `query()` works inside Docker with secrets via WebSocket `container_init`. Build proof-of-concept.

3. **Multi-level task decomposition UX** — How should leader agents decompose tasks? What prompt engineering is needed? Test with real API calls.

4. **Docker socket mount security** — Document security implications. Evaluate rootless Docker or restricted socket access.

---

## Decision Coverage Matrix

| Decision | Title | Issues |
|----------|-------|--------|
| 1 | Messaging interaction | #14, #17, #18 |
| 2 | Single user system | #3 |
| 3 | Docker sibling containers | #20, #21 |
| 4 | Main assistant in container | #12, #22 |
| 5 | Config files for org structure | #3, #4 |
| 6 | SQLite only | #6 |
| 7 | ~~Centralized workspaces~~ | Superseded by D38 |
| 8 | Recursive team config | #4 |
| 9 | Dynamic team creation | #24, #25 |
| 10 | Verbose DB-backed logging | #9 |
| 11 | URL-based skill loading | #27 |
| 12 | Go + Node.js polyglot | #1, #12, #13 |
| 13 | Frontend config/monitoring only | #29 |
| 14 | ~~NanoClaw IPC~~ | Superseded by D24 |
| 15 | Three core definitions | #2 |
| 16 | Agent IDs (AIDs) | #2 |
| 17 | Two-layer orchestration | #12, #26 |
| 18 | Multiple SDK instances | #12, #13 |
| 19 | No direct container-to-container | #26 |
| 20 | Extensible channel interface | #14, #15 |
| 21 | Team-specific skills | #4, #27 |
| 22 | Anthropic-protocol only | #5 |
| 23 | Shared agent model | #26 |
| 24 | WebSocket protocol | #10, #11, #12 |
| 25 | Fixed team lead placement | #4, #11 |
| 26 | SDK custom tools (not MCP) | #12, #16, #24 |
| 27 | Heartbeat system | #23 |
| 28 | Bi-directional deletion | #24 |
| 29 | Agent definition files | #3, #4, #13 |
| 30 | No team role_definition | #4 |
| 31 | Model tier system | #5, #13 |
| 32 | bun package manager | #1 |
| 33 | No CI/CD for now | #37 |
| 34 | Team IDs (TIDs) | #2 |
| 35 | Per-team env vars | #4 |
| 36 | Verbose messages by default | #9, #11 |
| 37 | 3rd-party MCP servers | #4, #11, #12 |
| 38 | Nested workspaces | #21 |
| 39 | Master container | #20, #22 |
| 40 | Two Docker images | #22 |
| 41 | Compiled code only | #8, #22 |
| 42 | Task-scoped workspace folders | #13, #21, #26 |
| 43 | Team lead external to agents list | #3, #4 |
| 44 | Flattened per-agent provider config | #5, #11 |
| 45 | Global provider presets | #5, #33 |
| 46 | Inter-agent messaging (future) | Future spike |
| 47 | Container auth (one-time token) | #10, #20 |
| 48 | Team naming model | #4 |
| 49 | create_team two-step | #24 |
| 50 | OAuth runtime mapping | #5, #13 |
