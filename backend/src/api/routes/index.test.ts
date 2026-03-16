/**
 * Tests for REST API routes: GET /api/agents, GET /api/containers, POST /api/containers/:slug/restart.
 *
 * Uses a minimal Fastify-mock approach: captures route handlers registered via app.get/app.post
 * and invokes them with mock FastifyRequest / FastifyReply doubles.
 *
 * @module api/routes/index.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { registerRoutes, resetSseStateForTest, type RouteContext } from './index.js';
import { defaultMasterConfig } from '../../config/defaults.js';

// ---------------------------------------------------------------------------
// Minimal Fastify mock — captures route handlers without starting a server
// ---------------------------------------------------------------------------

type RouteHandler = (req: MockRequest, reply: MockReply) => Promise<void>;

interface MockRequest {
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
  raw: { on: ReturnType<typeof vi.fn> };
}

interface MockReply {
  code: (n: number) => MockReply;
  send: (body?: unknown) => MockReply;
  raw: { setHeader: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; writable: boolean };
  _status: number;
  _body: unknown;
}

function makeMockReply(writable = true): MockReply {
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

function makeMockRequest(overrides?: Partial<MockRequest>): MockRequest {
  return {
    params: {},
    query: {},
    body: {},
    raw: { on: vi.fn() },
    ...overrides,
  };
}

/** Minimal Fastify mock that stores handlers keyed by "METHOD /path". */
class MockFastify {
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

function makeAgent(overrides?: Partial<OrgChartAgent>): OrgChartAgent {
  return {
    aid: 'aid-alice-abc123',
    name: 'alice',
    teamSlug: 'weather-team',
    role: 'member',
    status: AgentStatus.Idle,
    leadsTeam: undefined,
    ...overrides,
  };
}

function makeTeam(overrides?: Partial<OrgChartTeam>): OrgChartTeam {
  return {
    tid: 'tid-weather-team-abc123',
    slug: 'weather-team',
    leaderAid: 'aid-lead-abc123',
    parentTid: '',
    depth: 1,
    containerId: 'cid-weather-team',
    health: ContainerHealth.Running,
    agentAids: ['aid-alice-abc123'],
    workspacePath: '/app/workspace/teams/weather-team',
    ...overrides,
  };
}

function makeContainerInfo(slug: string, overrides?: Partial<ContainerInfo>): ContainerInfo {
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

function makeTask(slug: string, status: Task['status'] = 'active'): Task {
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

function createMockOrgChart(): OrgChart {
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
    getLeadOf: vi.fn(),
    isAuthorized: vi.fn(() => true),
    getTopology: vi.fn(() => []),
  } as OrgChart;
}

function createMockContainerManager(): ContainerManager & { getRestartCount: (slug: string) => number } {
  const restartCounts = new Map<string, number>();
  return {
    spawnTeamContainer: vi.fn(async () => makeContainerInfo('test-team')),
    stopTeamContainer: vi.fn(async () => {}),
    restartTeamContainer: vi.fn(async (slug: string) => {
      restartCounts.set(slug, (restartCounts.get(slug) ?? 0) + 1);
    }),
    getContainerByTeam: vi.fn(async () => undefined),
    listRunningContainers: vi.fn(async () => []),
    cleanupStoppedContainers: vi.fn(async () => 0),
    getRestartCount: (slug: string) => restartCounts.get(slug) ?? 0,
  };
}

function createMockHealthMonitor(): HealthMonitor {
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

function createMockTaskStore(): TaskStore {
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
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('GET /api/agents', () => {
  let app: MockFastify;
  let orgChart: OrgChart;
  let ctx: RouteContext;

  beforeEach(() => {
    app = new MockFastify();
    orgChart = createMockOrgChart();
    ctx = { orgChart };

    // Add some agents/teams
    const team = makeTeam();
    const agent = makeAgent();
    (orgChart.addTeam as ReturnType<typeof vi.fn>)(team);
    (orgChart.addAgent as ReturnType<typeof vi.fn>)(agent);

    registerRoutes(app as unknown as Parameters<typeof registerRoutes>[0], ctx);
  });

  it('returns all agents when no team filter is specified', async () => {
    const reply = await app.call('GET', '/api/agents');
    expect(reply._status).toBe(200);
    const body = reply._body as { agents: OrgChartAgent[] };
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].aid).toBe('aid-alice-abc123');
    expect(body.agents[0].teamSlug).toBe('weather-team');
    expect(body.agents[0].role).toBe('member');
    expect(body.agents[0].status).toBe(AgentStatus.Idle);
    expect(body.agents[0].leadsTeam).toBeNull();
  });

  it('filters by team when ?team= is provided', async () => {
    // Add another agent in a different team
    (orgChart.addTeam as ReturnType<typeof vi.fn>)(makeTeam({ slug: 'code-team', tid: 'tid-code-team-xyz' }));
    (orgChart.addAgent as ReturnType<typeof vi.fn>)(makeAgent({ aid: 'aid-bob-xyz', name: 'bob', teamSlug: 'code-team' }));

    const reply = await app.call('GET', '/api/agents', { query: { team: 'weather-team' } });
    expect(reply._status).toBe(200);
    const body = reply._body as { agents: OrgChartAgent[] };
    expect(body.agents.every((a) => a.teamSlug === 'weather-team')).toBe(true);
  });

  it('returns 503 when orgChart is not available', async () => {
    const emptyCtx: RouteContext = {};
    const app2 = new MockFastify();
    registerRoutes(app2 as unknown as Parameters<typeof registerRoutes>[0], emptyCtx);
    const reply = await app2.call('GET', '/api/agents');
    expect(reply._status).toBe(503);
  });

  it('returns 400 for empty team query param', async () => {
    const reply = await app.call('GET', '/api/agents', { query: { team: '' } });
    expect(reply._status).toBe(400);
  });

  it('includes leadsTeam when agent is a team lead', async () => {
    const leadAgent = makeAgent({ aid: 'aid-lead-abc123', leadsTeam: 'sub-team' });
    (orgChart.addAgent as ReturnType<typeof vi.fn>)(leadAgent);

    const reply = await app.call('GET', '/api/agents');
    const body = reply._body as { agents: Array<{ leadsTeam: string | null }> };
    const lead = body.agents.find((a) => (a as { aid?: string }).aid === 'aid-lead-abc123');
    expect(lead?.leadsTeam).toBe('sub-team');
  });
});

// ---------------------------------------------------------------------------
// GET /api/containers
// ---------------------------------------------------------------------------

describe('GET /api/containers', () => {
  let app: MockFastify;
  let containerManager: ContainerManager & { getRestartCount: (slug: string) => number };
  let healthMonitor: HealthMonitor;
  let orgChart: OrgChart;
  let taskStore: TaskStore;
  let ctx: RouteContext;

  beforeEach(() => {
    app = new MockFastify();
    containerManager = createMockContainerManager();
    healthMonitor = createMockHealthMonitor();
    orgChart = createMockOrgChart();
    taskStore = createMockTaskStore();
    ctx = { containerManager, healthMonitor, orgChart, taskStore };

    registerRoutes(app as unknown as Parameters<typeof registerRoutes>[0], ctx);
  });

  it('returns empty containers list when no containers are running', async () => {
    const reply = await app.call('GET', '/api/containers');
    expect(reply._status).toBe(200);
    const body = reply._body as { containers: unknown[] };
    expect(body.containers).toHaveLength(0);
  });

  it('returns enriched container data with health, agentCount, uptime, restartCount, activeTaskCount, childTeams', async () => {
    const container = makeContainerInfo('weather-team');
    (containerManager.listRunningContainers as ReturnType<typeof vi.fn>).mockResolvedValue([container]);

    // Add team and agent to orgChart
    const team = makeTeam();
    (orgChart.addTeam as ReturnType<typeof vi.fn>)(team);
    (orgChart.addAgent as ReturnType<typeof vi.fn>)(makeAgent());

    // Add tasks: 1 active, 1 pending
    (taskStore.listByTeam as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeTask('weather-team', 'active'),
      makeTask('weather-team', 'pending'),
    ]);

    const reply = await app.call('GET', '/api/containers');
    expect(reply._status).toBe(200);
    const body = reply._body as { containers: Array<{
      slug: string;
      health: ContainerHealth;
      agentCount: number;
      uptime: number;
      restartCount: number;
      activeTaskCount: number;
      childTeams: string[];
    }> };

    expect(body.containers).toHaveLength(1);
    const c = body.containers[0];
    expect(c.slug).toBe('weather-team');
    expect(c.health).toBe(ContainerHealth.Running);
    expect(c.agentCount).toBe(1);
    expect(c.uptime).toBeGreaterThanOrEqual(59); // ~60s ago
    expect(c.restartCount).toBe(0);
    expect(c.activeTaskCount).toBe(1);
    expect(c.childTeams).toEqual([]);
  });

  it('includes child teams in response', async () => {
    const container = makeContainerInfo('weather-team');
    (containerManager.listRunningContainers as ReturnType<typeof vi.fn>).mockResolvedValue([container]);

    const team = makeTeam();
    const childTeam = makeTeam({ tid: 'tid-sub-team-xyz', slug: 'sub-team', parentTid: team.tid });
    (orgChart.addTeam as ReturnType<typeof vi.fn>)(team);
    (orgChart.addTeam as ReturnType<typeof vi.fn>)(childTeam);
    (orgChart.getChildren as ReturnType<typeof vi.fn>).mockReturnValue([childTeam]);

    const reply = await app.call('GET', '/api/containers');
    const body = reply._body as { containers: Array<{ childTeams: string[] }> };
    expect(body.containers[0].childTeams).toContain('sub-team');
  });

  it('returns restartCount from manager after restarts', async () => {
    const container = makeContainerInfo('weather-team');
    (containerManager.listRunningContainers as ReturnType<typeof vi.fn>).mockResolvedValue([container]);

    // Simulate 2 restarts
    await containerManager.restartTeamContainer('weather-team', 'test');
    await containerManager.restartTeamContainer('weather-team', 'test');

    const reply = await app.call('GET', '/api/containers');
    const body = reply._body as { containers: Array<{ restartCount: number }> };
    expect(body.containers[0].restartCount).toBe(2);
  });

  it('uses health from healthMonitor when available', async () => {
    const container = makeContainerInfo('weather-team', { health: ContainerHealth.Running });
    (containerManager.listRunningContainers as ReturnType<typeof vi.fn>).mockResolvedValue([container]);
    (healthMonitor.getHealth as ReturnType<typeof vi.fn>).mockReturnValue(ContainerHealth.Degraded);

    const reply = await app.call('GET', '/api/containers');
    const body = reply._body as { containers: Array<{ health: ContainerHealth }> };
    expect(body.containers[0].health).toBe(ContainerHealth.Degraded);
  });

  it('returns 503 when containerManager is not available', async () => {
    const emptyCtx: RouteContext = {};
    const app2 = new MockFastify();
    registerRoutes(app2 as unknown as Parameters<typeof registerRoutes>[0], emptyCtx);
    const reply = await app2.call('GET', '/api/containers');
    expect(reply._status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// POST /api/containers/:slug/restart
// ---------------------------------------------------------------------------

describe('POST /api/containers/:slug/restart', () => {
  let app: MockFastify;
  let containerManager: ContainerManager & { getRestartCount: (slug: string) => number };
  let ctx: RouteContext;

  beforeEach(() => {
    app = new MockFastify();
    containerManager = createMockContainerManager();
    ctx = { containerManager };

    registerRoutes(app as unknown as Parameters<typeof registerRoutes>[0], ctx);
  });

  it('returns 200 with slug and status=restarted on success', async () => {
    const reply = await app.call('POST', '/api/containers/:slug/restart', {
      params: { slug: 'weather-team' },
    });
    expect(reply._status).toBe(200);
    const body = reply._body as { slug: string; status: string };
    expect(body.slug).toBe('weather-team');
    expect(body.status).toBe('restarted');
    expect(containerManager.restartTeamContainer).toHaveBeenCalledWith('weather-team', 'api_restart');
  });

  it('returns 409 when restart is already in progress (ConflictError)', async () => {
    (containerManager.restartTeamContainer as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ConflictError('Restart already in progress for team "weather-team"'),
    );
    const reply = await app.call('POST', '/api/containers/:slug/restart', {
      params: { slug: 'weather-team' },
    });
    expect(reply._status).toBe(409);
    const body = reply._body as { error: string };
    expect(body.error).toContain('in progress');
  });

  it('returns 404 when team container is not found (NotFoundError)', async () => {
    (containerManager.restartTeamContainer as ReturnType<typeof vi.fn>).mockRejectedValue(
      new NotFoundError('No container found for team "ghost"'),
    );
    const reply = await app.call('POST', '/api/containers/:slug/restart', {
      params: { slug: 'ghost-team' },
    });
    expect(reply._status).toBe(404);
  });

  it('returns 400 for invalid slug format (too short)', async () => {
    const reply = await app.call('POST', '/api/containers/:slug/restart', {
      params: { slug: 'ab' }, // 2 chars, less than 3
    });
    expect(reply._status).toBe(400);
    expect(containerManager.restartTeamContainer).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid slug format (uppercase letters)', async () => {
    const reply = await app.call('POST', '/api/containers/:slug/restart', {
      params: { slug: 'WeatherTeam' },
    });
    expect(reply._status).toBe(400);
  });

  it('returns 400 for slug that is too long (64 chars)', async () => {
    const longSlug = 'a'.repeat(64);
    const reply = await app.call('POST', '/api/containers/:slug/restart', {
      params: { slug: longSlug },
    });
    expect(reply._status).toBe(400);
  });

  it('returns 503 when containerManager is not available', async () => {
    const emptyCtx: RouteContext = {};
    const app2 = new MockFastify();
    registerRoutes(app2 as unknown as Parameters<typeof registerRoutes>[0], emptyCtx);
    const reply = await app2.call('POST', '/api/containers/:slug/restart', {
      params: { slug: 'weather-team' },
    });
    expect(reply._status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// ContainerManagerImpl.restartTeamContainer() enhancements (tested via manager.test.ts)
// but some integration-level behaviours also exercised here.
// ---------------------------------------------------------------------------

describe('POST /api/containers/:slug/restart — slug validation boundaries', () => {
  let app: MockFastify;
  let containerManager: ContainerManager & { getRestartCount: (slug: string) => number };
  let ctx: RouteContext;

  beforeEach(() => {
    app = new MockFastify();
    containerManager = createMockContainerManager();
    ctx = { containerManager };
    registerRoutes(app as unknown as Parameters<typeof registerRoutes>[0], ctx);
  });

  it('accepts a valid 3-char slug', async () => {
    const reply = await app.call('POST', '/api/containers/:slug/restart', {
      params: { slug: 'abc' },
    });
    expect(reply._status).toBe(200);
  });

  it('accepts a valid 63-char slug', async () => {
    const slug = 'a' + 'b'.repeat(62); // 63 chars
    const reply = await app.call('POST', '/api/containers/:slug/restart', {
      params: { slug },
    });
    expect(reply._status).toBe(200);
  });

  it('accepts a slug with hyphens between segments', async () => {
    const reply = await app.call('POST', '/api/containers/:slug/restart', {
      params: { slug: 'weather-forecast-team' },
    });
    expect(reply._status).toBe(200);
  });

  it('rejects a slug with leading hyphen', async () => {
    const reply = await app.call('POST', '/api/containers/:slug/restart', {
      params: { slug: '-weather-team' },
    });
    expect(reply._status).toBe(400);
  });

  it('rejects a slug with trailing hyphen', async () => {
    const reply = await app.call('POST', '/api/containers/:slug/restart', {
      params: { slug: 'weather-team-' },
    });
    expect(reply._status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/integrations
// ---------------------------------------------------------------------------

function makeIntegration(overrides?: Partial<Integration>): Integration {
  return {
    id: `integ-${Math.random().toString(36).slice(2)}`,
    team_id: 'weather-team',
    name: 'github-webhook',
    config_path: 'integrations/github.yaml',
    status: IntegrationStatus.Active,
    created_at: Date.now(),
    ...overrides,
  };
}

function createMockIntegrationStore(): IntegrationStore {
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

describe('GET /api/integrations', () => {
  let app: MockFastify;
  let integrationStore: IntegrationStore;
  let orgChart: OrgChart;
  let ctx: RouteContext;

  beforeEach(() => {
    app = new MockFastify();
    integrationStore = createMockIntegrationStore();
    orgChart = createMockOrgChart();
    ctx = { integrationStore, orgChart };
    registerRoutes(app as unknown as Parameters<typeof registerRoutes>[0], ctx);
  });

  it('returns 503 when integrationStore is not available', async () => {
    const app2 = new MockFastify();
    registerRoutes(app2 as unknown as Parameters<typeof registerRoutes>[0], {});
    const reply = await app2.call('GET', '/api/integrations');
    expect(reply._status).toBe(503);
  });

  it('returns empty list when no integrations exist', async () => {
    const reply = await app.call('GET', '/api/integrations');
    expect(reply._status).toBe(200);
    const body = reply._body as { integrations: unknown[] };
    expect(body.integrations).toEqual([]);
  });

  it('filters by ?team= query param', async () => {
    const i1 = makeIntegration({ team_id: 'weather-team' });
    const i2 = makeIntegration({ team_id: 'code-team' });
    await integrationStore.create(i1);
    await integrationStore.create(i2);

    const reply = await app.call('GET', '/api/integrations', { query: { team: 'weather-team' } });
    expect(reply._status).toBe(200);
    const body = reply._body as { integrations: Integration[] };
    expect(body.integrations).toHaveLength(1);
    expect(body.integrations[0].teamSlug).toBe('weather-team');
  });

  it('returns integrations from all teams when no filter is provided', async () => {
    // Add teams to orgChart
    const team1 = makeTeam({ slug: 'weather-team' });
    const team2 = makeTeam({ slug: 'code-team', tid: 'tid-code-team-xyz' });
    (orgChart.addTeam as ReturnType<typeof vi.fn>)(team1);
    (orgChart.addTeam as ReturnType<typeof vi.fn>)(team2);

    const i1 = makeIntegration({ team_id: 'weather-team' });
    const i2 = makeIntegration({ team_id: 'code-team' });
    await integrationStore.create(i1);
    await integrationStore.create(i2);

    const reply = await app.call('GET', '/api/integrations');
    expect(reply._status).toBe(200);
    const body = reply._body as { integrations: Integration[] };
    expect(body.integrations).toHaveLength(2);
  });

  it('returns correct Integration domain fields', async () => {
    const team = makeTeam();
    (orgChart.addTeam as ReturnType<typeof vi.fn>)(team);
    const i = makeIntegration({ team_id: 'weather-team', name: 'slack-hook' });
    await integrationStore.create(i);

    const reply = await app.call('GET', '/api/integrations');
    const body = reply._body as { integrations: Integration[] };
    const result = body.integrations[0];
    expect(result.id).toBe(i.id);
    expect(result.name).toBe('slack-hook');
    expect(result.teamSlug).toBe('weather-team');
    expect(result.config_path).toBeDefined();
    expect(result.status).toBeDefined();
    expect(result.created_at).toBeTypeOf('number');
  });
});

// ---------------------------------------------------------------------------
// GET /api/settings
// ---------------------------------------------------------------------------

function createMockConfigLoader(): ConfigLoader {
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

describe('GET /api/settings', () => {
  let app: MockFastify;
  let configLoader: ConfigLoader;
  let ctx: RouteContext;

  beforeEach(() => {
    app = new MockFastify();
    configLoader = createMockConfigLoader();
    ctx = { configLoader };
    registerRoutes(app as unknown as Parameters<typeof registerRoutes>[0], ctx);
  });

  it('returns 503 when configLoader is not available', async () => {
    const app2 = new MockFastify();
    registerRoutes(app2 as unknown as Parameters<typeof registerRoutes>[0], {});
    const reply = await app2.call('GET', '/api/settings');
    expect(reply._status).toBe(503);
  });

  it('returns settings with source annotations (nested by section)', async () => {
    const reply = await app.call('GET', '/api/settings');
    expect(reply._status).toBe(200);
    // Response is nested: { server: { listen_address: {value, source} }, limits: { max_depth: {value, source} } }
    const body = reply._body as Record<string, Record<string, { value: unknown; source: string }>>;
    expect(body['server']['listen_address']).toEqual({ value: '127.0.0.1:8080', source: 'default' });
    expect(body['limits']['max_depth']).toEqual({ value: 3, source: 'default' });
  });

  it('calls getConfigWithSources() on the configLoader', async () => {
    await app.call('GET', '/api/settings');
    expect(configLoader.getConfigWithSources).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// PUT /api/settings
// ---------------------------------------------------------------------------

describe('PUT /api/settings', () => {
  let app: MockFastify;
  let configLoader: ConfigLoader;
  let ctx: RouteContext;

  beforeEach(() => {
    app = new MockFastify();
    configLoader = createMockConfigLoader();
    ctx = { configLoader };
    registerRoutes(app as unknown as Parameters<typeof registerRoutes>[0], ctx);
  });

  it('returns 503 when configLoader is not available', async () => {
    const app2 = new MockFastify();
    registerRoutes(app2 as unknown as Parameters<typeof registerRoutes>[0], {});
    const reply = await app2.call('PUT', '/api/settings');
    expect(reply._status).toBe(503);
  });

  it('calls saveMaster with merged config and returns updated settings', async () => {
    const reply = await app.call('PUT', '/api/settings', {
      body: { limits: { max_depth: 5 } },
    });
    expect(reply._status).toBe(200);
    expect(configLoader.saveMaster).toHaveBeenCalled();
    // Response is the nested settings object directly (no settings wrapper)
    const body = reply._body as Record<string, unknown>;
    expect(body).toBeDefined();
    expect(typeof body).toBe('object');
  });

  it('returns 400 for invalid body (non-object)', async () => {
    const reply = await app.call('PUT', '/api/settings', {
      body: 'not-an-object',
    });
    expect(reply._status).toBe(400);
  });

  it('returns 400 when saveMaster throws a ValidationError', async () => {
    (configLoader.saveMaster as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ValidationError('Invalid config: max_depth must be a number'),
    );
    const reply = await app.call('PUT', '/api/settings', {
      body: { limits: { max_depth: 'bad' } },
    });
    expect(reply._status).toBe(400);
  });

  it('re-throws non-ValidationError from saveMaster so the onError hook handles it', async () => {
    (configLoader.saveMaster as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('ENOENT: no such file or directory'),
    );
    // The route should throw, not return a 400 — the mock app will surface it as a thrown error.
    await expect(
      app.call('PUT', '/api/settings', { body: { limits: {} } }),
    ).rejects.toThrow('ENOENT: no such file or directory');
  });
});

// ---------------------------------------------------------------------------
// POST /api/settings/reload
// ---------------------------------------------------------------------------

describe('POST /api/settings/reload', () => {
  let app: MockFastify;
  let configLoader: ConfigLoader;
  let ctx: RouteContext;

  beforeEach(() => {
    app = new MockFastify();
    configLoader = createMockConfigLoader();
    ctx = { configLoader };
    registerRoutes(app as unknown as Parameters<typeof registerRoutes>[0], ctx);
  });

  it('returns 503 when configLoader is not available', async () => {
    const app2 = new MockFastify();
    registerRoutes(app2 as unknown as Parameters<typeof registerRoutes>[0], {});
    const reply = await app2.call('POST', '/api/settings/reload');
    expect(reply._status).toBe(503);
  });

  it('calls loadMaster() and returns updated settings', async () => {
    const reply = await app.call('POST', '/api/settings/reload');
    expect(reply._status).toBe(200);
    expect(configLoader.loadMaster).toHaveBeenCalled();
    // Response is the nested settings object directly (no settings wrapper)
    const body = reply._body as Record<string, unknown>;
    expect(body).toBeDefined();
    expect(typeof body).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// GET /api/teams — parentSlug field (AC-G10)
// ---------------------------------------------------------------------------

describe('GET /api/teams — parentSlug field', () => {
  let app: MockFastify;
  let orgChart: OrgChart;
  let ctx: RouteContext;

  beforeEach(() => {
    app = new MockFastify();
    orgChart = createMockOrgChart();
    ctx = { orgChart };
    registerRoutes(app as unknown as Parameters<typeof registerRoutes>[0], ctx);
  });

  it('includes parentSlug: null for root-level teams', async () => {
    (orgChart.addTeam as ReturnType<typeof vi.fn>)(makeTeam({ parentTid: '' }));

    const reply = await app.call('GET', '/api/teams');
    expect(reply._status).toBe(200);
    const body = reply._body as { teams: Array<{ parentSlug: string | null }> };
    expect(body.teams[0].parentSlug).toBeNull();
  });

  it('includes parentSlug for child teams by resolving via getParent', async () => {
    const parent = makeTeam({ tid: 'tid-root-abc', slug: 'root-team', parentTid: '' });
    const child = makeTeam({
      tid: 'tid-child-abc',
      slug: 'child-team',
      parentTid: 'tid-root-abc',
    });
    (orgChart.addTeam as ReturnType<typeof vi.fn>)(parent);
    (orgChart.addTeam as ReturnType<typeof vi.fn>)(child);
    // getParent called with child's tid, returns parent
    (orgChart.getParent as ReturnType<typeof vi.fn>).mockImplementation((tid: string) => {
      if (tid === 'tid-child-abc') return parent;
      return undefined;
    });

    const reply = await app.call('GET', '/api/teams');
    expect(reply._status).toBe(200);
    const body = reply._body as { teams: Array<{ slug: string; parentSlug: string | null }> };
    const childEntry = body.teams.find((t) => t.slug === 'child-team');
    expect(childEntry?.parentSlug).toBe('root-team');
  });

  it('falls back to null when getParent returns undefined for a non-empty parentTid', async () => {
    const orphan = makeTeam({ tid: 'tid-orphan-abc', slug: 'orphan-team', parentTid: 'tid-gone' });
    (orgChart.addTeam as ReturnType<typeof vi.fn>)(orphan);
    (orgChart.getParent as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const reply = await app.call('GET', '/api/teams');
    const body = reply._body as { teams: Array<{ parentSlug: string | null }> };
    expect(body.teams[0].parentSlug).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /api/logs/stream — SSE EventBus fan-out (AC-G12)
// ---------------------------------------------------------------------------

function createMockEventBus(): EventBus {
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

describe('GET /api/logs/stream', () => {
  let app: MockFastify;
  let eventBus: EventBus;
  let ctx: RouteContext;

  beforeEach(() => {
    resetSseStateForTest();
    app = new MockFastify();
    eventBus = createMockEventBus();
    ctx = { eventBus };
    registerRoutes(app as unknown as Parameters<typeof registerRoutes>[0], ctx);
  });

  afterEach(() => {
    resetSseStateForTest();
  });

  it('sets SSE headers and writes initial connected event', async () => {
    const req = makeMockRequest();
    const reply = makeMockReply();

    await (app as unknown as MockFastify & {
      call: (m: string, p: string, r?: Partial<MockRequest>) => Promise<MockReply>
    }).call('GET', '/api/logs/stream', req);

    expect(reply.raw.setHeader).not.toHaveBeenCalled(); // Validate via the route handler directly
    // Instead: invoke the captured handler
    const routes = (app as unknown as { _routes: Map<string, unknown> })._routes;
    const handler = routes.get('GET /api/logs/stream') as (req: MockRequest, reply: MockReply) => Promise<void>;
    expect(handler).toBeDefined();
    const req2 = makeMockRequest();
    const reply2 = makeMockReply();
    await handler(req2, reply2);

    expect(reply2.raw.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(reply2.raw.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(reply2.raw.write).toHaveBeenCalledWith('data: {"type":"connected"}\n\n');
  });

  it('subscribes to EventBus when first client connects', async () => {
    const routes = (app as unknown as { _routes: Map<string, unknown> })._routes;
    const handler = routes.get('GET /api/logs/stream') as (req: MockRequest, reply: MockReply) => Promise<void>;
    await handler(makeMockRequest(), makeMockReply());

    expect(eventBus.filteredSubscribe).toHaveBeenCalledOnce();
  });

  it('does not create duplicate EventBus subscriptions for multiple clients', async () => {
    const routes = (app as unknown as { _routes: Map<string, unknown> })._routes;
    const handler = routes.get('GET /api/logs/stream') as (req: MockRequest, reply: MockReply) => Promise<void>;
    await handler(makeMockRequest(), makeMockReply());
    await handler(makeMockRequest(), makeMockReply());

    // Still only one subscription despite two clients
    expect(eventBus.filteredSubscribe).toHaveBeenCalledOnce();
  });

  it('fans out log events to all connected clients', async () => {
    const routes = (app as unknown as { _routes: Map<string, unknown> })._routes;
    const handler = routes.get('GET /api/logs/stream') as (req: MockRequest, reply: MockReply) => Promise<void>;
    const reply1 = makeMockReply();
    const reply2 = makeMockReply();
    await handler(makeMockRequest(), reply1);
    await handler(makeMockRequest(), reply2);

    const logEvent: BusEvent = { type: 'log_event', data: { msg: 'hello' }, timestamp: 1 };
    (eventBus.publish as ReturnType<typeof vi.fn>)(logEvent);

    const frame = `data: ${JSON.stringify(logEvent)}\n\n`;
    expect(reply1.raw.write).toHaveBeenCalledWith(frame);
    expect(reply2.raw.write).toHaveBeenCalledWith(frame);
  });

  it('does not fan out non-log events to SSE clients', async () => {
    const routes = (app as unknown as { _routes: Map<string, unknown> })._routes;
    const handler = routes.get('GET /api/logs/stream') as (req: MockRequest, reply: MockReply) => Promise<void>;
    const reply1 = makeMockReply();
    await handler(makeMockRequest(), reply1);

    const taskEvent: BusEvent = { type: 'task.dispatched', data: {}, timestamp: 1 };
    (eventBus.publish as ReturnType<typeof vi.fn>)(taskEvent);

    // Only the initial connected frame should have been written, not the task event
    expect(reply1.raw.write).toHaveBeenCalledTimes(1);
    expect(reply1.raw.write).toHaveBeenCalledWith('data: {"type":"connected"}\n\n');
  });

  it('skips clients whose raw stream is not writable (backpressure)', async () => {
    const routes = (app as unknown as { _routes: Map<string, unknown> })._routes;
    const handler = routes.get('GET /api/logs/stream') as (req: MockRequest, reply: MockReply) => Promise<void>;
    const writableReply = makeMockReply(true);
    const nonWritableReply = makeMockReply(false);
    // Manually set writable=false after initial connected write
    await handler(makeMockRequest(), writableReply);
    await handler(makeMockRequest(), nonWritableReply);
    // Override writable to false after connection
    nonWritableReply.raw.writable = false;

    const logEvent: BusEvent = { type: 'log_event', data: {}, timestamp: 1 };
    (eventBus.publish as ReturnType<typeof vi.fn>)(logEvent);

    const frame = `data: ${JSON.stringify(logEvent)}\n\n`;
    expect(writableReply.raw.write).toHaveBeenCalledWith(frame);
    // non-writable client should NOT receive the event frame
    expect(nonWritableReply.raw.write).not.toHaveBeenCalledWith(frame);
  });

  it('removes client and unsubscribes EventBus on close when last client disconnects', async () => {
    const routes = (app as unknown as { _routes: Map<string, unknown> })._routes;
    const handler = routes.get('GET /api/logs/stream') as (req: MockRequest, reply: MockReply) => Promise<void>;
    const req = makeMockRequest();
    await handler(req, makeMockReply());

    // Simulate client disconnect
    const closeHandler = (req.raw.on as ReturnType<typeof vi.fn>).mock.calls.find(
      ([event]: [string]) => event === 'close',
    )?.[1] as (() => void) | undefined;
    expect(closeHandler).toBeDefined();
    closeHandler!();

    // EventBus should be unsubscribed when all clients disconnect
    expect(eventBus.unsubscribe).toHaveBeenCalledOnce();
  });

  it('does not unsubscribe EventBus when some clients remain after one disconnects', async () => {
    const routes = (app as unknown as { _routes: Map<string, unknown> })._routes;
    const handler = routes.get('GET /api/logs/stream') as (req: MockRequest, reply: MockReply) => Promise<void>;
    const req1 = makeMockRequest();
    const req2 = makeMockRequest();
    await handler(req1, makeMockReply());
    await handler(req2, makeMockReply());

    // Disconnect only the first client
    const closeHandler1 = (req1.raw.on as ReturnType<typeof vi.fn>).mock.calls.find(
      ([event]: [string]) => event === 'close',
    )?.[1] as (() => void) | undefined;
    closeHandler1!();

    // EventBus should NOT be unsubscribed because req2 is still connected
    expect(eventBus.unsubscribe).not.toHaveBeenCalled();
  });

  it('returns 503 when SSE client limit (50) is reached', async () => {
    const routes = (app as unknown as { _routes: Map<string, unknown> })._routes;
    const handler = routes.get('GET /api/logs/stream') as (req: MockRequest, reply: MockReply) => Promise<void>;

    // Fill up to the limit (50 clients)
    for (let i = 0; i < 50; i++) {
      await handler(makeMockRequest(), makeMockReply());
    }

    // The 51st connection should be rejected
    const reply = makeMockReply();
    await handler(makeMockRequest(), reply);
    expect(reply._status).toBe(503);
  });

  it('does not subscribe to EventBus when eventBus is not in context', async () => {
    resetSseStateForTest();
    const app2 = new MockFastify();
    const noEventBusCtx: RouteContext = {};
    registerRoutes(app2 as unknown as Parameters<typeof registerRoutes>[0], noEventBusCtx);

    const routes = (app2 as unknown as { _routes: Map<string, unknown> })._routes;
    const handler = routes.get('GET /api/logs/stream') as (req: MockRequest, reply: MockReply) => Promise<void>;
    const reply = makeMockReply();
    await handler(makeMockRequest(), reply);

    // Should still write the initial connected frame (connection succeeds)
    expect(reply.raw.write).toHaveBeenCalledWith('data: {"type":"connected"}\n\n');
    // But no subscription was created (eventBus.filteredSubscribe not called)
    expect(eventBus.filteredSubscribe).not.toHaveBeenCalled();
  });
});
