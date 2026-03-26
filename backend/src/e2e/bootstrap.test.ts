/**
 * Bootstrap + graceful shutdown tests (migrated from layer-9.test.ts)
 *
 * - Bootstrap creates all components
 * - Graceful shutdown stops all components
 */

import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { bootstrap } from '../index.js';
import type { BootstrapResult } from '../index.js';

// ── Bootstrap creates all components ────────────────────────────────────

describe('Bootstrap creates all components', () => {
  let result: BootstrapResult | null = null;

  afterEach(async () => {
    if (result) {
      await result.shutdown();
      result = null;
    }
  });

  it('creates logger, db, session manager, trigger engine, channel router, fastify', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openhive-bootstrap-'));
    const input = new PassThrough();
    const output = new PassThrough();

    result = await bootstrap({
      runDir: dir,
      dataDir: join(dir, 'data'),
      skipListen: true,
      skipCli: true,
      orgMcpPort: 0,
      cliInput: input,
      cliOutput: output,
    });

    expect(result.logger).toBeDefined();
    expect(result.raw).toBeDefined();
    expect(result.fastify).toBeDefined();
    expect(result.sessionManager).toBeDefined();
    expect(result.triggerEngine).toBeDefined();
    expect(result.channelRouter).toBeDefined();
    expect(result.orgTree).toBeDefined();

    // Verify health endpoint works through bootstrap
    const response = await result.fastify.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);

    input.end();
  });
});

// ── Graceful shutdown stops all components ──────────────────────────────

describe('Graceful shutdown stops all components', () => {
  it('shutdown closes database and all subsystems', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openhive-shutdown-'));

    const result = await bootstrap({
      runDir: dir,
      dataDir: join(dir, 'data'),
      skipListen: true,
      skipCli: true,
      orgMcpPort: 0,
    });

    // Spawn a session so we can verify stopAll is called
    result.sessionManager.spawn('test-team');
    expect(result.sessionManager.getActive()).toHaveLength(1);

    await result.shutdown();

    // After shutdown, database should be closed
    expect(() => result.raw.prepare('SELECT 1').get()).toThrow();

    // Sessions should be stopped
    expect(result.sessionManager.getActive()).toHaveLength(0);
  });
});
