/**
 * update_team tool tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setupServer, makeNode } from '../__test-helpers.js';
import type { ServerFixtures } from '../__test-helpers.js';

describe('update_team', () => {
  let f: ServerFixtures;

  beforeEach(() => {
    f = setupServer();
    f.orgTree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    f.orgTree.addTeam(makeNode({ teamId: 'ops-team', name: 'ops-team', parentId: 'root' }));
    f.orgTree.addScopeKeywords('ops-team', ['monitoring', 'logs']);
  });

  it('adds scope keywords to existing team', async () => {
    const result = await f.server.invoke('update_team', {
      team: 'ops-team', scope_add: ['alerting', 'incidents'],
    }, 'root') as { success: boolean; scope: string[] };

    expect(result.success).toBe(true);
    expect(result.scope).toContain('alerting');
    expect(result.scope).toContain('incidents');
    expect(result.scope).toContain('monitoring');
    expect(result.scope).toContain('logs');
  });

  it('removes scope keywords from existing team', async () => {
    const result = await f.server.invoke('update_team', {
      team: 'ops-team', scope_remove: ['logs'],
    }, 'root') as { success: boolean; scope: string[] };

    expect(result.success).toBe(true);
    expect(result.scope).not.toContain('logs');
    expect(result.scope).toContain('monitoring');
  });

  it('adds and removes in single call', async () => {
    const result = await f.server.invoke('update_team', {
      team: 'ops-team', scope_add: ['alerting'], scope_remove: ['logs'],
    }, 'root') as { success: boolean; scope: string[] };

    expect(result.success).toBe(true);
    expect(result.scope).toContain('alerting');
    expect(result.scope).toContain('monitoring');
    expect(result.scope).not.toContain('logs');
  });

  it('rejects if team not found', async () => {
    const result = await f.server.invoke('update_team', {
      team: 'nonexistent', scope_add: ['x'],
    }, 'root') as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('rejects if caller is not parent', async () => {
    f.orgTree.addTeam(makeNode({ teamId: 'other-team', name: 'other-team', parentId: 'root' }));

    const result = await f.server.invoke('update_team', {
      team: 'ops-team', scope_add: ['x'],
    }, 'other-team') as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('not parent');
  });

  it('allows root caller bypass', async () => {
    const result = await f.server.invoke('update_team', {
      team: 'ops-team', scope_add: ['alerting'],
    }, 'root') as { success: boolean };

    expect(result.success).toBe(true);
  });

  it('rejects if no fields provided (empty arrays)', async () => {
    const result = await f.server.invoke('update_team', {
      team: 'ops-team', scope_add: [], scope_remove: [],
    }, 'root') as { success: boolean; error: string };

    expect(result.success).toBe(false);
  });

  it('rejects if removal would leave zero scope — DB unchanged', async () => {
    const result = await f.server.invoke('update_team', {
      team: 'ops-team', scope_remove: ['monitoring', 'logs'],
    }, 'root') as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('zero scope');

    // DB should be unchanged
    const scope = f.orgTree.getOwnScope('ops-team');
    expect(scope).toContain('monitoring');
    expect(scope).toContain('logs');
  });

  it('returns resulting scope array', async () => {
    const result = await f.server.invoke('update_team', {
      team: 'ops-team', scope_add: ['alerting'],
    }, 'root') as { success: boolean; scope: string[] };

    expect(result.success).toBe(true);
    expect(Array.isArray(result.scope)).toBe(true);
    expect(result.scope.length).toBe(3);
  });

  it('overlapping add/remove in same call produces correct result', async () => {
    // Adding and removing the same keyword: remove wins (it's removed from target set)
    const result = await f.server.invoke('update_team', {
      team: 'ops-team', scope_add: ['monitoring'], scope_remove: ['monitoring'],
    }, 'root') as { success: boolean; scope: string[] };

    // monitoring was in current, added back, then removed — net result: removed
    expect(result.success).toBe(true);
    expect(result.scope).not.toContain('monitoring');
    expect(result.scope).toContain('logs');
  });

  it('adding already-existing keyword is a no-op', async () => {
    const result = await f.server.invoke('update_team', {
      team: 'ops-team', scope_add: ['monitoring'],
    }, 'root') as { success: boolean; scope: string[] };

    expect(result.success).toBe(true);
    expect(result.scope).toContain('monitoring');
    expect(result.scope).toContain('logs');
    expect(result.scope.length).toBe(2);
  });
});
