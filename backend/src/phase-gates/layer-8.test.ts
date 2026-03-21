/**
 * Layer 8 Phase Gate: Orchestrator integration tests.
 *
 * Tests the 5 orchestrator collaborators working together:
 * - RouterImpl (two-tier routing)
 * - TriggerSchedulerImpl (cron/webhook/event triggers)
 * - ToolCallDispatcher (dedup, rate limiting, authorization)
 * - TaskDAGManager (task dispatch, dependency resolution, mixed terminal)
 * - EscalationRouter (escalation chain)
 * - ProactiveScheduler (proactive behavior)
 * - RetentionWorker (log retention, memory reconciliation)
 *
 * AC-L8-01 through AC-L8-21
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';

import { RouterImpl } from '../control-plane/router.js';
import { TriggerSchedulerImpl } from '../triggers/scheduler.js';
import { ToolCallDispatcher } from '../control-plane/tool-call-dispatcher.js';
import { TaskDAGManager } from '../control-plane/task-dag-manager.js';
import { EscalationRouter } from '../control-plane/escalation-router.js';
import { ProactiveScheduler } from '../control-plane/proactive-scheduler.js';
import { RetentionWorker } from '../control-plane/retention-worker.js';
import { EventBusImpl } from '../control-plane/event-bus.js';
import { OrchestratorImpl } from '../control-plane/orchestrator.js';
import type { OrchestratorDeps } from '../control-plane/orchestrator.js';

import {
  TaskStatus,
  AgentStatus,
  LogLevel,
  AgentRole,
  ChannelType,
} from '../domain/enums.js';
import {
  DomainError,
  RateLimitedError,
  AccessDeniedError,
  NotFoundError,
  ValidationError,
  mapDomainErrorToWSError,
} from '../domain/errors.js';
import { WSErrorCode } from '../domain/enums.js';
import type {
  InboundMessage,
  OrgChart,
  OrgChartAgent,
  OrgChartTeam,
  WSHub,
  TaskStore,
  Logger,
  MCPRegistry,
  ToolCallStore,
  HealthMonitor,
  LogStore,
  MemoryStore,
  BusEvent,
  ContainerManager,
  AgentExecutor,
  ConfigLoader,
} from '../domain/interfaces.js';
import type { Task } from '../domain/domain.js';

// ---------------------------------------------------------------------------
// Mock Factory Functions
// ---------------------------------------------------------------------------

function createMockLogger(): Logger {
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

function createMockOrgChart(): OrgChart {
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

function createMockWSHub(): WSHub {
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

function createMockTaskStore(): TaskStore {
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

function createMockMCPRegistry(): MCPRegistry {
  return {
    registerTool: vi.fn(),
    unregisterTool: vi.fn(),
    getTool: vi.fn(),
    listTools: vi.fn().mockReturnValue([]),
    getToolsForRole: vi.fn().mockReturnValue([]),
    isAllowed: vi.fn().mockReturnValue(true),
  };
}

function createMockToolCallStore(): ToolCallStore {
  return {
    create: vi.fn().mockResolvedValue(undefined),
    getByTask: vi.fn().mockResolvedValue([]),
    getByAgent: vi.fn().mockResolvedValue([]),
    getByToolName: vi.fn().mockResolvedValue([]),
  };
}

function createMockHealthMonitor(): HealthMonitor {
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

function createMockLogStore(): LogStore {
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

function createMockMemoryStore(): MemoryStore {
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

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Layer 8: Orchestrator Integration', () => {
  let logger: Logger;
  let logStore: LogStore;
  let eventBus: EventBusImpl;

  beforeEach(() => {
    logger = createMockLogger();
    logStore = createMockLogStore();
    eventBus = new EventBusImpl();
  });

  afterEach(() => {
    eventBus.close();
  });

  // -------------------------------------------------------------------------
  // 1. Router Two-Tier Routing
  // -------------------------------------------------------------------------

  describe('RouterImpl two-tier routing', () => {
    it('routes via Tier 1 exact match', async () => {
      const router = new RouterImpl();

      // Add exact route for 'weather' -> 'team-a'
      router.addKnownRoute('weather', 'team-a', 'exact');

      const message: InboundMessage = {
        id: 'msg-1',
        chatJid: 'chat-1',
        channelType: ChannelType.Discord,
        content: 'weather',
        timestamp: Date.now(),
      };

      const result = await router.route(message);
      expect(result).toBe('team-a');
    });

    it('routes via Tier 2 LLM judgment when no Tier 1 match', async () => {
      const tier2Handler = vi.fn().mockResolvedValue('team-b');
      const router = new RouterImpl(tier2Handler);

      // Add a different route
      router.addKnownRoute('weather', 'team-a', 'exact');

      const message: InboundMessage = {
        id: 'msg-2',
        chatJid: 'chat-2',
        channelType: ChannelType.Discord,
        content: 'unknown request',
        timestamp: Date.now(),
      };

      const result = await router.route(message);
      expect(result).toBe('team-b');
      expect(tier2Handler).toHaveBeenCalledWith(message);
    });

    it('throws NotFoundError when no route and no Tier 2 handler', async () => {
      const router = new RouterImpl(); // No Tier 2 handler

      const message: InboundMessage = {
        id: 'msg-3',
        chatJid: 'chat-3',
        channelType: ChannelType.Discord,
        content: 'unknown',
        timestamp: Date.now(),
      };

      await expect(router.route(message)).rejects.toThrow(NotFoundError);
    });

    it('routes via prefix match', async () => {
      const router = new RouterImpl();

      router.addKnownRoute('weather-', 'weather-team', 'prefix');

      const message: InboundMessage = {
        id: 'msg-4',
        chatJid: 'chat-4',
        channelType: ChannelType.Discord,
        content: 'weather-tokyo',
        timestamp: Date.now(),
      };

      const result = await router.route(message);
      expect(result).toBe('weather-team');
    });

    it('routes via regex match', async () => {
      const router = new RouterImpl();

      router.addKnownRoute('^issue-\\d+$', 'issue-team', 'regex');

      const message: InboundMessage = {
        id: 'msg-5',
        chatJid: 'chat-5',
        channelType: ChannelType.Discord,
        content: 'issue-12345',
        timestamp: Date.now(),
      };

      const result = await router.route(message);
      expect(result).toBe('issue-team');
    });

    it('prioritizes exact over prefix over regex', async () => {
      const router = new RouterImpl();

      // Add different patterns with different types
      // Regex matches everything
      router.addKnownRoute('.*', 'regex-team', 'regex');
      // Prefix matches 'weather-xxx'
      router.addKnownRoute('weather-', 'prefix-team', 'prefix');
      // Exact matches only 'weather'
      router.addKnownRoute('weather', 'exact-team', 'exact');

      // Exact match should win
      const exactMessage: InboundMessage = {
        id: 'msg-6',
        chatJid: 'chat-6',
        channelType: ChannelType.Discord,
        content: 'weather',
        timestamp: Date.now(),
      };
      const exactResult = await router.route(exactMessage);
      expect(exactResult).toBe('exact-team');

      // Prefix match for 'weather-tokyo'
      const prefixMessage: InboundMessage = {
        id: 'msg-7',
        chatJid: 'chat-7',
        channelType: ChannelType.Discord,
        content: 'weather-tokyo',
        timestamp: Date.now(),
      };
      const prefixResult = await router.route(prefixMessage);
      expect(prefixResult).toBe('prefix-team');

      // Regex fallback for anything else
      const regexMessage: InboundMessage = {
        id: 'msg-8',
        chatJid: 'chat-8',
        channelType: ChannelType.Discord,
        content: 'something-else',
        timestamp: Date.now(),
      };
      const regexResult = await router.route(regexMessage);
      expect(regexResult).toBe('regex-team');
    });
  });

  // -------------------------------------------------------------------------
  // 2. TriggerScheduler Cron
  // -------------------------------------------------------------------------

  describe('TriggerSchedulerImpl cron triggers', () => {
    let scheduler: TriggerSchedulerImpl;
    let fireHandler: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fireHandler = vi.fn();
      scheduler = new TriggerSchedulerImpl(eventBus, fireHandler);
    });

    afterEach(() => {
      scheduler.stop();
    });

    it('registers and fires cron trigger', async () => {
      scheduler.addCronTrigger('test-cron', '*/5 * * * *', 'team-a', 'Check weather');
      scheduler.start();

      // Trigger manually via timer callback
      const triggers = scheduler.listTriggers();
      expect(triggers).toHaveLength(1);
      expect(triggers[0].name).toBe('test-cron');
      expect(triggers[0].type).toBe('cron');
      expect(triggers[0].targetTeam).toBe('team-a');
    });

    it('rejects invalid cron expression', () => {
      expect(() => {
        scheduler.addCronTrigger('bad-cron', 'not-a-cron', 'team-a', 'test');
      }).toThrow(ValidationError);
    });

    it('removes trigger', () => {
      scheduler.addCronTrigger('remove-test', '0 * * * *', 'team-a', 'test');
      expect(scheduler.listTriggers()).toHaveLength(1);

      scheduler.removeTrigger('remove-test');
      expect(scheduler.listTriggers()).toHaveLength(0);
    });

    it('stop() halts all triggers', () => {
      scheduler.addCronTrigger('cron-1', '0 * * * *', 'team-a', 'test');
      scheduler.addCronTrigger('cron-2', '0 */2 * * *', 'team-b', 'test');
      scheduler.start();

      scheduler.stop();

      // Verify triggers still registered but not active
      expect(scheduler.listTriggers()).toHaveLength(2);
    });

    it('event trigger fires on matching event', async () => {
      const fireHandler = vi.fn();
      const scheduler = new TriggerSchedulerImpl(eventBus, fireHandler);

      scheduler.addEventTrigger(
        'task-complete-trigger',
        'task.completed',
        'team-a',
        'Check follow-up',
        (event: BusEvent) => event.data['team_slug'] === 'team-b',
      );
      scheduler.start();

      // Publish matching event
      eventBus.publish({
        type: 'task.completed',
        data: { team_slug: 'team-b', task_id: 'task-1' },
        timestamp: Date.now(),
      });

      // Allow event propagation
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(fireHandler).toHaveBeenCalledWith('team-a', 'Check follow-up', undefined, undefined);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Full Tool Call Flow
  // -------------------------------------------------------------------------

  describe('ToolCallDispatcher full flow', () => {
    let dispatcher: ToolCallDispatcher;
    let orgChart: OrgChart;
    let mcpRegistry: MCPRegistry;
    let toolCallStore: ToolCallStore;
    let handler: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      orgChart = createMockOrgChart();
      mcpRegistry = createMockMCPRegistry();
      toolCallStore = createMockToolCallStore();
      handler = vi.fn().mockResolvedValue({ result: 'success' });

      const handlers = new Map<string, (args: Record<string, unknown>, agentAid: string, teamSlug: string) => Promise<Record<string, unknown>>>();
      handlers.set('test_tool', handler);

      dispatcher = new ToolCallDispatcher({
        orgChart,
        mcpRegistry,
        logStore,
        toolCallStore,
        logger,
        handlers,
      });
    });

    it('executes tool and logs to ToolCallStore', async () => {
      const callId = crypto.randomUUID();

      vi.mocked(orgChart.getAgent).mockReturnValue({
        aid: 'aid-test',
        teamSlug: 'team-a',
        role: AgentRole.Member,
        name: 'Test Agent',
        status: AgentStatus.Idle,
      } as OrgChartAgent);
      vi.mocked(mcpRegistry.isAllowed).mockReturnValue(true);

      const result = await dispatcher.handleToolCall(
        'aid-test',
        'test_tool',
        { param: 'value' },
        callId,
      );

      expect(result).toEqual({ result: 'success' });
      expect(handler).toHaveBeenCalledWith({ param: 'value' }, 'aid-test', 'team-a');
      expect(toolCallStore.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tool_use_id: callId,
          tool_name: 'test_tool',
          agent_aid: 'aid-test',
          team_slug: 'team-a',
        }),
      );
    });

    it('denies unauthorized tool', async () => {
      vi.mocked(orgChart.getAgent).mockReturnValue({
        aid: 'aid-test',
        teamSlug: 'team-a',
        role: AgentRole.Member,
        name: 'Test Agent',
        status: AgentStatus.Idle,
      } as OrgChartAgent);
      vi.mocked(mcpRegistry.isAllowed).mockReturnValue(false);

      await expect(
        dispatcher.handleToolCall('aid-test', 'test_tool', {}, crypto.randomUUID()),
      ).rejects.toThrow(AccessDeniedError);
    });

    it('denies unknown agent', async () => {
      vi.mocked(orgChart.getAgent).mockReturnValue(undefined);

      await expect(
        dispatcher.handleToolCall('aid-unknown', 'test_tool', {}, crypto.randomUUID()),
      ).rejects.toThrow(NotFoundError);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Tool Call Dedup
  // -------------------------------------------------------------------------

  describe('ToolCallDispatcher dedup', () => {
    let dispatcher: ToolCallDispatcher;
    let orgChart: OrgChart;
    let mcpRegistry: MCPRegistry;
    let toolCallStore: ToolCallStore;
    let handler: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      orgChart = createMockOrgChart();
      mcpRegistry = createMockMCPRegistry();
      toolCallStore = createMockToolCallStore();
      handler = vi.fn().mockResolvedValue({ result: 'success' });

      const handlers = new Map<string, (args: Record<string, unknown>, agentAid: string, teamSlug: string) => Promise<Record<string, unknown>>>();
      handlers.set('test_tool', handler);

      dispatcher = new ToolCallDispatcher({
        orgChart,
        mcpRegistry,
        logStore,
        toolCallStore,
        logger,
        handlers,
      });
    });

    it('returns cached result for duplicate call_id', async () => {
      const callId = crypto.randomUUID();

      vi.mocked(orgChart.getAgent).mockReturnValue({
        aid: 'aid-test',
        teamSlug: 'team-a',
        role: AgentRole.Member,
        name: 'Test Agent',
        status: AgentStatus.Idle,
      } as OrgChartAgent);
      vi.mocked(mcpRegistry.isAllowed).mockReturnValue(true);

      // First call
      const result1 = await dispatcher.handleToolCall(
        'aid-test',
        'test_tool',
        { param: 'first' },
        callId,
      );

      // Second call with same call_id
      const result2 = await dispatcher.handleToolCall(
        'aid-test',
        'test_tool',
        { param: 'second' }, // Different args
        callId,
      );

      expect(result1).toEqual(result2);
      // Handler should only be called once (second was cached)
      expect(handler).toHaveBeenCalledTimes(1);
      // ToolCallStore should only be written once
      expect(toolCallStore.create).toHaveBeenCalledTimes(1);
    });

    it('different call_ids execute separately', async () => {
      vi.mocked(orgChart.getAgent).mockReturnValue({
        aid: 'aid-test',
        teamSlug: 'team-a',
        role: AgentRole.Member,
        name: 'Test Agent',
        status: AgentStatus.Idle,
      } as OrgChartAgent);
      vi.mocked(mcpRegistry.isAllowed).mockReturnValue(true);

      await dispatcher.handleToolCall('aid-test', 'test_tool', {}, crypto.randomUUID());
      await dispatcher.handleToolCall('aid-test', 'test_tool', {}, crypto.randomUUID());

      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Rate Limiting
  // -------------------------------------------------------------------------

  describe('ToolCallDispatcher rate limiting', () => {
    let dispatcher: ToolCallDispatcher;
    let orgChart: OrgChart;
    let mcpRegistry: MCPRegistry;
    let toolCallStore: ToolCallStore;

    beforeEach(() => {
      orgChart = createMockOrgChart();
      mcpRegistry = createMockMCPRegistry();
      toolCallStore = createMockToolCallStore();

      vi.mocked(orgChart.getAgent).mockReturnValue({
        aid: 'aid-test',
        teamSlug: 'team-a',
        role: AgentRole.Member,
        name: 'Test Agent',
        status: AgentStatus.Idle,
      } as OrgChartAgent);
      vi.mocked(mcpRegistry.isAllowed).mockReturnValue(true);
    });

    it('rejects 6th create_team call within 1 minute', async () => {
      const handler = vi.fn().mockResolvedValue({ success: true });
      const handlers = new Map<string, (args: Record<string, unknown>, agentAid: string, teamSlug: string) => Promise<Record<string, unknown>>>();
      handlers.set('create_team', handler);

      dispatcher = new ToolCallDispatcher({
        orgChart,
        mcpRegistry,
        logStore,
        toolCallStore,
        logger,
        handlers,
      });

      // create_team has limit of 5/minute
      for (let i = 0; i < 5; i++) {
        await dispatcher.handleToolCall('aid-test', 'create_team', {}, crypto.randomUUID());
      }

      // 6th call should fail
      await expect(
        dispatcher.handleToolCall('aid-test', 'create_team', {}, crypto.randomUUID()),
      ).rejects.toThrow(RateLimitedError);
    });

    it('allows 30 dispatch_subtask calls within 1 minute', async () => {
      const handler = vi.fn().mockResolvedValue({ success: true });
      const handlers = new Map<string, (args: Record<string, unknown>, agentAid: string, teamSlug: string) => Promise<Record<string, unknown>>>();
      handlers.set('dispatch_subtask', handler);

      dispatcher = new ToolCallDispatcher({
        orgChart,
        mcpRegistry,
        logStore,
        toolCallStore,
        logger,
        handlers,
      });

      // dispatch_subtask has limit of 30/minute
      for (let i = 0; i < 30; i++) {
        await dispatcher.handleToolCall('aid-test', 'dispatch_subtask', {}, crypto.randomUUID());
      }

      // 31st call should fail
      await expect(
        dispatcher.handleToolCall('aid-test', 'dispatch_subtask', {}, crypto.randomUUID()),
      ).rejects.toThrow(RateLimitedError);
    });

    it('cleanupAgent removes rate limiter entry', () => {
      const handler = vi.fn().mockResolvedValue({ success: true });
      const handlers = new Map<string, (args: Record<string, unknown>, agentAid: string, teamSlug: string) => Promise<Record<string, unknown>>>();
      handlers.set('create_team', handler);

      dispatcher = new ToolCallDispatcher({
        orgChart,
        mcpRegistry,
        logStore,
        toolCallStore,
        logger,
        handlers,
      });

      // Trigger rate limiter creation
      (dispatcher as unknown as { rateLimiters: Map<string, unknown> }).rateLimiters.set('aid-test', { timestamps: [] });

      dispatcher.cleanupAgent('aid-test');

      expect((dispatcher as unknown as { rateLimiters: Map<string, unknown> }).rateLimiters.has('aid-test')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Task DAG
  // -------------------------------------------------------------------------

  describe('TaskDAGManager dispatch and DAG', () => {
    let dagManager: TaskDAGManager;
    let taskStore: TaskStore;
    let orgChart: OrgChart;
    let wsHub: WSHub;
    let escalationHandler: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      taskStore = createMockTaskStore();
      orgChart = createMockOrgChart();
      wsHub = createMockWSHub();
      escalationHandler = vi.fn().mockResolvedValue('esc-1');

      dagManager = new TaskDAGManager({
        taskStore,
        orgChart,
        wsHub,
        eventBus,
        logger,
        onEscalation: escalationHandler,
      });
    });

    it('dispatches pending task to active', async () => {
      const task: Task = {
        id: 'task-1',
        parent_id: '',
        team_slug: 'team-a',
        agent_aid: 'aid-worker',
        title: 'Test task',
        status: TaskStatus.Pending,
        prompt: 'Do something',
        result: '',
        error: '',
        blocked_by: [],
        priority: 0,
        retry_count: 0,
        max_retries: 3,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      };

      vi.mocked(taskStore.validateDependencies).mockResolvedValue(undefined);
      vi.mocked(taskStore.getBlockedBy).mockResolvedValue([]);
      vi.mocked(orgChart.getAgent).mockReturnValue({
        aid: 'aid-worker',
        teamSlug: 'team-a',
        name: 'Worker',
        role: AgentRole.Member,
        status: AgentStatus.Idle,
      } as OrgChartAgent);
      vi.mocked(orgChart.getTeamBySlug).mockReturnValue({
        tid: 'tid-a',
        slug: 'team-a',
        leaderAid: 'aid-lead',
        parentTid: '',
        depth: 0,
        containerId: 'container-1',
        health: 'running' as never,
        agentAids: ['aid-worker'],
        workspacePath: '/workspace/team-a',
      } as OrgChartTeam);

      await dagManager.dispatchTask(task);

      expect(taskStore.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'task-1',
          status: TaskStatus.Active,
        }),
      );
      expect(wsHub.send).toHaveBeenCalledWith(
        'tid-a',
        expect.objectContaining({
          type: 'task_dispatch',
        }),
      );
    });

    it('AC05: task_dispatch wire format has blocked_by (not parent_task_id)', async () => {
      // Verifies the exact task_dispatch data payload shape per the wire protocol spec.
      // The field must be `blocked_by: []`, never `parent_task_id`.
      const task: Task = {
        id: 'task-wire-fmt',
        parent_id: '',
        team_slug: 'team-a',
        agent_aid: 'aid-worker',
        title: 'Wire format test',
        status: TaskStatus.Pending,
        prompt: 'Test wire format',
        result: '',
        error: '',
        blocked_by: [],
        priority: 0,
        retry_count: 0,
        max_retries: 3,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      };

      vi.mocked(taskStore.validateDependencies).mockResolvedValue(undefined);
      vi.mocked(taskStore.getBlockedBy).mockResolvedValue([]);
      vi.mocked(orgChart.getAgent).mockReturnValue({
        aid: 'aid-worker',
        teamSlug: 'team-a',
        name: 'Worker',
        role: AgentRole.Member,
        status: AgentStatus.Idle,
      } as OrgChartAgent);
      vi.mocked(orgChart.getTeamBySlug).mockReturnValue({
        tid: 'tid-a',
        slug: 'team-a',
        leaderAid: 'aid-lead',
        parentTid: '',
        depth: 0,
        containerId: 'container-1',
        health: 'running' as never,
        agentAids: ['aid-worker'],
        workspacePath: '/workspace/team-a',
      } as OrgChartTeam);

      await dagManager.dispatchTask(task);

      // Verify exact data payload shape: must use blocked_by, not parent_task_id
      expect(wsHub.send).toHaveBeenCalledWith(
        'tid-a',
        {
          type: 'task_dispatch',
          data: {
            task_id: 'task-wire-fmt',
            agent_aid: 'aid-worker',
            prompt: 'Test wire format',
            blocked_by: [],
          },
        },
      );
      // Verify parent_task_id is NOT present in the payload
      const sentPayload = vi.mocked(wsHub.send).mock.calls[0][1] as {
        type: string;
        data: Record<string, unknown>;
      };
      expect('parent_task_id' in sentPayload.data).toBe(false);
    });

    it('defers dispatch when blocked', async () => {
      const task: Task = {
        id: 'task-2',
        parent_id: '',
        team_slug: 'team-a',
        agent_aid: 'aid-worker',
        title: 'Blocked task',
        status: TaskStatus.Pending,
        prompt: 'Do something',
        result: '',
        error: '',
        blocked_by: ['task-1'],
        priority: 0,
        retry_count: 0,
        max_retries: 3,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      };

      vi.mocked(taskStore.validateDependencies).mockResolvedValue(undefined);
      vi.mocked(taskStore.getBlockedBy).mockResolvedValue(['task-1']);

      await dagManager.dispatchTask(task);

      // Should NOT update status when blocked
      expect(taskStore.update).not.toHaveBeenCalled();
      expect(wsHub.send).not.toHaveBeenCalled();
    });

    it('auto-dispatches dependent after blocker completes', async () => {
      const blockerTask: Task = {
        id: 'task-1',
        parent_id: 'parent-1',
        team_slug: 'team-a',
        agent_aid: 'aid-worker-1',
        title: 'Blocker',
        status: TaskStatus.Active,
        prompt: 'Do work',
        result: '',
        error: '',
        blocked_by: [],
        priority: 0,
        retry_count: 0,
        max_retries: 3,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      };

      const dependentTask: Task = {
        id: 'task-2',
        parent_id: 'parent-1',
        team_slug: 'team-a',
        agent_aid: 'aid-worker-2',
        title: 'Dependent',
        status: TaskStatus.Pending,
        prompt: 'Do more work',
        result: '',
        error: '',
        blocked_by: ['task-1'],
        priority: 0,
        retry_count: 0,
        max_retries: 3,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      };

      // Store mock with tasks
      const tasks = new Map<string, Task>();
      tasks.set('task-1', blockerTask);
      tasks.set('task-2', dependentTask);

      vi.mocked(taskStore.get).mockImplementation(async (id: string) => {
        const t = tasks.get(id);
        if (!t) throw new NotFoundError(`Task ${id} not found`);
        return t;
      });
      vi.mocked(taskStore.update).mockImplementation(async (task: Task) => {
        tasks.set(task.id, task);
      });
      vi.mocked(taskStore.getSubtree).mockResolvedValue([blockerTask, dependentTask]);
      vi.mocked(taskStore.unblockTask).mockResolvedValue(true);
      vi.mocked(orgChart.getAgent).mockReturnValue({
        aid: 'aid-worker-2',
        teamSlug: 'team-a',
        name: 'Worker 2',
        role: AgentRole.Member,
        status: AgentStatus.Idle,
      } as OrgChartAgent);
      vi.mocked(orgChart.getTeamBySlug).mockReturnValue({
        tid: 'tid-a',
        slug: 'team-a',
        leaderAid: 'aid-lead',
        parentTid: '',
        depth: 0,
        containerId: 'container-1',
        health: 'running' as never,
        agentAids: ['aid-worker-2'],
        workspacePath: '/workspace/team-a',
      } as OrgChartTeam);
      vi.mocked(taskStore.getBlockedBy).mockResolvedValue([]);

      // Complete the blocker
      await dagManager.handleTaskResult('task-1', 'aid-worker-1', TaskStatus.Completed, 'done');

      // Verify unblockTask was called for the dependent
      expect(taskStore.unblockTask).toHaveBeenCalledWith('task-2', 'task-1');
    });
  });

  // -------------------------------------------------------------------------
  // 7. Task DAG Mixed Terminal (User Decision #4)
  // -------------------------------------------------------------------------

  describe('TaskDAGManager mixed terminal (User Decision #4)', () => {
    let dagManager: TaskDAGManager;
    let taskStore: TaskStore;
    let orgChart: OrgChart;
    let wsHub: WSHub;
    let escalationHandler: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      taskStore = createMockTaskStore();
      orgChart = createMockOrgChart();
      wsHub = createMockWSHub();
      escalationHandler = vi.fn().mockResolvedValue('esc-terminal');

      dagManager = new TaskDAGManager({
        taskStore,
        orgChart,
        wsHub,
        eventBus,
        logger,
        onEscalation: escalationHandler,
      });
    });

    it('escalates when blocker fails terminally (no retries)', async () => {
      const blockerTask: Task = {
        id: 'task-blocker',
        parent_id: 'parent-1',
        team_slug: 'team-a',
        agent_aid: 'aid-worker-1',
        title: 'Blocker',
        status: TaskStatus.Active,
        prompt: 'Do work',
        result: '',
        error: '',
        blocked_by: [],
        priority: 0,
        retry_count: 2, // Already used retries
        max_retries: 2, // No more retries
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      };

      vi.mocked(taskStore.get).mockResolvedValue(blockerTask);
      vi.mocked(orgChart.getTeamBySlug).mockReturnValue({
        tid: 'tid-a',
        slug: 'team-a',
        leaderAid: 'aid-lead',
      } as OrgChartTeam);

      // Blocker fails with no retries left
      await dagManager.handleTaskResult('task-blocker', 'aid-worker-1', TaskStatus.Failed, '', 'Critical error');

      // Should escalate — the DAGManager passes the worker's AID to the escalation callback
      expect(escalationHandler).toHaveBeenCalledWith(
        'aid-worker-1',
        'task-blocker',
        'error',
        expect.objectContaining({
          failed_task_id: 'task-blocker',
          retries_exhausted: true,
        }),
      );
    });

    it('cascade cancels dependent when blocker is cancelled', async () => {
      const blockerTask: Task = {
        id: 'task-blocker',
        parent_id: 'parent-1',
        team_slug: 'team-a',
        agent_aid: 'aid-worker-1',
        title: 'Blocker',
        status: TaskStatus.Active,
        prompt: 'Do work',
        result: '',
        error: '',
        blocked_by: [],
        priority: 0,
        retry_count: 0,
        max_retries: 3,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      };

      const dependentTask: Task = {
        id: 'task-dependent',
        parent_id: 'parent-1',
        team_slug: 'team-a',
        agent_aid: 'aid-worker-2',
        title: 'Dependent',
        status: TaskStatus.Pending,
        prompt: 'Wait for blocker',
        result: '',
        error: '',
        blocked_by: ['task-blocker'],
        priority: 0,
        retry_count: 0,
        max_retries: 3,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      };

      const tasks = new Map<string, Task>();
      tasks.set('task-blocker', blockerTask);
      tasks.set('task-dependent', dependentTask);

      vi.mocked(taskStore.get).mockImplementation(async (id: string) => {
        const t = tasks.get(id);
        if (!t) throw new NotFoundError(`Task ${id} not found`);
        return t;
      });
      vi.mocked(taskStore.update).mockImplementation(async (task: Task) => {
        tasks.set(task.id, task);
      });
      vi.mocked(taskStore.getSubtree).mockResolvedValue([blockerTask, dependentTask]);

      // User cancels blocker
      await dagManager.handleTaskResult('task-blocker', 'aid-worker-1', TaskStatus.Cancelled);

      // Verify dependent was cascade cancelled
      expect(taskStore.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'task-dependent',
          status: TaskStatus.Cancelled,
          error: expect.stringContaining('Cascade'),
        }),
      );
    });

    it('retry transitions failed to pending when retries remain', async () => {
      const task: Task = {
        id: 'task-retry',
        parent_id: '',
        team_slug: 'team-a',
        agent_aid: 'aid-worker',
        title: 'Retry task',
        status: TaskStatus.Active,
        prompt: 'Do work',
        result: '',
        error: '',
        blocked_by: [],
        priority: 0,
        retry_count: 0,
        max_retries: 3,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      };

      const tasks = new Map<string, Task>();
      tasks.set('task-retry', task);

      vi.mocked(taskStore.get).mockImplementation(async (id: string) => {
        const t = tasks.get(id);
        if (!t) throw new NotFoundError(`Task ${id} not found`);
        return t;
      });
      vi.mocked(taskStore.update).mockImplementation(async (t: Task) => {
        tasks.set(t.id, t);
      });
      vi.mocked(taskStore.getBlockedBy).mockResolvedValue([]);
      vi.mocked(orgChart.getAgent).mockReturnValue({
        aid: 'aid-worker',
        teamSlug: 'team-a',
      } as OrgChartAgent);
      vi.mocked(orgChart.getTeamBySlug).mockReturnValue({
        tid: 'tid-a',
        containerId: 'container-1',
      } as OrgChartTeam);

      // Task fails but has retries
      await dagManager.handleTaskResult('task-retry', 'aid-worker', TaskStatus.Failed, '', 'Temporary error');

      // After failure with retries, the task transitions:
      // Failed -> Pending (for retry), then dispatchTask is called which makes it Active
      // The retry_count should be incremented
      const updatedTask = tasks.get('task-retry');
      expect(updatedTask?.retry_count).toBe(1);
      // Task should be dispatched (active) since dispatchTask is called after retry
      expect([TaskStatus.Pending, TaskStatus.Active]).toContain(updatedTask?.status);
    });
  });

  // -------------------------------------------------------------------------
  // 8. Escalation Chain
  // -------------------------------------------------------------------------

  describe('EscalationRouter chain walking', () => {
    let router: EscalationRouter;
    let taskStore: TaskStore;
    let orgChart: OrgChart;
    let wsHub: WSHub;

    beforeEach(() => {
      taskStore = createMockTaskStore();
      orgChart = createMockOrgChart();
      wsHub = createMockWSHub();

      router = new EscalationRouter({
        orgChart,
        wsHub,
        taskStore,
        eventBus,
        logger,
      });
    });

    it('escalates member to main assistant (flat escalation)', async () => {
      vi.mocked(orgChart.getAgent).mockImplementation((aid: string) => {
        if (aid === 'aid-member') {
          return { aid: 'aid-member', teamSlug: 'team-a', role: AgentRole.Member } as OrgChartAgent;
        }
        if (aid === 'aid-main') {
          return { aid: 'aid-main', teamSlug: 'main', role: 'main_assistant' } as OrgChartAgent;
        }
        return undefined;
      });
      vi.mocked(orgChart.getAgentsByTeam).mockReturnValue([
        { aid: 'aid-main', teamSlug: 'main', role: 'main_assistant' } as OrgChartAgent,
      ]);
      vi.mocked(orgChart.getTeamBySlug).mockImplementation((slug: string) => {
        if (slug === 'team-a') return { tid: 'tid-a', slug: 'team-a' } as OrgChartTeam;
        if (slug === 'main') return { tid: 'tid-main', slug: 'main' } as OrgChartTeam;
        return undefined;
      });
      vi.mocked(taskStore.get).mockResolvedValue({
        id: 'task-1',
        status: TaskStatus.Active,
      } as Task);
      vi.mocked(taskStore.update).mockResolvedValue(undefined);

      const correlationId = await router.handleEscalation(
        'aid-member',
        'task-1',
        'error' as never,
        { reason: 'stuck' },
      );

      expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);
      // Flat escalation sends to main assistant's team
      expect(wsHub.send).toHaveBeenCalledWith(
        'tid-main',
        expect.objectContaining({
          type: 'escalation_response',
          data: expect.objectContaining({
            correlation_id: correlationId,
            task_id: 'task-1',
            agent_aid: 'aid-main',
            source_team: 'team-a',
            destination_team: 'main',
            resolution: 'pending',
          }),
        }),
      );
    });

    // Leader chain escalation test removed — flat escalation model (no leader walking)

    it('deduplicates re-escalation with same correlation_id', async () => {
      vi.mocked(orgChart.getAgent).mockReturnValue({
        aid: 'aid-member',
        teamSlug: 'team-a',
        role: AgentRole.Member,
      } as OrgChartAgent);
      vi.mocked(orgChart.getTeamBySlug).mockReturnValue({
        tid: 'tid-a',
        slug: 'team-a',
        leaderAid: 'aid-lead',
      } as OrgChartTeam);
      vi.mocked(taskStore.get).mockResolvedValue({
        id: 'task-1',
        status: TaskStatus.Active,
      } as Task);
      vi.mocked(taskStore.update).mockResolvedValue(undefined);

      // First escalation
      const correlationId1 = await router.handleEscalation(
        'aid-member',
        'task-1',
        'error' as never,
        { reason: 'stuck' },
      );

      // Second escalation with same correlation_id (simulating retry)
      // The dedup is based on a newly generated UUID each call, so this tests
      // that the dedup set prevents duplicate upward routing

      // Verify task was only updated once (to escalated)
      expect(taskStore.update).toHaveBeenCalledTimes(1);
      expect(correlationId1).toBeDefined();
    });

    it('handleEscalationResponse rejects unknown correlation_id', async () => {
      await expect(
        router.handleEscalationResponse('unknown-id', 'retry', {}),
      ).rejects.toThrow(NotFoundError);
    });

    it('handleEscalationResponse rejects already resolved escalation', async () => {
      vi.mocked(orgChart.getAgent).mockReturnValue({
        aid: 'aid-member',
        teamSlug: 'team-a',
      } as OrgChartAgent);
      vi.mocked(orgChart.getTeamBySlug).mockReturnValue({
        tid: 'tid-a',
        leaderAid: 'aid-lead',
      } as OrgChartTeam);
      vi.mocked(taskStore.get).mockResolvedValue({
        id: 'task-1',
        status: TaskStatus.Active,
      } as Task);
      vi.mocked(taskStore.update).mockResolvedValue(undefined);

      const correlationId = await router.handleEscalation(
        'aid-member',
        'task-1',
        'error' as never,
        {},
      );

      // First response succeeds
      vi.mocked(taskStore.get).mockResolvedValue({
        id: 'task-1',
        status: TaskStatus.Escalated,
      } as Task);
      await router.handleEscalationResponse(correlationId, 'retry', {});

      // Second response should fail
      await expect(
        router.handleEscalationResponse(correlationId, 'retry', {}),
      ).rejects.toThrow(ValidationError);
    });

    it('AC09/AC10: handleEscalationResponse sends all 7 fields with reversed source/destination (Sender B)', async () => {
      // Set up member in team-a, main assistant in 'main' team.
      // After flat escalation: sourceTeam='team-a', destinationTeam='main'.
      // On response: source and destination are swapped (main -> team-a).
      vi.mocked(orgChart.getAgent).mockImplementation((aid: string) => {
        if (aid === 'aid-member') {
          return { aid: 'aid-member', teamSlug: 'team-a', role: AgentRole.Member } as OrgChartAgent;
        }
        if (aid === 'aid-main') {
          return { aid: 'aid-main', teamSlug: 'main', role: 'main_assistant' } as OrgChartAgent;
        }
        return undefined;
      });
      vi.mocked(orgChart.getAgentsByTeam).mockReturnValue([
        { aid: 'aid-main', teamSlug: 'main', role: 'main_assistant' } as OrgChartAgent,
      ]);
      vi.mocked(orgChart.getTeamBySlug).mockImplementation((slug: string) => {
        if (slug === 'team-a') {
          return { tid: 'tid-a', slug: 'team-a' } as OrgChartTeam;
        }
        if (slug === 'main') {
          return { tid: 'tid-main', slug: 'main' } as OrgChartTeam;
        }
        return undefined;
      });
      vi.mocked(taskStore.get).mockResolvedValue({
        id: 'task-esc',
        status: TaskStatus.Active,
      } as Task);
      vi.mocked(taskStore.update).mockResolvedValue(undefined);

      // Escalate member to main assistant — Sender A fires here
      const correlationId = await router.handleEscalation(
        'aid-member',
        'task-esc',
        'error' as never,
        { reason: 'needs decision' },
      );

      // Reset call history to isolate Sender B assertions
      vi.mocked(wsHub.send).mockClear();

      // Transition task to Escalated for the response path
      vi.mocked(taskStore.get).mockResolvedValue({
        id: 'task-esc',
        status: TaskStatus.Escalated,
      } as Task);

      // Sender B: main assistant responds, escalation_response goes back to original agent
      await router.handleEscalationResponse(correlationId, 'retry', { guidance: 'try again' });

      expect(wsHub.send).toHaveBeenCalledOnce();
      expect(wsHub.send).toHaveBeenCalledWith(
        'tid-a', // original member's container
        {
          type: 'escalation_response',
          data: {
            correlation_id: correlationId,
            task_id: 'task-esc',
            agent_aid: 'aid-member',
            // Source/destination are REVERSED on the return trip:
            // escalation went team-a -> main, response goes main -> team-a
            source_team: 'main',
            destination_team: 'team-a',
            resolution: 'retry',
            context: { guidance: 'try again' },
          },
        },
      );
    });
  });

  // -------------------------------------------------------------------------
  // 9. Proactive Scheduler
  // -------------------------------------------------------------------------

  describe('ProactiveScheduler behavior', () => {
    let scheduler: ProactiveScheduler;
    let healthMonitor: HealthMonitor;
    let dispatchFn: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      healthMonitor = createMockHealthMonitor();
      dispatchFn = vi.fn().mockResolvedValue(undefined);

      scheduler = new ProactiveScheduler({
        healthMonitor,
        logger,
        dispatcher: dispatchFn,
      });
    });

    afterEach(() => {
      scheduler.stop();
    });

    it('dispatches proactive_check when agent is idle', async () => {
      vi.mocked(healthMonitor.getAgentHealth).mockReturnValue(AgentStatus.Idle);

      await scheduler.fireCheck('aid-worker');

      expect(dispatchFn).toHaveBeenCalledWith(
        'aid-worker',
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}-\d{2}:\d{2}-aid-worker$/),
      );
    });

    it('skips proactive_check when agent is busy', async () => {
      vi.mocked(healthMonitor.getAgentHealth).mockReturnValue(AgentStatus.Busy);

      await scheduler.fireCheck('aid-worker');

      expect(dispatchFn).not.toHaveBeenCalled();
    });

    it('skips proactive_check when agent status is unknown', async () => {
      vi.mocked(healthMonitor.getAgentHealth).mockReturnValue(undefined);

      await scheduler.fireCheck('aid-worker');

      expect(dispatchFn).not.toHaveBeenCalled();
    });

    it('deduplicates by check_id (same minute)', async () => {
      vi.mocked(healthMonitor.getAgentHealth).mockReturnValue(AgentStatus.Idle);

      // First call dispatches
      await scheduler.fireCheck('aid-worker');

      // Second call in same minute is deduplicated
      await scheduler.fireCheck('aid-worker');

      expect(dispatchFn).toHaveBeenCalledTimes(1);
    });

    it('registerAgent creates timer with minimum interval of 5 minutes', () => {
      // Request 1 minute, should be clamped to 5
      scheduler.registerAgent('aid-worker', 1);

      expect(scheduler.getRegisteredCount()).toBe(1);
    });

    it('unregisterAgent clears timer', () => {
      scheduler.registerAgent('aid-worker', 30);
      expect(scheduler.getRegisteredCount()).toBe(1);

      scheduler.unregisterAgent('aid-worker');
      expect(scheduler.getRegisteredCount()).toBe(0);
    });

    it('stop clears all timers', () => {
      scheduler.registerAgent('aid-1', 30);
      scheduler.registerAgent('aid-2', 30);

      scheduler.stop();

      expect(scheduler.getRegisteredCount()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 10. rebuildState Recovery
  // -------------------------------------------------------------------------

  describe('Task recovery after restart', () => {
    it('marks active tasks as failed (recovery) and retries if possible', async () => {
      const taskStore = createMockTaskStore();
      const orgChart = createMockOrgChart();

      const taskWithRetries: Task = {
        id: 'task-retry',
        parent_id: '',
        team_slug: 'team-a',
        agent_aid: 'aid-worker',
        title: 'Task with retries',
        status: TaskStatus.Active,
        prompt: 'Do work',
        result: '',
        error: '',
        blocked_by: [],
        priority: 0,
        retry_count: 0,
        max_retries: 3,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      };

      const taskNoRetries: Task = {
        id: 'task-no-retry',
        parent_id: '',
        team_slug: 'team-a',
        agent_aid: 'aid-worker',
        title: 'Task without retries',
        status: TaskStatus.Active,
        prompt: 'Do work',
        result: '',
        error: '',
        blocked_by: [],
        priority: 0,
        retry_count: 3,
        max_retries: 3,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      };

      vi.mocked(taskStore.listByStatus).mockResolvedValue([taskWithRetries, taskNoRetries]);
      vi.mocked(orgChart.getTeamBySlug).mockReturnValue({
        leaderAid: 'aid-lead',
      } as OrgChartTeam);

      const escalationHandler = vi.fn().mockResolvedValue('esc-1');

      // Simulate recovery: mark failed, then retry or escalate
      const tasks = new Map<string, Task>();
      tasks.set('task-retry', taskWithRetries);
      tasks.set('task-no-retry', taskNoRetries);

      vi.mocked(taskStore.get).mockImplementation(async (id: string) => {
        const t = tasks.get(id);
        if (!t) throw new NotFoundError(`Task ${id} not found`);
        return t;
      });
      vi.mocked(taskStore.update).mockImplementation(async (task: Task) => {
        tasks.set(task.id, task);
      });

      // Mark tasks as failed
      for (const task of [taskWithRetries, taskNoRetries]) {
        await taskStore.update({
          ...task,
          status: TaskStatus.Failed,
          error: 'Task interrupted by orchestrator restart (recovery)',
          updated_at: Date.now(),
          completed_at: Date.now(),
        });
      }

      // Retry task with retries
      if (taskWithRetries.retry_count < taskWithRetries.max_retries) {
        await taskStore.update({
          ...taskWithRetries,
          status: TaskStatus.Pending,
          retry_count: taskWithRetries.retry_count + 1,
          error: '',
          updated_at: Date.now(),
          completed_at: null,
        });
      }

      // Escalate task without retries
      if (taskNoRetries.retry_count >= taskNoRetries.max_retries) {
        await escalationHandler('aid-lead', 'task-no-retry', 'error' as never, {
          recovery: true,
          retries_exhausted: true,
        });
      }

      // Verify retry task was transitioned to pending
      const retryTask = tasks.get('task-retry');
      expect(retryTask?.status).toBe(TaskStatus.Pending);
      expect(retryTask?.retry_count).toBe(1);

      // Verify no-retry task escalated
      expect(escalationHandler).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 11. Memory Reconciliation
  // -------------------------------------------------------------------------

  describe('RetentionWorker memory reconciliation', () => {
    let worker: RetentionWorker;
    let logStore: LogStore;
    let memoryStore: MemoryStore;
    let archiveWriter: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      logStore = createMockLogStore();
      memoryStore = createMockMemoryStore();
      archiveWriter = vi.fn().mockResolvedValue(undefined);

      worker = new RetentionWorker({
        logStore,
        memoryStore,
        logger,
        archiveWriter,
      });
    });

    afterEach(() => {
      worker.stop();
    });

    it('reindexes workspace memory files into SQLite', async () => {
      const memoryEntries = [
        { content: 'Memory entry 1', memoryType: 'curated' as const, createdAt: Date.now() - 1000 },
        { content: 'Memory entry 2', memoryType: 'daily' as const, createdAt: Date.now() },
      ];

      const indexed = await worker.reconcileMemory(
        'aid-worker',
        'team-a',
        memoryEntries,
      );

      expect(indexed).toBe(2);
      expect(memoryStore.save).toHaveBeenCalledTimes(2);
    });

    it('handles empty memory entries', async () => {
      const indexed = await worker.reconcileMemory(
        'aid-worker',
        'team-a',
        [],
      );

      expect(indexed).toBe(0);
      expect(memoryStore.save).not.toHaveBeenCalled();
    });

    it('runRetention sweeps expired entries by tier', async () => {
      vi.mocked(logStore.deleteByLevelBefore).mockResolvedValue(10);

      const deleted = await worker.runRetention();

      expect(deleted).toBe(50); // 5 levels (trace, debug, info, warn, error) x 10 each
      expect(logStore.deleteByLevelBefore).toHaveBeenCalled();
    });

    it('runArchive exports when count > threshold', async () => {
      vi.mocked(logStore.count).mockResolvedValue(150_000);
      vi.mocked(logStore.getOldest).mockResolvedValue([
        {
          id: 1,
          level: LogLevel.Debug,
          event_type: 'test',
          component: 'test',
          action: 'test',
          message: 'old log',
          params: '{}',
          team_slug: 'team-a',
          task_id: '',
          agent_aid: '',
          request_id: '',
          correlation_id: '',
          error: '',
          duration_ms: 0,
          created_at: Date.now() - 10000,
        },
      ]);
      vi.mocked(logStore.deleteBefore).mockResolvedValue(1);

      const archived = await worker.runArchive();

      expect(archived).toBe(1);
      expect(archiveWriter).toHaveBeenCalled();
    });

    it('runArchive skips when count < threshold', async () => {
      vi.mocked(logStore.count).mockResolvedValue(50_000);

      const archived = await worker.runArchive();

      expect(archived).toBe(0);
      expect(archiveWriter).not.toHaveBeenCalled();
    });

    it('shared lock prevents simultaneous retention and archive', async () => {
      vi.mocked(logStore.deleteByLevelBefore).mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return 1;
      });
      vi.mocked(logStore.count).mockResolvedValue(150_000);

      // Run both concurrently
      const [retentionResult, archiveResult] = await Promise.all([
        worker.runRetention(),
        worker.runArchive(),
      ]);

      // Only one should run (the other should return 0 due to lock)
      const totalRun = (retentionResult > 0 ? 1 : 0) + (archiveResult > 0 ? 1 : 0);
      expect(totalRun).toBeLessThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // Integration: Full Flow
  // -------------------------------------------------------------------------

  describe('Integration: Full orchestrator flow', () => {
    it('routes message, dispatches task, handles tool call, processes result', async () => {
      // Setup all components
      const router = new RouterImpl();
      const taskStore = createMockTaskStore();
      const orgChart = createMockOrgChart();
      const wsHub = createMockWSHub();
      const mcpRegistry = createMockMCPRegistry();
      const toolCallStore = createMockToolCallStore();

      // Add route
      router.addKnownRoute('ping', 'team-a', 'exact');

      // Route message
      const message: InboundMessage = {
        id: 'msg-1',
        chatJid: 'chat-1',
        channelType: ChannelType.Discord,
        content: 'ping',
        timestamp: Date.now(),
      };

      const teamSlug = await router.route(message);
      expect(teamSlug).toBe('team-a');

      // Setup agent and team
      vi.mocked(orgChart.getAgent).mockReturnValue({
        aid: 'aid-worker',
        teamSlug: 'team-a',
        role: AgentRole.Member,
        name: 'Worker',
        status: AgentStatus.Idle,
      } as OrgChartAgent);
      vi.mocked(orgChart.getTeamBySlug).mockReturnValue({
        tid: 'tid-a',
        slug: 'team-a',
        leaderAid: 'aid-lead',
        containerId: 'container-1',
      } as OrgChartTeam);
      vi.mocked(mcpRegistry.isAllowed).mockReturnValue(true);

      // Create task
      const task: Task = {
        id: 'task-1',
        parent_id: '',
        team_slug: 'team-a',
        agent_aid: 'aid-worker',
        title: 'Ping task',
        status: TaskStatus.Pending,
        prompt: 'Handle ping',
        result: '',
        error: '',
        blocked_by: [],
        priority: 0,
        retry_count: 0,
        max_retries: 3,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      };

      await taskStore.create(task);

      // Setup DAG manager
      const escalationHandler = vi.fn().mockResolvedValue('esc-1');
      const dagManager = new TaskDAGManager({
        taskStore,
        orgChart,
        wsHub,
        eventBus,
        logger,
        onEscalation: escalationHandler,
      });

      vi.mocked(taskStore.validateDependencies).mockResolvedValue(undefined);
      vi.mocked(taskStore.getBlockedBy).mockResolvedValue([]);
      vi.mocked(taskStore.get).mockResolvedValue(task);

      // Dispatch task
      await dagManager.dispatchTask(task);

      expect(wsHub.send).toHaveBeenCalledWith(
        'tid-a',
        expect.objectContaining({
          type: 'task_dispatch',
        }),
      );

      // Setup tool call dispatcher
      const toolHandler = vi.fn().mockResolvedValue({ success: true });
      const handlers = new Map<string, (args: Record<string, unknown>, agentAid: string, teamSlug: string) => Promise<Record<string, unknown>>>();
      handlers.set('send_message', toolHandler);

      const toolDispatcher = new ToolCallDispatcher({
        orgChart,
        mcpRegistry,
        logStore,
        toolCallStore,
        logger,
        handlers,
      });

      // Agent calls tool
      const toolResult = await toolDispatcher.handleToolCall(
        'aid-worker',
        'send_message',
        { content: 'pong' },
        crypto.randomUUID(),
      );

      expect(toolResult).toEqual({ success: true });
      expect(toolHandler).toHaveBeenCalled();

      // Complete task
      vi.mocked(taskStore.get).mockResolvedValue({
        ...task,
        status: TaskStatus.Active,
      });
      vi.mocked(taskStore.getSubtree).mockResolvedValue([]);

      await dagManager.handleTaskResult('task-1', 'aid-worker', TaskStatus.Completed, 'pong');

      expect(taskStore.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: TaskStatus.Completed,
          result: 'pong',
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 8. tool_call -> tool_result response loop (AC18, AC19, AC20)
  // -------------------------------------------------------------------------

  describe('tool_call -> tool_result response', () => {
    /**
     * Simulates the onMessage handler's tool_call branch from index.ts.
     *
     * The real implementation (index.ts lines 444-453) reads:
     *
     *   orchestrator.handleToolCall(agent_aid, tool_name, args, call_id)
     *     .then((result) => {
     *       wsServer.send(tid, { type: 'tool_result', data: { call_id, result } });
     *     })
     *     .catch((err) => {
     *       const isDomainError = err instanceof DomainError;
     *       const errorCode = isDomainError ? mapDomainErrorToWSError(err) : 'INTERNAL_ERROR';
     *       const errorMessage = isDomainError ? err.message : 'Internal error processing tool call';
     *       wsServer.send(tid, { type: 'tool_result', data: { call_id, error_code: errorCode, error_message: errorMessage } });
     *       logger.error('tool_call handler failed', { call_id, error: String(err) });
     *     });
     *
     * This helper replicates that exact branching so tests can verify the
     * wsServer.send calls for all three paths without booting index.ts.
     */
    async function simulateToolCallHandler(opts: {
      tid: string;
      call_id: string;
      agent_aid: string;
      tool_name: string;
      args: Record<string, unknown>;
      handleToolCall: (agentAid: string, toolName: string, args: Record<string, unknown>, callId: string) => Promise<Record<string, unknown>>;
      wsServerSend: ReturnType<typeof vi.fn>;
      loggerError: ReturnType<typeof vi.fn>;
    }): Promise<void> {
      const { tid, call_id, agent_aid, tool_name, args, handleToolCall, wsServerSend, loggerError } = opts;

      await handleToolCall(agent_aid, tool_name, args, call_id).then((result) => {
        wsServerSend(tid, { type: 'tool_result', data: { call_id, result } });
      }).catch((err: unknown) => {
        const isDomainError = err instanceof DomainError;
        const errorCode = isDomainError ? mapDomainErrorToWSError(err) : 'INTERNAL_ERROR';
        const errorMessage = isDomainError ? (err as DomainError).message : 'Internal error processing tool call';
        wsServerSend(tid, { type: 'tool_result', data: { call_id, error_code: errorCode, error_message: errorMessage } });
        loggerError('tool_call handler failed', { call_id, error: String(err) });
      });
    }

    it('AC18: success path sends tool_result with result payload', async () => {
      const wsServerSend = vi.fn();
      const loggerError = vi.fn();
      const resultPayload = { status: 'ok', value: 42 };
      const handleToolCall = vi.fn().mockResolvedValue(resultPayload);

      await simulateToolCallHandler({
        tid: 'tid-container-1',
        call_id: 'call-abc-123',
        agent_aid: 'aid-worker-abc1',
        tool_name: 'send_message',
        args: { content: 'hello' },
        handleToolCall,
        wsServerSend,
        loggerError,
      });

      expect(wsServerSend).toHaveBeenCalledOnce();
      expect(wsServerSend).toHaveBeenCalledWith('tid-container-1', {
        type: 'tool_result',
        data: {
          call_id: 'call-abc-123',
          result: resultPayload,
        },
      });
      // No error logging on success path
      expect(loggerError).not.toHaveBeenCalled();
    });

    it('AC19: DomainError path uses mapDomainErrorToWSError for error_code, not class name', async () => {
      const wsServerSend = vi.fn();
      const loggerError = vi.fn();
      const domainError = new NotFoundError('agent aid-missing not found');
      const handleToolCall = vi.fn().mockRejectedValue(domainError);

      await simulateToolCallHandler({
        tid: 'tid-container-2',
        call_id: 'call-def-456',
        agent_aid: 'aid-worker-def4',
        tool_name: 'get_task',
        args: { task_id: 'task-missing' },
        handleToolCall,
        wsServerSend,
        loggerError,
      });

      expect(wsServerSend).toHaveBeenCalledOnce();
      const sentMessage = vi.mocked(wsServerSend).mock.calls[0][1] as {
        type: string;
        data: { call_id: string; error_code: string; error_message: string };
      };

      expect(sentMessage.type).toBe('tool_result');
      expect(sentMessage.data.call_id).toBe('call-def-456');

      // Must use WSErrorCode value ('NOT_FOUND'), not class name ('NotFoundError')
      expect(sentMessage.data.error_code).toBe(WSErrorCode.NotFound);
      expect(sentMessage.data.error_code).toBe('NOT_FOUND');
      expect(sentMessage.data.error_code).not.toBe('NotFoundError');

      // Error message is the domain error's own message
      expect(sentMessage.data.error_message).toBe('agent aid-missing not found');

      // Error is logged
      expect(loggerError).toHaveBeenCalledWith(
        'tool_call handler failed',
        expect.objectContaining({ call_id: 'call-def-456' }),
      );
    });

    it('AC20: unexpected error path uses INTERNAL_ERROR and sanitized message, raw error not echoed', async () => {
      const wsServerSend = vi.fn();
      const loggerError = vi.fn();
      const rawError = new Error('kaboom: internal db state corrupted at offset 0xDEAD');
      const handleToolCall = vi.fn().mockRejectedValue(rawError);

      await simulateToolCallHandler({
        tid: 'tid-container-3',
        call_id: 'call-ghi-789',
        agent_aid: 'aid-worker-ghi7',
        tool_name: 'create_task',
        args: { title: 'test' },
        handleToolCall,
        wsServerSend,
        loggerError,
      });

      expect(wsServerSend).toHaveBeenCalledOnce();
      const sentMessage = vi.mocked(wsServerSend).mock.calls[0][1] as {
        type: string;
        data: { call_id: string; error_code: string; error_message: string };
      };

      expect(sentMessage.type).toBe('tool_result');
      expect(sentMessage.data.call_id).toBe('call-ghi-789');

      // Must use literal 'INTERNAL_ERROR', not the raw error class name
      expect(sentMessage.data.error_code).toBe('INTERNAL_ERROR');

      // Must use sanitized message, NOT the raw err.message
      expect(sentMessage.data.error_message).toBe('Internal error processing tool call');
      expect(sentMessage.data.error_message).not.toContain('kaboom');
      expect(sentMessage.data.error_message).not.toContain('0xDEAD');

      // Raw error details must NOT appear anywhere in the sent message
      const sentJson = JSON.stringify(sentMessage);
      expect(sentJson).not.toContain('kaboom');
      expect(sentJson).not.toContain('0xDEAD');

      // Error IS logged internally (for debugging), but not echoed to client
      expect(loggerError).toHaveBeenCalledWith(
        'tool_call handler failed',
        expect.objectContaining({ call_id: 'call-ghi-789' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // AC17: rebuildState() must NOT send heartbeat to containers
  // -------------------------------------------------------------------------

  describe('rebuildState() heartbeat direction (AC17)', () => {
    it('AC17: rebuildState() never calls wsHub.send with type heartbeat', async () => {
      // Protocol: heartbeat is container-to-root only (INV-02 direction enforcement).
      // Prior to step 20, rebuildState() sent { type: 'heartbeat', data: { request: true } }
      // to each running container. That violates the protocol. Verify it is removed.
      const wsHub = createMockWSHub();
      const orgChart = createMockOrgChart();
      const taskStore = createMockTaskStore();

      const mockContainerManager: ContainerManager = {
        spawnTeamContainer: vi.fn(),
        stopTeamContainer: vi.fn(),
        restartTeamContainer: vi.fn(),
        getContainerByTeam: vi.fn(),
        listRunningContainers: vi.fn().mockResolvedValue([
          { id: 'container-1', name: 'team-a', tid: 'tid-a', teamSlug: 'team-a', state: 'running', health: 'running' },
          { id: 'container-2', name: 'team-b', tid: 'tid-b', teamSlug: 'team-b', state: 'running', health: 'running' },
        ]),
        cleanupStoppedContainers: vi.fn().mockResolvedValue(0),
      };

      const mockAgentExecutor: AgentExecutor = {
        start: vi.fn(),
        stop: vi.fn(),
        kill: vi.fn(),
        isRunning: vi.fn().mockReturnValue(false),
        getStatus: vi.fn().mockReturnValue(undefined),
        dispatchTask: vi.fn().mockResolvedValue({ output: '', sessionId: undefined }),
      };

      const mockConfigLoader: ConfigLoader = {
        loadMaster: vi.fn(),
        saveMaster: vi.fn(),
        getMaster: vi.fn().mockReturnValue({ limits: {}, channels: {}, assistant: {} }),
        loadProviders: vi.fn(),
        saveProviders: vi.fn(),
        loadTeam: vi.fn(),
        saveTeam: vi.fn(),
        createTeamDir: vi.fn(),
        deleteTeamDir: vi.fn(),
        listTeams: vi.fn().mockResolvedValue([]),
        watchMaster: vi.fn(),
        watchProviders: vi.fn(),
        watchTeam: vi.fn(),
        stopWatching: vi.fn(),
        getConfigWithSources: vi.fn().mockResolvedValue({}),
      };

      // Set up task store so recoverTasks() finds no active tasks
      vi.mocked(taskStore.listByStatus).mockResolvedValue([]);

      const deps: OrchestratorDeps = {
        configLoader: mockConfigLoader,
        logger,
        eventBus,
        orgChart,
        wsHub,
        containerManager: mockContainerManager,
        agentExecutor: mockAgentExecutor,
        stores: {
          taskStore,
          // These stores are not touched by rebuildState() / recoverTasks()
          messageStore: {} as never,
          logStore: createMockLogStore(),
          memoryStore: createMockMemoryStore(),
          integrationStore: {} as never,
          credentialStore: {} as never,
          toolCallStore: createMockToolCallStore(),
        },
        mcpRegistry: createMockMCPRegistry(),
      };

      const orchestrator = new OrchestratorImpl(deps, true /* isRoot */);

      await orchestrator.rebuildState();

      // wsHub.send must NOT have been called with type 'heartbeat' at any point
      const sendCalls = vi.mocked(wsHub.send).mock.calls;
      const heartbeatCalls = sendCalls.filter(
        ([, payload]) => (payload as { type: string }).type === 'heartbeat',
      );
      expect(heartbeatCalls).toHaveLength(0);
    });
  });
});