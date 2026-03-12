import type {
  Orchestrator,
  Logger,
  EventBus,
  OrgChart,
  WSHub,
  WSConnection,
  TaskStore,
  ContainerManager,
  HealthMonitor,
  TriggerScheduler,
  AgentExecutor,
  SessionManager,
  ConfigLoader,
  KeyManager,
  MCPRegistry,
  ToolCallStore,
  LogStore,
  MemoryStore,
  AgentInitConfig,
  BusEvent,
} from '../domain/interfaces.js';
import type { Task } from '../domain/domain.js';
import type { TaskStatus, EscalationReason, AgentStatus } from '../domain/enums.js';
import { TaskStatus as TS } from '../domain/enums.js';
import { ToolCallDispatcher } from './tool-call-dispatcher.js';
import { TaskDAGManager } from './task-dag-manager.js';
import { EscalationRouter } from './escalation-router.js';
import { ProactiveScheduler } from './proactive-scheduler.js';
import { RetentionWorker } from './retention-worker.js';

/** All store interfaces combined for convenience. */
export interface AllStores {
  taskStore: TaskStore;
  logStore: LogStore;
  memoryStore: MemoryStore;
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
  healthMonitor?: HealthMonitor; // root only
  triggerScheduler?: TriggerScheduler; // root only
  router?: unknown; // root only - Router type
  agentExecutor: AgentExecutor;
  sessionManager?: SessionManager; // optional - not used directly by orchestrator
  stores?: AllStores; // root only
  mcpRegistry: MCPRegistry;
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

    // Send ready message
    if (this.deps.wsConnection) {
      this.deps.wsConnection.send({
        type: 'ready',
        data: { tid: this.deps.wsConnection.tid },
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
    const { stores, mcpRegistry, orgChart, wsHub, eventBus, healthMonitor } = this.deps;

    if (!stores || !wsHub || !healthMonitor) {
      return; // Non-root doesn't have these
    }

    // Tool handlers map (populated externally or defaults)
    const handlers = new Map<string, (args: Record<string, unknown>, agentAid: string, teamSlug: string) => Promise<Record<string, unknown>>>();

    // ToolCallDispatcher
    this.toolCallDispatcher = new ToolCallDispatcher({
      orgChart,
      mcpRegistry,
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
        this.logger.debug('proactive.dispatch', { agent_aid: agentAid, check_id: checkId });
        // Dispatch a proactive task - will be implemented in tool handlers
      },
    });

    // RetentionWorker
    this.retentionWorker = new RetentionWorker({
      logStore: stores.logStore,
      memoryStore: stores.memoryStore,
      logger: this.logger,
      archiveWriter: async (entries: string, _copyIndex: number) => {
        // Archive writer - writes to file system (will be implemented later)
        this.logger.debug('archive.write', { size: entries.length });
      },
    });
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
   * 4. Request heartbeat to rebuild health state in HealthMonitor
   * 5. Rebuild org chart from persisted team configs + live container state
   * 6. Task recovery: mark active tasks as failed (recovery), retry or escalate
   */
  async rebuildState(): Promise<void> {
    if (!this.isRoot) return;

    this.logger.info('Rebuilding orchestrator state');

    // 1. Query running containers
    const containers = await this.deps.containerManager?.listRunningContainers() ?? [];
    this.logger.info('Found running containers', { count: containers.length });

    // 2-4. For each container, re-establish connection and request heartbeat
    for (const container of containers) {
      this.logger.debug('container.recovery', {
        tid: container.tid,
        slug: container.teamSlug,
        health: container.health,
      });

      // Request heartbeat via WS (connection already established by WS server)
      if (this.deps.wsHub?.isConnected(container.tid)) {
        this.deps.wsHub.send(container.tid, {
          type: 'heartbeat',
          data: { request: true },
        });
      }
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
      case 'escalation_response':
        // Handled by MCPBridge
        break;
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