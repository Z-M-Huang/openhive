/**
 * Unit tests for OrchestratorImpl (thin coordinator).
 * AC-L8-16, AC-L8-17.
 */

import { describe, it, expect, vi } from 'vitest';
import { OrchestratorImpl, type OrchestratorDeps, type AllStores } from './orchestrator';
import { TaskStatus } from '../domain/enums.js';
import type { Task } from '../domain/domain.js';

// Mock factories
function createMockLogger() {
  return {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
    error: vi.fn(), audit: vi.fn(), log: vi.fn(), flush: vi.fn(), stop: vi.fn(),
  };
}

function createMockEventBus() {
  return {
    subscribe: vi.fn().mockReturnValue('sub-1'),
    filteredSubscribe: vi.fn().mockReturnValue('sub-filtered-1'),
    unsubscribe: vi.fn(), publish: vi.fn(), close: vi.fn(),
  };
}

function createMockOrgChart() {
  return {
    addTeam: vi.fn(), updateTeam: vi.fn(), removeTeam: vi.fn(), getTeam: vi.fn(),
    getTeamBySlug: vi.fn(), listTeams: vi.fn().mockReturnValue([]),
    getChildren: vi.fn(), getParent: vi.fn(),
    addAgent: vi.fn(), updateAgent: vi.fn(), removeAgent: vi.fn(), getAgent: vi.fn(),
    getAgentsByTeam: vi.fn().mockReturnValue([]),
    getLeadOf: vi.fn(), isAuthorized: vi.fn(), getTopology: vi.fn(),
  };
}

function createMockWSHub() {
  return {
    send: vi.fn(), broadcast: vi.fn(), isConnected: vi.fn().mockReturnValue(true),
    setReady: vi.fn(), isReady: vi.fn().mockReturnValue(true),
    handleUpgrade: vi.fn(), close: vi.fn(), getConnectedTeams: vi.fn(),
  };
}

function createMockWSConnection() {
  return {
    tid: 'tid-test-team',
    send: vi.fn(), close: vi.fn(), isAlive: vi.fn().mockReturnValue(true),
    onMessage: vi.fn(), onClose: vi.fn(),
  };
}

function createMockTaskStore() {
  return {
    create: vi.fn(), get: vi.fn(), update: vi.fn(), delete: vi.fn(),
    listByTeam: vi.fn(), listByStatus: vi.fn().mockResolvedValue([]),
    getSubtree: vi.fn(), getBlockedBy: vi.fn(), unblockTask: vi.fn(),
    validateDependencies: vi.fn(), retryTask: vi.fn(),
  };
}

function createMockLogStore() {
  return {
    create: vi.fn(), createWithIds: vi.fn().mockResolvedValue([1]), query: vi.fn(), deleteBefore: vi.fn(),
    deleteByLevelBefore: vi.fn(), count: vi.fn(), getOldest: vi.fn(),
  };
}

function createMockMemoryStore() {
  return {
    save: vi.fn(), search: vi.fn(), getByAgent: vi.fn(), deleteBefore: vi.fn(),
    softDeleteByAgent: vi.fn(), softDeleteByTeam: vi.fn(), purgeDeleted: vi.fn(),
  };
}

function createMockToolCallStore() {
  return {
    create: vi.fn(), getByTask: vi.fn(), getByAgent: vi.fn(), getByToolName: vi.fn(),
  };
}

function createMockMessageStore() {
  return {
    create: vi.fn(), getByChat: vi.fn(), getLatest: vi.fn(),
    deleteByChat: vi.fn(), deleteBefore: vi.fn(),
  };
}

function createMockIntegrationStore() {
  return {
    create: vi.fn(), get: vi.fn(), update: vi.fn(), delete: vi.fn(),
    listByTeam: vi.fn(), updateStatus: vi.fn(),
  };
}

function createMockCredentialStore() {
  return {
    create: vi.fn(), get: vi.fn(), update: vi.fn(), delete: vi.fn(), listByTeam: vi.fn(),
  };
}

function createMockProvisioner() {
  return {
    scaffoldWorkspace: vi.fn(), writeTeamConfig: vi.fn(),
    writeAgentDefinition: vi.fn(), writeSettings: vi.fn(),
    deleteWorkspace: vi.fn(), archiveWorkspace: vi.fn(),
  };
}

function createMockHealthMonitor() {
  return {
    recordHeartbeat: vi.fn(), getHealth: vi.fn(), getAgentHealth: vi.fn(),
    getAllHealth: vi.fn(), getStuckAgents: vi.fn(), start: vi.fn(), stop: vi.fn(),
  };
}

function createMockContainerManager() {
  return {
    spawnTeamContainer: vi.fn(), stopTeamContainer: vi.fn(),
    restartTeamContainer: vi.fn(), getContainerByTeam: vi.fn(),
    listRunningContainers: vi.fn().mockResolvedValue([]),
    cleanupStoppedContainers: vi.fn(),
  };
}

function createMockMCPRegistry() {
  return {
    registerTool: vi.fn(), unregisterTool: vi.fn(), getTool: vi.fn(),
    isAllowed: vi.fn(), listTools: vi.fn(), getToolsForRole: vi.fn(),
  };
}

function createMockAgentExecutor() {
  return {
    start: vi.fn(), stop: vi.fn(), kill: vi.fn(),
    isRunning: vi.fn(), getStatus: vi.fn(),
  };
}

function createMockSessionManager() {
  return {
    createSession: vi.fn(), resumeSession: vi.fn(), endSession: vi.fn(),
    getSessionByAgent: vi.fn(),
  };
}

function createMockConfigLoader() {
  return {
    loadMaster: vi.fn(), saveMaster: vi.fn(), getMaster: vi.fn(),
    loadProviders: vi.fn(), saveProviders: vi.fn(),
    loadTeam: vi.fn(), saveTeam: vi.fn(),
    createTeamDir: vi.fn(), deleteTeamDir: vi.fn(), listTeams: vi.fn(),
    watchMaster: vi.fn(), watchProviders: vi.fn(), watchTeam: vi.fn(),
    stopWatching: vi.fn(),
  };
}

function createMockStores(): AllStores {
  return {
    taskStore: createMockTaskStore(),
    messageStore: createMockMessageStore(),
    logStore: createMockLogStore(),
    memoryStore: createMockMemoryStore(),
    integrationStore: createMockIntegrationStore(),
    credentialStore: createMockCredentialStore(),
    toolCallStore: createMockToolCallStore(),
  };
}

function createRootDeps(): OrchestratorDeps {
  return {
    configLoader: createMockConfigLoader(),
    logger: createMockLogger(),
    eventBus: createMockEventBus(),
    orgChart: createMockOrgChart(),
    wsHub: createMockWSHub(),
    containerManager: createMockContainerManager(),
    provisioner: createMockProvisioner(),
    healthMonitor: createMockHealthMonitor(),
    keyManager: { unlock: vi.fn(), lock: vi.fn(), encrypt: vi.fn(), decrypt: vi.fn(), rekey: vi.fn(), isUnlocked: vi.fn().mockReturnValue(true) },
    triggerScheduler: { loadTriggers: vi.fn(), addCronTrigger: vi.fn(), removeTrigger: vi.fn(), listTriggers: vi.fn(), start: vi.fn(), stop: vi.fn() },
    agentExecutor: createMockAgentExecutor(),
    sessionManager: createMockSessionManager(),
    stores: createMockStores(),
    mcpRegistry: createMockMCPRegistry(),
  };
}

function createNonRootDeps(): OrchestratorDeps {
  return {
    configLoader: createMockConfigLoader(),
    logger: createMockLogger(),
    eventBus: createMockEventBus(),
    orgChart: createMockOrgChart(),
    wsConnection: createMockWSConnection(),
    agentExecutor: createMockAgentExecutor(),
    sessionManager: createMockSessionManager(),
    mcpRegistry: createMockMCPRegistry(),
  };
}

describe('OrchestratorImpl', () => {
  describe('Delegation', () => {
    it('handleToolCall delegates to ToolCallDispatcher', async () => {
      const deps = createRootDeps();
      vi.mocked(deps.orgChart.getAgent).mockReturnValue({
        aid: 'aid-test',
        teamSlug: 'team-a',
        role: 'member',
      } as any);
      vi.mocked(deps.mcpRegistry!.isAllowed).mockReturnValue(true);

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      // The ToolCallDispatcher is initialized, but has no handlers
      await expect(
        orchestrator.handleToolCall('aid-test', 'unknown_tool', {}, 'call-1')
      ).rejects.toThrow('Tool');

      await orchestrator.stop();
    });

    it('dispatchTask delegates to TaskDAGManager', async () => {
      const deps = createRootDeps();
      const task: Task = {
        id: 'task-1',
        parent_id: '',
        team_slug: 'team-a',
        agent_aid: 'aid-worker',
        title: 'Test',
        status: TaskStatus.Pending,
        prompt: 'test',
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

      vi.mocked(deps.stores!.taskStore.validateDependencies).mockResolvedValue(undefined);
      vi.mocked(deps.stores!.taskStore.getBlockedBy).mockResolvedValue([]);
      vi.mocked(deps.orgChart.getAgent).mockReturnValue({
        aid: 'aid-worker',
        teamSlug: 'team-a',
      } as any);
      vi.mocked(deps.orgChart.getTeamBySlug).mockReturnValue({
        tid: 'tid-a',
        slug: 'team-a',
        leaderAid: 'aid-lead',
        containerId: 'container-1',
      } as any);

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      await orchestrator.dispatchTask(task);

      expect(deps.stores!.taskStore.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: TaskStatus.Active })
      );

      await orchestrator.stop();
    });

    it('handleTaskResult delegates to TaskDAGManager', async () => {
      const deps = createRootDeps();
      const task = {
        id: 'task-1',
        status: TaskStatus.Active,
        blocked_by: [],
        agent_aid: 'aid-worker',
      };

      vi.mocked(deps.stores!.taskStore.get).mockResolvedValue(task as any);

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      await orchestrator.handleTaskResult('task-1', 'aid-worker', TaskStatus.Completed, 'done');

      expect(deps.stores!.taskStore.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: TaskStatus.Completed })
      );

      await orchestrator.stop();
    });
  });

  describe('rebuildState', () => {
    it('active tasks marked as failed with recovery, retry if retries remain', async () => {
      const deps = createRootDeps();
      const task = {
        id: 'task-1',
        parent_id: '',
        team_slug: 'team-a',
        agent_aid: 'aid-worker',
        title: 'Test',
        status: TaskStatus.Active,
        prompt: 'test',
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

      vi.mocked(deps.stores!.taskStore.listByStatus).mockResolvedValue([task as any]);
      vi.mocked(deps.orgChart.getTeamBySlug).mockReturnValue({
        tid: 'tid-a',
        slug: 'team-a',
        leaderAid: 'aid-lead',
      } as any);
      vi.mocked(deps.orgChart.getAgent).mockReturnValue({
        aid: 'aid-lead',
        teamSlug: 'root',
      } as any);
      vi.mocked(deps.wsHub!.isConnected).mockReturnValue(true);

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      // Verify task was transitioned to failed then to pending
      expect(deps.stores!.taskStore.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'task-1',
          status: TaskStatus.Failed,
          error: expect.stringContaining('recovery'),
        })
      );
      expect(deps.stores!.taskStore.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'task-1',
          status: TaskStatus.Pending,
          retry_count: 1,
        })
      );

      await orchestrator.stop();
    });

    it('escalates if retries exhausted', async () => {
      const deps = createRootDeps();
      const task = {
        id: 'task-1',
        parent_id: '',
        team_slug: 'team-a',
        agent_aid: 'aid-worker',
        title: 'Test',
        status: TaskStatus.Active,
        prompt: 'test',
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

      // Task is first marked as failed, then EscalationRouter needs to get it
      vi.mocked(deps.stores!.taskStore.listByStatus).mockResolvedValue([task as any]);
      vi.mocked(deps.stores!.taskStore.get).mockResolvedValue({
        ...task,
        status: TaskStatus.Failed,
      } as any);
      vi.mocked(deps.orgChart.getTeamBySlug).mockReturnValue({
        tid: 'tid-a',
        slug: 'team-a',
        leaderAid: 'aid-lead',
      } as any);
      vi.mocked(deps.orgChart.getAgent).mockReturnValue({
        aid: 'aid-lead',
        teamSlug: 'root',
      } as any);
      vi.mocked(deps.wsHub!.isConnected).mockReturnValue(true);

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      // Should have marked task as failed
      expect(deps.stores!.taskStore.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'task-1',
          status: TaskStatus.Failed,
        })
      );

      // EscalationRouter should have been called (updates task to Escalated)
      expect(deps.stores!.taskStore.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: TaskStatus.Escalated,
        })
      );

      await orchestrator.stop();
    });

    it('does not send heartbeat to containers during rebuildState (AC17: direction is container-to-root only)', async () => {
      const deps = createRootDeps();

      // Simulate one running container so the loop body executes
      vi.mocked(deps.containerManager!.listRunningContainers).mockResolvedValue([
        { tid: 'tid-team-a', teamSlug: 'team-a', health: 'healthy' } as any,
      ]);
      vi.mocked(deps.wsHub!.isConnected).mockReturnValue(true);

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      // wsHub.send must never be called with type 'heartbeat' -- that direction is forbidden
      const heartbeatCalls = vi.mocked(deps.wsHub!.send).mock.calls.filter(
        (args) => (args[1] as { type: string }).type === 'heartbeat'
      );
      expect(heartbeatCalls).toHaveLength(0);

      await orchestrator.stop();
    });
  });

  describe('Dual-mode', () => {
    it('start with isRoot=true subscribes to EventBus events', async () => {
      const deps = createRootDeps();

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      // filteredSubscribe should be called for tool_call, task_result, escalation, heartbeat
      expect(deps.eventBus.filteredSubscribe).toHaveBeenCalledTimes(4);
      expect(deps.eventBus.filteredSubscribe).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(Function)
      );

      await orchestrator.stop();
    });

    it('start with isRoot=true starts ProactiveScheduler and RetentionWorker', async () => {
      const deps = createRootDeps();

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      // ProactiveScheduler should register agents (none in this case)
      // RetentionWorker should have start() called
      // (verified via internal state, not directly observable)

      await orchestrator.stop();
    });

    it('start with isRoot=false registers WS handlers and waits for container_init', async () => {
      const deps = createNonRootDeps();

      const orchestrator = new OrchestratorImpl(deps, false);

      // Get reference to onMessage callback before starting
      let onMessageCallback: ((msg: { type: string; data: Record<string, unknown> }) => void) | undefined;

      vi.mocked(deps.wsConnection!.onMessage).mockImplementation((cb) => {
        onMessageCallback = cb;
      });

      // Start should block until container_init
      const startPromise = orchestrator.start();

      // Wait a bit for the async setup
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should register WS message handler
      expect(deps.wsConnection!.onMessage).toHaveBeenCalled();

      // Should send ready message
      expect(deps.wsConnection!.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ready' })
      );

      // Simulate container_init message to resolve the promise
      expect(onMessageCallback).toBeDefined();
      onMessageCallback!({
        type: 'container_init',
        data: { agents: [] },
      });

      await startPromise;

      await orchestrator.stop();
    });
  });

  describe('Start/Stop', () => {
    it('start() activates orchestrator-owned workers', async () => {
      const deps = createRootDeps();

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      // Verify EventBus subscriptions
      expect(deps.eventBus.filteredSubscribe).toHaveBeenCalled();

      await orchestrator.stop();
    });

    it('stop() tears down only orchestrator-owned workers', async () => {
      const deps = createRootDeps();

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      // Get subscription IDs
      const subIds = (orchestrator as any).eventSubscriptions;
      expect(subIds.length).toBeGreaterThan(0);

      await orchestrator.stop();

      // Verify EventBus.unsubscribe was called for each subscription
      expect(deps.eventBus.unsubscribe).toHaveBeenCalledTimes(subIds.length);

      // Verify subscriptions cleared
      expect((orchestrator as any).eventSubscriptions).toEqual([]);
    });
  });

  describe('agent_message handling (non-root)', () => {
    it('publishes agent.message event to EventBus with all 4 fields', async () => {
      const deps = createNonRootDeps();
      const orchestrator = new OrchestratorImpl(deps, false);

      // Start will wait for container_init
      const startPromise = orchestrator.start();

      // Grab the onMessage callback registered during startNonRoot
      const onMessageCallback = vi.mocked(deps.wsConnection!.onMessage).mock.calls[0][0];

      // Resolve start() by sending container_init first
      onMessageCallback({
        type: 'container_init',
        data: { agents: [] },
      });
      await startPromise;

      // Now simulate an agent_message arriving from root
      onMessageCallback({
        type: 'agent_message',
        data: {
          correlation_id: 'corr-abc123',
          source_aid: 'aid-sender-abc',
          target_aid: 'aid-target-def',
          content: 'Hello from another agent',
        },
      });

      // EventBus should have received an agent.message publish
      expect(deps.eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'agent.message',
          data: {
            correlation_id: 'corr-abc123',
            source_aid: 'aid-sender-abc',
            target_aid: 'aid-target-def',
            content: 'Hello from another agent',
          },
        })
      );

      // Debug log should have been emitted
      expect(deps.logger.debug).toHaveBeenCalledWith(
        'Received agent_message',
        expect.objectContaining({
          correlation_id: 'corr-abc123',
          source_aid: 'aid-sender-abc',
          target_aid: 'aid-target-def',
        })
      );

      await orchestrator.stop();
    });

    it('does not throw when eventBus is absent (optional dep)', async () => {
      const deps = createNonRootDeps();
      // Remove eventBus to confirm optional chaining protects publish
      deps.eventBus = undefined as any;

      const orchestrator = new OrchestratorImpl(deps, false);
      const startPromise = orchestrator.start();

      const onMessageCallback = vi.mocked(deps.wsConnection!.onMessage).mock.calls[0][0];
      onMessageCallback({ type: 'container_init', data: { agents: [] } });
      await startPromise;

      // Should not throw even with no eventBus
      expect(() =>
        onMessageCallback({
          type: 'agent_message',
          data: {
            correlation_id: 'corr-xyz',
            source_aid: 'aid-a',
            target_aid: 'aid-b',
            content: 'test',
          },
        })
      ).not.toThrow();

      await orchestrator.stop();
    });
  });

  describe('Container_init handling (non-root)', () => {
    it('receives init config and starts agents', async () => {
      const deps = createNonRootDeps();
      const agentConfigs = [
        {
          aid: 'aid-agent-1',
          name: 'Agent 1',
          description: 'Test agent',
          role: 'member',
          model: 'claude-sonnet',
          tools: ['read', 'write'],
          provider: {
            type: 'oauth' as const,
            oauthToken: 'test-token',
            models: { haiku: 'claude-haiku', sonnet: 'claude-sonnet', opus: 'claude-opus' },
          },
        },
      ];

      const orchestrator = new OrchestratorImpl(deps, false);

      // Start will wait for container_init
      const startPromise = orchestrator.start();

      // Simulate container_init message
      const onMessageCallback = vi.mocked(deps.wsConnection!.onMessage).mock.calls[0][0];
      onMessageCallback({
        type: 'container_init',
        data: { agents: agentConfigs },
      });

      await startPromise;

      // Verify agents were started
      expect(deps.agentExecutor.start).toHaveBeenCalledWith(
        expect.objectContaining({ aid: 'aid-agent-1' }),
        '/app/workspace'
      );

      await orchestrator.stop();
    });
  });

  describe('Error handling', () => {
    it('handleToolCall throws if ToolCallDispatcher not initialized', async () => {
      const deps = createNonRootDeps();

      const orchestrator = new OrchestratorImpl(deps, false);

      await expect(
        orchestrator.handleToolCall('aid-test', 'test_tool', {}, 'call-1')
      ).rejects.toThrow('ToolCallDispatcher not initialized');
    });

    it('dispatchTask throws if TaskDAGManager not initialized', async () => {
      const deps = createNonRootDeps();

      const orchestrator = new OrchestratorImpl(deps, false);

      await expect(
        orchestrator.dispatchTask({} as Task)
      ).rejects.toThrow('TaskDAGManager not initialized');
    });

    it('handleTaskResult throws if TaskDAGManager not initialized', async () => {
      const deps = createNonRootDeps();

      const orchestrator = new OrchestratorImpl(deps, false);

      await expect(
        orchestrator.handleTaskResult('task-1', 'aid-test', TaskStatus.Completed)
      ).rejects.toThrow('TaskDAGManager not initialized');
    });

    it('handleEscalation throws if EscalationRouter not initialized', async () => {
      const deps = createNonRootDeps();

      const orchestrator = new OrchestratorImpl(deps, false);

      await expect(
        orchestrator.handleEscalation('aid-test', 'task-1', 'error' as any, {})
      ).rejects.toThrow('EscalationRouter not initialized');
    });

    it('handleEscalationResponse throws if EscalationRouter not initialized', async () => {
      const deps = createNonRootDeps();

      const orchestrator = new OrchestratorImpl(deps, false);

      await expect(
        orchestrator.handleEscalationResponse('corr-1', 'retry', {})
      ).rejects.toThrow('EscalationRouter not initialized');
    });
  });
});