/**
 * Shutdown handler registration and graceful shutdown logic.
 *
 * @module init/shutdown
 */

import type { Logger } from '../domain/interfaces.js';
import type { ShutdownState } from './types.js';

let isShuttingDown = false;

/**
 * Registers SIGINT and SIGTERM handlers for graceful shutdown.
 */
export function registerShutdownHandlers(logger: Logger, state: ShutdownState): void {
  const handler = (signal: string) => {
    if (isShuttingDown) {
      logger.warn('Shutdown already in progress, ignoring signal', { signal });
      return;
    }
    isShuttingDown = true;

    logger.info('Received shutdown signal', { signal });

    gracefulShutdown(state)
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
export async function gracefulShutdown(state: ShutdownState): Promise<void> {
  const logger = state.logger;

  // Brief pause to let any in-flight responses complete
  logger?.info('Draining in-flight tasks');
  await new Promise(resolve => setTimeout(resolve, 2000));
  logger?.info('Task drain complete');

  // Stop triggers
  if (state.triggerScheduler) {
    logger?.info('Stopping trigger scheduler');
    state.triggerScheduler.stop();
  }

  // Disconnect channels
  if (state.discordAdapter) {
    logger?.info('Disconnecting Discord adapter');
    await state.discordAdapter.disconnect();
  }
  if (state.slackAdapter) {
    logger?.info('Disconnecting Slack adapter');
    await state.slackAdapter.disconnect();
  }

  // Stop orchestrator
  if (state.orchestrator) {
    logger?.info('Stopping orchestrator');
    await state.orchestrator.stop();
  }

  // Stop health monitor
  if (state.healthMonitor) {
    logger?.info('Stopping health monitor');
    state.healthMonitor.stop();
  }

  // Stop API server
  if (state.apiServer) {
    logger?.info('Stopping API server');
    await state.apiServer.stop();
  }

  // Close WebSocket
  if (state.wsServer) {
    logger?.info('Closing WebSocket server');
    await state.wsServer.close();
  }
  if (state.wsConnection) {
    logger?.info('Disconnecting WebSocket client');
    await state.wsConnection.disconnect();
  }

  // Stop token manager
  if (state.tokenManager) {
    logger?.info('Stopping token manager');
    state.tokenManager.stopCleanup();
    state.tokenManager.revokeAll();
  }

  // Close event bus
  if (state.eventBus) {
    logger?.info('Closing event bus');
    state.eventBus.close();
  }

  // Close database
  if (state.database) {
    logger?.info('Closing database');
    await state.database.close();
  }

  // Lock key manager
  if (state.keyManager) {
    logger?.info('Locking key manager');
    await state.keyManager.lock();
  }

  // Stop plugin manager file watcher
  if (state.pluginManager) {
    logger?.info('Stopping plugin manager');
    state.pluginManager.stopWatching();
  }

  // Stop config watchers
  if (state.configLoader) {
    logger?.info('Stopping config watchers');
    state.configLoader.stopWatching();
  }

  // Flush and stop logger
  if (logger) {
    logger.info('Shutting down logger');
    await logger.stop();
  }
}
