/**
 * UT-6: Tool registration + R-1: Error handling tests
 *
 * Migrated from phase-gates/layer-5.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OrgToolInvoker } from './registry.js';
import { createToolInvoker } from './registry.js';
import { setupServer, makeTeamConfig, makeNode } from './__test-helpers.js';
import type { ServerFixtures } from './__test-helpers.js';

// ── UT-6: Tool Registration ──────────────────────────────────────────────

describe('UT-6: Core tools registered', () => {
  let server: OrgToolInvoker;

  beforeEach(() => {
    ({ server } = setupServer());
  });

  it('registers exactly 10 core tools (trigger tools require configStore)', () => {
    expect(server.tools.size).toBe(10);
  });

  it('registers update_team with correct name', () => {
    const tool = server.tools.get('update_team');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('update_team');
    expect(tool!.description).toBeTruthy();
    expect(tool!.inputSchema).toBeDefined();
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

// ── Trigger tool registration (requires configStore + triggerEngine) ────

describe('Trigger tools registered with configStore + triggerEngine', () => {
  it('registers trigger management tools when triggerConfigStore and triggerEngine are provided', () => {
    const f = setupServer();
    const mockConfigStore = {
      upsert: vi.fn(), remove: vi.fn(), removeByTeam: vi.fn(),
      getByTeam: vi.fn().mockReturnValue([]), getAll: vi.fn().mockReturnValue([]),
      setState: vi.fn(), incrementFailures: vi.fn(), resetFailures: vi.fn(),
      get: vi.fn(),
    };
    const mockTriggerEngine = {
      replaceTeamTriggers: vi.fn(), removeTeamTriggers: vi.fn(),
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
      log: () => {},
      triggerConfigStore: mockConfigStore,
      triggerEngine: mockTriggerEngine as never,
    });

    expect(server.tools.has('create_trigger')).toBe(true);
    expect(server.tools.has('enable_trigger')).toBe(true);
    expect(server.tools.has('disable_trigger')).toBe(true);
    expect(server.tools.has('list_triggers')).toBe(true);
    expect(server.tools.has('test_trigger')).toBe(true);
    expect(server.tools.has('update_trigger')).toBe(true);
    expect(server.tools.has('sync_team_triggers')).toBe(false);
  });

  it('test_trigger threads sourceChannelId via scoped queue', () => {
    const f = setupServer();
    const mockConfigStore = {
      upsert: vi.fn(), remove: vi.fn(), removeByTeam: vi.fn(),
      getByTeam: vi.fn().mockReturnValue([]), getAll: vi.fn().mockReturnValue([]),
      setState: vi.fn(), incrementFailures: vi.fn(), resetFailures: vi.fn(),
      get: vi.fn().mockReturnValue({ task: 'run test', maxTurns: 100 }),
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
      log: () => {},
      triggerConfigStore: mockConfigStore,
      triggerEngine: { replaceTeamTriggers: vi.fn(), removeTeamTriggers: vi.fn() } as never,
    });

    f.orgTree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    f.orgTree.addTeam(makeNode({ teamId: 'trigger-team', name: 'trigger-team', parentId: 'root' }));

    server.invoke('test_trigger', { team: 'trigger-team', trigger_name: 'my-trig' }, 'root', 'ws:xyz');

    expect(f.taskQueue.tasks).toHaveLength(1);
    expect(f.taskQueue.tasks[0].sourceChannelId).toBe('ws:xyz');
  });

  it('test_trigger preserves max_turns alongside sourceChannelId', async () => {
    const f = setupServer();
    const mockConfigStore = {
      upsert: vi.fn(), remove: vi.fn(), removeByTeam: vi.fn(),
      getByTeam: vi.fn().mockReturnValue([]), getAll: vi.fn().mockReturnValue([]),
      setState: vi.fn(), incrementFailures: vi.fn(), resetFailures: vi.fn(),
      get: vi.fn().mockReturnValue({ task: 'run test', maxTurns: 100 }),
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
      log: () => {},
      triggerConfigStore: mockConfigStore,
      triggerEngine: { replaceTeamTriggers: vi.fn(), removeTeamTriggers: vi.fn() } as never,
    });

    f.orgTree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    f.orgTree.addTeam(makeNode({ teamId: 'trigger-team', name: 'trigger-team', parentId: 'root' }));

    await server.invoke('test_trigger', { team: 'trigger-team', trigger_name: 'my-trig', max_turns: 50 }, 'root', 'ws:xyz');

    expect(f.taskQueue.tasks).toHaveLength(1);
    const opts = JSON.parse(f.taskQueue.tasks[0].options!) as Record<string, unknown>;
    expect(opts.max_turns).toBe(50);
    expect(f.taskQueue.tasks[0].sourceChannelId).toBe('ws:xyz');
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
