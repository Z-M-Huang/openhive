import type {
  Orchestrator,
  Logger,
  EventBus,
  OrgChart,
  WSHub,
  WSConnection,
  TaskStore,
  MessageStore,
  LogStore,
  MemoryStore,
  IntegrationStore,
  CredentialStore,
  ToolCallStore,
  ContainerManager,
  ContainerProvisioner,
  HealthMonitor,
  TriggerScheduler,
  AgentExecutor,
  SessionManager,
  ConfigLoader,
  KeyManager,
  MCPRegistry,
  AgentInitConfig,
  BusEvent,
  ResolvedProvider,
} from '../domain/interfaces.js';
import type { Task } from '../domain/domain.js';
import type { TaskStatus, EscalationReason, AgentStatus } from '../domain/enums.js';
import { TaskStatus as TS } from '../domain/enums.js';
import { ValidationError } from '../domain/errors.js';
import { ToolCallDispatcher } from './tool-call-dispatcher.js';
import { TaskDAGManager } from './task-dag-manager.js';
import { EscalationRouter } from './escalation-router.js';
import { ProactiveScheduler } from './proactive-scheduler.js';
import { RetentionWorker } from './retention-worker.js';
import { createToolHandlers, type ToolContext } from '../mcp/tools/index.js';

/** All store interfaces combined for convenience. */
export interface AllStores {
  taskStore: TaskStore;
  messageStore: MessageStore;
  logStore: LogStore;
  memoryStore: MemoryStore;
  integrationStore: IntegrationStore;
  credentialStore: CredentialStore;
  toolCallStore: ToolCallStore;
}

/** Dependencies for OrchestratorImpl. */
export interface OrchestratorDeps {
  configLoader: ConfigLoader;
  logger: Logger;
  database?: unknown; // root only - Database type not needed here
  keyManager?: KeyManager; // root only
  eventBus: EventBus;
  orgChart: OrgChart;
  wsServer?: unknown; // root only - WSServer type
  wsConnection?: WSConnection; // non-root only
  wsHub?: WSHub; // root only
  containerManager?: ContainerManager; // root only
  provisioner?: ContainerProvisioner; // root only
  healthMonitor?: HealthMonitor; // root only
  triggerScheduler?: TriggerScheduler; // root only
  router?: unknown; // root only - Router type
  agentExecutor: AgentExecutor;
  sessionManager?: SessionManager; // optional - not used directly by orchestrator
  stores?: AllStores; // root only
  mcpRegistry: MCPRegistry;
  /** Configurable limits from master config (CON-01, CON-02, CON-03). Frozen in ToolContext. */
  limits?: {
    max_depth: number;
    max_teams: number;
    max_agents_per_team: number;
    max_concurrent_tasks: number;
  };
  /** Directory to write gzip-compressed NDJSON log archives (AC21). */
  archiveDir?: string;
  /** Base data directory used to validate archiveDir is within bounds (AC22). */
  dataDir?: string;
}

/**
 * Unified orchestrator — thin coordinator that delegates to 5 collaborators.
 *
 * User Decision #2: Orchestrator is now a thin coordinator. It wires and delegates to:
 * - ToolCallDispatcher (tool call processing)
 * - TaskDAGManager (task dispatch and dependency resolution)
 * - EscalationRouter (escalation chain)
 * - ProactiveScheduler (proactive behavior)
 * - RetentionWorker (log retention and archiving)
 *
 * Runs in every container (root and non-root) with different capabilities.
 */
export class OrchestratorImpl implements Orchestrator {
  private readonly isRoot: boolean;
  private readonly deps: OrchestratorDeps;
  private readonly logger: Logger;

  // Collaborators
  private toolCallDispatcher?: ToolCallDispatcher;
  private taskDAGManager?: TaskDAGManager;
  private escalationRouter?: EscalationRouter;
  private proactiveScheduler?: ProactiveScheduler;
  private retentionWorker?: RetentionWorker;

  // Event subscriptions for cleanup
  private eventSubscriptions: string[] = [];

  // Init promise for non-root
  private initResolve?: () => void;
  private initPromise?: Promise<void>;

  // Agent configs received in container_init
  private agentConfigs: AgentInitConfig[] = [];

  // Stuck agent check timer (root only)
  private stuckAgentTimer?: ReturnType<typeof setInterval>;

  constructor(deps: OrchestratorDeps, isRoot: boolean = true) {
    this.deps = deps;
    this.logger = deps.logger;
    this.isRoot = isRoot;
  }

  /**
   * Start the orchestrator.
   *
   * NOTE: Orchestrator does NOT own infrastructure initialization.
   * main() (Step 46) creates all infra and passes ready instances via OrchestratorDeps.
   * This method only performs orchestrator-specific logic.
   */
  async start(): Promise<void> {
    this.logger.info('Orchestrator starting', { is_root: this.isRoot });

    if (this.isRoot) {
      await this.startRoot();
    } else {
      await this.startNonRoot();
    }

    this.logger.info('Orchestrator started', { is_root: this.isRoot });
  }

  private async startRoot(): Promise<void> {
    // Initialize collaborators
    this.initCollaborators();

    // Subscribe to EventBus events
    this.subscribeToEvents();

    // Start ProactiveScheduler (register agents from org chart)
    this.startProactiveScheduler();

    // Start RetentionWorker
    if (this.retentionWorker) {
      this.retentionWorker.start();
    }

    // Rebuild state from persisted data
    await this.rebuildState();
  }

  private async startNonRoot(): Promise<void> {
    // Register WS message handlers
    if (this.deps.wsConnection) {
      this.deps.wsConnection.onMessage(this.handleWSMessage.bind(this));
    }

    // Wait for container_init message
    this.initPromise = new Promise<void>((resolve) => {
      this.initResolve = resolve;
    });

    // Send ready message with protocol-compliant payload
    if (this.deps.wsConnection) {
      // Agent count is 0 initially; will be updated when agents are added
      this.deps.wsConnection.send({
        type: 'ready',
        data: {
          team_id: this.deps.wsConnection.tid,
          agent_count: 0,
          protocol_version: '1.0.0',
        },
      });
    }

    // Wait for init (with timeout)
    const timeout = setTimeout(() => {
      this.logger.warn('container_init timeout, continuing anyway');
      this.initResolve?.();
    }, 30000);

    await this.initPromise;
    clearTimeout(timeout);

    // Start agents from received configs
    await this.startAgents();
  }

  private initCollaborators(): void {
    const { stores, mcpRegistry, orgChart, wsHub, eventBus, healthMonitor, keyManager, containerManager, provisioner, triggerScheduler } = this.deps;

    if (!stores || !wsHub || !healthMonitor || !keyManager || !containerManager || !provisioner || !triggerScheduler) {
      return; // Non-root doesn't have these
    }

    // Build ToolContext for createToolHandlers
    const toolContext: ToolContext = {
      orgChart,
      taskStore: stores.taskStore,
      messageStore: stores.messageStore,
      logStore: stores.logStore,
      memoryStore: stores.memoryStore,
      integrationStore: stores.integrationStore,
      credentialStore: stores.credentialStore,
      toolCallStore: stores.toolCallStore,
      containerManager,
      provisioner,
      keyManager,
      wsHub,
      eventBus,
      triggerScheduler,
      mcpRegistry,
      healthMonitor,
      logger: this.logger,
      limits: Object.freeze({
        max_depth: this.deps.limits?.max_depth ?? 3,
        max_teams: this.deps.limits?.max_teams ?? 10,
        max_agents_per_team: this.deps.limits?.max_agents_per_team ?? 5,
        max_concurrent_tasks: this.deps.limits?.max_concurrent_tasks ?? 50,
      }),
    };

    // Create all 22 tool handlers with proper authorization and validation
    const handlers = createToolHandlers(toolContext);

    // ToolCallDispatcher
    this.toolCallDispatcher = new ToolCallDispatcher({
      orgChart,
      mcpRegistry,
      logStore: stores.logStore,
      toolCallStore: stores.toolCallStore,
      logger: this.logger,
      handlers,
    });

    // TaskDAGManager
    this.taskDAGManager = new TaskDAGManager({
      taskStore: stores.taskStore,
      orgChart,
      wsHub,
      eventBus,
      logger: this.logger,
      onEscalation: this.handleEscalation.bind(this),
    });

    // EscalationRouter
    this.escalationRouter = new EscalationRouter({
      orgChart,
      wsHub,
      taskStore: stores.taskStore,
      eventBus,
      logger: this.logger,
    });

    // ProactiveScheduler
    this.proactiveScheduler = new ProactiveScheduler({
      healthMonitor,
      logger: this.logger,
      dispatcher: async (agentAid: string, checkId: string) => {
        // 1. Look up agent in orgChart
        const agent = this.deps.orgChart.getAgent(agentAid);
        if (!agent) {
          this.logger.debug('proactive.skip.no_agent', { agent_aid: agentAid });
          return;
        }

        // 2. Look up team in orgChart
        const team = this.deps.orgChart.getTeamBySlug(agent.teamSlug);
        if (!team) {
          this.logger.debug('proactive.skip.no_team', { agent_aid: agentAid, team_slug: agent.teamSlug });
          return;
        }

        // 3. Resolve PROACTIVE.md and read with error discrimination
        let prompt = 'Perform routine health check and report status.';
        try {
          const fs = await import('node:fs/promises');
          const nodePath = await import('node:path');
          const proactivePath = nodePath.resolve(team.workspacePath, '.claude', 'skills', 'PROACTIVE.md');
          const content = await fs.readFile(proactivePath, 'utf8');

          // 4. Enforce CON-12: 500 line limit
          const lines = content.split('\n');
          if (lines.length > 500) {
            this.logger.warn('proactive.truncated', {
              agent_aid: agentAid,
              lines: lines.length,
              max: 500,
            });
            prompt = lines.slice(0, 500).join('\n') + '\n\n[Truncated: original had ' + lines.length + ' lines, CON-12 limit is 500]';
          } else {
            prompt = content;
          }
        } catch (err) {
          const errno = (err as NodeJS.ErrnoException).code;
          if (errno === 'ENOENT') {
            // Expected: no PROACTIVE.md defined — use default prompt (AC24)
            this.logger.debug('proactive.no_proactive_md', {
              agent_aid: agentAid,
              team_slug: agent.teamSlug,
            });
            // Fall through — use default prompt
          } else {
            // Unexpected I/O error (EACCES, EIO, etc.) — skip dispatch (AC24)
            this.logger.warn('proactive.read_error', {
              agent_aid: agentAid,
              team_slug: agent.teamSlug,
              error_code: errno,
              error: String(err),
            });
            return;
          }
        }

        // 5. Log prompt hash for audit
        const crypto = await import('node:crypto');
        const promptHash = crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16);
        this.logger.info('proactive.dispatch', {
          agent_aid: agentAid,
          check_id: checkId,
          prompt_hash: promptHash,
        });

        // 6. Create task record
        const taskStores = this.deps.stores;
        if (!taskStores) return;

        const taskId = `proactive-${checkId}`;
        const now = Date.now();
        const task = {
          id: taskId,
          parent_id: '',
          team_slug: agent.teamSlug,
          agent_aid: agentAid,
          title: `Proactive: ${checkId}`,
          status: TS.Pending,
          prompt,
          result: '',
          error: '',
          blocked_by: [] as string[],
          priority: 1,
          retry_count: 0,
          max_retries: 0,
          created_at: now,
          updated_at: now,
          completed_at: null,
        };
        await taskStores.taskStore.create(task);

        // 7. Dispatch task via TaskDAGManager
        if (this.taskDAGManager) {
          await this.taskDAGManager.dispatchTask(task);
        }
      },
    });

    // RetentionWorker
    this.retentionWorker = new RetentionWorker({
      logStore: stores.logStore,
      memoryStore: stores.memoryStore,
      logger: this.logger,
      archiveWriter: async (entries: string, copyIndex: number) => {
        const nodePath = await import('node:path');
        const archiveDir = nodePath.resolve(this.deps.archiveDir ?? 'data/archives');
        const expectedBase = nodePath.resolve(this.deps.dataDir ?? 'data');

        // Segment-aware path validation: reject sibling-prefix attacks like /data-evil
        // (bare startsWith('/data') would incorrectly allow /data-evil).
        if (archiveDir !== expectedBase && !archiveDir.startsWith(expectedBase + nodePath.sep)) {
          this.logger.error('archive.path_traversal', {
            archive_dir: archiveDir,
            expected_base: expectedBase,
          });
          throw new ValidationError(
            `Archive directory '${archiveDir}' is outside allowed base '${expectedBase}'`
          );
        }

        const fs = await import('node:fs/promises');
        await fs.mkdir(archiveDir, { recursive: true });

        const filename = `logs-archive-${copyIndex}.ndjson.gz`;
        const filePath = nodePath.resolve(archiveDir, filename);
        // entries is a base64-encoded gzip buffer produced by RetentionWorker
        await fs.writeFile(filePath, Buffer.from(entries, 'base64'));

        this.logger.info('archive.written', { path: filePath, copy_index: copyIndex });
      },
    });

    // Stuck agent detection timer (check every 30 seconds, default 30 min timeout)
    const STUCK_CHECK_INTERVAL_MS = 30_000;
    const STUCK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
    this.stuckAgentTimer = setInterval(() => {
      this.checkStuckAgents(STUCK_TIMEOUT_MS);
    }, STUCK_CHECK_INTERVAL_MS);
  }

  /**
   * Check for stuck agents (busy longer than timeout) and kill them.
   * Per wiki: SIGTERM -> 5s grace -> SIGKILL -> mark task failed, escalate.
   */
  private async checkStuckAgents(timeoutMs: number): Promise<void> {
    const { healthMonitor, agentExecutor, stores, orgChart, wsHub } = this.deps;
    if (!healthMonitor || !agentExecutor || !stores) return;

    const stuckAgents = healthMonitor.getStuckAgents(timeoutMs);
    if (stuckAgents.length === 0) return;

    this.logger.warn('Detected stuck agents, stopping them', {
      count: stuckAgents.length,
      timeout_ms: timeoutMs,
    });

    for (const aid of stuckAgents) {
      try {
        // Stop the agent process with grace period (SIGTERM -> 5s -> SIGKILL)
        await agentExecutor.stop(aid, 5000);
        this.logger.info('Stopped stuck agent', { aid });

        // Find and fail any active tasks for this agent
        const activeTasks = await stores.taskStore.listByStatus(TS.Active);
        for (const task of activeTasks) {
          if (task.agent_aid === aid) {
            const updatedTask = {
              ...task,
              status: TS.Failed,
              error: 'Agent timed out (stuck)',
              updated_at: Date.now(),
            };
            await stores.taskStore.update(updatedTask);
            this.logger.info('Marked task as failed due to stuck agent', {
              task_id: task.id,
              aid,
            });

            // Escalate to team lead
            const team = orgChart.getTeamBySlug(task.team_slug);
            if (team && wsHub) {
              await this.handleEscalation(aid, task.id, 'timeout' as EscalationReason, {
                original_error: 'Agent timed out (stuck)',
                team_slug: task.team_slug,
              });
            }
          }
        }
      } catch (err) {
        this.logger.error('Failed to stop stuck agent', { aid, error: String(err) });
      }
    }
  }

  private subscribeToEvents(): void {
    const { eventBus } = this.deps;

    // Subscribe to tool_call events
    const toolCallSub = eventBus.filteredSubscribe(
      (e: BusEvent) => e.type === 'tool_call',
      (e: BusEvent) => {
        this.logger.debug('tool_call event', { data: e.data });
      },
    );
    this.eventSubscriptions.push(toolCallSub);

    // Subscribe to task_result events
    const taskResultSub = eventBus.filteredSubscribe(
      (e: BusEvent) => e.type === 'task_result',
      (e: BusEvent) => {
        const { task_id, agent_aid, status, result, error } = e.data as {
          task_id: string;
          agent_aid: string;
          status: TaskStatus;
          result?: string;
          error?: string;
        };
        this.handleTaskResult(task_id, agent_aid, status, result, error).catch((err) => {
          this.logger.error('task_result handler failed', { error: String(err) });
        });
      },
    );
    this.eventSubscriptions.push(taskResultSub);

    // Subscribe to escalation events
    const escalationSub = eventBus.filteredSubscribe(
      (e: BusEvent) => e.type === 'escalation',
      (e: BusEvent) => {
        const { agent_aid, task_id, reason, context } = e.data as {
          agent_aid: string;
          task_id: string;
          reason: EscalationReason;
          context: Record<string, unknown>;
        };
        this.handleEscalation(agent_aid, task_id, reason, context).catch((err) => {
          this.logger.error('escalation handler failed', { error: String(err) });
        });
      },
    );
    this.eventSubscriptions.push(escalationSub);

    // Subscribe to heartbeat events
    const heartbeatSub = eventBus.filteredSubscribe(
      (e: BusEvent) => e.type === 'heartbeat',
      (e: BusEvent) => {
        const { tid, agents } = e.data as {
          tid: string;
          agents: Array<{ aid: string; status: AgentStatus; detail: string }>;
        };
        this.deps.healthMonitor?.recordHeartbeat(tid, agents);
      },
    );
    this.eventSubscriptions.push(heartbeatSub);
  }

  private startProactiveScheduler(): void {
    if (!this.proactiveScheduler) return;

    // Register all agents from org chart
    const agents = this.deps.orgChart.listTeams()
      .flatMap((team) => this.deps.orgChart.getAgentsByTeam(team.slug));

    for (const agent of agents) {
      // Default 30 min interval, can be configured per agent
      this.proactiveScheduler.registerAgent(agent.aid, 30);
    }
  }

  /**
   * Stop the orchestrator gracefully.
   *
   * Stops orchestrator-owned workers only (main() owns shared infrastructure teardown).
   * Stops: auto-archive worker, RetentionWorker, ProactiveScheduler timers,
   * EventBus subscriptions (orchestrator's own handlers).
   */
  async stop(): Promise<void> {
    this.logger.info('Orchestrator stopping', { is_root: this.isRoot });

    // Stop stuck agent timer
    if (this.stuckAgentTimer) {
      clearInterval(this.stuckAgentTimer);
      this.stuckAgentTimer = undefined;
    }

    // Stop ProactiveScheduler
    this.proactiveScheduler?.stop();

    // Stop RetentionWorker
    this.retentionWorker?.stop();

    // Unsubscribe from EventBus
    for (const subId of this.eventSubscriptions) {
      this.deps.eventBus.unsubscribe(subId);
    }
    this.eventSubscriptions = [];

    this.logger.info('Orchestrator stopped', { is_root: this.isRoot });
  }

  /**
   * Rebuild orchestrator state after a root container restart.
   *
   * Recovery sequence:
   * 1. Query Docker API for running containers with openhive labels
   * 2. For each container, re-establish WebSocket connection
   * 3. Send container_init to re-sync agent configurations
   * 4. Wait for containers to send heartbeat naturally (CON-05: within 30s)
   * 5. Rebuild org chart from persisted team configs + live container state
   * 6. Task recovery: mark active tasks as failed (recovery), retry or escalate
   */
  async rebuildState(): Promise<void> {
    if (!this.isRoot) return;

    this.logger.info('Rebuilding orchestrator state');

    // 1. Query running containers
    const containers = await this.deps.containerManager?.listRunningContainers() ?? [];
    this.logger.info('Found running containers', { count: containers.length });

    // 2-4. For each container, log recovery state (heartbeat arrives naturally)
    for (const container of containers) {
      this.logger.debug('container.recovery', {
        tid: container.tid,
        slug: container.teamSlug,
        health: container.health,
      });

      // Container heartbeat will arrive naturally within 30s (CON-05).
      // Protocol forbids root-to-container heartbeat -- direction is container-to-root only.
    }

    // 5. Rebuild org chart from stored state
    // (Assumes teams were loaded from config during startup)

    // 6. Task recovery
    await this.recoverTasks();

    this.logger.info('State rebuild complete');
  }

  /**
   * Task recovery: mark active tasks as failed (recovery), retry or escalate.
   */
  private async recoverTasks(): Promise<void> {
    const taskStore = this.deps.stores?.taskStore;
    if (!taskStore) return;

    // Find all active tasks
    const activeTasks = await taskStore.listByStatus(TS.Active);

    for (const task of activeTasks) {
      this.logger.info('task.recovery', { task_id: task.id, agent_aid: task.agent_aid });

      // Mark as failed with reason 'recovery'
      const now = Date.now();
      await taskStore.update({
        ...task,
        status: TS.Failed,
        error: 'Task interrupted by orchestrator restart (recovery)',
        updated_at: now,
        completed_at: now,
      });

      // Check retry count
      if (task.retry_count < task.max_retries) {
        // Transition to pending for retry
        await taskStore.update({
          ...task,
          id: task.id,
          status: TS.Pending,
          retry_count: task.retry_count + 1,
          error: '',
          updated_at: Date.now(),
          completed_at: null,
        });
        this.logger.info('task.recovery.retry', {
          task_id: task.id,
          retry_count: task.retry_count + 1,
          max_retries: task.max_retries,
        });
      } else {
        // Escalate to team lead
        const team = this.deps.orgChart.getTeamBySlug(task.team_slug);
        const leaderAid = team?.leaderAid ?? task.agent_aid;

        await this.handleEscalation(leaderAid, task.id, 'error' as EscalationReason, {
          recovery: true,
          failed_task_id: task.id,
          error: 'Task failed after orchestrator restart, retries exhausted',
          retries_exhausted: true,
        });
      }
    }
  }

  /**
   * Handle WebSocket message (non-root).
   */
  private handleWSMessage(message: { type: string; data: Record<string, unknown> }): void {
    switch (message.type) {
      case 'container_init':
        this.handleContainerInit(message.data as { agents: AgentInitConfig[] });
        break;
      case 'task_dispatch':
        this.handleTaskDispatch(message.data as { task_id: string; agent_aid: string; prompt: string });
        break;
      case 'shutdown':
        this.handleShutdown();
        break;
      case 'agent_added': {
        // Notification that a new agent was added to this team
        // Root sends this after create_agent tool; non-root should start the agent
        const { agent } = message.data as {
          agent: { aid: string; name: string; description: string; model: string; role?: string; tools?: string[]; provider?: unknown; systemPrompt?: string };
        };
        this.logger.info('Agent added notification', { aid: agent.aid, name: agent.name });
        // Add to local org chart
        const team = this.deps.orgChart?.listTeams()[0];
        if (team) {
          this.deps.orgChart?.addAgent({
            aid: agent.aid,
            name: agent.name,
            teamSlug: team.slug,
            role: (agent.role as 'main_assistant' | 'team_lead' | 'member') || 'member',
            status: 'idle',
          });
        }
        // Start the agent in this container
        if (this.deps.agentExecutor) {
          const agentConfig: AgentInitConfig = {
            aid: agent.aid,
            name: agent.name,
            description: agent.description,
            role: agent.role || 'member',
            model: agent.model,
            tools: agent.tools || [],
            provider: agent.provider as ResolvedProvider || { type: 'anthropic_direct', models: {} },
            systemPrompt: agent.systemPrompt,
          };
          this.deps.agentExecutor.start(agentConfig, '/app/workspace')
            .then(() => {
              this.logger.info('agent.started from agent_added', { aid: agent.aid });
            })
            .catch((err: Error) => {
              this.logger.error('agent.start.failed from agent_added', {
                aid: agent.aid,
                error: err.message,
              });
            });
        }
        break;
      }
      case 'escalation_response': {
        // Response to an escalation from this container
        const { correlation_id, task_id, agent_aid, resolution, context } = message.data as {
          correlation_id: string;
          task_id: string;
          agent_aid: string;
          resolution: string;
          context: Record<string, unknown>;
        };
        this.logger.info('Received escalation_response', { correlation_id, task_id, agent_aid, resolution });
        // Publish to event bus for MCPBridge to handle
        this.deps.eventBus?.publish({
          type: 'escalation.response',
          data: { correlation_id, task_id, agent_aid, resolution, context },
          timestamp: Date.now(),
        });
        break;
      }
      case 'task_cancel': {
        // Cancel a running task
        const { task_id, cascade, reason } = message.data as {
          task_id: string;
          cascade: boolean;
          reason?: string;
        };
        this.logger.info('Received task_cancel', { task_id, cascade, reason });
        // Publish to event bus for handling
        this.deps.eventBus?.publish({
          type: 'task.cancel',
          data: { task_id, cascade, reason },
          timestamp: Date.now(),
        });
        break;
      }
      case 'tool_result': {
        // Result of a tool call made by this container
        const { call_id, result, error_code, error_message } = message.data as {
          call_id: string;
          result?: unknown;
          error_code?: string;
          error_message?: string;
        };
        this.logger.debug('Received tool_result', { call_id, hasResult: result !== undefined, error_code });
        // Publish to event bus for MCPBridge to handle
        this.deps.eventBus?.publish({
          type: 'tool.result',
          data: { call_id, result, error_code, error_message },
          timestamp: Date.now(),
        });
        break;
      }
      case 'agent_message': {
        // Inter-agent message routed through root, delivered to target agent via EventBus
        const { correlation_id, source_aid, target_aid, content } = message.data as {
          correlation_id: string;
          source_aid: string;
          target_aid: string;
          content: string;
        };
        this.logger.debug('Received agent_message', { correlation_id, source_aid, target_aid });
        // Publish to event bus for MCPBridge / agent SDK to deliver to target agent
        this.deps.eventBus?.publish({
          type: 'agent.message',
          data: { correlation_id, source_aid, target_aid, content },
          timestamp: Date.now(),
        });
        break;
      }
      default:
        this.logger.debug('ws.message.unhandled', { type: message.type });
    }
  }

  /**
   * Handle container_init message (non-root).
   */
  private handleContainerInit(data: { agents: AgentInitConfig[] }): void {
    this.logger.info('container_init received', { agent_count: data.agents?.length ?? 0 });
    this.agentConfigs = data.agents ?? [];
    this.initResolve?.();
  }

  /**
   * Start agents from received configs (non-root).
   */
  private async startAgents(): Promise<void> {
    for (const config of this.agentConfigs) {
      try {
        await this.deps.agentExecutor.start(config, '/app/workspace');
        this.logger.info('agent.started', { aid: config.aid });
      } catch (err) {
        this.logger.error('agent.start.failed', {
          aid: config.aid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Handle task_dispatch message (non-root).
   */
  private handleTaskDispatch(data: { task_id: string; agent_aid: string; prompt: string }): void {
    this.logger.debug('task_dispatch received', { task_id: data.task_id, agent_aid: data.agent_aid });
    // Forward to agent executor - will be handled by SDK hooks
  }

  /**
   * Handle shutdown message (non-root).
   */
  private handleShutdown(): void {
    this.logger.info('shutdown received');
    this.stop().catch((err) => {
      this.logger.error('shutdown failed', { error: String(err) });
    });
  }

  // -------------------------------------------------------------------------
  // Delegation methods (thin wrappers)
  // -------------------------------------------------------------------------

  /**
   * Dispatch a tool call from an agent to the appropriate handler.
   * Delegates to ToolCallDispatcher.
   */
  async handleToolCall(
    agentAid: string,
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<Record<string, unknown>> {
    if (!this.toolCallDispatcher) {
      throw new Error('ToolCallDispatcher not initialized');
    }
    return this.toolCallDispatcher.handleToolCall(agentAid, toolName, args, callId);
  }

  /**
   * Dispatch a task to the appropriate agent for execution.
   * Delegates to TaskDAGManager.
   */
  async dispatchTask(task: Task): Promise<void> {
    if (!this.taskDAGManager) {
      throw new Error('TaskDAGManager not initialized');
    }
    return this.taskDAGManager.dispatchTask(task);
  }

  /**
   * Process a task result reported by an agent.
   * Delegates to TaskDAGManager.
   */
  async handleTaskResult(
    taskId: string,
    agentAid: string,
    status: TaskStatus,
    result?: string,
    error?: string,
  ): Promise<void> {
    if (!this.taskDAGManager) {
      throw new Error('TaskDAGManager not initialized');
    }
    return this.taskDAGManager.handleTaskResult(taskId, agentAid, status, result, error);
  }

  /**
   * Handle an escalation request from an agent.
   * Delegates to EscalationRouter.
   */
  async handleEscalation(
    agentAid: string,
    taskId: string,
    reason: EscalationReason,
    context: Record<string, unknown>,
  ): Promise<string> {
    if (!this.escalationRouter) {
      throw new Error('EscalationRouter not initialized');
    }
    return this.escalationRouter.handleEscalation(agentAid, taskId, reason, context);
  }

  /**
   * Process a response to a prior escalation.
   * Delegates to EscalationRouter.
   */
  async handleEscalationResponse(
    correlationId: string,
    resolution: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    if (!this.escalationRouter) {
      throw new Error('EscalationRouter not initialized');
    }
    return this.escalationRouter.handleEscalationResponse(correlationId, resolution, context);
  }
}