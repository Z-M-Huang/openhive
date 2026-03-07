/**
 * OpenHive Backend - Task API Handlers
 *
 * Implements GET /api/v1/tasks (with status/team/pagination),
 * GET /api/v1/tasks/:id (with subtree), POST /api/v1/tasks/:id/cancel.
 * Fastify schema validation guards all routes; task ID pattern matches UUID format.
 *
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { GoOrchestrator, TaskStore } from '../domain/interfaces.js';
import type { TaskStatus } from '../domain/enums.js';
import type { Task } from '../domain/types.js';
import type { MiddlewareLogger } from './middleware.js';
import { mapDomainError, sendError, sendJSON } from './response.js';
import type { FastifyReplyShim } from './response.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TASKS_LIMIT = 50;
const MAX_TASKS_LIMIT = 500;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/** Paginated task list response. */
export interface TasksResponse {
  tasks: Task[];
  total: number;
  has_more: boolean;
  limit: number;
  offset: number;
}

/** Task with optional subtasks array for tree display. */
export type TaskWithSubtree = Task & { subtasks?: Task[] };

// ---------------------------------------------------------------------------
// Internal request types
// ---------------------------------------------------------------------------

interface GetTasksQuery {
  status?: TaskStatus;
  team?: string;
  limit?: number;
  offset?: number;
}

interface TaskIdParams {
  id: string;
}

// ---------------------------------------------------------------------------
// JSON schemas
// ---------------------------------------------------------------------------

/** Task ID pattern: lowercase hex chars and hyphens (UUID format). */
const TASK_ID_PATTERN = '^[a-f0-9-]+$';

/** JSON schema for the :id URL parameter. */
export const TASK_ID_PARAM_SCHEMA = {
  params: {
    type: 'object',
    properties: {
      id: { type: 'string', pattern: TASK_ID_PATTERN, maxLength: 128 },
    },
  },
};

/** JSON schema for GET /api/v1/tasks querystring. */
export const GET_TASKS_QUERY_SCHEMA = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
      },
      team: {
        type: 'string',
        pattern: '^[a-z0-9][a-z0-9-]*[a-z0-9]$',
        maxLength: 64,
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_TASKS_LIMIT,
        default: DEFAULT_TASKS_LIMIT,
      },
      offset: {
        type: 'integer',
        minimum: 0,
        default: 0,
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Builds a TaskWithSubtree from a task and optional subtasks.
 */
export function buildTaskWithSubtree(task: Task, subtasks?: Task[]): TaskWithSubtree {
  return { ...task, subtasks };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * Handler factory for GET /api/v1/tasks.
 * Supports query params: status, team, limit, offset.
 */
export function getTasksHandler(taskStore: TaskStore, _logger: MiddlewareLogger) {
  return async (
    request: FastifyRequest<{ Querystring: GetTasksQuery }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const { status, team } = request.query;
    const limit = request.query.limit ?? DEFAULT_TASKS_LIMIT;
    const offset = request.query.offset ?? 0;

    let tasks: Task[];

    if (team !== undefined) {
      try {
        tasks = await taskStore.listByTeam(team);
      } catch (err) {
        mapDomainError(reply as FastifyReplyShim, err);
        return;
      }
    } else if (status !== undefined) {
      try {
        tasks = await taskStore.listByStatus(status);
      } catch (err) {
        mapDomainError(reply as FastifyReplyShim, err);
        return;
      }
    } else {
      // No filter: list running tasks as practical default.
      try {
        tasks = await taskStore.listByStatus('running');
      } catch {
        tasks = [];
      }
    }

    const total = tasks.length;
    let hasMore = false;
    let paginatedTasks: Task[];

    if (offset < tasks.length) {
      const end = offset + limit;
      if (end >= tasks.length) {
        paginatedTasks = tasks.slice(offset);
      } else {
        hasMore = true;
        paginatedTasks = tasks.slice(offset, end);
      }
    } else {
      paginatedTasks = [];
    }

    const response: TasksResponse = {
      tasks: paginatedTasks,
      total,
      has_more: hasMore,
      limit,
      offset,
    };

    sendJSON(reply as FastifyReplyShim, 200, response);
  };
}

/**
 * Handler factory for GET /api/v1/tasks/:id.
 * Returns task with subtree. Returns 404 if not found.
 */
export function getTaskHandler(taskStore: TaskStore, logger: MiddlewareLogger) {
  return async (
    request: FastifyRequest<{ Params: TaskIdParams }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const { id } = request.params;

    let task: Task;
    try {
      task = await taskStore.get(id);
    } catch (err) {
      mapDomainError(reply as FastifyReplyShim, err);
      return;
    }

    // Fetch subtree; non-fatal if it fails.
    let subtasks: Task[] | undefined;
    try {
      const subtree = await taskStore.getSubtree(id);
      // Filter out root task itself from the subtree.
      subtasks = subtree.filter((t) => t.id !== id);
    } catch (err) {
      logger.warn('failed to get task subtree', err);
    }

    sendJSON(reply as FastifyReplyShim, 200, buildTaskWithSubtree(task, subtasks));
  };
}

/**
 * Handler factory for POST /api/v1/tasks/:id/cancel.
 * Requires Content-Type: application/json for CSRF protection.
 * Returns updated task after cancellation.
 */
export function cancelTaskHandler(
  orch: GoOrchestrator,
  taskStore: TaskStore,
  logger: MiddlewareLogger,
) {
  return async (
    request: FastifyRequest<{ Params: TaskIdParams }>,
    reply: FastifyReply,
  ): Promise<void> => {
    // Enforce JSON Content-Type for CSRF protection (even though body is not read).
    const ct = request.headers['content-type'];
    if (ct !== 'application/json') {
      sendError(
        reply as FastifyReplyShim,
        415,
        'INVALID_CONTENT_TYPE',
        'Content-Type must be application/json',
      );
      return;
    }

    const { id } = request.params;

    try {
      await orch.cancelTask(id);
    } catch (err) {
      logger.error('failed to cancel task', err);
      mapDomainError(reply as FastifyReplyShim, err);
      return;
    }

    // Return updated task.
    try {
      const task = await taskStore.get(id);
      sendJSON(reply as FastifyReplyShim, 200, task);
    } catch (err) {
      mapDomainError(reply as FastifyReplyShim, err);
    }
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers all task routes on the Fastify instance.
 */
export function registerTaskRoutes(
  fastify: FastifyInstance,
  taskStore: TaskStore,
  orch: GoOrchestrator,
  logger: MiddlewareLogger,
): void {
  fastify.get('/api/v1/tasks', { schema: GET_TASKS_QUERY_SCHEMA }, getTasksHandler(taskStore, logger));
  fastify.get('/api/v1/tasks/:id', { schema: TASK_ID_PARAM_SCHEMA }, getTaskHandler(taskStore, logger));
  fastify.post(
    '/api/v1/tasks/:id/cancel',
    { schema: TASK_ID_PARAM_SCHEMA },
    cancelTaskHandler(orch, taskStore, logger),
  );
}
