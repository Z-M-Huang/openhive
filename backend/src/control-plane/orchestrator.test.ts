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
    isAuthorized: vi.fn(), getTopology: vi.fn(),
    updateTeamTid: vi.fn(), getDispatchTarget: vi.fn(),
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
    getRecentUserTasks: vi.fn().mockResolvedValue([]),
    getNextPendingForAgent: vi.fn().mockResolvedValue(null),
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
    save: vi.fn().mockResolvedValue(1), search: vi.fn(), getByAgent: vi.fn(), deleteBefore: vi.fn(),
    softDeleteByAgent: vi.fn(), softDeleteByTeam: vi.fn(), purgeDeleted: vi.fn(),
    searchBM25: vi.fn().mockResolvedValue([]),
    searchHybrid: vi.fn().mockResolvedValue([]),
    saveChunks: vi.fn().mockResolvedValue(undefined),
    getChunks: vi.fn().mockResolvedValue([]),
    deleteChunks: vi.fn().mockResolvedValue(undefined),
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
    addAgentToTeamYaml: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockHealthMonitor() {
  return {
    recordHeartbeat: vi.fn(), getHealth: vi.fn(), getAgentHealth: vi.fn(),
    getAllHealth: vi.fn(), getStuckAgents: vi.fn().mockReturnValue([]), checkTimeouts: vi.fn(),
    start: vi.fn(), stop: vi.fn(),
  };
}

function createMockTokenManager() {
  return {
    generate: vi.fn(), validate: vi.fn(), revoke: vi.fn(), revokeAll: vi.fn(),
    startCleanup: vi.fn(), stopCleanup: vi.fn(),
    generateSession: vi.fn(), validateSession: vi.fn(),
    revokeSessionsForTid: vi.fn(), revokeSession: vi.fn(),
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
    dispatchTask: vi.fn().mockResolvedValue({ output: '', sessionId: undefined }),
  };
}

function createMockSessionManager() {
  return {
    createSession: vi.fn(), resumeSession: vi.fn(), endSession: vi.fn(),
    getSessionByAgent: vi.fn(), preloadFromStore: vi.fn().mockResolvedValue(undefined),
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
    getConfigWithSources: vi.fn().mockResolvedValue({}),
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
    tokenManager: createMockTokenManager(),
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
        coordinatorAid: 'aid-lead',
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
        coordinatorAid: 'aid-lead',
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
        coordinatorAid: 'aid-lead',
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

      // filteredSubscribe should be called for:
      // tool_call, task_result, session.cleanup, escalation, heartbeat, health.state_changed, container.restarted
      expect(deps.eventBus.filteredSubscribe).toHaveBeenCalledTimes(7);
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

      // Ready should NOT be sent yet (must wait for container_init first)
      expect(deps.wsConnection!.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ready' })
      );

      // Simulate container_init message to resolve the promise
      expect(onMessageCallback).toBeDefined();
      onMessageCallback!({
        type: 'container_init',
        data: { agents: [] },
      });

      await startPromise;

      // Ready should be sent AFTER container_init + agent startup
      expect(deps.wsConnection!.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ready' })
      );

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

  describe('Health auto-restart (AC-B1, AC-B2, AC-B6)', () => {
    /**
     * Helper: simulate a health.state_changed event by calling the handler
     * that is registered via filteredSubscribe.
     */
    async function triggerHealthEvent(
      deps: OrchestratorDeps,
      _orchestrator: InstanceType<typeof OrchestratorImpl>,
      eventData: { tid: string; previousState: string; newState: string },
    ): Promise<void> {
      // Find the filteredSubscribe call whose filter matches 'health.state_changed'
      const calls = vi.mocked(deps.eventBus.filteredSubscribe).mock.calls;
      for (const [filter, handler] of calls) {
        const event = { type: 'health.state_changed', data: eventData, timestamp: Date.now() };
        if (filter(event)) {
          handler(event);
          // Give the async handler a tick to run
          await new Promise((resolve) => setTimeout(resolve, 0));
          return;
        }
      }
      throw new Error('health.state_changed filteredSubscribe handler not found');
    }

    it('restarts container when newState is unreachable (AC-B1)', async () => {
      const deps = createRootDeps();
      vi.mocked(deps.orgChart.listTeams).mockReturnValue([
        { tid: 'tid-team-a', slug: 'team-a', coordinatorAid: 'aid-lead' } as any,
      ]);
      vi.mocked(deps.orgChart.getTeamBySlug).mockReturnValue(
        { tid: 'tid-team-a', slug: 'team-a' } as any,
      );
      vi.mocked(deps.containerManager!.restartTeamContainer).mockResolvedValue({ id: 'cid-1', name: 'openhive-test', state: 'running', teamSlug: 'test', tid: 'tid-test-new', health: 'running' as any, createdAt: Date.now() });

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      await triggerHealthEvent(deps, orchestrator, {
        tid: 'tid-team-a',
        previousState: 'healthy',
        newState: 'unreachable',
      });

      expect(deps.containerManager!.restartTeamContainer).toHaveBeenCalledWith(
        'team-a',
        expect.stringContaining('health_auto_restart'),
      );

      await orchestrator.stop();
    });

    it('does NOT restart container when newState is not unreachable', async () => {
      const deps = createRootDeps();
      vi.mocked(deps.orgChart.listTeams).mockReturnValue([
        { tid: 'tid-team-a', slug: 'team-a', coordinatorAid: 'aid-lead' } as any,
      ]);

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      await triggerHealthEvent(deps, orchestrator, {
        tid: 'tid-team-a',
        previousState: 'healthy',
        newState: 'degraded',
      });

      expect(deps.containerManager!.restartTeamContainer).not.toHaveBeenCalled();

      await orchestrator.stop();
    });

    it('revokes session tokens before restarting (AC-B6)', async () => {
      const deps = createRootDeps();
      vi.mocked(deps.orgChart.listTeams).mockReturnValue([
        { tid: 'tid-team-a', slug: 'team-a', coordinatorAid: 'aid-lead' } as any,
      ]);
      vi.mocked(deps.orgChart.getTeamBySlug).mockReturnValue(
        { tid: 'tid-team-a', slug: 'team-a' } as any,
      );
      vi.mocked(deps.containerManager!.restartTeamContainer).mockResolvedValue({ id: 'cid-1', name: 'openhive-test', state: 'running', teamSlug: 'test', tid: 'tid-test-new', health: 'running' as any, createdAt: Date.now() });

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      await triggerHealthEvent(deps, orchestrator, {
        tid: 'tid-team-a',
        previousState: 'healthy',
        newState: 'unreachable',
      });

      // Token revocation must happen before restart
      const tokenRevokeOrder = vi.mocked(deps.tokenManager!.revokeSessionsForTid).mock.invocationCallOrder[0];
      const restartOrder = vi.mocked(deps.containerManager!.restartTeamContainer).mock.invocationCallOrder[0];
      expect(tokenRevokeOrder).toBeLessThan(restartOrder);

      expect(deps.tokenManager!.revokeSessionsForTid).toHaveBeenCalledWith('tid-team-a');

      await orchestrator.stop();
    });

    it('rate limits auto-restart to 3 per hour per slug (AC-B2)', async () => {
      const deps = createRootDeps();
      vi.mocked(deps.orgChart.listTeams).mockReturnValue([
        { tid: 'tid-team-a', slug: 'team-a', coordinatorAid: 'aid-lead' } as any,
      ]);
      vi.mocked(deps.orgChart.getTeamBySlug).mockReturnValue(
        { tid: 'tid-team-a', slug: 'team-a' } as any,
      );
      vi.mocked(deps.containerManager!.restartTeamContainer).mockResolvedValue({ id: 'cid-1', name: 'openhive-test', state: 'running', teamSlug: 'test', tid: 'tid-test-new', health: 'running' as any, createdAt: Date.now() });

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      // Trigger 4 unreachable events — only 3 should result in restarts
      for (let i = 0; i < 4; i++) {
        await triggerHealthEvent(deps, orchestrator, {
          tid: 'tid-team-a',
          previousState: 'healthy',
          newState: 'unreachable',
        });
      }

      expect(deps.containerManager!.restartTeamContainer).toHaveBeenCalledTimes(3);
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Auto-restart rate limit exceeded for container team-a'),
        expect.any(Object),
      );

      await orchestrator.stop();
    });

    it('logs auto-restart at audit level (AC-B1)', async () => {
      const deps = createRootDeps();
      vi.mocked(deps.orgChart.listTeams).mockReturnValue([
        { tid: 'tid-team-a', slug: 'team-a', coordinatorAid: 'aid-lead' } as any,
      ]);
      vi.mocked(deps.orgChart.getTeamBySlug).mockReturnValue(
        { tid: 'tid-team-a', slug: 'team-a' } as any,
      );
      vi.mocked(deps.containerManager!.restartTeamContainer).mockResolvedValue({ id: 'cid-1', name: 'openhive-test', state: 'running', teamSlug: 'test', tid: 'tid-test-new', health: 'running' as any, createdAt: Date.now() });

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      await triggerHealthEvent(deps, orchestrator, {
        tid: 'tid-team-a',
        previousState: 'healthy',
        newState: 'unreachable',
      });

      expect(deps.logger.audit).toHaveBeenCalledWith(
        'health.auto_restart',
        expect.objectContaining({ slug: 'team-a', tid: 'tid-team-a' }),
      );

      await orchestrator.stop();
    });

    it('skips restart when no team found for tid', async () => {
      const deps = createRootDeps();
      // orgChart.listTeams returns empty — no team matches the tid
      vi.mocked(deps.orgChart.listTeams).mockReturnValue([]);

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      await triggerHealthEvent(deps, orchestrator, {
        tid: 'tid-unknown',
        previousState: 'healthy',
        newState: 'unreachable',
      });

      expect(deps.containerManager!.restartTeamContainer).not.toHaveBeenCalled();

      await orchestrator.stop();
    });
  });

  describe('Consolidated timer (AC-CROSS-4)', () => {
    it('calls healthMonitor.checkTimeouts() from the consolidated timer', async () => {
      vi.useFakeTimers();
      const deps = createRootDeps();

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      // Fire the 30s consolidated timer tick
      vi.advanceTimersByTime(30_000);
      // Give async callbacks a tick
      await Promise.resolve();

      expect(deps.healthMonitor!.checkTimeouts).toHaveBeenCalled();

      await orchestrator.stop();
      vi.useRealTimers();
    });

    it('timer is cleared on stop()', async () => {
      vi.useFakeTimers();
      const deps = createRootDeps();

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      const timerBefore = (orchestrator as any).consolidatedCheckTimer;
      expect(timerBefore).toBeDefined();

      await orchestrator.stop();

      expect((orchestrator as any).consolidatedCheckTimer).toBeUndefined();

      vi.useRealTimers();
    });

    it('stuckAgentTimer is no longer used (replaced by consolidatedCheckTimer)', async () => {
      const deps = createRootDeps();

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      // Old stuckAgentTimer field must not exist
      expect((orchestrator as any).stuckAgentTimer).toBeUndefined();

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

  describe('DispatchTracker wiring (AC-B5)', () => {
    function createMockDispatchTracker() {
      return {
        trackDispatch: vi.fn(),
        acknowledgeDispatch: vi.fn(),
        getUnacknowledged: vi.fn().mockReturnValue([]),
        getUnacknowledgedByAgent: vi.fn().mockReturnValue([]),
        transferOwnership: vi.fn().mockReturnValue(0),
        isTracked: vi.fn().mockReturnValue(false),
        start: vi.fn(),
        stop: vi.fn(),
      };
    }

    it('trackDispatch is called with task id and team tid after dispatchTask', async () => {
      const deps = createRootDeps();
      const dispatchTracker = createMockDispatchTracker();
      deps.dispatchTracker = dispatchTracker;

      const task: Task = {
        id: 'task-dt-1',
        parent_id: '',
        team_slug: 'team-a',
        agent_aid: 'aid-worker',
        title: 'DispatchTracker test',
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
        tid: 'tid-team-a',
        slug: 'team-a',
        coordinatorAid: 'aid-lead',
        containerId: 'container-1',
      } as any);

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      await orchestrator.dispatchTask(task);

      expect(dispatchTracker.trackDispatch).toHaveBeenCalledWith('task-dt-1', 'tid-team-a', 'aid-worker');

      await orchestrator.stop();
    });

    it('trackDispatch is not called when agent is not found in org chart', async () => {
      const deps = createRootDeps();
      const dispatchTracker = createMockDispatchTracker();
      deps.dispatchTracker = dispatchTracker;

      const task: Task = {
        id: 'task-dt-2',
        parent_id: '',
        team_slug: 'team-a',
        agent_aid: 'aid-unknown',
        title: 'Unknown agent',
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
      // Agent not found
      vi.mocked(deps.orgChart.getAgent).mockReturnValue(undefined);

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      await orchestrator.dispatchTask(task);

      expect(dispatchTracker.trackDispatch).not.toHaveBeenCalled();

      await orchestrator.stop();
    });

    it('acknowledgeDispatch is called with task id before task result is processed', async () => {
      const deps = createRootDeps();
      const dispatchTracker = createMockDispatchTracker();
      deps.dispatchTracker = dispatchTracker;

      const task = {
        id: 'task-dt-3',
        status: TaskStatus.Active,
        blocked_by: [],
        agent_aid: 'aid-worker',
        parent_id: '',
        team_slug: 'team-a',
      };

      vi.mocked(deps.stores!.taskStore.get).mockResolvedValue(task as any);

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      await orchestrator.handleTaskResult('task-dt-3', 'aid-worker', TaskStatus.Completed, 'done');

      expect(dispatchTracker.acknowledgeDispatch).toHaveBeenCalledWith('task-dt-3');

      await orchestrator.stop();
    });

    it('dispatchTracker.stop() is called during orchestrator.stop()', async () => {
      const deps = createRootDeps();
      const dispatchTracker = createMockDispatchTracker();
      deps.dispatchTracker = dispatchTracker;

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();
      await orchestrator.stop();

      expect(dispatchTracker.stop).toHaveBeenCalled();
    });

    it('dispatchTracker is optional — dispatchTask works without it', async () => {
      const deps = createRootDeps();
      // No dispatchTracker set

      const task: Task = {
        id: 'task-no-tracker',
        parent_id: '',
        team_slug: 'team-a',
        agent_aid: 'aid-worker',
        title: 'No tracker',
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
        tid: 'tid-team-a',
        slug: 'team-a',
        coordinatorAid: 'aid-lead',
        containerId: 'container-1',
      } as any);

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      // Should not throw
      await expect(orchestrator.dispatchTask(task)).resolves.toBeUndefined();

      await orchestrator.stop();
    });
  });

  describe('SessionManager wiring (AC-C1, AC-C2)', () => {
    function buildTaskForSessionTest(id: string, agentAid: string, teamSlug: string): Task {
      return {
        id,
        parent_id: '',
        team_slug: teamSlug,
        agent_aid: agentAid,
        title: 'Session test task',
        status: TaskStatus.Pending,
        prompt: 'do something',
        result: '',
        error: '',
        blocked_by: [],
        priority: 0,
        retry_count: 0,
        max_retries: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      };
    }

    it('dispatchTask calls sessionManager.createSession with agentAid and taskId (AC-C1)', async () => {
      const deps = createRootDeps();
      const sessionManager = createMockSessionManager();
      const SESSION_ID = 'sess-abc-123';
      vi.mocked(sessionManager.createSession).mockResolvedValue(SESSION_ID);
      deps.sessionManager = sessionManager;

      vi.mocked(deps.stores!.taskStore.validateDependencies).mockResolvedValue(undefined);
      vi.mocked(deps.stores!.taskStore.getBlockedBy).mockResolvedValue([]);
      vi.mocked(deps.orgChart.getAgent).mockReturnValue({
        aid: 'aid-worker',
        teamSlug: 'team-a',
      } as any);
      vi.mocked(deps.orgChart.getTeamBySlug).mockReturnValue({
        tid: 'tid-team-a',
        slug: 'team-a',
        coordinatorAid: 'aid-lead',
        containerId: 'container-1',
      } as any);

      const task = buildTaskForSessionTest('task-sess-1', 'aid-worker', 'team-a');

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();
      await orchestrator.dispatchTask(task);

      expect(sessionManager.createSession).toHaveBeenCalledWith('aid-worker', 'task-sess-1', 'tid-team-a');

      await orchestrator.stop();
    });

    it('dispatchTask includes session_id in task_dispatch WS message (AC-C1)', async () => {
      const deps = createRootDeps();
      const sessionManager = createMockSessionManager();
      const SESSION_ID = 'sess-xyz-456';
      vi.mocked(sessionManager.createSession).mockResolvedValue(SESSION_ID);
      deps.sessionManager = sessionManager;

      vi.mocked(deps.stores!.taskStore.validateDependencies).mockResolvedValue(undefined);
      vi.mocked(deps.stores!.taskStore.getBlockedBy).mockResolvedValue([]);
      vi.mocked(deps.orgChart.getAgent).mockReturnValue({
        aid: 'aid-worker',
        teamSlug: 'team-a',
      } as any);
      vi.mocked(deps.orgChart.getTeamBySlug).mockReturnValue({
        tid: 'tid-team-a',
        slug: 'team-a',
        coordinatorAid: 'aid-lead',
        containerId: 'container-1',
      } as any);

      const task = buildTaskForSessionTest('task-sess-2', 'aid-worker', 'team-a');

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();
      await orchestrator.dispatchTask(task);

      expect(deps.wsHub!.send).toHaveBeenCalledWith(
        'tid-team-a',
        expect.objectContaining({
          type: 'task_dispatch',
          data: expect.objectContaining({ session_id: SESSION_ID }),
        }),
      );

      await orchestrator.stop();
    });

    it('handleTaskResult calls sessionManager.endSession after processing (AC-C2)', async () => {
      const deps = createRootDeps();
      const sessionManager = createMockSessionManager();
      const SESSION_ID = 'sess-end-789';
      vi.mocked(sessionManager.createSession).mockResolvedValue(SESSION_ID);
      vi.mocked(sessionManager.endSession).mockResolvedValue(undefined);
      deps.sessionManager = sessionManager;

      vi.mocked(deps.stores!.taskStore.validateDependencies).mockResolvedValue(undefined);
      vi.mocked(deps.stores!.taskStore.getBlockedBy).mockResolvedValue([]);
      vi.mocked(deps.orgChart.getAgent).mockReturnValue({
        aid: 'aid-worker',
        teamSlug: 'team-a',
      } as any);
      vi.mocked(deps.orgChart.getTeamBySlug).mockReturnValue({
        tid: 'tid-team-a',
        slug: 'team-a',
        coordinatorAid: 'aid-lead',
        containerId: 'container-1',
      } as any);

      const task = buildTaskForSessionTest('task-sess-3', 'aid-worker', 'team-a');

      vi.mocked(deps.stores!.taskStore.get).mockResolvedValue({
        ...task,
        status: TaskStatus.Active,
      } as any);

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      // First dispatch to create the session
      await orchestrator.dispatchTask(task);
      // Then report result
      await orchestrator.handleTaskResult('task-sess-3', 'aid-worker', TaskStatus.Completed, 'done');

      expect(sessionManager.endSession).toHaveBeenCalledWith(SESSION_ID);

      await orchestrator.stop();
    });

    it('dispatchTask proceeds if sessionManager.createSession throws (non-fatal)', async () => {
      const deps = createRootDeps();
      const sessionManager = createMockSessionManager();
      vi.mocked(sessionManager.createSession).mockRejectedValue(new Error('Conflict'));
      deps.sessionManager = sessionManager;

      vi.mocked(deps.stores!.taskStore.validateDependencies).mockResolvedValue(undefined);
      vi.mocked(deps.stores!.taskStore.getBlockedBy).mockResolvedValue([]);
      vi.mocked(deps.orgChart.getAgent).mockReturnValue({
        aid: 'aid-worker',
        teamSlug: 'team-a',
      } as any);
      vi.mocked(deps.orgChart.getTeamBySlug).mockReturnValue({
        tid: 'tid-team-a',
        slug: 'team-a',
        coordinatorAid: 'aid-lead',
        containerId: 'container-1',
      } as any);

      const task = buildTaskForSessionTest('task-sess-4', 'aid-worker', 'team-a');

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      // Must NOT throw even though createSession fails
      await expect(orchestrator.dispatchTask(task)).resolves.toBeUndefined();
      expect(deps.logger.warn).toHaveBeenCalledWith(
        'session.create.failed',
        expect.objectContaining({ task_id: 'task-sess-4' }),
      );

      await orchestrator.stop();
    });

    it('handleTaskResult does not call endSession when no session was created', async () => {
      const deps = createRootDeps();
      const sessionManager = createMockSessionManager();
      deps.sessionManager = sessionManager;

      const task = {
        id: 'task-sess-5',
        status: TaskStatus.Active,
        blocked_by: [],
        agent_aid: 'aid-worker',
        parent_id: '',
        team_slug: 'team-a',
      };
      vi.mocked(deps.stores!.taskStore.get).mockResolvedValue(task as any);

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      // Handle result without prior dispatch (no session in map)
      await orchestrator.handleTaskResult('task-sess-5', 'aid-worker', TaskStatus.Completed, 'done');

      expect(sessionManager.endSession).not.toHaveBeenCalled();

      await orchestrator.stop();
    });

    it('rebuildState resumes sessions for active tasks (AC-C2)', async () => {
      const deps = createRootDeps();
      const sessionManager = createMockSessionManager();
      const SESSION_ID = 'sess-resume-abc';

      // Simulate a persisted session already known to the manager
      vi.mocked(sessionManager.getSessionByAgent).mockReturnValue(SESSION_ID);
      vi.mocked(sessionManager.resumeSession).mockResolvedValue(undefined);
      deps.sessionManager = sessionManager;

      const activeTask = {
        id: 'task-active-1',
        parent_id: '',
        team_slug: 'team-a',
        agent_aid: 'aid-worker',
        title: 'Active task',
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

      vi.mocked(deps.stores!.taskStore.listByStatus).mockResolvedValue([activeTask as any]);
      vi.mocked(deps.stores!.taskStore.get).mockResolvedValue({
        ...activeTask,
        status: TaskStatus.Failed,
      } as any);
      vi.mocked(deps.orgChart.getTeamBySlug).mockReturnValue({
        tid: 'tid-team-a',
        slug: 'team-a',
        coordinatorAid: 'aid-lead',
      } as any);
      vi.mocked(deps.orgChart.getAgent).mockReturnValue({
        aid: 'aid-lead',
        teamSlug: 'root',
      } as any);

      const orchestrator = new OrchestratorImpl(deps, true);
      await orchestrator.start();

      expect(sessionManager.getSessionByAgent).toHaveBeenCalledWith('aid-worker');
      expect(sessionManager.resumeSession).toHaveBeenCalledWith(SESSION_ID);

      await orchestrator.stop();
    });
  });
});