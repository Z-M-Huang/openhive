/**
 * Root-mode initialization.
 *
 * Coordinates three phases: persistence, coordination, and service wiring
 * (orchestrator, executor, API, channels).
 *
 * @module init/root-mode
 */

import { join } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';

import { ConfigLoaderImpl } from '../config/loader.js';
import { OrchestratorImpl } from '../control-plane/orchestrator.js';
import { RouterImpl } from '../control-plane/router.js';
import { AgentExecutorImpl } from '../executor/executor.js';
import { SessionManagerImpl } from '../executor/session.js';
import { MCPRegistryImpl } from '../mcp/registry.js';
import { APIServer } from '../api/server.js';
import { MessageRouterImpl } from '../channels/router.js';
import { NotFoundError } from '../domain/errors.js';
import type { Logger, SessionStore, AgentInitConfig } from '../domain/interfaces.js';

import type { ShutdownState } from './types.js';
import { ROOT_WORKSPACE_CLAUDE_MD } from './helpers.js';
import { initializeChannelAdapters } from './channel-adapters.js';
import { initPersistence } from './phase-persistence.js';
import { initCoordination } from './phase-coordination.js';

// ---------------------------------------------------------------------------
// Root-mode initialization
// ---------------------------------------------------------------------------

/**
 * Initializes all root-only services.
 */
export async function initializeRootMode(
  configLoader: ConfigLoaderImpl,
  logger: Logger,
  masterConfig: Awaited<ReturnType<ConfigLoaderImpl['loadMaster']>>,
  providers: Record<string, unknown>,
  listenHost: string,
  listenPort: number,
  shutdownState: ShutdownState,
): Promise<void> {
  logger.info('Initializing root mode services');

  // Phase 1: Persistence — database, key manager, stores, SQLite sink
  const persistence = await initPersistence(masterConfig, logger, shutdownState);

  // Phase 2: Coordination — event bus, org chart, WS server, health, containers, triggers, plugins
  const coordination = await initCoordination(masterConfig, providers, logger, shutdownState, persistence);

  // 12. Initialize MCP registry
  const mcpRegistry = new MCPRegistryImpl();
  logger.info('MCP registry initialized');

  // 13. Initialize agent executor and session manager
  const agentExecutor = new AgentExecutorImpl(coordination.eventBus, logger);
  const sessionManager = new SessionManagerImpl(persistence.sessionStore as SessionStore, '/app/workspace');
  logger.info('Agent executor initialized');

  // 14. Initialize orchestrator
  const orchestrator = new OrchestratorImpl({
    configLoader,
    logger,
    database: persistence.database,
    keyManager: persistence.keyManager,
    eventBus: coordination.eventBus,
    orgChart: coordination.orgChart,
    wsServer: coordination.wsServer,
    wsHub: coordination.wsServer,
    containerManager: coordination.containerManager,
    provisioner: coordination.provisioner,
    healthMonitor: coordination.healthMonitor,
    triggerScheduler: coordination.triggerScheduler,
    agentExecutor,
    sessionManager,
    dispatchTracker: coordination.dispatchTracker,
    workspaceLock: coordination.workspaceLock,
    pluginManager: coordination.pluginManager,
    stores: {
      taskStore: persistence.taskStore,
      messageStore: persistence.messageStore,
      logStore: persistence.logStore,
      memoryStore: persistence.memoryStore,
      integrationStore: persistence.integrationStore,
      credentialStore: persistence.credentialStore,
      toolCallStore: persistence.toolCallStore,
    },
    mcpRegistry,
    limits: masterConfig.limits,
    archiveDir: masterConfig.server.log_archive.archive_dir,
    dataDir: masterConfig.server.data_dir,
    skillRegistries: masterConfig.skill_registries,
    resolveProviderPreset: coordination.resolveProviderPreset,
  }, true);

  shutdownState.stores = {
    taskStore: persistence.taskStore,
    messageStore: persistence.messageStore,
    logStore: persistence.logStore,
    memoryStore: persistence.memoryStore,
    integrationStore: persistence.integrationStore,
    credentialStore: persistence.credentialStore,
    toolCallStore: persistence.toolCallStore,
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
  agentExecutor.setTaskStore(persistence.taskStore);

  // Wire memory file writer for post-task auto-save to daily logs
  const memoryFileWriter = orchestrator.getMemoryFileWriter();
  if (memoryFileWriter) {
    agentExecutor.setMemoryFileWriter(memoryFileWriter);
  }
  agentExecutor.setMemoryStore(persistence.memoryStore);
  agentExecutor.setToolCallStores(persistence.logStore, persistence.toolCallStore);

  // Build AgentInitConfig for the main assistant
  const assistantConfig = masterConfig.assistant;
  const mainAssistantProvider = coordination.resolveProviderPreset(assistantConfig.provider);

  // Default system prompt for root team.yaml
  const defaultRootSystemPrompt = `You are ${assistantConfig.name}, the primary AI assistant for the OpenHive platform. You manage teams of specialized AI agents, handle user requests, and orchestrate complex tasks. Always identify yourself as ${assistantConfig.name} — never as "Claude", "Claude Code", or any other identity.

## Credential Management

When setting up teams that need API keys or secrets:
- Use \`set_credential\` with \`team_slug\` to store credentials for the target team BEFORE creating agents that need them.
- Agents retrieve their own team's credentials via \`get_credential\`.
- Never embed API keys in agent descriptions — use \`set_credential\` / \`get_credential\` instead.

## Agent Descriptions

When creating agents with \`create_agent\`, the description becomes the agent's system prompt. Include:
- Full job description and workflow steps
- API endpoints and entity IDs (credentials via get_credential, not hardcoded)
- Decision rules, thresholds, and error handling
- Expected output format

## Trigger Notifications

When registering triggers with \`register_trigger\`, pass \`reply_to\` with the current channel JID so results are sent back to the conversation.`;

  // Write root workspace config so the SDK subprocess knows about MCP tools
  try {
    await mkdir(join('/app/workspace', '.claude'), { recursive: true });
    await writeFile(join('/app/workspace', '.claude', 'CLAUDE.md'), ROOT_WORKSPACE_CLAUDE_MD, 'utf-8');
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

    // Generate root team.yaml (H2 — recursive design: root has team.yaml like every container)
    const rootTeamYaml = {
      slug: 'main',
      coordinator_aid: assistantConfig.aid,
      system_prompt: defaultRootSystemPrompt,
      agents: [{
        aid: assistantConfig.aid,
        name: assistantConfig.name,
        role: 'main_assistant',
        model_tier: assistantConfig.model_tier ?? 'sonnet',
        provider: assistantConfig.provider ?? 'default',
      }],
    };
    await writeFile(join('/app/workspace', 'team.yaml'), yamlStringify(rootTeamYaml), 'utf-8');

    logger.info('Root workspace CLAUDE.md + settings.json + team.yaml written');
  } catch (err) {
    logger.warn('Failed to write root workspace config', { error: String(err) });
  }

  // Read system_prompt from generated team.yaml (single source of truth)
  let rootSystemPrompt = defaultRootSystemPrompt;
  try {
    const rootTeamConfig = yamlParse(await readFile(join('/app/workspace', 'team.yaml'), 'utf-8')) as Record<string, unknown>;
    if (rootTeamConfig['system_prompt']) {
      rootSystemPrompt = String(rootTeamConfig['system_prompt']);
    }
  } catch {
    // Fall back to default if team.yaml read fails
  }

  const mainAssistantInitConfig: AgentInitConfig = {
    aid: assistantConfig.aid,
    name: assistantConfig.name,
    description: assistantConfig.name,
    role: 'main_assistant',
    model: coordination.resolveModel(assistantConfig.model_tier, mainAssistantProvider),
    modelTier: assistantConfig.model_tier ?? 'sonnet',
    tools: [],
    provider: mainAssistantProvider,
    systemPrompt: rootSystemPrompt,
  };

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
    allowedOrigins: masterConfig.security.allowed_origins,
    wsHub: coordination.wsServer,
    eventBus: coordination.eventBus,
    orgChart: coordination.orgChart,
    containerManager: coordination.containerManager,
    provisioner: coordination.provisioner,
    healthMonitor: coordination.healthMonitor,
    triggerScheduler: coordination.triggerScheduler,
    orchestrator,
    taskStore: persistence.taskStore,
    logStore: persistence.logStore,
    taskEventStore: persistence.taskEventStore,
    integrationStore: persistence.integrationStore,
    credentialStore: persistence.credentialStore,
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
  const mainAssistantAid = masterConfig.assistant.aid;
  const llmRouter = new RouterImpl(async (msg) => {
    const teams = coordination.orgChart.listTeams();
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
    persistence.messageStore,
    llmRouter,
    orchestrator,
    coordination.orgChart
  );
  shutdownState.messageRouter = messageRouter;

  // Wire message router into orchestrator for sendResponse on task completion (AC-G5-02)
  orchestrator.setMessageRouter(messageRouter);

  // Wire message router into API server for /ws/cli endpoint (AC-CLI-04)
  await apiServer.setMessageRouter(messageRouter);

  // Initialize channel adapters (CLI, Discord, Slack)
  await initializeChannelAdapters(messageRouter, masterConfig, logger, shutdownState);

  // 17. Verify main assistant is registered in org chart
  const mainTeam = coordination.orgChart.getTeamBySlug('main');
  if (!mainTeam) {
    throw new Error('Root team "main" not found in org chart after bootstrap');
  }
  logger.info('Main assistant verified in org chart', { aid: mainAssistantAid, tid: mainTeam.tid });

  logger.info('Root mode initialization complete');
}
