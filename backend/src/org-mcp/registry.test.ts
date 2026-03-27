/**
 * UT-6: Tool registration + R-1: Error handling tests
 *
 * Migrated from phase-gates/layer-5.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OrgToolInvoker } from './registry.js';
import { setupServer, makeTeamConfig } from './__test-helpers.js';
import type { ServerFixtures } from './__test-helpers.js';

// ── UT-6: Tool Registration ──────────────────────────────────────────────

describe('UT-6: Core tools registered', () => {
  let server: OrgToolInvoker;

  beforeEach(() => {
    ({ server } = setupServer());
  });

  it('registers exactly 9 core tools (trigger tools require configStore)', () => {
    expect(server.tools.size).toBe(9);
  });

  it('registers spawn_team with correct name', () => {
    const tool = server.tools.get('spawn_team');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('spawn_team');
    expect(tool!.description).toBeTruthy();
    expect(tool!.inputSchema).toBeDefined();
  });

  it('registers shutdown_team with correct name', () => {
    const tool = server.tools.get('shutdown_team');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('shutdown_team');
  });

  it('registers delegate_task with correct name', () => {
    const tool = server.tools.get('delegate_task');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('delegate_task');
  });

  it('registers escalate with correct name', () => {
    const tool = server.tools.get('escalate');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('escalate');
  });

  it('registers send_message with correct name', () => {
    const tool = server.tools.get('send_message');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('send_message');
  });

  it('registers get_status with correct name', () => {
    const tool = server.tools.get('get_status');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('get_status');
  });

  it('registers query_team with correct name', () => {
    const tool = server.tools.get('query_team');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('query_team');
    expect(tool!.description).toBeTruthy();
    expect(tool!.inputSchema).toBeDefined();
  });

  it('registers get_credential with correct name', () => {
    const tool = server.tools.get('get_credential');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('get_credential');
    expect(tool!.description).toBeTruthy();
    expect(tool!.inputSchema).toBeDefined();
  });
});

// ── R-1: Server error handling ──────────────────────────────────────────

describe('R-1: Server error handling', () => {
  let f: ServerFixtures;

  beforeEach(() => {
    f = setupServer();
  });

  it('returns error for unknown tool', async () => {
    const result = await f.server.invoke('nonexistent_tool', {}, 'root');

    const typed = result as { success: boolean; error: string };
    expect(typed.success).toBe(false);
    expect(typed.error).toContain('unknown tool');
  });

  it('catches handler exceptions and returns error', async () => {
    // Force an exception by making spawner throw
    f.teamConfigs.set('boom', makeTeamConfig({ name: 'boom' }));
    vi.mocked(f.spawner.spawn).mockRejectedValueOnce(new Error('kaboom'));

    const result = await f.server.invoke('spawn_team', { name: 'boom', scope_accepts: ['test'] }, 'root');

    const typed = result as { success: boolean; error: string };
    expect(typed.success).toBe(false);
    // The error is handled inside spawnTeam, not at the server catch level
    expect(typed.error).toContain('spawn failed');
  });
});
