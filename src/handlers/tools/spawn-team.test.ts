/**
 * spawn_team tool tests — validation, spawner, filesystem, parent normalization,
 * scope_accepts, credential note.
 *
 * Migrated from phase-gates/layer-5.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as yamlParse } from 'yaml';
import { spawnTeam } from './spawn-team.js';
import { OrgTree } from '../../domain/org-tree.js';
import {
  setupServer,
  makeNode,
  makeTeamConfig,
  createMemoryOrgStore,
  createMockTaskQueue,
} from '../__test-helpers.js';
import type { ServerFixtures } from '../__test-helpers.js';

// ── spawn_team (via server invoker) ──────────────────────────────────────

describe('spawn_team', () => {
  let f: ServerFixtures;

  beforeEach(() => {
    f = setupServer();
  });

  it('creates org tree entry and calls spawner', async () => {
    f.teamConfigs.set('weather', makeTeamConfig({ name: 'weather' }));

    const result = await f.server.invoke('spawn_team', { name: 'weather', scope_accepts: ['weather'] }, 'root');

    expect(result).toEqual({ success: true, team: 'weather' });
    expect(f.orgTree.getTeam('weather')).toBeDefined();
    expect(f.orgTree.getTeam('weather')?.parentId).toBe('root');
    expect(f.spawner.spawn).toHaveBeenCalledWith('weather', 'weather');
  });

  it('rejects duplicate team name', async () => {
    f.teamConfigs.set('dup', makeTeamConfig({ name: 'dup' }));
    f.orgTree.addTeam(makeNode({ teamId: 'dup', name: 'dup' }));

    const result = await f.server.invoke('spawn_team', { name: 'dup', scope_accepts: ['test'] }, 'root');

    expect(result).toEqual(expect.objectContaining({ success: false }));
  });

  it('threads sourceChannelId into bootstrap task via registry', async () => {
    f.teamConfigs.set('routed-team', makeTeamConfig({ name: 'routed-team' }));

    const result = await f.server.invoke(
      'spawn_team',
      { name: 'routed-team', scope_accepts: ['test'] },
      'root',
      'ws:spawn123',
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    const initTask = f.taskQueue.tasks.find(t => t.teamId === 'routed-team');
    expect(initTask?.sourceChannelId).toBe('ws:spawn123');
  });

  it('rolls back org tree on spawn failure', async () => {
    f.teamConfigs.set('fail-team', makeTeamConfig({ name: 'fail-team' }));
    vi.mocked(f.spawner.spawn).mockRejectedValueOnce(new Error('docker unavailable'));

    const result = await f.server.invoke('spawn_team', { name: 'fail-team', scope_accepts: ['test'] }, 'root');

    expect(result).toEqual(expect.objectContaining({ success: false }));
    expect(f.orgTree.getTeam('fail-team')).toBeUndefined();
  });
});

// ── spawn_team filesystem and init ────────────────────────────────────────

describe('spawn_team filesystem and init', () => {
  let dir: string;
  let tree: OrgTree;
  let mockSpawner: { spawn: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  let mockTaskQueue: ReturnType<typeof createMockTaskQueue>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openhive-l5-fs-'));
    mkdirSync(join(dir, 'teams'), { recursive: true });
    const store = createMemoryOrgStore();
    tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    mockSpawner = { spawn: vi.fn().mockResolvedValue('sid'), stop: vi.fn() };
    mockTaskQueue = createMockTaskQueue();
  });

  function makeDeps(overrides?: Partial<Parameters<typeof spawnTeam>[2]>) {
    return {
      orgTree: tree,
      spawner: mockSpawner,
      runDir: dir,
      loadConfig: (_name: string, _cp?: string, hints?: { description?: string; scopeAccepts?: string[]; scopeRejects?: string[] }) => ({
        name: _name, parent: null, description: hints?.description ?? '',
        scope: { accepts: hints?.scopeAccepts ?? [], rejects: hints?.scopeRejects ?? [] },
        allowed_tools: ['*'], mcp_servers: [] as string[], provider_profile: 'default', maxTurns: 100,
      }),
      taskQueue: mockTaskQueue,
      ...overrides,
    };
  }

  it('scaffolds all 4 subdirectories', async () => {
    await spawnTeam({ name: 'ops', scope_accepts: ['ops'] }, 'root', makeDeps());
    for (const sub of ['org-rules', 'team-rules', 'skills', 'subagents']) {
      expect(existsSync(join(dir, 'teams', 'ops', sub))).toBe(true);
    }
  });

  it('writes config.yaml with correct content', async () => {
    await spawnTeam({ name: 'ops', description: 'My ops team', scope_accepts: ['logs'] }, 'root', makeDeps());
    const raw = readFileSync(join(dir, 'teams', 'ops', 'config.yaml'), 'utf-8');
    const cfg = yamlParse(raw) as Record<string, unknown>;
    expect(cfg['name']).toBe('ops');
    expect(cfg['description']).toBe('My ops team');
  });

  it('does not inject org into mcp_servers (org MCP removed)', async () => {
    await spawnTeam({ name: 'ops', scope_accepts: ['ops'] }, 'root', makeDeps());
    const raw = readFileSync(join(dir, 'teams', 'ops', 'config.yaml'), 'utf-8');
    const cfg = yamlParse(raw) as { mcp_servers: string[] };
    expect(cfg.mcp_servers).not.toContain('org');
  });

  it('preserves external mcp_servers without injecting org', async () => {
    const cfgPath = join(dir, 'no-org.yaml');
    writeFileSync(cfgPath, 'name: custom\nmcp_servers: [analytics]\nscope:\n  accepts: []\n  rejects: []\nallowed_tools: ["*"]\nprovider_profile: default\nmaxTurns: 50\n');
    const { loadTeamConfig } = await import('../../config/loader.js');
    const deps = makeDeps({ loadConfig: (_n, cp) => cp ? loadTeamConfig(cp) : makeDeps().loadConfig(_n) });
    await spawnTeam({ name: 'custom', config_path: cfgPath }, 'root', deps);
    const raw = readFileSync(join(dir, 'teams', 'custom', 'config.yaml'), 'utf-8');
    const cfg = yamlParse(raw) as { mcp_servers: string[] };
    expect(cfg.mcp_servers).not.toContain('org');
    expect(cfg.mcp_servers).toContain('analytics');
  });

  it('writes credentials to config.yaml', async () => {
    const testToken = 'test-fake-token-value-1234567890';
    await spawnTeam({ name: 'ops', scope_accepts: ['ops'], credentials: { api_key: testToken, subdomain: 'acme' } }, 'root', makeDeps());
    const raw = readFileSync(join(dir, 'teams', 'ops', 'config.yaml'), 'utf-8');
    const cfg = yamlParse(raw) as { credentials: Record<string, string> };
    expect(cfg.credentials['api_key']).toBe(testToken);
    expect(cfg.credentials['subdomain']).toBe('acme');
  });

  it('config has no credentials section when none provided', async () => {
    await spawnTeam({ name: 'ops', scope_accepts: ['ops'] }, 'root', makeDeps());
    const raw = readFileSync(join(dir, 'teams', 'ops', 'config.yaml'), 'utf-8');
    const cfg = yamlParse(raw) as { credentials?: Record<string, string> };
    expect(cfg.credentials).toBeUndefined();
  });

  it('writes team-context.md when init_context provided', async () => {
    await spawnTeam({ name: 'ops', scope_accepts: ['logs'], init_context: 'Monitor logs every 10 minutes' }, 'root', makeDeps());
    const content = readFileSync(join(dir, 'teams', 'ops', 'team-rules', 'team-context.md'), 'utf-8');
    expect(content).toBe('Monitor logs every 10 minutes');
  });

  it('does NOT write init-context.md when omitted', async () => {
    await spawnTeam({ name: 'ops', scope_accepts: ['ops'] }, 'root', makeDeps());
    expect(existsSync(join(dir, 'teams', 'ops', 'memory', 'init-context.md'))).toBe(false);
  });

  it('auto-queues init task with critical priority', async () => {
    await spawnTeam({ name: 'ops', scope_accepts: ['ops'], init_context: 'Setup instructions' }, 'root', makeDeps());
    expect(mockTaskQueue.tasks).toHaveLength(1);
    expect(mockTaskQueue.tasks[0].teamId).toBe('ops');
    expect(mockTaskQueue.tasks[0].priority).toBe('critical');
    expect(mockTaskQueue.tasks[0].task).toContain('Bootstrap');
  });

  it('rolls back dirs + org tree + session on enqueue failure', async () => {
    const failQueue = {
      ...mockTaskQueue,
      enqueue: () => { throw new Error('queue full'); },
    };
    const result = await spawnTeam({ name: 'ops', scope_accepts: ['ops'] }, 'root', makeDeps({ taskQueue: failQueue }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('init enqueue failed');
    expect(tree.getTeam('ops')).toBeUndefined();
    expect(existsSync(join(dir, 'teams', 'ops'))).toBe(false);
    expect(mockSpawner.stop).toHaveBeenCalledWith('ops');
  });

  it('cleans up on spawn failure', async () => {
    mockSpawner.spawn.mockRejectedValueOnce(new Error('docker down'));
    const result = await spawnTeam({ name: 'fail', scope_accepts: ['test'] }, 'root', makeDeps());
    expect(result.success).toBe(false);
    expect(tree.getTeam('fail')).toBeUndefined();
    expect(existsSync(join(dir, 'teams', 'fail'))).toBe(false);
  });
});

// ── spawn_team parent normalization ───────────────────────────────────────

describe('spawn_team parent normalization', () => {
  it('config.yaml parent field matches callerId', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'openhive-l5-parent-'));
    mkdirSync(join(dir2, 'teams'), { recursive: true });
    const store = createMemoryOrgStore();
    const tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));

    const result = await spawnTeam(
      { name: 'child-team', scope_accepts: ['test'], description: 'Test' },
      'root',
      {
        orgTree: tree,
        spawner: { spawn: vi.fn().mockResolvedValue('sid'), stop: vi.fn() },
        runDir: dir2,
        loadConfig: (_n: string, _cp?: string, hints?: { description?: string; scopeAccepts?: string[]; scopeRejects?: string[] }) => ({
          name: _n, parent: null, description: hints?.description ?? '',
          scope: { accepts: hints?.scopeAccepts ?? [], rejects: hints?.scopeRejects ?? [] },
          allowed_tools: ['*'], mcp_servers: [] as string[], provider_profile: 'default', maxTurns: 100,
        }),
        taskQueue: createMockTaskQueue(),
      },
    );
    expect(result.success).toBe(true);

    const raw = readFileSync(join(dir2, 'teams', 'child-team', 'config.yaml'), 'utf-8');
    const cfg = yamlParse(raw) as { parent: string };
    expect(cfg.parent).toBe('root');
  });
});

// ── spawn_team scope_accepts validation ───────────────────────────────────

describe('spawn_team scope_accepts validation', () => {
  it('rejects when no scope_accepts and no config_path', async () => {
    const result = await spawnTeam(
      { name: 'no-scope' },
      'root',
      {
        orgTree: new OrgTree(createMemoryOrgStore()),
        spawner: { spawn: vi.fn().mockResolvedValue('sid') },
        runDir: '/tmp/test',
        loadConfig: () => makeTeamConfig(),
        taskQueue: createMockTaskQueue(),
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('scope_accepts');
  });

  it('rejects scope_accepts with empty strings', async () => {
    const result = await spawnTeam(
      { name: 'empty-scope', scope_accepts: [''] },
      'root',
      {
        orgTree: new OrgTree(createMemoryOrgStore()),
        spawner: { spawn: vi.fn().mockResolvedValue('sid') },
        runDir: '/tmp/test',
        loadConfig: () => makeTeamConfig(),
        taskQueue: createMockTaskQueue(),
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid input');
  });

  it('allows spawn with config_path but no scope_accepts', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'openhive-l5-cfg-'));
    mkdirSync(join(dir2, 'teams'), { recursive: true });
    const cfgPath = join(dir2, 'custom.yaml');
    writeFileSync(cfgPath, 'name: custom\nscope:\n  accepts: [ops]\n  rejects: []\nallowed_tools: ["*"]\nmcp_servers: []\nprovider_profile: default\nmaxTurns: 50\n');

    const store = createMemoryOrgStore();
    const tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    const { loadTeamConfig: ltc } = await import('../../config/loader.js');

    const result = await spawnTeam(
      { name: 'custom', config_path: cfgPath },
      'root',
      {
        orgTree: tree,
        spawner: { spawn: vi.fn().mockResolvedValue('sid') },
        runDir: dir2,
        loadConfig: (_n, cp) => cp ? ltc(cp) : makeTeamConfig(),
        taskQueue: createMockTaskQueue(),
      },
    );
    expect(result.success).toBe(true);
  });
});

// ── spawn_team credential note ────────────────────────────────────────────

describe('spawn_team credential note', () => {
  let dir: string;
  let tree: OrgTree;
  let mockSpawner: { spawn: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  let mockTaskQueue: ReturnType<typeof createMockTaskQueue>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openhive-l5-note-'));
    mkdirSync(join(dir, 'teams'), { recursive: true });
    const store = createMemoryOrgStore();
    tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    mockSpawner = { spawn: vi.fn().mockResolvedValue('sid'), stop: vi.fn() };
    mockTaskQueue = createMockTaskQueue();
  });

  function makeDeps() {
    return {
      orgTree: tree,
      spawner: mockSpawner,
      runDir: dir,
      loadConfig: (_name: string, _cp?: string, hints?: { description?: string; scopeAccepts?: string[]; scopeRejects?: string[] }) => ({
        name: _name, parent: null, description: hints?.description ?? '',
        scope: { accepts: hints?.scopeAccepts ?? [], rejects: hints?.scopeRejects ?? [] },
        allowed_tools: ['*'], mcp_servers: [] as string[], provider_profile: 'default', maxTurns: 100,
      }),
      taskQueue: mockTaskQueue,
    };
  }

  it('returns note when credentials are provided', async () => {
    const result = await spawnTeam(
      { name: 'cred-team', scope_accepts: ['test'], credentials: { subdomain: 'test-fake-credential-1234' } },
      'root', makeDeps(),
    );
    expect(result.success).toBe(true);
    expect(result.note).toContain('Do NOT echo credential values');
  });

  it('does not return note when no credentials', async () => {
    const result = await spawnTeam(
      { name: 'no-cred', scope_accepts: ['test'] },
      'root', makeDeps(),
    );
    expect(result.success).toBe(true);
    expect(result.note).toBeUndefined();
  });
});
