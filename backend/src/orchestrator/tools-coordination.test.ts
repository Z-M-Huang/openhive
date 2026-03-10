/**
 * Tests for coordination SDK tool handlers (escalate, consolidate_results).
 *
 * Covers:
 *   - escalate: constructs correct EscalationMsg, delegates to router
 *   - escalate: rejects non-owned task (agent_aid mismatch)
 *   - escalate: returns correlation_id
 *   - escalate: validates required fields (task_id, reason)
 *   - consolidate_results: returns per-task status with results for completed tasks
 *   - consolidate_results: handles mix of completed/failed/pending
 *   - consolidate_results: handles nonexistent task IDs
 *   - consolidate_results: validates required fields (task_ids)
 *   - registerCoordinationTools: registers both tools
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerCoordinationTools } from './tools-coordination.js';
import type { CoordinationToolsDeps } from './tools-coordination.js';
import type { TaskStore, ToolRegistry } from '../domain/interfaces.js';
import type { Task, JsonValue } from '../domain/types.js';
import type { TaskStatus } from '../domain/enums.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';
import type { ToolCallContext } from './toolhandler.js';
import type { EscalationRouter } from './escalation-router.js';
import type { EscalationMsg } from '../ws/messages.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ToolFunc = (args: Record<string, JsonValue>, context?: ToolCallContext) => Promise<JsonValue>;

/** Creates a ToolCallContext with the given agentAid and teamSlug. */
function ctx(agentAid: string, teamSlug: string = 'main'): ToolCallContext {
  return { teamSlug, agentAid };
}

/** Creates a silent logger. */
function makeLogger(): CoordinationToolsDeps['logger'] {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

/** Creates a mock task with the given overrides. */
function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date();
  return {
    id: 'task-001',
    team_slug: 'main',
    agent_aid: 'aid-bot-1',
    status: 'running' as TaskStatus,
    prompt: 'test prompt',
    blocked_by: [],
    priority: 0,
    retry_count: 0,
    max_retries: 0,
    created_at: now,
    updated_at: now,
    completed_at: null,
    ...overrides,
  };
}

/** Creates a mock TaskStore backed by an in-memory Map. */
function makeMockTaskStore(tasks: Task[] = []): TaskStore {
  const taskMap = new Map<string, Task>();
  for (const t of tasks) {
    taskMap.set(t.id, { ...t });
  }

  return {
    async create(task: Task) {
      taskMap.set(task.id, { ...task });
    },
    async get(id: string): Promise<Task> {
      const t = taskMap.get(id);
      if (t === undefined) throw new NotFoundError('task', id);
      return { ...t };
    },
    async update(task: Task) {
      if (!taskMap.has(task.id)) throw new NotFoundError('task', task.id);
      taskMap.set(task.id, { ...task });
    },
    async delete(id: string) {
      taskMap.delete(id);
    },
    async listByTeam(_teamSlug: string): Promise<Task[]> {
      return [];
    },
    async listByStatus(_status: TaskStatus): Promise<Task[]> {
      return [];
    },
    async getSubtree(_rootID: string): Promise<Task[]> {
      return [];
    },
    async getDependents(_blockerID: string): Promise<Task[]> {
      return [];
    },
    async getBlockedBy(_taskId: string): Promise<string[]> {
      return [];
    },
    async unblockTask(_taskId: string, _completedDependencyId: string): Promise<boolean> {
      return true;
    },
    async retryTask(_taskId: string): Promise<boolean> {
      return false;
    },
    async validateDependencies(_taskId: string, _blockedByIds: string[]): Promise<void> {},
  };
}

/** Creates a mock EscalationRouter that captures handleEscalation calls. */
function makeMockEscalationRouter(): EscalationRouter & {
  calls: Array<{ sourceTeamID: string; msg: EscalationMsg }>;
} {
  const calls: Array<{ sourceTeamID: string; msg: EscalationMsg }> = [];
  return {
    calls,
    async handleEscalation(sourceTeamID: string, msg: EscalationMsg): Promise<void> {
      calls.push({ sourceTeamID, msg });
    },
    // We only need handleEscalation for this test
    async handleEscalationResponse() {
      // no-op
    },
  } as EscalationRouter & { calls: Array<{ sourceTeamID: string; msg: EscalationMsg }> };
}

/** Creates a mock ToolRegistry that captures registered tools. */
function makeMockRegistry(): ToolRegistry & { tools: Map<string, ToolFunc> } {
  const tools = new Map<string, ToolFunc>();
  return {
    tools,
    register(name: string, fn: ToolFunc) {
      tools.set(name, fn);
    },
  };
}

// ---------------------------------------------------------------------------
// registerCoordinationTools
// ---------------------------------------------------------------------------

describe('registerCoordinationTools', () => {
  it('registers escalate and consolidate_results', () => {
    const registry = makeMockRegistry();
    const deps: CoordinationToolsDeps = {
      taskStore: makeMockTaskStore(),
      escalationRouter: makeMockEscalationRouter(),
      logger: makeLogger(),
    };
    registerCoordinationTools(registry, deps);

    expect(registry.tools.has('escalate')).toBe(true);
    expect(registry.tools.has('consolidate_results')).toBe(true);
    expect(registry.tools.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// escalate
// ---------------------------------------------------------------------------

describe('escalate', () => {
  let taskStore: TaskStore;
  let router: ReturnType<typeof makeMockEscalationRouter>;
  let escalateFn: ToolFunc;

  beforeEach(() => {
    const task = makeTask({ id: 'task-001', agent_aid: 'aid-bot-1' });
    taskStore = makeMockTaskStore([task]);
    router = makeMockEscalationRouter();
    const registry = makeMockRegistry();
    registerCoordinationTools(registry, {
      taskStore,
      escalationRouter: router,
      logger: makeLogger(),
    });
    escalateFn = registry.tools.get('escalate')!;
  });

  it('constructs correct EscalationMsg and delegates to router', async () => {
    const result = await escalateFn(
      { task_id: 'task-001', reason: 'need help' },
      ctx('aid-bot-1', 'team-alpha'),
    ) as Record<string, JsonValue>;

    expect(router.calls).toHaveLength(1);
    const call = router.calls[0]!;
    expect(call.sourceTeamID).toBe('team-alpha');
    expect(call.msg.task_id).toBe('task-001');
    expect(call.msg.agent_aid).toBe('aid-bot-1');
    expect(call.msg.source_team).toBe('team-alpha');
    expect(call.msg.reason).toBe('need help');
    expect(call.msg.escalation_level).toBe(1);
    expect(call.msg.correlation_id).toBeDefined();
    expect(typeof call.msg.correlation_id).toBe('string');

    expect(result['status']).toBe('escalated');
    expect(result['correlation_id']).toBe(call.msg.correlation_id);
  });

  it('passes optional context to EscalationMsg', async () => {
    await escalateFn(
      { task_id: 'task-001', reason: 'need help', context: 'additional details' },
      ctx('aid-bot-1', 'team-alpha'),
    );

    const call = router.calls[0]!;
    expect(call.msg.context).toEqual({ detail: 'additional details' });
  });

  it('returns correlation_id', async () => {
    const result = await escalateFn(
      { task_id: 'task-001', reason: 'stuck' },
      ctx('aid-bot-1'),
    ) as Record<string, JsonValue>;

    expect(result['correlation_id']).toBeDefined();
    expect(typeof result['correlation_id']).toBe('string');
    // UUID format check
    expect(result['correlation_id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('rejects non-owned task (agent_aid mismatch)', async () => {
    await expect(
      escalateFn(
        { task_id: 'task-001', reason: 'stuck' },
        ctx('aid-other-agent', 'team-alpha'),
      ),
    ).rejects.toThrow(ValidationError);

    await expect(
      escalateFn(
        { task_id: 'task-001', reason: 'stuck' },
        ctx('aid-other-agent', 'team-alpha'),
      ),
    ).rejects.toThrow('agent does not own this task');
  });

  it('throws ValidationError when task_id is missing', async () => {
    await expect(
      escalateFn({ reason: 'stuck' }, ctx('aid-bot-1')),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when reason is missing', async () => {
    await expect(
      escalateFn({ task_id: 'task-001' }, ctx('aid-bot-1')),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when context has no agentAid', async () => {
    await expect(
      escalateFn({ task_id: 'task-001', reason: 'stuck' }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws NotFoundError when task does not exist', async () => {
    await expect(
      escalateFn(
        { task_id: 'nonexistent', reason: 'stuck' },
        ctx('aid-bot-1'),
      ),
    ).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// consolidate_results
// ---------------------------------------------------------------------------

describe('consolidate_results', () => {
  let consolidateFn: ToolFunc;

  beforeEach(() => {
    const now = new Date();
    const tasks = [
      makeTask({ id: 'task-1', status: 'completed' as TaskStatus, result: 'done well', completed_at: now }),
      makeTask({ id: 'task-2', status: 'failed' as TaskStatus, error: 'out of memory' }),
      makeTask({ id: 'task-3', status: 'running' as TaskStatus }),
      makeTask({ id: 'task-4', status: 'pending' as TaskStatus }),
    ];
    const taskStore = makeMockTaskStore(tasks);
    const registry = makeMockRegistry();
    registerCoordinationTools(registry, {
      taskStore,
      escalationRouter: makeMockEscalationRouter(),
      logger: makeLogger(),
    });
    consolidateFn = registry.tools.get('consolidate_results')!;
  });

  it('returns per-task status with results for completed tasks', async () => {
    const result = await consolidateFn(
      { task_ids: ['task-1'] },
      ctx('aid-bot-1'),
    ) as Record<string, JsonValue>;

    const tasks = result['tasks'] as Array<Record<string, JsonValue>>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!['task_id']).toBe('task-1');
    expect(tasks[0]!['status']).toBe('completed');
    expect(tasks[0]!['result']).toBe('done well');
  });

  it('handles mix of completed/failed/pending/running', async () => {
    const result = await consolidateFn(
      { task_ids: ['task-1', 'task-2', 'task-3', 'task-4'] },
      ctx('aid-bot-1'),
    ) as Record<string, JsonValue>;

    const tasks = result['tasks'] as Array<Record<string, JsonValue>>;
    expect(tasks).toHaveLength(4);

    const byId = new Map(tasks.map((t) => [t['task_id'], t]));

    expect(byId.get('task-1')!['status']).toBe('completed');
    expect(byId.get('task-1')!['result']).toBe('done well');

    expect(byId.get('task-2')!['status']).toBe('failed');
    expect(byId.get('task-2')!['error']).toBe('out of memory');

    expect(byId.get('task-3')!['status']).toBe('running');
    expect(byId.get('task-4')!['status']).toBe('pending');
  });

  it('handles nonexistent task IDs without crashing', async () => {
    const result = await consolidateFn(
      { task_ids: ['task-1', 'nonexistent-id', 'task-2'] },
      ctx('aid-bot-1'),
    ) as Record<string, JsonValue>;

    const tasks = result['tasks'] as Array<Record<string, JsonValue>>;
    expect(tasks).toHaveLength(3);

    const notFound = tasks.find((t) => t['task_id'] === 'nonexistent-id')!;
    expect(notFound['status']).toBe('not_found');

    const found = tasks.find((t) => t['task_id'] === 'task-1')!;
    expect(found['status']).toBe('completed');
  });

  it('throws ValidationError when task_ids is missing', async () => {
    await expect(
      consolidateFn({}, ctx('aid-bot-1')),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when task_ids is empty', async () => {
    await expect(
      consolidateFn({ task_ids: [] }, ctx('aid-bot-1')),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when task_ids is not an array', async () => {
    await expect(
      consolidateFn({ task_ids: 'not-an-array' }, ctx('aid-bot-1')),
    ).rejects.toThrow(ValidationError);
  });

  it('accepts task_ids as a JSON-encoded string array', async () => {
    // SDK may serialize arrays as JSON strings when passing through MCP
    const result = await consolidateFn(
      { task_ids: JSON.stringify(['task-1']) },
      ctx('aid-bot-1'),
    ) as Record<string, JsonValue>;

    const tasks = result['tasks'] as Array<Record<string, JsonValue>>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!['task_id']).toBe('task-1');
    expect(tasks[0]!['status']).toBe('completed');
  });
});
