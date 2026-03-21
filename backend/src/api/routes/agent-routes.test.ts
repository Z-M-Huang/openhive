/**
 * Tests for GET /api/agents route.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OrgChart, OrgChartAgent } from '../../domain/index.js';
import { AgentStatus } from '../../domain/enums.js';
import { registerRoutes, type RouteContext } from './index.js';
import { MockFastify, makeAgent, makeTeam, createMockOrgChart } from './__test-helpers.js';

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
  });

  it('filters by team when ?team= is provided', async () => {
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
});
