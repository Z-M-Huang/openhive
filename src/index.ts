/** OpenHive v4 entry point — bootstrap and graceful shutdown. */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import { createLogger, type AppLogger } from './logging/logger.js';
import { loadProviders, loadSystemConfig, getTeamConfig, getOrCreateTeamConfig } from './config/loader.js';
import { OrgTree } from './domain/org-tree.js';
import { createToolInvoker, type OrgToolDeps, type OrgToolInvoker } from './handlers/tool-invoker.js';
import { TeamRegistry } from './sessions/team-registry.js';
import { ChannelRouter } from './channels/router.js';
import { registerHealthEndpoint } from './health.js';
import { WsAdapter } from './channels/ws-adapter.js';
import { DiscordAdapter } from './channels/discord-adapter.js';
import { handleMessage } from './sessions/message-handler.js';
import { TaskConsumer } from './sessions/task-consumer.js';
import { recoverFromCrash } from './recovery/startup-recovery.js';
import {
  ensureRunDir, seedOrgRules, initStorage,
  initTriggerEngine, initChannels, ensureMainTeam, migrateAllowedTools,
  initBrowserRelay, runMemoryMigration,
} from './bootstrap-helpers.js';
import type { TriggerEngine } from './triggers/engine.js';
import type { ChannelMessage } from './domain/interfaces.js';
import { createChannelHandler } from './channel-handler-factory.js';
import { TopicSessionManager } from './sessions/topic-session-manager.js';
import { buildProviderRegistry, resolveModel } from './sessions/provider-registry.js';
import type { ProvidersOutput } from './config/validation.js';
import type { Readable, Writable } from 'node:stream';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
export interface BootstrapDeps {
  readonly dataDir?: string;
  readonly runDir?: string;
  readonly systemRulesDir?: string;
  readonly seedRulesDir?: string;
  readonly listenAddress?: string;
  readonly listenPort?: number;
  readonly cliInput?: Readable;
  readonly cliOutput?: Writable;
  readonly skipCli?: boolean;
  readonly skipListen?: boolean;
}

export interface BootstrapResult {
  readonly logger: AppLogger;
  readonly raw: Database.Database;
  readonly fastify: FastifyInstance;
  readonly sessionManager: TeamRegistry;
  readonly triggerEngine: ReturnType<typeof initTriggerEngine>;
  readonly channelRouter: ChannelRouter;
  readonly orgTree: OrgTree;
  readonly orgToolInvoker: OrgToolInvoker;
  readonly providersConfig: ProvidersOutput | null;
  readonly dataDir: string;
  readonly runDir: string;
  readonly systemRulesDir: string;
  shutdown(): Promise<void>;
}



function resolveLogLevel(dataDir: string): string {
  const path = join(dataDir, 'config', 'config.yaml');
  if (!existsSync(path)) return 'info';
  try { return loadSystemConfig(path).log_level; } catch { return 'info'; }
}

function buildOrgToolDeps(
  opts: {
    orgTree: OrgTree; sessionManager: TeamRegistry;
    taskQueueStore: import('./domain/interfaces.js').ITaskQueueStore;
    escalationStore: import('./domain/interfaces.js').IEscalationStore;
    triggerConfigStore: import('./domain/interfaces.js').ITriggerConfigStore;
    interactionStore: import('./domain/interfaces.js').IInteractionStore;
    memoryStore?: { removeByTeam(teamName: string): void };
    runDir: string; logger: AppLogger;
    browserRelay?: import('./sessions/tools/browser-proxy.js').BrowserRelay;
  },
  getQueryRunner: () => import('./handlers/tool-invoker.js').TeamQueryRunner | undefined,
  getTriggerEngine: () => TriggerEngine | undefined,
): OrgToolDeps {
  return {
    orgTree: opts.orgTree,
    spawner: { spawn: (id: string) => { opts.sessionManager.spawn(id); return Promise.resolve(id); } },
    sessionManager: {
      getSession: (id: string) => Promise.resolve(opts.sessionManager.isActive(id) ? { id } : null),
      terminateSession: (id: string) => { opts.sessionManager.stop(id); return Promise.resolve(); },
    },
    taskQueue: opts.taskQueueStore,
    escalationStore: opts.escalationStore,
    triggerConfigStore: opts.triggerConfigStore,
    interactionStore: opts.interactionStore,
    memoryStore: opts.memoryStore,
    runDir: opts.runDir,
    loadConfig: (name: string, cp?: string, hints?: { description?: string; scopeAccepts?: string[] }) =>
      getOrCreateTeamConfig(opts.runDir, name, cp, hints),
    getTeamConfig: (id: string) => getTeamConfig(opts.runDir, id),
    log: (msg, meta) => opts.logger.info(msg, meta),
    get queryRunner() { return getQueryRunner(); },
    get triggerEngine() { return getTriggerEngine(); },
    get browserRelay() { return opts.browserRelay; },
  };
}

export async function bootstrap(deps?: BootstrapDeps): Promise<BootstrapResult> {
  const dataDir = deps?.dataDir ?? '/data';
  const runDir = deps?.runDir ?? '/app/.run';
  const systemRulesDir = deps?.systemRulesDir ?? '/app/system-rules';
  const seedRulesDir = deps?.seedRulesDir ?? '/app/seed-rules';

  ensureRunDir(runDir);
  seedOrgRules(dataDir, seedRulesDir);

  const stores = initStorage(dataDir, runDir);
  const { raw, orgStore, taskQueueStore, escalationStore } = stores;

  const logLevel = resolveLogLevel(dataDir);
  const logger = createLogger({ level: logLevel, logStore: stores.logStore });

  const providersPath = join(dataDir, 'config', 'providers.yaml');
  let providersConfig: ProvidersOutput | null = null;
  try {
    providersConfig = loadProviders(providersPath);
    logger.info('Loaded provider profiles', { profiles: Object.keys(providersConfig.profiles) });
  } catch {
    logger.warn('No providers.yaml found');
  }

  const orgTree = new OrgTree(orgStore);
  orgTree.loadFromStore();

  const recovery = recoverFromCrash({ orgStore, taskQueueStore, orgTree, runDir, logger, topicStore: stores.topicStore });
  if (recovery.recovered > 0) logger.info('Recovery completed', { recovered: recovery.recovered });

  ensureMainTeam(runDir, orgTree);
  runMemoryMigration(stores.memoryStore, orgTree, runDir, logger);
  migrateAllowedTools(runDir);
  const sessionManager = new TeamRegistry();

  // Browser relay initializes in background — lazy getter defers until ready
  let browserRelayRef: import('./sessions/tools/browser-proxy.js').BrowserRelay | undefined;
  const browserRelayReady = initBrowserRelay(logger).then(r => { browserRelayRef = r; });

  // Lazy refs — break circular dependency between org tools and trigger engine / query runner
  let queryRunnerRef: import('./handlers/tool-invoker.js').TeamQueryRunner | undefined;
  let triggerEngineRef: TriggerEngine | undefined;

  const { triggerConfigStore } = stores;

  const orgToolDeps = buildOrgToolDeps(
    { orgTree, sessionManager, taskQueueStore, escalationStore, triggerConfigStore,
      interactionStore: stores.interactionStore, memoryStore: stores.memoryStore,
      runDir, logger,
      get browserRelay() { return browserRelayRef; } },
    () => queryRunnerRef,
    () => triggerEngineRef,
  );
  // Synchronous invoker for tests and direct tool calls
  const orgToolInvoker = createToolInvoker(orgToolDeps);

  // Notification helper for trigger deactivation
  const notifyTriggerDeactivated = (team: string, triggerName: string, reason: string): void => {
    logger.warn('Trigger auto-disabled', { team, trigger: triggerName, reason });
  };
  const triggerEngine = initTriggerEngine(
    stores.triggerStore, taskQueueStore, logger, triggerConfigStore, notifyTriggerDeactivated,
  );
  triggerEngineRef = triggerEngine;

  const adapters = initChannels(
    { dataDir, cliInput: deps?.cliInput, cliOutput: deps?.cliOutput, skipCli: deps?.skipCli },
    logger,
  );

  const handlerDeps = providersConfig
    ? {
        providers: providersConfig, availableMcpServers: {} as Record<string, unknown>,
        runDir, dataDir, systemRulesDir, orgAncestors: [] as string[], logger,
        interactionStore: stores.interactionStore, orgTree,
        // Org tool context deps for inline builders
        spawner: orgToolDeps.spawner,
        sessionManager: orgToolDeps.sessionManager,
        taskQueue: orgToolDeps.taskQueue,
        escalationStore: orgToolDeps.escalationStore,
        triggerConfigStore: stores.triggerConfigStore,
        get triggerEngine() { return triggerEngineRef; },
        get browserRelay() { return browserRelayRef; },
        get queryRunner() { return queryRunnerRef; },
        loadConfig: orgToolDeps.loadConfig,
        getTeamConfigFn: orgToolDeps.getTeamConfig,
        memoryStore: stores.memoryStore,
      }
    : null;

  // Wire queryRunner: query_team → handleMessage for synchronous child queries
  if (handlerDeps) {
    queryRunnerRef = async (query, team, callerId, ancestors, sourceChannelId) => {
      const result = await handleMessage(
        { channelId: `query:${callerId}:${team}:${Date.now()}`, userId: callerId, content: query, timestamp: Date.now() },
        { ...handlerDeps, orgAncestors: ancestors },
        { teamName: team, sourceChannelId },
      );
      if (!result.ok) throw new Error(result.error ?? 'unknown error');
      return result.content;
    };
  }

  // WsAdapter added to ChannelRouter for sendResponse (notifications), not for message routing.
  // WsAdapter handles its own message flow with progress/ack support.
  const wsAdapter = new WsAdapter();

  let classifierModel: import('ai').LanguageModel | undefined;
  if (providersConfig) try {
    const reg = buildProviderRegistry(providersConfig);
    const dp = providersConfig.profiles['default'];
    if (dp) classifierModel = resolveModel(reg, 'default', dp.model ?? 'claude-sonnet-4-20250514');
  } catch { /* classifier is optional */ }

  const channelHandler = createChannelHandler({
    handlerDeps, triggerEngine, interactionStore: stores.interactionStore,
    topicStore: stores.topicStore, classifierModel, topicSessionManager: new TopicSessionManager(),
  });
  const channelRouter = new ChannelRouter([wsAdapter, ...adapters], async (msg: ChannelMessage) => {
    logger.info('Received message', { channelId: msg.channelId, userId: msg.userId });
    return (await channelHandler(msg)).results.map((r) => r.response).filter(Boolean).join('\n---\n');
  });
  // WS and Discord adapters get channelHandler directly (topic metadata in result)
  wsAdapter.setHandler(channelHandler);
  if (stores.topicStore) {
    const ts = stores.topicStore;
    wsAdapter.setTopicListCallback((chId) =>
      ts.getByChannel(chId).map((t) => ({ id: t.id, name: t.name, state: t.state })));
  }
  for (const a of adapters) { if (a instanceof DiscordAdapter) a.setHandler(channelHandler); }

  const fastify = Fastify({ logger: false });
  await fastify.register(import('@fastify/websocket'));
  registerHealthEndpoint(fastify, { raw, sessionManager, triggerEngine, channelRouter });
  wsAdapter.registerRoute(fastify);

  // Collect Discord adapters for notification routing
  const discordAdapters = adapters.filter(
    (a): a is DiscordAdapter => a instanceof DiscordAdapter,
  );

  const taskConsumer = handlerDeps ? new TaskConsumer({
    taskQueueStore, orgTree, handlerDeps,
    interactionStore: stores.interactionStore,
    notifyChannel: async (content, sourceChannelId) => {
      if (sourceChannelId) {
        // Try router first (works for CLI and any adapter using ChannelRouter flow)
        const sent = await channelRouter.sendResponse(sourceChannelId, content);
        if (sent) return;
        // Router didn't know this channel — route directly to bypass adapters
        // (WS/Discord use setHandler(), so their IDs are never in #channelOwners)
        if (sourceChannelId.startsWith('ws:')) {
          await wsAdapter.sendResponse(sourceChannelId, content);
        } else {
          for (const da of discordAdapters) {
            try { await da.sendResponse(sourceChannelId, content); } catch { /* channel gone */ }
          }
        }
        return;
      }
      // No source channel — this is a bug, every task should have a sourceChannelId
      logger.error('Task notification has no sourceChannelId — cannot route', { contentLength: content.length });
    },
    getTeamConfig: (teamId: string) => getTeamConfig(runDir, teamId),
    reportTriggerOutcome: (team, triggerName, success) => {
      triggerEngine.reportTaskOutcome(team, triggerName, success);
    },
  }) : null;
  taskConsumer?.start(); triggerEngine.start(); await channelRouter.start();

  // Periodic cleanup of old channel interactions (24-hour retention, every 6 hours)
  const interactionCleanupInterval = setInterval(() => {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    try { stores.interactionStore.cleanOlderThan(cutoff); } catch { /* non-critical */ }
  }, 6 * 60 * 60 * 1000);

  if (!deps?.skipListen) {
    await fastify.listen({ host: deps?.listenAddress ?? '0.0.0.0', port: deps?.listenPort ?? 8080 });
  }
  logger.info('OpenHive v4 started — v4.2.1', { dataDir, runDir, systemRulesDir });

  const shutdown = async (): Promise<void> => {
    clearInterval(interactionCleanupInterval);
    taskConsumer?.stop(); triggerEngine.stop();
    await channelRouter.stop(); sessionManager.stopAll();
    await browserRelayReady; await browserRelayRef?.close();
    await fastify.close(); raw.close();
  };

  return {
    logger, raw, fastify, sessionManager, triggerEngine, channelRouter, orgTree,
    orgToolInvoker, providersConfig, dataDir, runDir, systemRulesDir, shutdown,
  };
}
