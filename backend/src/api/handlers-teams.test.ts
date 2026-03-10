/**
 * Tests for handlers-teams.ts — GET/POST/DELETE /api/v1/teams.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

import type { Orchestrator, HeartbeatMonitor, OrgChart } from '../domain/interfaces.js';
import type { HeartbeatStatus, Team } from '../domain/types.js';
import { NotFoundError } from '../domain/errors.js';
import { buildTeamResponse, registerTeamRoutes } from './handlers-teams.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const sampleTeam: Team = {
  tid: 'tid-abc-def',
  slug: 'my-team',
  leader_aid: 'aid-abc-def',
  parent_slug: undefined,
  children: [],
  agents: [],
};

const sampleHeartbeat: HeartbeatStatus = {
  team_id: 'tid-abc-def',
  agents: [],
  last_seen: new Date('2025-01-01T00:00:00Z'),
  is_healthy: true,
};

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeMockOrgChart(): OrgChart & {
  getOrgChart: ReturnType<typeof vi.fn>;
  getTeamBySlug: ReturnType<typeof vi.fn>;
} {
  return {
    getOrgChart: vi.fn().mockReturnValue({ 'my-team': sampleTeam }),
    getTeamBySlug: vi.fn().mockImplementation((slug: string) => {
      if (slug === 'my-team') return sampleTeam;
      throw new NotFoundError('team', slug);
    }),
    getAgentByAID: vi.fn(),
    getTeamForAgent: vi.fn(),
    getLeadTeams: vi.fn(),
    getSubordinates: vi.fn(),
    getSupervisor: vi.fn(),
    rebuildFromConfig: vi.fn(),
  } as unknown as OrgChart & {
    getOrgChart: ReturnType<typeof vi.fn>;
    getTeamBySlug: ReturnType<typeof vi.fn>;
  };
}

function makeMockOrch(): Orchestrator & {
  createTeam: ReturnType<typeof vi.fn>;
  deleteTeam: ReturnType<typeof vi.fn>;
} {
  return {
    createTeam: vi.fn().mockResolvedValue(sampleTeam),
    deleteTeam: vi.fn().mockResolvedValue(undefined),
    getTeam: vi.fn(),
    listTeams: vi.fn(),
    updateTeam: vi.fn(),
    dispatchTask: vi.fn(),
    handleTaskResult: vi.fn(),
    cancelTask: vi.fn(),
    getTaskStatus: vi.fn(),
    createSubtasks: vi.fn(),
    getHealthStatus: vi.fn(),
    handleUnhealthy: vi.fn(),
    getAllStatuses: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as Orchestrator & {
    createTeam: ReturnType<typeof vi.fn>;
    deleteTeam: ReturnType<typeof vi.fn>;
  };
}

function makeMockHbm(): HeartbeatMonitor & {
  getStatus: ReturnType<typeof vi.fn>;
} {
  return {
    getStatus: vi.fn().mockReturnValue(sampleHeartbeat),
    getAllStatuses: vi.fn(),
    processHeartbeat: vi.fn(),
    setOnUnhealthy: vi.fn(),
    startMonitoring: vi.fn(),
    stopMonitoring: vi.fn(),
  } as unknown as HeartbeatMonitor & { getStatus: ReturnType<typeof vi.fn> };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

async function buildApp(
  orgChart: OrgChart,
  orch: Orchestrator,
  hbm: HeartbeatMonitor | null,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { allErrors: true, removeAdditional: false, coerceTypes: false } },
  });
  registerTeamRoutes(app, orgChart, orch, hbm, makeLogger());
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// getTeamsHandler
// ---------------------------------------------------------------------------

describe('getTeamsHandler', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(makeMockOrgChart(), makeMockOrch(), makeMockHbm());
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns all teams with heartbeat', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/teams' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as { data: Array<{ slug: string; heartbeat?: { is_healthy: boolean } }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.slug).toBe('my-team');
    expect(body.data[0]!.heartbeat?.is_healthy).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getTeamHandler
// ---------------------------------------------------------------------------

describe('getTeamHandler', () => {
  let orgChart: ReturnType<typeof makeMockOrgChart>;
  let app: FastifyInstance;

  beforeEach(async () => {
    orgChart = makeMockOrgChart();
    app = await buildApp(orgChart, makeMockOrch(), null);
  });

  it('returns team by slug', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/teams/my-team' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: { slug: string; tid: string } };
    expect(body.data.slug).toBe('my-team');
    expect(body.data.tid).toBe('tid-abc-def');
  });

  it('returns 404 for unknown slug', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/teams/no-such-team' });
    expect(res.statusCode).toBe(404);
  });

  it('rejects slug param with invalid characters', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/teams/INVALID_SLUG' });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// createTeamHandler
// ---------------------------------------------------------------------------

describe('createTeamHandler', () => {
  let orch: ReturnType<typeof makeMockOrch>;
  let app: FastifyInstance;

  beforeEach(async () => {
    orch = makeMockOrch();
    app = await buildApp(makeMockOrgChart(), orch, null);
  });

  it('creates team with valid input', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      payload: JSON.stringify({ slug: 'my-team', leader_aid: 'aid-abc-def' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(201);
    expect(orch.createTeam).toHaveBeenCalledWith('my-team', 'aid-abc-def');
  });

  it('rejects reserved slugs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      payload: JSON.stringify({ slug: 'admin', leader_aid: 'aid-abc-def' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    expect(orch.createTeam).not.toHaveBeenCalled();
  });

  it('rejects empty slug or leader_aid', async () => {
    const noSlug = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      payload: JSON.stringify({ leader_aid: 'aid-abc-def' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(noSlug.statusCode).toBe(400);

    const noLeader = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      payload: JSON.stringify({ slug: 'my-team' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(noLeader.statusCode).toBe(400);
  });

  it('rejects slug with path traversal characters (../, /, \\)', async () => {
    const traversal = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      payload: JSON.stringify({ slug: '../evil', leader_aid: 'aid-abc-def' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(traversal.statusCode).toBe(400);

    const withSlash = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      payload: JSON.stringify({ slug: 'foo/bar', leader_aid: 'aid-abc-def' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(withSlash.statusCode).toBe(400);

    const withBackslash = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      payload: JSON.stringify({ slug: 'foo\\bar', leader_aid: 'aid-abc-def' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(withBackslash.statusCode).toBe(400);
  });

  it('rejects slug with special characters (spaces, unicode)', async () => {
    const withSpace = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      payload: JSON.stringify({ slug: 'my team', leader_aid: 'aid-abc-def' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(withSpace.statusCode).toBe(400);

    const withUnicode = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      payload: JSON.stringify({ slug: 'my-tëam', leader_aid: 'aid-abc-def' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(withUnicode.statusCode).toBe(400);
  });

  it('rejects oversized slug (>64 chars)', async () => {
    const longSlug = 'a'.repeat(65);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      payload: JSON.stringify({ slug: longSlug, leader_aid: 'aid-abc-def' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects malformed leader_aid', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      payload: JSON.stringify({ slug: 'my-team', leader_aid: 'not-an-aid' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects extra fields in body (additionalProperties: false)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      payload: JSON.stringify({ slug: 'my-team', leader_aid: 'aid-abc-def', extra: 'field' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// deleteTeamHandler
// ---------------------------------------------------------------------------

describe('deleteTeamHandler', () => {
  let orch: ReturnType<typeof makeMockOrch>;
  let app: FastifyInstance;

  beforeEach(async () => {
    orch = makeMockOrch();
    app = await buildApp(makeMockOrgChart(), orch, null);
  });

  it('deletes team and returns 204', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/teams/my-team' });
    expect(res.statusCode).toBe(204);
    expect(orch.deleteTeam).toHaveBeenCalledWith('my-team');
  });

  it('returns 404 for unknown slug', async () => {
    orch.deleteTeam.mockRejectedValue(new NotFoundError('team', 'no-such-team'));
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/teams/no-such-team' });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// buildTeamResponse utility
// ---------------------------------------------------------------------------

describe('buildTeamResponse', () => {
  it('includes heartbeat when hbm provided and getStatus succeeds', () => {
    const hbm = makeMockHbm();
    const resp = buildTeamResponse(sampleTeam, hbm);
    expect(resp.heartbeat?.is_healthy).toBe(true);
    expect(resp.slug).toBe('my-team');
  });

  it('omits heartbeat when hbm is null', () => {
    const resp = buildTeamResponse(sampleTeam, null);
    expect(resp.heartbeat).toBeUndefined();
  });

  it('omits heartbeat when getStatus throws (team not seen yet)', () => {
    const hbm = makeMockHbm();
    hbm.getStatus.mockImplementation(() => {
      throw new NotFoundError('heartbeat', 'tid-abc-def');
    });
    const resp = buildTeamResponse(sampleTeam, hbm);
    expect(resp.heartbeat).toBeUndefined();
  });
});

