/**
 * Tests for container routes: GET /api/containers, POST /api/containers/:slug/restart.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OrgChart, ContainerManager, HealthMonitor, TaskStore } from '../../domain/index.js';
import { ContainerHealth } from '../../domain/enums.js';
import { ConflictError, NotFoundError } from '../../domain/errors.js';
import { registerRoutes, type RouteContext } from './index.js';
import { MockFastify, makeAgent, makeTeam, makeContainerInfo, makeTask, createMockOrgChart, createMockContainerManager, createMockHealthMonitor, createMockTaskStore } from './__test-helpers.js';

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
