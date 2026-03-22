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
  TokenManager,
  MCPRegistry,
  DispatchTracker,
  WorkspaceLock,
  PluginManager,
  MessageRouter,
  AgentInitConfig,
  BusEvent,
} from '../domain/interfaces.js';
import type { Task } from '../domain/domain.js';
import type { TaskStatus, EscalationReason, AgentStatus } from '../domain/enums.js';
import { TaskStatus as TS, ContainerHealth as CH, AgentStatus as AS, AgentRole as AR } from '../domain/enums.js';
import { ValidationError } from '../domain/errors.js';
import { validateTeam } from '../config/validation.js';
import YAML from 'yaml';
import { ToolCallDispatcher } from './tool-call-dispatcher.js';
import { TaskDAGManager } from './task-dag-manager.js';
import { EscalationRouter } from './escalation-router.js';
import { ProactiveScheduler } from './proactive-scheduler.js';
import { RetentionWorker } from './retention-worker.js';
import { createToolHandlers, type ToolContext, type ToolHandler, type PendingMemoryWrite } from '../mcp/tools/index.js';
import { join } from 'node:path';
import { mkdir, readdir, readFile, stat, access } from 'node:fs/promises';
import { appendFile } from 'node:fs/promises';
import {
  handleWSMessage as handleWSMessageFn,
  type WSHandlerDeps,
} from './orchestrator-ws-handlers.js';
import {
  checkStuckAgents as checkStuckAgentsFn,
  cleanupOrphanedTasks as cleanupOrphanedTasksFn,
  handleHealthStateChanged as handleHealthStateChangedFn,
  startProactiveScheduler as startProactiveSchedulerFn,
} from './orchestrator-proactive.js';

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
  tokenManager?: TokenManager; // root only — used to revoke stale tokens before restart (AC-B6)
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
  sessionManager?: SessionManager; // root only — wired into task dispatch chain (AC-C1, AC-C2)
  dispatchTracker?: DispatchTracker; // root only — in-flight task tracking for state replay (AC-B5)
  workspaceLock?: WorkspaceLock; // root only — advisory lock for concurrent workspace operations (AC-D2, AC-D3)
  pluginManager?: PluginManager; // root only — log sink plugin hot-reload (AC-F1, AC-F5)
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
  /** Configured skill registry URLs from openhive.yaml. */
  skillRegistries?: string[];
  /** Provider resolver for agent_added WS messages (root only). */
  resolveProviderPreset?: (presetName: string) => import('../domain/interfaces.js').ResolvedProvider;
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

  /** Optional message router for sending responses back to channels (root-only, AC-G5-01). */
  private messageRouter?: MessageRouter;

  // Event subscriptions for cleanup
  private eventSubscriptions: string[] = [];

  // Init promise for non-root
  private initResolve?: () => void;
  private initPromise?: Promise<void>;

  // Agent configs received in container_init
  private agentConfigs: AgentInitConfig[] = [];

  /**
   * Consolidated health + stuck-agent check timer (root only, AC-CROSS-4).
   *
   * Replaces both the HealthMonitor's internal checkTimeouts timer and the
   * previous stuckAgentTimer. A single setInterval(30000) calls:
   *   (a) healthMonitor.checkTimeouts() — detects unhealthy/unreachable containers
   *   (b) this.checkStuckAgents()       — detects stuck agent processes
   */
  private consolidatedCheckTimer?: ReturnType<typeof setInterval>;

  /**
   * Per-slug restart counters for rate limiting (max 3 auto-restarts per hour).
   * Each entry: { count, windowStart } where windowStart is a Unix ms timestamp.
   */
  private restartCounts = new Map<string, { count: number; windowStart: number }>();

  /**
   * Maps taskId -> sessionId for active in-flight tasks (AC-C1, AC-C2).
   * Created in dispatchTask(), consumed and cleared in handleTaskResult().
   */
  private readonly taskSessionMap = new Map<string, string>();

  /** Tool handlers map created in initCollaborators(). Available via getToolHandlers(). */
  private toolHandlersMap?: Map<string, ToolHandler>;
  /** Memory file writer created in initCollaborators(). Available via getMemoryFileWriter(). */
  private memoryFileWriterFn?: (agentAid: string, teamSlug: string, entry: {
    id: number; content: string; memory_type: 'curated' | 'daily'; created_at: number;
  }) => Promise<void>;

  constructor(deps: OrchestratorDeps, isRoot: boolean = true) {
    this.deps = deps;
    this.logger = deps.logger;
    this.isRoot = isRoot;
  }

  /**
   * Returns the tool handlers map created in initCollaborators().
   * Returns undefined if initCollaborators() has not run (non-root containers).
   */
  getToolHandlers(): Map<string, ToolHandler> | undefined {
    return this.toolHandlersMap;
  }

  /** Returns the memory file writer for post-task auto-save. */
  getMemoryFileWriter(): typeof this.memoryFileWriterFn {
    return this.memoryFileWriterFn;
  }

  /**
   * Set the message router for sending responses back to channels (AC-G5-02).
   * Called post-construction because MessageRouter is created after the orchestrator.
   */
  setMessageRouter(router: MessageRouter): void {
    this.messageRouter = router;
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

    // Wait for container_init message (root sends it after WS connect)
    this.initPromise = new Promise<void>((resolve) => {
      this.initResolve = resolve;
    });

    const timeout = setTimeout(() => {
      this.logger.warn('container_init timeout, continuing anyway');
      this.initResolve?.();
    }, 30000);

    await this.initPromise;
    clearTimeout(timeout);

    // Start agents from received configs BEFORE sending ready
    await this.startAgents();

    // Send ready AFTER agents are started (WebSocket-Protocol.md spec)
    // This ensures root knows the container is fully operational
    if (this.deps.wsConnection) {
      this.deps.wsConnection.send({
        type: 'ready',
        data: {
          team_id: this.deps.wsConnection.tid,
          agent_count: this.agentConfigs.length,
          protocol_version: '1.0.0',
        },
      });
    }
  }

  private initCollaborators(): void {
    const { stores, mcpRegistry, orgChart, wsHub, eventBus, healthMonitor, keyManager, containerManager, provisioner, triggerScheduler } = this.deps;

    if (!stores || !wsHub || !healthMonitor || !keyManager || !containerManager || !provisioner || !triggerScheduler) {
      return; // Non-root doesn't have these
    }

    // Pending memory writes queue (in-memory, drain-on-write)
    const pendingMemoryWrites: PendingMemoryWrite[] = [];

    // Memory file writer: append-based dual-write to workspace files
    const memoryFileWriter = async (
      agentAid: string,
      teamSlug: string,
      entry: { id: number; content: string; memory_type: 'curated' | 'daily'; created_at: number },
    ): Promise<void> => {
      // Security: reject path traversal in agentAid
      if (agentAid.includes('..') || agentAid.includes('/') || agentAid.includes('\\')) {
        throw new Error(`Invalid agentAid: ${agentAid}`);
      }
      // Security: cap individual memory entry at 500 chars
      if (entry.content.length > 500) {
        throw new Error('Memory entry exceeds 500 character limit');
      }

      // Resolve workspace: use orgChart for consistency with executor read path
      const team = orgChart.getTeamBySlug(teamSlug);
      const workspacePath = team?.workspacePath ?? '/app/workspace';
      const memoryDir = join(workspacePath, 'memory', agentAid);
      await mkdir(memoryDir, { recursive: true });

      const timestamp = new Date(entry.created_at).toISOString();

      if (entry.memory_type === 'curated') {
        // Append to MEMORY.md with timestamp header
        const memoryPath = join(memoryDir, 'MEMORY.md');
        const newEntry = `\n## ${timestamp}\n${entry.content}\n`;
        await appendFile(memoryPath, newEntry, 'utf-8');
      } else {
        // Daily: append to YYYY-MM-DD.md
        const dateStr = new Date(entry.created_at).toISOString().slice(0, 10);
        const dailyPath = join(memoryDir, `${dateStr}.md`);
        const newEntry = `\n### ${timestamp}\n${entry.content}\n`;
        await appendFile(dailyPath, newEntry, 'utf-8');
      }
    };

    // Store for executor access
    this.memoryFileWriterFn = memoryFileWriter;

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
      workspaceLock: this.deps.workspaceLock,
      memoryFileWriter,
      pendingMemoryWrites,
      skillRegistries: this.deps.skillRegistries,
      resolveProviderPreset: this.deps.resolveProviderPreset,
      limits: Object.freeze({
        max_depth: this.deps.limits?.max_depth ?? 3,
        max_teams: this.deps.limits?.max_teams ?? 10,
        max_agents_per_team: this.deps.limits?.max_agents_per_team ?? 5,
        max_concurrent_tasks: this.deps.limits?.max_concurrent_tasks ?? 50,
      }),
    };

    // Create all 23 tool handlers with proper authorization and validation
    const handlers = createToolHandlers(toolContext);
    this.toolHandlersMap = handlers;

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
      agentExecutor: this.deps.agentExecutor,
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

    // Consolidated health + stuck-agent timer (AC-CROSS-4).
    // Replaces both healthMonitor's internal checkTimeouts timer and the previous
    // stuckAgentTimer. One setInterval(30000) calls both checks sequentially.
    const CONSOLIDATED_INTERVAL_MS = 30_000;
    const STUCK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
    const ORPHAN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    this.consolidatedCheckTimer = setInterval(() => {
      // (a) Detect unhealthy/unreachable containers and emit health.state_changed
      healthMonitor.checkTimeouts();
      // (b) Detect stuck agent processes
      void this.checkStuckAgents(STUCK_TIMEOUT_MS);
      // (c) Clean up orphaned active tasks (no running agent or dispatch tracker entry)
      void this.cleanupOrphanedTasks(ORPHAN_TIMEOUT_MS);
    }, CONSOLIDATED_INTERVAL_MS);
  }

  /**
   * Check for stuck agents (busy longer than timeout) and kill them.
   * Delegates to standalone function in orchestrator-proactive.ts.
   */
  private async checkStuckAgents(timeoutMs: number): Promise<void> {
    return checkStuckAgentsFn({
      logger: this.logger,
      healthMonitor: this.deps.healthMonitor,
      agentExecutor: this.deps.agentExecutor,
      stores: this.deps.stores ? { taskStore: this.deps.stores.taskStore } : undefined,
      orgChart: this.deps.orgChart,
      wsHub: this.deps.wsHub,
      handleEscalation: this.handleEscalation.bind(this),
    }, timeoutMs);
  }

  private async cleanupOrphanedTasks(thresholdMs: number): Promise<void> {
    return cleanupOrphanedTasksFn({
      logger: this.logger,
      stores: this.deps.stores ? { taskStore: this.deps.stores.taskStore } : undefined,
      orgChart: this.deps.orgChart,
      agentExecutor: this.deps.agentExecutor,
      dispatchTracker: this.deps.dispatchTracker,
    }, thresholdMs);
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

    // Subscribe to session cleanup events (dispatch failures in task-dag-manager)
    const sessionCleanupSub = eventBus.filteredSubscribe(
      (e: BusEvent) => e.type === 'session.cleanup',
      async (e: BusEvent) => {
        const { task_id } = e.data as { task_id: string; agent_aid: string };
        const sessionId = this.taskSessionMap.get(task_id);
        if (sessionId && this.deps.sessionManager) {
          this.taskSessionMap.delete(task_id);
          try {
            await this.deps.sessionManager.endSession(sessionId);
          } catch (err) {
            this.logger.warn('session.cleanup.failed', {
              task_id,
              session_id: sessionId,
              error: String(err),
            });
          }
        }
      },
    );
    this.eventSubscriptions.push(sessionCleanupSub);

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

    // Subscribe to health.state_changed events for auto-restart (AC-B1, AC-B2, AC-B6)
    const healthSub = eventBus.filteredSubscribe(
      (e: BusEvent) => e.type === 'health.state_changed',
      (e: BusEvent) => {
        const { tid, previousState, newState } = e.data as {
          tid: string;
          previousState: string;
          newState: string;
        };
        if (newState === 'unreachable') {
          this.handleHealthStateChanged(tid, previousState, newState).catch((err) => {
            this.logger.error('health.state_changed handler failed', { error: String(err) });
          });
        }
      },
    );
    this.eventSubscriptions.push(healthSub);

    // Subscribe to container.restarted events for dispatch ownership transfer (Phase 9.1)
    const restartSub = eventBus.filteredSubscribe(
      (e: BusEvent) => e.type === 'container.restarted',
      (e: BusEvent) => {
        const { slug, oldTid } = e.data as { slug: string; oldTid: string };
        if (oldTid && this.deps.dispatchTracker) {
          // New TID will be assigned when container reconnects — for now transfer
          // ownership from oldTid to slug as a temporary marker
          const newTeam = this.deps.orgChart.getTeamBySlug(slug);
          if (newTeam) {
            const transferred = this.deps.dispatchTracker.transferOwnership(oldTid, newTeam.tid);
            this.logger.info('Dispatch ownership transferred after container restart', {
              slug,
              old_tid: oldTid,
              new_tid: newTeam.tid,
              transferred_count: transferred,
            });
          }
        }
      },
    );
    this.eventSubscriptions.push(restartSub);
  }

  /**
   * Handle a health state transition to 'unreachable': revoke stale tokens and
   * auto-restart the container. Delegates to standalone function.
   */
  private async handleHealthStateChanged(tid: string, previousState: string, newState: string): Promise<void> {
    return handleHealthStateChangedFn({
      logger: this.logger,
      orgChart: this.deps.orgChart,
      containerManager: this.deps.containerManager,
      tokenManager: this.deps.tokenManager,
      restartCounts: this.restartCounts,
    }, tid, previousState, newState);
  }

  /**
   * Start the proactive scheduler. Delegates to standalone function.
   */
  private startProactiveScheduler(): void {
    startProactiveSchedulerFn(this.proactiveScheduler, {
      logger: this.logger,
      orgChart: this.deps.orgChart,
      proactiveScheduler: this.proactiveScheduler!,
    });
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

    // Stop consolidated health + stuck-agent timer (AC-CROSS-4)
    if (this.consolidatedCheckTimer) {
      clearInterval(this.consolidatedCheckTimer);
      this.consolidatedCheckTimer = undefined;
    }

    // Stop ProactiveScheduler
    this.proactiveScheduler?.stop();

    // Stop RetentionWorker
    this.retentionWorker?.stop();

    // Stop DispatchTracker (clears all in-flight timers)
    this.deps.dispatchTracker?.stop();

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

    // 6. Resume active sessions for reconnected containers (AC-C2).
    // First, populate the in-memory map from the SessionStore so that sessions
    // persisted before this root restart are visible to getSessionByAgent().
    // Then resume them so agents can continue their prior SDK context.
    if (this.deps.sessionManager) {
      await this.deps.sessionManager.preloadFromStore();
    }
    await this.resumeActiveSessions();

    // 7. Rebuild teams from filesystem (discovers persisted team directories)
    await this.rebuildTeamsFromFilesystem();

    // 8. Task recovery
    await this.recoverTasks();

    this.logger.info('State rebuild complete');
  }

  /**
   * Rebuild teams from filesystem on startup.
   *
   * Recursively scans the workspace tree for team.yaml files and re-registers
   * each discovered team (and its agents) in the org chart. Containers are
   * marked as 'stopped' since they aren't running yet after a restart.
   *
   * This ensures the org chart is populated even when the database has no
   * prior state (fresh start with pre-existing workspace directories).
   */
  private async rebuildTeamsFromFilesystem(): Promise<void> {
    const workspaceRoot = '/app/workspace';
    const discovered: Array<{ workspacePath: string; depth: number; parentTid: string }> = [];

    // Recursive scanner: find all team.yaml files in the workspace tree
    const scanDir = async (dir: string, depth: number, parentTid: string): Promise<void> => {
      const teamsDir = join(dir, 'teams');
      let entries: string[];
      try {
        entries = await readdir(teamsDir);
      } catch {
        return; // No teams/ subdirectory — leaf node
      }

      for (const entry of entries) {
        const teamPath = join(teamsDir, entry);
        try {
          const info = await stat(teamPath);
          if (!info.isDirectory()) continue;
          await access(join(teamPath, 'team.yaml'));
          discovered.push({ workspacePath: teamPath, depth, parentTid });
          // Recurse into sub-teams
          await scanDir(teamPath, depth + 1, ''); // parentTid filled in during registration
        } catch {
          // Not a valid team directory
        }
      }
    };

    await scanDir(workspaceRoot, 1, '');

    if (discovered.length === 0) {
      this.logger.debug('rebuild.filesystem.no_teams', { workspace: workspaceRoot });
      return;
    }

    this.logger.info('rebuild.filesystem.discovered', { count: discovered.length });

    // Process in order of discovery (parents before children due to BFS-like scan)
    for (const { workspacePath, depth } of discovered) {
      try {
        const raw = await readFile(join(workspacePath, 'team.yaml'), 'utf-8');
        const parsed: unknown = YAML.parse(raw);
        const teamConfig = validateTeam(parsed);

        // Use persisted TID if available, else generate new one
        const tid = teamConfig.tid || `tid-${teamConfig.slug}-${Date.now().toString(16)}`;

        // Determine parentTid: look up the parent directory's team in org chart
        const parentPath = join(workspacePath, '..', '..');
        const parentTeam = this.deps.orgChart.listTeams().find(t => {
          // Normalize paths for comparison
          const normalized = join(t.workspacePath);
          const normalizedParent = join(parentPath);
          return normalized === normalizedParent;
        });
        const parentTid = parentTeam?.tid ?? '';

        // Skip if team already registered (e.g., from container discovery)
        const existing = this.deps.orgChart.getTeamBySlug(teamConfig.slug);
        if (existing) {
          this.logger.debug('rebuild.filesystem.skip_existing', { slug: teamConfig.slug, tid: existing.tid });
          continue;
        }

        // Register team in org chart with 'stopped' health
        this.deps.orgChart.addTeam({
          tid,
          slug: teamConfig.slug,
          coordinatorAid: teamConfig.coordinator_aid,
          parentTid,
          depth,
          containerId: '',
          health: CH.Stopped,
          agentAids: (teamConfig.agents ?? []).map(a => a.aid),
          workspacePath,
        });

        // Register agents from team.yaml
        for (const agentEntry of teamConfig.agents ?? []) {
          try {
            this.deps.orgChart.addAgent({
              aid: agentEntry.aid,
              name: agentEntry.name,
              teamSlug: teamConfig.slug,
              role: AR.Member,
              status: AS.Idle,
            });
          } catch {
            // Agent may already exist from other sources
          }
        }

        this.logger.info('rebuild.filesystem.team_registered', {
          slug: teamConfig.slug,
          tid,
          agents: (teamConfig.agents ?? []).length,
          workspace: workspacePath,
        });
      } catch (err) {
        this.logger.warn('rebuild.filesystem.team_failed', {
          workspace: workspacePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
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
        // Escalate for decision
        await this.handleEscalation(task.agent_aid, task.id, 'error' as EscalationReason, {
          recovery: true,
          failed_task_id: task.id,
          error: 'Task failed after orchestrator restart, retries exhausted',
          retries_exhausted: true,
        });
      }
    }
  }

  /**
   * Resume active sessions for agents that were running when root restarted (AC-C2).
   *
   * Queries the task store for Active tasks, looks up persisted session IDs via
   * SessionManager.getSessionByAgent(), and calls resumeSession() so the agent
   * can continue its prior SDK context once the container reconnects.
   * Errors per session are non-fatal and logged at warn level.
   */
  private async resumeActiveSessions(): Promise<void> {
    const { sessionManager, stores } = this.deps;
    if (!sessionManager || !stores) return;

    const activeTasks = await stores.taskStore.listByStatus(TS.Active);
    if (activeTasks.length === 0) return;

    this.logger.info('session.resume.start', { active_task_count: activeTasks.length });

    for (const task of activeTasks) {
      // Look up any persisted session for this agent
      const existingSessionId = sessionManager.getSessionByAgent(task.agent_aid);
      if (!existingSessionId) {
        // No session was persisted (e.g. root restarted between session create and persist)
        this.logger.debug('session.resume.no_session', {
          task_id: task.id,
          agent_aid: task.agent_aid,
        });
        continue;
      }

      try {
        await sessionManager.resumeSession(existingSessionId);
        this.taskSessionMap.set(task.id, existingSessionId);
        this.logger.debug('session.resume.ok', {
          task_id: task.id,
          agent_aid: task.agent_aid,
          session_id: existingSessionId,
        });
      } catch (err) {
        this.logger.warn('session.resume.failed', {
          task_id: task.id,
          agent_aid: task.agent_aid,
          session_id: existingSessionId,
          error: String(err),
        });
      }
    }
  }

  /**
   * Handle WebSocket message (non-root). Delegates to standalone function.
   */
  private handleWSMessage(message: { type: string; data: Record<string, unknown> }): void {
    const wsHandlerDeps: WSHandlerDeps = {
      logger: this.logger,
      eventBus: this.deps.eventBus,
      orgChart: this.deps.orgChart,
      wsConnection: this.deps.wsConnection,
      agentExecutor: this.deps.agentExecutor,
      dispatchTracker: this.deps.dispatchTracker,
    };
    handleWSMessageFn(
      wsHandlerDeps,
      this.agentConfigs,
      this.initResolve,
      (configs) => { this.agentConfigs = configs; },
      message,
    );
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
   * Delegates to TaskDAGManager. Before dispatch, creates an SDK session via
   * SessionManager and includes the session_id in the task_dispatch WS message
   * (AC-C1). After dispatch, registers the task with DispatchTracker so state
   * can be replayed if the container reconnects (AC-B5).
   */
  async dispatchTask(task: Task): Promise<void> {
    if (!this.taskDAGManager) {
      throw new Error('TaskDAGManager not initialized');
    }

    // Persist the task to the store before dispatch so downstream lookups
    // (e.g., getBlockedBy, update) can find it.
    if (this.deps.stores?.taskStore) {
      try {
        await this.deps.stores.taskStore.create(task);
      } catch {
        // Task may already exist (e.g., retry dispatch) — update instead
        await this.deps.stores.taskStore.update(task);
      }
    }

    // Create SDK session before dispatch so the container can resume it (AC-C1).
    // The session is bound to both the agent AID and the team TID (AC-C2).
    // Errors are non-fatal — dispatch proceeds even if session creation fails.
    let sessionId: string | undefined;
    if (this.deps.sessionManager) {
      try {
        // Resolve the TID for this agent's team so the session can be bound to it.
        const agent = this.deps.orgChart.getAgent(task.agent_aid);
        const agentTeam = agent ? this.deps.orgChart.getTeamBySlug(agent.teamSlug) : undefined;
        const tid = agentTeam?.tid ?? '';
        sessionId = await this.deps.sessionManager.createSession(task.agent_aid, task.id, tid);
        this.taskSessionMap.set(task.id, sessionId);
      } catch (err) {
        this.logger.warn('session.create.failed', {
          task_id: task.id,
          agent_aid: task.agent_aid,
          error: String(err),
        });
      }
    }

    await this.taskDAGManager.dispatchTask(task, sessionId);

    // Track dispatch for state replay on reconnect (AC-B5).
    // Look up the target team's TID via the org chart so we can replay by TID.
    if (this.deps.dispatchTracker) {
      const agent = this.deps.orgChart.getAgent(task.agent_aid);
      if (agent) {
        const team = this.deps.orgChart.getTeamBySlug(agent.teamSlug);
        if (team) {
          this.deps.dispatchTracker.trackDispatch(task.id, team.tid, task.agent_aid);
        }
      }
    }
  }

  /**
   * Process a task result reported by an agent.
   * Delegates to TaskDAGManager. Before delegating, acknowledges the dispatch
   * so DispatchTracker stops the grace-period timer (AC-B5). After processing,
   * ends the SDK session so the agent can accept a new task (AC-C2).
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

    // Handle re-queue from non-root container (agent was busy)
    if (status === TS.Pending) {
      this.deps.dispatchTracker?.acknowledgeDispatch(taskId);
      // Clean up session created before dispatch
      const sessionId = this.taskSessionMap.get(taskId);
      if (sessionId && this.deps.sessionManager) {
        this.taskSessionMap.delete(taskId);
        try {
          await this.deps.sessionManager.endSession(sessionId);
        } catch (err) {
          this.logger.warn('session.end.failed', {
            task_id: taskId,
            session_id: sessionId,
            error: String(err),
          });
        }
      }
      // Revert task to pending for later re-dispatch
      const taskStore = this.deps.stores?.taskStore;
      if (taskStore) {
        const task = await taskStore.get(taskId);
        await taskStore.update({ ...task, status: TS.Pending, updated_at: Date.now() });
      }
      return;
    }

    // Acknowledge the dispatch so DispatchTracker clears the grace-period timer (AC-B5).
    this.deps.dispatchTracker?.acknowledgeDispatch(taskId);
    await this.taskDAGManager.handleTaskResult(taskId, agentAid, status, result, error);

    // End the SDK session now that the task is complete (AC-C2).
    // Errors are non-fatal — session may have already been cleaned up.
    const sessionId = this.taskSessionMap.get(taskId);
    if (sessionId && this.deps.sessionManager) {
      this.taskSessionMap.delete(taskId);
      try {
        await this.deps.sessionManager.endSession(sessionId);
      } catch (err) {
        this.logger.warn('session.end.failed', {
          task_id: taskId,
          session_id: sessionId,
          error: String(err),
        });
      }
    }

    // Send response back to originating channel if this is a completed root-level task
    // with origin_chat_jid (AC-G5-01). Failures are logged as warnings but do NOT block
    // task completion (AC-G5-04). Null origin_chat_jid is silently skipped (AC-G5-03).
    if (status === TS.Completed && result && this.messageRouter) {
      const taskStore = this.deps.stores?.taskStore;
      if (taskStore) {
        try {
          const task = await taskStore.get(taskId);
          if (task.origin_chat_jid && !task.parent_id) {
            await this.messageRouter.sendResponse(task.origin_chat_jid, result);
          }
        } catch (err) {
          this.logger.warn('sendResponse.failed', {
            task_id: taskId,
            error: String(err),
          });
        }
      }
    }

    // Notify originating channel on terminal failure (C3 — silent failure fix).
    // Terminal states: Failed (no retries left) or Escalated (retries exhausted → escalated).
    // Only notify for root-level tasks (no parent_id) with an origin channel.
    if ((status === TS.Failed || status === TS.Escalated) && this.messageRouter) {
      const taskStore = this.deps.stores?.taskStore;
      if (taskStore) {
        try {
          const updatedTask = await taskStore.get(taskId);
          const isTerminal = updatedTask.status === TS.Failed || updatedTask.status === TS.Escalated;
          if (isTerminal && updatedTask.origin_chat_jid && !updatedTask.parent_id) {
            const failMsg = `Task ${updatedTask.status}: ${error || 'Unknown error'}\nTask: ${updatedTask.title}`;
            await this.messageRouter.sendResponse(updatedTask.origin_chat_jid, failMsg);
          }
        } catch (err) {
          this.logger.warn('sendResponse.terminal.failed', {
            task_id: taskId,
            error: String(err),
          });
        }
      }
    }

    // Dispatch next queued task for this agent now that it's idle
    if (this.deps.stores?.taskStore) {
      try {
        const nextTask = await this.deps.stores.taskStore.getNextPendingForAgent(agentAid);
        if (nextTask) {
          this.logger.info('Dispatching queued task', {
            task_id: nextTask.id,
            agent_aid: agentAid,
          });
          await this.dispatchTask(nextTask);
        }
      } catch (err) {
        this.logger.warn('queued.dispatch.failed', {
          agent_aid: agentAid,
          error: String(err),
        });
      }
    }
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