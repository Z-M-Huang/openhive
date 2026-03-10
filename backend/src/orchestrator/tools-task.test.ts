/**
 * Tests for task SDK tool handlers (tools-task.ts)
 *
 * Covers:
 *   1.  dispatch_task creates and dispatches task (returns task_id + status)
 *   2.  dispatch_task validates agent exists in OrgChart
 *   3.  dispatch_task validates agent_aid is required
 *   4.  dispatch_task validates prompt is required
 *   5.  dispatch_task sends task_dispatch WS message
 *   6.  dispatch_task updates task to running on successful WS send
 *   7.  dispatch_subtask sets parent_id correctly
 *   8.  dispatch_subtask works without parent_task_id (optional)
 *   9.  get_task_status returns task by ID
 *   10. get_task_status requires task_id
 *   11. cancel_task marks task as cancelled and sets completedAt
 *   12. cancel_task sends shutdown signal to container
 *   13. cancel_task rejects already-completed tasks
 *   14. cancel_task rejects already-failed tasks
 *   15. list_tasks returns paginated results (respects limit)
 *   16. list_tasks filters by team_slug
 *   17. list_tasks filters by status
 *   18. list_tasks defaults to running status
 *   19. list_tasks validates invalid status
 *   20. registerTaskTools registers all expected tool names
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerTaskTools, type TaskToolsDeps } from './tools-task.js';
import { ToolHandler } from './toolhandler.js';
import { ValidationError, NotFoundError } from '../domain/errors.js';
import type { TaskStore, WSHub, ContainerManager, OrgChart } from '../domain/interfaces.js';
import type { Task, Agent, Team, JsonValue } from '../domain/types.js';

// Mock node:crypto to allow controlling randomUUID in cycle detection tests
vi.mock('node:crypto', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:crypto')>();
  return {
    ...orig,
    randomUUID: vi.fn(orig.randomUUID),
  };
});

// ---------------------------------------------------------------------------
// Helpers — factory functions for test data
// ---------------------------------------------------------------------------

function makeAgent(aid: string, name: string): Agent {
  return { aid, name };
}

function makeTeam(slug: string, leaderAID: string, agents: Agent[] = []): Team {
  return {
    tid: `tid-${slug.slice(0, 8)}-test0001`,
    slug,
    leader_aid: leaderAID,
    agents,
  };
}

function makeTask(id: string, override: Partial<Task> = {}): Task {
  return {
    id,
    team_slug: 'dev-team',
    agent_aid: 'aid-worker-00000001',
    status: 'pending',
    prompt: 'do something',
    blocked_by: [],
    priority: 0,
    retry_count: 0,
    max_retries: 0,
    created_at: new Date('2024-01-01T00:00:00Z'),
    updated_at: new Date('2024-01-01T00:00:00Z'),
    completed_at: null,
    ...override,
  };
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeMockTaskStore(tasks: Task[] = []): TaskStore {
  const store: Map<string, Task> = new Map(tasks.map((t) => [t.id, t]));

  return {
    create: vi.fn().mockImplementation((task: Task) => {
      store.set(task.id, { ...task });
      return Promise.resolve();
    }),
    get: vi.fn().mockImplementation((id: string) => {
      const task = store.get(id);
      if (task === undefined) throw new NotFoundError('task', id);
      return Promise.resolve({ ...task });
    }),
    update: vi.fn().mockImplementation((task: Task) => {
      if (!store.has(task.id)) throw new NotFoundError('task', task.id);
      store.set(task.id, { ...task });
      return Promise.resolve();
    }),
    delete: vi.fn().mockResolvedValue(undefined),
    listByTeam: vi.fn().mockImplementation((teamSlug: string) => {
      return Promise.resolve(
        [...store.values()].filter((t) => t.team_slug === teamSlug),
      );
    }),
    listByStatus: vi.fn().mockImplementation((status: string) => {
      return Promise.resolve([...store.values()].filter((t) => t.status === status));
    }),
    getSubtree: vi.fn().mockResolvedValue([]),
    getDependents: vi.fn().mockResolvedValue([]),
    getBlockedBy: vi.fn().mockResolvedValue([]),
    unblockTask: vi.fn().mockResolvedValue(true),
    retryTask: vi.fn().mockResolvedValue(false),
    validateDependencies: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockWSHub(): WSHub {
  return {
    registerConnection: vi.fn(),
    unregisterConnection: vi.fn(),
    sendToTeam: vi.fn().mockResolvedValue(undefined),
    broadcastAll: vi.fn().mockResolvedValue(undefined),
    generateToken: vi.fn().mockReturnValue('token-xyz'),
    getUpgradeHandler: vi.fn().mockReturnValue(() => {}),
    getConnectedTeams: vi.fn().mockReturnValue([]),
    setOnMessage: vi.fn(),
    setOnConnect: vi.fn(),
  };
}

function makeMockContainerManager(): ContainerManager {
  return {
    ensureRunning: vi.fn().mockResolvedValue(undefined),
    provisionTeam: vi.fn().mockResolvedValue(undefined),
    removeTeam: vi.fn().mockResolvedValue(undefined),
    restartTeam: vi.fn().mockResolvedValue(undefined),
    stopTeam: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue('running'),
    getContainerID: vi.fn().mockReturnValue('container-abc'),
  };
}

function makeMockOrgChart(
  agentsByAID: Record<string, Agent> = {},
  teamsBySlug: Record<string, Team> = {},
): OrgChart {
  return {
    getOrgChart: vi.fn().mockReturnValue(teamsBySlug),
    getAgentByAID: vi.fn().mockImplementation((aid: string) => {
      const agent = agentsByAID[aid];
      if (agent === undefined) throw new NotFoundError('agent', aid);
      return agent;
    }),
    getTeamBySlug: vi.fn().mockImplementation((slug: string) => {
      const team = teamsBySlug[slug];
      if (team === undefined) throw new NotFoundError('team', slug);
      return team;
    }),
    getTeamForAgent: vi.fn().mockImplementation((aid: string) => {
      for (const team of Object.values(teamsBySlug)) {
        for (const a of team.agents ?? []) {
          if (a.aid === aid) return team;
        }
        if (team.leader_aid === aid) return team;
      }
      throw new NotFoundError('team', `for agent ${aid}`);
    }),
    getLeadTeams: vi.fn().mockReturnValue([]),
    getSubordinates: vi.fn().mockReturnValue([]),
    getSupervisor: vi.fn().mockReturnValue(null),
    rebuildFromConfig: vi.fn(),
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const workerAgent = makeAgent('aid-worker-00000001', 'Worker');
const devTeam = makeTeam('dev-team', 'aid-worker-00000001', [workerAgent]);

let taskStore: TaskStore;
let wsHub: WSHub;
let containerManager: ContainerManager;
let orgChart: OrgChart;
let deps: TaskToolsDeps;
let handler: ToolHandler;

beforeEach(() => {
  taskStore = makeMockTaskStore();
  wsHub = makeMockWSHub();
  containerManager = makeMockContainerManager();
  orgChart = makeMockOrgChart(
    { 'aid-worker-00000001': workerAgent },
    { 'dev-team': devTeam },
  );
  deps = {
    taskStore,
    wsHub,
    containerManager,
    orgChart,
    taskWaiter: null,
    taskCoordinator: null,
    logger: makeLogger(),
  };
  handler = new ToolHandler(makeLogger());
  registerTaskTools(handler, deps);
});

// ---------------------------------------------------------------------------
// registerTaskTools
// ---------------------------------------------------------------------------

describe('registerTaskTools', () => {
  it('registers all expected tool names', () => {
    const tools = handler.registeredTools();
    expect(tools).toContain('dispatch_task');
    expect(tools).toContain('dispatch_task_and_wait');
    expect(tools).toContain('dispatch_subtask');
    expect(tools).toContain('get_task_status');
    expect(tools).toContain('cancel_task');
    expect(tools).toContain('list_tasks');
    // get_member_status is registered in tools-team.ts, not here
    expect(tools).not.toContain('get_member_status');
  });
});

// ---------------------------------------------------------------------------
// dispatch_task
// ---------------------------------------------------------------------------

describe('dispatch_task', () => {
  it('creates and dispatches task, returns task_id and status', async () => {
    const result = await handler.handleToolCall('c1', 'dispatch_task', {
      agent_aid: 'aid-worker-00000001',
      prompt: 'analyze the logs',
    }) as Record<string, JsonValue>;

    expect(result['task_id']).toBeDefined();
    expect(typeof result['task_id']).toBe('string');
    // Status is 'running' when WS dispatch succeeded
    expect(result['status']).toBe('running');

    expect(taskStore.create).toHaveBeenCalledOnce();
    expect(wsHub.sendToTeam).toHaveBeenCalledWith('dev-team', expect.any(String));
  });

  it('sends a task_dispatch WS message', async () => {
    await handler.handleToolCall('c2', 'dispatch_task', {
      agent_aid: 'aid-worker-00000001',
      prompt: 'do something',
    });

    const [teamSlug, encodedMsg] = (wsHub.sendToTeam as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(teamSlug).toBe('dev-team');

    const parsed = JSON.parse(encodedMsg) as { type: string; data: Record<string, JsonValue> };
    expect(parsed['type']).toBe('task_dispatch');
    expect(parsed['data']['agent_aid']).toBe('aid-worker-00000001');
    expect(parsed['data']['prompt']).toBe('do something');
    expect(typeof parsed['data']['task_id']).toBe('string');
  });

  it('updates task to running after successful WS dispatch', async () => {
    await handler.handleToolCall('c3', 'dispatch_task', {
      agent_aid: 'aid-worker-00000001',
      prompt: 'check status',
    });

    // taskStore.update is called to promote status to running
    expect(taskStore.update).toHaveBeenCalledOnce();
    const updatedTask = (taskStore.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as Task;
    expect(updatedTask.status).toBe('running');
  });

  it('throws ValidationError when agent_aid is missing', async () => {
    await expect(
      handler.handleToolCall('c4', 'dispatch_task', {
        prompt: 'do something',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('c5', 'dispatch_task', {
        prompt: 'do something',
      }),
    ).rejects.toThrow('agent_aid is required');
  });

  it('throws ValidationError when prompt is missing', async () => {
    await expect(
      handler.handleToolCall('c6', 'dispatch_task', {
        agent_aid: 'aid-worker-00000001',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('c7', 'dispatch_task', {
        agent_aid: 'aid-worker-00000001',
      }),
    ).rejects.toThrow('prompt is required');
  });

  it('throws NotFoundError when agent does not exist in OrgChart', async () => {
    await expect(
      handler.handleToolCall('c8', 'dispatch_task', {
        agent_aid: 'aid-ghost-00000000',
        prompt: 'do something',
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('throws ValidationError when agent is not in any team', async () => {
    // Agent exists in OrgChart but not assigned to any team
    const loneAgent = makeAgent('aid-lone-00000001', 'Lone Agent');
    const localOrgChart = makeMockOrgChart(
      { 'aid-lone-00000001': loneAgent },
      {}, // no teams
    );
    const localDeps: TaskToolsDeps = { ...deps, orgChart: localOrgChart };
    const localHandler = new ToolHandler(makeLogger());
    registerTaskTools(localHandler, localDeps);

    await expect(
      localHandler.handleToolCall('c9', 'dispatch_task', {
        agent_aid: 'aid-lone-00000001',
        prompt: 'do something',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      localHandler.handleToolCall('c10', 'dispatch_task', {
        agent_aid: 'aid-lone-00000001',
        prompt: 'do something',
      }),
    ).rejects.toThrow('is not in any team');
  });

  it('calls containerManager.ensureRunning before dispatching', async () => {
    await handler.handleToolCall('c11', 'dispatch_task', {
      agent_aid: 'aid-worker-00000001',
      prompt: 'run tests',
    });

    expect(containerManager.ensureRunning).toHaveBeenCalledWith('dev-team');
  });

  it('does not call ensureRunning when containerManager is null', async () => {
    const localDeps: TaskToolsDeps = { ...deps, containerManager: null };
    const localHandler = new ToolHandler(makeLogger());
    registerTaskTools(localHandler, localDeps);

    await expect(
      localHandler.handleToolCall('c12', 'dispatch_task', {
        agent_aid: 'aid-worker-00000001',
        prompt: 'run tests',
      }),
    ).resolves.toBeDefined();

    expect(containerManager.ensureRunning).not.toHaveBeenCalled();
  });

  it('task remains pending status when WS dispatch fails', async () => {
    (wsHub.sendToTeam as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('connection refused'),
    );

    const result = await handler.handleToolCall('c13', 'dispatch_task', {
      agent_aid: 'aid-worker-00000001',
      prompt: 'analyze logs',
    }) as Record<string, JsonValue>;

    // Status should still be 'pending' because the WS send failed
    expect(result['status']).toBe('pending');
    // update should NOT have been called since dispatch failed
    expect(taskStore.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// dispatch_task — DAG fields (blocked_by, priority, max_retries)
// ---------------------------------------------------------------------------

describe('dispatch_task — DAG fields', () => {
  it('keeps task pending and skips WS dispatch when blocked_by is non-empty', async () => {
    // Pre-create two blocker tasks so validation passes
    const blocker1 = makeTask('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    const blocker2 = makeTask('11111111-2222-3333-4444-555555555555');
    taskStore = makeMockTaskStore([blocker1, blocker2]);
    const localDeps: TaskToolsDeps = { ...deps, taskStore };
    const localHandler = new ToolHandler(makeLogger());
    registerTaskTools(localHandler, localDeps);

    const result = await localHandler.handleToolCall('dag1', 'dispatch_task', {
      agent_aid: 'aid-worker-00000001',
      prompt: 'blocked task',
      blocked_by: [
        'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        '11111111-2222-3333-4444-555555555555',
      ],
    });

    // Check task was created with blocked_by
    const createdTask = (taskStore.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as Task;
    expect(createdTask.blocked_by).toEqual([
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      '11111111-2222-3333-4444-555555555555',
    ]);
    expect(createdTask.status).toBe('pending');

    // Task should NOT be dispatched via WS — stays pending until blockers resolve
    expect(wsHub.sendToTeam).not.toHaveBeenCalled();

    // Result should report pending status
    const parsed = result as Record<string, unknown>;
    expect(parsed['status']).toBe('pending');
  });

  it('passes priority and max_retries through to task and WS message', async () => {
    await handler.handleToolCall('dag2', 'dispatch_task', {
      agent_aid: 'aid-worker-00000001',
      prompt: 'priority task',
      priority: 5,
      max_retries: 3,
    });

    const createdTask = (taskStore.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as Task;
    expect(createdTask.priority).toBe(5);
    expect(createdTask.max_retries).toBe(3);
    expect(createdTask.retry_count).toBe(0);

    // Check WS message includes priority and max_retries
    const [, encodedMsg] = (wsHub.sendToTeam as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    const parsed = JSON.parse(encodedMsg) as { type: string; data: Record<string, JsonValue> };
    expect(parsed['data']['priority']).toBe(5);
    expect(parsed['data']['max_retries']).toBe(3);
  });

  it('omits priority and max_retries from WS message when they are 0 (default)', async () => {
    await handler.handleToolCall('dag3', 'dispatch_task', {
      agent_aid: 'aid-worker-00000001',
      prompt: 'default priority task',
    });

    const [, encodedMsg] = (wsHub.sendToTeam as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    const parsed = JSON.parse(encodedMsg) as { type: string; data: Record<string, JsonValue> };
    expect(parsed['data']['priority']).toBeUndefined();
    expect(parsed['data']['max_retries']).toBeUndefined();
  });

  it('defaults blocked_by to empty array when not provided', async () => {
    await handler.handleToolCall('dag4', 'dispatch_task', {
      agent_aid: 'aid-worker-00000001',
      prompt: 'no deps task',
    });

    const createdTask = (taskStore.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as Task;
    expect(createdTask.blocked_by).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// dispatch_task — blocked_by validation
// ---------------------------------------------------------------------------

describe('dispatch_task — blocked_by validation', () => {
  it('rejects empty strings in blocked_by', async () => {
    await expect(
      handler.handleToolCall('bv1', 'dispatch_task', {
        agent_aid: 'aid-worker-00000001',
        prompt: 'task',
        blocked_by: [''],
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('bv1b', 'dispatch_task', {
        agent_aid: 'aid-worker-00000001',
        prompt: 'task',
        blocked_by: [''],
      }),
    ).rejects.toThrow('invalid task IDs');
  });

  it('rejects non-UUID strings in blocked_by', async () => {
    await expect(
      handler.handleToolCall('bv2', 'dispatch_task', {
        agent_aid: 'aid-worker-00000001',
        prompt: 'task',
        blocked_by: ['abc', '123'],
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('bv2b', 'dispatch_task', {
        agent_aid: 'aid-worker-00000001',
        prompt: 'task',
        blocked_by: ['not-a-uuid'],
      }),
    ).rejects.toThrow('must be UUID format');
  });

  it('rejects blocked_by with more than 50 elements', async () => {
    const tooMany = Array.from({ length: 51 }, (_, i) =>
      `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`
    );
    await expect(
      handler.handleToolCall('bv3', 'dispatch_task', {
        agent_aid: 'aid-worker-00000001',
        prompt: 'task',
        blocked_by: tooMany,
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('bv3b', 'dispatch_task', {
        agent_aid: 'aid-worker-00000001',
        prompt: 'task',
        blocked_by: tooMany,
      }),
    ).rejects.toThrow('exceeds maximum of 50');
  });

  it('rejects blocked_by IDs for tasks that do not exist in the store', async () => {
    const nonExistentID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await expect(
      handler.handleToolCall('bv4', 'dispatch_task', {
        agent_aid: 'aid-worker-00000001',
        prompt: 'task',
        blocked_by: [nonExistentID],
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('bv4b', 'dispatch_task', {
        agent_aid: 'aid-worker-00000001',
        prompt: 'task',
        blocked_by: [nonExistentID],
      }),
    ).rejects.toThrow('non-existent tasks');
  });

  it('accepts valid UUID task IDs that exist in the store', async () => {
    const existingTask = makeTask('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    taskStore = makeMockTaskStore([existingTask]);
    const localDeps: TaskToolsDeps = { ...deps, taskStore };
    const localHandler = new ToolHandler(makeLogger());
    registerTaskTools(localHandler, localDeps);

    const result = await localHandler.handleToolCall('bv5', 'dispatch_task', {
      agent_aid: 'aid-worker-00000001',
      prompt: 'blocked task',
      blocked_by: ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
    }) as Record<string, JsonValue>;

    expect(result['task_id']).toBeDefined();
    expect(result['status']).toBe('pending');
  });

  it('filters non-string values from blocked_by array', async () => {
    // Non-string values should be silently filtered out
    await handler.handleToolCall('bv6', 'dispatch_task', {
      agent_aid: 'aid-worker-00000001',
      prompt: 'task with mixed array',
      blocked_by: [42, null, true] as unknown as JsonValue[],
    });

    const createdTask = (taskStore.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as Task;
    expect(createdTask.blocked_by).toEqual([]);
  });

  it('throws ValidationError when blocked_by would create a dependency cycle', async () => {
    // Control the new task's UUID so we can set up a blocker that references it.
    const knownId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const blockerID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

    // Make randomUUID return our known ID
    const mockedUUID = vi.mocked(randomUUID);
    mockedUUID.mockReturnValue(knownId as ReturnType<typeof randomUUID>);

    try {
      // Blocker's blocked_by points back to the known new task ID -> cycle
      const cycleStore = makeMockTaskStore([
        makeTask(blockerID, { blocked_by: [knownId] }),
      ]);
      const cycleDeps: TaskToolsDeps = { ...deps, taskStore: cycleStore };
      const cycleHandler = new ToolHandler(makeLogger());
      registerTaskTools(cycleHandler, cycleDeps);

      await expect(
        cycleHandler.handleToolCall('bv-cycle', 'dispatch_task', {
          agent_aid: 'aid-worker-00000001',
          prompt: 'cyclic task',
          blocked_by: [blockerID],
        }),
      ).rejects.toThrow(ValidationError);
      await expect(
        cycleHandler.handleToolCall('bv-cycle2', 'dispatch_task', {
          agent_aid: 'aid-worker-00000001',
          prompt: 'cyclic task',
          blocked_by: [blockerID],
        }),
      ).rejects.toThrow('dependency cycle detected');
    } finally {
      mockedUUID.mockRestore();
    }
  });
  it('accepts blocked_by as a JSON-encoded string array', async () => {
    // SDK may serialize arrays as JSON strings when passing through MCP
    const blockerTask = makeTask('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    taskStore = makeMockTaskStore([blockerTask]);
    const localDeps: TaskToolsDeps = { ...deps, taskStore };
    const localHandler = new ToolHandler(makeLogger());
    registerTaskTools(localHandler, localDeps);

    await localHandler.handleToolCall('json-str', 'dispatch_task', {
      agent_aid: 'aid-worker-00000001',
      prompt: 'task with JSON string blocked_by',
      blocked_by: JSON.stringify(['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']) as unknown as JsonValue,
    });

    const createdTask = (taskStore.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as Task;
    expect(createdTask.blocked_by).toEqual(['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']);
  });
});

// ---------------------------------------------------------------------------
// dispatch_subtask — DAG fields
// ---------------------------------------------------------------------------

describe('dispatch_subtask — DAG fields', () => {
  it('passes blocked_by, priority, max_retries to subtask', async () => {
    const blockerTask = makeTask('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    taskStore = makeMockTaskStore([blockerTask]);
    const localDeps: TaskToolsDeps = { ...deps, taskStore };
    const localHandler = new ToolHandler(makeLogger());
    registerTaskTools(localHandler, localDeps);

    await localHandler.handleToolCall('sdag1', 'dispatch_subtask', {
      agent_aid: 'aid-worker-00000001',
      prompt: 'subtask with DAG',
      parent_task_id: 'parent-001',
      blocked_by: ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
      priority: 2,
      max_retries: 1,
    });

    const createdTask = (taskStore.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as Task;
    expect(createdTask.blocked_by).toEqual(['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']);
    expect(createdTask.priority).toBe(2);
    expect(createdTask.max_retries).toBe(1);
    expect(createdTask.parent_id).toBe('parent-001');
  });
});

// ---------------------------------------------------------------------------
// dispatch_subtask
// ---------------------------------------------------------------------------

describe('dispatch_subtask', () => {
  it('sets parent_id on the created task when parent_task_id is provided', async () => {
    const parentID = 'parent-task-001';

    await handler.handleToolCall('s1', 'dispatch_subtask', {
      agent_aid: 'aid-worker-00000001',
      prompt: 'subtask work',
      parent_task_id: parentID,
    });

    const createdTask = (taskStore.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as Task;
    expect(createdTask.parent_id).toBe(parentID);
  });

  it('works without parent_task_id (optional field)', async () => {
    const result = await handler.handleToolCall('s2', 'dispatch_subtask', {
      agent_aid: 'aid-worker-00000001',
      prompt: 'standalone subtask',
    }) as Record<string, JsonValue>;

    expect(result['task_id']).toBeDefined();

    const createdTask = (taskStore.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as Task;
    expect(createdTask.parent_id).toBeUndefined();
  });

  it('throws ValidationError when agent_aid is missing', async () => {
    await expect(
      handler.handleToolCall('s3', 'dispatch_subtask', {
        prompt: 'do something',
        parent_task_id: 'parent-123',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('requires prompt', async () => {
    await expect(
      handler.handleToolCall('s4', 'dispatch_subtask', {
        agent_aid: 'aid-worker-00000001',
        parent_task_id: 'parent-123',
      }),
    ).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// get_task_status
// ---------------------------------------------------------------------------

describe('get_task_status', () => {
  it('returns task object for a known task_id', async () => {
    const existingTask = makeTask('task-001', { status: 'running', team_slug: 'dev-team' });
    taskStore = makeMockTaskStore([existingTask]);
    const localDeps: TaskToolsDeps = { ...deps, taskStore };
    const localHandler = new ToolHandler(makeLogger());
    registerTaskTools(localHandler, localDeps);

    const result = await localHandler.handleToolCall('g1', 'get_task_status', {
      task_id: 'task-001',
    }) as Record<string, JsonValue>;

    expect(result['id']).toBe('task-001');
    expect(result['status']).toBe('running');
    expect(taskStore.get).toHaveBeenCalledWith('task-001');
  });

  it('throws ValidationError when task_id is missing', async () => {
    await expect(
      handler.handleToolCall('g2', 'get_task_status', {}),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('g3', 'get_task_status', {}),
    ).rejects.toThrow('task_id is required');
  });

  it('throws NotFoundError for unknown task_id', async () => {
    await expect(
      handler.handleToolCall('g4', 'get_task_status', { task_id: 'no-such-task' }),
    ).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// cancel_task
// ---------------------------------------------------------------------------

describe('cancel_task', () => {
  it('marks task as cancelled and sets completed_at', async () => {
    const pendingTask = makeTask('task-002', { status: 'pending' });
    taskStore = makeMockTaskStore([pendingTask]);
    const localDeps: TaskToolsDeps = { ...deps, taskStore };
    const localHandler = new ToolHandler(makeLogger());
    registerTaskTools(localHandler, localDeps);

    const result = await localHandler.handleToolCall('ca1', 'cancel_task', {
      task_id: 'task-002',
    }) as Record<string, JsonValue>;

    expect(result['task_id']).toBe('task-002');
    expect(result['status']).toBe('cancelled');

    expect(taskStore.update).toHaveBeenCalledOnce();
    const updatedTask = (taskStore.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as Task;
    expect(updatedTask.status).toBe('cancelled');
    expect(updatedTask.completed_at).toBeInstanceOf(Date);
  });

  it('returns cancelled_ids in result (fallback path, no coordinator)', async () => {
    const runningTask = makeTask('task-003', { status: 'running', team_slug: 'dev-team' });
    taskStore = makeMockTaskStore([runningTask]);
    const localDeps: TaskToolsDeps = { ...deps, taskStore, taskCoordinator: null };
    const localHandler = new ToolHandler(makeLogger());
    registerTaskTools(localHandler, localDeps);

    const result = await localHandler.handleToolCall('ca2', 'cancel_task', {
      task_id: 'task-003',
    }) as Record<string, JsonValue>;

    expect(result['task_id']).toBe('task-003');
    expect(result['status']).toBe('cancelled');
    expect(result['cancelled_ids']).toEqual(['task-003']);
  });

  it('throws ValidationError when task_id is missing', async () => {
    await expect(
      handler.handleToolCall('ca3', 'cancel_task', {}),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('ca4', 'cancel_task', {}),
    ).rejects.toThrow('task_id is required');
  });

  it('throws ValidationError when task is already completed', async () => {
    const completedTask = makeTask('task-004', { status: 'completed' });
    taskStore = makeMockTaskStore([completedTask]);
    const localDeps: TaskToolsDeps = { ...deps, taskStore };
    const localHandler = new ToolHandler(makeLogger());
    registerTaskTools(localHandler, localDeps);

    await expect(
      localHandler.handleToolCall('ca5', 'cancel_task', { task_id: 'task-004' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      localHandler.handleToolCall('ca6', 'cancel_task', { task_id: 'task-004' }),
    ).rejects.toThrow('already completed');
  });

  it('throws ValidationError when task is already failed', async () => {
    const failedTask = makeTask('task-005', { status: 'failed' });
    taskStore = makeMockTaskStore([failedTask]);
    const localDeps: TaskToolsDeps = { ...deps, taskStore };
    const localHandler = new ToolHandler(makeLogger());
    registerTaskTools(localHandler, localDeps);

    await expect(
      localHandler.handleToolCall('ca7', 'cancel_task', { task_id: 'task-005' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      localHandler.handleToolCall('ca8', 'cancel_task', { task_id: 'task-005' }),
    ).rejects.toThrow('already failed');
  });

  it('does not send WS message when team_slug is empty (fallback)', async () => {
    const noTeamTask = makeTask('task-006', { status: 'pending', team_slug: '' });
    taskStore = makeMockTaskStore([noTeamTask]);
    const localDeps: TaskToolsDeps = { ...deps, taskStore, taskCoordinator: null };
    const localHandler = new ToolHandler(makeLogger());
    registerTaskTools(localHandler, localDeps);

    await localHandler.handleToolCall('ca9', 'cancel_task', { task_id: 'task-006' });
    expect(wsHub.sendToTeam).not.toHaveBeenCalled();
  });

  it('delegates to taskCoordinator.cancelTask when coordinator is set', async () => {
    const mockCoordinator = {
      dispatchTask: vi.fn(),
      handleTaskResult: vi.fn(),
      cancelTask: vi.fn().mockResolvedValue(['task-010', 'task-011']),
      getTaskStatus: vi.fn(),
      createSubtasks: vi.fn(),
    };
    const localDeps: TaskToolsDeps = {
      ...deps,
      taskCoordinator: mockCoordinator,
    };
    const localHandler = new ToolHandler(makeLogger());
    registerTaskTools(localHandler, localDeps);

    const result = await localHandler.handleToolCall('ca10', 'cancel_task', {
      task_id: 'task-010',
    }) as Record<string, JsonValue>;

    expect(mockCoordinator.cancelTask).toHaveBeenCalledWith('task-010', true);
    expect(result['task_id']).toBe('task-010');
    expect(result['cancelled_ids']).toEqual(['task-010', 'task-011']);
    expect(result['status']).toBe('cancelled');
  });

  it('passes cascade=false when specified', async () => {
    const mockCoordinator = {
      dispatchTask: vi.fn(),
      handleTaskResult: vi.fn(),
      cancelTask: vi.fn().mockResolvedValue(['task-012']),
      getTaskStatus: vi.fn(),
      createSubtasks: vi.fn(),
    };
    const localDeps: TaskToolsDeps = {
      ...deps,
      taskCoordinator: mockCoordinator,
    };
    const localHandler = new ToolHandler(makeLogger());
    registerTaskTools(localHandler, localDeps);

    const result = await localHandler.handleToolCall('ca11', 'cancel_task', {
      task_id: 'task-012',
      cascade: false,
    }) as Record<string, JsonValue>;

    expect(mockCoordinator.cancelTask).toHaveBeenCalledWith('task-012', false);
    expect(result['cancelled_ids']).toEqual(['task-012']);
  });
});

// ---------------------------------------------------------------------------
// list_tasks
// ---------------------------------------------------------------------------

describe('list_tasks', () => {
  it('returns all running tasks by default (no filters)', async () => {
    const tasks: Task[] = [
      makeTask('t1', { status: 'running', team_slug: 'dev-team' }),
      makeTask('t2', { status: 'pending', team_slug: 'dev-team' }),
      makeTask('t3', { status: 'running', team_slug: 'ops-team' }),
    ];
    taskStore = makeMockTaskStore(tasks);
    const localDeps: TaskToolsDeps = { ...deps, taskStore };
    const localHandler = new ToolHandler(makeLogger());
    registerTaskTools(localHandler, localDeps);

    const result = await localHandler.handleToolCall('l1', 'list_tasks', {}) as Task[];
    expect(Array.isArray(result)).toBe(true);
    // Default is to list running tasks
    expect(taskStore.listByStatus).toHaveBeenCalledWith('running');
    expect(result).toHaveLength(2);
  });

  it('filters by team_slug when provided', async () => {
    const tasks: Task[] = [
      makeTask('t4', { status: 'running', team_slug: 'dev-team' }),
      makeTask('t5', { status: 'pending', team_slug: 'dev-team' }),
      makeTask('t6', { status: 'running', team_slug: 'ops-team' }),
    ];
    taskStore = makeMockTaskStore(tasks);
    const localDeps: TaskToolsDeps = { ...deps, taskStore };
    const localHandler = new ToolHandler(makeLogger());
    registerTaskTools(localHandler, localDeps);

    const result = await localHandler.handleToolCall('l2', 'list_tasks', {
      team_slug: 'dev-team',
    }) as Task[];

    expect(taskStore.listByTeam).toHaveBeenCalledWith('dev-team');
    expect(result).toHaveLength(2);
  });

  it('filters by status when provided', async () => {
    const tasks: Task[] = [
      makeTask('t7', { status: 'pending', team_slug: 'dev-team' }),
      makeTask('t8', { status: 'pending', team_slug: 'ops-team' }),
      makeTask('t9', { status: 'running', team_slug: 'dev-team' }),
    ];
    taskStore = makeMockTaskStore(tasks);
    const localDeps: TaskToolsDeps = { ...deps, taskStore };
    const localHandler = new ToolHandler(makeLogger());
    registerTaskTools(localHandler, localDeps);

    const result = await localHandler.handleToolCall('l3', 'list_tasks', {
      status: 'pending',
    }) as Task[];

    expect(taskStore.listByStatus).toHaveBeenCalledWith('pending');
    expect(result).toHaveLength(2);
  });

  it('respects the limit argument', async () => {
    const tasks: Task[] = [
      makeTask('t10', { status: 'running', team_slug: 'dev-team' }),
      makeTask('t11', { status: 'running', team_slug: 'dev-team' }),
      makeTask('t12', { status: 'running', team_slug: 'dev-team' }),
    ];
    taskStore = makeMockTaskStore(tasks);
    const localDeps: TaskToolsDeps = { ...deps, taskStore };
    const localHandler = new ToolHandler(makeLogger());
    registerTaskTools(localHandler, localDeps);

    const result = await localHandler.handleToolCall('l4', 'list_tasks', {
      limit: 2,
    }) as Task[];

    expect(result).toHaveLength(2);
  });

  it('does not truncate when limit is 0 (unlimited)', async () => {
    const tasks: Task[] = [
      makeTask('t13', { status: 'running', team_slug: 'dev-team' }),
      makeTask('t14', { status: 'running', team_slug: 'dev-team' }),
      makeTask('t15', { status: 'running', team_slug: 'dev-team' }),
    ];
    taskStore = makeMockTaskStore(tasks);
    const localDeps: TaskToolsDeps = { ...deps, taskStore };
    const localHandler = new ToolHandler(makeLogger());
    registerTaskTools(localHandler, localDeps);

    const result = await localHandler.handleToolCall('l5', 'list_tasks', {
      limit: 0,
    }) as Task[];

    expect(result).toHaveLength(3);
  });

  it('throws ValidationError for invalid status string', async () => {
    await expect(
      handler.handleToolCall('l6', 'list_tasks', { status: 'exploded' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('l7', 'list_tasks', { status: 'exploded' }),
    ).rejects.toThrow('invalid status: exploded');
  });

  it('throws ValidationError for invalid team_slug', async () => {
    await expect(
      handler.handleToolCall('l8', 'list_tasks', { team_slug: 'Invalid Slug!' }),
    ).rejects.toThrow(ValidationError);
  });

  it('team_slug takes precedence over status', async () => {
    const tasks: Task[] = [
      makeTask('t16', { status: 'running', team_slug: 'dev-team' }),
    ];
    taskStore = makeMockTaskStore(tasks);
    const localDeps: TaskToolsDeps = { ...deps, taskStore };
    const localHandler = new ToolHandler(makeLogger());
    registerTaskTools(localHandler, localDeps);

    await localHandler.handleToolCall('l9', 'list_tasks', {
      team_slug: 'dev-team',
      status: 'pending',
    });

    // team_slug takes precedence — listByTeam is called, not listByStatus
    expect(taskStore.listByTeam).toHaveBeenCalledWith('dev-team');
    expect(taskStore.listByStatus).not.toHaveBeenCalled();
  });
});
