/**
 * OpenHive entry point.
 *
 * Bootstraps the unified orchestrator in either **root** or **non-root** mode
 * based on the `OPENHIVE_IS_ROOT` environment variable.
 *
 * ## Root mode (`OPENHIVE_IS_ROOT=true`)
 *
 * Activates all services:
 * - Messaging channel adapters (Discord)
 * - SQLite database (WAL mode, async write queue)
 * - REST API server (Fastify, bound to 127.0.0.1 by default)
 * - WebSocket hub (container connections, hub-and-spoke topology)
 * - Docker container runtime (sibling containers)
 * - Trigger scheduler (cron, webhook, channel_event, task_completion)
 *
 * ## Non-root mode
 *
 * Activates minimal services:
 * - Orchestrator (local agent management)
 * - WebSocket client (connects to root hub)
 *
 * ## Startup validation order
 *
 * 1. Load and validate provider presets (`providers.yaml`)
 * 2. Load and validate master configuration (`openhive.yaml`)
 * 3. Validate environment variables (`OPENHIVE_IS_ROOT`, `OPENHIVE_HOST_DIR`, etc.)
 * 4. Validate and unlock master encryption key (`OPENHIVE_MASTER_KEY`)
 * 5. Discover and validate team configurations (`team.yaml` files)
 * 6. Build initial org chart from team configs
 *
 * ## Graceful shutdown order
 *
 * Triggered by SIGINT / SIGTERM:
 * 1. Stop config file watchers
 * 2. Flush and stop the logger
 * 3. Close the EventBus
 * 4. Close the database (flush write queue, checkpoint WAL)
 * 5. Close WebSocket connections (hub or client)
 * 6. Disconnect channel adapters
 * 7. Terminate child processes (agent SDK instances, with timeout)
 *
 * // INV-09: Invariants in code, policies in skills
 * // INV-10: Root is a control plane
 *
 * @module
 */

import { resolve, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import Dockerode from 'dockerode';

// INV-09: Invariants in code, policies in skills
// INV-10: Root is a control plane

import { ConfigLoaderImpl } from './config/loader.js';
import { LoggerImpl } from './logging/logger.js';
import { StdoutSink } from './logging/sinks.js';
import { SQLiteSink } from './logging/sinks.js';
import { Database } from './storage/database.js';
import {
  newTaskStore,
  newMessageStore,
  newLogStore,
  newTaskEventStore,
  newToolCallStore,
  newDecisionStore,
  newSessionStore,
  newMemoryStore,
  newIntegrationStore,
  newCredentialStore,
} from './storage/stores/index.js';
import { KeyManagerImpl } from './security/key-manager.js';
import { EventBusImpl } from './control-plane/event-bus.js';
import { OrgChartImpl } from './control-plane/org-chart.js';
import { WSServer } from './websocket/server.js';
import { WSConnectionImpl } from './websocket/connection.js';
import { TokenManagerImpl } from './websocket/token-manager.js';
import { APIServer } from './api/server.js';
import { HealthMonitorImpl } from './containers/health.js';
import { DiscordAdapter } from './channels/discord.js';
import { MessageRouterImpl } from './channels/router.js';
import { TriggerSchedulerImpl } from './triggers/scheduler.js';
import { OrchestratorImpl } from './control-plane/orchestrator.js';
import { DispatchTrackerImpl } from './control-plane/dispatch-tracker.js';
import { RouterImpl } from './control-plane/router.js';
import { AgentExecutorImpl } from './executor/executor.js';
import { SessionManagerImpl } from './executor/session.js';
import { MCPRegistryImpl } from './mcp/registry.js';
import { ContainerRuntimeImpl } from './containers/runtime.js';
import { ContainerManagerImpl } from './containers/manager.js';
import { ContainerProvisionerImpl } from './containers/provisioner.js';
import { WorkspaceLockImpl } from './control-plane/workspace-lock.js';
import { PluginManagerImpl } from './plugins/manager.js';
import { LogLevel, ChannelType, ProviderType } from './domain/enums.js';
import { DomainError, NotFoundError, mapDomainErrorToWSError } from './domain/errors.js';
import type { Logger, LogSink, OrgChartTeam, OrgChartAgent, SessionStore, MCPServerConfig, TaskStore, MessageStore, LogStore, MemoryStore, IntegrationStore, CredentialStore, ToolCallStore, ResolvedProvider, AgentInitConfig } from './domain/interfaces.js';
import { resolveSecretsTemplatesInObject } from './mcp/tools/index.js';

// ---------------------------------------------------------------------------
// Root workspace CLAUDE.md — instructs the SDK subprocess about MCP tools
// ---------------------------------------------------------------------------

const ROOT_WORKSPACE_CLAUDE_MD = `# OpenHive Assistant

You are an AI assistant running inside OpenHive. You have 23 management tools available via MCP.

## CRITICAL: Use MCP Tools for System Operations

You MUST use the following MCP tools — do NOT write files directly for these operations:

| Task | Tool to Use | Do NOT |
|------|-------------|--------|
| Remember facts | \`save_memory\` | Write to MEMORY.md directly |
| Search memories | \`recall_memory\` | Read MEMORY.md directly |
| Create an agent | \`create_agent\` | Write .claude/agents/*.md directly |
| Schedule recurring task | \`register_trigger\` | Suggest crontab or write YAML |
| Create a task for an agent | \`create_task\` | Describe what should happen without creating a task |
| Register HTTP endpoint | \`register_webhook\` | Write server config directly |

Writing files directly does NOT register them in the system. Only MCP tool calls update the database, org chart, and trigger scheduler.

## HTTP Calls

You CAN make HTTP calls. Use the built-in HTTP client:
\`\`\`bash
bun run /app/common/scripts/http-client.ts https://example.com/api --method POST --data '{"key":"value"}'
\`\`\`
This client has SSRF protection and timeout handling. You can also use curl via Bash.

## Creating Agents

When you create an agent with \`create_agent\`, include a DETAILED description that covers:
- What the agent does (full job description)
- Step-by-step instructions for its workflow
- API endpoints, credentials, entity IDs it needs
- Decision rules and thresholds
- What to do on success vs failure

Do NOT create minimal agents with just a name. The description IS the agent's system prompt.
Check if an agent already exists before creating a duplicate — use \`inspect_topology\` first.

## Available Tools (23)

**Container:** spawn_container, stop_container, list_containers
**Team:** create_team, create_agent
**Task:** create_task, dispatch_subtask, update_task_status
**Messaging:** send_message
**Orchestration:** escalate
**Memory:** save_memory, recall_memory
**Integration:** create_integration, test_integration, activate_integration
**Secrets:** get_credential, set_credential
**Query:** get_team, get_task, get_health, inspect_topology
**Event:** register_webhook, register_trigger
`;

// ---------------------------------------------------------------------------
// Global State (for shutdown handling)
// ---------------------------------------------------------------------------

interface ShutdownState {
  configLoader: ConfigLoaderImpl | null;
  logger: Logger | null;
  eventBus: EventBusImpl | null;
  database: Database | null;
  wsServer: WSServer | null;
  wsConnection: WSConnectionImpl | null;
  apiServer: APIServer | null;
  healthMonitor: HealthMonitorImpl | null;
  discordAdapter: DiscordAdapter | null;
  messageRouter: MessageRouterImpl | null;
  triggerScheduler: TriggerSchedulerImpl | null;
  orchestrator: OrchestratorImpl | null;
  tokenManager: TokenManagerImpl | null;
  keyManager: KeyManagerImpl | null;
  dispatchTracker: DispatchTrackerImpl | null;
  pluginManager: PluginManagerImpl | null;
  stores: {
    taskStore: TaskStore | null;
    messageStore: MessageStore | null;
    logStore: LogStore | null;
    memoryStore: MemoryStore | null;
    integrationStore: IntegrationStore | null;
    credentialStore: CredentialStore | null;
    toolCallStore: ToolCallStore | null;
  } | null;
}

const shutdownState: ShutdownState = {
  configLoader: null,
  logger: null,
  eventBus: null,
  database: null,
  wsServer: null,
  wsConnection: null,
  apiServer: null,
  healthMonitor: null,
  discordAdapter: null,
  messageRouter: null,
  triggerScheduler: null,
  orchestrator: null,
  tokenManager: null,
  keyManager: null,
  dispatchTracker: null,
  pluginManager: null,
  stores: null,
};

let isShuttingDown = false;

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Parses a log level string to LogLevel enum.
 * Defaults to Info if invalid or not provided.
 */
function parseLogLevel(level: string | undefined): LogLevel {
  switch (level?.toLowerCase()) {
    case 'trace':
      return LogLevel.Trace;
    case 'debug':
      return LogLevel.Debug;
    case 'info':
      return LogLevel.Info;
    case 'warn':
      return LogLevel.Warn;
    case 'error':
      return LogLevel.Error;
    case 'audit':
      return LogLevel.Audit;
    default:
      return LogLevel.Info;
  }
}

/**
 * Parses a listen address string (e.g., "127.0.0.1:8080") into host and port.
 */
function parseListenAddress(address: string): { host: string; port: number } {
  const parts = address.split(':');
  if (parts.length === 2) {
    const port = parseInt(parts[1], 10);
    if (!isNaN(port) && port > 0 && port < 65536) {
      return { host: parts[0], port };
    }
  }
  // Default fallback
  return { host: '127.0.0.1', port: 8080 };
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Application entry point.
 *
 * Reads `OPENHIVE_IS_ROOT` from the environment to determine operating mode,
 * then initializes the appropriate subsystems and begins accepting work.
 *
 * **Root mode** (INV-10): activates the full control plane including channels,
 * database, REST API, WebSocket hub, Docker runtime, and trigger scheduler.
 *
 * **Non-root mode**: activates only the local orchestrator and WebSocket client
 * connection to the root container.
 *
 * Startup proceeds through a strict validation sequence:
 * providers -> master config -> env -> key -> teams -> org chart.
 *
 * Registers SIGINT and SIGTERM handlers for graceful shutdown that tears down
 * subsystems in reverse initialization order.
 */
export async function main(): Promise<void> {
  const isRoot = process.env['OPENHIVE_IS_ROOT'] === 'true';

  // INV-09: Invariants in code, policies in skills
  // INV-10: Root is a control plane — root mode activates the full
  //         control plane; non-root activates orchestrator + WS client only.

  // -------------------------------------------------------------------------
  // Phase 1: Load Configuration
  // -------------------------------------------------------------------------

  const configLoader = new ConfigLoaderImpl();
  shutdownState.configLoader = configLoader;

  // Load master config
  const masterConfig = await configLoader.loadMaster();
  const logLevel = parseLogLevel(masterConfig.server.log_level);
  const { host: listenHost, port: listenPort } = parseListenAddress(
    masterConfig.server.listen_address
  );

  // Load providers (root only, but load in both to validate)
  let providers: Record<string, unknown> = {};
  try {
    providers = await configLoader.loadProviders();
  } catch {
    // providers.yaml is optional in non-root.
    // In root mode, it's also optional if CLAUDE_CODE_OAUTH_TOKEN env var is set
    // (enables `bun run docker` with just the env var).
    if (isRoot && !process.env['CLAUDE_CODE_OAUTH_TOKEN']) {
      throw new Error('providers.yaml is required in root mode (or set CLAUDE_CODE_OAUTH_TOKEN env var)');
    }
  }

  // -------------------------------------------------------------------------
  // Phase 2: Initialize Logger
  // -------------------------------------------------------------------------

  const sinks = [new StdoutSink(logLevel)];
  const logger = new LoggerImpl({
    minLevel: logLevel,
    sinks,
    batchSize: 50,
    flushIntervalMs: 100,
  });
  shutdownState.logger = logger;

  logger.info('OpenHive starting', {
    is_root: isRoot,
    log_level: masterConfig.server.log_level,
    listen_address: masterConfig.server.listen_address,
  });

  // -------------------------------------------------------------------------
  // Phase 3: Root-Specific Initialization
  // -------------------------------------------------------------------------

  if (isRoot) {
    await initializeRootMode(configLoader, logger, masterConfig, providers, listenHost, listenPort);
  } else {
    await initializeNonRootMode(logger);
  }

  // -------------------------------------------------------------------------
  // Phase 4: Register Shutdown Handlers
  // -------------------------------------------------------------------------

  registerShutdownHandlers(logger);

  logger.info('OpenHive initialized', { is_root: isRoot });
}

/**
 * Initializes all root-only services.
 */
async function initializeRootMode(
  configLoader: ConfigLoaderImpl,
  logger: Logger,
  masterConfig: Awaited<ReturnType<typeof configLoader.loadMaster>>,
  providers: Record<string, unknown>,
  listenHost: string,
  listenPort: number,
): Promise<void> {
  logger.info('Initializing root mode services');

  // 1. Validate master key
  const masterKey = process.env['OPENHIVE_MASTER_KEY'];
  if (!masterKey || masterKey.length < 32) {
    throw new Error('OPENHIVE_MASTER_KEY environment variable must be at least 32 characters');
  }

  // 2. Initialize database
  const dbPath = resolve(masterConfig.database.path);
  const database = new Database(dbPath);
  await database.initialize();
  shutdownState.database = database;

  logger.info('Database initialized', { path: dbPath });

  // 3. Initialize key manager
  const keyManager = new KeyManagerImpl();
  await keyManager.unlock(masterKey);
  shutdownState.keyManager = keyManager;

  logger.info('Key manager unlocked');

  // 4. Initialize stores
  const taskStore = newTaskStore(database);
  const messageStore = newMessageStore(database); // Used by channels adapter
  const logStore = newLogStore(database);
  const taskEventStore = newTaskEventStore(database);
  const toolCallStore = newToolCallStore(database);
  const decisionStore = newDecisionStore(database); // Used for decision audit
  const sessionStore = newSessionStore(database);
  const memoryStore = newMemoryStore(database);
  const integrationStore = newIntegrationStore(database); // Used for integrations
  const credentialStore = newCredentialStore(database); // Used for credentials

  // Suppress unused warnings for stores that will be wired up later
  void messageStore;
  void decisionStore;
  // credentialStore is used in onConnect for secrets resolution

  // Add SQLite sink to logger for persistence
  const sqliteSink = new SQLiteSink(logStore);
  (logger as unknown as { sinks: unknown[] }).sinks.push(sqliteSink);

  logger.info('Stores initialized');

  // 5. Initialize event bus
  const eventBus = new EventBusImpl();
  shutdownState.eventBus = eventBus;

  logger.info('Event bus started');

  // 6. Build org chart from config
  const orgChart = new OrgChartImpl();

  // Bootstrap root team with main assistant
  const assistantConfig = masterConfig.assistant;
  const rootTeamTid = `tid-main-${Date.now().toString(16)}`;

  // Create root team (bypassing INV-01 check for bootstrap)
  const rootTeam: OrgChartTeam = {
    tid: rootTeamTid,
    slug: 'main',
    leaderAid: assistantConfig.aid,
    parentTid: '',
    depth: 0,
    containerId: 'root',
    health: 'running',
    agentAids: [assistantConfig.aid],
    workspacePath: '/app/workspace',
  };

  // Add root team directly to internal maps (bypasses INV-01 for bootstrap)
  (orgChart as unknown as { teamsByTid: Map<string, OrgChartTeam> }).teamsByTid.set(rootTeamTid, rootTeam);
  (orgChart as unknown as { teamsBySlug: Map<string, OrgChartTeam> }).teamsBySlug.set(rootTeam.slug, rootTeam);
  (orgChart as unknown as { agentsByTeam: Map<string, Set<string>> }).agentsByTeam.set(rootTeam.slug, new Set([assistantConfig.aid]));

  // Add main assistant agent
  const mainAssistant: OrgChartAgent = {
    aid: assistantConfig.aid,
    name: assistantConfig.name,
    teamSlug: 'main',
    role: 'main_assistant',
    status: 'idle',
    leadsTeam: 'main',
  };
  (orgChart as unknown as { agentsByAid: Map<string, OrgChartAgent> }).agentsByAid.set(mainAssistant.aid, mainAssistant);

  logger.info('Org chart initialized', {
    root_tid: rootTeamTid,
    main_assistant: assistantConfig.aid,
  });

  // 7. Initialize token manager
  const tokenManager = new TokenManagerImpl({ ttlMs: 300_000 });
  tokenManager.startCleanup(60_000);
  shutdownState.tokenManager = tokenManager;

  logger.info('Token manager started');

  // Helper: resolve a named provider preset from providers.yaml into a ResolvedProvider.
  // The providers map has shape: Record<string, Provider> (Provider from domain.ts).
  // Falls back to a safe oauth default if the preset is not found.
  function resolveProviderPreset(presetName: string): ResolvedProvider {
    const preset = (providers as Record<string, Record<string, unknown>>)[presetName];
    if (!preset) {
      // No preset found in providers.yaml — fall back to CLAUDE_CODE_OAUTH_TOKEN env var
      const envOauthToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
      if (envOauthToken) {
        return {
          type: ProviderType.OAuth,
          oauthToken: envOauthToken,
          models: {
            haiku: 'claude-haiku-4-5-20251001',
            sonnet: 'claude-sonnet-4-6',
            opus: 'claude-opus-4-6',
          } as ResolvedProvider['models'],
        };
      }
      // No credentials available — empty models, container will fail at SDK call time
      return { type: ProviderType.OAuth, models: {} as ResolvedProvider['models'] };
    }

    // Resolve from providers.yaml preset (takes precedence over env vars)
    const resolved: ResolvedProvider = {
      type: (preset['type'] as string) === ProviderType.AnthropicDirect
        ? ProviderType.AnthropicDirect
        : ProviderType.OAuth,
      ...(preset['api_key'] !== undefined ? { apiKey: String(preset['api_key']) } : {}),
      ...(preset['base_url'] !== undefined ? { baseUrl: String(preset['base_url']) } : {}),
      ...(preset['oauth_token'] !== undefined ? { oauthToken: String(preset['oauth_token']) } : {}),
      models: ((preset['models'] as Record<string, string>) ?? {}) as ResolvedProvider['models'],
    };

    // If preset exists but has no credentials, fall back to CLAUDE_CODE_OAUTH_TOKEN env var
    if (!resolved.apiKey && !resolved.oauthToken) {
      const envOauthToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
      if (envOauthToken) {
        resolved.oauthToken = envOauthToken;
        resolved.type = ProviderType.OAuth;
      }
    }

    return resolved;
  }

  // Helper: resolve a model tier string to a concrete model ID using the resolved provider.
  // Falls back to the tier string itself if not mapped (allows passthrough of explicit model IDs).
  function resolveModel(tier: string, resolvedProvider: ResolvedProvider): string {
    return (resolvedProvider.models as Record<string, string | undefined>)[tier] ?? tier;
  }

  // 8. Initialize WebSocket server (WSServer implements WSHub with rate limiting and write queues)
  const wsServer = new WSServer(tokenManager, {
    onMessage: async (tid: string, message: { type: string; data: Record<string, unknown> }) => {
      logger.debug('WS message received', { tid, type: message.type });

      switch (message.type) {
        case 'heartbeat': {
          const agents = message.data['agents'] as Array<{ aid: string; status: string; detail: string }>;
          if (agents) {
            shutdownState.healthMonitor?.recordHeartbeat(tid, agents.map(a => ({
              aid: a.aid,
              status: a.status as 'idle' | 'busy' | 'error' | 'starting',
              detail: a.detail,
            })));
          }
          break;
        }

        case 'tool_call': {
          // Forward tool calls from containers to orchestrator
          const { call_id, tool_name, arguments: args, agent_aid } = message.data as {
            call_id: string;
            tool_name: string;
            arguments: Record<string, unknown>;
            agent_aid: string;
          };
          if (shutdownState.orchestrator) {
            shutdownState.orchestrator.handleToolCall(agent_aid, tool_name, args, call_id).then((result) => {
              wsServer.send(tid, { type: 'tool_result', data: { call_id, result } });
            }).catch((err) => {
              const isDomainError = err instanceof DomainError;
              const errorCode = isDomainError ? mapDomainErrorToWSError(err) : 'INTERNAL_ERROR';
              const errorMessage = isDomainError ? err.message : 'Internal error processing tool call';
              wsServer.send(tid, { type: 'tool_result', data: { call_id, error_code: errorCode, error_message: errorMessage } });
              logger.error('tool_call handler failed', { call_id, error: String(err) });
            });
          }
          break;
        }

        case 'task_result': {
          // Forward task results to orchestrator
          const { task_id, agent_aid, status, result, error } = message.data as {
            task_id: string;
            agent_aid: string;
            status: 'completed' | 'failed';
            result?: string;
            error?: string;
          };
          const taskStatus = status === 'completed' ? 'completed' : 'failed';
          if (shutdownState.orchestrator) {
            shutdownState.orchestrator.handleTaskResult(task_id, agent_aid, taskStatus, result, error).catch((err) => {
              logger.error('task_result handler failed', { task_id, error: String(err) });
            });
          }
          break;
        }

        case 'escalation': {
          // Forward escalations to orchestrator
          const { task_id, agent_aid, reason, context } = message.data as {
            task_id: string;
            agent_aid: string;
            reason: string;
            context: Record<string, unknown>;
          };
          if (shutdownState.orchestrator) {
            shutdownState.orchestrator.handleEscalation(agent_aid, task_id, reason as any, context).catch((err) => {
              logger.error('escalation handler failed', { task_id, error: String(err) });
            });
          }
          break;
        }

        case 'ready': {
          // Container ready notification - validate protocol and update state
          const { team_id, agent_count, protocol_version } = message.data as {
            team_id: string;
            agent_count: number;
            protocol_version: string;
          };

          // Validate protocol version (major version must match)
          // Wiki: "Root validates protocol_version -- major mismatch causes rejection"
          const expectedMajor = '1';
          const receivedMajor = protocol_version.split('.')[0];
          if (receivedMajor !== expectedMajor) {
            logger.error('Protocol version mismatch - disconnecting container', {
              tid,
              expected: expectedMajor,
              received: protocol_version,
            });
            // Disconnect the container with protocol error (1002)
            if (shutdownState.wsServer) {
              shutdownState.wsServer.disconnect(tid, 1002, `Protocol version mismatch: expected ${expectedMajor}.x, got ${protocol_version}`);
            }
            break;
          }

          // Update health monitor to mark container as running
          if (shutdownState.healthMonitor) {
            shutdownState.healthMonitor.recordHeartbeat(tid, []);
          }

          // Mark the team as ready (for create_team polling)
          if (shutdownState.wsServer) {
            shutdownState.wsServer.setReady(tid);
          }

          logger.info('Container ready', { tid, team_id, agent_count, protocol_version });

          // State replay (AC-B5): re-dispatch any tasks that were in-flight when
          // the container disconnected. Query unacknowledged task IDs for this TID,
          // fetch their data from the task store, and re-send task_dispatch messages
          // with a 'retried: true' flag. This allows the container to pick up where
          // it left off without losing in-flight work.
          if (shutdownState.dispatchTracker && shutdownState.stores?.taskStore && shutdownState.wsServer) {
            const unacknowledged = shutdownState.dispatchTracker.getUnacknowledged(tid);
            if (unacknowledged.length > 0) {
              logger.info('Replaying in-flight dispatches after reconnect', {
                tid,
                count: unacknowledged.length,
              });
              for (const taskId of unacknowledged) {
                try {
                  const task = await shutdownState.stores.taskStore.get(taskId);
                  shutdownState.wsServer.send(tid, {
                    type: 'task_dispatch',
                    data: {
                      task_id: task.id,
                      agent_aid: task.agent_aid,
                      prompt: task.prompt,
                      blocked_by: task.blocked_by ?? [],
                      retried: true,
                    },
                  });
                  logger.info('Replayed task dispatch after reconnect', { tid, task_id: taskId });
                } catch (err) {
                  logger.error('Failed to replay task dispatch', {
                    tid,
                    task_id: taskId,
                    error: String(err),
                  });
                }
              }
            }
          }

          break;
        }

        case 'log_event': {
          // Write log events from containers to the log store
          // Protocol: { level: 'debug'|'info'|'warn'|'error', source_aid, message, metadata, timestamp }
          const { level, source_aid, message: logMessage, metadata, timestamp } = message.data as {
            level: 'debug' | 'info' | 'warn' | 'error';
            source_aid: string;
            message: string;
            metadata?: Record<string, unknown>;
            timestamp: string;
          };
          if (shutdownState.stores?.logStore) {
            const team = orgChart.getTeam(tid);
            // Map string level to numeric
            const levelMap: Record<string, number> = { debug: 0, info: 10, warn: 30, error: 40 };
            await shutdownState.stores.logStore.create([{
              id: 0,
              level: (levelMap[level] ?? 10) as LogLevel,
              event_type: 'log_event',
              component: '',
              action: '',
              message: logMessage,
              params: metadata ? JSON.stringify(metadata) : '',
              team_slug: team?.slug ?? '',
              task_id: '',
              agent_aid: source_aid,
              request_id: '',
              correlation_id: '',
              error: '',
              duration_ms: 0,
              created_at: new Date(timestamp).getTime() || Date.now(),
            }]);
          }
          break;
        }

        case 'status_update': {
          // Update agent status in org chart
          const { agent_aid, status, detail } = message.data as {
            agent_aid: string;
            status: string;
            detail?: string;
          };
          logger.info('Agent status update', { agent_aid, status, detail });

          // Update the agent's status in the org chart
          const agent = orgChart.getAgent(agent_aid);
          if (agent) {
            const validStatuses = ['idle', 'busy', 'error', 'starting'] as const;
            const newStatus = validStatuses.includes(status as typeof validStatuses[number])
              ? (status as typeof validStatuses[number])
              : agent.status;
            orgChart.updateAgent({
              ...agent,
              status: newStatus,
            });
          }
          break;
        }

        case 'agent_ready': {
          // Hot-reload acknowledgment for dynamic agent addition
          // Protocol: { aid: string }
          const { aid } = message.data as { aid: string };
          logger.info('Agent ready (hot-reload)', { aid, tid });

          // Update agent status to idle in org chart
          const agent = orgChart.getAgent(aid);
          if (agent) {
            orgChart.updateAgent({
              ...agent,
              status: 'idle',
            });
          }
          break;
        }

        case 'org_chart_update': {
          // Handle topology changes from containers (e.g., sub-team creation, agent addition)
          const { action: updateAction, team_slug, agent_aid } = message.data as {
            action: string;
            team_slug?: string;
            agent_aid?: string;
          };
          logger.info('Org chart update notification', { tid, action: updateAction, team_slug, agent_aid });

          // Handle specific actions
          switch (updateAction) {
            case 'agent_added':
              // Agent was added in container; already handled via agent_added message
              break;
            case 'team_created':
              // Sub-team was created; update org chart if we have team info
              if (team_slug) {
                const childTeam = orgChart.getTeamBySlug(team_slug);
                if (!childTeam) {
                  logger.warn('org_chart_update: team not found for creation', { team_slug });
                }
              }
              break;
            case 'agent_removed':
              // Agent was explicitly removed from a container.
              // Acknowledge its in-flight dispatches so grace-period timers are cleared
              // and the tasks are not replayed to the new container (the agent is gone).
              if (agent_aid) {
                const dt = shutdownState.dispatchTracker;
                if (dt) {
                  const agentTaskIds = dt.getUnacknowledgedByAgent(agent_aid);
                  for (const taskId of agentTaskIds) {
                    dt.acknowledgeDispatch(taskId);
                  }
                  if (agentTaskIds.length > 0) {
                    logger.info('dispatch.clear_on_agent_removed', { agent_aid, cleared: agentTaskIds.length });
                  }
                }
                orgChart.removeAgent(agent_aid);
              }
              break;
            default:
              logger.debug('org_chart_update: unhandled action', { action: updateAction });
          }
          break;
        }

        default:
          logger.debug('Unhandled WS message type', { type: message.type });
      }
    },
    onConnect: async (tid: string, isReconnect: boolean) => {
      logger.info('Container connected', { tid, isReconnect });

      // Reconnecting containers already have their configuration — skip container_init
      // so they don't reset their in-progress agent state (AC-A3).
      if (isReconnect) {
        logger.info('Skipping container_init for reconnecting container', { tid });
        return;
      }

      // Send container_init with resolved secrets templates (AC-L6-11)
      const team = orgChart.getTeam(tid);
      if (!team) {
        logger.warn('Connected team not found in org chart', { tid });
        return;
      }

      try {
        // Load raw team.yaml content for agents and mcp_servers
        const teamYamlPath = resolve(team.workspacePath, 'team.yaml');
        let rawTeamConfig: Record<string, unknown> = {};
        try {
          const yaml = await import('yaml');
          const fs = await import('node:fs/promises');
          const raw = await fs.readFile(teamYamlPath, 'utf-8');
          rawTeamConfig = yaml.parse(raw) as Record<string, unknown>;
        } catch (yamlError) {
          logger.warn('Failed to load team.yaml', { path: teamYamlPath, error: String(yamlError) });
        }

        // Load credentials for this team
        const credentials = await credentialStore.listByTeam(team.slug);
        const secrets: Record<string, string> = {};

        // Decrypt credentials
        for (const cred of credentials) {
          try {
            const decrypted = await keyManager.decrypt(cred.encrypted_value);
            secrets[cred.name] = decrypted;
          } catch (decryptError) {
            logger.warn('Failed to decrypt credential', {
              name: cred.name,
              team: team.slug,
              error: String(decryptError),
            });
          }
        }

        // Resolve {secrets.XXX} templates in MCP servers
        let mcpServers: MCPServerConfig[] | undefined;
        const rawMcpServers = rawTeamConfig['mcp_servers'];
        if (rawMcpServers && Array.isArray(rawMcpServers)) {
          mcpServers = rawMcpServers.map((server: Record<string, unknown>) => ({
            name: String(server['name'] || ''),
            command: String(server['command'] || ''),
            args: (server['args'] as string[]) || [],
            env: resolveSecretsTemplatesInObject(
              (server['env'] as Record<string, string>) || {},
              secrets
            ),
          }));
        }

        // Build agent configs from team config
        const rawAgents = rawTeamConfig['agents'];
        const agents = Array.isArray(rawAgents) ? rawAgents : [];

        // Generate a session token for reconnect authentication (AC-A2).
        // This is a long-lived token delivered via container_init so the container
        // can re-authenticate on reconnect without needing a new one-time token.
        const sessionToken = tokenManager.generateSession(tid);

        // Build container_init message
        const containerInitData = {
          protocol_version: '1.0',
          is_main_assistant: team.slug === 'main',
          team_config: rawTeamConfig as unknown,
          agents: agents.map((a: Record<string, unknown>) => {
            // Resolve the provider preset for this agent (fall back to 'default')
            const resolvedProvider = resolveProviderPreset(String(a['provider'] || 'default'));
            return {
              aid: String(a['aid'] || ''),
              name: String(a['name'] || ''),
              description: String(a['description'] || ''),
              role: String(a['role'] || 'member'),
              model: resolveModel(String(a['model_tier'] || 'sonnet'), resolvedProvider),
              tools: (a['tools'] as string[]) || [],
              provider: resolvedProvider,
              ...(a['system_prompt'] ? { systemPrompt: String(a['system_prompt']) } : {}),
            };
          }),
          secrets,
          mcp_servers: mcpServers,
          session_token: sessionToken,
        };

        // Send container_init via hub
        // NOTE: Do NOT log containerInitData — it contains API keys in each agent's provider field.
        // The log below intentionally omits the payload (AC16).
        const messageStr = JSON.stringify({ type: 'container_init', data: containerInitData });
        wsServer.send(tid, JSON.parse(messageStr));
        logger.info('Sent container_init to team', { tid, team_slug: team.slug, agent_count: agents.length });
      } catch (initError) {
        logger.error('Failed to send container_init', { tid, error: String(initError) });
      }
    },
    onDisconnect: (tid: string) => {
      logger.info('Container disconnected', { tid });
    },
  });
  wsServer.start();
  shutdownState.wsServer = wsServer;

  logger.info('WebSocket hub started');

  // 9. Initialize health monitor
  const healthMonitor = new HealthMonitorImpl(eventBus);
  healthMonitor.start();
  shutdownState.healthMonitor = healthMonitor;

  logger.info('Health monitor started');

  // 10. Initialize container infrastructure
  const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });
  const containerRuntime = new ContainerRuntimeImpl(docker);
  const provisioner = new ContainerProvisionerImpl('/app/workspace');
  // Resolve host workspace path for Docker bind mounts.
  // When running inside a container, Docker needs the host-side path.
  // HOST_PROJECT_DIR is set in deployments/.env for nested-container scenarios.
  const hostProjectDir = process.env['HOST_PROJECT_DIR'] ?? '';
  const hostWorkspaceRoot = hostProjectDir
    ? `${hostProjectDir}/.run/workspace`
    : '/app/workspace';

  const containerManager = new ContainerManagerImpl(
    containerRuntime,
    tokenManager,
    eventBus,
    provisioner,
    {
      image: masterConfig.docker.image,
      network: masterConfig.docker.network,
      workspaceRoot: '/app/workspace',
      hostWorkspaceRoot,
      rootHost: 'openhive-root',
      memoryLimit: masterConfig.docker.resource_limits.max_memory,
      cpuLimit: Math.floor((masterConfig.docker.resource_limits.max_cpus ?? 1) * 100000),
    }
  );

  logger.info('Container manager initialized');

  // 11. Initialize trigger scheduler
  const triggerScheduler = new TriggerSchedulerImpl(
    eventBus,
    async (teamSlug: string, prompt: string, agent?: string) => {
      logger.info('Trigger fired', { team_slug: teamSlug, prompt, agent });

      // Get the team to find its lead
      const team = orgChart.getTeamBySlug(teamSlug);
      if (!team) {
        logger.error('Trigger fired for unknown team', { team_slug: teamSlug });
        return;
      }

      // Use the specified agent AID, or fall back to the team lead (AC-E3)
      const assignedAid = agent ?? team.leaderAid;

      // Generate task ID
      const taskId = `task-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;

      // Create the task
      const task = {
        id: taskId,
        parent_id: '',
        team_slug: teamSlug,
        agent_aid: assignedAid,
        title: `Triggered: ${prompt.slice(0, 50)}...`,
        status: 'pending' as const,
        prompt,
        result: '',
        error: '',
        blocked_by: [],
        priority: 5,
        retry_count: 0,
        max_retries: 3,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      };

      try {
        await taskStore.create(task);
        logger.info('Trigger created task', { task_id: taskId, team_slug: teamSlug });

        // Dispatch via orchestrator if available
        if (shutdownState.orchestrator) {
          await shutdownState.orchestrator.dispatchTask(task);
        }
      } catch (err) {
        logger.error('Failed to create/dispatch trigger task', {
          team_slug: teamSlug,
          error: err instanceof Error ? err.message : String(err),
      });
    }
  },
    masterConfig.triggers,
  );
  await triggerScheduler.loadTriggers();
  triggerScheduler.start();
  shutdownState.triggerScheduler = triggerScheduler;

  logger.info('Trigger scheduler started');

  // 11b. Initialize DispatchTracker (AC-B5 — in-flight task tracking for state replay)
  const dispatchTracker = new DispatchTrackerImpl(eventBus);
  dispatchTracker.start();
  shutdownState.dispatchTracker = dispatchTracker;

  logger.info('Dispatch tracker started');

  // 11c. Initialize WorkspaceLock (AC-D2, AC-D3 — advisory lock for concurrent workspace ops)
  const workspaceLock = new WorkspaceLockImpl();

  logger.info('Workspace lock initialized');

  // 11d. Initialize PluginManager (AC-F1, AC-F3, AC-F5 — log sink plugin hot-reload)
  //
  // Plugins are loaded from <workspacePath>/plugins/sinks/ and added as additional
  // LogSink instances to the logger. Hot-reload via chokidar (CON-04: 500ms debounce).
  // Error boundaries prevent plugin crashes from affecting the host (AC-F2).
  //
  // onSinksChanged keeps the live logger in sync after each hot-reload so that
  // new/changed plugins are immediately active in the logging pipeline (AC-F3).
  // We track which sinks are currently managed by the PluginManager so we can
  // diff against the new set and call addSink/removeSink accordingly.
  let activeManagedSinks: LogSink[] = [];
  const pluginManager = new PluginManagerImpl({
    workspacePath: '/app/workspace',
    logger,
    onSinksChanged: (currentSinks) => {
      // LoggerImpl exposes addSink/removeSink for dynamic sink management (AC-F3).
      const loggerImpl = logger as LoggerImpl;
      // Remove sinks that are no longer in the current set
      for (const old of activeManagedSinks) {
        if (!currentSinks.includes(old)) {
          loggerImpl.removeSink(old);
        }
      }
      // Add sinks that are new
      for (const fresh of currentSinks) {
        if (!activeManagedSinks.includes(fresh)) {
          loggerImpl.addSink(fresh);
        }
      }
      activeManagedSinks = currentSinks.slice();
      logger.info('Plugin sinks updated in logger', { count: currentSinks.length });
    },
  });
  await pluginManager.loadAll();
  // activeManagedSinks is already populated via onSinksChanged called during loadAll
  pluginManager.startWatching();
  shutdownState.pluginManager = pluginManager;

  logger.info('Plugin manager started', { plugins_loaded: activeManagedSinks.length });

  // 12. Initialize MCP registry
  const mcpRegistry = new MCPRegistryImpl();

  logger.info('MCP registry initialized');

  // 13. Initialize agent executor and session manager
  // Tool handlers will be set after orchestrator creates them (see step 14b)
  const agentExecutor = new AgentExecutorImpl(eventBus, logger);
  const sessionManager = new SessionManagerImpl(sessionStore as SessionStore, '/app/workspace');

  logger.info('Agent executor initialized');

  // 14. Initialize orchestrator
  const orchestrator = new OrchestratorImpl({
    configLoader,
    logger,
    database,
    keyManager,
    eventBus,
    orgChart,
    wsServer,
    wsHub: wsServer, // WSServer implements WSHub
    containerManager,
    provisioner,
    healthMonitor,
    triggerScheduler,
    agentExecutor,
    sessionManager,
    dispatchTracker,
    workspaceLock,
    pluginManager,
    stores: {
      taskStore,
      messageStore,
      logStore,
      memoryStore,
      integrationStore,
      credentialStore,
      toolCallStore,
    },
    mcpRegistry,
    limits: masterConfig.limits,
    archiveDir: masterConfig.server.log_archive.archive_dir,
    dataDir: masterConfig.server.data_dir,
  }, true);

  shutdownState.stores = {
    taskStore,
    messageStore,
    logStore,
    memoryStore,
    integrationStore,
    credentialStore,
    toolCallStore,
  };

  await orchestrator.start();
  shutdownState.orchestrator = orchestrator;

  logger.info('Orchestrator started');

  // 14b. Wire tool handlers and task store to agent executor and start main assistant
  const toolHandlers = orchestrator.getToolHandlers();
  if (toolHandlers) {
    agentExecutor.setToolHandlers(toolHandlers);
    logger.info('Tool handlers injected into agent executor', { handlerCount: toolHandlers.size });
  }
  agentExecutor.setTaskStore(taskStore);

  // Wire memory file writer for post-task auto-save to daily logs
  const memoryFileWriter = orchestrator.getMemoryFileWriter();
  if (memoryFileWriter) {
    agentExecutor.setMemoryFileWriter(memoryFileWriter);
  }
  agentExecutor.setMemoryStore(memoryStore);

  // Build AgentInitConfig for the main assistant
  const mainAssistantProvider = resolveProviderPreset(assistantConfig.provider);
  const mainAssistantInitConfig: AgentInitConfig = {
    aid: assistantConfig.aid,
    name: assistantConfig.name,
    description: assistantConfig.name,
    role: 'main_assistant',
    model: resolveModel(assistantConfig.model_tier, mainAssistantProvider),
    modelTier: assistantConfig.model_tier ?? 'sonnet',
    tools: [], // Empty = all tools allowed (main assistant has full access)
    provider: mainAssistantProvider,
  };

  // Write root workspace config so the SDK subprocess knows about MCP tools
  try {
    await mkdir(join('/app/workspace', '.claude'), { recursive: true });
    await writeFile(join('/app/workspace', '.claude', 'CLAUDE.md'), ROOT_WORKSPACE_CLAUDE_MD, 'utf-8');
    // Settings.json: allow all tools (Claude Code permission format)
    await writeFile(join('/app/workspace', '.claude', 'settings.json'), JSON.stringify({
      permissions: {
        allow: [
          'mcp__openhive-tools',
          'Bash',
          'Read',
          'Write',
          'Edit',
        ],
      },
      enableAllProjectMcpServers: true,
    }, null, 2), 'utf-8');
    logger.info('Root workspace CLAUDE.md + settings.json written');
  } catch (err) {
    logger.warn('Failed to write root workspace config', { error: String(err) });
  }

  try {
    await agentExecutor.start(mainAssistantInitConfig, '/app/workspace');
    logger.info('Main assistant started', { aid: mainAssistantInitConfig.aid });
  } catch (err) {
    logger.error('Failed to start main assistant', {
      aid: mainAssistantInitConfig.aid,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // 15. Initialize API server (must be last before channels)
  const apiServer = new APIServer({
    port: listenPort,
    listenAddress: listenHost,
    wsHub: wsServer,
    eventBus,
    orgChart,
    containerManager,
    provisioner,
    healthMonitor,
    triggerScheduler,
    orchestrator,
    taskStore,
    logStore,
    taskEventStore,
    integrationStore,
    credentialStore,
    configLoader,
    logger,
  });
  await apiServer.start();
  shutdownState.apiServer = apiServer;

  logger.info('API server started', {
    host: listenHost,
    port: listenPort,
  });

  // 16. Initialize channel adapters and message router
  // Always create the router — CLI adapter is always available in root mode
  const mainAssistantAid = masterConfig.assistant.aid;
  const llmRouter = new RouterImpl(async (msg) => {
    // Tier 2: LLM-based routing. For now, route everything to main assistant.
    const teams = orgChart.listTeams();
    logger.info('Tier 2 routing: selecting default team', {
      chat_jid: msg.chatJid,
      content_preview: msg.content.slice(0, 50),
      main_assistant_aid: mainAssistantAid,
      available_teams: teams.map(t => t.slug),
    });
    const mainTeam = teams.find(t => t.slug === 'main');
    if (mainTeam) return 'main';
    if (teams.length > 0) return teams[0].slug;
    throw new NotFoundError('No teams available for routing');
  });

  const messageRouter = new MessageRouterImpl(
    messageStore,
    llmRouter,
    orchestrator,
    orgChart
  );
  shutdownState.messageRouter = messageRouter;

  // Wire message router into orchestrator for sendResponse on task completion (AC-G5-02)
  orchestrator.setMessageRouter(messageRouter);

  // Wire message router into API server for /ws/cli endpoint (AC-CLI-04)
  await apiServer.setMessageRouter(messageRouter);

  // 16a. CLI adapter — always enabled in root mode when stdin is TTY
  if (process.stdin.isTTY) {
    const { CLIAdapter } = await import('./channels/cli.js');
    const cliAdapter = new CLIAdapter();
    await cliAdapter.connect();
    messageRouter.registerChannel(ChannelType.Cli, cliAdapter);
    logger.info('CLI channel adapter connected');
  }

  // 16b. Discord adapter — enabled via config
  if (masterConfig.channels.discord.enabled) {
    const discordToken = process.env['DISCORD_BOT_TOKEN'];
    if (discordToken) {
      const discordAdapter = new DiscordAdapter();
      try {
        await discordAdapter.connect();
        messageRouter.registerChannel(ChannelType.Discord, discordAdapter);
        shutdownState.discordAdapter = discordAdapter;
        logger.info('Discord adapter connected');
      } catch (err) {
        logger.error('Failed to connect Discord adapter', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      logger.warn('Discord enabled but DISCORD_BOT_TOKEN not set');
    }
  }

  // 17. Verify main assistant is registered in org chart
  // (Already bootstrapped in step 6 at line ~353. Just verify it exists.)
  const mainTeam = orgChart.getTeamBySlug('main');
  if (!mainTeam) {
    throw new Error('Root team "main" not found in org chart after bootstrap');
  }
  logger.info('Main assistant verified in org chart', { aid: mainAssistantAid, tid: mainTeam.tid });

  logger.info('Root mode initialization complete');
}

/**
 * Initializes non-root (container) mode.
 */
async function initializeNonRootMode(logger: Logger): Promise<void> {
  logger.info('Initializing non-root mode services');

  // 1. Get connection parameters from environment
  const tid = process.env['OPENHIVE_TEAM_TID'];
  const token = process.env['OPENHIVE_WS_TOKEN'];
  const rootHost = process.env['OPENHIVE_ROOT_HOST'] || 'openhive';
  const hubUrl = `ws://${rootHost}:8080`;

  if (!tid || !token) {
    throw new Error('OPENHIVE_TEAM_TID and OPENHIVE_WS_TOKEN are required in non-root mode');
  }

  // 2. Initialize event bus
  const eventBus = new EventBusImpl();
  shutdownState.eventBus = eventBus;

  // 3. Initialize MCP registry
  const mcpRegistry = new MCPRegistryImpl();

  // 4. Initialize agent executor (session manager requires store, use no-op)
  const agentExecutor = new AgentExecutorImpl(eventBus, logger);

  // 5. Initialize org chart (will be populated from container_init)
  const orgChart = new OrgChartImpl();

  // 6. Connect to root WebSocket hub
  const wsConnection = new WSConnectionImpl({
    tid,
    token,
    hubUrl,
  });

  // Note: Message handler is registered by OrchestratorImpl.startNonRoot()
  // to avoid handler overwrite issues. All root-to-container messages are
  // handled by the orchestrator.

  wsConnection.onClose((code, reason) => {
    logger.warn('WebSocket connection closed', { code, reason });
  });

  await wsConnection.connect();
  shutdownState.wsConnection = wsConnection;

  logger.info('Connected to root hub', { tid, hubUrl });

  // 7. Initialize orchestrator (non-root) - sessionManager is optional for non-root
  const orchestrator = new OrchestratorImpl({
    configLoader: new ConfigLoaderImpl(),
    logger,
    eventBus,
    orgChart,
    wsConnection,
    agentExecutor,
    mcpRegistry,
  }, false);

  await orchestrator.start();
  shutdownState.orchestrator = orchestrator;

  logger.info('Non-root mode initialization complete');
}

/**
 * Registers SIGINT and SIGTERM handlers for graceful shutdown.
 */
function registerShutdownHandlers(logger: Logger): void {
  const handler = (signal: string) => {
    if (isShuttingDown) {
      logger.warn('Shutdown already in progress, ignoring signal', { signal });
      return;
    }
    isShuttingDown = true;

    logger.info('Received shutdown signal', { signal });

    gracefulShutdown()
      .then(() => {
        logger.info('Shutdown complete');
        process.exit(0);
      })
      .catch((err) => {
        logger.error('Shutdown failed', { error: String(err) });
        process.exit(1);
      });
  };

  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}

/**
 * Performs graceful shutdown in reverse initialization order.
 */
async function gracefulShutdown(): Promise<void> {
  const logger = shutdownState.logger;

  // Stop triggers
  if (shutdownState.triggerScheduler) {
    logger?.info('Stopping trigger scheduler');
    shutdownState.triggerScheduler.stop();
  }

  // Disconnect channels
  if (shutdownState.discordAdapter) {
    logger?.info('Disconnecting Discord adapter');
    await shutdownState.discordAdapter.disconnect();
  }

  // Stop orchestrator
  if (shutdownState.orchestrator) {
    logger?.info('Stopping orchestrator');
    await shutdownState.orchestrator.stop();
  }

  // Stop health monitor
  if (shutdownState.healthMonitor) {
    logger?.info('Stopping health monitor');
    shutdownState.healthMonitor.stop();
  }

  // Stop API server
  if (shutdownState.apiServer) {
    logger?.info('Stopping API server');
    await shutdownState.apiServer.stop();
  }

  // Close WebSocket
  if (shutdownState.wsServer) {
    logger?.info('Closing WebSocket server');
    await shutdownState.wsServer.close();
  }
  if (shutdownState.wsConnection) {
    logger?.info('Disconnecting WebSocket client');
    await shutdownState.wsConnection.disconnect();
  }

  // Stop token manager
  if (shutdownState.tokenManager) {
    logger?.info('Stopping token manager');
    shutdownState.tokenManager.stopCleanup();
    shutdownState.tokenManager.revokeAll();
  }

  // Close event bus
  if (shutdownState.eventBus) {
    logger?.info('Closing event bus');
    shutdownState.eventBus.close();
  }

  // Close database
  if (shutdownState.database) {
    logger?.info('Closing database');
    await shutdownState.database.close();
  }

  // Lock key manager
  if (shutdownState.keyManager) {
    logger?.info('Locking key manager');
    await shutdownState.keyManager.lock();
  }

  // Stop plugin manager file watcher
  if (shutdownState.pluginManager) {
    logger?.info('Stopping plugin manager');
    shutdownState.pluginManager.stopWatching();
  }

  // Stop config watchers
  if (shutdownState.configLoader) {
    logger?.info('Stopping config watchers');
    shutdownState.configLoader.stopWatching();
  }

  // Flush and stop logger
  if (logger) {
    logger.info('Shutting down logger');
    await logger.stop();
  }
}

// ---------------------------------------------------------------------------
// Entry point — invoke main() when run directly
// ---------------------------------------------------------------------------
main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});