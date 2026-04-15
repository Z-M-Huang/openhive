/**
 * disable_trigger tool tests.
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
    setActiveTask: vi.fn(),
    clearActiveTask: vi.fn(),
    setOverlapCount: vi.fn(),
    resetOverlapState: vi.fn(),
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

describe('disable_trigger', () => {
  let f: ServerFixtures;
  let triggers: Map<string, TriggerConfig>;
  let server: OrgToolInvoker;
  let mockConfigStore: ReturnType<typeof createTriggerServer>['mockConfigStore'];

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
      task: 'Check logs',
      state: 'active',
      maxSteps: 100,
      failureThreshold: 3,
      consecutiveFailures: 0,
    });

    ({ server, mockConfigStore } = createTriggerServer(f, triggers));
  });

  it('calls setOverlapCount(0) on disable', async () => {
    const result = await server.invoke('disable_trigger', {
      team: 'ops-team', trigger_name: 'fetch-logs',
    }, 'root') as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockConfigStore.setOverlapCount).toHaveBeenCalledWith('ops-team', 'fetch-logs', 0);
  });

  it('calls setState to disabled', async () => {
    const result = await server.invoke('disable_trigger', {
      team: 'ops-team', trigger_name: 'fetch-logs',
      reason: 'maintenance',
    }, 'root') as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockConfigStore.setState).toHaveBeenCalledWith('ops-team', 'fetch-logs', 'disabled', 'maintenance');
  });
});
