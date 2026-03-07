/**
 * OpenHive Backend - Main Orchestrator
 *
 * Implements the GoOrchestrator interface, combining TeamProvisioner,
 * TaskCoordinator, and HealthManager responsibilities.
 *
 * Uses boolean started/stopped flags instead of sync.Once patterns.
 * Stale reaper loop uses setInterval (cleared on stop).
 * Three Mutexes: teamMutex, taskDispatchMutex, orgChartMutex (async-mutex).
 * CopyFileWithContainment is exported as a module-level async function.
 */

import { Mutex } from 'async-mutex';
import { resolve as resolvePath, join as joinPath, sep, dirname, isAbsolute } from 'node:path';
import { mkdirSync, lstatSync, existsSync, createReadStream, createWriteStream } from 'node:fs';
import { mkdir, writeFile, rm, cp, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

import type {
  GoOrchestrator,
  TaskStore,
  WSHub,
  ContainerManager,
  OrgChart,
  ConfigLoader,
  HeartbeatMonitor,
  EventBus,
} from '../domain/interfaces.js';
import type { Task, Team, HeartbeatStatus, MasterConfig, Agent } from '../domain/types.js';
import { NotFoundError, ValidationError, ConflictError } from '../domain/errors.js';
import { validateSlug, validateAID, isReservedSlug, slugToDisplayName, slugifyName } from '../domain/validation.js';
import { MsgTypeTaskDispatch, MsgTypeShutdown } from '../ws/messages.js';
import type { TaskDispatchMsg, ShutdownMsg } from '../ws/messages.js';
import { encodeMessage } from '../ws/protocol.js';
// Dispatcher is referenced in OrchestratorDeps for future use.
import type { Dispatcher } from './dispatch.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STALE_TASK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const STALE_REAPER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// OrchestratorLogger
// ---------------------------------------------------------------------------

/**
 * Minimal structured logger interface for Orchestrator.
 * Compatible with pino or any standard structured logger stub.
 */
export interface OrchestratorLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// OrchestratorDeps
// ---------------------------------------------------------------------------

/**
 * Dependencies for Orchestrator construction.
 */
export interface OrchestratorDeps {
  taskStore: TaskStore;
  wsHub: WSHub;
  containerManager: ContainerManager | null;
  orgChart: OrgChart;
  configLoader: ConfigLoader;
  heartbeatMonitor: HeartbeatMonitor | null;
  eventBus: EventBus | null;
  dispatcher: Dispatcher | null;
  logger: OrchestratorLogger;
  runDir: string;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Main orchestrator that implements GoOrchestrator.
 * Combines TeamProvisioner, TaskCoordinator, and HealthManager.
 */
export class Orchestrator implements GoOrchestrator {
  private readonly taskStore: TaskStore;
  private readonly wsHub: WSHub;
  private readonly containerManager: ContainerManager | null;
  private readonly orgChart: OrgChart;
  private readonly configLoader: ConfigLoader;
  private readonly heartbeatMonitor: HeartbeatMonitor | null;
  private readonly eventBus: EventBus | null;
  private readonly runDir: string;
  // Kept for future use in dispatcher integration; present in deps but not yet used.
  private readonly logger: OrchestratorLogger;

  // Mutexes for concurrent-safe operations
  private readonly teamMutex = new Mutex();
  private readonly taskDispatchMutex = new Mutex();
  private readonly orgChartMutex = new Mutex();

  // Lifecycle state
  private started = false;
  private stopped = false;
  private staleReaperTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: OrchestratorDeps) {
    this.taskStore = deps.taskStore;
    this.wsHub = deps.wsHub;
    this.containerManager = deps.containerManager;
    this.orgChart = deps.orgChart;
    this.configLoader = deps.configLoader;
    this.heartbeatMonitor = deps.heartbeatMonitor;
    this.eventBus = deps.eventBus;
    this.runDir = deps.runDir;
    // deps.dispatcher is kept in OrchestratorDeps for future use; not stored yet.
    this.logger = deps.logger;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Starts the heartbeat monitor and stale task reaper.
   * Idempotent — repeated calls are no-ops.
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    // Wire heartbeat unhealthy callback.
    if (this.heartbeatMonitor !== null) {
      this.heartbeatMonitor.setOnUnhealthy((teamID: string) => {
        this.handleUnhealthy(teamID).catch((err: unknown) => {
          this.logger.error('failed to handle unhealthy team', {
            team_id: teamID,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      });
      this.heartbeatMonitor.startMonitoring();
      this.logger.info('heartbeat monitor started');
    }

    // Start stale task reaper interval.
    this.staleReaperTimer = setInterval(() => {
      this.reapStaleTasks().catch((err: unknown) => {
        this.logger.error('stale reaper error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, STALE_REAPER_INTERVAL_MS);

    this.logger.info('stale task reaper started', {
      interval_ms: STALE_REAPER_INTERVAL_MS,
      timeout_ms: STALE_TASK_TIMEOUT_MS,
    });
  }

  /**
   * Stops the heartbeat monitor and clears the stale task reaper.
   * Idempotent — repeated calls are no-ops.
   */
  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;

    if (this.heartbeatMonitor !== null) {
      this.heartbeatMonitor.stopMonitoring();
      this.logger.info('heartbeat monitor stopped');
    }

    if (this.staleReaperTimer !== null) {
      clearInterval(this.staleReaperTimer);
      this.staleReaperTimer = null;
    }

    this.logger.info('stale task reaper stopped');
  }

  // -------------------------------------------------------------------------
  // Private: reapStaleTasks
  // -------------------------------------------------------------------------

  /**
   * Finds tasks stuck in 'running' state beyond STALE_TASK_TIMEOUT_MS and
   * marks them as failed.
   */
  private async reapStaleTasks(): Promise<void> {
    let tasks: Task[];
    try {
      tasks = await this.taskStore.listByStatus('running');
    } catch (err) {
      this.logger.error('stale reaper: failed to list running tasks', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const threshold = new Date(Date.now() - STALE_TASK_TIMEOUT_MS);

    for (const task of tasks) {
      if (task.updated_at < threshold) {
        const now = new Date();
        const updated: Task = {
          ...task,
          status: 'failed',
          error: 'task timed out: exceeded stale task threshold',
          updated_at: now,
          completed_at: now,
        };

        try {
          await this.taskStore.update(updated);
        } catch (updateErr: unknown) {
          this.logger.error('stale reaper: failed to mark task as failed', {
            task_id: task.id,
            error: updateErr instanceof Error ? updateErr.message : String(updateErr),
          });
          continue;
        }

        this.logger.warn('stale reaper: marked stale task as failed', {
          task_id: task.id,
          team_slug: task.team_slug,
        });

        if (this.eventBus !== null) {
          this.eventBus.publish({
            type: 'task_failed',
            payload: {
              kind: 'task_failed',
              task_id: task.id,
              error: updated.error ?? 'task timed out: exceeded stale task threshold',
            },
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // TeamProvisioner
  // -------------------------------------------------------------------------

  /**
   * Validates inputs, creates the team config, and provisions a container.
   */
  async createTeam(slug: string, leaderAID: string): Promise<Team> {
    validateSlug(slug);
    validateAID(leaderAID);

    if (isReservedSlug(slug)) {
      throw new ValidationError('slug', `slug "${slug}" is reserved`);
    }

    return this.teamMutex.runExclusive(async () => {
      // Verify leader exists in OrgChart.
      try {
        this.orgChart.getAgentByAID(leaderAID);
      } catch {
        throw new ValidationError('leader_aid', `agent ${leaderAID} does not exist`);
      }

      // Check slug uniqueness.
      try {
        const existing = this.orgChart.getTeamBySlug(slug);
        if (existing !== null && existing !== undefined) {
          throw new ConflictError('team', `team ${slug} already exists`);
        }
      } catch (err) {
        if (err instanceof ConflictError) {
          throw err;
        }
        // NotFoundError from getTeamBySlug means slug is free — continue.
      }

      // Generate TID.
      const slugPrefix = slug.slice(0, 8);
      const shortID = crypto.randomUUID().slice(0, 8);
      const tid = `tid-${slugPrefix}-${shortID}`;

      const team: Team = {
        tid,
        slug,
        leader_aid: leaderAID,
      };

      // Create directory and save config.
      await this.configLoader.createTeamDir(slug);
      await this.configLoader.saveTeam(slug, team);

      // Scaffold workspace directory structure (best-effort).
      try {
        await scaffoldTeamWorkspace(this.runDir, slug);
      } catch (err: unknown) {
        this.logger.warn('failed to scaffold workspace for new team', {
          slug,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Provision container (best-effort).
      if (this.containerManager !== null) {
        try {
          await this.containerManager.provisionTeam(slug, {});
        } catch (err: unknown) {
          this.logger.warn('failed to provision container for new team', {
            slug,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Rebuild OrgChart (best-effort).
      try {
        await this.rebuildOrgChart();
      } catch (err: unknown) {
        this.logger.warn('failed to rebuild orgchart after CreateTeam', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Publish event.
      if (this.eventBus !== null) {
        this.eventBus.publish({
          type: 'team_created',
          payload: { kind: 'team_created', team_id: tid },
        });
      }

      this.logger.info('team created', { slug, tid, leader_aid: leaderAID });
      return team;
    });
  }

  /**
   * Stops the container and removes the team config directory.
   */
  async deleteTeam(slug: string): Promise<void> {
    validateSlug(slug);

    return this.teamMutex.runExclusive(async () => {
      // Verify team exists and get TID for event.
      let tid: string;
      let leaderAID: string;
      try {
        const team = this.orgChart.getTeamBySlug(slug);
        tid = team.tid;
        leaderAID = team.leader_aid;
      } catch {
        throw new NotFoundError('team', slug);
      }

      // Step 1: Capture leader info EARLY (before cleanup invalidates orgchart).
      let leaderAgent: Agent | undefined;
      let leaderParentSlug: string | undefined;
      let leaderOtherTeams: string[] = [];
      try {
        leaderAgent = this.orgChart.getAgentByAID(leaderAID);
        leaderOtherTeams = this.orgChart.getLeadTeams(leaderAID).filter((s) => s !== slug);
        try {
          const parentTeam = this.orgChart.getTeamForAgent(leaderAID);
          leaderParentSlug = parentTeam.slug;
        } catch {
          // Top-level agent in master.agents — parent is 'main'
          leaderParentSlug = 'main';
        }
      } catch {
        this.logger.warn('leader not found in orgchart during deleteTeam, skipping leader cleanup', {
          slug,
          leader_aid: leaderAID,
        });
      }

      // Step 2: Existing cleanup.

      // Stop and remove container (best-effort).
      if (this.containerManager !== null) {
        try {
          await this.containerManager.removeTeam(slug);
        } catch (err: unknown) {
          this.logger.warn('failed to remove container for team', {
            slug,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Cancel/fail in-progress tasks before removing workspace.
      const tasks = await this.taskStore.listByTeam(slug);
      for (const task of tasks) {
        if (task.status === 'pending' || task.status === 'running') {
          await this.taskStore.update({
            ...task,
            status: 'failed',
            error: 'team deleted',
            updated_at: new Date(),
            completed_at: new Date(),
          });
        }
      }

      // Validation errors propagate — fail-secure.
      // Throws ValidationError on path traversal or symlink attack.
      const workspacePath = validateWorkspacePath(this.runDir, slug);

      // Narrow catch: only tolerate ENOENT (directory already gone).
      try {
        await rm(workspacePath, { recursive: true });
      } catch (err) {
        if (isNodeError(err) && err.code === 'ENOENT') {
          this.logger.warn('workspace already removed', { slug });
        } else {
          throw err; // unexpected filesystem error — propagate
        }
      }

      // Remove config directory.
      await this.configLoader.deleteTeamDir(slug);

      // Rebuild OrgChart (best-effort).
      try {
        await this.rebuildOrgChart();
      } catch (err: unknown) {
        this.logger.warn('failed to rebuild orgchart after DeleteTeam', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Step 3: Best-effort leader cleanup AFTER all core cleanup succeeds.
      if (leaderAgent !== undefined) {
        // Never delete the main assistant.
        if (leaderAID === 'aid-main-001') {
          this.logger.info('skipping leader cleanup for main assistant', { leader_aid: leaderAID });
        } else if (leaderOtherTeams.length > 0) {
          this.logger.info('leader leads other teams, skipping deletion', {
            leader_aid: leaderAID,
            other_teams: leaderOtherTeams,
          });
        } else {
          try {
            // Remove leader from parent config.
            if (leaderParentSlug === 'main') {
              const master = await this.configLoader.loadMaster();
              master.agents = (master.agents ?? []).filter((a) => a.aid !== leaderAID);
              await this.configLoader.saveMaster(master);
            } else if (leaderParentSlug !== undefined) {
              const parentTeam = await this.configLoader.loadTeam(leaderParentSlug);
              parentTeam.agents = (parentTeam.agents ?? []).filter((a) => a.aid !== leaderAID);
              await this.configLoader.saveTeam(leaderParentSlug, parentTeam);
            }

            // Delete leader's .md from parent workspace.
            try {
              const wsSlug = leaderParentSlug === 'main' ? 'main' : (leaderParentSlug ?? 'main');
              const agentFileName = `${slugifyName(leaderAgent.name)}.md`;
              const filePath = joinPath(this.runDir, 'teams', wsSlug, '.claude', 'agents', agentFileName);
              await unlink(filePath);
            } catch (err) {
              if (isNodeError(err) && err.code === 'ENOENT') {
                this.logger.warn('leader .md already removed', { leader_aid: leaderAID });
              } else {
                this.logger.warn('failed to delete leader .md file', { leader_aid: leaderAID, error: String(err) });
              }
            }

            // Rebuild orgchart again (config changed).
            try {
              await this.rebuildOrgChart();
            } catch (err) {
              this.logger.warn('failed to rebuild orgchart after leader cleanup', {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          } catch (err) {
            this.logger.warn('failed to clean up leader agent during deleteTeam', {
              leader_aid: leaderAID,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // Publish event.
      if (this.eventBus !== null) {
        this.eventBus.publish({
          type: 'team_deleted',
          payload: { kind: 'team_deleted', team_id: tid },
        });
      }

      this.logger.info('team deleted', { slug });
    });
  }

  /**
   * Returns the team configuration for the given slug.
   */
  async getTeam(slug: string): Promise<Team> {
    validateSlug(slug);
    return this.configLoader.loadTeam(slug);
  }

  /**
   * Returns all teams from the OrgChart.
   */
  async listTeams(): Promise<Team[]> {
    const chart = this.orgChart.getOrgChart();
    return Object.values(chart);
  }

  /**
   * Updates whitelisted fields of a team configuration.
   * Only 'env_vars' and 'container_config' are updatable.
   */
  async updateTeam(slug: string, updates: Record<string, import('../domain/types.js').JsonValue>): Promise<Team> {
    validateSlug(slug);

    const team = await this.configLoader.loadTeam(slug);

    for (const [field, value] of Object.entries(updates)) {
      switch (field) {
        case 'env_vars': {
          // value must be Record<string, string>
          if (
            typeof value !== 'object' ||
            value === null ||
            Array.isArray(value) ||
            !Object.values(value as Record<string, import('../domain/types.js').JsonValue>).every(
              (v) => typeof v === 'string',
            )
          ) {
            throw new ValidationError('env_vars', 'must be a string map');
          }
          team.env_vars = value as Record<string, string>;
          break;
        }
        case 'container_config': {
          // value must be a plain object (ContainerConfig shape)
          if (
            typeof value !== 'object' ||
            value === null ||
            Array.isArray(value)
          ) {
            throw new ValidationError('container_config', 'must be a ContainerConfig');
          }
          team.container_config = value as import('../domain/types.js').ContainerConfig;
          break;
        }
        default:
          throw new ValidationError(field, `field "${field}" is not updatable`);
      }
    }

    await this.configLoader.saveTeam(slug, team);
    this.logger.info('team updated', { slug });
    return team;
  }

  // -------------------------------------------------------------------------
  // TaskCoordinator
  // -------------------------------------------------------------------------

  /**
   * Validates the target agent via OrgChart, ensures the container is running,
   * and dispatches the task via WebSocket.
   */
  async dispatchTask(task: Task): Promise<void> {
    if (!task.agent_aid || task.agent_aid === '') {
      throw new ValidationError('agent_aid', 'agent_aid is required');
    }
    if (!task.prompt || task.prompt === '') {
      throw new ValidationError('prompt', 'prompt is required');
    }

    return this.taskDispatchMutex.runExclusive(async () => {
      // Validate target agent exists in OrgChart.
      try {
        this.orgChart.getAgentByAID(task.agent_aid!);
      } catch {
        throw new NotFoundError('agent', task.agent_aid!);
      }

      // Resolve team for target agent.
      let targetTeam: Team;
      try {
        targetTeam = this.orgChart.getTeamForAgent(task.agent_aid!);
      } catch {
        throw new ValidationError('agent_aid', `agent ${task.agent_aid!} is not in any team`);
      }

      // Set task fields.
      if (!task.id || task.id === '') {
        task.id = crypto.randomUUID();
      }
      const now = new Date();
      if (!task.created_at || task.created_at.getTime() === 0) {
        task.created_at = now;
      }
      task.updated_at = now;
      task.team_slug = targetTeam.slug;
      task.status = 'pending';

      // Persist task.
      await this.taskStore.create(task);

      // Ensure container is running.
      if (this.containerManager !== null) {
        try {
          await this.containerManager.ensureRunning(targetTeam.slug);
        } catch (err: unknown) {
          this.logger.warn('failed to ensure container running', {
            task_id: task.id,
            team: targetTeam.slug,
            error: err instanceof Error ? err.message : String(err),
          });
          // Task persisted; container may come online later.
          return;
        }
      }

      // Dispatch via WS.
      const dispatchMsg: TaskDispatchMsg = {
        task_id: task.id,
        agent_aid: task.agent_aid!,
        prompt: task.prompt,
      };
      const encoded = encodeMessage(MsgTypeTaskDispatch, dispatchMsg);

      try {
        await this.wsHub.sendToTeam(targetTeam.slug, encoded);
      } catch (err: unknown) {
        this.logger.warn('failed to dispatch task to container', {
          task_id: task.id,
          team: targetTeam.slug,
          error: err instanceof Error ? err.message : String(err),
        });
        return; // Task persisted; can be retried.
      }

      // Mark as running.
      const updatedTask: Task = {
        ...task,
        status: 'running',
        updated_at: new Date(),
      };
      try {
        await this.taskStore.update(updatedTask);
        // Mutate original task object to reflect running state.
        task.status = 'running';
        task.updated_at = updatedTask.updated_at;
      } catch (err: unknown) {
        this.logger.error('failed to update task status to running', {
          task_id: task.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Publish event.
      if (this.eventBus !== null) {
        this.eventBus.publish({
          type: 'task_created',
          payload: { kind: 'task_created', task },
        });
      }

      this.logger.info('task dispatched', {
        task_id: task.id,
        team: targetTeam.slug,
        agent: task.agent_aid,
      });
    });
  }

  /**
   * Processes a task result: stores it, checks if all sibling subtasks
   * are complete, and triggers consolidation if so.
   */
  async handleTaskResult(taskID: string, result: string, errMsg: string): Promise<void> {
    const task = await this.taskStore.get(taskID);

    const now = new Date();
    let updated: Task;

    if (errMsg !== '') {
      updated = {
        ...task,
        status: 'failed',
        error: errMsg,
        updated_at: now,
        completed_at: now,
      };
    } else {
      updated = {
        ...task,
        status: 'completed',
        result,
        updated_at: now,
        completed_at: now,
      };
    }

    await this.taskStore.update(updated);

    // Publish event.
    if (this.eventBus !== null) {
      if (updated.status === 'failed') {
        this.eventBus.publish({
          type: 'task_failed',
          payload: {
            kind: 'task_failed',
            task_id: taskID,
            error: errMsg,
          },
        });
      } else {
        this.eventBus.publish({
          type: 'task_completed',
          payload: {
            kind: 'task_completed',
            task_id: taskID,
            result: {
              task_id: taskID,
              status: 'completed',
              result,
              duration: now.getTime() - task.created_at.getTime(),
            },
          },
        });
      }
    }

    // If this task has a parent, check if all sibling subtasks are complete.
    if (task.parent_id && task.parent_id !== '') {
      try {
        await this.checkAndConsolidateSubtasks(task.parent_id);
      } catch (err: unknown) {
        this.logger.error('failed to consolidate subtasks', {
          parent_task_id: task.parent_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.logger.info('task result processed', {
      task_id: taskID,
      status: updated.status,
    });
  }

  /**
   * Checks if all subtasks of parentID are terminal, and if so,
   * updates the parent task with consolidated results.
   */
  private async checkAndConsolidateSubtasks(parentID: string): Promise<void> {
    const subtasks = await this.taskStore.getSubtree(parentID);

    // Filter to direct children only.
    const children = subtasks.filter((t) => t.parent_id === parentID);

    if (children.length === 0) {
      return;
    }

    // Check if all children are terminal.
    const allDone = children.every(
      (child) => child.status !== 'pending' && child.status !== 'running',
    );

    if (!allDone) {
      return;
    }

    // All subtasks are terminal — consolidate results.
    const results: string[] = [];
    let anyFailed = false;

    for (const child of children) {
      if (child.status === 'completed' && child.result && child.result !== '') {
        const shortID = child.id.length > 8 ? child.id.slice(0, 8) : child.id;
        results.push(`[${shortID}] ${child.result}`);
      } else if (child.status === 'failed') {
        anyFailed = true;
      }
    }

    // Load parent task and update with consolidated result.
    const parent = await this.taskStore.get(parentID);
    const now = new Date();

    let updatedParent: Task;
    if (anyFailed && results.length === 0) {
      updatedParent = {
        ...parent,
        status: 'failed',
        error: 'one or more subtasks failed',
        updated_at: now,
        completed_at: now,
      };
    } else {
      updatedParent = {
        ...parent,
        status: 'completed',
        result: results.join('\n---\n'),
        updated_at: now,
        completed_at: now,
      };
    }

    await this.taskStore.update(updatedParent);

    if (this.eventBus !== null) {
      if (updatedParent.status === 'failed') {
        this.eventBus.publish({
          type: 'task_failed',
          payload: {
            kind: 'task_failed',
            task_id: parentID,
            error: updatedParent.error ?? 'one or more subtasks failed',
          },
        });
      } else {
        this.eventBus.publish({
          type: 'task_completed',
          payload: {
            kind: 'task_completed',
            task_id: parentID,
            result: {
              task_id: parentID,
              status: 'completed',
              result: updatedParent.result,
              duration: now.getTime() - parent.created_at.getTime(),
            },
          },
        });
      }
    }

    this.logger.info('subtask results consolidated', {
      parent_task_id: parentID,
      subtask_count: children.length,
      consolidated_status: updatedParent.status,
    });
  }

  /**
   * Updates the task status to cancelled and sends a shutdown signal.
   */
  async cancelTask(taskID: string): Promise<void> {
    const task = await this.taskStore.get(taskID);

    if (
      task.status === 'completed' ||
      task.status === 'failed' ||
      task.status === 'cancelled'
    ) {
      throw new ValidationError(
        'task_id',
        `task ${taskID} is already ${task.status}`,
      );
    }

    const now = new Date();
    const updated: Task = {
      ...task,
      status: 'cancelled',
      updated_at: now,
      completed_at: now,
    };

    await this.taskStore.update(updated);

    // Send cancel signal to container.
    if (task.team_slug && task.team_slug !== '') {
      const cancelMsg: ShutdownMsg = {
        reason: `task ${taskID} cancelled`,
        timeout: 5,
      };
      try {
        const encoded = encodeMessage(MsgTypeShutdown, cancelMsg);
        await this.wsHub.sendToTeam(task.team_slug, encoded);
      } catch (err: unknown) {
        this.logger.warn('failed to send cancel to container', {
          task_id: taskID,
          team: task.team_slug,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (this.eventBus !== null) {
      this.eventBus.publish({
        type: 'task_cancelled',
        payload: { kind: 'task_cancelled', task_id: taskID },
      });
    }

    this.logger.info('task cancelled', { task_id: taskID });
  }

  /**
   * Returns the current task from the store.
   */
  async getTaskStatus(taskID: string): Promise<Task> {
    return this.taskStore.get(taskID);
  }

  /**
   * Creates subtasks for the given parent and dispatches each.
   */
  async createSubtasks(parentID: string, prompts: string[], teamSlug: string): Promise<Task[]> {
    if (!parentID || parentID === '') {
      throw new ValidationError('parent_id', 'parent_id is required');
    }
    if (prompts.length === 0) {
      throw new ValidationError('prompts', 'at least one prompt is required');
    }
    validateSlug(teamSlug);

    // Verify parent exists.
    const parent = await this.taskStore.get(parentID);

    // Resolve team leader as default dispatch target.
    let team: Team;
    try {
      team = this.orgChart.getTeamBySlug(teamSlug);
    } catch {
      throw new NotFoundError('team', teamSlug);
    }

    const tasks: Task[] = [];
    for (let i = 0; i < prompts.length; i++) {
      const prompt = prompts[i]!;
      const now = new Date();
      const subtask: Task = {
        id: crypto.randomUUID(),
        parent_id: parent.id,
        team_slug: teamSlug,
        agent_aid: team.leader_aid,
        status: 'pending',
        prompt,
        created_at: now,
        updated_at: now,
        completed_at: null,
      };

      try {
        await this.dispatchTask(subtask);
        tasks.push(subtask);
      } catch (err: unknown) {
        this.logger.error('failed to dispatch subtask', {
          parent_id: parentID,
          index: i,
          error: err instanceof Error ? err.message : String(err),
        });
        // Continue — failures should not abort the others.
      }
    }

    this.logger.info('subtasks created', {
      parent_id: parentID,
      requested: prompts.length,
      dispatched: tasks.length,
    });
    return tasks;
  }

  // -------------------------------------------------------------------------
  // HealthManager
  // -------------------------------------------------------------------------

  /**
   * Returns the latest heartbeat status for a team.
   * Throws NotFoundError if heartbeatMonitor is null.
   */
  getHealthStatus(teamSlug: string): HeartbeatStatus {
    if (this.heartbeatMonitor === null) {
      throw new NotFoundError('heartbeat_status', teamSlug);
    }
    return this.heartbeatMonitor.getStatus(teamSlug);
  }

  /**
   * Triggers a container restart when a team becomes unhealthy.
   */
  async handleUnhealthy(teamID: string): Promise<void> {
    this.logger.warn('handling unhealthy team', { team_id: teamID });

    if (this.containerManager === null) {
      this.logger.warn('no container manager configured, cannot restart team', {
        team_id: teamID,
      });
      return;
    }

    await this.containerManager.restartTeam(teamID);
    this.logger.info('unhealthy team restarted', { team_id: teamID });

    if (this.eventBus !== null) {
      this.eventBus.publish({
        type: 'container_state_changed',
        payload: {
          kind: 'container_state_changed',
          team_id: teamID,
          state: 'starting',
        },
      });
    }
  }

  /**
   * Returns all team heartbeat statuses.
   */
  getAllStatuses(): Record<string, HeartbeatStatus> {
    if (this.heartbeatMonitor === null) {
      return {};
    }
    return this.heartbeatMonitor.getAllStatuses();
  }

  // -------------------------------------------------------------------------
  // Private: rebuildOrgChart
  // -------------------------------------------------------------------------

  /**
   * Reloads all configs and rebuilds the in-memory OrgChart.
   */
  private async rebuildOrgChart(): Promise<void> {
    return this.orgChartMutex.runExclusive(async () => {
      let master: MasterConfig;
      try {
        master = this.configLoader.getMaster();
      } catch {
        master = await this.configLoader.loadMaster();
      }

      const slugs = await this.configLoader.listTeams();
      const teams: Record<string, Team> = {};

      for (const slug of slugs) {
        try {
          const team = await this.configLoader.loadTeam(slug);
          teams[slug] = team;
        } catch (err: unknown) {
          this.logger.warn('failed to load team during orgchart rebuild', {
            slug,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      this.orgChart.rebuildFromConfig(master, teams);
    });
  }
}

// ---------------------------------------------------------------------------
// copyFileWithContainment
// ---------------------------------------------------------------------------

/**
 * Copies a file from srcRoot/relPath to destRoot/relPath, enforcing that both
 * the source and destination are within their respective workspace roots.
 *
 * Rejects path traversal attempts (relPath containing '..', URL-encoded dot
 * sequences such as '%2e%2e', or absolute paths). The resolve-based containment
 * check at the end is the authoritative defense; the early-out checks provide
 * explicit, readable rejection before any filesystem operations.
 */
export async function copyFileWithContainment(
  srcRoot: string,
  destRoot: string,
  relPath: string,
): Promise<void> {
  // Reject '..' components.
  if (relPath.includes('..')) {
    throw new Error(`path traversal rejected: "${relPath}" contains '..'`);
  }
  // Reject URL-encoded traversal sequences (%2e%2e is URL-encoding of ..).
  if (relPath.toLowerCase().includes('%2e')) {
    throw new Error(`path traversal rejected: "${relPath}" contains URL-encoded dot sequence`);
  }
  // Reject absolute paths.
  if (isAbsolute(relPath)) {
    throw new Error(`path traversal rejected: absolute path not allowed: "${relPath}"`);
  }

  const srcAbs = resolvePath(joinPath(srcRoot, relPath));
  const destAbs = resolvePath(joinPath(destRoot, relPath));

  const cleanSrcRoot = resolvePath(srcRoot);
  const cleanDestRoot = resolvePath(destRoot);

  // Validate containment: resolved path must be under the declared root.
  if (!srcAbs.startsWith(cleanSrcRoot + sep) && srcAbs !== cleanSrcRoot) {
    throw new Error(
      `path containment violation: source "${srcAbs}" escapes root "${cleanSrcRoot}"`,
    );
  }
  if (!destAbs.startsWith(cleanDestRoot + sep) && destAbs !== cleanDestRoot) {
    throw new Error(
      `path containment violation: destination "${destAbs}" escapes root "${cleanDestRoot}"`,
    );
  }

  // Ensure destination directory exists.
  mkdirSync(dirname(destAbs), { recursive: true });

  // Perform copy via stream pipeline.
  await pipeline(
    createReadStream(srcAbs),
    createWriteStream(destAbs, { flags: 'w', mode: 0o600 }),
  );
}

// ---------------------------------------------------------------------------
// isNodeError
// ---------------------------------------------------------------------------

/**
 * Type guard that narrows an unknown catch value to NodeJS.ErrnoException.
 * Checks for the presence of a `code` property (string) which is the
 * canonical way Node.js filesystem errors carry their POSIX error code.
 */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    'code' in err &&
    typeof (err as NodeJS.ErrnoException).code === 'string'
  );
}

// ---------------------------------------------------------------------------
// validateWorkspacePath
// ---------------------------------------------------------------------------

/**
 * Validates and resolves the workspace path for a team slug under
 * `<runDir>/teams/<slug>/`.
 *
 * Security checks (in order):
 *   1. Resolve absolute paths for both teamsRoot and target.
 *   2. Containment check — target must start with teamsRoot + sep.
 *   3. Symlink detection for EXISTING paths via lstatSync.
 *   4. For NON-EXISTENT paths, walk ancestor directories up to teamsRoot
 *      and reject any existing ancestor that is a symlink.
 *
 * IMPORTANT: Does NOT call isReservedSlug. This is purely a filesystem
 * security function (containment + symlink rejection). Reserved slug
 * blocking is handled separately in createTeam/makeCreateTeam.
 *
 * Returns the resolved absolute path if safe.
 * Throws ValidationError on containment violations or symlink detection.
 * Re-throws unexpected filesystem errors (EACCES, etc.).
 */
export function validateWorkspacePath(runDir: string, slug: string): string {
  // Step 1: Resolve absolute paths.
  const teamsRoot = resolvePath(joinPath(runDir, 'teams'));
  const targetPath = resolvePath(joinPath(teamsRoot, slug));

  // Step 2: Containment check — target must be directly under teamsRoot.
  if (!targetPath.startsWith(teamsRoot + sep)) {
    throw new ValidationError(
      'workspace_path',
      `path containment violation: "${targetPath}" escapes "${teamsRoot}"`,
    );
  }

  // Step 3: Symlink detection for EXISTING paths.
  // Use lstatSync (not statSync) — statSync follows symlinks and would not detect them.
  try {
    const stat = lstatSync(targetPath);
    if (stat.isSymbolicLink()) {
      throw new ValidationError(
        'workspace_path',
        `symlink rejected: "${targetPath}" is a symbolic link`,
      );
    }
    // Path exists and is not a symlink — valid.
    return targetPath;
  } catch (err) {
    // If ENOENT, path does not exist — proceed to Step 4.
    if (!isNodeError(err) || err.code !== 'ENOENT') {
      throw err; // Re-throw unexpected errors (EACCES, etc.).
    }
  }

  // Step 4: For NON-EXISTENT paths, walk parent directories up to teamsRoot
  // checking each existing ancestor for symlinks.
  // This prevents attacks where a parent directory is a symlink pointing
  // outside the workspace.
  let current = targetPath;
  while (current !== teamsRoot) {
    const parent = dirname(current);
    if (parent === current) {
      // Reached filesystem root without finding teamsRoot — should not
      // happen given Step 2 passed, but guard defensively.
      break;
    }
    current = parent;

    try {
      const parentStat = lstatSync(current);
      if (parentStat.isSymbolicLink()) {
        throw new ValidationError(
          'workspace_path',
          `symlink rejected: ancestor "${current}" is a symbolic link`,
        );
      }
      // Found an existing non-symlink ancestor — safe.
      // All directories from here down to targetPath will be created
      // by mkdir({recursive:true}), which creates real directories.
      break;
    } catch (err) {
      if (!isNodeError(err) || err.code !== 'ENOENT') {
        throw err;
      }
      // Parent also does not exist — continue walking up.
    }
  }

  // Path is safe (non-existent, but all existing ancestors are real dirs).
  return targetPath;
}

// ---------------------------------------------------------------------------
// scaffoldTeamWorkspace
// ---------------------------------------------------------------------------

/**
 * Creates the standard workspace directory structure for a team under
 * `<runDir>/teams/<slug>/` and writes the initial CLAUDE.md and
 * .claude/settings.json files.
 *
 * Directory structure created:
 *   <runDir>/teams/<slug>/
 *   <runDir>/teams/<slug>/.claude/agents/
 *   <runDir>/teams/<slug>/.claude/skills/
 *   <runDir>/teams/<slug>/work/tasks/
 *
 * Files written:
 *   <runDir>/teams/<slug>/CLAUDE.md  — team name heading
 *   <runDir>/teams/<slug>/.claude/settings.json  — {"allowedTools":[]}
 *
 * Calls validateWorkspacePath first to enforce containment and symlink checks.
 * Idempotent — re-calling with the same slug is a no-op (mkdir recursive).
 */
/**
 * Options for scaffoldTeamWorkspace. All optional — defaults produce the
 * standard minimal scaffold.
 */
export interface ScaffoldOptions {
  /** Optional path to main-assistant/.claude/skills/ to copy into the team workspace. */
  skillsSourceDir?: string;
  /** Optional description of the team leader for CLAUDE.md context. */
  leaderDescription?: string;
}

export async function scaffoldTeamWorkspace(
  runDir: string,
  slug: string,
  options?: ScaffoldOptions,
): Promise<void> {
  const workspaceDir = validateWorkspacePath(runDir, slug);

  // Create all required directories.
  await mkdir(joinPath(workspaceDir, '.claude', 'agents'), { recursive: true, mode: 0o755 });
  await mkdir(joinPath(workspaceDir, '.claude', 'skills'), { recursive: true, mode: 0o755 });
  await mkdir(joinPath(workspaceDir, 'work', 'tasks'), { recursive: true, mode: 0o755 });

  // Write enriched CLAUDE.md with team context and SDK tool skill index.
  const teamDisplayName = slugToDisplayName(slug);
  const claudeMdContent = buildTeamClaudeMd(teamDisplayName, slug, options?.leaderDescription);
  await writeFile(joinPath(workspaceDir, 'CLAUDE.md'), claudeMdContent, { mode: 0o644 });

  // Write .claude/settings.json with empty allowedTools.
  const settingsContent = JSON.stringify({ allowedTools: [] }, null, 2) + '\n';
  await writeFile(joinPath(workspaceDir, '.claude', 'settings.json'), settingsContent, {
    mode: 0o644,
  });

  // Copy SDK tool skill files from main-assistant template if available.
  if (options?.skillsSourceDir && existsSync(options.skillsSourceDir)) {
    const destSkillsDir = joinPath(workspaceDir, '.claude', 'skills');
    await cp(options.skillsSourceDir, destSkillsDir, {
      recursive: true,
      force: false,
    });
  }
}

/**
 * Generates the CLAUDE.md content for a team workspace.
 * Includes role context and SDK tool skill index for recursive design.
 */
function buildTeamClaudeMd(
  displayName: string,
  slug: string,
  leaderDescription?: string,
): string {
  const leaderContext = leaderDescription
    ? `\nTeam Leader: ${leaderDescription}\n`
    : '';

  return `# ${displayName}
${leaderContext}
This team's orchestrator has the same capabilities as the main assistant.
It can create agents, dispatch tasks, create sub-teams, and manage skills.

## For the Team Leader
You delegate work to specialized team members. Do NOT perform tasks yourself.
1. Analyze the task
2. Create workers if needed with create_agent(name, description, team_slug="${slug}")
3. Dispatch with dispatch_task_and_wait(agent_aid, prompt)
4. Synthesize results and return
5. If a task requires a specialized sub-team, create one (recursive)

## For Team Members
Complete assigned tasks thoroughly. Focus on your specialty.
If a task is too complex, you can create sub-teams using SDK tools.

## Available Skills
Use load_skill with team_slug="${slug}" to load any skill.

### Team & Agent Management
| Skill | Description |
|-------|-------------|
| create-agent | Create a new agent in a team |
| create-team | Create a team with a leader AID |
| delete-team | Delete a team by slug |
| delete-agent | Delete an agent by AID + team_slug |
| update-team | Update team config fields |
| list-teams | List all teams |
| get-team | Get team details by slug |

### Task Management
| Skill | Description |
|-------|-------------|
| dispatch-task | Fire-and-forget task dispatch |
| dispatch-task-and-wait | Dispatch and block until result |
| dispatch-subtask | Dispatch a subtask under a parent task |
| get-task-status | Check task completion status |
| cancel-task | Cancel a running task |
| list-tasks | List tasks (optionally by team) |
| consolidate-results | Consolidate subtask results |
| escalate | Escalate a task to parent |

### Skills & Configuration
| Skill | Description |
|-------|-------------|
| create-skill | Create a skill definition |
| load-skill | Load a skill for use |
| get-config | Read system configuration |
| update-config | Write system configuration |
| get-system-status | System health check |
| get-member-status | Agent/member health status |
`;
}

// ---------------------------------------------------------------------------
// copyMainAssistantWorkspace
// ---------------------------------------------------------------------------

/**
 * Copies the static main-assistant/ directory into the target workspace.
 * Used to populate the main assistant workspace from the git-tracked template.
 *
 * @param srcDir  - Path to the static main-assistant/ directory.
 * @param destDir - Path to the target workspace (e.g. .run/teams/main/).
 * @param force   - If true, overwrites existing files. If false, only copies
 *                  files that don't already exist in the destination.
 *
 * Validates the source directory exists before copying.
 * On force=false, uses `cp` with `force: false` which skips existing files.
 */
export async function copyMainAssistantWorkspace(
  srcDir: string,
  destDir: string,
  force: boolean,
): Promise<void> {
  const resolvedSrc = resolvePath(srcDir);
  if (!existsSync(resolvedSrc)) {
    throw new Error(`main-assistant source directory not found: ${resolvedSrc}`);
  }

  const resolvedDest = resolvePath(destDir);

  // Ensure destination exists.
  await mkdir(resolvedDest, { recursive: true });

  // Copy recursively. force=false preserves existing files (user modifications).
  await cp(resolvedSrc, resolvedDest, {
    recursive: true,
    force,
  });
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Creates a new Orchestrator with the given dependencies.
 */
export function newOrchestrator(deps: OrchestratorDeps): Orchestrator {
  return new Orchestrator(deps);
}
