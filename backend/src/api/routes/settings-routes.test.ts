/**
 * Tests for settings routes: GET/PUT /api/settings, POST /api/settings/reload.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ConfigLoader } from '../../domain/index.js';
import { ValidationError } from '../../domain/errors.js';
import { registerRoutes, type RouteContext } from './index.js';
import { MockFastify, createMockConfigLoader } from './__test-helpers.js';

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
