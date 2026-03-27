/**
 * OpenHive v3 entry point — bootstrap and graceful shutdown.
 *
 * Three-tier data model:
 *   Tier 1: /app/system-rules/  (baked into image, immutable)
 *   Tier 2: /data/              (admin config + org rules, read-only volume)
 *   Tier 3: .run/               (runtime workspace, writable volume)
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import { createLogger, type AppLogger } from './logging/logger.js';
import { loadProviders, loadTeamConfig, loadSystemConfig } from './config/loader.js';
import { OrgTree } from './domain/org-tree.js';
import { startOrgMcpHttpServer } from './org-mcp/http-server.js';
import { createToolInvoker, type OrgMcpDeps, type OrgToolInvoker } from './org-mcp/registry.js';
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
  initTriggerEngine, initChannels, ensureMainTeam,
} from './bootstrap-helpers.js';
import type { TriggerEngine } from './triggers/engine.js';
import type { ChannelMessage } from './domain/interfaces.js';
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
  readonly orgMcpPort?: number;
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


function loadOrGenerateConfig(
  runDir: string, name: string, configPath?: string,
  hints?: { description?: string; scopeAccepts?: string[]; parent?: string },
) {
  if (configPath) return loadTeamConfig(configPath);
  const path = join(runDir, 'teams', name, 'config.yaml');
  if (existsSync(path)) return loadTeamConfig(path);
  return {
    name, parent: hints?.parent ?? null, description: hints?.description ?? '',
    allowed_tools: ['*'],
    mcp_servers: ['org'], provider_profile: 'default', maxTurns: 100,
  };
}

function safeLoadConfig(runDir: string, teamId: string) {
  const path = join(runDir, 'teams', teamId, 'config.yaml');
  if (!existsSync(path)) return undefined;
  try { return loadTeamConfig(path); } catch { return undefined; }
}

function resolveLogLevel(dataDir: string): string {
  const path = join(dataDir, 'config', 'config.yaml');
  if (!existsSync(path)) return 'info';
  try { return loadSystemConfig(path).log_level; } catch { return 'info'; }
}

function buildOrgMcpDeps(
  opts: {
    orgTree: OrgTree; sessionManager: TeamRegistry;
    taskQueueStore: import('./domain/interfaces.js').ITaskQueueStore;
    escalationStore: import('./domain/interfaces.js').IEscalationStore;
    triggerConfigStore: import('./domain/interfaces.js').ITriggerConfigStore;
    runDir: string; logger: AppLogger;
  },
  getQueryRunner: () => import('./org-mcp/registry.js').TeamQueryRunner | undefined,
  getTriggerEngine: () => TriggerEngine | undefined,
): OrgMcpDeps {
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
    runDir: opts.runDir,
    loadConfig: (name: string, cp?: string, hints?: { description?: string; scopeAccepts?: string[] }) =>
      loadOrGenerateConfig(opts.runDir, name, cp, hints),
    getTeamConfig: (id: string) => safeLoadConfig(opts.runDir, id),
    log: (msg, meta) => opts.logger.info(msg, meta),
    get queryRunner() { return getQueryRunner(); },
    get triggerEngine() { return getTriggerEngine(); },
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

  const recovery = recoverFromCrash({ orgStore, taskQueueStore, orgTree, runDir, logger });
  if (recovery.recovered > 0) logger.info('Recovery completed', { recovered: recovery.recovered });

  ensureMainTeam(runDir, orgTree);
  const sessionManager = new TeamRegistry();

  // Lazy refs — break circular dependency between org-MCP and trigger engine / query runner
  let queryRunnerRef: import('./org-mcp/registry.js').TeamQueryRunner | undefined;
  let triggerEngineRef: TriggerEngine | undefined;

  const { triggerConfigStore } = stores;

  const orgMcpDeps = buildOrgMcpDeps(
    { orgTree, sessionManager, taskQueueStore, escalationStore, triggerConfigStore, runDir, logger },
    () => queryRunnerRef,
    () => triggerEngineRef,
  );
  const orgMcpHttpServer = await startOrgMcpHttpServer(orgMcpDeps, deps?.orgMcpPort ?? 3001);
  const orgMcpPort = orgMcpHttpServer.port;

  // Synchronous invoker for tests and direct tool calls
  const orgToolInvoker = createToolInvoker(orgMcpDeps);

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
    ? { providers: providersConfig, orgMcpPort, availableMcpServers: {}, runDir, dataDir, systemRulesDir, orgAncestors: [] as string[], logger }
    : null;

  // Wire queryRunner: query_team → handleMessage for synchronous child queries
  if (handlerDeps) {
    queryRunnerRef = async (query, team, callerId, ancestors) => {
      const result = await handleMessage(
        { channelId: `query:${callerId}:${team}:${Date.now()}`, userId: callerId, content: query, timestamp: Date.now() },
        { ...handlerDeps, orgAncestors: ancestors },
        { teamName: team },
      );
      if (!result.ok) throw new Error(result.error ?? 'unknown error');
      return result.content;
    };
  }

  // WsAdapter added to ChannelRouter for sendResponse (notifications), not for message routing.
  // WsAdapter handles its own message flow with progress/ack support.
  const wsAdapter = new WsAdapter();

  const channelRouter = new ChannelRouter([wsAdapter, ...adapters], async (msg: ChannelMessage) => {
    logger.info('Received message', { channelId: msg.channelId, userId: msg.userId });
    triggerEngine.onMessage(msg.content, msg.channelId);
    if (!handlerDeps) return 'No providers configured.';
    const result = await handleMessage(msg, handlerDeps);
    return result.ok ? (result.content ?? '') : `Error: ${result.error}`;
  });

  // Set WS-specific handler with progress support (bypasses ChannelRouter for incoming messages)
  wsAdapter.setHandler(async (msg, onProgress) => {
    triggerEngine.onMessage(msg.content, msg.channelId);
    if (!handlerDeps) return 'No providers configured.';
    const result = await handleMessage(msg, handlerDeps, { onProgress });
    return result.ok ? (result.content ?? '') : `Error: ${result.error}`;
  });

  // Wire Discord adapters with progress support (same pattern as WsAdapter)
  for (const adapter of adapters) {
    if (adapter instanceof DiscordAdapter) {
      adapter.setHandler(async (msg, onProgress) => {
        triggerEngine.onMessage(msg.content, msg.channelId);
        if (!handlerDeps) return 'No providers configured.';
        const result = await handleMessage(msg, handlerDeps, { onProgress });
        return result.ok ? (result.content ?? '') : `Error: ${result.error}`;
      });
    }
  }

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
    notifyChannel: async (content) => {
      for (const chId of wsAdapter.getConnectedChannelIds()) {
        await wsAdapter.sendResponse(chId, content);
      }
      for (const da of discordAdapters) {
        for (const chId of da.getNotifyChannelIds()) {
          try { await da.sendResponse(chId, content); } catch { /* channel gone */ }
        }
      }
    },
    getTeamConfig: (teamId: string) => safeLoadConfig(runDir, teamId),
    reportTriggerOutcome: (team, triggerName, success) => {
      triggerEngine.reportTaskOutcome(team, triggerName, success);
    },
  }) : null;
  taskConsumer?.start(); triggerEngine.start(); await channelRouter.start();

  if (!deps?.skipListen) {
    await fastify.listen({ host: deps?.listenAddress ?? '0.0.0.0', port: deps?.listenPort ?? 8080 });
  }
  logger.info('OpenHive v3 started', { dataDir, runDir, systemRulesDir });

  const shutdown = async (): Promise<void> => {
    taskConsumer?.stop(); triggerEngine.stop();
    await channelRouter.stop(); sessionManager.stopAll();
    orgMcpHttpServer.close();
    await fastify.close(); raw.close();
  };

  const result: BootstrapResult = {
    logger, raw, fastify, sessionManager, triggerEngine, channelRouter, orgTree,
    orgToolInvoker, providersConfig, dataDir, runDir, systemRulesDir, shutdown,
  };
  return result;
}
