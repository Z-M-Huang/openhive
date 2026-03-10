/**
 * OpenHive Backend - Coordination SDK Tool Handlers
 *
 * Registers coordination tool handlers on the ToolHandler.
 *
 * Tools:
 *   escalate            - escalates a task to the supervisor via EscalationRouter
 *   consolidate_results - gathers task results for multiple task IDs
 *
 * The escalate tool is a thin wrapper that:
 *   1. Verifies the calling agent owns the task
 *   2. Generates a correlation_id
 *   3. Constructs an EscalationMsg
 *   4. Delegates to EscalationRouter.handleEscalation()
 *
 * The consolidate_results tool gathers status/result/error for a list of
 * task IDs, handling not-found gracefully (returns { status: 'not_found' }).
 */

import { randomUUID } from 'node:crypto';
import type { TaskStore } from '../domain/interfaces.js';
import type { JsonValue } from '../domain/types.js';
import { ValidationError, NotFoundError } from '../domain/errors.js';
import type { ToolFunc, ToolCallContext } from './toolhandler.js';
import type { ToolRegistry } from '../domain/interfaces.js';
import type { EscalationRouter } from './escalation-router.js';
import type { EscalationMsg } from '../ws/messages.js';

// ---------------------------------------------------------------------------
// CoordinationToolsDeps
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into coordination tool handlers.
 */
export interface CoordinationToolsDeps {
  taskStore: TaskStore;
  escalationRouter: EscalationRouter;
  logger: {
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, data?: Record<string, unknown>): void;
  };
}

// ---------------------------------------------------------------------------
// registerCoordinationTools
// ---------------------------------------------------------------------------

/**
 * Registers all coordination SDK custom tool handlers on the ToolHandler.
 *
 * Registers:
 *   escalate            - escalate a task to the supervisor
 *   consolidate_results - gather results for multiple tasks
 */
export function registerCoordinationTools(handler: ToolRegistry, deps: CoordinationToolsDeps): void {
  handler.register('escalate', makeEscalate(deps));
  handler.register('consolidate_results', makeConsolidateResults(deps));
}

// ---------------------------------------------------------------------------
// escalate
// ---------------------------------------------------------------------------

/**
 * Escalates a task to the supervisor via EscalationRouter.
 *
 * Verifies the calling agent owns the task, generates a correlation_id,
 * constructs an EscalationMsg, and delegates to the router.
 *
 * Args:
 *   task_id: string (required) - ID of the task to escalate
 *   reason:  string (required) - reason for escalation
 *   context: string (optional) - additional context
 *
 * Returns: { correlation_id, status: 'escalated' }
 */
function makeEscalate(deps: CoordinationToolsDeps): ToolFunc {
  return async (args: Record<string, JsonValue>, callContext?: ToolCallContext): Promise<JsonValue> => {
    const agentAid = callContext?.agentAid ?? '';
    const teamSlug = callContext?.teamSlug ?? '';
    const taskId = typeof args['task_id'] === 'string' ? args['task_id'] : '';
    const reason = typeof args['reason'] === 'string' ? args['reason'] : '';
    const contextArg = typeof args['context'] === 'string' ? args['context'] : '';

    // Validate required fields
    if (agentAid === '') {
      throw new ValidationError('agent_aid', 'agent_aid is required (must be provided via authenticated context)');
    }
    if (taskId === '') {
      throw new ValidationError('task_id', 'task_id is required');
    }
    if (reason === '') {
      throw new ValidationError('reason', 'reason is required');
    }

    // Fetch the task (throws NotFoundError if missing)
    const task = await deps.taskStore.get(taskId);

    // Verify task ownership: the calling agent must own this task
    if (task.agent_aid !== agentAid) {
      throw new ValidationError('task_id', 'agent does not own this task');
    }

    // Generate correlation_id for tracking the escalation chain
    const correlationId = randomUUID();

    // Build the escalation context object
    const escalationContext: Record<string, JsonValue> = {};
    if (contextArg !== '') {
      escalationContext['detail'] = contextArg;
    }

    // Construct EscalationMsg
    const msg: EscalationMsg = {
      correlation_id: correlationId,
      task_id: taskId,
      agent_aid: agentAid,
      source_team: teamSlug,
      destination_team: '', // Router will resolve the destination
      escalation_level: 1,
      reason,
      context: escalationContext,
    };

    // Delegate to the EscalationRouter
    await deps.escalationRouter.handleEscalation(teamSlug, msg);

    deps.logger.info('task escalated via tool', {
      correlation_id: correlationId,
      task_id: taskId,
      agent_aid: agentAid,
      source_team: teamSlug,
      reason,
    });

    return {
      correlation_id: correlationId,
      status: 'escalated',
    } as unknown as JsonValue;
  };
}

// ---------------------------------------------------------------------------
// consolidate_results
// ---------------------------------------------------------------------------

/**
 * Gathers task results for multiple task IDs. Handles not-found gracefully
 * by including a { task_id, status: 'not_found' } entry.
 *
 * Args:
 *   task_ids: string[] (required) - array of task IDs to consolidate
 *
 * Returns: { tasks: [ { task_id, status, result?, error? }, ... ] }
 */
function makeConsolidateResults(deps: CoordinationToolsDeps): ToolFunc {
  return async (args: Record<string, JsonValue>): Promise<JsonValue> => {
    let rawTaskIds = args['task_ids'];

    // The SDK may serialize arrays as JSON strings when passing through MCP.
    // Accept both native arrays and JSON-encoded strings.
    if (typeof rawTaskIds === 'string') {
      try {
        const parsed: unknown = JSON.parse(rawTaskIds);
        if (Array.isArray(parsed)) {
          rawTaskIds = parsed as JsonValue;
        }
      } catch {
        // Not valid JSON — fall through to validation error below
      }
    }

    // Validate task_ids is a non-empty array
    if (!Array.isArray(rawTaskIds)) {
      throw new ValidationError('task_ids', 'task_ids must be an array of strings');
    }

    const taskIds = rawTaskIds.filter((v): v is string => typeof v === 'string');
    if (taskIds.length === 0) {
      throw new ValidationError('task_ids', 'task_ids must contain at least one task ID');
    }

    const results: Array<Record<string, JsonValue>> = [];

    for (const taskId of taskIds) {
      try {
        const task = await deps.taskStore.get(taskId);
        const entry: Record<string, JsonValue> = {
          task_id: taskId,
          status: task.status,
        };
        if (task.result !== undefined) {
          entry['result'] = task.result;
        }
        if (task.error !== undefined) {
          entry['error'] = task.error;
        }
        results.push(entry);
      } catch (err) {
        if (err instanceof NotFoundError) {
          results.push({
            task_id: taskId,
            status: 'not_found',
          });
        } else {
          throw err;
        }
      }
    }

    deps.logger.info('results consolidated', {
      task_count: taskIds.length,
      found: results.filter((r) => r['status'] !== 'not_found').length,
      not_found: results.filter((r) => r['status'] === 'not_found').length,
    });

    return { tasks: results } as unknown as JsonValue;
  };
}
