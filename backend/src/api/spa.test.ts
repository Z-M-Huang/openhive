/**
 * Tests for spa.ts — SPA static file handler + client-side routing fallback.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { spaPlugin } from './spa.js';

// ---------------------------------------------------------------------------
// Test fixtures — temp directory with a minimal SPA dist
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'openhive-spa-'));
  writeFileSync(join(tmpDir, 'index.html'), '<!DOCTYPE html><html><body>SPA</body></html>');
  writeFileSync(join(tmpDir, 'app.js'), 'console.log("app");');
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// spaPlugin tests
// ---------------------------------------------------------------------------

describe('spaPlugin', () => {
  it('SPA serves index.html for root path', async () => {
    const app = Fastify({ logger: false });
    await app.register(spaPlugin, { root: tmpDir });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<!DOCTYPE html>');
  });

  it('SPA serves static files when they exist', async () => {
    const app = Fastify({ logger: false });
    await app.register(spaPlugin, { root: tmpDir });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/app.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('console.log("app");');
  });

  it('SPA falls back to index.html for unknown paths', async () => {
    const app = Fastify({ logger: false });
    await app.register(spaPlugin, { root: tmpDir });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/some/spa/route' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<!DOCTYPE html>');
  });

  it('SPA does not intercept API routes', async () => {
    const app = Fastify({ logger: false });
    // API route registered before SPA plugin takes priority
    app.get('/api/health', (_req, reply) => reply.send({ data: 'ok' }));
    await app.register(spaPlugin, { root: tmpDir });
    await app.ready();

    // Registered API route → 200
    const apiRes = await app.inject({ method: 'GET', url: '/api/health' });
    expect(apiRes.statusCode).toBe(200);
    expect(JSON.parse(apiRes.body) as unknown).toEqual({ data: 'ok' });

    // Unregistered API path → 404 JSON, NOT index.html
    const missingRes = await app.inject({ method: 'GET', url: '/api/missing' });
    expect(missingRes.statusCode).toBe(404);
    expect(missingRes.body).not.toContain('<!DOCTYPE html>');
  });
});
