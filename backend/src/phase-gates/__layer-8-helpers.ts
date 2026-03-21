/**
 * Shared mock factories for Layer 8 phase gate tests.
 */

import { vi } from 'vitest';

import { AgentStatus } from '../domain/enums.js';
import { NotFoundError } from '../domain/errors.js';
import type {
  OrgChart,
  WSHub,
  TaskStore,
  Logger,
  MCPRegistry,
  ToolCallStore,
  HealthMonitor,
  LogStore,
  MemoryStore,
} from '../domain/interfaces.js';
import type { Task } from '../domain/domain.js';

export function createMockLogger(): Logger {
  return {
    log: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    audit: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

export function createMockOrgChart(): OrgChart {
  return {
    addTeam: vi.fn(),
    updateTeam: vi.fn(),
    removeTeam: vi.fn(),
    getTeam: vi.fn(),
    getTeamBySlug: vi.fn(),
    listTeams: vi.fn().mockReturnValue([]),
    getChildren: vi.fn().mockReturnValue([]),
    getParent: vi.fn(),
    addAgent: vi.fn(),
    updateAgent: vi.fn(),
    removeAgent: vi.fn(),
    getAgent: vi.fn(),
    getAgentsByTeam: vi.fn().mockReturnValue([]),
    isAuthorized: vi.fn().mockReturnValue(true),
    getTopology: vi.fn().mockReturnValue([]),
    getDispatchTarget: vi.fn(),
  };
}

export function createMockWSHub(): WSHub {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    setReady: vi.fn(),
    isReady: vi.fn().mockReturnValue(true),
    getConnectedTeams: vi.fn().mockReturnValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    handleUpgrade: vi.fn(),
  };
}

export function createMockTaskStore(): TaskStore {
  const tasks = new Map<string, Task>();
  return {
    create: vi.fn(async (task: Task) => { tasks.set(task.id, task); }),
    get: vi.fn(async (id: string) => {
      const task = tasks.get(id);
      if (!task) throw new NotFoundError(`Task ${id} not found`);
      return task;
    }),
    update: vi.fn(async (task: Task) => { tasks.set(task.id, task); }),
    delete: vi.fn(async (id: string) => { tasks.delete(id); }),
    listByTeam: vi.fn().mockResolvedValue([]),
    listByStatus: vi.fn().mockResolvedValue([]),
    getSubtree: vi.fn().mockResolvedValue([]),
    getBlockedBy: vi.fn().mockResolvedValue([]),
    unblockTask: vi.fn().mockResolvedValue(true),
    retryTask: vi.fn().mockResolvedValue(true),
    validateDependencies: vi.fn().mockResolvedValue(undefined),
    getRecentUserTasks: vi.fn().mockResolvedValue([]),
    getNextPendingForAgent: vi.fn().mockResolvedValue(null),
  };
}

export function createMockMCPRegistry(): MCPRegistry {
  return {
    registerTool: vi.fn(),
    unregisterTool: vi.fn(),
    getTool: vi.fn(),
    listTools: vi.fn().mockReturnValue([]),
    getToolsForRole: vi.fn().mockReturnValue([]),
    isAllowed: vi.fn().mockReturnValue(true),
  };
}

export function createMockToolCallStore(): ToolCallStore {
  return {
    create: vi.fn().mockResolvedValue(undefined),
    getByTask: vi.fn().mockResolvedValue([]),
    getByAgent: vi.fn().mockResolvedValue([]),
    getByToolName: vi.fn().mockResolvedValue([]),
  };
}

export function createMockHealthMonitor(): HealthMonitor {
  return {
    recordHeartbeat: vi.fn(),
    getHealth: vi.fn(),
    getAgentHealth: vi.fn().mockReturnValue(AgentStatus.Idle),
    getAllHealth: vi.fn().mockReturnValue(new Map()),
    getStuckAgents: vi.fn().mockReturnValue([]),
    checkTimeouts: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

export function createMockLogStore(): LogStore {
  return {
    create: vi.fn().mockResolvedValue(undefined),
    createWithIds: vi.fn().mockResolvedValue([1]),
    query: vi.fn().mockResolvedValue([]),
    deleteBefore: vi.fn().mockResolvedValue(0),
    deleteByLevelBefore: vi.fn().mockResolvedValue(0),
    count: vi.fn().mockResolvedValue(0),
    getOldest: vi.fn().mockResolvedValue([]),
  };
}

export function createMockMemoryStore(): MemoryStore {
  return {
    save: vi.fn().mockResolvedValue(1),
    search: vi.fn().mockResolvedValue([]),
    getByAgent: vi.fn().mockResolvedValue([]),
    deleteBefore: vi.fn().mockResolvedValue(0),
    softDeleteByAgent: vi.fn().mockResolvedValue(0),
    softDeleteByTeam: vi.fn().mockResolvedValue(0),
    purgeDeleted: vi.fn().mockResolvedValue(0),
    searchBM25: vi.fn().mockResolvedValue([]),
    searchHybrid: vi.fn().mockResolvedValue([]),
    saveChunks: vi.fn().mockResolvedValue(undefined),
    getChunks: vi.fn().mockResolvedValue([]),
    deleteChunks: vi.fn().mockResolvedValue(undefined),
  };
}
