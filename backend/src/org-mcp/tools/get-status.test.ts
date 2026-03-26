/**
 * get_status tool tests.
 *
 * Migrated from phase-gates/layer-5.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setupServer, makeNode } from '../__test-helpers.js';
import type { ServerFixtures } from '../__test-helpers.js';

describe('get_status', () => {
  let f: ServerFixtures;

  beforeEach(() => {
    f = setupServer();
    f.orgTree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    f.orgTree.addTeam(makeNode({ teamId: 'team-a', name: 'team-a', parentId: 'root' }));
    f.orgTree.addTeam(makeNode({ teamId: 'team-b', name: 'team-b', parentId: 'root' }));
  });

  it('returns all children when no team specified', async () => {
    const result = await f.server.invoke('get_status', {}, 'root');

    const typed = result as { success: boolean; teams: Array<{ teamId: string }> };
    expect(typed.success).toBe(true);
    expect(typed.teams).toHaveLength(2);
    const ids = typed.teams.map((t) => t.teamId).sort();
    expect(ids).toEqual(['team-a', 'team-b']);
  });

  it('returns specific child team status', async () => {
    const result = await f.server.invoke('get_status', { team: 'team-a' }, 'root');

    const typed = result as { success: boolean; teams: Array<{ teamId: string; queueDepth: number }> };
    expect(typed.success).toBe(true);
    expect(typed.teams).toHaveLength(1);
    expect(typed.teams[0].teamId).toBe('team-a');
    expect(typed.teams[0].queueDepth).toBe(0);
  });

  it('shows correct queue depth', async () => {
    f.taskQueue.enqueue('team-a', 'task 1', 'normal');
    f.taskQueue.enqueue('team-a', 'task 2', 'high');
    f.taskQueue.enqueue('team-b', 'task 3', 'normal');

    const result = await f.server.invoke('get_status', { team: 'team-a' }, 'root');

    const typed = result as { success: boolean; teams: Array<{ queueDepth: number; pendingCount: number }> };
    expect(typed.teams[0].queueDepth).toBe(2);
    expect(typed.teams[0].pendingCount).toBe(2);
  });

  it('rejects when target is not child of caller', async () => {
    f.orgTree.addTeam(makeNode({ teamId: 'stranger', name: 'stranger' }));

    const result = await f.server.invoke('get_status', { team: 'team-a' }, 'stranger');

    const typed = result as { success: boolean; error: string };
    expect(typed.success).toBe(false);
    expect(typed.error).toContain('not a child');
  });
});
