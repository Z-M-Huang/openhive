/**
 * Coordination phase initialization: event bus, org chart, WS server,
 * health monitor, containers, triggers, dispatch tracker, workspace lock, plugins.
 *
 * @module init/phase-coordination
 */

import Dockerode from 'dockerode';

import type { MasterConfig } from '../config/defaults.js';
import type { Logger, LogSink, OrgChartTeam, OrgChartAgent, TaskStore } from '../domain/interfaces.js';
import { LoggerImpl } from '../logging/logger.js';
import { EventBusImpl } from '../control-plane/event-bus.js';
import { OrgChartImpl } from '../control-plane/org-chart.js';
import { WSServer } from '../websocket/server.js';
import { TokenManagerImpl } from '../websocket/token-manager.js';
import { HealthMonitorImpl } from '../containers/health.js';
import { TriggerSchedulerImpl } from '../triggers/scheduler.js';
import { DispatchTrackerImpl } from '../control-plane/dispatch-tracker.js';
import { ContainerRuntimeImpl } from '../containers/runtime.js';
import { ContainerManagerImpl } from '../containers/manager.js';
import { ContainerProvisionerImpl } from '../containers/provisioner.js';
import { WorkspaceLockImpl } from '../control-plane/workspace-lock.js';
import { PluginManagerImpl } from '../plugins/manager.js';

import type { ShutdownState } from './types.js';
import type { PersistenceResult } from './phase-persistence.js';
import { parseDurationMs, createProviderResolver } from './helpers.js';
import { createOnMessageHandler, createOnConnectHandler, createOnDisconnectHandler } from './ws-handlers.js';

/** Result of coordination phase initialization. */
export interface CoordinationResult {
  eventBus: EventBusImpl;
  orgChart: OrgChartImpl;
  wsServer: WSServer;
  tokenManager: TokenManagerImpl;
  healthMonitor: HealthMonitorImpl;
  containerManager: ContainerManagerImpl;
  provisioner: ContainerProvisionerImpl;
  triggerScheduler: TriggerSchedulerImpl;
  dispatchTracker: DispatchTrackerImpl;
  workspaceLock: WorkspaceLockImpl;
  pluginManager: PluginManagerImpl;
  resolveProviderPreset: ReturnType<typeof createProviderResolver>['resolveProviderPreset'];
  resolveModel: ReturnType<typeof createProviderResolver>['resolveModel'];
}

/**
 * Initializes event bus, org chart, WS server (with forward-ref patching),
 * health monitor, container infrastructure, triggers, dispatch tracker,
 * workspace lock, and plugin manager.
 */
export async function initCoordination(
  masterConfig: MasterConfig,
  providers: Record<string, unknown>,
  logger: Logger,
  shutdownState: ShutdownState,
  persistence: PersistenceResult,
): Promise<CoordinationResult> {
  // 5. Initialize event bus
  const eventBus = new EventBusImpl();
  shutdownState.eventBus = eventBus;
  logger.info('Event bus started');

  // 6. Build org chart from config
  const orgChart = new OrgChartImpl();
  const assistantConfig = masterConfig.assistant;
  const rootTeamTid = `tid-main-${Date.now().toString(16)}`;

  const rootTeam: OrgChartTeam = {
    tid: rootTeamTid,
    slug: 'main',
    parentTid: '',
    depth: 0,
    containerId: 'root',
    health: 'running',
    agentAids: [assistantConfig.aid],
    workspacePath: '/app/workspace',
  };

  // Add root team directly to internal maps (bypasses addTeam for bootstrap)
  (orgChart as unknown as { teamsByTid: Map<string, OrgChartTeam> }).teamsByTid.set(rootTeamTid, rootTeam);
  (orgChart as unknown as { teamsBySlug: Map<string, OrgChartTeam> }).teamsBySlug.set(rootTeam.slug, rootTeam);
  (orgChart as unknown as { agentsByTeam: Map<string, Set<string>> }).agentsByTeam.set(rootTeam.slug, new Set([assistantConfig.aid]));

  const mainAssistant: OrgChartAgent = {
    aid: assistantConfig.aid,
    name: assistantConfig.name,
    teamSlug: 'main',
    role: 'main_assistant',
    status: 'idle',
  };
  (orgChart as unknown as { agentsByAid: Map<string, OrgChartAgent> }).agentsByAid.set(mainAssistant.aid, mainAssistant);

  logger.info('Org chart initialized', {
    root_tid: rootTeamTid,
    main_assistant: assistantConfig.aid,
  });

  // 7. Initialize token manager (wire token_ttl from config)
  const tokenTtlMs = parseDurationMs(masterConfig.security.token_ttl, 300_000);
  const tokenManager = new TokenManagerImpl({ ttlMs: tokenTtlMs });
  tokenManager.startCleanup(60_000);
  shutdownState.tokenManager = tokenManager;
  logger.info('Token manager started');

  // Provider resolution helpers
  const { resolveProviderPreset, resolveModel } = createProviderResolver(providers);

  // 8. Initialize WebSocket server with handler factories
  const wsHandlerDeps = {
    logger,
    shutdownState,
    orgChart,
    wsServer: null as unknown as WSServer, // set after construction
    tokenManager,
    credentialStore: persistence.credentialStore,
    resolveProviderPreset,
    resolveModel,
  };

  const wsServer = new WSServer(tokenManager, {
    onMessage: createOnMessageHandler(wsHandlerDeps),
    onConnect: createOnConnectHandler(wsHandlerDeps),
    onDisconnect: createOnDisconnectHandler(wsHandlerDeps),
  });

  // Patch wsServer reference into deps (circular: handlers need wsServer, wsServer needs handlers)
  wsHandlerDeps.wsServer = wsServer;

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
    async (teamSlug: string, prompt: string, agent?: string, replyTo?: string) => {
      logger.info('Trigger fired', { team_slug: teamSlug, prompt, agent });

      const team = orgChart.getTeamBySlug(teamSlug);
      if (!team) {
        logger.error('Trigger fired for unknown team', { team_slug: teamSlug });
        return;
      }

      let assignedAid = agent ?? '';
      if (!assignedAid) {
        try {
          assignedAid = orgChart.getDispatchTarget(teamSlug).aid;
        } catch {
          logger.error('No dispatch target for trigger team', { team_slug: teamSlug });
          return;
        }
      }

      const taskId = `task-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
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
        origin_chat_jid: replyTo ?? null,
      };

      try {
        await (persistence.taskStore as TaskStore).create(task);
        logger.info('Trigger created task', { task_id: taskId, team_slug: teamSlug });

        // Dispatch via orchestrator if available (forward-ref: captured lazily)
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

  // 11b. Initialize DispatchTracker (AC-B5)
  const dispatchTracker = new DispatchTrackerImpl(eventBus);
  dispatchTracker.start();
  shutdownState.dispatchTracker = dispatchTracker;
  logger.info('Dispatch tracker started');

  // 11c. Initialize WorkspaceLock (AC-D2, AC-D3)
  const workspaceLock = new WorkspaceLockImpl();
  logger.info('Workspace lock initialized');

  // 11d. Initialize PluginManager (AC-F1, AC-F3, AC-F5)
  let activeManagedSinks: LogSink[] = [];
  const pluginManager = new PluginManagerImpl({
    workspacePath: '/app/workspace',
    logger,
    onSinksChanged: (currentSinks) => {
      const loggerImpl = logger as LoggerImpl;
      for (const old of activeManagedSinks) {
        if (!currentSinks.includes(old)) {
          loggerImpl.removeSink(old);
        }
      }
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
  pluginManager.startWatching();
  shutdownState.pluginManager = pluginManager;
  logger.info('Plugin manager started', { plugins_loaded: activeManagedSinks.length });

  return {
    eventBus,
    orgChart,
    wsServer,
    tokenManager,
    healthMonitor,
    containerManager,
    provisioner,
    triggerScheduler,
    dispatchTracker,
    workspaceLock,
    pluginManager,
    resolveProviderPreset,
    resolveModel,
  };
}
