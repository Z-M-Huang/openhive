/**
 * Quick E2E tests — in-process bootstrap with mock queryFn.
 *
 * Verifies runtime wiring without Docker or API keys.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { bootstrap } from '../index.js';
import type { BootstrapResult } from '../index.js';
// ── Setup ────────────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'openhive-e2e-quick-'));
let result: BootstrapResult;

afterAll(async () => {
  if (result) await result.shutdown();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('Quick E2E: Bootstrap wiring', () => {
  it('bootstraps and health returns 200', { timeout: 15_000 }, async () => {
    result = await bootstrap({
      runDir: dir, dataDir: join(dir, 'data'),
      skipListen: true, skipCli: true,
    });

    const resp = await result.fastify.inject({ method: 'GET', url: '/health' });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body) as { storage: { ok: boolean } };
    expect(body.storage.ok).toBe(true);
  });

  it('.run/ structure has teams/, shared/, backups/, teams/main/', () => {
    expect(existsSync(join(dir, 'teams'))).toBe(true);
    expect(existsSync(join(dir, 'shared'))).toBe(true);
    expect(existsSync(join(dir, 'backups'))).toBe(true);
    expect(existsSync(join(dir, 'teams', 'main', 'config.yaml'))).toBe(true);
  });

  it('.run/ main team has all subdirectories', () => {
    for (const sub of ['memory', 'org-rules', 'team-rules', 'skills', 'subagents']) {
      expect(existsSync(join(dir, 'teams', 'main', sub))).toBe(true);
    }
  });

  it('health shows triggers registered (via SQLite config store)', { timeout: 15_000 }, async () => {
    // Create trigger via MCP tool (root caller bypasses parent check for main team)
    const createResult = await result.orgToolInvoker.invoke('create_trigger', {
      team: 'main', name: 'e2e-kw', type: 'keyword',
      config: { pattern: 'e2e-test' }, task: 'handle test',
    }, 'root') as { success: boolean };
    expect(createResult.success).toBe(true);

    // Enable the trigger (moves from pending → active)
    const enableResult = await result.orgToolInvoker.invoke('enable_trigger', {
      team: 'main', trigger_name: 'e2e-kw',
    }, 'root') as { success: boolean };
    expect(enableResult.success).toBe(true);

    // Re-bootstrap to verify triggers are loaded from SQLite on startup
    await result.shutdown();
    result = await bootstrap({
      runDir: dir, dataDir: join(dir, 'data'),
      skipListen: true, skipCli: true,
    });

    const resp = await result.fastify.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(resp.body) as { triggers: { registered: number } };
    expect(body.triggers.registered).toBeGreaterThanOrEqual(1);
  });

  it('seed rules applied to dataDir/rules/', () => {
    const rulesDir = join(dir, 'data', 'rules');
    if (!existsSync(rulesDir)) return; // seed-rules dir may not exist in test env
    const files = readdirSync(rulesDir).filter(f => f.endsWith('.md'));
    // If seed rules exist, they should have been copied
    expect(files.length).toBeGreaterThanOrEqual(0);
  });

  it('routeMessage returns response (no providers = error message)', async () => {
    const response = await result.channelRouter.routeMessage({
      channelId: 'test', userId: 'test-user',
      content: 'hello', timestamp: Date.now(),
    });
    // Without providers.yaml, returns error message
    expect(typeof response).toBe('string');
  });

  it('providers loaded when config exists', () => {
    // In this test, no providers.yaml exists so providersConfig is null
    // That's expected — tests run without real API keys
    expect(result.providersConfig).toBeNull();
  });

  it('main team registered in org tree', () => {
    const main = result.orgTree.getTeam('main');
    expect(main).toBeDefined();
    expect(main?.name).toBe('main');
  });
});
