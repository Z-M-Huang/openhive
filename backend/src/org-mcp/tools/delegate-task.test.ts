/**
 * delegate_task tool tests.
 *
 * Migrated from phase-gates/layer-5.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setupServer, makeNode, makeTeamConfig } from '../__test-helpers.js';
import type { ServerFixtures } from '../__test-helpers.js';

describe('delegate_task', () => {
  let f: ServerFixtures;

  beforeEach(() => {
    f = setupServer();
    f.orgTree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    f.orgTree.addTeam(makeNode({ teamId: 'weather-team', name: 'weather-team', parentId: 'root' }));
    f.orgTree.addScopeKeywords('weather-team', ['weather', 'forecast']);
    f.teamConfigs.set('weather-team', makeTeamConfig({ name: 'weather-team' }));
  });

  it('admits task matching accept scope and enqueues', async () => {
    const result = await f.server.invoke(
      'delegate_task',
      { team: 'weather-team', task: 'get weather forecast for NYC' },
      'root',
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    const typed = result as { success: boolean; task_id: string };
    expect(typed.task_id).toBeTruthy();
    expect(f.taskQueue.tasks).toHaveLength(1);
    expect(f.taskQueue.tasks[0].teamId).toBe('weather-team');
  });

  it('validates caller is parent', async () => {
    f.orgTree.addTeam(makeNode({ teamId: 'stranger', name: 'stranger' }));

    const result = await f.server.invoke(
      'delegate_task',
      { team: 'weather-team', task: 'get weather' },
      'stranger',
    );

    const typed = result as { success: boolean; reason: string };
    expect(typed.success).toBe(false);
    expect(typed.reason).toContain('not parent');
  });

  it('uses specified priority', async () => {
    const result = await f.server.invoke(
      'delegate_task',
      { team: 'weather-team', task: 'urgent weather alert', priority: 'critical' },
      'root',
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(f.taskQueue.tasks[0].priority).toBe('critical');
  });
});
