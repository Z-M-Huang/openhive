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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerTaskTools, type TaskToolsDeps } from './tools-task.js';
import { ToolHandler } from './toolhandler.js';
import { ValidationError, NotFoundError } from '../domain/errors.js';
import type { TaskStore, WSHub, ContainerManager, OrgChart } from '../domain/interfaces.js';
import type { Task, Agent, Team, JsonValue } from '../domain/types.js';

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

  it('sends MsgTypeShutdown to the team container', async () => {
    const runningTask = makeTask('task-003', { status: 'running', team_slug: 'dev-team' });
    taskStore = makeMockTaskStore([runningTask]);
    const localDeps: TaskToolsDeps = { ...deps, taskStore };
    const localHandler = new ToolHandler(makeLogger());
    registerTaskTools(localHandler, localDeps);

    await localHandler.handleToolCall('ca2', 'cancel_task', {
      task_id: 'task-003',
    });

    expect(wsHub.sendToTeam).toHaveBeenCalledOnce();
    const [teamSlug, encodedMsg] = (wsHub.sendToTeam as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(teamSlug).toBe('dev-team');

    const parsed = JSON.parse(encodedMsg) as { type: string; data: Record<string, JsonValue> };
    expect(parsed['type']).toBe('shutdown');
    expect(typeof parsed['data']['reason']).toBe('string');
    expect(parsed['data']['reason']).toContain('task-003');
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

  it('does not send WS message when team_slug is empty', async () => {
    const noTeamTask = makeTask('task-006', { status: 'pending', team_slug: '' });
    taskStore = makeMockTaskStore([noTeamTask]);
    const localDeps: TaskToolsDeps = { ...deps, taskStore };
    const localHandler = new ToolHandler(makeLogger());
    registerTaskTools(localHandler, localDeps);

    await localHandler.handleToolCall('ca9', 'cancel_task', { task_id: 'task-006' });
    expect(wsHub.sendToTeam).not.toHaveBeenCalled();
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
