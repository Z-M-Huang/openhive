/**
 * Layer 6 Phase Gate: MCP Tools + Skills integration tests.
 *
 * Tests MCPBridge round-trip and timeout, SDKToolHandler authorization and
 * error mapping, tool execution (create_task with blocked_by, cycle detection),
 * save_memory dual-write, SkillLoader workspace shadowing and CON-12 truncation,
 * SkillRegistry team-scoped isolation (INV-08), and full integration wiring.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  OrgChartAgent,
  OrgChartTeam,
  BusEvent,
  MemoryEntry,
  TaskStore,
  MessageStore,
  LogStore,
  MemoryStore,
  IntegrationStore,
  CredentialStore,
  ToolCallStore,
  ContainerManager,
  ContainerProvisioner,
  KeyManager,
  WSHub,
  TriggerScheduler,
  HealthMonitor,
  Logger,
} from '../domain/index.js';

import {
  TaskStatus,
  AgentStatus,
  ContainerHealth,
  WSErrorCode,
  IntegrationStatus,
} from '../domain/index.js';

import {
  NotFoundError,
  CycleDetectedError,
} from '../domain/errors.js';

import { MCPBridgeImpl, TIMEOUT_QUERY_MS, TIMEOUT_MUTATING_MS, TIMEOUT_BLOCKING_MS } from '../mcp/bridge.js';
import { SDKToolHandler, createToolHandlers, TOOL_SCHEMAS } from '../mcp/tools/index.js';
import type { ToolContext } from '../mcp/tools/index.js';
import { MCPRegistryImpl } from '../mcp/registry.js';
import { OrgChartImpl } from '../control-plane/org-chart.js';
import { EventBusImpl } from '../control-plane/event-bus.js';
import { SkillLoaderImpl } from '../skills/loader.js';
import { SkillRegistryImpl } from '../skills/registry.js';

// ---------------------------------------------------------------------------
// Test helpers: mock logger
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

// ---------------------------------------------------------------------------
// Test helpers: mock ToolContext
// ---------------------------------------------------------------------------

function createMockToolContext(overrides?: Partial<ToolContext>): ToolContext {
  const orgChart = new OrgChartImpl();
  const eventBus = new EventBusImpl();
  const mcpRegistry = new MCPRegistryImpl();

  return {
    orgChart,
    taskStore: {
      create: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockImplementation(async (id: string) => ({
        id,
        parent_id: '',
        team_slug: 'test-team',
        agent_aid: 'aid-test-abc123',
        title: 'Test task',
        status: TaskStatus.Pending,
        prompt: 'Test prompt',
        result: '',
        error: '',
        blocked_by: null,
        priority: 0,
        retry_count: 0,
        max_retries: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      })),
      update: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      listByTeam: vi.fn().mockResolvedValue([]),
      listByStatus: vi.fn().mockResolvedValue([]),
      getSubtree: vi.fn().mockResolvedValue([]),
      getBlockedBy: vi.fn().mockResolvedValue([]),
      unblockTask: vi.fn().mockResolvedValue(false),
      retryTask: vi.fn().mockResolvedValue(false),
      validateDependencies: vi.fn().mockResolvedValue(undefined),
      getRecentUserTasks: vi.fn().mockResolvedValue([]),
    } satisfies TaskStore,
    messageStore: {
      create: vi.fn().mockResolvedValue(undefined),
      getByChat: vi.fn().mockResolvedValue([]),
      getLatest: vi.fn().mockResolvedValue([]),
      deleteByChat: vi.fn().mockResolvedValue(undefined),
      deleteBefore: vi.fn().mockResolvedValue(0),
    } satisfies MessageStore,
    logStore: {
      create: vi.fn().mockResolvedValue(undefined),
      createWithIds: vi.fn().mockResolvedValue([1]),
      query: vi.fn().mockResolvedValue([]),
      deleteBefore: vi.fn().mockResolvedValue(0),
      deleteByLevelBefore: vi.fn().mockResolvedValue(0),
      count: vi.fn().mockResolvedValue(0),
      getOldest: vi.fn().mockResolvedValue([]),
    } satisfies LogStore,
    memoryStore: {
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
    } satisfies MemoryStore,
    integrationStore: {
      create: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockImplementation(async (id: string) => ({
        id,
        team_id: 'test-team',
        name: 'test-integration',
        config_path: '/app/workspace/integrations/test.yaml',
        status: IntegrationStatus.Proposed,
        created_at: Date.now(),
      })),
      update: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      listByTeam: vi.fn().mockResolvedValue([]),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    } satisfies IntegrationStore,
    credentialStore: {
      create: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({ id: 'cred-1', name: 'api-key', encrypted_value: 'enc', team_id: 'test-team', created_at: Date.now() }),
      update: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      listByTeam: vi.fn().mockResolvedValue([]),
    } satisfies CredentialStore,
    toolCallStore: {
      create: vi.fn().mockResolvedValue(undefined),
      getByTask: vi.fn().mockResolvedValue([]),
      getByAgent: vi.fn().mockResolvedValue([]),
      getByToolName: vi.fn().mockResolvedValue([]),
    } satisfies ToolCallStore,
    containerManager: {
      spawnTeamContainer: vi.fn().mockResolvedValue({
        id: 'container-1', name: 'openhive-test', state: 'running',
        teamSlug: 'test-team', tid: 'tid-test-abc123',
        health: ContainerHealth.Running, createdAt: Date.now(),
      }),
      stopTeamContainer: vi.fn().mockResolvedValue(undefined),
      restartTeamContainer: vi.fn().mockResolvedValue(undefined),
      getContainerByTeam: vi.fn().mockResolvedValue(undefined),
      listRunningContainers: vi.fn().mockResolvedValue([]),
      cleanupStoppedContainers: vi.fn().mockResolvedValue(0),
    } satisfies ContainerManager,
    provisioner: {
      scaffoldWorkspace: vi.fn().mockResolvedValue('/app/workspace/teams/test-team'),
      writeTeamConfig: vi.fn().mockResolvedValue(undefined),
      writeAgentDefinition: vi.fn().mockResolvedValue(undefined),
      writeSettings: vi.fn().mockResolvedValue(undefined),
      deleteWorkspace: vi.fn().mockResolvedValue(undefined),
      archiveWorkspace: vi.fn().mockResolvedValue(undefined),
    } satisfies ContainerProvisioner,
    keyManager: {
      unlock: vi.fn().mockResolvedValue(undefined),
      lock: vi.fn().mockResolvedValue(undefined),
      rekey: vi.fn().mockResolvedValue(undefined),
      encrypt: vi.fn().mockResolvedValue('encrypted-value'),
      decrypt: vi.fn().mockResolvedValue('decrypted-value'),
      isUnlocked: vi.fn().mockReturnValue(true),
    } satisfies KeyManager,
    wsHub: {
      handleUpgrade: vi.fn(),
      send: vi.fn(),
      broadcast: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
      setReady: vi.fn(),
      isReady: vi.fn().mockReturnValue(true),
      getConnectedTeams: vi.fn().mockReturnValue([]),
      close: vi.fn().mockResolvedValue(undefined),
    } satisfies WSHub,
    eventBus,
    triggerScheduler: {
      loadTriggers: vi.fn().mockResolvedValue(undefined),
      addCronTrigger: vi.fn(),
      removeTrigger: vi.fn(),
      listTriggers: vi.fn().mockReturnValue([]),
      start: vi.fn(),
      stop: vi.fn(),
    } satisfies TriggerScheduler,
    mcpRegistry,
    healthMonitor: {
      recordHeartbeat: vi.fn(),
      getHealth: vi.fn().mockReturnValue(ContainerHealth.Running),
      getAgentHealth: vi.fn().mockReturnValue(AgentStatus.Idle),
      getAllHealth: vi.fn().mockReturnValue(new Map()),
      getStuckAgents: vi.fn().mockReturnValue([]),
      start: vi.fn(),
      stop: vi.fn(),
    } satisfies HealthMonitor,
    logger: createMockLogger(),
    limits: Object.freeze({
      max_depth: 3,
      max_teams: 10,
      max_agents_per_team: 5,
      max_concurrent_tasks: 50,
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test helpers: setup org chart with standard hierarchy
// ---------------------------------------------------------------------------

/**
 * Bootstrap a root team by directly seeding OrgChart's private maps.
 * Works around the chicken-and-egg: addTeam requires leader in agentsByAid,
 * addAgent requires team in teamsBySlug. The real orchestrator handles this at init.
 */
function bootstrapRootTeam(
  orgChart: OrgChartImpl,
  mainAid: string,
  rootTid: string,
): void {
  const raw = orgChart as unknown as {
    teamsByTid: Map<string, OrgChartTeam>;
    teamsBySlug: Map<string, OrgChartTeam>;
    agentsByAid: Map<string, OrgChartAgent>;
    agentsByTeam: Map<string, Set<string>>;
  };

  const rootTeam: OrgChartTeam = {
    tid: rootTid,
    slug: 'root-team',
    leaderAid: mainAid,
    parentTid: '',
    depth: 0,
    containerId: 'root-container',
    health: ContainerHealth.Running,
    agentAids: [mainAid],
    workspacePath: '/app/workspace',
  };
  const mainAgent: OrgChartAgent = {
    aid: mainAid,
    name: 'Main Assistant',
    teamSlug: 'root-team',
    role: 'main_assistant',
    status: AgentStatus.Idle,
  };

  raw.teamsByTid.set(rootTeam.tid, rootTeam);
  raw.teamsBySlug.set(rootTeam.slug, rootTeam);
  raw.agentsByAid.set(mainAgent.aid, mainAgent);
  raw.agentsByTeam.set('root-team', new Set([mainAgent.aid]));
}

function setupOrgChart(orgChart: OrgChartImpl): {
  mainAid: string;
  leadAid: string;
  memberAid: string;
  teamSlug: string;
  tid: string;
} {
  const mainAid = 'aid-main-abc123';
  const leadAid = 'aid-lead-def456';
  const memberAid = 'aid-member-ghi789';
  const teamSlug = 'test-team';
  const tid = 'tid-test-aaa111';
  const rootTid = 'tid-root-000000';

  // Bootstrap root team (chicken-and-egg workaround)
  bootstrapRootTeam(orgChart, mainAid, rootTid);

  // Add lead agent to root team (INV-01: lead runs in parent container)
  orgChart.addAgent({
    aid: leadAid,
    name: 'Team Lead',
    teamSlug: 'root-team',
    role: 'team_lead',
    status: AgentStatus.Idle,
  });

  // Add child team
  orgChart.addTeam({
    tid,
    slug: teamSlug,
    leaderAid: leadAid,
    parentTid: rootTid,
    depth: 1,
    containerId: 'container-test',
    health: ContainerHealth.Running,
    agentAids: [],
    workspacePath: '/app/workspace/teams/test-team',
  });

  // Add member agent to the child team
  orgChart.addAgent({
    aid: memberAid,
    name: 'Member Agent',
    teamSlug: teamSlug,
    role: 'member',
    status: AgentStatus.Idle,
  });

  return { mainAid, leadAid, memberAid, teamSlug, tid };
}

// ---------------------------------------------------------------------------
// Test helpers: temp directory management
// ---------------------------------------------------------------------------

let tmpRoot: string;

function createTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-l6-'));
}

// ===========================================================================
// Layer 6 Phase Gate Tests
// ===========================================================================

describe('Layer 6: MCP Tools + Skills', () => {
  beforeEach(() => {
    tmpRoot = createTmpRoot();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. MCPBridge round-trip
  // -------------------------------------------------------------------------

  describe('MCPBridge round-trip', () => {
    it('should send tool_call via WS and resolve when handleResult is called', async () => {
      const sent: Record<string, unknown>[] = [];
      const sendFn = (msg: Record<string, unknown>) => sent.push(msg);
      const bridge = new MCPBridgeImpl(sendFn, createMockLogger());

      // Start the call (non-blocking)
      const resultPromise = bridge.callTool('get_team', { slug: 'my-team' }, 'aid-caller-abc123');
      expect(bridge.getPendingCalls()).toBe(1);

      // Verify WS message was sent
      expect(sent).toHaveLength(1);
      const wsMsg = sent[0];
      expect(wsMsg.type).toBe('tool_call');

      const data = wsMsg.data as Record<string, unknown>;
      expect(data.tool_name).toBe('get_team');
      expect(data.arguments).toEqual({ slug: 'my-team' });
      expect(data.agent_aid).toBe('aid-caller-abc123');
      expect(typeof data.call_id).toBe('string');

      // Simulate root responding with the result
      const callId = data.call_id as string;
      bridge.handleResult(callId, { slug: 'my-team', tid: 'tid-my-abc123' });

      // Promise should resolve
      const result = await resultPromise;
      expect(result).toEqual({ slug: 'my-team', tid: 'tid-my-abc123' });
      expect(bridge.getPendingCalls()).toBe(0);
    });

    it('should reject when handleError is called', async () => {
      const sent: Record<string, unknown>[] = [];
      const sendFn = (msg: Record<string, unknown>) => sent.push(msg);
      const bridge = new MCPBridgeImpl(sendFn, createMockLogger());

      const resultPromise = bridge.callTool('get_team', { slug: 'missing' }, 'aid-caller-abc123');

      const data = (sent[0].data as Record<string, unknown>);
      const callId = data.call_id as string;

      bridge.handleError(callId, WSErrorCode.NotFound, "Team 'missing' not found");

      await expect(resultPromise).rejects.toThrow("Team 'missing' not found");
      expect(bridge.getPendingCalls()).toBe(0);
    });

    it('should time out query tools at 10s (CON-09)', async () => {
      vi.useFakeTimers();
      try {
        const sendFn = vi.fn();
        const bridge = new MCPBridgeImpl(sendFn, createMockLogger());

        const resultPromise = bridge.callTool('get_team', { slug: 'test' }, 'aid-caller-abc123');
        expect(bridge.getPendingCalls()).toBe(1);

        // Advance past the query timeout
        vi.advanceTimersByTime(TIMEOUT_QUERY_MS + 100);

        await expect(resultPromise).rejects.toThrow(/timed out.*get_team/);
        expect(bridge.getPendingCalls()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should assign correct timeout tiers', () => {
      const sendFn = vi.fn();
      const bridge = new MCPBridgeImpl(sendFn);

      // Query tier (10s)
      expect(bridge.getTimeoutForTool('get_team')).toBe(TIMEOUT_QUERY_MS);
      expect(bridge.getTimeoutForTool('recall_memory')).toBe(TIMEOUT_QUERY_MS);
      expect(bridge.getTimeoutForTool('list_containers')).toBe(TIMEOUT_QUERY_MS);

      // Mutating tier (60s)
      expect(bridge.getTimeoutForTool('create_task')).toBe(TIMEOUT_MUTATING_MS);
      expect(bridge.getTimeoutForTool('save_memory')).toBe(TIMEOUT_MUTATING_MS);

      // Blocking tier (5 min)
      expect(bridge.getTimeoutForTool('spawn_container')).toBe(TIMEOUT_BLOCKING_MS);
      expect(bridge.getTimeoutForTool('stop_container')).toBe(TIMEOUT_BLOCKING_MS);

      // Unknown defaults to mutating
      expect(bridge.getTimeoutForTool('unknown_tool')).toBe(TIMEOUT_MUTATING_MS);
    });

    it('should ignore handleResult for unknown call_id', () => {
      const sendFn = vi.fn();
      const logger = createMockLogger();
      const bridge = new MCPBridgeImpl(sendFn, logger);

      // Should not throw
      bridge.handleResult('nonexistent-id', { data: 'test' });
      expect(logger.warn).toHaveBeenCalledWith(
        'Received result for unknown call_id',
        expect.objectContaining({ call_id: 'nonexistent-id' }),
      );
    });

    it('should cancel all pending calls on cancelAll()', async () => {
      const sendFn = vi.fn();
      const bridge = new MCPBridgeImpl(sendFn, createMockLogger());

      const p1 = bridge.callTool('get_team', { slug: 'a' }, 'aid-a-abc123');
      const p2 = bridge.callTool('get_task', { task_id: 'b' }, 'aid-b-def456');
      expect(bridge.getPendingCalls()).toBe(2);

      bridge.cancelAll('shutdown');

      await expect(p1).rejects.toThrow('shutdown');
      await expect(p2).rejects.toThrow('shutdown');
      expect(bridge.getPendingCalls()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Tool authorization (SDKToolHandler RBAC)
  // -------------------------------------------------------------------------

  describe('Tool authorization', () => {
    it('should allow main_assistant to call spawn_container', async () => {
      const ctx = createMockToolContext();
      const { mainAid } = setupOrgChart(ctx.orgChart as OrgChartImpl);

      const handler = new SDKToolHandler(ctx);
      const result = await handler.handle('spawn_container', { team_slug: 'new-team' }, mainAid, 'call-1');

      expect(result.success).toBe(true);
      expect(result.result).toHaveProperty('container_id');
    });

    it('should deny member from calling spawn_container', async () => {
      const ctx = createMockToolContext();
      const { memberAid } = setupOrgChart(ctx.orgChart as OrgChartImpl);

      const handler = new SDKToolHandler(ctx);
      const result = await handler.handle('spawn_container', { team_slug: 'new-team' }, memberAid, 'call-2');

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.AccessDenied);
      expect(result.error_message).toContain('not authorized');
    });

    it('should deny member from calling create_team', async () => {
      const ctx = createMockToolContext();
      const { memberAid } = setupOrgChart(ctx.orgChart as OrgChartImpl);

      const handler = new SDKToolHandler(ctx);
      const result = await handler.handle(
        'create_team',
        { slug: 'new-team', leader_aid: 'aid-lead-def456', purpose: 'testing' },
        memberAid,
        'call-3',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.AccessDenied);
    });

    it('should allow member to call update_task_status', async () => {
      const ctx = createMockToolContext();
      const { memberAid } = setupOrgChart(ctx.orgChart as OrgChartImpl);

      // Task must be in Active state to transition to Completed
      (ctx.taskStore.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'task-1',
        parent_id: '',
        team_slug: 'test-team',
        agent_aid: memberAid,
        title: 'Test',
        status: TaskStatus.Active,
        prompt: 'Test',
        result: '',
        error: '',
        blocked_by: null,
        priority: 0,
        retry_count: 0,
        max_retries: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      });

      const handler = new SDKToolHandler(ctx);
      const result = await handler.handle(
        'update_task_status',
        { task_id: 'task-1', status: 'completed', result: 'Done' },
        memberAid,
        'call-4',
      );

      expect(result.success).toBe(true);
      expect(result.result).toEqual({ status: 'completed' });
    });

    it('should allow team_lead to call create_task but deny container tools', async () => {
      const ctx = createMockToolContext();
      const { leadAid } = setupOrgChart(ctx.orgChart as OrgChartImpl);

      const handler = new SDKToolHandler(ctx);

      // Lead can create tasks
      const taskResult = await handler.handle(
        'create_task',
        { agent_aid: 'aid-member-ghi789', prompt: 'Do something' },
        leadAid,
        'call-5',
      );
      expect(taskResult.success).toBe(true);
      expect(taskResult.result).toHaveProperty('task_id');

      // Lead cannot spawn containers
      const containerResult = await handler.handle(
        'spawn_container',
        { team_slug: 'new' },
        leadAid,
        'call-6',
      );
      expect(containerResult.success).toBe(false);
      expect(containerResult.error_code).toBe(WSErrorCode.AccessDenied);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Tool execution: create_task with blocked_by
  // -------------------------------------------------------------------------

  describe('Tool execution: create_task', () => {
    it('should create task with blocked_by dependencies', async () => {
      const ctx = createMockToolContext();
      const { leadAid, memberAid } = setupOrgChart(ctx.orgChart as OrgChartImpl);

      const handler = new SDKToolHandler(ctx);
      const result = await handler.handle(
        'create_task',
        {
          agent_aid: memberAid,
          prompt: 'Run tests',
          blocked_by: ['dep-task-1', 'dep-task-2'],
          priority: 5,
        },
        leadAid,
        'call-7',
      );

      expect(result.success).toBe(true);
      expect(result.result).toHaveProperty('task_id');

      // Verify validateDependencies was called
      expect(ctx.taskStore.validateDependencies).toHaveBeenCalledWith(
        expect.any(String),
        ['dep-task-1', 'dep-task-2'],
      );

      // Verify task was created with the blocked_by array
      expect(ctx.taskStore.create).toHaveBeenCalledWith(
        expect.objectContaining({
          blocked_by: ['dep-task-1', 'dep-task-2'],
          priority: 5,
        }),
      );
    });

    it('should reject create_task when cycle detected in dependencies', async () => {
      const ctx = createMockToolContext();
      const { leadAid, memberAid } = setupOrgChart(ctx.orgChart as OrgChartImpl);

      // Mock validateDependencies to throw CycleDetectedError
      (ctx.taskStore.validateDependencies as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new CycleDetectedError('Dependency cycle detected: task-a -> task-b -> task-a'),
      );

      const handler = new SDKToolHandler(ctx);
      const result = await handler.handle(
        'create_task',
        {
          agent_aid: memberAid,
          prompt: 'Cyclic task',
          blocked_by: ['task-b'],
        },
        leadAid,
        'call-8',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.CycleDetected);
      expect(result.error_message).toContain('cycle');
    });
  });

  // -------------------------------------------------------------------------
  // 4. Tool error mapping: domain errors -> WS error codes
  // -------------------------------------------------------------------------

  describe('Tool error mapping', () => {
    it('should map NotFoundError to NOT_FOUND', async () => {
      const ctx = createMockToolContext();
      const { mainAid } = setupOrgChart(ctx.orgChart as OrgChartImpl);

      // get_task throws NotFoundError for unknown task
      (ctx.taskStore.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new NotFoundError("Task 'nonexistent' not found"),
      );

      const handler = new SDKToolHandler(ctx);
      const result = await handler.handle(
        'get_task',
        { task_id: 'nonexistent' },
        mainAid,
        'call-9',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.NotFound);
      expect(result.error_message).toContain('not found');
    });

    it('should map ValidationError to VALIDATION_ERROR', async () => {
      const ctx = createMockToolContext();
      const { mainAid } = setupOrgChart(ctx.orgChart as OrgChartImpl);

      // Trigger validation by attempting invalid state transition
      (ctx.taskStore.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'task-1',
        parent_id: '',
        team_slug: 'test-team',
        agent_aid: mainAid,
        title: 'Test',
        status: TaskStatus.Completed, // terminal state
        prompt: 'Test',
        result: 'Done',
        error: '',
        blocked_by: null,
        priority: 0,
        retry_count: 0,
        max_retries: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: Date.now(),
      });

      const handler = new SDKToolHandler(ctx);
      const result = await handler.handle(
        'update_task_status',
        { task_id: 'task-1', status: 'active' },
        mainAid,
        'call-10',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.ValidationError);
      expect(result.error_message).toContain('Invalid task state transition');
    });

    it('should map AccessDeniedError to ACCESS_DENIED', async () => {
      const ctx = createMockToolContext();
      const { memberAid } = setupOrgChart(ctx.orgChart as OrgChartImpl);

      const handler = new SDKToolHandler(ctx);
      const result = await handler.handle(
        'list_containers',
        {},
        memberAid,
        'call-11',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.AccessDenied);
    });

    it('should map unknown errors to INTERNAL_ERROR', async () => {
      const ctx = createMockToolContext();
      const { mainAid } = setupOrgChart(ctx.orgChart as OrgChartImpl);

      // Simulate an unexpected runtime error in the handler
      (ctx.containerManager.listRunningContainers as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Docker socket connection refused'),
      );

      const handler = new SDKToolHandler(ctx);
      const result = await handler.handle(
        'list_containers',
        {},
        mainAid,
        'call-12',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.InternalError);
      expect(result.error_message).toContain('Docker socket');
    });

    it('should log tool calls on both success and failure', async () => {
      const ctx = createMockToolContext();
      const { mainAid } = setupOrgChart(ctx.orgChart as OrgChartImpl);

      const handler = new SDKToolHandler(ctx);

      // Success case
      await handler.handle('list_containers', {}, mainAid, 'call-success');
      expect(ctx.toolCallStore.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tool_use_id: 'call-success',
          tool_name: 'list_containers',
          agent_aid: mainAid,
          error: '',
        }),
      );

      // Failure case
      (ctx.containerManager.listRunningContainers as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('fail'),
      );
      await handler.handle('list_containers', {}, mainAid, 'call-failure');
      expect(ctx.toolCallStore.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tool_use_id: 'call-failure',
          tool_name: 'list_containers',
          error: 'fail',
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 5. save_memory dual-write: MemoryStore index write
  // -------------------------------------------------------------------------

  describe('save_memory dual-write', () => {
    it('should persist memory via MemoryStore with correct fields', async () => {
      const ctx = createMockToolContext();
      const { memberAid, teamSlug } = setupOrgChart(ctx.orgChart as OrgChartImpl);

      const handler = new SDKToolHandler(ctx);
      const result = await handler.handle(
        'save_memory',
        { content: 'Important discovery about API rate limits', memory_type: 'curated' },
        memberAid,
        'call-13',
      );

      expect(result.success).toBe(true);
      expect(result.result).toHaveProperty('memory_id');
      expect(result.result!.status).toBe('saved');

      // Verify MemoryStore.save was called with correct data
      expect(ctx.memoryStore.save).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_aid: memberAid,
          team_slug: teamSlug,
          content: 'Important discovery about API rate limits',
          memory_type: 'curated',
          deleted_at: null,
        }),
      );
    });

    it('should recall memories via MemoryStore search', async () => {
      const ctx = createMockToolContext();
      const { memberAid } = setupOrgChart(ctx.orgChart as OrgChartImpl);

      const mockMemories: MemoryEntry[] = [
        {
          id: 1,
          agent_aid: memberAid,
          team_slug: 'test-team',
          content: 'Rate limit is 100 req/min',
          memory_type: 'curated',
          created_at: Date.now(),
          deleted_at: null,
        },
      ];
      (ctx.memoryStore.searchHybrid as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockMemories);

      const handler = new SDKToolHandler(ctx);
      const result = await handler.handle(
        'recall_memory',
        { query: 'rate limit', limit: 5 },
        memberAid,
        'call-14',
      );

      expect(result.success).toBe(true);
      const memories = (result.result as Record<string, unknown>).memories as Array<Record<string, unknown>>;
      expect(memories).toHaveLength(1);
      expect(memories[0].content).toBe('Rate limit is 100 req/min');

      // Verify searchHybrid was called (recall_memory now uses hybrid search)
      expect(ctx.memoryStore.searchHybrid).toHaveBeenCalledWith(
        'rate limit',
        memberAid,
        undefined, // no embedding service
        5,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 6. SkillLoader: workspace shadows common, CON-12 truncation
  // -------------------------------------------------------------------------

  describe('SkillLoader', () => {
    it('should load common skills', async () => {
      const loader = new SkillLoaderImpl({
        commonSkillsPath: '/app/openhive/common/skills',
      });

      const skills = await loader.loadCommonSkills();
      expect(skills.length).toBeGreaterThanOrEqual(6);

      const names = skills.map((s) => s.name);
      expect(names).toContain('escalation');
      expect(names).toContain('health-report');
      expect(names).toContain('memory-management');
      expect(names).toContain('task-completion');
    });

    it('should load a single common skill by name', async () => {
      const loader = new SkillLoaderImpl({
        commonSkillsPath: '/app/openhive/common/skills',
      });

      const skill = await loader.loadSkill(tmpRoot, 'escalation');
      expect(skill.name).toBe('escalation');
      expect(skill.description).toBeTruthy();
      expect(skill.allowedTools).toContain('escalate');
      expect(skill.body).toBeTruthy();
    });

    it('should throw NotFoundError for nonexistent skill', async () => {
      const loader = new SkillLoaderImpl({
        commonSkillsPath: '/app/openhive/common/skills',
      });

      await expect(loader.loadSkill(tmpRoot, 'nonexistent-skill')).rejects.toThrow(NotFoundError);
    });

    it('should shadow common skill with workspace skill', async () => {
      // Create a workspace skill that overrides a common skill
      const wsSkillDir = path.join(tmpRoot, '.claude', 'skills', 'escalation');
      fs.mkdirSync(wsSkillDir, { recursive: true });
      fs.writeFileSync(
        path.join(wsSkillDir, 'SKILL.md'),
        [
          '---',
          'name: escalation',
          'description: Custom escalation for this team',
          'allowed-tools:',
          '  - escalate',
          '  - send_message',
          '---',
          '',
          '# Custom Escalation',
          '',
          'This is a team-specific override.',
        ].join('\n'),
      );

      const loader = new SkillLoaderImpl({
        commonSkillsPath: '/app/openhive/common/skills',
      });

      // loadSkill should return workspace version
      const skill = await loader.loadSkill(tmpRoot, 'escalation');
      expect(skill.description).toBe('Custom escalation for this team');

      // loadAllSkills should also return workspace version
      const allSkills = await loader.loadAllSkills(tmpRoot);
      const escalation = allSkills.find((s) => s.name === 'escalation');
      expect(escalation).toBeDefined();
      expect(escalation!.description).toBe('Custom escalation for this team');

      // Other common skills should still be present
      const names = allSkills.map((s) => s.name);
      expect(names).toContain('health-report');
      expect(names).toContain('memory-management');
    });

    it('should truncate body at 500 lines (CON-12)', async () => {
      // Create a skill with >500 lines
      const longSkillDir = path.join(tmpRoot, '.claude', 'skills', 'long-skill');
      fs.mkdirSync(longSkillDir, { recursive: true });

      const bodyLines = Array.from({ length: 600 }, (_, i) => `Line ${i + 1}: content here`);
      const content = [
        '---',
        'name: long-skill',
        'description: A skill with too many lines',
        '---',
        '',
        ...bodyLines,
      ].join('\n');

      fs.writeFileSync(path.join(longSkillDir, 'SKILL.md'), content);

      const loader = new SkillLoaderImpl({
        commonSkillsPath: tmpRoot + '/empty-common',
      });

      const skill = await loader.loadSkill(tmpRoot, 'long-skill');
      const loadedLines = skill.body.split('\n');
      expect(loadedLines.length).toBeLessThanOrEqual(500);
      // The first body line after frontmatter is empty, then "Line 1: ..."
      expect(loadedLines[loadedLines.length - 1]).toContain('Line');
    });

    it('should parse all frontmatter fields correctly', async () => {
      const skillDir = path.join(tmpRoot, '.claude', 'skills', 'full-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        [
          '---',
          'name: full-skill',
          'description: Skill with all frontmatter fields',
          'argument-hint: "<file_path> [--strict]"',
          'allowed-tools:',
          '  - Read',
          '  - Grep',
          'model: sonnet',
          'user-invocable: true',
          'disable-model-invocation: true',
          '---',
          '',
          '# Full Skill Body',
        ].join('\n'),
      );

      const loader = new SkillLoaderImpl({
        commonSkillsPath: tmpRoot + '/empty-common',
      });

      const skill = await loader.loadSkill(tmpRoot, 'full-skill');
      expect(skill.name).toBe('full-skill');
      expect(skill.description).toBe('Skill with all frontmatter fields');
      expect(skill.argumentHint).toBe('<file_path> [--strict]');
      expect(skill.allowedTools).toEqual(['Read', 'Grep']);
      expect(skill.model).toBe('sonnet');
      expect(skill.userInvocable).toBe(true);
      expect(skill.disableModelInvocation).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 7. SkillRegistry team-scoped isolation (INV-08)
  // -------------------------------------------------------------------------

  describe('SkillRegistry (INV-08)', () => {
    it('should isolate skills between teams', () => {
      const registry = new SkillRegistryImpl();

      registry.register('team-a', {
        name: 'custom-review',
        description: 'Team A code review',
        body: 'Review code for Team A standards',
      });

      registry.register('team-b', {
        name: 'custom-review',
        description: 'Team B code review',
        body: 'Review code for Team B standards',
      });

      const skillA = registry.get('team-a', 'custom-review');
      const skillB = registry.get('team-b', 'custom-review');

      expect(skillA!.description).toBe('Team A code review');
      expect(skillB!.description).toBe('Team B code review');
    });

    it('should return defensive copies from get()', () => {
      const registry = new SkillRegistryImpl();
      registry.register('my-team', {
        name: 'test-skill',
        description: 'Original',
        body: 'Body',
      });

      const copy1 = registry.get('my-team', 'test-skill');
      const copy2 = registry.get('my-team', 'test-skill');

      // Mutating one copy should not affect the other
      copy1!.description = 'Mutated';
      expect(copy2!.description).toBe('Original');
    });

    it('should shadow common skills with team skills in listForTeam()', () => {
      const registry = new SkillRegistryImpl();

      // Register common skill
      registry.register('__common__', {
        name: 'escalation',
        description: 'Common escalation skill',
        body: 'Default escalation behavior',
      });

      // Team override
      registry.register('my-team', {
        name: 'escalation',
        description: 'Custom escalation for my-team',
        body: 'Custom behavior',
      });

      const skills = registry.listForTeam('my-team');
      const escalation = skills.find((s) => s.name === 'escalation');
      expect(escalation).toBeDefined();
      expect(escalation!.description).toBe('Custom escalation for my-team');
    });

    it('should unregister team skill and fall back to common', () => {
      const registry = new SkillRegistryImpl();

      registry.register('__common__', {
        name: 'memory-management',
        description: 'Common memory management',
        body: 'Default memory behavior',
      });

      registry.register('my-team', {
        name: 'memory-management',
        description: 'Custom memory for my-team',
        body: 'Custom memory behavior',
      });

      // Team version visible
      let skill = registry.get('my-team', 'memory-management');
      expect(skill!.description).toBe('Custom memory for my-team');

      // Unregister team version
      registry.unregister('my-team', 'memory-management');

      // Common version should be visible again
      skill = registry.get('my-team', 'memory-management');
      expect(skill!.description).toBe('Common memory management');
    });
  });

  // -------------------------------------------------------------------------
  // 8. Integration wiring: full tool call flow
  // -------------------------------------------------------------------------

  describe('Integration wiring', () => {
    it('should execute full tool call flow: SDKToolHandler -> handler -> stores -> result', async () => {
      const ctx = createMockToolContext();
      const orgChart = ctx.orgChart as OrgChartImpl;
      const { mainAid, leadAid, memberAid, teamSlug } = setupOrgChart(orgChart);

      const events: BusEvent[] = [];
      (ctx.eventBus as EventBusImpl).subscribe((event) => events.push(event));

      const handler = new SDKToolHandler(ctx);

      // Step 1: Create a task (lead assigning to their team member)
      const createResult = await handler.handle(
        'create_task',
        { agent_aid: memberAid, prompt: 'Build the feature', priority: 3 },
        leadAid,
        'call-flow-1',
      );
      expect(createResult.success).toBe(true);
      const taskId = (createResult.result as Record<string, unknown>).task_id as string;
      expect(taskId).toBeTruthy();

      // Verify task was created in store
      expect(ctx.taskStore.create).toHaveBeenCalledWith(
        expect.objectContaining({
          id: taskId,
          agent_aid: memberAid,
          prompt: 'Build the feature',
          status: TaskStatus.Pending,
          priority: 3,
        }),
      );

      // Step 2: Save memory (member)
      const memResult = await handler.handle(
        'save_memory',
        { content: 'Figured out the API structure', memory_type: 'daily' },
        memberAid,
        'call-flow-2',
      );
      expect(memResult.success).toBe(true);
      expect(ctx.memoryStore.save).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_aid: memberAid,
          team_slug: teamSlug,
          content: 'Figured out the API structure',
          memory_type: 'daily',
        }),
      );

      // Step 3: Tool call logging happened for both calls
      expect(ctx.toolCallStore.create).toHaveBeenCalledTimes(2);

      // Step 4: Verify send_message between agents (member to their team lead)
      const sendResult = await handler.handle(
        'send_message',
        { target_aid: leadAid, content: 'Task complete' },
        memberAid,
        'call-flow-3',
      );
      expect(sendResult.success).toBe(true);
      expect(ctx.messageStore.create).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Task complete',
          role: 'agent',
        }),
      );

      // Step 5: Verify cross-branch messaging is denied
      const crossResult = await handler.handle(
        'send_message',
        { target_aid: mainAid, content: 'Should fail' },
        memberAid,
        'call-flow-4',
      );
      expect(crossResult.success).toBe(false);
      expect(crossResult.error_code).toBe(WSErrorCode.AccessDenied);
    });

    it('should verify all 25 tool schemas are defined', () => {
      const schemaKeys = Object.keys(TOOL_SCHEMAS);
      expect(schemaKeys).toHaveLength(25);

      // Verify critical tools are present
      const expectedTools = [
        'spawn_container', 'stop_container', 'list_containers',
        'create_team', 'create_agent',
        'create_task', 'dispatch_subtask', 'update_task_status',
        'send_message', 'escalate',
        'save_memory', 'recall_memory',
        'create_integration', 'test_integration', 'activate_integration',
        'get_credential', 'set_credential',
        'get_team', 'get_task', 'get_health', 'inspect_topology',
        'register_webhook', 'register_trigger',
      ];

      for (const tool of expectedTools) {
        expect(schemaKeys).toContain(tool);
      }
    });

    it('should verify createToolHandlers returns 25 handlers', () => {
      const ctx = createMockToolContext();
      setupOrgChart(ctx.orgChart as OrgChartImpl);

      const handlers = createToolHandlers(ctx);
      expect(handlers.size).toBe(25);
    });

    it('should wire MCPBridge round-trip with SDKToolHandler', async () => {
      const ctx = createMockToolContext();
      const { mainAid } = setupOrgChart(ctx.orgChart as OrgChartImpl);
      const sdkHandler = new SDKToolHandler(ctx);

      // Simulate the bridge sending a tool call, root handling it, and sending result back
      const sent: Record<string, unknown>[] = [];
      const sendFn = (msg: Record<string, unknown>) => sent.push(msg);
      const bridge = new MCPBridgeImpl(sendFn, createMockLogger());

      // Agent calls get_team through the bridge
      const resultPromise = bridge.callTool('get_team', { slug: 'test-team' }, mainAid);

      // Root receives the WS message and processes it through SDKToolHandler
      const wsMsg = sent[0];
      const data = wsMsg.data as Record<string, unknown>;
      const callId = data.call_id as string;
      const toolName = data.tool_name as string;
      const args = data.arguments as Record<string, unknown>;
      const agentAid = data.agent_aid as string;

      const handlerResult = await sdkHandler.handle(toolName, args, agentAid, callId);

      // Root sends result back over WS (simulated by calling handleResult)
      if (handlerResult.success) {
        bridge.handleResult(callId, handlerResult.result!);
      } else {
        bridge.handleError(callId, handlerResult.error_code!, handlerResult.error_message!);
      }

      // Agent receives the resolved result
      const result = await resultPromise;
      expect(result).toHaveProperty('slug', 'test-team');
      expect(result).toHaveProperty('tid');
      expect(bridge.getPendingCalls()).toBe(0);
    });
  });
});
