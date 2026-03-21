/**
 * Tests for GET /api/integrations route.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OrgChart, IntegrationStore } from '../../domain/index.js';
import type { Integration } from '../../domain/domain.js';
import { registerRoutes, type RouteContext } from './index.js';
import { MockFastify, makeTeam, createMockOrgChart, makeIntegration, createMockIntegrationStore } from './__test-helpers.js';

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
    const body = reply._body as { integrations: Array<{ teamSlug: string }> };
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
    const body = reply._body as { integrations: Array<{ id: string; name: string; teamSlug: string; config_path: string; status: string; created_at: number }> };
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
