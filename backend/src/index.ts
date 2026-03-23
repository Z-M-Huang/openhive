/**
 * OpenHive v3 entry point — bootstrap and graceful shutdown.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { createLogger } from './logging/logger.js';
import { loadProviders, loadTriggers } from './config/loader.js';
import { createDatabase, createTables } from './storage/database.js';
import { OrgStore } from './storage/stores/org-store.js';
import { TaskQueueStore } from './storage/stores/task-queue-store.js';
import { TriggerStore } from './storage/stores/trigger-store.js';
import { LogStore } from './storage/stores/log-store.js';
import { EscalationStore } from './storage/stores/escalation-store.js';
import { MemoryStore } from './storage/stores/memory-store.js';
import { OrgTree } from './domain/org-tree.js';
import { createOrgMcpServer } from './org-mcp/server.js';
import type { OrgMcpServer } from './org-mcp/server.js';
import { SessionManager } from './sessions/manager.js';
import { TriggerDedup } from './triggers/dedup.js';
import { TriggerRateLimiter } from './triggers/rate-limiter.js';
import { TriggerEngine } from './triggers/engine.js';
import { CLIAdapter } from './channels/cli-adapter.js';
import { DiscordAdapter } from './channels/discord-adapter.js';
import { SecretString } from './secrets/secret-string.js';
import { ChannelRouter } from './channels/router.js';
import { registerHealthEndpoint } from './health.js';
import type { IChannelAdapter, ChannelMessage } from './domain/interfaces.js';
import type { TriggerConfig } from './domain/types.js';
import type { ProvidersOutput } from './config/validation.js';
import type { Readable, Writable } from 'node:stream';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type pino from 'pino';

export interface BootstrapDeps {
  readonly providersPath?: string;
  readonly dbPath?: string;
  readonly memoryDir?: string;
  readonly listenAddress?: string;
  readonly listenPort?: number;
  readonly cliInput?: Readable;
  readonly cliOutput?: Writable;
  readonly skipCli?: boolean;
  readonly skipListen?: boolean;
}

export interface BootstrapResult {
  readonly logger: pino.Logger;
  readonly raw: Database.Database;
  readonly fastify: FastifyInstance;
  readonly sessionManager: SessionManager;
  readonly triggerEngine: TriggerEngine;
  readonly channelRouter: ChannelRouter;
  readonly orgTree: OrgTree;
  readonly orgMcpServer: OrgMcpServer;
  readonly providersConfig: ProvidersOutput | null;
  shutdown(): Promise<void>;
}

let currentResult: BootstrapResult | null = null;

function initStorage(deps?: BootstrapDeps) {
  const dbPath = deps?.dbPath
    ?? process.env['OPENHIVE_DB_PATH']
    ?? '/data/openhive.db';
  const { db, raw } = createDatabase(dbPath);
  createTables(raw);

  const orgStore = new OrgStore(db);
  const taskQueueStore = new TaskQueueStore(db);
  const triggerStore = new TriggerStore(db);
  const logStore = new LogStore(db);
  const escalationStore = new EscalationStore(db);
  const memoryDir = deps?.memoryDir ?? '/data/memory';
  const memoryStore = new MemoryStore(memoryDir);

  return { db, raw, orgStore, taskQueueStore, triggerStore, logStore, escalationStore, memoryStore };
}

function loadTriggerConfigs(dataDir: string, logger: pino.Logger): TriggerConfig[] {
  const triggersPath = join(dataDir, 'triggers.yaml');
  if (!existsSync(triggersPath)) {
    logger.info('No triggers.yaml found, skipping trigger loading');
    return [];
  }
  try {
    const result = loadTriggers(triggersPath);
    return result.triggers as TriggerConfig[];
  } catch (err) {
    logger.warn({ err }, 'Failed to load triggers.yaml');
    return [];
  }
}

function initTriggerEngine(
  triggerStore: TriggerStore,
  taskQueueStore: TaskQueueStore,
  logger: pino.Logger,
  triggers: TriggerConfig[],
): TriggerEngine {
  const dedup = new TriggerDedup(triggerStore);
  const rateLimiter = new TriggerRateLimiter(10, 60_000);
  const engine = new TriggerEngine({
    triggers,
    dedup,
    rateLimiter,
    delegateTask: (team, task, priority) => {
      taskQueueStore.enqueue(team, task, priority ?? 'normal');
      return Promise.resolve();
    },
    logger: {
      info: (msg, meta) => logger.info(meta ?? {}, msg),
      warn: (msg, meta) => logger.warn(meta ?? {}, msg),
    },
  });
  engine.register();
  return engine;
}

function initChannels(
  deps: BootstrapDeps | undefined,
  logger: pino.Logger,
): IChannelAdapter[] {
  const adapters: IChannelAdapter[] = [];
  if (!deps?.skipCli) {
    adapters.push(new CLIAdapter({
      input: deps?.cliInput,
      output: deps?.cliOutput,
    }));
  }

  // Wire Discord adapter when DISCORD_BOT_TOKEN env var is set
  const discordToken = process.env['DISCORD_BOT_TOKEN'];
  if (discordToken) {
    logger.info('Discord bot token found, wiring Discord adapter');
    adapters.push(new DiscordAdapter({
      token: new SecretString(discordToken),
    }));
  }

  return adapters;
}

export async function bootstrap(deps?: BootstrapDeps): Promise<BootstrapResult> {
  const stores = initStorage(deps);
  const { raw, orgStore, taskQueueStore, escalationStore } = stores;

  const logLevel = process.env['OPENHIVE_LOG_LEVEL'] ?? 'info';
  const logger = createLogger({ level: logLevel, logStore: stores.logStore });

  const providersPath = deps?.providersPath
    ?? process.env['OPENHIVE_PROVIDERS_PATH']
    ?? '/data/providers.yaml';
  let providersConfig: ProvidersOutput | null = null;
  try {
    providersConfig = loadProviders(providersPath);
    logger.info({ profiles: Object.keys(providersConfig.profiles) }, 'Loaded provider profiles');
  } catch {
    logger.warn('No providers.yaml found');
  }

  const orgTree = new OrgTree(orgStore);
  orgTree.loadFromStore();

  const sessionManager = new SessionManager();

  const orgMcpServer = createOrgMcpServer({
    orgTree,
    spawner: {
      spawn: (teamId: string) => {
        sessionManager.spawn(teamId);
        return Promise.resolve(teamId);
      },
    },
    sessionManager: {
      getSession: (sessionId: string) =>
        Promise.resolve(sessionManager.isActive(sessionId) ? { id: sessionId } : null),
      terminateSession: (sessionId: string) => {
        sessionManager.stop(sessionId);
        return Promise.resolve();
      },
    },
    taskQueue: taskQueueStore,
    escalationStore,
    loadConfig: () => ({
      name: 'default', parent: null, description: '', scope: { accepts: [], rejects: [] },
      allowed_tools: [], secret_refs: [], mcp_servers: [], provider_profile: 'default', maxTurns: 50,
    }),
    getTeamConfig: () => undefined,
    log: (msg, meta) => logger.info(meta ?? {}, msg),
  });

  const dataDir = deps?.dbPath
    ? join(deps.dbPath, '..')
    : (process.env['OPENHIVE_DATA_DIR'] ?? '/data');
  const triggerConfigs = loadTriggerConfigs(dataDir, logger);
  const triggerEngine = initTriggerEngine(stores.triggerStore, taskQueueStore, logger, triggerConfigs);
  const adapters = initChannels(deps, logger);
  const channelRouter = new ChannelRouter(adapters, (msg: ChannelMessage) => {
    logger.info({ channelId: msg.channelId, userId: msg.userId }, 'Received message');
    // Forward to trigger engine for keyword/message matching
    triggerEngine.onMessage(msg.content, msg.channelId);
    return Promise.resolve(undefined);
  });

  const fastify = Fastify({ logger: false });
  registerHealthEndpoint(fastify, { raw, sessionManager, triggerEngine, channelRouter });

  triggerEngine.start();
  await channelRouter.start();

  if (!deps?.skipListen) {
    const address = deps?.listenAddress ?? process.env['OPENHIVE_LISTEN_ADDRESS'] ?? '127.0.0.1';
    const port = deps?.listenPort ?? Number(process.env['OPENHIVE_LISTEN_PORT'] ?? '8080');
    await fastify.listen({ host: address, port });
  }

  logger.info('OpenHive v3 started');

  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down...');
    triggerEngine.stop();
    await channelRouter.stop();
    sessionManager.stopAll();
    await fastify.close();
    raw.close();
    logger.info('Shutdown complete');
    currentResult = null;
  };

  const result: BootstrapResult = {
    logger, raw, fastify, sessionManager, triggerEngine, channelRouter, orgTree,
    orgMcpServer, providersConfig, shutdown,
  };
  currentResult = result;
  return result;
}

// Graceful shutdown handlers
const handleSignal = (): void => {
  if (currentResult) {
    void currentResult.shutdown().then(() => process.exit(0));
  } else {
    process.exit(0);
  }
};

process.on('SIGTERM', handleSignal);
process.on('SIGINT', handleSignal);

// Auto-start unless running in test (check multiple indicators)
const isTest = process.env['VITEST'] !== undefined
  || process.env['NODE_ENV'] === 'test'
  || process.env['VITEST_WORKER_ID'] !== undefined;
if (!isTest) {
  bootstrap().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('Fatal: bootstrap failed', err);
    process.exit(1);
  });
}
