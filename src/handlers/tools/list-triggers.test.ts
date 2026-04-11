/**
 * list_triggers tool tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TriggerConfig } from '../../domain/types.js';
import { setupServer, makeNode } from '../__test-helpers.js';
import { createToolInvoker } from '../tool-invoker.js';
import type { ServerFixtures } from '../__test-helpers.js';
import type { OrgToolInvoker } from '../tool-invoker.js';
import type { TriggerInfo } from './list-triggers.js';

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

describe('list_triggers', () => {
  let f: ServerFixtures;
  let triggers: Map<string, TriggerConfig>;
  let server: OrgToolInvoker;

  beforeEach(() => {
    f = setupServer();
    f.orgTree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    f.orgTree.addTeam(makeNode({ teamId: 'ops-team', name: 'ops-team', parentId: 'root' }));
    triggers = new Map();
    ({ server } = createTriggerServer(f, triggers));
  });

  it('includes overlapPolicy, overlapCount, and activeTaskId in response', async () => {
    triggers.set('ops-team:fetch-logs', {
      name: 'fetch-logs',
      type: 'schedule',
      team: 'ops-team',
      config: { cron: '*/5 * * * *' },
      task: 'Check logs',
      state: 'active',
      maxTurns: 100,
      failureThreshold: 3,
      consecutiveFailures: 1,
      overlapPolicy: 'always-skip',
      overlapCount: 2,
      activeTaskId: 'task-123',
    });

    const result = await server.invoke('list_triggers', {
      team: 'ops-team',
    }, 'root') as { success: boolean; triggers: TriggerInfo[] };

    expect(result.success).toBe(true);
    expect(result.triggers).toHaveLength(1);
    expect(result.triggers[0].overlapPolicy).toBe('always-skip');
    expect(result.triggers[0].overlapCount).toBe(2);
    expect(result.triggers[0].activeTaskId).toBe('task-123');
  });

  it('defaults overlap fields when not set on config', async () => {
    triggers.set('ops-team:basic', {
      name: 'basic',
      type: 'keyword',
      team: 'ops-team',
      config: { pattern: 'test' },
      task: 'Do basic stuff',
      state: 'pending',
      maxTurns: 50,
    });

    const result = await server.invoke('list_triggers', {
      team: 'ops-team',
    }, 'root') as { success: boolean; triggers: TriggerInfo[] };

    expect(result.success).toBe(true);
    expect(result.triggers).toHaveLength(1);
    expect(result.triggers[0].overlapPolicy).toBe('skip-then-replace');
    expect(result.triggers[0].overlapCount).toBe(0);
    expect(result.triggers[0].activeTaskId).toBeNull();
  });
});
