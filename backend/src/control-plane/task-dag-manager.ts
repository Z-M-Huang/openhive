import type { Task } from '../domain/domain.js';
import { TaskStatus } from '../domain/enums.js';
import type { EscalationReason } from '../domain/enums.js';
import { assertValidTransition } from '../domain/domain.js';
import type {
  TaskStore,
  OrgChart,
  WSHub,
  EventBus,
  Logger,
} from '../domain/interfaces.js';

/**
 * Per-parent-task mutex to prevent race conditions from concurrent subtask completions (RISK-34).
 * Simple promise-based lock keyed by parent_task_id.
 */
class MutexMap {
  private readonly locks = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    // Wait for any existing lock on this key
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }

    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = () => {
        this.locks.delete(key);
        resolve();
      };
    });
    this.locks.set(key, promise);
    return release;
  }
}

/**
 * Manages task dispatch, dependency resolution, and mixed terminal state handling.
 *
 * User Decision #4: Mixed terminal states — when a blocker fails terminally,
 * escalate to lead for decision. Blocked task waits. If user kills failed blocker,
 * cascade kill to blocked tasks. If lead retries, blocked task continues waiting.
 */
export class TaskDAGManager {
  private readonly taskStore: TaskStore;
  private readonly orgChart: OrgChart;
  private readonly wsHub: WSHub;
  private readonly eventBus: EventBus;
  private readonly logger: Logger;
  private readonly onEscalation: (agentAid: string, taskId: string, reason: EscalationReason, context: Record<string, unknown>) => Promise<string>;

  private readonly mutex = new MutexMap();

  constructor(deps: {
    taskStore: TaskStore;
    orgChart: OrgChart;
    wsHub: WSHub;
    eventBus: EventBus;
    logger: Logger;
    onEscalation: (agentAid: string, taskId: string, reason: EscalationReason, context: Record<string, unknown>) => Promise<string>;
  }) {
    this.taskStore = deps.taskStore;
    this.orgChart = deps.orgChart;
    this.wsHub = deps.wsHub;
    this.eventBus = deps.eventBus;
    this.logger = deps.logger;
    this.onEscalation = deps.onEscalation;
  }

  /**
   * Dispatch a task: validate DAG, check not blocked, transition pending->active, send via WS.
   */
  async dispatchTask(task: Task): Promise<void> {
    // Validate dependencies exist
    if (task.blocked_by && task.blocked_by.length > 0) {
      await this.taskStore.validateDependencies(task.id, task.blocked_by);
    }

    // Check if blocked
    const blockers = await this.taskStore.getBlockedBy(task.id);
    if (blockers.length > 0) {
      this.logger.debug('Task blocked, deferring dispatch', {
        task_id: task.id,
        blocked_by: blockers,
      });
      return;
    }

    // Transition pending -> active
    assertValidTransition(task.status, TaskStatus.Active);
    const now = Date.now();
    await this.taskStore.update({
      ...task,
      status: TaskStatus.Active,
      updated_at: now,
    });

    // Send to target container via WS
    const targetAgent = this.orgChart.getAgent(task.agent_aid);
    if (targetAgent) {
      const targetTeam = this.orgChart.getTeamBySlug(targetAgent.teamSlug);
      if (targetTeam && targetTeam.containerId) {
        this.wsHub.send(targetTeam.tid, {
          type: 'task_dispatch',
          data: {
            task_id: task.id,
            agent_aid: task.agent_aid,
            prompt: task.prompt,
            parent_task_id: task.parent_id,
          },
        });
      }
    }

    this.eventBus.publish({
      type: 'task.dispatched',
      data: { task_id: task.id, agent_aid: task.agent_aid },
      timestamp: now,
    });
  }

  /**
   * Handle task result: update store, unblock dependents, handle failure.
   * Uses per-parent-task mutex to prevent race conditions (RISK-34).
   */
  async handleTaskResult(
    taskId: string,
    agentAid: string,
    status: TaskStatus,
    result?: string,
    error?: string,
  ): Promise<void> {
    const task = await this.taskStore.get(taskId);

    // Serialize by parent task to prevent concurrent subtask races
    const mutexKey = task.parent_id || taskId;
    const release = await this.mutex.acquire(mutexKey);

    try {
      await this.processTaskResult(task, agentAid, status, result, error);
    } finally {
      release();
    }
  }

  private async processTaskResult(
    task: Task,
    agentAid: string,
    status: TaskStatus,
    result?: string,
    error?: string,
  ): Promise<void> {
    assertValidTransition(task.status, status);

    const now = Date.now();
    const isTerminal = status === TaskStatus.Completed || status === TaskStatus.Cancelled;

    await this.taskStore.update({
      ...task,
      status,
      result: result ?? task.result,
      error: error ?? task.error,
      updated_at: now,
      completed_at: isTerminal ? now : task.completed_at,
    });

    if (status === TaskStatus.Completed) {
      await this.handleCompletion(task);
    } else if (status === TaskStatus.Failed) {
      await this.handleFailure(task, agentAid, error);
    } else if (status === TaskStatus.Cancelled) {
      await this.handleCancellation(task);
    }
  }

  /** On completion: unblock dependent tasks and auto-dispatch newly unblocked ones. */
  private async handleCompletion(task: Task): Promise<void> {
    // Find tasks that depend on this one via parent subtree
    if (!task.parent_id) return;

    const siblings = await this.taskStore.getSubtree(task.parent_id);
    for (const sibling of siblings) {
      if (sibling.id === task.id) continue;
      if (sibling.status !== TaskStatus.Pending) continue;
      if (!sibling.blocked_by || !sibling.blocked_by.includes(task.id)) continue;

      const unblocked = await this.taskStore.unblockTask(sibling.id, task.id);
      if (unblocked) {
        // Re-fetch to get updated blocked_by
        const updated = await this.taskStore.get(sibling.id);
        await this.dispatchTask(updated);
      }
    }
  }

  /**
   * On failure: retry if possible, otherwise escalate to lead (User Decision #4).
   */
  private async handleFailure(task: Task, agentAid: string, error?: string): Promise<void> {
    if (task.retry_count < task.max_retries) {
      // Retry: transition failed -> pending
      assertValidTransition(TaskStatus.Failed, TaskStatus.Pending);
      await this.taskStore.update({
        ...task,
        status: TaskStatus.Pending,
        retry_count: task.retry_count + 1,
        updated_at: Date.now(),
      });

      const updated = await this.taskStore.get(task.id);
      await this.dispatchTask(updated);
      return;
    }

    // No retries left: escalate to lead for decision (User Decision #4)
    const team = this.orgChart.getTeamBySlug(task.team_slug);
    const leaderAid = team?.leaderAid ?? agentAid;

    await this.onEscalation(leaderAid, task.id, 'error' as EscalationReason, {
      failed_task_id: task.id,
      error: error ?? task.error,
      retries_exhausted: true,
    });
  }

  /**
   * On cancellation: cascade kill to blocked tasks (User Decision #4).
   */
  private async handleCancellation(task: Task): Promise<void> {
    if (!task.parent_id) return;

    const siblings = await this.taskStore.getSubtree(task.parent_id);
    for (const sibling of siblings) {
      if (sibling.id === task.id) continue;
      if (sibling.status !== TaskStatus.Pending) continue;
      if (!sibling.blocked_by || !sibling.blocked_by.includes(task.id)) continue;

      // Cascade cancel
      assertValidTransition(sibling.status, TaskStatus.Cancelled);
      await this.taskStore.update({
        ...sibling,
        status: TaskStatus.Cancelled,
        error: `Cascade: blocker '${task.id}' was cancelled`,
        updated_at: Date.now(),
        completed_at: Date.now(),
      });
    }
  }
}
