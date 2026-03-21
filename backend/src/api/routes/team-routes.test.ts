/**
 * Tests for GET /api/teams route.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OrgChart } from '../../domain/index.js';
import { registerRoutes, type RouteContext } from './index.js';
import { MockFastify, makeTeam, createMockOrgChart } from './__test-helpers.js';

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

