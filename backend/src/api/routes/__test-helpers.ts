/**
 * Shared test helpers for API route tests.
 *
 * Provides MockRequest, MockReply, MockFastify, entity factories,
 * and mock service factories used across route test suites.
 */

import { vi } from 'vitest';
import type {
  OrgChart,
  ContainerManager,
  HealthMonitor,
  TaskStore,
  OrgChartAgent,
  OrgChartTeam,
  ContainerInfo,
  Task,
  IntegrationStore,
  ConfigLoader,
  EventBus,
  BusEvent,
  EventHandler,
  EventFilter,
} from '../../domain/index.js';
import type { Integration } from '../../domain/domain.js';
import { AgentStatus, ContainerHealth, IntegrationStatus } from '../../domain/enums.js';
import { NotFoundError } from '../../domain/errors.js';
import { defaultMasterConfig } from '../../config/defaults.js';

// ---------------------------------------------------------------------------
// Minimal Fastify mock — captures route handlers without starting a server
// ---------------------------------------------------------------------------

export type RouteHandler = (req: MockRequest, reply: MockReply) => Promise<void>;

export interface MockRequest {
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
  raw: { on: ReturnType<typeof vi.fn> };
}

export interface MockReply {
  code: (n: number) => MockReply;
  send: (body?: unknown) => MockReply;
  raw: { setHeader: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; writable: boolean };
  _status: number;
  _body: unknown;
}

export function makeMockReply(writable = true): MockReply {
  const reply: MockReply = {
    _status: 200,
    _body: undefined,
    raw: {
      setHeader: vi.fn(),
      write: vi.fn(),
      writable,
    },
    code(n: number) {
      this._status = n;
      return this;
    },
    send(body?: unknown) {
      this._body = body;
      return this;
    },
  };
  return reply;
}

export function makeMockRequest(overrides?: Partial<MockRequest>): MockRequest {
  return {
    params: {},
    query: {},
    body: {},
    raw: { on: vi.fn() },
    ...overrides,
  };
}

/** Minimal Fastify mock that stores handlers keyed by "METHOD /path". */
export class MockFastify {
  private readonly _routes = new Map<string, RouteHandler>();

  get(path: string, handler: RouteHandler): void {
    this._routes.set(`GET ${path}`, handler);
  }

  post(path: string, handler: RouteHandler): void {
    this._routes.set(`POST ${path}`, handler);
  }

  put(path: string, handler: RouteHandler): void {
    this._routes.set(`PUT ${path}`, handler);
  }

  patch(path: string, handler: RouteHandler): void {
    this._routes.set(`PATCH ${path}`, handler);
  }

  delete(path: string, handler: RouteHandler): void {
    this._routes.set(`DELETE ${path}`, handler);
  }

  async call(method: string, path: string, req?: Partial<MockRequest>): Promise<MockReply> {
    const key = `${method} ${path}`;
    const handler = this._routes.get(key);
    if (!handler) throw new Error(`No route registered for ${key}`);
    const request = makeMockRequest(req);
    const reply = makeMockReply();
    await handler(request, reply);
    return reply;
  }
}

// ---------------------------------------------------------------------------
// Mock domain services
// ---------------------------------------------------------------------------

export function makeAgent(overrides?: Partial<OrgChartAgent>): OrgChartAgent {
  return {
    aid: 'aid-alice-abc123',
    name: 'alice',
    teamSlug: 'weather-team',
    role: 'member',
    status: AgentStatus.Idle,
    ...overrides,
  };
}

export function makeTeam(overrides?: Partial<OrgChartTeam>): OrgChartTeam {
  return {
    tid: 'tid-weather-team-abc123',
    slug: 'weather-team',
    coordinatorAid: 'aid-lead-abc123',
    parentTid: '',
    depth: 1,
    containerId: 'cid-weather-team',
    health: ContainerHealth.Running,
    agentAids: ['aid-alice-abc123'],
    workspacePath: '/app/workspace/teams/weather-team',
    ...overrides,
  };
}

export function makeContainerInfo(slug: string, overrides?: Partial<ContainerInfo>): ContainerInfo {
  return {
    id: `cid-${slug}`,
    name: `openhive-${slug}`,
    state: 'running',
    teamSlug: slug,
    tid: `tid-${slug}-abc123`,
    health: ContainerHealth.Running,
    createdAt: Date.now() - 60_000, // 60s ago
    ...overrides,
  };
}

export function makeTask(slug: string, status: Task['status'] = 'active'): Task {
  return {
    id: `task-${Math.random().toString(36).slice(2)}`,
    parent_id: '',
    team_slug: slug,
    agent_aid: 'aid-alice-abc123',
    title: 'Some task',
    status,
    prompt: 'Do something',
    result: '',
    error: '',
    blocked_by: null,
    priority: 0,
    retry_count: 0,
    max_retries: 3,
    created_at: Date.now(),
    updated_at: Date.now(),
    completed_at: null,
  };
}

export function createMockOrgChart(): OrgChart {
  const agents = new Map<string, OrgChartAgent>();
  const teams = new Map<string, OrgChartTeam>();

  return {
    addTeam: vi.fn((t: OrgChartTeam) => { teams.set(t.slug, t); }),
    updateTeam: vi.fn(),
    removeTeam: vi.fn(),
    getTeam: vi.fn(),
    getTeamBySlug: vi.fn((slug: string) => teams.get(slug)),
    listTeams: vi.fn(() => [...teams.values()]),
    getChildren: vi.fn((_tid: string) => []),
    getParent: vi.fn(),
    addAgent: vi.fn((a: OrgChartAgent) => { agents.set(a.aid, a); }),
    updateAgent: vi.fn(),
    removeAgent: vi.fn(),
    getAgent: vi.fn(),
    getAgentsByTeam: vi.fn((teamSlug: string) =>
      [...agents.values()].filter((a) => a.teamSlug === teamSlug),
    ),
    isAuthorized: vi.fn(() => true),
    getTopology: vi.fn(() => []),
    updateTeamTid: vi.fn(),
    getDispatchTarget: vi.fn(),
  } as OrgChart;
}

export function createMockContainerManager(): ContainerManager & { getRestartCount: (slug: string) => number } {
  const restartCounts = new Map<string, number>();
  return {
    spawnTeamContainer: vi.fn(async () => makeContainerInfo('test-team')),
    stopTeamContainer: vi.fn(async () => {}),
    restartTeamContainer: vi.fn(async (slug: string) => {
      restartCounts.set(slug, (restartCounts.get(slug) ?? 0) + 1);
      return makeContainerInfo(slug);
    }),
    getContainerByTeam: vi.fn(async () => undefined),
    listRunningContainers: vi.fn(async () => []),
    cleanupStoppedContainers: vi.fn(async () => 0),
    getRestartCount: (slug: string) => restartCounts.get(slug) ?? 0,
  };
}

export function createMockHealthMonitor(): HealthMonitor {
  return {
    recordHeartbeat: vi.fn(),
    getHealth: vi.fn(() => ContainerHealth.Running),
    getAgentHealth: vi.fn(),
    getAllHealth: vi.fn(() => new Map()),
    getStuckAgents: vi.fn(() => []),
    checkTimeouts: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

export function createMockTaskStore(): TaskStore {
  return {
    create: vi.fn(async () => {}),
    get: vi.fn(async () => { throw new Error('not found'); }),
    update: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    listByTeam: vi.fn(async () => []),
    listByStatus: vi.fn(async () => []),
    getSubtree: vi.fn(async () => []),
    getBlockedBy: vi.fn(async () => []),
    unblockTask: vi.fn(async () => false),
    retryTask: vi.fn(async () => false),
    validateDependencies: vi.fn(async () => {}),
    getRecentUserTasks: vi.fn().mockResolvedValue([]),
    getNextPendingForAgent: vi.fn().mockResolvedValue(null),
  };
}

// ---------------------------------------------------------------------------
// Integration helpers
// ---------------------------------------------------------------------------

export function makeIntegration(overrides?: Partial<Integration>): Integration {
  return {
    id: `integ-${Math.random().toString(36).slice(2)}`,
    team_id: 'weather-team',
    name: 'github-webhook',
    config_path: 'integrations/github.yaml',
    status: IntegrationStatus.Active,
    error_message: '',
    created_at: Date.now(),
    ...overrides,
  };
}

export function createMockIntegrationStore(): IntegrationStore {
  const store = new Map<string, Integration>();
  return {
    create: vi.fn(async (i: Integration) => { store.set(i.id, i); }),
    get: vi.fn(async (id: string) => {
      const i = store.get(id);
      if (!i) throw new NotFoundError(`Integration not found: ${id}`);
      return i;
    }),
    update: vi.fn(async (i: Integration) => { store.set(i.id, i); }),
    delete: vi.fn(async (id: string) => { store.delete(id); }),
    listByTeam: vi.fn(async (teamId: string) =>
      [...store.values()].filter((i) => i.team_id === teamId),
    ),
    updateStatus: vi.fn(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// Config loader helpers
// ---------------------------------------------------------------------------

export function createMockConfigLoader(): ConfigLoader {
  const master = defaultMasterConfig();
  return {
    loadMaster: vi.fn(async () => master),
    saveMaster: vi.fn(async () => {}),
    getMaster: vi.fn(() => master),
    loadProviders: vi.fn(async () => ({})),
    saveProviders: vi.fn(async () => {}),
    loadTeam: vi.fn(async () => { throw new Error('not implemented'); }),
    saveTeam: vi.fn(async () => {}),
    createTeamDir: vi.fn(async () => {}),
    deleteTeamDir: vi.fn(async () => {}),
    listTeams: vi.fn(async () => []),
    watchMaster: vi.fn(),
    watchProviders: vi.fn(),
    watchTeam: vi.fn(),
    stopWatching: vi.fn(),
    getConfigWithSources: vi.fn(async () => ({
      'server.listen_address': { value: '127.0.0.1:8080', source: 'default' as const },
      'limits.max_depth': { value: 3, source: 'default' as const },
    })),
  };
}

// ---------------------------------------------------------------------------
// Event bus helpers
// ---------------------------------------------------------------------------

export function createMockEventBus(): EventBus {
  const handlers = new Map<string, { filter: EventFilter; handler: EventHandler }>();
  let idCounter = 0;

  return {
    publish: vi.fn((event: BusEvent) => {
      for (const { filter, handler } of handlers.values()) {
        if (filter(event)) {
          handler(event);
        }
      }
    }),
    subscribe: vi.fn((handler: EventHandler) => {
      const id = `sub-${++idCounter}`;
      handlers.set(id, { filter: () => true, handler });
      return id;
    }),
    filteredSubscribe: vi.fn((filter: EventFilter, handler: EventHandler) => {
      const id = `sub-${++idCounter}`;
      handlers.set(id, { filter, handler });
      return id;
    }),
    unsubscribe: vi.fn((id: string) => {
      handlers.delete(id);
    }),
    close: vi.fn(),
  };
}
