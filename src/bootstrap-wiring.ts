/** Bootstrap wiring helpers — extracted from index.ts to satisfy max-lines. */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createLogger, type AppLogger } from './logging/logger.js';
import { loadProviders, loadSystemConfig, loadChannels, getTeamConfig, getOrCreateTeamConfig } from './config/loader.js';
import type { TrustPolicy } from './config/trust-policy.js';
import { OrgTree } from './domain/org-tree.js';
import { ConcurrencyManager } from './domain/concurrency-manager.js';
import type { OrgToolDeps } from './handlers/tool-invoker.js';
import { TeamRegistry } from './sessions/team-registry.js';
import { ChannelRouter } from './channels/router.js';
import { registerHealthEndpoint } from './health.js';
import { registerApiRoutes } from './api/routes.js';
import { WsAdapter } from './channels/ws-adapter.js';
import { DiscordAdapter } from './channels/discord-adapter.js';
import type { handleMessage } from './sessions/message-handler.js';
import { TaskConsumer } from './sessions/task-consumer.js';
import { recoverFromCrash } from './recovery/startup-recovery.js';
import { ensureRunDir, ensureRulesDir, initStorage, initTriggerEngine, ensureMainTeam, seedLearningTriggers } from './bootstrap-helpers.js';
import { createChannelHandler } from './channel-handler-factory.js';
import { buildProviderRegistry, resolveModel } from './sessions/provider-registry.js';
import type { TriggerEngine } from './triggers/engine.js';
import type { ChannelMessage } from './domain/interfaces.js';
import type { ProvidersOutput } from './config/validation.js';

export interface BootstrapDeps {
  readonly dataDir?: string;
  readonly runDir?: string;
  readonly systemRulesDir?: string;
  readonly listenAddress?: string;
  readonly listenPort?: number;
  readonly skipListen?: boolean;
}

export interface BootstrapCore {
  dataDir: string; runDir: string; systemRulesDir: string;
  stores: ReturnType<typeof initStorage>;
  logger: AppLogger;
  providersConfig: ProvidersOutput | null;
  trustPolicy: TrustPolicy | undefined;
  orgTree: OrgTree;
  sessionManager: TeamRegistry;
}

export type HandlerDeps = Parameters<typeof handleMessage>[1];

function resolveLogLevel(dataDir: string): string {
  const path = join(dataDir, 'config', 'config.yaml');
  if (!existsSync(path)) return 'info';
  try { return loadSystemConfig(path).log_level; } catch { return 'info'; }
}

function resolveTrustPolicy(dataDir: string, warn: (msg: string) => void): TrustPolicy | undefined {
  const noPolicy = 'No trust policy configured — all senders allowed';
  const path = join(dataDir, 'config', 'channels.yaml');
  if (!existsSync(path)) { warn(noPolicy); return undefined; }
  try { const p = loadChannels(path).trust; if (!p) warn(noPolicy); return p; }
  catch { warn(noPolicy); return undefined; }
}

export function buildOrgToolDeps(
  opts: {
    orgTree: OrgTree; sessionManager: TeamRegistry;
    taskQueueStore: import('./domain/interfaces.js').ITaskQueueStore;
    escalationStore: import('./domain/interfaces.js').IEscalationStore;
    triggerConfigStore: import('./domain/interfaces.js').ITriggerConfigStore;
    interactionStore: import('./domain/interfaces.js').IInteractionStore;
    memoryStore?: { removeByTeam(teamName: string): void };
    senderTrustStore?: import('./domain/interfaces.js').ISenderTrustStore;
    vaultStore?: import('./domain/interfaces.js').IVaultStore;
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
    senderTrustStore: opts.senderTrustStore,
    vaultStore: opts.vaultStore,
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

export function initCore(deps: BootstrapDeps | undefined): BootstrapCore {
  const dataDir = deps?.dataDir ?? '/data';
  const runDir = deps?.runDir ?? '/app/.run';
  const systemRulesDir = deps?.systemRulesDir ?? '/app/system-rules';
  ensureRunDir(runDir);
  ensureRulesDir(dataDir);
  const stores = initStorage(dataDir, runDir);
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

  const trustPolicy = resolveTrustPolicy(dataDir, (m) => logger.warn(m));
  const orgTree = new OrgTree(stores.orgStore);
  orgTree.loadFromStore();
  const recovery = recoverFromCrash({
    orgStore: stores.orgStore, taskQueueStore: stores.taskQueueStore, orgTree, runDir, logger,
    topicStore: stores.topicStore, triggerConfigStore: stores.triggerConfigStore,
  });
  if (recovery.recovered > 0) logger.info('Recovery completed', { recovered: recovery.recovered });
  ensureMainTeam(runDir, orgTree);
  seedLearningTriggers(runDir, stores.triggerConfigStore);
  stores.raw.prepare("DELETE FROM trigger_configs WHERE team = 'main' AND name = 'dead-letter-scan'").run();

  return { dataDir, runDir, systemRulesDir, stores, logger, providersConfig, trustPolicy, orgTree, sessionManager: new TeamRegistry() };
}

export function resolveClassifierModel(providersConfig: ProvidersOutput | null): import('ai').LanguageModel | undefined {
  if (!providersConfig) return undefined;
  try {
    const reg = buildProviderRegistry(providersConfig);
    const dp = providersConfig.profiles['default'];
    if (dp) return resolveModel(reg, 'default', dp.model ?? 'claude-sonnet-4-20250514');
  } catch { /* classifier is optional */ }
  return undefined;
}

export async function wireFastify(opts: {
  raw: Database.Database; sessionManager: TeamRegistry;
  triggerEngine: ReturnType<typeof initTriggerEngine>;
  channelRouter: ChannelRouter;
  orgTree: OrgTree;
  taskQueueStore: import('./domain/interfaces.js').ITaskQueueStore;
  triggerConfigStore: import('./domain/interfaces.js').ITriggerConfigStore;
  pluginToolStore: import('./domain/interfaces.js').IPluginToolStore;
  wsAdapter: WsAdapter | undefined;
}): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  await fastify.register(import('@fastify/websocket'));
  registerHealthEndpoint(fastify, { raw: opts.raw, sessionManager: opts.sessionManager, triggerEngine: opts.triggerEngine, channelRouter: opts.channelRouter });
  registerApiRoutes(fastify, { raw: opts.raw, orgTree: opts.orgTree, taskQueueStore: opts.taskQueueStore, triggerConfigStore: opts.triggerConfigStore, pluginToolStore: opts.pluginToolStore });
  opts.wsAdapter?.registerRoute(fastify);
  const publicDir = fileURLToPath(new URL('../public', import.meta.url));
  await fastify.register((await import('@fastify/static')).default, { root: publicDir, prefix: '/' });
  return fastify;
}

export function buildHandlerDeps(opts: {
  providersConfig: ProvidersOutput | null;
  core: BootstrapCore;
  orgToolDeps: OrgToolDeps;
  triggerEngine: ReturnType<typeof initTriggerEngine>;
  browserRelayRef: { ref: import('./sessions/tools/browser-proxy.js').BrowserRelay | undefined };
  queryRunnerRef: { ref: import('./handlers/tool-invoker.js').TeamQueryRunner | undefined };
  concurrencyManager?: ConcurrencyManager;
}): HandlerDeps | null {
  const { providersConfig, core, orgToolDeps, triggerEngine, browserRelayRef, queryRunnerRef } = opts;
  if (!providersConfig) return null;
  const { stores, orgTree, runDir, dataDir, systemRulesDir, logger } = core;
  // ADR-41: runtime concurrency governance. Callers may inject a shared manager
  // (matching src/index.ts); otherwise we instantiate one with the default cap
  // (5, matching TeamConfigSchema).
  const concurrencyManager = opts.concurrencyManager ?? new ConcurrencyManager({ maxConcurrentDailyOps: 5 });
  return {
    providers: providersConfig,
    runDir, dataDir, systemRulesDir, orgAncestors: [] as string[], logger,
    interactionStore: stores.interactionStore, orgTree,
    spawner: orgToolDeps.spawner, sessionManager: orgToolDeps.sessionManager,
    taskQueue: orgToolDeps.taskQueue, escalationStore: orgToolDeps.escalationStore,
    triggerConfigStore: stores.triggerConfigStore, triggerEngine,
    get browserRelay() { return browserRelayRef.ref; },
    get queryRunner() { return queryRunnerRef.ref; },
    loadConfig: orgToolDeps.loadConfig, getTeamConfigFn: orgToolDeps.getTeamConfig,
    memoryStore: stores.memoryStore, senderTrustStore: stores.senderTrustStore,
    vaultStore: stores.vaultStore, pluginToolStore: stores.pluginToolStore,
    concurrencyManager,
  };
}

export function wireChannels(opts: {
  wsAdapter: WsAdapter | undefined;
  adapters: import('./domain/interfaces.js').IChannelAdapter[];
  channelHandler: ReturnType<typeof createChannelHandler>;
  topicStore: import('./domain/interfaces.js').ITopicStore | undefined;
  logger: AppLogger;
}): ChannelRouter {
  const { wsAdapter, adapters, channelHandler, topicStore, logger } = opts;
  const router = new ChannelRouter([...(wsAdapter ? [wsAdapter] : []), ...adapters], async (msg: ChannelMessage) => {
    logger.info('Received message', { channelId: msg.channelId, userId: msg.userId });
    return (await channelHandler(msg)).results.map((r) => r.response).filter(Boolean).join('\n---\n');
  });
  wsAdapter?.setHandler(channelHandler);
  if (wsAdapter && topicStore) {
    const ts = topicStore;
    wsAdapter.setTopicListCallback((chId) =>
      ts.getByChannel(chId).map((t) => ({ id: t.id, name: t.name, state: t.state })));
  }
  for (const a of adapters) { if (a instanceof DiscordAdapter) a.setHandler(channelHandler); }
  return router;
}

export function buildTaskConsumer(opts: {
  handlerDeps: HandlerDeps | null;
  core: BootstrapCore;
  triggerEngine: ReturnType<typeof initTriggerEngine>;
  channelRouter: ChannelRouter;
  wsAdapter: WsAdapter | undefined;
  discordAdapters: DiscordAdapter[];
}): TaskConsumer | null {
  const { handlerDeps, core, triggerEngine, channelRouter, wsAdapter, discordAdapters } = opts;
  if (!handlerDeps) return null;
  return new TaskConsumer({
    taskQueueStore: core.stores.taskQueueStore, orgTree: core.orgTree, handlerDeps,
    interactionStore: core.stores.interactionStore,
    notifyChannel: async (content, sourceChannelId) => {
      if (sourceChannelId) {
        const sent = await channelRouter.sendResponse(sourceChannelId, content);
        if (sent) return;
        if (sourceChannelId.startsWith('ws:')) {
          if (wsAdapter) await wsAdapter.sendResponse(sourceChannelId, content);
        } else {
          for (const da of discordAdapters) {
            try { await da.sendResponse(sourceChannelId, content); } catch { /* channel gone */ }
          }
        }
        return;
      }
      core.logger.error('Task notification has no sourceChannelId — cannot route', { contentLength: content.length });
    },
    getTeamConfig: (teamId: string) => getTeamConfig(core.runDir, teamId),
    reportTriggerOutcome: (team, triggerName, success, taskId) => {
      triggerEngine.reportTaskOutcome(team, triggerName, success, taskId);
    },
  });
}
