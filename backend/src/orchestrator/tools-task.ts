/**
 * OpenHive Backend - Task SDK Tool Handlers
 *
 * Registers task management tool handlers on the ToolHandler.
 * Covers task dispatch, status queries, cancellation, and listing.
 */

import { randomUUID } from 'node:crypto';
import type { TaskStore, WSHub, ContainerManager, OrgChart, TaskCoordinator } from '../domain/interfaces.js';
import type { JsonValue, Task } from '../domain/types.js';
import { ValidationError, NotFoundError } from '../domain/errors.js';
import { validateAID, validateSlug } from '../domain/validation.js';
import { parseTaskStatus } from '../domain/enums.js';
import type { ToolFunc } from './toolhandler.js';
import type { ToolRegistry } from '../domain/interfaces.js';
import type { TaskWaiter } from './task-waiter.js';
import {
  MsgTypeTaskDispatch,
  encodeMessage,
} from '../ws/index.js';
import type { TaskDispatchMsg } from '../ws/index.js';
import { wouldCreateCycle } from '../store/task-store.js';

// ---------------------------------------------------------------------------
// TaskToolsDeps
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into task tool handlers.
 */
export interface TaskToolsDeps {
  taskStore: TaskStore;
  wsHub: WSHub;
  containerManager: ContainerManager | null;
  orgChart: OrgChart;
  taskWaiter: TaskWaiter | null;
  taskCoordinator: TaskCoordinator | null;
  logger: {
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, data?: Record<string, unknown>): void;
  };
}

// ---------------------------------------------------------------------------
// registerTaskTools
// ---------------------------------------------------------------------------

/**
 * Registers all task management SDK custom tool handlers on the ToolHandler.
 *
 * Registers:
 *   dispatch_task    — dispatch without parent_task_id
 *   dispatch_subtask — dispatch with parent_task_id (required)
 *   get_task_status  — get task by ID
 *   cancel_task      — cancel a running task
 *   list_tasks       — list tasks by team or status with optional limit
 */
export function registerTaskTools(handler: ToolRegistry, deps: TaskToolsDeps): void {
  handler.register('dispatch_task', makeDispatchTask(deps));
  handler.register('dispatch_task_and_wait', makeDispatchTaskAndWait(deps));
  handler.register('dispatch_subtask', makeDispatchSubtask(deps));
  handler.register('get_task_status', makeGetTaskStatus(deps));
  handler.register('cancel_task', makeCancelTask(deps));
  handler.register('list_tasks', makeListTasks(deps));
}

// ---------------------------------------------------------------------------
// dispatchTask — shared logic for both dispatch_task and dispatch_subtask
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// UUID format regex for blocked_by validation
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Maximum number of blocked_by dependencies allowed per task. */
const MAX_BLOCKED_BY = 50;

/**
 * Options for DAG-related fields on task dispatch.
 */
interface DispatchDAGOpts {
  blocked_by: string[];
  priority: number;
  max_retries: number;
}

/**
 * Validates blocked_by array entries: non-empty strings, UUID format,
 * max 50 elements, and all referenced tasks must exist in the store.
 */
async function validateBlockedBy(
  blockedBy: string[],
  taskStore: TaskStore,
): Promise<void> {
  if (blockedBy.length > MAX_BLOCKED_BY) {
    throw new ValidationError(
      'blocked_by',
      `blocked_by exceeds maximum of ${MAX_BLOCKED_BY} elements (got ${blockedBy.length})`,
    );
  }

  const invalidFormat: string[] = [];
  for (const id of blockedBy) {
    if (id === '' || !UUID_RE.test(id)) {
      invalidFormat.push(id);
    }
  }
  if (invalidFormat.length > 0) {
    throw new ValidationError(
      'blocked_by',
      `blocked_by contains invalid task IDs (must be UUID format): ${invalidFormat.join(', ')}`,
    );
  }

  // Verify all referenced tasks exist
  const missing: string[] = [];
  for (const id of blockedBy) {
    try {
      await taskStore.get(id);
    } catch {
      missing.push(id);
    }
  }
  if (missing.length > 0) {
    throw new ValidationError(
      'blocked_by',
      `blocked_by references non-existent tasks: ${missing.join(', ')}`,
    );
  }
}

/**
 * Core dispatch logic shared between dispatch_task and dispatch_subtask.
 * Creates the task record, sends it to the container via WebSocket, and
 * updates the task to 'running' if dispatch succeeds.
 */
async function dispatchTaskCore(
  deps: TaskToolsDeps,
  agentAID: string,
  prompt: string,
  parentTaskID: string,
  dagOpts: DispatchDAGOpts = { blocked_by: [], priority: 0, max_retries: 0 },
): Promise<JsonValue> {
  validateAID(agentAID);

  if (prompt === '') {
    throw new ValidationError('prompt', 'prompt is required');
  }

  // Validate blocked_by array
  if (dagOpts.blocked_by.length > 0) {
    await validateBlockedBy(dagOpts.blocked_by, deps.taskStore);
  }

  // Verify agent exists in OrgChart
  let targetAgent;
  try {
    targetAgent = deps.orgChart.getAgentByAID(agentAID);
  } catch {
    throw new NotFoundError('agent', agentAID);
  }

  // Verify agent belongs to a team
  let targetTeam;
  try {
    targetTeam = deps.orgChart.getTeamForAgent(agentAID);
  } catch {
    throw new ValidationError(
      'agent_aid',
      `agent ${agentAID} is not in any team`,
    );
  }

  // Ensure the team container is running
  if (deps.containerManager !== null) {
    await deps.containerManager.ensureRunning(targetTeam.slug);
  }

  const now = new Date();
  const task: Task = {
    id: randomUUID(),
    ...(parentTaskID !== '' ? { parent_id: parentTaskID } : {}),
    team_slug: targetTeam.slug,
    agent_aid: targetAgent.aid,
    status: 'pending',
    prompt,
    blocked_by: dagOpts.blocked_by,
    priority: dagOpts.priority,
    retry_count: 0,
    max_retries: dagOpts.max_retries,
    created_at: now,
    updated_at: now,
    completed_at: null,
  };

  // DAG cycle detection — prevent dependency deadlocks
  if (dagOpts.blocked_by.length > 0) {
    const cyclic = await wouldCreateCycle(deps.taskStore, task.id, dagOpts.blocked_by);
    if (cyclic) {
      throw new ValidationError('blocked_by', 'dependency cycle detected');
    }
  }

  await deps.taskStore.create(task);

  // If blocked_by is non-empty, keep task in 'pending' — the orchestrator's
  // handleTaskCompleted will dispatch when all blockers resolve (wiki DAG model).
  if (dagOpts.blocked_by.length > 0) {
    deps.logger.info('task created with dependencies, waiting for blockers', {
      task_id: task.id,
      team: targetTeam.slug,
      agent: agentAID,
      blocked_by: dagOpts.blocked_by,
    });
    return { task_id: task.id, status: task.status } as unknown as JsonValue;
  }

  // No dependencies — dispatch to container via WebSocket immediately.
  const dispatchPayload: TaskDispatchMsg = {
    task_id: task.id,
    agent_aid: agentAID,
    prompt,
    blocked_by: task.blocked_by,
    ...(task.priority !== 0 ? { priority: task.priority } : {}),
    ...(task.max_retries !== 0 ? { max_retries: task.max_retries } : {}),
  };

  const encoded = encodeMessage(MsgTypeTaskDispatch, dispatchPayload);

  try {
    await deps.wsHub.sendToTeam(targetTeam.slug, encoded);
    // Promote to running on successful dispatch
    task.status = 'running';
    task.updated_at = new Date();
    try {
      await deps.taskStore.update(task);
    } catch (updateErr) {
      deps.logger.error('failed to update task status', {
        task_id: task.id,
        error: updateErr instanceof Error ? updateErr.message : String(updateErr),
      });
    }
  } catch (sendErr) {
    deps.logger.warn('failed to dispatch task to container', {
      task_id: task.id,
      team: targetTeam.slug,
      error: sendErr instanceof Error ? sendErr.message : String(sendErr),
    });
  }

  deps.logger.info('task dispatched', {
    task_id: task.id,
    team: targetTeam.slug,
    agent: agentAID,
  });

  return { task_id: task.id, status: task.status } as unknown as JsonValue;
}

// ---------------------------------------------------------------------------
// extractDAGOpts — extracts blocked_by, priority, max_retries from tool args
// ---------------------------------------------------------------------------

/**
 * Extracts DAG-related options (blocked_by, priority, max_retries) from
 * tool call arguments with type coercion and defaults.
 */
function extractDAGOpts(args: Record<string, JsonValue>): DispatchDAGOpts {
  let blockedBy: string[] = [];
  let rawBlockedBy = args['blocked_by'];

  // The MCP bridge may serialize arrays as JSON strings. Parse if needed.
  if (typeof rawBlockedBy === 'string') {
    try {
      const parsed: unknown = JSON.parse(rawBlockedBy);
      if (Array.isArray(parsed)) {
        rawBlockedBy = parsed as JsonValue;
      }
    } catch {
      // Not valid JSON — ignored
    }
  }

  if (Array.isArray(rawBlockedBy)) {
    blockedBy = rawBlockedBy.filter((v): v is string => typeof v === 'string');
  }

  const priority = typeof args['priority'] === 'number' ? args['priority'] : 0;
  const maxRetries = typeof args['max_retries'] === 'number' ? args['max_retries'] : 0;

  return { blocked_by: blockedBy, priority, max_retries: maxRetries };
}

// ---------------------------------------------------------------------------
// dispatch_task
// ---------------------------------------------------------------------------

/**
 * Dispatches a task to an agent without a parent task.
 *
 * Args:
 *   agent_aid:   string   (required) — AID of the target agent
 *   prompt:      string   (required) — task prompt
 *   blocked_by:  string[] (optional) — task IDs that must complete first
 *   priority:    number   (optional) — priority level (default 0)
 *   max_retries: number   (optional) — max retries (default 0)
 *
 * Returns: { task_id, status }
 */
function makeDispatchTask(deps: TaskToolsDeps): ToolFunc {
  return async (args: Record<string, JsonValue>): Promise<JsonValue> => {
    const agentAID = typeof args['agent_aid'] === 'string' ? args['agent_aid'] : '';
    const prompt = typeof args['prompt'] === 'string' ? args['prompt'] : '';

    if (agentAID === '') {
      throw new ValidationError('agent_aid', 'agent_aid is required');
    }

    const dagOpts = extractDAGOpts(args);
    return dispatchTaskCore(deps, agentAID, prompt, '', dagOpts);
  };
}

// ---------------------------------------------------------------------------
// dispatch_task_and_wait
// ---------------------------------------------------------------------------

/** Default timeout for dispatch_task_and_wait (5 minutes). */
const DEFAULT_WAIT_TIMEOUT_S = 300;
/** Maximum timeout for dispatch_task_and_wait (10 minutes). */
const MAX_WAIT_TIMEOUT_S = 600;

/**
 * Dispatches a task and blocks until the task completes, fails, or times out.
 * Uses TaskWaiter for race-condition-safe blocking.
 *
 * Race condition prevention:
 *   1. Register waiter BEFORE dispatch.
 *   2. After dispatch, check if already terminal (fast path).
 *   3. Await waiter promise.
 *
 * Args:
 *   agent_aid:       string (required) — AID of the target agent
 *   prompt:          string (required) — task prompt
 *   timeout_seconds: number (optional) — max seconds to wait (default 300, max 600)
 *
 * Returns: { task_id, status, result?, error? }
 */
function makeDispatchTaskAndWait(deps: TaskToolsDeps): ToolFunc {
  return async (args: Record<string, JsonValue>): Promise<JsonValue> => {
    if (deps.taskWaiter === null) {
      throw new ValidationError(
        'dispatch_task_and_wait',
        'TaskWaiter not configured; use dispatch_task instead',
      );
    }

    const agentAID = typeof args['agent_aid'] === 'string' ? args['agent_aid'] : '';
    const prompt = typeof args['prompt'] === 'string' ? args['prompt'] : '';
    const timeoutSecondsRaw = typeof args['timeout_seconds'] === 'number'
      ? args['timeout_seconds']
      : DEFAULT_WAIT_TIMEOUT_S;
    const timeoutSeconds = Math.min(Math.max(timeoutSecondsRaw, 1), MAX_WAIT_TIMEOUT_S);
    const timeoutMs = timeoutSeconds * 1000;

    if (agentAID === '') {
      throw new ValidationError('agent_aid', 'agent_aid is required');
    }
    if (prompt === '') {
      throw new ValidationError('prompt', 'prompt is required');
    }

    validateAID(agentAID);

    const dagOpts = extractDAGOpts(args);

    // Validate blocked_by array
    if (dagOpts.blocked_by.length > 0) {
      await validateBlockedBy(dagOpts.blocked_by, deps.taskStore);
    }

    // Verify agent exists and belongs to a team.
    let targetTeam;
    try {
      deps.orgChart.getAgentByAID(agentAID);
    } catch {
      throw new NotFoundError('agent', agentAID);
    }
    try {
      targetTeam = deps.orgChart.getTeamForAgent(agentAID);
    } catch {
      throw new ValidationError('agent_aid', `agent ${agentAID} is not in any team`);
    }

    // Ensure container is running.
    if (deps.containerManager !== null) {
      await deps.containerManager.ensureRunning(targetTeam.slug);
    }

    // Create task.
    const now = new Date();
    const task: Task = {
      id: randomUUID(),
      team_slug: targetTeam.slug,
      agent_aid: agentAID,
      status: 'pending',
      prompt,
      blocked_by: dagOpts.blocked_by,
      priority: dagOpts.priority,
      retry_count: 0,
      max_retries: dagOpts.max_retries,
      created_at: now,
      updated_at: now,
      completed_at: null,
    };

    // DAG cycle detection — prevent dependency deadlocks
    if (dagOpts.blocked_by.length > 0) {
      const cyclic = await wouldCreateCycle(deps.taskStore, task.id, dagOpts.blocked_by);
      if (cyclic) {
        throw new ValidationError('blocked_by', 'dependency cycle detected');
      }
    }

    // Step 1: Register waiter BEFORE dispatch (race condition prevention).
    const waiterPromise = deps.taskWaiter.waitForTask(task.id, timeoutMs);

    // Step 2: Persist task.
    await deps.taskStore.create(task);

    deps.logger.info('dispatch_task_and_wait: task created', {
      task_id: task.id,
      agent_aid: agentAID,
      team_slug: targetTeam.slug,
      timeout_seconds: timeoutSeconds,
    });

    // Step 3: Check if already terminal (fast path — unlikely but safe).
    try {
      const current = await deps.taskStore.get(task.id);
      if (isTerminalStatus(current.status)) {
        deps.taskWaiter.notifyComplete(
          task.id,
          current.status,
          current.result,
          current.error,
        );
      }
    } catch {
      // Task was just created, so get() shouldn't fail. If it does, waiter will timeout.
    }

    // Step 4: If blocked_by is non-empty, keep task in 'pending' — the
    // orchestrator's handleTaskCompleted will dispatch when all blockers resolve.
    if (dagOpts.blocked_by.length > 0) {
      deps.logger.info('dispatch_task_and_wait: task blocked, waiting for dependencies', {
        task_id: task.id,
        blocked_by: dagOpts.blocked_by,
      });
      // Don't dispatch yet — waiter will be notified when dependencies resolve
      // and the task eventually completes.
    } else {
      // No dependencies — dispatch to container immediately.
      const dispatchPayload: TaskDispatchMsg = {
        task_id: task.id,
        agent_aid: agentAID,
        prompt,
        blocked_by: task.blocked_by,
        ...(task.priority !== 0 ? { priority: task.priority } : {}),
        ...(task.max_retries !== 0 ? { max_retries: task.max_retries } : {}),
      };
      const encoded = encodeMessage(MsgTypeTaskDispatch, dispatchPayload);

      try {
        await deps.wsHub.sendToTeam(targetTeam.slug, encoded);
        // Promote to running.
        task.status = 'running';
        task.updated_at = new Date();
        try {
          await deps.taskStore.update(task);
        } catch (updateErr) {
          deps.logger.error('dispatch_task_and_wait: failed to update task status', {
            task_id: task.id,
            error: updateErr instanceof Error ? updateErr.message : String(updateErr),
          });
        }
      } catch (sendErr) {
        // Dispatch failed — notify waiter with failure.
        deps.logger.warn('dispatch_task_and_wait: failed to dispatch to container', {
          task_id: task.id,
          team: targetTeam.slug,
          error: sendErr instanceof Error ? sendErr.message : String(sendErr),
        });
        deps.taskWaiter.notifyComplete(
          task.id,
          'failed',
          undefined,
          `dispatch failed: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`,
        );
      }
    }

    // Step 5: Block until result or timeout.
    const waiterResult = await waiterPromise;

    deps.logger.info('dispatch_task_and_wait: completed', {
      task_id: task.id,
      status: waiterResult.status,
    });

    return waiterResult as unknown as JsonValue;
  };
}

/**
 * Returns true if the task status is terminal (no further transitions).
 */
function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

// ---------------------------------------------------------------------------
// dispatch_subtask
// ---------------------------------------------------------------------------

/**
 * Dispatches a subtask to an agent with an optional parent task ID.
 * When parent_task_id is provided, the created task is linked as a subtask.
 *
 * Args:
 *   agent_aid:      string (required) — AID of the target agent
 *   prompt:         string (required) — task prompt
 *   parent_task_id: string (optional) — ID of the parent task
 *
 * Returns: { task_id, status }
 */
function makeDispatchSubtask(deps: TaskToolsDeps): ToolFunc {
  return async (args: Record<string, JsonValue>): Promise<JsonValue> => {
    const agentAID = typeof args['agent_aid'] === 'string' ? args['agent_aid'] : '';
    const prompt = typeof args['prompt'] === 'string' ? args['prompt'] : '';
    const parentTaskID =
      typeof args['parent_task_id'] === 'string' ? args['parent_task_id'] : '';

    if (agentAID === '') {
      throw new ValidationError('agent_aid', 'agent_aid is required');
    }

    const dagOpts = extractDAGOpts(args);
    return dispatchTaskCore(deps, agentAID, prompt, parentTaskID, dagOpts);
  };
}

// ---------------------------------------------------------------------------
// get_task_status
// ---------------------------------------------------------------------------

/**
 * Returns the current status and details of a task.
 *
 * Args:
 *   task_id: string (required)
 *
 * Returns: Task object
 */
function makeGetTaskStatus(deps: TaskToolsDeps): ToolFunc {
  return async (args: Record<string, JsonValue>): Promise<JsonValue> => {
    const taskID = typeof args['task_id'] === 'string' ? args['task_id'] : '';

    if (taskID === '') {
      throw new ValidationError('task_id', 'task_id is required');
    }

    const task = await deps.taskStore.get(taskID);
    return task as unknown as JsonValue;
  };
}

// ---------------------------------------------------------------------------
// cancel_task
// ---------------------------------------------------------------------------

/**
 * Cancels a pending or running task with optional cascade to subtasks.
 * Delegates to TaskCoordinator.cancelTask() for shared implementation.
 *
 * Args:
 *   task_id:  string  (required) — ID of the task to cancel
 *   cascade:  boolean (optional, default true) — whether to cancel subtasks
 *
 * Returns: { task_id, cancelled_ids, status: "cancelled" }
 */
function makeCancelTask(deps: TaskToolsDeps): ToolFunc {
  return async (args: Record<string, JsonValue>): Promise<JsonValue> => {
    const taskID = typeof args['task_id'] === 'string' ? args['task_id'] : '';
    const cascade = typeof args['cascade'] === 'boolean' ? args['cascade'] : true;

    if (taskID === '') {
      throw new ValidationError('task_id', 'task_id is required');
    }

    if (deps.taskCoordinator != null) {
      // Delegate to shared implementation (orchestrator).
      const cancelledIDs = await deps.taskCoordinator.cancelTask(taskID, cascade);
      deps.logger.info('task cancelled via coordinator', {
        task_id: taskID,
        cascade,
        cancelled_ids: cancelledIDs,
      });
      return {
        task_id: taskID,
        cancelled_ids: cancelledIDs,
        status: 'cancelled',
      } as unknown as JsonValue;
    }

    // Fallback: direct cancellation when no coordinator is wired.
    const task = await deps.taskStore.get(taskID);

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
    task.status = 'cancelled';
    task.updated_at = now;
    task.completed_at = now;

    await deps.taskStore.update(task);

    // Notify TaskWaiter so dispatch_task_and_wait unblocks.
    if (deps.taskWaiter !== null) {
      deps.taskWaiter.notifyComplete(taskID, 'cancelled', undefined, 'task cancelled');
    }

    deps.logger.info('task cancelled', { task_id: taskID });

    return { task_id: taskID, cancelled_ids: [taskID], status: 'cancelled' } as unknown as JsonValue;
  };
}

// ---------------------------------------------------------------------------
// list_tasks
// ---------------------------------------------------------------------------

/**
 * Lists tasks filtered by team_slug or status, with an optional result limit.
 * If neither team_slug nor status is provided, defaults to listing running tasks.
 *
 * Args:
 *   team_slug?: string — filter by team slug (takes precedence over status)
 *   status?:    string — filter by task status
 *   limit?:     number — maximum number of results to return
 *
 * Returns: Task[]
 */
function makeListTasks(deps: TaskToolsDeps): ToolFunc {
  return async (args: Record<string, JsonValue>): Promise<JsonValue> => {
    const teamSlug = typeof args['team_slug'] === 'string' ? args['team_slug'] : '';
    const statusStr = typeof args['status'] === 'string' ? args['status'] : '';
    const limit = typeof args['limit'] === 'number' ? args['limit'] : 0;

    let tasks: Task[];

    if (teamSlug !== '') {
      validateSlug(teamSlug);
      tasks = await deps.taskStore.listByTeam(teamSlug);
    } else if (statusStr !== '') {
      let parsedStatus;
      try {
        parsedStatus = parseTaskStatus(statusStr);
      } catch {
        throw new ValidationError('status', `invalid status: ${statusStr}`);
      }
      tasks = await deps.taskStore.listByStatus(parsedStatus);
    } else {
      // Default: list running tasks
      tasks = await deps.taskStore.listByStatus('running');
    }

    if (limit > 0 && tasks.length > limit) {
      tasks = tasks.slice(0, limit);
    }

    return tasks as unknown as JsonValue;
  };
}
