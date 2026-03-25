/**
 * Layer 5 Phase Gate -- Org MCP Server
 *
 * Tests with mock ISessionSpawner + real OrgTree:
 * - UT-6: All 7 tools registered with correct names and schemas
 * - spawn_team: creates org tree entry, calls spawner
 * - shutdown_team: validates parent, calls stop, removes from tree
 * - delegate_task: scope admission passes/rejects, validates parent
 * - escalate: generates correlation_id, persists to store, queues for parent
 * - send_message: validates parent/child relationship, blocks unrelated teams
 * - get_status: returns only caller's children, shows queue depth
 * - UT-10: Scope admission rejects/admits correctly, reject-by-default for ambiguous
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createToolInvoker } from '../org-mcp/registry.js';
import type { OrgMcpDeps, OrgToolInvoker } from '../org-mcp/registry.js';
import { OrgTree } from '../domain/org-tree.js';
import type {
  IOrgStore,
  ISessionSpawner,
  ISessionManager,
  ITaskQueueStore,
  IEscalationStore,
} from '../domain/interfaces.js';
import type { OrgTreeNode, TeamConfig, TaskEntry, EscalationCorrelation } from '../domain/types.js';
import { TeamStatus, TaskPriority, TaskStatus } from '../domain/types.js';
import { checkScopeAdmission } from '../org-mcp/scope-admission.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeNode(overrides: Partial<OrgTreeNode> & { teamId: string; name: string }): OrgTreeNode {
  return {
    parentId: null,
    status: TeamStatus.Idle,
    agents: [],
    children: [],
    ...overrides,
  };
}

function createMemoryOrgStore(): IOrgStore {
  const data = new Map<string, OrgTreeNode>();
  return {
    addTeam(node: OrgTreeNode): void { data.set(node.teamId, node); },
    removeTeam(id: string): void { data.delete(id); },
    getTeam(id: string): OrgTreeNode | undefined { return data.get(id); },
    getChildren(parentId: string): OrgTreeNode[] {
      return [...data.values()].filter((n) => n.parentId === parentId);
    },
    getAncestors(): OrgTreeNode[] { return []; },
    getAll(): OrgTreeNode[] { return [...data.values()]; },
  };
}

function createMockTaskQueue(): ITaskQueueStore & { tasks: TaskEntry[] } {
  let idCounter = 0;
  const tasks: TaskEntry[] = [];

  return {
    tasks,
    enqueue(teamId: string, task: string, priority: string, correlationId?: string): string {
      idCounter += 1;
      const id = `task-${String(idCounter).padStart(4, '0')}`;
      tasks.push({
        id,
        teamId,
        task,
        priority: (priority as TaskPriority) || TaskPriority.Normal,
        status: TaskStatus.Pending,
        createdAt: new Date().toISOString(),
        correlationId: correlationId ?? null,
      });
      return id;
    },
    dequeue(teamId: string): TaskEntry | undefined {
      const idx = tasks.findIndex((t) => t.teamId === teamId && t.status === TaskStatus.Pending);
      if (idx === -1) return undefined;
      const entry = { ...tasks[idx], status: TaskStatus.Running };
      tasks[idx] = entry;
      return entry;
    },
    peek(teamId: string): TaskEntry | undefined {
      return tasks.find((t) => t.teamId === teamId && t.status === TaskStatus.Pending);
    },
    getByTeam(teamId: string): TaskEntry[] {
      return tasks.filter((t) => t.teamId === teamId);
    },
    updateStatus(taskId: string, status: TaskStatus): void {
      const idx = tasks.findIndex((t) => t.id === taskId);
      if (idx !== -1) {
        tasks[idx] = { ...tasks[idx], status };
      }
    },
    getPending(): TaskEntry[] {
      return tasks.filter((t) => t.status === TaskStatus.Pending);
    },
    getByStatus(status: TaskStatus): TaskEntry[] {
      return tasks.filter((t) => t.status === status);
    },
  };
}

function createMockEscalationStore(): IEscalationStore & { records: EscalationCorrelation[] } {
  const records: EscalationCorrelation[] = [];
  return {
    records,
    create(c: EscalationCorrelation): void { records.push(c); },
    updateStatus(correlationId: string, status: string): void {
      const idx = records.findIndex((r) => r.correlationId === correlationId);
      if (idx !== -1) {
        records[idx] = { ...records[idx], status };
      }
    },
    getByCorrelationId(id: string): EscalationCorrelation | undefined {
      return records.find((r) => r.correlationId === id);
    },
  };
}

function makeTeamConfig(overrides?: Partial<TeamConfig>): TeamConfig {
  return {
    name: 'test-team',
    parent: null,
    description: 'A test team',
    scope: { accepts: ['weather', 'forecast'], rejects: ['admin'] },
    allowed_tools: [],
    mcp_servers: [],
    provider_profile: 'default',
    maxTurns: 50,
    ...overrides,
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────

let orgTree: OrgTree;
let spawner: ISessionSpawner;
let sessionManager: ISessionManager;
let taskQueue: ReturnType<typeof createMockTaskQueue>;
let escalationStore: ReturnType<typeof createMockEscalationStore>;
let teamConfigs: Map<string, TeamConfig>;
let logMessages: Array<{ msg: string; meta?: Record<string, unknown> }>;
let server: OrgToolInvoker;

async function setupServer(): Promise<void> {
  const store = createMemoryOrgStore();
  orgTree = new OrgTree(store);
  spawner = { spawn: vi.fn<ISessionSpawner['spawn']>().mockResolvedValue('session-1') };
  sessionManager = { getSession: vi.fn().mockResolvedValue(null), terminateSession: vi.fn().mockResolvedValue(undefined) };
  taskQueue = createMockTaskQueue();
  escalationStore = createMockEscalationStore();
  teamConfigs = new Map<string, TeamConfig>();
  logMessages = [];

  const deps: OrgMcpDeps = {
    orgTree,
    spawner,
    sessionManager,
    taskQueue,
    escalationStore,
    runDir: '/tmp/openhive-test',
    loadConfig: (name: string) => {
      const cfg = teamConfigs.get(name);
      if (!cfg) throw new Error(`no config for team "${name}"`);
      return cfg;
    },
    getTeamConfig: (teamId: string) => teamConfigs.get(teamId),
    log: (msg: string, meta?: Record<string, unknown>) => { logMessages.push({ msg, meta }); },
  };

  server = createToolInvoker(deps);
}

// ── UT-6: Tool Registration ──────────────────────────────────────────────

describe('UT-6: All 7 tools registered', () => {
  beforeEach(setupServer);

  it('registers exactly 7 tools', () => {
    expect(server.tools.size).toBe(7);
  });

  it('registers spawn_team with correct name', () => {
    const tool = server.tools.get('spawn_team');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('spawn_team');
    expect(tool!.description).toBeTruthy();
    expect(tool!.inputSchema).toBeDefined();
  });

  it('registers shutdown_team with correct name', () => {
    const tool = server.tools.get('shutdown_team');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('shutdown_team');
  });

  it('registers delegate_task with correct name', () => {
    const tool = server.tools.get('delegate_task');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('delegate_task');
  });

  it('registers escalate with correct name', () => {
    const tool = server.tools.get('escalate');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('escalate');
  });

  it('registers send_message with correct name', () => {
    const tool = server.tools.get('send_message');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('send_message');
  });

  it('registers get_status with correct name', () => {
    const tool = server.tools.get('get_status');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('get_status');
  });

  it('registers query_team with correct name', () => {
    const tool = server.tools.get('query_team');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('query_team');
    expect(tool!.description).toBeTruthy();
    expect(tool!.inputSchema).toBeDefined();
  });
});

// ── spawn_team ────────────────────────────────────────────────────────────

describe('spawn_team', () => {
  beforeEach(setupServer);

  it('creates org tree entry and calls spawner', async () => {
    teamConfigs.set('weather', makeTeamConfig({ name: 'weather' }));

    const result = await server.invoke('spawn_team', { name: 'weather', scope_accepts: ['weather'] }, 'root');

    expect(result).toEqual({ success: true, team: 'weather' });
    expect(orgTree.getTeam('weather')).toBeDefined();
    expect(orgTree.getTeam('weather')?.parentId).toBe('root');
    expect(spawner.spawn).toHaveBeenCalledWith('weather', 'weather');
  });

  it('rejects duplicate team name', async () => {
    teamConfigs.set('dup', makeTeamConfig({ name: 'dup' }));
    orgTree.addTeam(makeNode({ teamId: 'dup', name: 'dup' }));

    const result = await server.invoke('spawn_team', { name: 'dup', scope_accepts: ['test'] }, 'root');

    expect(result).toEqual(expect.objectContaining({ success: false }));
  });

  it('rolls back org tree on spawn failure', async () => {
    teamConfigs.set('fail-team', makeTeamConfig({ name: 'fail-team' }));
    vi.mocked(spawner.spawn).mockRejectedValueOnce(new Error('docker unavailable'));

    const result = await server.invoke('spawn_team', { name: 'fail-team', scope_accepts: ['test'] }, 'root');

    expect(result).toEqual(expect.objectContaining({ success: false }));
    expect(orgTree.getTeam('fail-team')).toBeUndefined();
  });
});

// ── shutdown_team ──────────────────────────────────────────────────────────

describe('shutdown_team', () => {
  beforeEach(async () => {
    await setupServer();
    orgTree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    orgTree.addTeam(makeNode({ teamId: 'child', name: 'child', parentId: 'root' }));
  });

  it('stops session and removes from tree', async () => {
    const result = await server.invoke('shutdown_team', { name: 'child' }, 'root');

    expect(result).toEqual({ success: true });
    expect(orgTree.getTeam('child')).toBeUndefined();
    expect(sessionManager.terminateSession).toHaveBeenCalledWith('child');
  });

  it('rejects when caller is not parent', async () => {
    orgTree.addTeam(makeNode({ teamId: 'stranger', name: 'stranger' }));

    const result = await server.invoke('shutdown_team', { name: 'child' }, 'stranger');

    expect(result).toEqual(expect.objectContaining({ success: false }));
    // Team should still exist
    expect(orgTree.getTeam('child')).toBeDefined();
  });

  it('rejects when team not found', async () => {
    const result = await server.invoke('shutdown_team', { name: 'ghost' }, 'root');

    expect(result).toEqual(expect.objectContaining({ success: false }));
  });
});

// ── delegate_task ──────────────────────────────────────────────────────────

describe('delegate_task', () => {
  beforeEach(async () => {
    await setupServer();
    orgTree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    orgTree.addTeam(makeNode({ teamId: 'weather-team', name: 'weather-team', parentId: 'root' }));
    teamConfigs.set('weather-team', makeTeamConfig({
      name: 'weather-team',
      scope: { accepts: ['weather', 'forecast'], rejects: ['admin'] },
    }));
  });

  it('admits task matching accept scope and enqueues', async () => {
    const result = await server.invoke(
      'delegate_task',
      { team: 'weather-team', task: 'get weather forecast for NYC' },
      'root',
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    const typed = result as { success: boolean; task_id: string };
    expect(typed.task_id).toBeTruthy();
    expect(taskQueue.tasks).toHaveLength(1);
    expect(taskQueue.tasks[0].teamId).toBe('weather-team');
  });

  it('rejects task matching reject scope (F-9)', async () => {
    const result = await server.invoke(
      'delegate_task',
      { team: 'weather-team', task: 'admin reset all passwords' },
      'root',
    );

    const typed = result as { success: boolean; reason: string; team: string };
    expect(typed.success).toBe(false);
    expect(typed.reason).toContain('admin');
    expect(typed.team).toBe('weather-team');
    expect(taskQueue.tasks).toHaveLength(0);
  });

  it('rejects task with no matching accept pattern (reject-by-default F-9)', async () => {
    const result = await server.invoke(
      'delegate_task',
      { team: 'weather-team', task: 'calculate pi to 1000 digits' },
      'root',
    );

    const typed = result as { success: boolean; reason: string };
    expect(typed.success).toBe(false);
    expect(typed.reason).toContain('out-of-scope');
  });

  it('validates caller is parent', async () => {
    orgTree.addTeam(makeNode({ teamId: 'stranger', name: 'stranger' }));

    const result = await server.invoke(
      'delegate_task',
      { team: 'weather-team', task: 'get weather' },
      'stranger',
    );

    const typed = result as { success: boolean; reason: string };
    expect(typed.success).toBe(false);
    expect(typed.reason).toContain('not parent');
  });

  it('uses specified priority', async () => {
    const result = await server.invoke(
      'delegate_task',
      { team: 'weather-team', task: 'urgent weather alert', priority: 'critical' },
      'root',
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(taskQueue.tasks[0].priority).toBe('critical');
  });
});

// ── escalate ─────────────────────────────────────────────────────────────

describe('escalate', () => {
  beforeEach(async () => {
    await setupServer();
    orgTree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    orgTree.addTeam(makeNode({ teamId: 'child', name: 'child', parentId: 'root' }));
  });

  it('generates correlation_id and persists to store', async () => {
    const result = await server.invoke(
      'escalate',
      { message: 'Need help with complex task', reason: 'out of scope' },
      'child',
    );

    const typed = result as { success: boolean; correlation_id: string };
    expect(typed.success).toBe(true);
    expect(typed.correlation_id).toBeTruthy();

    // Verify escalation store
    expect(escalationStore.records).toHaveLength(1);
    expect(escalationStore.records[0].sourceTeam).toBe('child');
    expect(escalationStore.records[0].targetTeam).toBe('root');
    expect(escalationStore.records[0].correlationId).toBe(typed.correlation_id);
  });

  it('queues task for parent with high priority', async () => {
    await server.invoke(
      'escalate',
      { message: 'Need help' },
      'child',
    );

    expect(taskQueue.tasks).toHaveLength(1);
    expect(taskQueue.tasks[0].teamId).toBe('root');
    expect(taskQueue.tasks[0].priority).toBe(TaskPriority.High);
    expect(taskQueue.tasks[0].task).toContain('Need help');
  });

  it('fails when caller has no parent', async () => {
    const result = await server.invoke(
      'escalate',
      { message: 'Help' },
      'root',
    );

    const typed = result as { success: boolean; error: string };
    expect(typed.success).toBe(false);
    expect(typed.error).toContain('no parent');
  });

  it('fails when caller not found in org tree', async () => {
    const result = await server.invoke(
      'escalate',
      { message: 'Help' },
      'ghost',
    );

    const typed = result as { success: boolean; error: string };
    expect(typed.success).toBe(false);
    expect(typed.error).toContain('not found');
  });
});

// ── send_message ──────────────────────────────────────────────────────────

describe('send_message', () => {
  beforeEach(async () => {
    await setupServer();
    orgTree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    orgTree.addTeam(makeNode({ teamId: 'child-a', name: 'child-a', parentId: 'root' }));
    orgTree.addTeam(makeNode({ teamId: 'child-b', name: 'child-b', parentId: 'root' }));
  });

  it('allows child to send to parent', async () => {
    const result = await server.invoke(
      'send_message',
      { target: 'root', message: 'status update' },
      'child-a',
    );

    expect(result).toEqual({ success: true });
    expect(logMessages).toHaveLength(1);
    expect(logMessages[0].meta!['from']).toBe('child-a');
    expect(logMessages[0].meta!['to']).toBe('root');
  });

  it('allows parent to send to child', async () => {
    const result = await server.invoke(
      'send_message',
      { target: 'child-a', message: 'instructions' },
      'root',
    );

    expect(result).toEqual({ success: true });
  });

  it('blocks unrelated teams (sibling to sibling)', async () => {
    const result = await server.invoke(
      'send_message',
      { target: 'child-b', message: 'hello sibling' },
      'child-a',
    );

    const typed = result as { success: boolean; error: string };
    expect(typed.success).toBe(false);
    expect(typed.error).toContain('neither parent nor child');
  });

  it('fails when target not found', async () => {
    const result = await server.invoke(
      'send_message',
      { target: 'ghost', message: 'hello' },
      'child-a',
    );

    const typed = result as { success: boolean; error: string };
    expect(typed.success).toBe(false);
    expect(typed.error).toContain('not found');
  });
});

// ── get_status ────────────────────────────────────────────────────────────

describe('get_status', () => {
  beforeEach(async () => {
    await setupServer();
    orgTree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    orgTree.addTeam(makeNode({ teamId: 'team-a', name: 'team-a', parentId: 'root' }));
    orgTree.addTeam(makeNode({ teamId: 'team-b', name: 'team-b', parentId: 'root' }));
  });

  it('returns all children when no team specified', async () => {
    const result = await server.invoke('get_status', {}, 'root');

    const typed = result as { success: boolean; teams: Array<{ teamId: string }> };
    expect(typed.success).toBe(true);
    expect(typed.teams).toHaveLength(2);
    const ids = typed.teams.map((t) => t.teamId).sort();
    expect(ids).toEqual(['team-a', 'team-b']);
  });

  it('returns specific child team status', async () => {
    const result = await server.invoke('get_status', { team: 'team-a' }, 'root');

    const typed = result as { success: boolean; teams: Array<{ teamId: string; queueDepth: number }> };
    expect(typed.success).toBe(true);
    expect(typed.teams).toHaveLength(1);
    expect(typed.teams[0].teamId).toBe('team-a');
    expect(typed.teams[0].queueDepth).toBe(0);
  });

  it('shows correct queue depth', async () => {
    taskQueue.enqueue('team-a', 'task 1', 'normal');
    taskQueue.enqueue('team-a', 'task 2', 'high');
    taskQueue.enqueue('team-b', 'task 3', 'normal');

    const result = await server.invoke('get_status', { team: 'team-a' }, 'root');

    const typed = result as { success: boolean; teams: Array<{ queueDepth: number; pendingCount: number }> };
    expect(typed.teams[0].queueDepth).toBe(2);
    expect(typed.teams[0].pendingCount).toBe(2);
  });

  it('rejects when target is not child of caller', async () => {
    orgTree.addTeam(makeNode({ teamId: 'stranger', name: 'stranger' }));

    const result = await server.invoke('get_status', { team: 'team-a' }, 'stranger');

    const typed = result as { success: boolean; error: string };
    expect(typed.success).toBe(false);
    expect(typed.error).toContain('not a child');
  });
});

// ── UT-10: Scope Admission ───────────────────────────────────────────────

describe('UT-10: Scope Admission', () => {
  const scope = { accepts: ['weather', 'forecast', 'temperature'], rejects: ['admin', 'delete'] };

  it('admits task with matching accept keyword', () => {
    const result = checkScopeAdmission('get weather for NYC', scope);
    expect(result.admitted).toBe(true);
    expect(result.reason).toContain('weather');
  });

  it('rejects task with matching reject keyword', () => {
    const result = checkScopeAdmission('admin reset passwords', scope);
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain('admin');
  });

  it('rejects take priority over accepts', () => {
    const result = checkScopeAdmission('admin weather override', scope);
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain('admin');
  });

  it('reject-by-default for ambiguous task (F-9)', () => {
    const result = checkScopeAdmission('calculate fibonacci sequence', scope);
    expect(result.admitted).toBe(false);
    expect(result.reason).toBe('out-of-scope: no matching accept pattern');
  });

  it('handles empty scope (rejects everything by default)', () => {
    const result = checkScopeAdmission('any task', { accepts: [], rejects: [] });
    expect(result.admitted).toBe(false);
    expect(result.reason).toBe('out-of-scope: no matching accept pattern');
  });

  it('admits with partial keyword match', () => {
    const result = checkScopeAdmission('check the temperatures today', scope);
    expect(result.admitted).toBe(true);
  });
});

// ── R-1: Error handling (must not crash) ──────────────────────────────────

describe('R-1: Server error handling', () => {
  beforeEach(setupServer);

  it('returns error for unknown tool', async () => {
    const result = await server.invoke('nonexistent_tool', {}, 'root');

    const typed = result as { success: boolean; error: string };
    expect(typed.success).toBe(false);
    expect(typed.error).toContain('unknown tool');
  });

  it('catches handler exceptions and returns error', async () => {
    // Force an exception by making spawner throw
    teamConfigs.set('boom', makeTeamConfig({ name: 'boom' }));
    vi.mocked(spawner.spawn).mockRejectedValueOnce(new Error('kaboom'));

    const result = await server.invoke('spawn_team', { name: 'boom', scope_accepts: ['test'] }, 'root');

    const typed = result as { success: boolean; error: string };
    expect(typed.success).toBe(false);
    // The error is handled inside spawnTeam, not at the server catch level
    expect(typed.error).toContain('spawn failed');
  });
});

// ── query_team ────────────────────────────────────────────────────────────

describe('query_team', () => {
  beforeEach(async () => {
    await setupServer();
    orgTree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    orgTree.addTeam(makeNode({ teamId: 'weather-team', name: 'weather-team', parentId: 'root' }));
    teamConfigs.set('weather-team', makeTeamConfig({
      name: 'weather-team',
      scope: { accepts: ['weather', 'forecast'], rejects: ['admin'] },
    }));
  });

  it('returns error if target team not found', async () => {
    const result = await server.invoke('query_team', { team: 'ghost', query: 'hello' }, 'root');
    const typed = result as { success: boolean; error: string };
    expect(typed.success).toBe(false);
    expect(typed.error).toContain('not found');
  });

  it('returns error if caller is not parent', async () => {
    orgTree.addTeam(makeNode({ teamId: 'stranger', name: 'stranger' }));
    const result = await server.invoke('query_team', { team: 'weather-team', query: 'weather?' }, 'stranger');
    const typed = result as { success: boolean; error: string };
    expect(typed.success).toBe(false);
    expect(typed.error).toContain('not parent');
  });

  it('returns error if scope admission fails', async () => {
    const result = await server.invoke('query_team', { team: 'weather-team', query: 'admin reset' }, 'root');
    const typed = result as { success: boolean; error: string };
    expect(typed.success).toBe(false);
    expect(typed.error).toContain('admin');
  });

  it('returns error if queryRunner not configured', async () => {
    // queryRunner is undefined (no providers)
    const result = await server.invoke('query_team', { team: 'weather-team', query: 'get weather' }, 'root');
    const typed = result as { success: boolean; error: string };
    expect(typed.success).toBe(false);
    expect(typed.error).toContain('not available');
  });

  it('CLAUDE_CODE_STREAM_CLOSE_TIMEOUT is set in buildQueryOptions env', async () => {
    // Verify timeout is included in SDK env options (no longer global process.env mutation)
    const { buildQueryOptions } = await import('../sessions/query-options.js');
    const opts = buildQueryOptions({
      teamName: 'child',
      teamConfig: makeTeamConfig({ name: 'child' }),
      runDir: '/tmp/test',
      dataDir: '/tmp/data',
      systemRulesDir: '/tmp/rules',
      providers: { profiles: { default: { type: 'api', model: 'claude-sonnet-4-5-20250514', api_key: process.env['ANTHROPIC_API_KEY'] ?? 'test-placeholder' } } } as never,
      availableMcpServers: {},
      ancestors: [],
      logger: { info: () => {} },
    });

    expect(opts.env['CLAUDE_CODE_STREAM_CLOSE_TIMEOUT']).toBe('1800000');
  });
});

// ── query_team: happy path + error detection ──────────────────────────────

describe('query_team handler logic', () => {
  it('returns success with mocked queryRunner response', async () => {
    const { queryTeam } = await import('../org-mcp/tools/query-team.js');

    const store = createMemoryOrgStore();
    const tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'child', name: 'child', parentId: 'root' }));
    const configs = new Map<string, TeamConfig>();
    configs.set('child', makeTeamConfig({ name: 'child', scope: { accepts: ['test'], rejects: [] } }));

    const result = await queryTeam(
      { team: 'child', query: 'test query' },
      'root',
      {
        orgTree: tree,
        getTeamConfig: (id) => configs.get(id),
        queryRunner: async () => 'The weather is sunny',
        log: () => {},
      },
    );

    expect(result.success).toBe(true);
    expect(result.response).toBe('The weather is sunny');
  });

  it('detects error strings from queryRunner as failures', async () => {
    const { queryTeam } = await import('../org-mcp/tools/query-team.js');

    const store = createMemoryOrgStore();
    const tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'child', name: 'child', parentId: 'root' }));
    const configs = new Map<string, TeamConfig>();
    configs.set('child', makeTeamConfig({ name: 'child', scope: { accepts: ['test'], rejects: [] } }));

    const result = await queryTeam(
      { team: 'child', query: 'test query' },
      'root',
      {
        orgTree: tree,
        getTeamConfig: (id) => configs.get(id),
        queryRunner: async () => 'Error processing message: SDK not available',
        log: () => {},
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Error processing message');
  });
});

// ── spawn_team filesystem + init + credentials ───────────────────────────

import { tmpdir } from 'node:os';
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as yamlParse } from 'yaml';
import { spawnTeam } from '../org-mcp/tools/spawn-team.js';

describe('spawn_team filesystem and init', () => {
  let dir: string;
  let tree: OrgTree;
  let mockSpawner: { spawn: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  let mockTaskQueue: ReturnType<typeof createMockTaskQueue>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openhive-l5-fs-'));
    mkdirSync(join(dir, 'teams'), { recursive: true });
    const store = createMemoryOrgStore();
    tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    mockSpawner = { spawn: vi.fn().mockResolvedValue('sid'), stop: vi.fn() };
    mockTaskQueue = createMockTaskQueue();
  });

  function makeDeps(overrides?: Partial<Parameters<typeof spawnTeam>[2]>) {
    return {
      orgTree: tree,
      spawner: mockSpawner,
      runDir: dir,
      loadConfig: (_name: string, _cp?: string, hints?: { description?: string; scopeAccepts?: string[]; scopeRejects?: string[] }) => ({
        name: _name, parent: null, description: hints?.description ?? '',
        scope: { accepts: hints?.scopeAccepts ?? [], rejects: hints?.scopeRejects ?? [] },
        allowed_tools: ['*'], mcp_servers: [] as string[], provider_profile: 'default', maxTurns: 100,
      }),
      taskQueue: mockTaskQueue,
      ...overrides,
    };
  }

  it('scaffolds all 6 subdirectories', async () => {
    await spawnTeam({ name: 'ops', scope_accepts: ['ops'] }, 'root', makeDeps());
    for (const sub of ['workspace', 'memory', 'org-rules', 'team-rules', 'skills', 'subagents']) {
      expect(existsSync(join(dir, 'teams', 'ops', sub))).toBe(true);
    }
  });

  it('writes config.yaml with correct content', async () => {
    await spawnTeam({ name: 'ops', description: 'My ops team', scope_accepts: ['logs'] }, 'root', makeDeps());
    const raw = readFileSync(join(dir, 'teams', 'ops', 'config.yaml'), 'utf-8');
    const cfg = yamlParse(raw) as Record<string, unknown>;
    expect(cfg['name']).toBe('ops');
    expect(cfg['description']).toBe('My ops team');
  });

  it('enforces org in mcp_servers even when config omits it', async () => {
    await spawnTeam({ name: 'ops', scope_accepts: ['ops'] }, 'root', makeDeps());
    const raw = readFileSync(join(dir, 'teams', 'ops', 'config.yaml'), 'utf-8');
    const cfg = yamlParse(raw) as { mcp_servers: string[] };
    expect(cfg.mcp_servers).toContain('org');
  });

  it('enforces org when config_path provides config without org', async () => {
    const cfgPath = join(dir, 'no-org.yaml');
    writeFileSync(cfgPath, 'name: custom\nmcp_servers: [analytics]\nscope:\n  accepts: []\n  rejects: []\nallowed_tools: ["*"]\nprovider_profile: default\nmaxTurns: 50\n');
    const { loadTeamConfig } = await import('../config/loader.js');
    const deps = makeDeps({ loadConfig: (_n, cp) => cp ? loadTeamConfig(cp) : makeDeps().loadConfig(_n) });
    await spawnTeam({ name: 'custom', config_path: cfgPath }, 'root', deps);
    const raw = readFileSync(join(dir, 'teams', 'custom', 'config.yaml'), 'utf-8');
    const cfg = yamlParse(raw) as { mcp_servers: string[] };
    expect(cfg.mcp_servers).toContain('org');
    expect(cfg.mcp_servers).toContain('analytics');
  });

  it('writes credentials to config.yaml', async () => {
    const testToken = 'test-fake-token-value-1234567890';
    await spawnTeam({ name: 'ops', scope_accepts: ['ops'], credentials: { api_key: testToken, subdomain: 'acme' } }, 'root', makeDeps());
    const raw = readFileSync(join(dir, 'teams', 'ops', 'config.yaml'), 'utf-8');
    const cfg = yamlParse(raw) as { credentials: Record<string, string> };
    expect(cfg.credentials['api_key']).toBe(testToken);
    expect(cfg.credentials['subdomain']).toBe('acme');
  });

  it('config has no credentials section when none provided', async () => {
    await spawnTeam({ name: 'ops', scope_accepts: ['ops'] }, 'root', makeDeps());
    const raw = readFileSync(join(dir, 'teams', 'ops', 'config.yaml'), 'utf-8');
    const cfg = yamlParse(raw) as { credentials?: Record<string, string> };
    expect(cfg.credentials).toBeUndefined();
  });

  it('writes init-context.md when init_context provided', async () => {
    await spawnTeam({ name: 'ops', scope_accepts: ['logs'], init_context: 'Monitor logs every 10 minutes' }, 'root', makeDeps());
    const content = readFileSync(join(dir, 'teams', 'ops', 'memory', 'init-context.md'), 'utf-8');
    expect(content).toBe('Monitor logs every 10 minutes');
  });

  it('does NOT write init-context.md when omitted', async () => {
    await spawnTeam({ name: 'ops', scope_accepts: ['ops'] }, 'root', makeDeps());
    expect(existsSync(join(dir, 'teams', 'ops', 'memory', 'init-context.md'))).toBe(false);
  });

  it('auto-queues init task with critical priority', async () => {
    await spawnTeam({ name: 'ops', scope_accepts: ['ops'], init_context: 'Setup instructions' }, 'root', makeDeps());
    expect(mockTaskQueue.tasks).toHaveLength(1);
    expect(mockTaskQueue.tasks[0].teamId).toBe('ops');
    expect(mockTaskQueue.tasks[0].priority).toBe(TaskPriority.Critical);
    expect(mockTaskQueue.tasks[0].task).toContain('Bootstrap');
  });

  it('rolls back dirs + org tree + session on enqueue failure', async () => {
    const failQueue = {
      ...mockTaskQueue,
      enqueue: () => { throw new Error('queue full'); },
    };
    const result = await spawnTeam({ name: 'ops', scope_accepts: ['ops'] }, 'root', makeDeps({ taskQueue: failQueue }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('init enqueue failed');
    expect(tree.getTeam('ops')).toBeUndefined();
    expect(existsSync(join(dir, 'teams', 'ops'))).toBe(false);
    expect(mockSpawner.stop).toHaveBeenCalledWith('ops');
  });

  it('cleans up on spawn failure', async () => {
    mockSpawner.spawn.mockRejectedValueOnce(new Error('docker down'));
    const result = await spawnTeam({ name: 'fail', scope_accepts: ['test'] }, 'root', makeDeps());
    expect(result.success).toBe(false);
    expect(tree.getTeam('fail')).toBeUndefined();
    expect(existsSync(join(dir, 'teams', 'fail'))).toBe(false);
  });
});

// ── Credential redaction ─────────────────────────────────────────────────

import { scrubSecrets } from '../logging/credential-scrubber.js';

describe('Credential redaction with raw secrets', () => {
  it('scrubs team credential values from text', () => {
    const testToken = 'test-fake-token-for-redaction-test';
    const result = scrubSecrets(
      `Calling API with token ${testToken}`,
      [],
      [testToken],
    );
    expect(result).not.toContain(testToken);
    expect(result).toContain('[REDACTED]');
  });

  it('does not redact short values (< 8 chars)', () => {
    const result = scrubSecrets('subdomain is prod', [], ['prod']);
    expect(result).toContain('prod');
  });
});

// ── Fix 1C: spawn_team note when credentials provided ─────────────────────

describe('spawn_team credential note', () => {
  let dir: string;
  let tree: OrgTree;
  let mockSpawner: { spawn: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  let mockTaskQueue: ReturnType<typeof createMockTaskQueue>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openhive-l5-note-'));
    mkdirSync(join(dir, 'teams'), { recursive: true });
    const store = createMemoryOrgStore();
    tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    mockSpawner = { spawn: vi.fn().mockResolvedValue('sid'), stop: vi.fn() };
    mockTaskQueue = createMockTaskQueue();
  });

  function makeDeps() {
    return {
      orgTree: tree,
      spawner: mockSpawner,
      runDir: dir,
      loadConfig: (_name: string, _cp?: string, hints?: { description?: string; scopeAccepts?: string[]; scopeRejects?: string[] }) => ({
        name: _name, parent: null, description: hints?.description ?? '',
        scope: { accepts: hints?.scopeAccepts ?? [], rejects: hints?.scopeRejects ?? [] },
        allowed_tools: ['*'], mcp_servers: [] as string[], provider_profile: 'default', maxTurns: 100,
      }),
      taskQueue: mockTaskQueue,
    };
  }

  it('returns note when credentials are provided', async () => {
    const result = await spawnTeam(
      { name: 'cred-team', scope_accepts: ['test'], credentials: { subdomain: 'test-fake-credential-1234' } },
      'root', makeDeps(),
    );
    expect(result.success).toBe(true);
    expect(result.note).toContain('Do NOT echo credential values');
  });

  it('does not return note when no credentials', async () => {
    const result = await spawnTeam(
      { name: 'no-cred', scope_accepts: ['test'] },
      'root', makeDeps(),
    );
    expect(result.success).toBe(true);
    expect(result.note).toBeUndefined();
  });
});

// ── Fix 2: Fail-closed scope check ───────────────────────────────────────

describe('delegate_task fail-closed scope check', () => {
  it('rejects when getTeamConfig returns undefined', async () => {
    const { delegateTask: dt } = await import('../org-mcp/tools/delegate-task.js');
    const store = createMemoryOrgStore();
    const tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'child', name: 'child', parentId: 'root' }));

    const result = dt(
      { team: 'child', task: 'do something', priority: 'normal' },
      'root',
      { orgTree: tree, taskQueue: createMockTaskQueue(), getTeamConfig: () => undefined, log: () => {} },
    );
    expect(result.success).toBe(false);
    expect(result.reason).toContain('config not loadable');
  });
});

describe('query_team fail-closed scope check', () => {
  it('rejects when getTeamConfig returns undefined', async () => {
    const { queryTeam: qt } = await import('../org-mcp/tools/query-team.js');
    const store = createMemoryOrgStore();
    const tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'child', name: 'child', parentId: 'root' }));

    const result = await qt(
      { team: 'child', query: 'hello' },
      'root',
      { orgTree: tree, getTeamConfig: () => undefined, log: () => {} },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('config not loadable');
  });
});

// ── Fix 1B: query_team credential scrubbing ──────────────────────────────

describe('query_team credential scrubbing', () => {
  it('scrubs child team credentials from response', async () => {
    const { queryTeam: qt } = await import('../org-mcp/tools/query-team.js');
    const store = createMemoryOrgStore();
    const tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'child', name: 'child', parentId: 'root' }));

    const testFakeValue = 'test-fake-value-for-scrubbing';
    const configs = new Map<string, TeamConfig>();
    configs.set('child', makeTeamConfig({
      name: 'child',
      scope: { accepts: ['test'], rejects: [] },
      credentials: { subdomain: testFakeValue },
    }));

    const result = await qt(
      { team: 'child', query: 'test query' },
      'root',
      {
        orgTree: tree,
        getTeamConfig: (id) => configs.get(id),
        queryRunner: async () => `The value is ${testFakeValue} and it works`,
        log: () => {},
      },
    );
    expect(result.success).toBe(true);
    expect(result.response).not.toContain(testFakeValue);
    expect(result.response).toContain('[REDACTED]');
  });
});

// ── Fix 3: Parent set to callerId ────────────────────────────────────────

describe('spawn_team parent normalization', () => {
  it('config.yaml parent field matches callerId', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'openhive-l5-parent-'));
    mkdirSync(join(dir2, 'teams'), { recursive: true });
    const store = createMemoryOrgStore();
    const tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));

    const result = await spawnTeam(
      { name: 'child-team', scope_accepts: ['test'], description: 'Test' },
      'root',
      {
        orgTree: tree,
        spawner: { spawn: vi.fn().mockResolvedValue('sid'), stop: vi.fn() },
        runDir: dir2,
        loadConfig: (_n: string, _cp?: string, hints?: { description?: string; scopeAccepts?: string[]; scopeRejects?: string[] }) => ({
          name: _n, parent: null, description: hints?.description ?? '',
          scope: { accepts: hints?.scopeAccepts ?? [], rejects: hints?.scopeRejects ?? [] },
          allowed_tools: ['*'], mcp_servers: [] as string[], provider_profile: 'default', maxTurns: 100,
        }),
        taskQueue: createMockTaskQueue(),
      },
    );
    expect(result.success).toBe(true);

    const raw = readFileSync(join(dir2, 'teams', 'child-team', 'config.yaml'), 'utf-8');
    const cfg = yamlParse(raw) as { parent: string };
    expect(cfg.parent).toBe('root');
  });
});

// ── Fix 4: scope_accepts required without config_path ────────────────────

describe('spawn_team scope_accepts validation', () => {
  it('rejects when no scope_accepts and no config_path', async () => {
    const result = await spawnTeam(
      { name: 'no-scope' },
      'root',
      {
        orgTree: new OrgTree(createMemoryOrgStore()),
        spawner: { spawn: vi.fn().mockResolvedValue('sid') },
        runDir: '/tmp/test',
        loadConfig: () => makeTeamConfig(),
        taskQueue: createMockTaskQueue(),
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('scope_accepts');
  });

  it('rejects scope_accepts with empty strings', async () => {
    const result = await spawnTeam(
      { name: 'empty-scope', scope_accepts: [''] },
      'root',
      {
        orgTree: new OrgTree(createMemoryOrgStore()),
        spawner: { spawn: vi.fn().mockResolvedValue('sid') },
        runDir: '/tmp/test',
        loadConfig: () => makeTeamConfig(),
        taskQueue: createMockTaskQueue(),
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid input');
  });

  it('allows spawn with config_path but no scope_accepts', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'openhive-l5-cfg-'));
    mkdirSync(join(dir2, 'teams'), { recursive: true });
    const cfgPath = join(dir2, 'custom.yaml');
    writeFileSync(cfgPath, 'name: custom\nscope:\n  accepts: [ops]\n  rejects: []\nallowed_tools: ["*"]\nmcp_servers: []\nprovider_profile: default\nmaxTurns: 50\n');

    const store = createMemoryOrgStore();
    const tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    const { loadTeamConfig: ltc } = await import('../config/loader.js');

    const result = await spawnTeam(
      { name: 'custom', config_path: cfgPath },
      'root',
      {
        orgTree: tree,
        spawner: { spawn: vi.fn().mockResolvedValue('sid') },
        runDir: dir2,
        loadConfig: (_n, cp) => cp ? ltc(cp) : makeTeamConfig(),
        taskQueue: createMockTaskQueue(),
      },
    );
    expect(result.success).toBe(true);
  });
});
