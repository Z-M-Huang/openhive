/**
 * UT-10: list_teams tool tests.
 *
 * Migrated from phase-gates/layer-5.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TaskStatus } from '../../domain/types.js';
import { setupServer, makeNode, makeTeamConfig } from '../__test-helpers.js';
import type { ServerFixtures } from '../__test-helpers.js';

describe('UT-10: list_teams', () => {
  let f: ServerFixtures;

  beforeEach(() => {
    f = setupServer();
  });

  it('returns child teams with description and scope', async () => {
    f.orgTree.addTeam(makeNode({ teamId: 'main', name: 'main' }));
    f.teamConfigs.set('team-a', makeTeamConfig({
      name: 'team-a', description: 'Operations monitoring',
    }));
    f.orgTree.addTeam(makeNode({ teamId: 'team-a', name: 'team-a', parentId: 'main' }));
    f.orgTree.addScopeKeywords('team-a', ['operations', 'monitoring']);

    const result = await f.server.invoke('list_teams', {}, 'main');
    const typed = result as { success: boolean; teams: Array<{
      name: string; description: string; keywords: string[];
    }> };

    expect(typed.success).toBe(true);
    expect(typed.teams).toHaveLength(1);
    expect(typed.teams[0].name).toBe('team-a');
    expect(typed.teams[0].description).toBe('Operations monitoring');
    expect(typed.teams[0].keywords).toContain('operations');
    expect(typed.teams[0].keywords).toContain('monitoring');
  });

  it('returns empty array when caller has no children', async () => {
    f.orgTree.addTeam(makeNode({ teamId: 'main', name: 'main' }));
    const result = await f.server.invoke('list_teams', {}, 'main');
    const typed = result as { success: boolean; teams: unknown[] };
    expect(typed.success).toBe(true);
    expect(typed.teams).toHaveLength(0);
  });

  it('recursive mode returns nested children', async () => {
    f.orgTree.addTeam(makeNode({ teamId: 'main', name: 'main' }));
    f.teamConfigs.set('parent-ops', makeTeamConfig({ name: 'parent-ops' }));
    f.teamConfigs.set('child-logs', makeTeamConfig({ name: 'child-logs' }));
    f.orgTree.addTeam(makeNode({ teamId: 'parent-ops', name: 'parent-ops', parentId: 'main' }));
    f.orgTree.addTeam(makeNode({ teamId: 'child-logs', name: 'child-logs', parentId: 'parent-ops' }));

    const result = await f.server.invoke('list_teams', { recursive: true }, 'main');
    const typed = result as { success: boolean; teams: Array<{
      name: string; children?: Array<{ name: string }>;
    }> };

    expect(typed.success).toBe(true);
    expect(typed.teams[0].name).toBe('parent-ops');
    expect(typed.teams[0].children).toHaveLength(1);
    expect(typed.teams[0].children![0].name).toBe('child-logs');
  });

  it('returns own keywords only, not descendant keywords', async () => {
    f.orgTree.addTeam(makeNode({ teamId: 'main', name: 'main' }));
    f.teamConfigs.set('parent-ops', makeTeamConfig({ name: 'parent-ops' }));
    f.teamConfigs.set('child-logs', makeTeamConfig({ name: 'child-logs' }));
    f.orgTree.addTeam(makeNode({ teamId: 'parent-ops', name: 'parent-ops', parentId: 'main' }));
    f.orgTree.addTeam(makeNode({ teamId: 'child-logs', name: 'child-logs', parentId: 'parent-ops' }));
    f.orgTree.addScopeKeywords('parent-ops', ['operations']);
    f.orgTree.addScopeKeywords('child-logs', ['logs', 'archiving']);

    const result = await f.server.invoke('list_teams', { recursive: true }, 'main');
    const typed = result as { success: boolean; teams: Array<{
      name: string; keywords: string[]; children?: Array<{ name: string; keywords: string[] }>;
    }> };

    // parent-ops has only its own keywords, NOT child-logs' keywords
    expect(typed.teams[0].keywords).toEqual(['operations']);
    expect(typed.teams[0].keywords).not.toContain('logs');
    // child-logs has its own keywords
    expect(typed.teams[0].children![0].keywords).toContain('logs');
    expect(typed.teams[0].children![0].keywords).toContain('archiving');
  });

  it('handles team with no config gracefully (description defaults to empty)', async () => {
    f.orgTree.addTeam(makeNode({ teamId: 'main', name: 'main' }));
    // team-orphan has no config in teamConfigs map
    f.orgTree.addTeam(makeNode({ teamId: 'team-orphan', name: 'team-orphan', parentId: 'main' }));

    const result = await f.server.invoke('list_teams', {}, 'main');
    const typed = result as { success: boolean; teams: Array<{ name: string; description: string }> };

    expect(typed.success).toBe(true);
    const orphan = typed.teams.find(t => t.name === 'team-orphan');
    expect(orphan).toBeDefined();
    expect(orphan!.description).toBe('');
  });

  it('pendingCount only counts pending tasks, not completed/running', async () => {
    f.orgTree.addTeam(makeNode({ teamId: 'main', name: 'main' }));
    f.teamConfigs.set('busy-team', makeTeamConfig({ name: 'busy-team' }));
    f.orgTree.addTeam(makeNode({ teamId: 'busy-team', name: 'busy-team', parentId: 'main' }));
    // Enqueue tasks and move some to non-pending states
    f.taskQueue.enqueue('busy-team', 'task 1', 'normal', 'delegate');
    f.taskQueue.enqueue('busy-team', 'task 2', 'normal', 'delegate');
    const dequeued = f.taskQueue.dequeue('busy-team');  // moves task 1 to running
    if (dequeued) f.taskQueue.updateStatus(dequeued.id, TaskStatus.Completed);

    const result = await f.server.invoke('list_teams', {}, 'main');
    const typed = result as { success: boolean; teams: Array<{ pendingCount: number }> };
    expect(typed.success).toBe(true);
    // Only task 2 should be pending (task 1 is completed)
    expect(typed.teams[0].pendingCount).toBe(1);
  });

  it('respects MAX_DEPTH and does not infinitely recurse', async () => {
    f.orgTree.addTeam(makeNode({ teamId: 'main', name: 'main' }));
    // Create a chain deeper than MAX_DEPTH (10) — should truncate
    let parentId = 'main';
    for (let i = 0; i < 12; i++) {
      const id = `deep-${i}`;
      f.teamConfigs.set(id, makeTeamConfig({ name: id }));
      f.orgTree.addTeam(makeNode({ teamId: id, name: id, parentId }));
      parentId = id;
    }

    const result = await f.server.invoke('list_teams', { recursive: true }, 'main');
    expect((result as { success: boolean }).success).toBe(true);
    // Should complete without hanging — depth bound prevents runaway
  });

  it('registers list_teams with correct name', () => {
    const tool = f.server.tools.get('list_teams');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('list_teams');
    expect(tool!.description).toBeTruthy();
    expect(tool!.inputSchema).toBeDefined();
  });
});
