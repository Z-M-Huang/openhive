/**
 * Tests for SDKToolHandler + 22 tool handlers.
 *
 * Uses interface-first mock objects (vi.fn()) for all stores and managers.
 * Focuses on: handler logic, authorization rejection, error mapping,
 * state transitions, and dual-write for save_memory.
 *
 * @module mcp/tools/index.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SDKToolHandler,
  createToolHandlers,
  TOOL_NAMES,
  TOOL_COUNT,
  TOOL_SCHEMAS,
  resolveSecretsTemplate,
  resolveSecretsTemplatesInObject,
} from './index.js';
import type { ToolContext } from './index.js';
import type {
  OrgChart,
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
  EventBus,
  TriggerScheduler,
  MCPRegistry,
  HealthMonitor,
  Logger,
  OrgChartAgent,
  OrgChartTeam,
  ContainerInfo,
  MemoryEntry,
} from '../../domain/index.js';
import {
  TaskStatus,
  AgentStatus,
  ContainerHealth,
  IntegrationStatus,
  WSErrorCode,
} from '../../domain/index.js';
import type { Task, Integration, Credential } from '../../domain/domain.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<OrgChartAgent> = {}): OrgChartAgent {
  return {
    aid: 'aid-alice-001',
    name: 'Alice',
    teamSlug: 'test-team',
    role: 'team_lead',
    status: AgentStatus.Idle,
    ...overrides,
  };
}

function makeTeam(overrides: Partial<OrgChartTeam> = {}): OrgChartTeam {
  return {
    tid: 'tid-test-001',
    slug: 'test-team',
    leaderAid: 'aid-alice-001',
    parentTid: '',
    depth: 0,
    containerId: 'cid-test',
    health: ContainerHealth.Running,
    agentAids: ['aid-alice-001'],
    workspacePath: '/app/workspace/teams/test-team',
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-001',
    parent_id: '',
    team_slug: 'test-team',
    agent_aid: 'aid-alice-001',
    title: 'Test task',
    status: TaskStatus.Active,
    prompt: 'Do something',
    result: '',
    error: '',
    blocked_by: null,
    priority: 0,
    retry_count: 0,
    max_retries: 0,
    created_at: Date.now(),
    updated_at: Date.now(),
    completed_at: null,
    ...overrides,
  };
}

function createMockContext(): ToolContext {
  const orgChart: OrgChart = {
    addTeam: vi.fn(),
    removeTeam: vi.fn(),
    getTeam: vi.fn(() => makeTeam()),
    getTeamBySlug: vi.fn((slug: string) => makeTeam({ slug })),
    listTeams: vi.fn(() => [makeTeam()]),
    getChildren: vi.fn(() => []),
    getParent: vi.fn(() => undefined),
    addAgent: vi.fn(),
    removeAgent: vi.fn(),
    getAgent: vi.fn((aid: string) => makeAgent({ aid })),
    getAgentsByTeam: vi.fn(() => [makeAgent()]),
    getLeadOf: vi.fn(() => makeAgent()),
    isAuthorized: vi.fn(() => true),
    getTopology: vi.fn(() => []),
  };

  const taskStore: TaskStore = {
    create: vi.fn(async () => {}),
    get: vi.fn(async () => makeTask()),
    update: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    listByTeam: vi.fn(async () => []),
    listByStatus: vi.fn(async () => []),
    getSubtree: vi.fn(async () => []),
    getBlockedBy: vi.fn(async () => []),
    unblockTask: vi.fn(async () => false),
    retryTask: vi.fn(async () => false),
    validateDependencies: vi.fn(async () => {}),
  };

  const messageStore: MessageStore = {
    create: vi.fn(async () => {}),
    getByChat: vi.fn(async () => []),
    getLatest: vi.fn(async () => []),
    deleteByChat: vi.fn(async () => {}),
    deleteBefore: vi.fn(async () => 0),
  };

  const logStore: LogStore = {
    create: vi.fn(async () => {}),
    query: vi.fn(async () => []),
    deleteBefore: vi.fn(async () => 0),
    deleteByLevelBefore: vi.fn(async () => 0),
    count: vi.fn(async () => 0),
    getOldest: vi.fn(async () => []),
  };

  const memoryStore: MemoryStore = {
    save: vi.fn(async () => {}),
    search: vi.fn(async () => []),
    getByAgent: vi.fn(async () => []),
    deleteBefore: vi.fn(async () => 0),
    softDeleteByAgent: vi.fn(async () => 0),
    softDeleteByTeam: vi.fn(async () => 0),
    purgeDeleted: vi.fn(async () => 0),
  };

  const integrationStore: IntegrationStore = {
    create: vi.fn(async () => {}),
    get: vi.fn(async (): Promise<Integration> => ({
      id: 'int-001',
      team_id: 'test-team',
      name: 'test-integration',
      config_path: '/app/workspace/integrations/test.yaml',
      status: IntegrationStatus.Proposed,
      created_at: Date.now(),
    })),
    update: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    listByTeam: vi.fn(async () => []),
    updateStatus: vi.fn(async () => {}),
  };

  const credentialStore: CredentialStore = {
    create: vi.fn(async () => {}),
    get: vi.fn(async (): Promise<Credential> => ({
      id: 'cred-001',
      name: 'api-key',
      encrypted_value: 'encrypted:abc',
      team_id: 'test-team',
      created_at: Date.now(),
    })),
    update: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    listByTeam: vi.fn(async (): Promise<Credential[]> => [{
      id: 'cred-001',
      name: 'api-key',
      encrypted_value: 'encrypted:abc',
      team_id: 'test-team',
      created_at: Date.now(),
    }]),
  };

  const toolCallStore: ToolCallStore = {
    create: vi.fn(async () => {}),
    getByTask: vi.fn(async () => []),
    getByAgent: vi.fn(async () => []),
    getByToolName: vi.fn(async () => []),
  };

  const containerManager: ContainerManager = {
    spawnTeamContainer: vi.fn(async (slug: string): Promise<ContainerInfo> => ({
      id: `cid-${slug}`,
      name: `openhive-${slug}`,
      state: 'running',
      teamSlug: slug,
      tid: `tid-${slug}-abc123`,
      health: ContainerHealth.Running,
      createdAt: Date.now(),
    })),
    stopTeamContainer: vi.fn(async () => {}),
    restartTeamContainer: vi.fn(async () => {}),
    getContainerByTeam: vi.fn(async () => undefined),
    listRunningContainers: vi.fn(async (): Promise<ContainerInfo[]> => [{
      id: 'cid-alpha',
      name: 'openhive-alpha',
      state: 'running',
      teamSlug: 'alpha',
      tid: 'tid-alpha-001',
      health: ContainerHealth.Running,
      createdAt: Date.now(),
    }]),
    cleanupStoppedContainers: vi.fn(async () => 0),
  };

  const provisioner: ContainerProvisioner = {
    scaffoldWorkspace: vi.fn(async (_parent: string, slug: string) => `/app/workspace/teams/${slug}`),
    writeTeamConfig: vi.fn(async () => {}),
    writeAgentDefinition: vi.fn(async () => {}),
    writeSettings: vi.fn(async () => {}),
    deleteWorkspace: vi.fn(async () => {}),
    archiveWorkspace: vi.fn(async () => {}),
  };

  const keyManager: KeyManager = {
    unlock: vi.fn(async () => {}),
    lock: vi.fn(async () => {}),
    rekey: vi.fn(async () => 0),
    encrypt: vi.fn(async (text: string) => `encrypted:${text}`),
    decrypt: vi.fn(async (text: string) => text.replace('encrypted:', '')),
    isUnlocked: vi.fn(() => true),
  };

  const wsHub: WSHub = {
    handleUpgrade: vi.fn(),
    send: vi.fn(),
    broadcast: vi.fn(),
    isConnected: vi.fn(() => true),
    getConnectedTeams: vi.fn(() => []),
    close: vi.fn(async () => {}),
  };

  const eventBus: EventBus = {
    publish: vi.fn(),
    subscribe: vi.fn(() => 'sub-001'),
    filteredSubscribe: vi.fn(() => 'sub-002'),
    unsubscribe: vi.fn(),
    close: vi.fn(),
  };

  const triggerScheduler: TriggerScheduler = {
    loadTriggers: vi.fn(async () => {}),
    addCronTrigger: vi.fn(),
    removeTrigger: vi.fn(),
    listTriggers: vi.fn(() => []),
    start: vi.fn(),
    stop: vi.fn(),
  };

  const mcpRegistry: MCPRegistry = {
    registerTool: vi.fn(),
    unregisterTool: vi.fn(),
    getTool: vi.fn(() => undefined),
    listTools: vi.fn(() => []),
    getToolsForRole: vi.fn(() => []),
    isAllowed: vi.fn(() => true),
  };

  const healthMonitor: HealthMonitor = {
    recordHeartbeat: vi.fn(),
    getHealth: vi.fn(() => ContainerHealth.Running),
    getAgentHealth: vi.fn(() => AgentStatus.Idle),
    getAllHealth: vi.fn(() => new Map([['tid-test-001', ContainerHealth.Running]])),
    getStuckAgents: vi.fn(() => []),
    start: vi.fn(),
    stop: vi.fn(),
  };

  const logger: Logger = {
    log: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    audit: vi.fn(),
    flush: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };

  return {
    orgChart,
    taskStore,
    messageStore,
    logStore,
    memoryStore,
    integrationStore,
    credentialStore,
    toolCallStore,
    containerManager,
    provisioner,
    keyManager,
    wsHub,
    eventBus,
    triggerScheduler,
    mcpRegistry,
    healthMonitor,
    logger,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createToolHandlers', () => {
  it('creates a Map with 22 handlers', () => {
    const ctx = createMockContext();
    const handlers = createToolHandlers(ctx);
    expect(handlers.size).toBe(22);
  });

  it('all TOOL_NAMES have entries in TOOL_SCHEMAS', () => {
    for (const name of TOOL_NAMES) {
      expect(TOOL_SCHEMAS[name]).toBeDefined();
    }
  });

  it('TOOL_COUNT equals 22', () => {
    expect(TOOL_COUNT).toBe(22);
  });
});

describe('SDKToolHandler', () => {
  let ctx: ToolContext;
  let handler: SDKToolHandler;

  beforeEach(() => {
    ctx = createMockContext();
    handler = new SDKToolHandler(ctx);
  });

  // -----------------------------------------------------------------------
  // Authorization
  // -----------------------------------------------------------------------

  describe('authorization', () => {
    it('rejects when MCPRegistry.isAllowed returns false', async () => {
      vi.mocked(ctx.mcpRegistry.isAllowed).mockReturnValue(false);

      const result = await handler.handle(
        'spawn_container',
        { team_slug: 'alpha' },
        'aid-bob-001',
        'call-001',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.AccessDenied);
      expect(result.error_message).toContain('not authorized');
    });

    it('allows when MCPRegistry.isAllowed returns true', async () => {
      vi.mocked(ctx.mcpRegistry.isAllowed).mockReturnValue(true);

      const result = await handler.handle(
        'list_containers',
        {},
        'aid-alice-001',
        'call-002',
      );

      expect(result.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Container tools
  // -----------------------------------------------------------------------

  describe('spawn_container', () => {
    it('calls containerManager.spawnTeamContainer and returns result', async () => {
      const result = await handler.handle(
        'spawn_container',
        { team_slug: 'alpha' },
        'aid-alice-001',
        'call-003',
      );

      expect(result.success).toBe(true);
      expect(result.result?.container_id).toBe('cid-alpha');
      expect(result.result?.connected).toBe(true);
      expect(ctx.containerManager.spawnTeamContainer).toHaveBeenCalledWith('alpha');
    });
  });

  describe('stop_container', () => {
    it('calls containerManager.stopTeamContainer', async () => {
      const result = await handler.handle(
        'stop_container',
        { team_slug: 'beta' },
        'aid-alice-001',
        'call-004',
      );

      expect(result.success).toBe(true);
      expect(result.result?.final_status).toBe('stopped');
      expect(ctx.containerManager.stopTeamContainer).toHaveBeenCalledWith('beta', 'Tool: stop_container');
    });
  });

  describe('list_containers', () => {
    it('returns running containers', async () => {
      const result = await handler.handle(
        'list_containers',
        {},
        'aid-alice-001',
        'call-005',
      );

      expect(result.success).toBe(true);
      const containers = (result.result as Record<string, unknown>)['containers'] as unknown[];
      expect(containers).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Task tools
  // -----------------------------------------------------------------------

  describe('create_task', () => {
    it('creates task and returns task_id', async () => {
      const result = await handler.handle(
        'create_task',
        { agent_aid: 'aid-alice-001', prompt: 'Do something useful' },
        'aid-alice-001',
        'call-010',
      );

      expect(result.success).toBe(true);
      expect(result.result?.task_id).toBeDefined();
      expect(typeof result.result?.task_id).toBe('string');
      expect(ctx.taskStore.create).toHaveBeenCalledOnce();
    });

    it('validates dependencies when blocked_by is provided', async () => {
      const result = await handler.handle(
        'create_task',
        { agent_aid: 'aid-alice-001', prompt: 'Depends on task-x', blocked_by: ['task-x'] },
        'aid-alice-001',
        'call-011',
      );

      expect(result.success).toBe(true);
      expect(ctx.taskStore.validateDependencies).toHaveBeenCalled();
    });
  });

  describe('update_task_status', () => {
    it('validates state transition and updates task', async () => {
      // active -> completed is valid
      vi.mocked(ctx.taskStore.get).mockResolvedValue(makeTask({ status: TaskStatus.Active }));

      const result = await handler.handle(
        'update_task_status',
        { task_id: 'task-001', status: 'completed', result: 'Done!' },
        'aid-alice-001',
        'call-012',
      );

      expect(result.success).toBe(true);
      expect(result.result?.status).toBe('completed');
      expect(ctx.taskStore.update).toHaveBeenCalledOnce();
    });

    it('rejects invalid state transition', async () => {
      // completed -> active is invalid
      vi.mocked(ctx.taskStore.get).mockResolvedValue(makeTask({ status: TaskStatus.Completed }));

      const result = await handler.handle(
        'update_task_status',
        { task_id: 'task-001', status: 'active' },
        'aid-alice-001',
        'call-013',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.ValidationError);
      expect(result.error_message).toContain('Invalid task state transition');
    });
  });

  describe('dispatch_subtask', () => {
    it('creates subtask with parent_task_id', async () => {
      const result = await handler.handle(
        'dispatch_subtask',
        {
          agent_aid: 'aid-alice-001',
          prompt: 'Sub-work',
          parent_task_id: 'task-001',
        },
        'aid-alice-001',
        'call-014',
      );

      expect(result.success).toBe(true);
      expect(result.result?.task_id).toBeDefined();
      expect(ctx.taskStore.get).toHaveBeenCalledWith('task-001');
    });
  });

  // -----------------------------------------------------------------------
  // Memory tools (dual-write)
  // -----------------------------------------------------------------------

  describe('save_memory', () => {
    it('dual-writes: calls memoryStore.save', async () => {
      const result = await handler.handle(
        'save_memory',
        { content: 'Important fact', memory_type: 'curated' },
        'aid-alice-001',
        'call-020',
      );

      expect(result.success).toBe(true);
      expect(result.result?.status).toBe('saved');
      expect(result.result?.memory_id).toBeDefined();
      expect(ctx.memoryStore.save).toHaveBeenCalledOnce();

      // Verify the save call has the right agent_aid
      const savedEntry = vi.mocked(ctx.memoryStore.save).mock.calls[0][0];
      expect(savedEntry.agent_aid).toBe('aid-alice-001');
      expect(savedEntry.content).toBe('Important fact');
      expect(savedEntry.memory_type).toBe('curated');
    });
  });

  describe('recall_memory', () => {
    it('searches memoryStore with agent AID', async () => {
      const mockMemory: MemoryEntry = {
        id: 1,
        agent_aid: 'aid-alice-001',
        team_slug: 'test-team',
        content: 'Remembered fact',
        memory_type: 'curated',
        created_at: Date.now(),
        deleted_at: null,
      };
      vi.mocked(ctx.memoryStore.search).mockResolvedValue([mockMemory]);

      const result = await handler.handle(
        'recall_memory',
        { query: 'fact' },
        'aid-alice-001',
        'call-021',
      );

      expect(result.success).toBe(true);
      const memories = (result.result as Record<string, unknown>)['memories'] as unknown[];
      expect(memories).toHaveLength(1);
      expect(ctx.memoryStore.search).toHaveBeenCalledWith(
        expect.objectContaining({ agentAid: 'aid-alice-001', query: 'fact' }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Messaging
  // -----------------------------------------------------------------------

  describe('send_message', () => {
    it('stores message and sends via WS', async () => {
      const result = await handler.handle(
        'send_message',
        { target_aid: 'aid-bob-002', content: 'Hello!' },
        'aid-alice-001',
        'call-030',
      );

      expect(result.success).toBe(true);
      expect(result.result?.delivered).toBe(true);
      expect(ctx.messageStore.create).toHaveBeenCalledOnce();
      expect(ctx.wsHub.send).toHaveBeenCalled();
    });

    it('returns error for unknown target agent', async () => {
      vi.mocked(ctx.orgChart.getAgent).mockImplementation((aid: string) => {
        if (aid === 'aid-alice-001') return makeAgent();
        return undefined;
      });

      const result = await handler.handle(
        'send_message',
        { target_aid: 'aid-nonexistent-999', content: 'Hello?' },
        'aid-alice-001',
        'call-031',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.NotFound);
    });
  });

  // -----------------------------------------------------------------------
  // Escalation
  // -----------------------------------------------------------------------

  describe('escalate', () => {
    it('transitions task to escalated and publishes event', async () => {
      vi.mocked(ctx.taskStore.get).mockResolvedValue(makeTask({ status: TaskStatus.Active }));

      const result = await handler.handle(
        'escalate',
        { task_id: 'task-001', reason: 'need_guidance', context: { detail: 'stuck' } },
        'aid-alice-001',
        'call-040',
      );

      expect(result.success).toBe(true);
      expect(result.result?.correlation_id).toBeDefined();
      expect(ctx.taskStore.update).toHaveBeenCalledOnce();
      expect(ctx.eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task.escalated' }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Integration tools
  // -----------------------------------------------------------------------

  describe('create_integration', () => {
    it('creates integration in proposed state', async () => {
      const result = await handler.handle(
        'create_integration',
        { name: 'slack-bot', type: 'slack', config: { token: 'xxx' } },
        'aid-alice-001',
        'call-050',
      );

      expect(result.success).toBe(true);
      expect(result.result?.integration_id).toBeDefined();
      expect(result.result?.config_path).toContain('slack-bot');
      expect(ctx.integrationStore.create).toHaveBeenCalledOnce();
    });
  });

  describe('test_integration', () => {
    it('transitions proposed integration to tested', async () => {
      const result = await handler.handle(
        'test_integration',
        { integration_id: 'int-001' },
        'aid-alice-001',
        'call-051',
      );

      expect(result.success).toBe(true);
      expect(result.result?.success).toBe(true);
      expect(ctx.integrationStore.updateStatus).toHaveBeenCalledWith('int-001', IntegrationStatus.Tested);
    });

    it('rejects testing an already active integration', async () => {
      vi.mocked(ctx.integrationStore.get).mockResolvedValue({
        id: 'int-001',
        team_id: 'test-team',
        name: 'test',
        config_path: '/path',
        status: IntegrationStatus.Active,
        created_at: Date.now(),
      });

      const result = await handler.handle(
        'test_integration',
        { integration_id: 'int-001' },
        'aid-alice-001',
        'call-052',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.ValidationError);
    });
  });

  describe('activate_integration', () => {
    it('transitions tested integration to active', async () => {
      vi.mocked(ctx.integrationStore.get).mockResolvedValue({
        id: 'int-001',
        team_id: 'test-team',
        name: 'test',
        config_path: '/path',
        status: IntegrationStatus.Tested,
        created_at: Date.now(),
      });

      const result = await handler.handle(
        'activate_integration',
        { integration_id: 'int-001' },
        'aid-alice-001',
        'call-053',
      );

      expect(result.success).toBe(true);
      expect(result.result?.status).toBe(IntegrationStatus.Active);
    });
  });

  // -----------------------------------------------------------------------
  // Credential tools
  // -----------------------------------------------------------------------

  describe('get_credential', () => {
    it('decrypts and returns credential value', async () => {
      const result = await handler.handle(
        'get_credential',
        { key: 'api-key' },
        'aid-alice-001',
        'call-060',
      );

      expect(result.success).toBe(true);
      expect(result.result?.value).toBe('abc');
      expect(ctx.keyManager.decrypt).toHaveBeenCalledWith('encrypted:abc');
    });

    it('returns NOT_FOUND for missing credential', async () => {
      vi.mocked(ctx.credentialStore.listByTeam).mockResolvedValue([]);

      const result = await handler.handle(
        'get_credential',
        { key: 'missing-key' },
        'aid-alice-001',
        'call-061',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.NotFound);
    });
  });

  describe('set_credential', () => {
    it('encrypts and stores credential', async () => {
      const result = await handler.handle(
        'set_credential',
        { key: 'secret', value: 'my-secret' },
        'aid-alice-001',
        'call-062',
      );

      expect(result.success).toBe(true);
      expect(ctx.keyManager.encrypt).toHaveBeenCalledWith('my-secret');
      expect(ctx.credentialStore.create).toHaveBeenCalledOnce();
    });
  });

  // -----------------------------------------------------------------------
  // Query tools
  // -----------------------------------------------------------------------

  describe('get_team', () => {
    it('returns team info from org chart', async () => {
      const result = await handler.handle(
        'get_team',
        { slug: 'test-team' },
        'aid-alice-001',
        'call-070',
      );

      expect(result.success).toBe(true);
      expect(result.result?.slug).toBe('test-team');
      expect(result.result?.tid).toBe('tid-test-001');
    });

    it('returns NOT_FOUND for unknown team', async () => {
      vi.mocked(ctx.orgChart.getTeamBySlug).mockReturnValue(undefined);

      const result = await handler.handle(
        'get_team',
        { slug: 'nonexistent' },
        'aid-alice-001',
        'call-071',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.NotFound);
    });
  });

  describe('get_task', () => {
    it('returns task info', async () => {
      const result = await handler.handle(
        'get_task',
        { task_id: 'task-001' },
        'aid-alice-001',
        'call-072',
      );

      expect(result.success).toBe(true);
      expect(result.result?.task_id).toBe('task-001');
      expect(result.result?.status).toBe(TaskStatus.Active);
    });
  });

  describe('get_health', () => {
    it('returns system-wide health without scope', async () => {
      const result = await handler.handle(
        'get_health',
        {},
        'aid-alice-001',
        'call-073',
      );

      expect(result.success).toBe(true);
      const entries = (result.result as Record<string, unknown>)['entries'] as unknown[];
      expect(entries.length).toBeGreaterThan(0);
    });
  });

  describe('inspect_topology', () => {
    it('returns topology tree', async () => {
      const result = await handler.handle(
        'inspect_topology',
        {},
        'aid-alice-001',
        'call-074',
      );

      expect(result.success).toBe(true);
      expect(result.result?.tree).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Team tools
  // -----------------------------------------------------------------------

  describe('create_team', () => {
    it('scaffolds workspace, adds to org chart, publishes event', async () => {
      const result = await handler.handle(
        'create_team',
        { slug: 'new-team', leader_aid: 'aid-alice-001', purpose: 'Testing' },
        'aid-alice-001',
        'call-080',
      );

      expect(result.success).toBe(true);
      expect(result.result?.slug).toBe('new-team');
      expect(ctx.provisioner.scaffoldWorkspace).toHaveBeenCalled();
      expect(ctx.orgChart.addTeam).toHaveBeenCalled();
      expect(ctx.eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'team.created' }),
      );
    });
  });

  describe('create_agent', () => {
    it('writes agent definition and registers in org chart', async () => {
      const result = await handler.handle(
        'create_agent',
        { name: 'bob', description: 'A helper', team_slug: 'test-team' },
        'aid-alice-001',
        'call-081',
      );

      expect(result.success).toBe(true);
      expect(result.result?.aid).toBeDefined();
      expect((result.result?.aid as string).startsWith('aid-')).toBe(true);
      expect(ctx.provisioner.writeAgentDefinition).toHaveBeenCalled();
      expect(ctx.orgChart.addAgent).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Webhook
  // -----------------------------------------------------------------------

  describe('register_webhook', () => {
    it('publishes webhook.registered event and returns URL', async () => {
      const result = await handler.handle(
        'register_webhook',
        { path: 'deploy', target_team: 'ops-team' },
        'aid-alice-001',
        'call-090',
      );

      expect(result.success).toBe(true);
      expect(result.result?.webhook_url).toBe('/api/v1/hooks/deploy');
      expect(result.result?.registration_id).toBeDefined();
      expect(ctx.eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'webhook.registered' }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Error mapping
  // -----------------------------------------------------------------------

  describe('error mapping', () => {
    it('maps DomainError to appropriate WSErrorCode', async () => {
      vi.mocked(ctx.taskStore.get).mockRejectedValue(
        new (await import('../../domain/errors.js')).NotFoundError('Task not found'),
      );

      const result = await handler.handle(
        'get_task',
        { task_id: 'nonexistent' },
        'aid-alice-001',
        'call-100',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.NotFound);
    });

    it('maps non-DomainError to INTERNAL_ERROR', async () => {
      vi.mocked(ctx.taskStore.get).mockRejectedValue(new Error('DB exploded'));

      const result = await handler.handle(
        'get_task',
        { task_id: 'task-001' },
        'aid-alice-001',
        'call-101',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.InternalError);
    });
  });

  // -----------------------------------------------------------------------
  // Tool call logging
  // -----------------------------------------------------------------------

  describe('logging', () => {
    it('logs successful tool call to toolCallStore', async () => {
      await handler.handle(
        'list_containers',
        {},
        'aid-alice-001',
        'call-110',
      );

      expect(ctx.toolCallStore.create).toHaveBeenCalledOnce();
      const logged = vi.mocked(ctx.toolCallStore.create).mock.calls[0][0];
      expect(logged.tool_use_id).toBe('call-110');
      expect(logged.tool_name).toBe('list_containers');
      expect(logged.error).toBe('');
    });

    it('logs failed tool call with error message', async () => {
      vi.mocked(ctx.mcpRegistry.isAllowed).mockReturnValue(false);

      await handler.handle(
        'spawn_container',
        { team_slug: 'x' },
        'aid-bob-001',
        'call-111',
      );

      expect(ctx.toolCallStore.create).toHaveBeenCalledOnce();
      const logged = vi.mocked(ctx.toolCallStore.create).mock.calls[0][0];
      expect(logged.error).toContain('not authorized');
    });
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  describe('validation', () => {
    it('rejects missing required fields', async () => {
      const result = await handler.handle(
        'create_task',
        { agent_aid: 'aid-alice-001' }, // missing 'prompt'
        'aid-alice-001',
        'call-120',
      );

      expect(result.success).toBe(false);
      // Zod validation failures map to INTERNAL_ERROR (not DomainError)
      expect(result.error_code).toBeDefined();
    });

    it('rejects unknown tool name', async () => {
      const result = await handler.handle(
        'nonexistent_tool',
        {},
        'aid-alice-001',
        'call-121',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.NotFound);
    });
  });
});

// -----------------------------------------------------------------------
// Secrets template resolution (AC-L6-11)
// ---------------------------------------------------------------------------

describe('resolveSecretsTemplate', () => {
  it('resolves {secrets.KEY} placeholders', () => {
    const secrets = { VAR1: 'value_abc', VAR2: 'value_xyz' };
    const result = resolveSecretsTemplate('url?a={secrets.VAR1}&b={secrets.VAR2}', secrets);
    expect(result).toBe('url?a=value_abc&b=value_xyz');
  });

  it('leaves unresolved placeholders unchanged', () => {
    const secrets = { VAR1: 'value1' };
    const result = resolveSecretsTemplate('{secrets.VAR1} and {secrets.MISSING}', secrets);
    expect(result).toBe('value1 and {secrets.MISSING}');
  });

  it('returns unchanged string when no placeholders', () => {
    const secrets = { VAR1: 'value1' };
    const result = resolveSecretsTemplate('no placeholders here', secrets);
    expect(result).toBe('no placeholders here');
  });

  it('handles empty secrets object', () => {
    const result = resolveSecretsTemplate('{secrets.VAR1}', {});
    expect(result).toBe('{secrets.VAR1}');
  });

  it('handles multiple occurrences of same key', () => {
    const secrets = { KEY: 'value' };
    const result = resolveSecretsTemplate('{secrets.KEY}-{secrets.KEY}', secrets);
    expect(result).toBe('value-value');
  });
});

describe('resolveSecretsTemplatesInObject', () => {
  it('resolves templates in string values', () => {
    const secrets = { HOST: 'example.com', PORT: '8080' };
    const obj = { url: 'https://{secrets.HOST}:{secrets.PORT}' };
    const result = resolveSecretsTemplatesInObject(obj, secrets);
    expect(result).toEqual({ url: 'https://example.com:8080' });
  });

  it('recursively resolves in nested objects', () => {
    const secrets = { KEY: 'value1' };
    const obj = { level1: { level2: { value: '{secrets.KEY}' } } };
    const result = resolveSecretsTemplatesInObject(obj, secrets);
    expect(result).toEqual({ level1: { level2: { value: 'value1' } } });
  });

  it('resolves templates in arrays', () => {
    const secrets = { ITEM: 'replaced' };
    const obj = { items: ['{secrets.ITEM}', 'static', '{secrets.ITEM}'] };
    const result = resolveSecretsTemplatesInObject(obj, secrets);
    expect(result).toEqual({ items: ['replaced', 'static', 'replaced'] });
  });

  it('preserves non-string types', () => {
    const secrets = { KEY: 'value' };
    const obj = { num: 42, bool: true, nil: null, str: '{secrets.KEY}' };
    const result = resolveSecretsTemplatesInObject(obj, secrets);
    expect(result).toEqual({ num: 42, bool: true, nil: null, str: 'value' });
  });

  it('handles null and undefined values', () => {
    const secrets = { KEY: 'value' };
    const obj = { a: null, b: undefined };
    const result = resolveSecretsTemplatesInObject(obj, secrets);
    expect(result).toEqual({ a: null, b: undefined });
  });
});

// ---------------------------------------------------------------------------
// Hierarchy authorization tests (AC-L6-04)
// ---------------------------------------------------------------------------

describe('SDKToolHandler hierarchy authorization', () => {
  let ctx: ToolContext;
  let handler: SDKToolHandler;

  beforeEach(() => {
    ctx = createMockContext();
    handler = new SDKToolHandler(ctx);
  });

  describe('create_task with hierarchy check', () => {
    it('allows when authorized for target agent', async () => {
      vi.mocked(ctx.orgChart.isAuthorized).mockReturnValue(true);

      const result = await handler.handle(
        'create_task',
        { agent_aid: 'aid-bob-002', prompt: 'Do work' },
        'aid-alice-001',
        'call-h1',
      );

      expect(result.success).toBe(true);
      expect(ctx.orgChart.isAuthorized).toHaveBeenCalledWith('aid-alice-001', 'aid-bob-002');
    });

    it('rejects when not authorized for target agent', async () => {
      vi.mocked(ctx.orgChart.isAuthorized).mockReturnValue(false);

      const result = await handler.handle(
        'create_task',
        { agent_aid: 'aid-charlie-003', prompt: 'Do work' },
        'aid-alice-001',
        'call-h2',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.AccessDenied);
      expect(result.error_message).toContain('not authorized');
    });
  });

  describe('send_message with hierarchy check', () => {
    it('checks authorization for target_aid', async () => {
      vi.mocked(ctx.orgChart.isAuthorized).mockReturnValue(true);

      await handler.handle(
        'send_message',
        { target_aid: 'aid-bob-002', content: 'Hello' },
        'aid-alice-001',
        'call-h3',
      );

      expect(ctx.orgChart.isAuthorized).toHaveBeenCalledWith('aid-alice-001', 'aid-bob-002');
    });
  });

  describe('escalate with hierarchy check', () => {
    it('checks authorization for target_aid', async () => {
      vi.mocked(ctx.taskStore.get).mockResolvedValue(makeTask({ status: TaskStatus.Active }));
      vi.mocked(ctx.orgChart.isAuthorized).mockReturnValue(true);

      await handler.handle(
        'escalate',
        { task_id: 'task-001', target_aid: 'aid-lead-002', reason: 'need_guidance', context: {} },
        'aid-member-003',
        'call-h4',
      );

      expect(ctx.orgChart.isAuthorized).toHaveBeenCalledWith('aid-member-003', 'aid-lead-002');
    });
  });
});
