/**
 * Shared test helpers for org-mcp tool tests.
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
import { TeamStatus, TaskPriority, TaskStatus } from '../domain/types.js';
import { createToolInvoker } from './registry.js';
import type { OrgMcpDeps, OrgToolInvoker } from './registry.js';

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
  };
}

// ── Factory: In-memory ITaskQueueStore ────────────────────────────────────

export function createMockTaskQueue(): ITaskQueueStore & { tasks: TaskEntry[] } {
  let idCounter = 0;
  const tasks: TaskEntry[] = [];

  return {
    tasks,
    enqueue(teamId: string, task: string, priority: string, correlationId?: string, options?: string): string {
      idCounter += 1;
      const id = `task-${String(idCounter).padStart(4, '0')}`;
      // Extract sourceChannelId from options JSON if present
      let sourceChannelId: string | null = null;
      if (options) {
        try {
          const parsed = JSON.parse(options) as Record<string, unknown>;
          if (typeof parsed.sourceChannelId === 'string') sourceChannelId = parsed.sourceChannelId;
        } catch { /* not JSON */ }
      }
      tasks.push({
        id,
        teamId,
        task,
        priority: (priority as TaskPriority) || TaskPriority.Normal,
        status: TaskStatus.Pending,
        createdAt: new Date().toISOString(),
        correlationId: correlationId ?? null,
        result: null,
        durationMs: null,
        options: options ?? null,
        sourceChannelId,
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
    updateStatus(correlationId: string, status: string): void {
      const idx = records.findIndex((r) => r.correlationId === correlationId);
      if (idx !== -1) {
        records[idx] = { ...records[idx], status };
      }
    },
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

// ── Factory: Full OrgMcpDeps + OrgToolInvoker server ─────────────────────

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

export function setupServer(): ServerFixtures {
  const store = createMemoryOrgStore();
  const orgTree = new OrgTree(store);
  const spawner: ISessionSpawner = { spawn: vi.fn<ISessionSpawner['spawn']>().mockResolvedValue('session-1') };
  const sessionManager: ISessionManager = { getSession: vi.fn().mockResolvedValue(null), terminateSession: vi.fn().mockResolvedValue(undefined) };
  const taskQueue = createMockTaskQueue();
  const escalationStore = createMockEscalationStore();
  const teamConfigs = new Map<string, TeamConfig>();
  const logMessages: Array<{ msg: string; meta?: Record<string, unknown> }> = [];

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

  const server = createToolInvoker(deps);

  return { orgTree, spawner, sessionManager, taskQueue, escalationStore, teamConfigs, logMessages, server };
}
