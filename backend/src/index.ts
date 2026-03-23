/**
 * OpenHive v3 entry point — bootstrap and graceful shutdown.
 *
 * Three-tier data model:
 *   Tier 1: /app/system-rules/  (baked into image, immutable)
 *   Tier 2: /data/              (admin config + org rules, read-only volume)
 *   Tier 3: .run/               (runtime workspace, writable volume)
 */

import { join } from 'node:path';
import Fastify from 'fastify';
import { createLogger } from './logging/logger.js';
import { existsSync } from 'node:fs';
import { loadProviders, loadTeamConfig } from './config/loader.js';
import { OrgTree } from './domain/org-tree.js';
import { createOrgMcpServer } from './org-mcp/server.js';
import type { OrgMcpServer } from './org-mcp/server.js';
import { SessionManager } from './sessions/manager.js';
import { ChannelRouter } from './channels/router.js';
import { registerHealthEndpoint } from './health.js';
import { registerMessageEndpoint } from './api/message-endpoint.js';
import {
  ensureRunDir, seedOrgRules, initStorage,
  loadTriggerConfigs, initTriggerEngine, initChannels,
} from './bootstrap-helpers.js';
import type { ChannelMessage } from './domain/interfaces.js';
import type { ProvidersOutput } from './config/validation.js';
import type { Readable, Writable } from 'node:stream';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type pino from 'pino';

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
  readonly logger: pino.Logger;
  readonly raw: Database.Database;
  readonly fastify: FastifyInstance;
  readonly sessionManager: SessionManager;
  readonly triggerEngine: ReturnType<typeof initTriggerEngine>;
  readonly channelRouter: ChannelRouter;
  readonly orgTree: OrgTree;
  readonly orgMcpServer: OrgMcpServer;
  readonly providersConfig: ProvidersOutput | null;
  readonly dataDir: string;
  readonly runDir: string;
  readonly systemRulesDir: string;
  shutdown(): Promise<void>;
}

let currentResult: BootstrapResult | null = null;

export async function bootstrap(deps?: BootstrapDeps): Promise<BootstrapResult> {
  const dataDir = deps?.dataDir ?? process.env['OPENHIVE_DATA_DIR'] ?? '/data';
  const runDir = deps?.runDir ?? process.env['OPENHIVE_RUN_DIR'] ?? '/app/.run';
  const systemRulesDir = deps?.systemRulesDir
    ?? process.env['OPENHIVE_SYSTEM_RULES_DIR'] ?? '/app/system-rules';
  const seedRulesDir = deps?.seedRulesDir ?? '/app/seed-rules';

  ensureRunDir(runDir);
  seedOrgRules(dataDir, seedRulesDir);

  const stores = initStorage(dataDir, runDir);
  const { raw, orgStore, taskQueueStore, escalationStore } = stores;

  const logLevel = process.env['OPENHIVE_LOG_LEVEL'] ?? 'info';
  const logger = createLogger({ level: logLevel, logStore: stores.logStore });

  const providersPath = join(dataDir, 'config', 'providers.yaml');
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
    spawner: { spawn: (id: string) => { sessionManager.spawn(id); return Promise.resolve(id); } },
    sessionManager: {
      getSession: (id: string) => Promise.resolve(sessionManager.isActive(id) ? { id } : null),
      terminateSession: (id: string) => { sessionManager.stop(id); return Promise.resolve(); },
    },
    taskQueue: taskQueueStore, escalationStore, runDir,
    loadConfig: (name: string, configPath?: string) => {
      const path = configPath ?? join(runDir, 'teams', name, 'config.yaml');
      return loadTeamConfig(path);
    },
    getTeamConfig: (teamId: string) => {
      const path = join(runDir, 'teams', teamId, 'config.yaml');
      if (!existsSync(path)) return undefined;
      try { return loadTeamConfig(path); } catch { return undefined; }
    },
    log: (msg, meta) => logger.info(meta ?? {}, msg),
  });

  const triggerConfigs = loadTriggerConfigs(runDir, logger);
  const triggerEngine = initTriggerEngine(stores.triggerStore, taskQueueStore, logger, triggerConfigs);
  const adapters = initChannels(
    { dataDir, cliInput: deps?.cliInput, cliOutput: deps?.cliOutput, skipCli: deps?.skipCli },
    logger,
  );
  const channelRouter = new ChannelRouter(adapters, (msg: ChannelMessage) => {
    logger.info({ channelId: msg.channelId, userId: msg.userId }, 'Received message');
    triggerEngine.onMessage(msg.content, msg.channelId);
    return Promise.resolve(undefined);
  });

  const fastify = Fastify({ logger: false });
  registerHealthEndpoint(fastify, { raw, sessionManager, triggerEngine, channelRouter });
  registerMessageEndpoint(fastify, { channelRouter });

  triggerEngine.start();
  await channelRouter.start();

  if (!deps?.skipListen) {
    const address = deps?.listenAddress ?? process.env['OPENHIVE_LISTEN_ADDRESS'] ?? '127.0.0.1';
    const port = deps?.listenPort ?? Number(process.env['OPENHIVE_LISTEN_PORT'] ?? '8080');
    await fastify.listen({ host: address, port });
  }

  logger.info({ dataDir, runDir, systemRulesDir }, 'OpenHive v3 started');

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
    orgMcpServer, providersConfig, dataDir, runDir, systemRulesDir, shutdown,
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
