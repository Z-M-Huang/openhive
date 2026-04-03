/**
 * update_trigger tool tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TriggerConfig } from '../../domain/types.js';
import { setupServer, makeNode } from '../__test-helpers.js';
import { createToolInvoker } from '../tool-invoker.js';
import type { ServerFixtures } from '../__test-helpers.js';
import type { OrgToolInvoker } from '../tool-invoker.js';

function createTriggerServer(f: ServerFixtures, triggers: Map<string, TriggerConfig>) {
  const mockConfigStore = {
    upsert: vi.fn((config: TriggerConfig) => {
      triggers.set(`${config.team}:${config.name}`, config);
    }),
    remove: vi.fn(),
    removeByTeam: vi.fn(),
    getByTeam: vi.fn((team: string) => [...triggers.values()].filter(t => t.team === team)),
    getAll: vi.fn(() => [...triggers.values()]),
    setState: vi.fn(),
    incrementFailures: vi.fn(),
    resetFailures: vi.fn(),
    get: vi.fn((team: string, name: string) => triggers.get(`${team}:${name}`)),
  };

  const mockTriggerEngine = {
    replaceTeamTriggers: vi.fn(),
    removeTeamTriggers: vi.fn(),
  };

  const server = createToolInvoker({
    orgTree: f.orgTree,
    spawner: f.spawner,
    sessionManager: f.sessionManager,
    taskQueue: f.taskQueue,
    escalationStore: f.escalationStore,
    runDir: '/tmp/openhive-test',
    loadConfig: () => { throw new Error('no config'); },
    getTeamConfig: () => undefined,
    log: (msg, meta) => { f.logMessages.push({ msg, meta }); },
    triggerConfigStore: mockConfigStore,
    triggerEngine: mockTriggerEngine as never,
  });

  return { server, mockConfigStore, mockTriggerEngine };
}

describe('update_trigger', () => {
  let f: ServerFixtures;
  let triggers: Map<string, TriggerConfig>;
  let server: OrgToolInvoker;
  let mockConfigStore: ReturnType<typeof createTriggerServer>['mockConfigStore'];
  let mockTriggerEngine: ReturnType<typeof createTriggerServer>['mockTriggerEngine'];

  beforeEach(() => {
    f = setupServer();
    f.orgTree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    f.orgTree.addTeam(makeNode({ teamId: 'ops-team', name: 'ops-team', parentId: 'root' }));

    triggers = new Map();
    triggers.set('ops-team:fetch-logs', {
      name: 'fetch-logs',
      type: 'schedule',
      team: 'ops-team',
      config: { cron: '*/2 * * * *' },
      task: 'Check logs for errors',
      state: 'active',
      maxTurns: 100,
      failureThreshold: 3,
      consecutiveFailures: 0,
      sourceChannelId: 'ws:abc',
      skill: 'log-check',
    });

    ({ server, mockConfigStore, mockTriggerEngine } = createTriggerServer(f, triggers));
  });

  it('updates trigger config (cron)', async () => {
    const result = await server.invoke('update_trigger', {
      team: 'ops-team', trigger_name: 'fetch-logs',
      config: { cron: '*/5 * * * *' },
    }, 'root') as { success: boolean; trigger_name: string };

    expect(result.success).toBe(true);
    expect(result.trigger_name).toBe('fetch-logs');
    expect(mockConfigStore.upsert).toHaveBeenCalledWith(expect.objectContaining({
      config: { cron: '*/5 * * * *' },
    }));
  });

  it('updates trigger task text', async () => {
    const result = await server.invoke('update_trigger', {
      team: 'ops-team', trigger_name: 'fetch-logs',
      task: 'Check for critical errors only',
    }, 'root') as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockConfigStore.upsert).toHaveBeenCalledWith(expect.objectContaining({
      task: 'Check for critical errors only',
    }));
  });

  it('updates both config and task', async () => {
    const result = await server.invoke('update_trigger', {
      team: 'ops-team', trigger_name: 'fetch-logs',
      config: { cron: '*/10 * * * *' },
      task: 'New task text',
    }, 'root') as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockConfigStore.upsert).toHaveBeenCalledWith(expect.objectContaining({
      config: { cron: '*/10 * * * *' },
      task: 'New task text',
    }));
  });

  it('re-registers active trigger via replaceTeamTriggers', async () => {
    await server.invoke('update_trigger', {
      team: 'ops-team', trigger_name: 'fetch-logs',
      config: { cron: '*/5 * * * *' },
    }, 'root');

    expect(mockTriggerEngine.replaceTeamTriggers).toHaveBeenCalledWith('ops-team', expect.any(Array));
  });

  it('does NOT re-register pending/disabled trigger', async () => {
    triggers.set('ops-team:fetch-logs', {
      ...triggers.get('ops-team:fetch-logs')!,
      state: 'pending',
    });

    await server.invoke('update_trigger', {
      team: 'ops-team', trigger_name: 'fetch-logs',
      task: 'Updated task',
    }, 'root');

    expect(mockTriggerEngine.replaceTeamTriggers).not.toHaveBeenCalled();
  });

  it('rejects if team not found', async () => {
    const result = await server.invoke('update_trigger', {
      team: 'nonexistent', trigger_name: 'fetch-logs',
      task: 'x',
    }, 'root') as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('rejects if caller is not parent', async () => {
    f.orgTree.addTeam(makeNode({ teamId: 'other', name: 'other', parentId: 'root' }));

    const result = await server.invoke('update_trigger', {
      team: 'ops-team', trigger_name: 'fetch-logs',
      task: 'x',
    }, 'other') as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('not parent');
  });

  it('allows root caller bypass', async () => {
    const result = await server.invoke('update_trigger', {
      team: 'ops-team', trigger_name: 'fetch-logs',
      task: 'Updated',
    }, 'root') as { success: boolean };

    expect(result.success).toBe(true);
  });

  it('rejects if trigger not found', async () => {
    const result = await server.invoke('update_trigger', {
      team: 'ops-team', trigger_name: 'nonexistent',
      task: 'x',
    }, 'root') as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('rejects if no updatable field provided', async () => {
    const result = await server.invoke('update_trigger', {
      team: 'ops-team', trigger_name: 'fetch-logs',
    }, 'root') as { success: boolean; error: string };

    expect(result.success).toBe(false);
  });

  it('rejects invalid cron expression for active schedule trigger — DB unchanged', async () => {
    const before = triggers.get('ops-team:fetch-logs')!;

    const result = await server.invoke('update_trigger', {
      team: 'ops-team', trigger_name: 'fetch-logs',
      config: { cron: 'not-a-cron' },
    }, 'root') as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid cron');
    // DB should NOT have been mutated
    expect(mockConfigStore.upsert).not.toHaveBeenCalled();
    // Original config preserved
    expect(triggers.get('ops-team:fetch-logs')!.config).toEqual(before.config);
  });

  it('rejects invalid regex pattern for active keyword trigger — DB unchanged', async () => {
    triggers.set('ops-team:kw-trig', {
      name: 'kw-trig',
      type: 'keyword',
      team: 'ops-team',
      config: { pattern: 'valid' },
      task: 'check',
      state: 'active',
      maxTurns: 50,
      failureThreshold: 3,
    });

    const result = await server.invoke('update_trigger', {
      team: 'ops-team', trigger_name: 'kw-trig',
      config: { pattern: '[invalid(' },
    }, 'root') as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid regex');
    expect(mockConfigStore.upsert).not.toHaveBeenCalled();
  });

  it('preserves sourceChannelId and skill from existing trigger after update', async () => {
    await server.invoke('update_trigger', {
      team: 'ops-team', trigger_name: 'fetch-logs',
      task: 'New task',
    }, 'root');

    expect(mockConfigStore.upsert).toHaveBeenCalledWith(expect.objectContaining({
      sourceChannelId: 'ws:abc',
      skill: 'log-check',
    }));
  });

  it('maps max_turns → maxTurns and failure_threshold → failureThreshold correctly', async () => {
    await server.invoke('update_trigger', {
      team: 'ops-team', trigger_name: 'fetch-logs',
      max_turns: 200,
      failure_threshold: 10,
    }, 'root');

    expect(mockConfigStore.upsert).toHaveBeenCalledWith(expect.objectContaining({
      maxTurns: 200,
      failureThreshold: 10,
    }));
  });
});
