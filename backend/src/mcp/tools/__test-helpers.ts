/**
 * Shared test helpers for MCP tools tests.
 *
 * Provides mock factories for OrgChartAgent, OrgChartTeam, Task, and the
 * full ToolContext mock used across handler test suites.
 */

import { vi } from 'vitest';
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
} from '../../domain/index.js';
import {
  TaskStatus,
  AgentStatus,
  ContainerHealth,
  IntegrationStatus,
} from '../../domain/index.js';
import type { Task, Integration, Credential } from '../../domain/domain.js';

// ---------------------------------------------------------------------------
// Entity factories
// ---------------------------------------------------------------------------

export function makeAgent(overrides: Partial<OrgChartAgent> = {}): OrgChartAgent {
  return {
    aid: 'aid-alice-001',
    name: 'Alice',
    teamSlug: 'test-team',
    role: 'member',
    status: AgentStatus.Idle,
    ...overrides,
  };
}

export function makeTeam(overrides: Partial<OrgChartTeam> = {}): OrgChartTeam {
  return {
    tid: 'tid-test-001',
    slug: 'test-team',
    coordinatorAid: 'aid-alice-001',
    parentTid: '',
    depth: 0,
    containerId: 'cid-test',
    health: ContainerHealth.Running,
    agentAids: ['aid-alice-001'],
    workspacePath: '/app/workspace/teams/test-team',
    ...overrides,
  };
}

export function makeTask(overrides: Partial<Task> = {}): Task {
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

// ---------------------------------------------------------------------------
// Full ToolContext mock
// ---------------------------------------------------------------------------

export function createMockContext(): ToolContext {
  const orgChart: OrgChart = {
    addTeam: vi.fn(),
    updateTeam: vi.fn(),
    removeTeam: vi.fn(),
    getTeam: vi.fn(() => makeTeam()),
    getTeamBySlug: vi.fn((slug: string) => makeTeam({ slug })),
    listTeams: vi.fn(() => [makeTeam()]),
    getChildren: vi.fn(() => []),
    getParent: vi.fn(() => undefined),
    addAgent: vi.fn(),
    updateAgent: vi.fn(),
    removeAgent: vi.fn(),
    getAgent: vi.fn((aid: string) => makeAgent({ aid })),
    getAgentsByTeam: vi.fn(() => [makeAgent()]),
    isAuthorized: vi.fn(() => true),
    getTopology: vi.fn(() => []),
    updateTeamTid: vi.fn(),
    getDispatchTarget: vi.fn(() => makeAgent()),
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
    getRecentUserTasks: vi.fn(async () => []),
    getNextPendingForAgent: vi.fn(async () => null),
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
    createWithIds: vi.fn().mockResolvedValue([1]),
    query: vi.fn(async () => []),
    deleteBefore: vi.fn(async () => 0),
    deleteByLevelBefore: vi.fn(async () => 0),
    count: vi.fn(async () => 0),
    getOldest: vi.fn(async () => []),
  };

  const memoryStore: MemoryStore = {
    save: vi.fn(async () => 1),
    search: vi.fn(async () => []),
    getByAgent: vi.fn(async () => []),
    deleteBefore: vi.fn(async () => 0),
    softDeleteByAgent: vi.fn(async () => 0),
    softDeleteByTeam: vi.fn(async () => 0),
    purgeDeleted: vi.fn(async () => 0),
    searchBM25: vi.fn(async () => []),
    searchHybrid: vi.fn(async () => []),
    saveChunks: vi.fn(async () => undefined),
    getChunks: vi.fn(async () => []),
    deleteChunks: vi.fn(async () => undefined),
  };

  const integrationStore: IntegrationStore = {
    create: vi.fn(async () => {}),
    get: vi.fn(async (): Promise<Integration> => ({
      id: 'int-001',
      team_id: 'test-team',
      name: 'test-integration',
      config_path: '/app/workspace/integrations/test.yaml',
      status: IntegrationStatus.Proposed,
      error_message: '',
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
    restartTeamContainer: vi.fn(async () => ({ id: 'cid-1', name: 'openhive-test', state: 'running', teamSlug: 'test', tid: 'tid-test-new', health: 'running' as any, createdAt: Date.now() })),
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
    addAgentToTeamYaml: vi.fn(async () => {}),
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
    setReady: vi.fn(),
    isReady: vi.fn(() => true),
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
    checkTimeouts: vi.fn(),
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
    limits: Object.freeze({
      max_depth: 3,
      max_teams: 10,
      max_agents_per_team: 5,
      max_concurrent_tasks: 50,
    }),
  };
}
