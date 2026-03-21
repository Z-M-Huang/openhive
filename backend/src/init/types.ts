/**
 * Shutdown state interface for graceful shutdown coordination.
 *
 * @module init/types
 */

import type { ConfigLoaderImpl } from '../config/loader.js';
import type { EventBusImpl } from '../control-plane/event-bus.js';
import type { Database } from '../storage/database.js';
import type { WSServer } from '../websocket/server.js';
import type { WSConnectionImpl } from '../websocket/connection.js';
import type { APIServer } from '../api/server.js';
import type { HealthMonitorImpl } from '../containers/health.js';
import type { DiscordAdapter } from '../channels/discord.js';
import type { MessageRouterImpl } from '../channels/router.js';
import type { TriggerSchedulerImpl } from '../triggers/scheduler.js';
import type { OrchestratorImpl } from '../control-plane/orchestrator.js';
import type { TokenManagerImpl } from '../websocket/token-manager.js';
import type { KeyManagerImpl } from '../security/key-manager.js';
import type { DispatchTrackerImpl } from '../control-plane/dispatch-tracker.js';
import type { PluginManagerImpl } from '../plugins/manager.js';
import type { Logger, TaskStore, MessageStore, LogStore, MemoryStore, IntegrationStore, CredentialStore, ToolCallStore } from '../domain/interfaces.js';

export interface ShutdownState {
  configLoader: ConfigLoaderImpl | null;
  logger: Logger | null;
  eventBus: EventBusImpl | null;
  database: Database | null;
  wsServer: WSServer | null;
  wsConnection: WSConnectionImpl | null;
  apiServer: APIServer | null;
  healthMonitor: HealthMonitorImpl | null;
  discordAdapter: DiscordAdapter | null;
  slackAdapter: import('../channels/slack.js').SlackAdapter | null;
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

export function createShutdownState(): ShutdownState {
  return {
    configLoader: null,
    logger: null,
    eventBus: null,
    database: null,
    wsServer: null,
    wsConnection: null,
    apiServer: null,
    healthMonitor: null,
    discordAdapter: null,
    slackAdapter: null,
    messageRouter: null,
    triggerScheduler: null,
    orchestrator: null,
    tokenManager: null,
    keyManager: null,
    dispatchTracker: null,
    pluginManager: null,
    stores: null,
  };
}
