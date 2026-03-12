/**
 * Integration tests for the 5 orchestrator collaborators.
 * AC-L8-01, AC-L8-04 through AC-L8-15, AC-L8-18, AC-L8-19.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';

import { ToolCallDispatcher } from './tool-call-dispatcher';
import { TaskDAGManager } from './task-dag-manager';
import { EscalationRouter } from './escalation-router';
import { ProactiveScheduler } from './proactive-scheduler';
import { RetentionWorker } from './retention-worker';

import { TaskStatus, AgentStatus, LogLevel, AgentRole } from '../domain/enums.js';
import { RateLimitedError, AccessDeniedError } from '../domain/errors.js';

// Mock factory functions
function createMockOrgChart() {
  return {
    addTeam: vi.fn(), removeTeam: vi.fn(), addAgent: vi.fn(), removeAgent: vi.fn(),
    getTeam: vi.fn(), getParent: vi.fn(), getLeadOf: vi.fn(),
    getTeamBySlug: vi.fn(), getTeamByTid: vi.fn(), getAgent: vi.fn(),
    getAgentsByTeam: vi.fn(), getTeamLead: vi.fn(), getParentTeam: vi.fn(),
    getChildren: vi.fn(), isAncestor: vi.fn(), isAuthorized: vi.fn(),
    getTopology: vi.fn(), listTeams: vi.fn(),
  };
}

function createMockWSHub() {
  return {
    register: vi.fn(), unregister: vi.fn(), route: vi.fn(), send: vi.fn(),
    broadcast: vi.fn(), handleUpgrade: vi.fn(), isConnected: vi.fn(),
    close: vi.fn(), getConnectedTeams: vi.fn(),
  };
}

function createMockTaskStore() {
  return {
    create: vi.fn(), get: vi.fn(), getById: vi.fn(), update: vi.fn(),
    updateStatus: vi.fn(), delete: vi.fn(), listByTeam: vi.fn(),
    listByStatus: vi.fn(), listBlockedBy: vi.fn(), getBlockedBy: vi.fn(),
    getSubtree: vi.fn(), unblockTask: vi.fn(), validateDependencies: vi.fn(),
    retryTask: vi.fn(),
  };
}

function createMockEventBus() {
  return {
    subscribe: vi.fn(), filteredSubscribe: vi.fn(), unsubscribe: vi.fn(),
    publish: vi.fn(), close: vi.fn(),
  };
}

function createMockLogger() {
  return {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
    error: vi.fn(), audit: vi.fn(), log: vi.fn(), flush: vi.fn(), stop: vi.fn(),
  };
}

function createMockMCPRegistry() {
  return {
    registerTool: vi.fn(), unregisterTool: vi.fn(), getTool: vi.fn(),
    isAllowed: vi.fn(), listTools: vi.fn(), getToolsForRole: vi.fn(),
  };
}

function createMockToolCallStore() {
  return {
    create: vi.fn(), getByTask: vi.fn(), getByAgent: vi.fn(),
    getByToolName: vi.fn(), listByAgent: vi.fn(),
  };
}

function createMockHealthMonitor() {
  return {
    recordHeartbeat: vi.fn(), getHealth: vi.fn(), getAgentHealth: vi.fn(),
    getAllHealth: vi.fn(), getStuckAgents: vi.fn(), start: vi.fn(), stop: vi.fn(),
  };
}

function createMockLogStore() {
  return {
    create: vi.fn(), batchCreate: vi.fn(), list: vi.fn(), deleteByIds: vi.fn(),
    count: vi.fn(), getOldest: vi.fn(), deleteByLevelBefore: vi.fn(), deleteBefore: vi.fn(),
    query: vi.fn(),
  };
}

function createMockMemoryStore() {
  return {
    save: vi.fn(), search: vi.fn(), listByAgent: vi.fn(),
    softDeleteByAgent: vi.fn(), purgeDeleted: vi.fn(), reconcileWorkspace: vi.fn(),
    getByAgent: vi.fn(), deleteBefore: vi.fn(), softDeleteByTeam: vi.fn(),
  };
}

describe('ToolCallDispatcher', () => {
  let dispatcher: ToolCallDispatcher;
  let orgChart: ReturnType<typeof createMockOrgChart>;
  let mcpRegistry: ReturnType<typeof createMockMCPRegistry>;
  let toolCallStore: ReturnType<typeof createMockToolCallStore>;

  beforeEach(() => {
    orgChart = createMockOrgChart();
    mcpRegistry = createMockMCPRegistry();
    toolCallStore = createMockToolCallStore();

    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>>();
    handlers.set('test_tool', vi.fn().mockResolvedValue({ success: true }));

    dispatcher = new ToolCallDispatcher({
      orgChart,
      mcpRegistry,
      toolCallStore,
      logger: createMockLogger(),
      handlers,
    });
  });

  it('dedup - duplicate call_id returns cached result', async () => {
    const callId = crypto.randomUUID();
    vi.mocked(orgChart.getAgent).mockReturnValue({ role: AgentRole.Member, teamSlug: 'team-a' } as any);
    vi.mocked(mcpRegistry.isAllowed).mockReturnValue(true);

    // First call executes
    const result1 = await dispatcher.handleToolCall('aid-test', 'test_tool', { x: 1 }, callId);

    // Second call with same call_id returns cached (doesn't re-execute)
    const result2 = await dispatcher.handleToolCall('aid-test', 'test_tool', { x: 2 }, callId);

    expect(result1).toEqual(result2);
    // Tool should only be called once (cached on second)
    expect(toolCallStore.create).toHaveBeenCalledTimes(1);
  });

  it('rate limiting - exceeds limit throws RateLimitedError', async () => {
    const callId1 = crypto.randomUUID();
    const callId2 = crypto.randomUUID();
    const callId3 = crypto.randomUUID();
    const callId4 = crypto.randomUUID();
    const callId5 = crypto.randomUUID();
    const callId6 = crypto.randomUUID();

    vi.mocked(orgChart.getAgent).mockReturnValue({ role: AgentRole.Member, teamSlug: 'team-a' } as any);
    vi.mocked(mcpRegistry.isAllowed).mockReturnValue(true);

    // create_team has limit of 5/minute - call 6 times should fail on 6th
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>>();
    handlers.set('create_team', vi.fn().mockResolvedValue({ success: true }));

    const disp = new ToolCallDispatcher({
      orgChart,
      mcpRegistry,
      toolCallStore,
      logger: createMockLogger(),
      handlers,
    });

    // First 5 should succeed
    await disp.handleToolCall('aid-test', 'create_team', {}, callId1);
    await disp.handleToolCall('aid-test', 'create_team', {}, callId2);
    await disp.handleToolCall('aid-test', 'create_team', {}, callId3);
    await disp.handleToolCall('aid-test', 'create_team', {}, callId4);
    await disp.handleToolCall('aid-test', 'create_team', {}, callId5);

    // 6th should throw
    await expect(disp.handleToolCall('aid-test', 'create_team', {}, callId6))
      .rejects.toThrow(RateLimitedError);
  });

  it('authorization - denied when not allowed', async () => {
    vi.mocked(orgChart.getAgent).mockReturnValue({ role: AgentRole.Member, teamSlug: 'team-a' } as any);
    vi.mocked(mcpRegistry.isAllowed).mockReturnValue(false);

    await expect(
      dispatcher.handleToolCall('aid-test', 'test_tool', {}, crypto.randomUUID())
    ).rejects.toThrow(AccessDeniedError);
  });

  it('cleanupAgent removes rate limiter entry', () => {
    vi.mocked(orgChart.getAgent).mockReturnValue({ role: AgentRole.Member, teamSlug: 'team-a' } as any);
    vi.mocked(mcpRegistry.isAllowed).mockReturnValue(true);

    // Trigger lazy init of rate limiter
    (dispatcher as any).rateLimiters.set('aid-test', { timestamps: [] });

    dispatcher.cleanupAgent('aid-test');

    expect((dispatcher as any).rateLimiters.has('aid-test')).toBe(false);
  });
});

describe('TaskDAGManager', () => {
  let taskStore: ReturnType<typeof createMockTaskStore>;
  let orgChart: ReturnType<typeof createMockOrgChart>;
  let wsHub: ReturnType<typeof createMockWSHub>;
  let eventBus: ReturnType<typeof createMockEventBus>;
  let dagManager: TaskDAGManager;

  beforeEach(() => {
    taskStore = createMockTaskStore();
    orgChart = createMockOrgChart();
    wsHub = createMockWSHub();
    eventBus = createMockEventBus();

    dagManager = new TaskDAGManager({
      taskStore,
      orgChart,
      wsHub,
      eventBus,
      logger: createMockLogger(),
      onEscalation: vi.fn().mockResolvedValue('esc-test'),
    });
  });

  it('dispatchTask transitions pending to active', async () => {
    const task = {
      id: 'task-1',
      status: TaskStatus.Pending,
      blocked_by: [],
      agent_aid: 'aid-worker',
      prompt: 'test',
    };

    vi.mocked(taskStore.validateDependencies).mockResolvedValue(undefined as any);
    vi.mocked(taskStore.getBlockedBy).mockResolvedValue([]);
    vi.mocked(orgChart.getAgent).mockReturnValue({ teamSlug: 'team-a' } as any);
    vi.mocked(orgChart.getTeamBySlug).mockReturnValue({ tid: 'tid-a', containerId: 'container-1' } as any);
    vi.mocked(wsHub.isConnected).mockReturnValue(true);

    await dagManager.dispatchTask(task as any);

    expect(taskStore.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: TaskStatus.Active })
    );
    expect(wsHub.send).toHaveBeenCalled();
  });

  it('handleTaskResult completes task', async () => {
    const task = {
      id: 'task-1',
      status: TaskStatus.Active,
      blocked_by: [],
      agent_aid: 'aid-worker',
      prompt: 'test',
    };

    vi.mocked(taskStore.get).mockResolvedValue(task as any);
    vi.mocked(taskStore.getBlockedBy).mockResolvedValue([]);
    vi.mocked(taskStore.listBlockedBy).mockResolvedValue([]);

    await dagManager.handleTaskResult('task-1', 'aid-worker', TaskStatus.Completed, 'done');

    expect(taskStore.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: TaskStatus.Completed })
    );
  });
});

describe('EscalationRouter', () => {
  let router: EscalationRouter;
  let taskStore: ReturnType<typeof createMockTaskStore>;
  let orgChart: ReturnType<typeof createMockOrgChart>;
  let wsHub: ReturnType<typeof createMockWSHub>;

  beforeEach(() => {
    taskStore = createMockTaskStore();
    orgChart = createMockOrgChart();
    wsHub = createMockWSHub();

    router = new EscalationRouter({
      orgChart,
      wsHub,
      taskStore,
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
    });
  });

  it('handleEscalation creates record and returns correlationId', async () => {
    vi.mocked(orgChart.getAgent).mockReturnValue({ teamSlug: 'team-a' } as any);
    vi.mocked(orgChart.getTeamBySlug).mockReturnValue({ tid: 'tid-a', leaderAid: 'aid-lead' } as any);
    vi.mocked(taskStore.get).mockResolvedValue({ id: 'task-123', status: TaskStatus.Active } as any);
    vi.mocked(taskStore.update).mockResolvedValue(undefined as any);
    vi.mocked(wsHub.isConnected).mockReturnValue(true);

    const correlationId = await router.handleEscalation(
      'aid-member',
      'task-123',
      'NEEDS_HUMAN_INPUT' as any,
      { test: true },
    );

    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('handleEscalationResponse throws for unknown correlation_id', async () => {
    await expect(
      router.handleEscalationResponse('unknown-id', 'retry', {})
    ).rejects.toThrow();
  });
});

describe('ProactiveScheduler', () => {
  let scheduler: ProactiveScheduler;
  let healthMonitor: ReturnType<typeof createMockHealthMonitor>;
  let dispatchFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    healthMonitor = createMockHealthMonitor();
    dispatchFn = vi.fn().mockResolvedValue(undefined);

    scheduler = new ProactiveScheduler({
      healthMonitor,
      logger: createMockLogger(),
      dispatcher: dispatchFn,
    });
  });

  afterEach(() => {
    scheduler.stop();
  });

  it('registerAgent creates timer entry', () => {
    scheduler.registerAgent('aid-test', 5);
    expect((scheduler as any).timers.has('aid-test')).toBe(true);
  });

  it('unregisterAgent clears timer', () => {
    scheduler.registerAgent('aid-test', 5);
    scheduler.unregisterAgent('aid-test');
    expect((scheduler as any).timers.has('aid-test')).toBe(false);
  });

  it('stop() clears all timers', () => {
    scheduler.registerAgent('aid-1', 5);
    scheduler.registerAgent('aid-2', 5);
    scheduler.stop();
    expect((scheduler as any).timers.size).toBe(0);
  });

  it('fireCheck skips non-idle agent', async () => {
    vi.mocked(healthMonitor.getAgentHealth).mockResolvedValue({ status: AgentStatus.Busy } as any);
    await (scheduler as any).fireCheck('aid-busy');
    expect(dispatchFn).not.toHaveBeenCalled();
  });
});

describe('RetentionWorker', () => {
  let worker: RetentionWorker;
  let logStore: ReturnType<typeof createMockLogStore>;
  let archiveWriter: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logStore = createMockLogStore();
    archiveWriter = vi.fn().mockResolvedValue(undefined);

    worker = new RetentionWorker({
      logStore,
      memoryStore: createMockMemoryStore(),
      logger: createMockLogger(),
      archiveWriter,
    });
  });

  afterEach(() => {
    worker.stop();
  });

  it('runRetention deletes expired entries', async () => {
    vi.mocked(logStore.deleteByLevelBefore).mockResolvedValue(2);
    await (worker as any).runRetention();
    expect(logStore.deleteByLevelBefore).toHaveBeenCalled();
  });

  it('runArchive exports when count > 100K', async () => {
    vi.mocked(logStore.count).mockResolvedValue(150_000);
    vi.mocked(logStore.getOldest).mockResolvedValue([
      { id: 1, level: LogLevel.Trace, message: 'old1', created_at: Date.now() - 1000 },
    ] as any);
    vi.mocked(logStore.deleteBefore).mockResolvedValue(1);

    await (worker as any).runArchive();

    expect(logStore.getOldest).toHaveBeenCalled();
    expect(archiveWriter).toHaveBeenCalled();
  });

  it('runArchive skips when count < 100K', async () => {
    vi.mocked(logStore.count).mockResolvedValue(50_000);

    await (worker as any).runArchive();

    expect(logStore.getOldest).not.toHaveBeenCalled();
  });

  it('stop() clears both timers', () => {
    worker.start();
    worker.stop();
    expect((worker as any).retentionTimer).toBeUndefined();
    expect((worker as any).archiveTimer).toBeUndefined();
  });
});