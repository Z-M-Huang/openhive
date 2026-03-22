/**
 * Layer 8 Phase Gate: Orchestrator integration tests.
 *
 * Integration flow, tool_call->tool_result response, and rebuildState tests.
 * Component-specific tests are split into layer-8-routing, layer-8-dispatcher,
 * layer-8-dag, layer-8-escalation, and layer-8-recovery test files.
 *
 * AC-L8-01 through AC-L8-21
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';

import { RouterImpl } from '../control-plane/router.js';
import { ToolCallDispatcher } from '../control-plane/tool-call-dispatcher.js';
import { TaskDAGManager } from '../control-plane/task-dag-manager.js';
import { EventBusImpl } from '../control-plane/event-bus.js';
import { OrchestratorImpl } from '../control-plane/orchestrator.js';
import type { OrchestratorDeps } from '../control-plane/orchestrator.js';

import {
  TaskStatus,
  AgentStatus,
  AgentRole,
  ChannelType,
} from '../domain/enums.js';
import {
  DomainError,
  NotFoundError,
  mapDomainErrorToWSError,
} from '../domain/errors.js';
import { WSErrorCode } from '../domain/enums.js';
import type {
  InboundMessage,
  OrgChartAgent,
  OrgChartTeam,
  Logger,
  LogStore,
  ContainerManager,
  AgentExecutor,
  ConfigLoader,
} from '../domain/interfaces.js';
import type { Task } from '../domain/domain.js';

import { createMockLogger, createMockOrgChart, createMockWSHub, createMockTaskStore, createMockMCPRegistry, createMockToolCallStore, createMockLogStore, createMockMemoryStore } from './__layer-8-helpers.js';

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
        coordinatorAid: 'aid-lead',
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
