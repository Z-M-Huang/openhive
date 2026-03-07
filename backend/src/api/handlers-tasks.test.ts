/**
 * Tests for handlers-tasks.ts — GET/tasks, GET/tasks/:id, POST/tasks/:id/cancel.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

import type { GoOrchestrator, TaskStore } from '../domain/interfaces.js';
import type { Task } from '../domain/types.js';
import { NotFoundError } from '../domain/errors.js';
import { buildTaskWithSubtree, registerTaskRoutes } from './handlers-tasks.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const sampleTask: Task = {
  id: 'aaaa1111-bbbb-cccc-dddd-eeee00000001',
  team_slug: 'my-team',
  status: 'running',
  prompt: 'do something',
  created_at: new Date('2025-01-01T00:00:00Z'),
  updated_at: new Date('2025-01-01T00:00:00Z'),
  completed_at: null,
};

const sampleTask2: Task = {
  id: 'aaaa1111-bbbb-cccc-dddd-eeee00000002',
  parent_id: sampleTask.id,
  team_slug: 'my-team',
  status: 'completed',
  prompt: 'subtask',
  created_at: new Date('2025-01-01T00:01:00Z'),
  updated_at: new Date('2025-01-01T00:01:00Z'),
  completed_at: new Date('2025-01-01T00:02:00Z'),
};

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeMockTaskStore(): TaskStore & {
  get: ReturnType<typeof vi.fn>;
  listByTeam: ReturnType<typeof vi.fn>;
  listByStatus: ReturnType<typeof vi.fn>;
  getSubtree: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn().mockImplementation((id: string) => {
      if (id === sampleTask.id) return Promise.resolve(sampleTask);
      throw new NotFoundError('task', id);
    }),
    create: vi.fn(),
    update: vi.fn(),
    listByTeam: vi.fn().mockResolvedValue([sampleTask]),
    listByStatus: vi.fn().mockResolvedValue([sampleTask]),
    getSubtree: vi.fn().mockResolvedValue([sampleTask, sampleTask2]),
  } as unknown as TaskStore & {
    get: ReturnType<typeof vi.fn>;
    listByTeam: ReturnType<typeof vi.fn>;
    listByStatus: ReturnType<typeof vi.fn>;
    getSubtree: ReturnType<typeof vi.fn>;
  };
}

function makeMockOrch(): GoOrchestrator & {
  cancelTask: ReturnType<typeof vi.fn>;
} {
  return {
    cancelTask: vi.fn().mockResolvedValue(undefined),
    createTeam: vi.fn(),
    deleteTeam: vi.fn(),
    getTeam: vi.fn(),
    listTeams: vi.fn(),
    updateTeam: vi.fn(),
    dispatchTask: vi.fn(),
    handleTaskResult: vi.fn(),
    getTaskStatus: vi.fn(),
    createSubtasks: vi.fn(),
    getHealthStatus: vi.fn(),
    handleUnhealthy: vi.fn(),
    getAllStatuses: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as GoOrchestrator & { cancelTask: ReturnType<typeof vi.fn> };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

// Note: coerceTypes: 'array' is required so that integer query params (limit, offset)
// are coerced from URL strings to numbers by AJV.
async function buildApp(
  taskStore: TaskStore,
  orch: GoOrchestrator,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    ajv: {
      customOptions: { allErrors: true, removeAdditional: false, coerceTypes: 'array' },
    },
  });
  registerTaskRoutes(app, taskStore, orch, makeLogger());
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// getTasksHandler
// ---------------------------------------------------------------------------

describe('getTasksHandler', () => {
  let taskStore: ReturnType<typeof makeMockTaskStore>;
  let app: FastifyInstance;

  beforeEach(async () => {
    taskStore = makeMockTaskStore();
    app = await buildApp(taskStore, makeMockOrch());
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns paginated tasks', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tasks' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: { tasks: Task[]; total: number; limit: number; offset: number } };
    expect(body.data.tasks).toHaveLength(1);
    expect(body.data.total).toBe(1);
    expect(body.data.limit).toBe(50);
    expect(body.data.offset).toBe(0);
  });

  it('filters by team slug', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tasks?team=my-team' });
    expect(res.statusCode).toBe(200);
    expect(taskStore.listByTeam).toHaveBeenCalledWith('my-team');
  });

  it('filters by status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tasks?status=running' });
    expect(res.statusCode).toBe(200);
    expect(taskStore.listByStatus).toHaveBeenCalledWith('running');
  });

  it('validates limit and offset', async () => {
    const zeroLimit = await app.inject({ method: 'GET', url: '/api/v1/tasks?limit=0' });
    expect(zeroLimit.statusCode).toBe(400);

    const negativeOffset = await app.inject({ method: 'GET', url: '/api/v1/tasks?offset=-1' });
    expect(negativeOffset.statusCode).toBe(400);
  });

  it('rejects limit > 500 with 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tasks?limit=501' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid status enum value with 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tasks?status=invalid' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects negative offset with 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tasks?offset=-5' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects injection in team query param', async () => {
    const withSlash = await app.inject({ method: 'GET', url: '/api/v1/tasks?team=../evil' });
    expect(withSlash.statusCode).toBe(400);

    const withUppercase = await app.inject({ method: 'GET', url: '/api/v1/tasks?team=INVALID_TEAM' });
    expect(withUppercase.statusCode).toBe(400);
  });

  it('ignores unknown query parameters (additionalProperties: false)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tasks?foo=bar' });
    expect(res.statusCode).toBe(400);
  });

  it('caps limit at max — returns correct pagination metadata', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tasks?limit=500' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: { limit: number } };
    expect(body.data.limit).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// getTaskHandler
// ---------------------------------------------------------------------------

describe('getTaskHandler', () => {
  let taskStore: ReturnType<typeof makeMockTaskStore>;
  let app: FastifyInstance;

  beforeEach(async () => {
    taskStore = makeMockTaskStore();
    app = await buildApp(taskStore, makeMockOrch());
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns task with subtree', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${sampleTask.id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: { id: string; subtasks: Task[] } };
    expect(body.data.id).toBe(sampleTask.id);
    // subtasks should exclude the root (sampleTask itself), contain sampleTask2
    expect(body.data.subtasks).toHaveLength(1);
    expect(body.data.subtasks[0]!.id).toBe(sampleTask2.id);
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tasks/aaaa1111-bbbb-cccc-dddd-eeee99999999',
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects task id with special characters', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tasks/INVALID_ID' });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// cancelTaskHandler
// ---------------------------------------------------------------------------

describe('cancelTaskHandler', () => {
  let orch: ReturnType<typeof makeMockOrch>;
  let taskStore: ReturnType<typeof makeMockTaskStore>;
  let app: FastifyInstance;

  beforeEach(async () => {
    orch = makeMockOrch();
    taskStore = makeMockTaskStore();
    app = await buildApp(taskStore, orch);
  });

  afterEach(async () => {
    await app.close();
  });

  it('cancels task and returns updated', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${sampleTask.id}/cancel`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(200);
    expect(orch.cancelTask).toHaveBeenCalledWith(sampleTask.id);
    const body = JSON.parse(res.body) as { data: { id: string } };
    expect(body.data.id).toBe(sampleTask.id);
  });

  it('requires JSON Content-Type', async () => {
    const noContentType = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${sampleTask.id}/cancel`,
    });
    expect(noContentType.statusCode).toBe(415);

    const wrongContentType = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${sampleTask.id}/cancel`,
      headers: { 'content-type': 'text/plain' },
    });
    expect(wrongContentType.statusCode).toBe(415);
  });
});

// ---------------------------------------------------------------------------
// buildTaskWithSubtree utility
// ---------------------------------------------------------------------------

describe('buildTaskWithSubtree', () => {
  it('includes subtasks when provided', () => {
    const result = buildTaskWithSubtree(sampleTask, [sampleTask2]);
    expect(result.id).toBe(sampleTask.id);
    expect(result.subtasks).toHaveLength(1);
    expect(result.subtasks![0]!.id).toBe(sampleTask2.id);
  });

  it('has undefined subtasks when not provided', () => {
    const result = buildTaskWithSubtree(sampleTask);
    expect(result.subtasks).toBeUndefined();
  });
});
