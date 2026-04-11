/**
 * create_trigger tool tests.
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
  });

  return { server, mockConfigStore };
}

describe('create_trigger', () => {
  let f: ServerFixtures;
  let triggers: Map<string, TriggerConfig>;
  let server: OrgToolInvoker;
  let mockConfigStore: ReturnType<typeof createTriggerServer>['mockConfigStore'];

  beforeEach(() => {
    f = setupServer();
    f.orgTree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    f.orgTree.addTeam(makeNode({ teamId: 'ops-team', name: 'ops-team', parentId: 'root' }));
    triggers = new Map();
    ({ server, mockConfigStore } = createTriggerServer(f, triggers));
  });

  it('creates trigger with default overlap_policy', async () => {
    const result = await server.invoke('create_trigger', {
      team: 'ops-team', name: 'my-trigger', type: 'schedule',
      config: { cron: '*/5 * * * *' }, task: 'do stuff',
    }, 'root') as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockConfigStore.upsert).toHaveBeenCalledWith(expect.objectContaining({
      name: 'my-trigger',
      overlapPolicy: undefined,
    }));
  });

  it('creates trigger with explicit overlap_policy', async () => {
    const result = await server.invoke('create_trigger', {
      team: 'ops-team', name: 'my-trigger', type: 'schedule',
      config: { cron: '*/5 * * * *' }, task: 'do stuff',
      overlap_policy: 'always-skip',
    }, 'root') as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockConfigStore.upsert).toHaveBeenCalledWith(expect.objectContaining({
      name: 'my-trigger',
      overlapPolicy: 'always-skip',
    }));
  });

  it('creates trigger with allow overlap_policy', async () => {
    const result = await server.invoke('create_trigger', {
      team: 'ops-team', name: 'my-trigger', type: 'schedule',
      config: { cron: '*/5 * * * *' }, task: 'do stuff',
      overlap_policy: 'allow',
    }, 'root') as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockConfigStore.upsert).toHaveBeenCalledWith(expect.objectContaining({
      overlapPolicy: 'allow',
    }));
  });
});
