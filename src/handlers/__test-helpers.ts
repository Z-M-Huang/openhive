/**
 * Shared test helpers for handler tool tests.
 *
 * Exports factory functions only — never mutable state.
 */

import { vi } from 'vitest';
import { OrgTree } from '../domain/org-tree.js';
import type {
  IOrgStore,
  ISessionSpawner,
  ISessionManager,
  ITaskQueueStore,
  IEscalationStore,
} from '../domain/interfaces.js';
import type { OrgTreeNode, TeamConfig, TaskEntry, EscalationCorrelation } from '../domain/types.js';
import { TeamStatus, TaskStatus } from '../domain/types.js';
import type { TaskPriority, TaskType, TaskOptions } from '../domain/types.js';
import { errorMessage } from '../domain/errors.js';

// Direct handler imports — standalone, no shared invoker
import { spawnTeam, SpawnTeamInputSchema } from './tools/spawn-team.js';
import { shutdownTeam, ShutdownTeamInputSchema } from './tools/shutdown-team.js';
import { delegateTask, DelegateTaskInputSchema } from './tools/delegate-task.js';
import { escalate, EscalateInputSchema } from './tools/escalate.js';
import { sendMessage, SendMessageInputSchema } from './tools/send-message.js';
import { getStatus, GetStatusInputSchema } from './tools/get-status.js';
import { queryTeam, QueryTeamInputSchema } from './tools/query-team.js';
import { listTeams, ListTeamsInputSchema } from './tools/list-teams.js';
import { getCredential, GetCredentialInputSchema } from './tools/get-credential.js';
import { updateTeam, UpdateTeamInputSchema } from './tools/update-team.js';

// ── Factory: OrgTreeNode ──────────────────────────────────────────────────

export function makeNode(overrides: Partial<OrgTreeNode> & { teamId: string; name: string }): OrgTreeNode {
  return {
    parentId: null,
    status: TeamStatus.Idle,
    agents: [],
    children: [],
    ...overrides,
  };
}

// ── Factory: TeamConfig ───────────────────────────────────────────────────

export function makeTeamConfig(overrides?: Partial<TeamConfig>): TeamConfig {
  return {
    name: 'test-team',
    parent: null,
    description: 'A test team',
    allowed_tools: [],
    mcp_servers: [],
    provider_profile: 'default',
    maxTurns: 50,
    ...overrides,
  };
}

// ── Factory: In-memory IOrgStore ──────────────────────────────────────────

export function createMemoryOrgStore(): IOrgStore {
  const data = new Map<string, OrgTreeNode>();
  const scopeMap = new Map<string, Set<string>>();
  return {
    addTeam(node: OrgTreeNode): void { data.set(node.teamId, node); },
    removeTeam(id: string): void { scopeMap.delete(id); data.delete(id); },
    getTeam(id: string): OrgTreeNode | undefined { return data.get(id); },
    getChildren(parentId: string): OrgTreeNode[] {
      return [...data.values()].filter((n) => n.parentId === parentId);
    },
    getAncestors(): OrgTreeNode[] { return []; },
    getAll(): OrgTreeNode[] { return [...data.values()]; },
    addScopeKeywords(teamId: string, keywords: string[]): void {
      const set = scopeMap.get(teamId) ?? new Set();
      for (const kw of keywords) set.add(kw.toLowerCase().trim());
      scopeMap.set(teamId, set);
    },
    removeScopeKeywords(teamId: string): void { scopeMap.delete(teamId); },
    removeScopeKeyword(teamId: string, keyword: string): void {
      scopeMap.get(teamId)?.delete(keyword.toLowerCase().trim());
    },
    getOwnScope(teamId: string): string[] { return [...(scopeMap.get(teamId) ?? [])]; },
    getEffectiveScope(teamId: string): string[] {
      const collect = (id: string): string[] => {
        const own = [...(scopeMap.get(id) ?? [])];
        const children = [...data.values()].filter((n) => n.parentId === id);
        for (const child of children) own.push(...collect(child.teamId));
        return own;
      };
      return [...new Set(collect(teamId))];
    },
    setBootstrapped(): void {},
    isBootstrapped(): boolean { return false; },
  };
}

// ── Factory: In-memory ITaskQueueStore ────────────────────────────────────

export function createMockTaskQueue(): ITaskQueueStore & { tasks: TaskEntry[] } {
  let idCounter = 0;
  const tasks: TaskEntry[] = [];

  return {
    tasks,
    enqueue(teamId: string, task: string, priority: TaskPriority, type?: TaskType, sourceChannelId?: string, correlationId?: string, options?: TaskOptions): string {
      idCounter += 1;
      const id = `task-${String(idCounter).padStart(4, '0')}`;
      tasks.push({
        id,
        teamId,
        task,
        priority: priority || 'normal',
        type: type || 'delegate',
        status: TaskStatus.Pending,
        createdAt: new Date().toISOString(),
        correlationId: correlationId ?? null,
        result: null,
        durationMs: null,
        options: options ?? null,
        sourceChannelId: sourceChannelId ?? null,
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
    updateResult(taskId: string, result: string): void {
      const idx = tasks.findIndex((t) => t.id === taskId);
      if (idx !== -1) {
        tasks[idx] = { ...tasks[idx], result };
      }
    },
    getPending(): TaskEntry[] {
      return tasks.filter((t) => t.status === TaskStatus.Pending);
    },
    getByStatus(status: TaskStatus): TaskEntry[] {
      return tasks.filter((t) => t.status === status);
    },
    removeByTeam(teamId: string): void {
      const indices = tasks.reduce<number[]>((acc, t, i) => t.teamId === teamId ? [...acc, i] : acc, []);
      for (const i of indices.reverse()) tasks.splice(i, 1);
    },
  };
}

// ── Factory: In-memory IEscalationStore ───────────────────────────────────

export function createMockEscalationStore(): IEscalationStore & { records: EscalationCorrelation[] } {
  const records: EscalationCorrelation[] = [];
  return {
    records,
    create(c: EscalationCorrelation): void { records.push(c); },
    getByCorrelationId(id: string): EscalationCorrelation | undefined {
      return records.find((r) => r.correlationId === id);
    },
    removeByTeam(teamId: string): void {
      const filtered = records.filter(r => r.sourceTeam !== teamId && r.targetTeam !== teamId);
      records.length = 0;
      records.push(...filtered);
    },
  };
}

// ── OrgToolInvoker — local type for test fixtures ────────────────────────

export interface ToolMeta {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export interface OrgToolInvoker {
  readonly tools: ReadonlyMap<string, ToolMeta>;
  invoke(toolName: string, input: unknown, callerId: string, sourceChannelId?: string): Promise<unknown>;
}

// ── Factory: Full server fixtures with direct handler map ────────────────

export interface ServerFixtures {
  orgTree: OrgTree;
  spawner: ISessionSpawner;
  sessionManager: ISessionManager;
  taskQueue: ReturnType<typeof createMockTaskQueue>;
  escalationStore: ReturnType<typeof createMockEscalationStore>;
  teamConfigs: Map<string, TeamConfig>;
  logMessages: Array<{ msg: string; meta?: Record<string, unknown> }>;
  server: OrgToolInvoker;
}

type ToolHandler = (input: unknown, callerId: string, sourceChannelId?: string) => Promise<unknown>;

export function setupServer(): ServerFixtures {
  const store = createMemoryOrgStore();
  const orgTree = new OrgTree(store);
  const spawner: ISessionSpawner = { spawn: vi.fn<ISessionSpawner['spawn']>().mockResolvedValue('session-1') };
  const sessionManager: ISessionManager = { getSession: vi.fn().mockResolvedValue(null), terminateSession: vi.fn().mockResolvedValue(undefined) };
  const taskQueue = createMockTaskQueue();
  const escalationStore = createMockEscalationStore();
  const teamConfigs = new Map<string, TeamConfig>();
  const logMessages: Array<{ msg: string; meta?: Record<string, unknown> }> = [];

  const loadConfig = (name: string) => {
    const cfg = teamConfigs.get(name);
    if (!cfg) throw new Error(`no config for team "${name}"`);
    return cfg;
  };
  const getTeamConfig = (teamId: string) => teamConfigs.get(teamId);
  const log = (msg: string, meta?: Record<string, unknown>) => { logMessages.push({ msg, meta }); };

  // Tool metadata for tests that inspect the tool catalog
  const toolMeta = new Map<string, ToolMeta>([
    ['spawn_team', { name: 'spawn_team', description: 'Create a new team and spawn its session', inputSchema: SpawnTeamInputSchema }],
    ['shutdown_team', { name: 'shutdown_team', description: 'Shut down a team, persist tasks, remove from org tree', inputSchema: ShutdownTeamInputSchema }],
    ['delegate_task', { name: 'delegate_task', description: 'Delegate a task to a child team', inputSchema: DelegateTaskInputSchema }],
    ['escalate', { name: 'escalate', description: 'Escalate an issue to parent team', inputSchema: EscalateInputSchema }],
    ['send_message', { name: 'send_message', description: 'Send a message to a parent or child team', inputSchema: SendMessageInputSchema }],
    ['get_status', { name: 'get_status', description: 'Get status of child teams including queue depth', inputSchema: GetStatusInputSchema }],
    ['list_teams', { name: 'list_teams', description: 'List child teams with descriptions, scope keywords, and status for routing decisions', inputSchema: ListTeamsInputSchema }],
    ['query_team', { name: 'query_team', description: 'Synchronously query a child team and return its response', inputSchema: QueryTeamInputSchema }],
    ['get_credential', { name: 'get_credential', description: 'Retrieve a credential value by key', inputSchema: GetCredentialInputSchema }],
    ['update_team', { name: 'update_team', description: 'Update a child team scope keywords', inputSchema: UpdateTeamInputSchema }],
  ]);

  // Build tool name → handler map with deps pre-bound
  const toolMap = new Map<string, ToolHandler>([
    ['spawn_team', (input, callerId, sourceChannelId) =>
      spawnTeam(input as never, callerId, { orgTree, spawner, runDir: '/tmp/openhive-test', loadConfig, taskQueue }, sourceChannelId)],
    ['shutdown_team', (input, callerId) =>
      shutdownTeam(input as never, callerId, { orgTree, sessionManager, taskQueue, escalationStore, runDir: '/tmp/openhive-test' })],
    ['delegate_task', (input, callerId, sourceChannelId) =>
      Promise.resolve(delegateTask(input as never, callerId, { orgTree, taskQueue, log }, sourceChannelId))],
    ['escalate', (input, callerId, sourceChannelId) =>
      Promise.resolve(escalate(input as never, callerId, { orgTree, escalationStore, taskQueue }, sourceChannelId))],
    ['send_message', (input, callerId) =>
      Promise.resolve(sendMessage(input as never, callerId, { orgTree, log }))],
    ['get_status', (input, callerId) =>
      Promise.resolve(getStatus(input as never, callerId, { orgTree, taskQueue }))],
    ['list_teams', (input, callerId) =>
      Promise.resolve(listTeams(input as never, callerId, { orgTree, taskQueue, getTeamConfig }))],
    ['query_team', (input, callerId, sourceChannelId) =>
      queryTeam(input as never, callerId, { orgTree, getTeamConfig, log }, sourceChannelId)],
    ['get_credential', (input, callerId) =>
      Promise.resolve(getCredential(input as never, callerId, { getTeamConfig, log }))],
    ['update_team', (input, callerId) =>
      Promise.resolve(updateTeam(input as never, callerId, { orgTree, log }))],
  ]);

  const server: OrgToolInvoker = {
    tools: toolMeta,
    async invoke(toolName: string, input: unknown, callerId: string, sourceChannelId?: string): Promise<unknown> {
      const handler = toolMap.get(toolName);
      if (!handler) {
        return { success: false, error: `unknown tool: ${toolName}` };
      }
      try {
        return await handler(input, callerId, sourceChannelId);
      } catch (err) {
        return { success: false, error: `tool error: ${errorMessage(err)}` };
      }
    },
  };

  return { orgTree, spawner, sessionManager, taskQueue, escalationStore, teamConfigs, logMessages, server };
}
