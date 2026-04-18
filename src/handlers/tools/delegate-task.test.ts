/**
 * delegate_task tool tests.
 *
 * Migrated from phase-gates/layer-5.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setupServer, makeNode, makeTeamConfig } from '../__test-helpers.js';
import type { ServerFixtures } from '../__test-helpers.js';
import { TaskStatus } from '../../domain/types.js';
import type { TaskEntry } from '../../domain/types.js';
import type { DelegateTaskResult } from './delegate-task.js';

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

  it('threads sourceChannelId into task queue options', async () => {
    const result = await f.server.invoke(
      'delegate_task',
      { team: 'weather-team', task: 'check NYC weather' },
      'root',
      'ws:abc123',
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(f.taskQueue.tasks).toHaveLength(1);
    expect(f.taskQueue.tasks[0].sourceChannelId).toBe('ws:abc123');
  });

  it('enqueues without sourceChannelId when none provided', async () => {
    const result = await f.server.invoke(
      'delegate_task',
      { team: 'weather-team', task: 'check weather' },
      'root',
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(f.taskQueue.tasks[0].sourceChannelId).toBeNull();
  });

  describe('delegate_task concurrency', () => {
    beforeEach(() => {
      f.orgTree.addTeam(makeNode({ teamId: 'ops', name: 'ops', parentId: 'root' }));
      f.teamConfigs.set('ops', makeTeamConfig({ name: 'ops' }));
    });

    function seedTask(overrides: Partial<TaskEntry> & { teamId: string }): TaskEntry {
      const entry: TaskEntry = {
        id: `pre-seed-${String(Math.random()).slice(2, 8)}`,
        task: 'existing task',
        priority: 'normal',
        type: 'delegate',
        status: TaskStatus.Pending,
        createdAt: new Date().toISOString(),
        correlationId: null,
        result: null,
        durationMs: null,
        options: null,
        sourceChannelId: null,
        ...overrides,
      };
      f.taskQueue.tasks.push(entry);
      return entry;
    }

    it('default policy is confirm → requires_confirmation when team has active work', async () => {
      seedTask({ teamId: 'ops', type: 'bootstrap', status: TaskStatus.Running });
      const r = await f.server.invoke('delegate_task', { team: 'ops', task: 'x' }, 'root') as DelegateTaskResult;
      expect(r.enqueued).toBe(false);
      expect(r.requires_confirmation).toBe(true);
      expect(r.overlap_policy_applied).toBe('confirm');
      expect(r.in_flight?.[0]?.type).toBe('bootstrap');
    });

    it('skip → returns enqueued:false, still success:true', async () => {
      seedTask({ teamId: 'ops', type: 'delegate', status: TaskStatus.Pending });
      const r = await f.server.invoke('delegate_task', { team: 'ops', task: 'x', overlap_policy: 'skip' }, 'root') as DelegateTaskResult;
      expect(r.success).toBe(true);
      expect(r.enqueued).toBe(false);
      expect(r.overlap_policy_applied).toBe('skip');
    });

    it('allow → enqueues despite active work', async () => {
      seedTask({ teamId: 'ops', type: 'bootstrap', status: TaskStatus.Running });
      const r = await f.server.invoke('delegate_task', { team: 'ops', task: 'x', overlap_policy: 'allow' }, 'root') as DelegateTaskResult;
      expect(r.enqueued).toBe(true);
      expect(r.task_id).toBeTruthy();
    });

    it('replace with pending-only → cancels pending, enqueues', async () => {
      const pending = seedTask({ teamId: 'ops', type: 'delegate', status: TaskStatus.Pending });
      const r = await f.server.invoke('delegate_task', { team: 'ops', task: 'x', overlap_policy: 'replace' }, 'root') as DelegateTaskResult;
      expect(r.enqueued).toBe(true);
      expect(f.taskQueue.getActiveForTeam('ops').map((t) => t.id)).not.toContain(pending.id);
    });

    it('replace with non-stale running → downgrade to requires_confirmation', async () => {
      seedTask({ teamId: 'ops', type: 'bootstrap', status: TaskStatus.Running, createdAt: new Date().toISOString() });
      const r = await f.server.invoke('delegate_task', { team: 'ops', task: 'x', overlap_policy: 'replace' }, 'root') as DelegateTaskResult;
      expect(r.enqueued).toBe(false);
      expect(r.requires_confirmation).toBe(true);
      expect(r.reason).toBe('replace_targets_running_session');
    });

    it('invalid overlap_policy is rejected by the Zod schema', async () => {
      const r = await f.server.invoke('delegate_task', { team: 'ops', task: 'x', overlap_policy: 'bogus' as unknown as 'wait' }, 'root') as DelegateTaskResult;
      expect(r.success).toBe(false);
      expect(r.reason).toMatch(/overlap_policy/i);
    });

    it('team-not-found → success:false, no concurrency fields', async () => {
      const r = await f.server.invoke('delegate_task', { team: 'ghost', task: 'x' }, 'root') as DelegateTaskResult;
      expect(r.success).toBe(false);
      expect(r.enqueued).toBeUndefined();
      expect(r.requires_confirmation).toBeUndefined();
    });

    it('caller-not-parent → success:false, no concurrency fields', async () => {
      const r = await f.server.invoke('delegate_task', { team: 'ops', task: 'x' }, 'stranger') as DelegateTaskResult;
      expect(r.success).toBe(false);
      expect(r.requires_confirmation).toBeUndefined();
    });

    it('in_flight projects task_id/type/status/age_ms correctly', async () => {
      seedTask({
        teamId: 'ops',
        type: 'bootstrap',
        status: TaskStatus.Running,
        createdAt: new Date(Date.now() - 5000).toISOString(),
      });
      const r = await f.server.invoke('delegate_task', { team: 'ops', task: 'x' }, 'root') as DelegateTaskResult;
      expect(r.in_flight?.[0]).toMatchObject({
        task_id: expect.any(String) as unknown,
        type: 'bootstrap',
        status: 'running',
        age_ms: expect.any(Number) as unknown,
      });
      expect(r.in_flight?.[0]?.age_ms).toBeGreaterThanOrEqual(5000);
    });
  });
});
