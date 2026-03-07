/**
 * Tests for handlers-logs.ts — GET /api/v1/logs.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

import type { LogStore } from '../domain/interfaces.js';
import type { LogEntry } from '../domain/types.js';
import { registerLogRoutes } from './handlers-logs.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const sampleLog: LogEntry = {
  id: 1,
  level: 'info',
  component: 'orchestrator',
  action: 'task.start',
  message: 'Task started',
  team_name: 'my-team',
  task_id: 'aaaa1111-bbbb-cccc-dddd-eeee00000001',
  created_at: new Date('2025-01-01T00:00:00Z'),
};

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeMockLogStore(entries: LogEntry[] = [sampleLog]): LogStore & {
  query: ReturnType<typeof vi.fn>;
} {
  return {
    create: vi.fn(),
    query: vi.fn().mockResolvedValue(entries),
    deleteBefore: vi.fn(),
    count: vi.fn(),
    getOldest: vi.fn(),
  } as unknown as LogStore & { query: ReturnType<typeof vi.fn> };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

// Note: coerceTypes:'array' required so integer query params (limit, offset)
// are coerced from URL strings to numbers by AJV.
async function buildApp(logStore: LogStore): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    ajv: {
      customOptions: { allErrors: true, removeAdditional: false, coerceTypes: 'array' },
    },
  });
  registerLogRoutes(app, logStore, makeLogger());
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// getLogsHandler
// ---------------------------------------------------------------------------

describe('getLogsHandler', () => {
  let logStore: ReturnType<typeof makeMockLogStore>;
  let app: FastifyInstance;

  // Use beforeAll/afterAll to avoid cold-start hook timeout on first test.
  // Mocks are cleared between tests to keep call counts accurate.
  beforeAll(async () => {
    logStore = makeMockLogStore();
    app = await buildApp(logStore);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply default mock implementation after clearAllMocks
    logStore.query.mockResolvedValue([sampleLog]);
  });

  it('returns log entries', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: LogEntry[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.component).toBe('orchestrator');
  });

  it('filters by level', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs?level=info' });
    expect(res.statusCode).toBe(200);
    expect(logStore.query).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info' }),
    );
  });

  it('filters by component', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs?component=orchestrator' });
    expect(res.statusCode).toBe(200);
    expect(logStore.query).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'orchestrator' }),
    );
  });

  it('filters by time range', async () => {
    const since = '2025-01-01T00:00:00Z';
    const until = '2025-01-02T00:00:00Z';
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/logs?since=${since}&until=${until}`,
    });
    expect(res.statusCode).toBe(200);
    const call = logStore.query.mock.calls[0]![0] as { since: Date; until: Date };
    expect(call.since).toBeInstanceOf(Date);
    expect(call.until).toBeInstanceOf(Date);
  });

  it('validates limit and offset', async () => {
    const zeroLimit = await app.inject({ method: 'GET', url: '/api/v1/logs?limit=0' });
    expect(zeroLimit.statusCode).toBe(400);

    const negativeOffset = await app.inject({ method: 'GET', url: '/api/v1/logs?offset=-1' });
    expect(negativeOffset.statusCode).toBe(400);
  });

  it('returns empty array for no results', async () => {
    const emptyStore = makeMockLogStore([]);
    const emptyApp = await buildApp(emptyStore);
    try {
      const res = await emptyApp.inject({ method: 'GET', url: '/api/v1/logs' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { data: LogEntry[] };
      expect(body.data).toEqual([]);
    } finally {
      await emptyApp.close();
    }
  });

  it('rejects invalid level', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs?level=verbose' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects injection in component query param', async () => {
    const withSlash = await app.inject({ method: 'GET', url: '/api/v1/logs?component=../evil' });
    expect(withSlash.statusCode).toBe(400);

    const withSpace = await app.inject({
      method: 'GET',
      url: '/api/v1/logs?component=bad%20component',
    });
    expect(withSpace.statusCode).toBe(400);
  });

  it('rejects negative offset with 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs?offset=-5' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects limit > 1000 with 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs?limit=1001' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid date-time format for since/until', async () => {
    const invalidSince = await app.inject({
      method: 'GET',
      url: '/api/v1/logs?since=not-a-date',
    });
    expect(invalidSince.statusCode).toBe(400);

    const invalidUntil = await app.inject({
      method: 'GET',
      url: '/api/v1/logs?until=not-a-date',
    });
    expect(invalidUntil.statusCode).toBe(400);
  });

  it('rejects unknown query parameters (additionalProperties: false)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs?foo=bar' });
    expect(res.statusCode).toBe(400);
  });
});
