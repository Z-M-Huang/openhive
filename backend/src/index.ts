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

// INV-09: Invariants in code, policies in skills
// INV-10: Root is a control plane

import { ConfigLoaderImpl } from './config/loader.js';
import { LoggerImpl } from './logging/logger.js';
import { StdoutSink } from './logging/sinks.js';

import { createShutdownState } from './init/types.js';
import { parseLogLevel, parseListenAddress } from './init/helpers.js';
import { registerShutdownHandlers } from './init/shutdown.js';
import { initializeRootMode } from './init/root-mode.js';
import { initializeNonRootMode } from './init/non-root-mode.js';

// ---------------------------------------------------------------------------
// Global State (for shutdown handling)
// ---------------------------------------------------------------------------

const shutdownState = createShutdownState();

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
  // Phase 3: Mode-Specific Initialization
  // -------------------------------------------------------------------------

  if (isRoot) {
    await initializeRootMode(configLoader, logger, masterConfig, providers, listenHost, listenPort, shutdownState);
  } else {
    await initializeNonRootMode(logger, shutdownState);
  }

  // -------------------------------------------------------------------------
  // Phase 4: Register Shutdown Handlers
  // -------------------------------------------------------------------------

  registerShutdownHandlers(logger, shutdownState);

  logger.info('OpenHive initialized', { is_root: isRoot });
}

// ---------------------------------------------------------------------------
// Entry point — invoke main() when run directly (not when imported by tests)
// ---------------------------------------------------------------------------
if (import.meta.main) {
  main().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}
