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
import { spawnTeam, jitteredCron, seedLearningTrigger, seedReflectionTrigger } from './spawn-team.js';
import type { ITriggerConfigStore } from '../../domain/interfaces.js';
import type { TriggerConfig, TriggerState } from '../../domain/types.js';
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

    expect(result).toMatchObject({ success: true, team: 'weather' });
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
      loadConfig: (_name: string, _cp?: string, hints?: { description?: string; parent?: string }) => ({
        name: _name, parent: hints?.parent ?? null, description: hints?.description ?? '',
        allowed_tools: ['*'], provider_profile: 'default', maxSteps: 100,
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

  it('does not include mcp_servers in output (clean-start)', async () => {
    await spawnTeam({ name: 'ops', scope_accepts: ['ops'] }, 'root', makeDeps());
    const raw = readFileSync(join(dir, 'teams', 'ops', 'config.yaml'), 'utf-8');
    const cfg = yamlParse(raw) as Record<string, unknown>;
    expect('mcp_servers' in cfg).toBe(false);
  });

  it('strips mcp_servers from input config (clean-start)', async () => {
    const cfgPath = join(dir, 'no-org.yaml');
    writeFileSync(cfgPath, 'name: custom\nmcp_servers: [analytics]\nallowed_tools: ["*"]\nprovider_profile: default\nmaxSteps: 50\n');
    const { loadTeamConfig } = await import('../../config/loader.js');
    const deps = makeDeps({ loadConfig: (_n, cp) => cp ? loadTeamConfig(cp) : makeDeps().loadConfig(_n) });
    await spawnTeam({ name: 'custom', config_path: cfgPath }, 'root', deps);
    const raw = readFileSync(join(dir, 'teams', 'custom', 'config.yaml'), 'utf-8');
    const cfg = yamlParse(raw) as Record<string, unknown>;
    expect('mcp_servers' in cfg).toBe(false);
  });

  it('rejects credentials when vaultStore is absent (AC-10: vault is sole source)', async () => {
    const testToken = 'test-fake-token-value-1234567890';
    const result = await spawnTeam(
      { name: 'ops', scope_accepts: ['ops'], credentials: { api_key: testToken, subdomain: 'acme' } },
      'root', makeDeps(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('vault');
    // Team dir must not be partially created on rejection.
    expect(existsSync(join(dir, 'teams', 'ops', 'config.yaml'))).toBe(false);
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

  it('bootstrap payload instructs creating subagents, plugins, skills, memory (AC-36)', async () => {
    await spawnTeam({ name: 'ops', scope_accepts: ['ops'] }, 'root', makeDeps());
    const payload = mockTaskQueue.tasks[0].task;
    expect(payload).toMatch(/subagents\//);
    expect(payload).toMatch(/plugins\//);
    expect(payload).toMatch(/skills\//);
    expect(payload).toMatch(/memory_save/);
    expect(payload.toLowerCase()).toMatch(/five-layer hierarchy/);
    expect(payload).toMatch(/register_plugin_tool/);
  });

  it('bootstrap payload includes five-layer hierarchy when init_context provided', async () => {
    await spawnTeam({ name: 'ops', scope_accepts: ['ops'], init_context: 'ctx' }, 'root', makeDeps());
    const payload = mockTaskQueue.tasks[0].task;
    expect(payload.toLowerCase()).toMatch(/five-layer hierarchy/);
    expect(payload).toMatch(/subagents\//);
    expect(payload).toMatch(/plugins\//);
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

  it('success path returns status:queued', async () => {
    const result = await spawnTeam({ name: 'ops', scope_accepts: ['ops'] }, 'root', makeDeps());
    expect(result.success).toBe(true);
    expect(result.status).toBe('queued');
  });

  it('success path returns a bootstrap_task_id matching the enqueued task', async () => {
    const result = await spawnTeam({ name: 'ops', scope_accepts: ['ops'] }, 'root', makeDeps());
    const enqueued = mockTaskQueue.getActiveForTeam('ops');
    expect(result.bootstrap_task_id).toBe(enqueued[0]?.id);
  });

  it('success path includes message_for_user referencing setup', async () => {
    const result = await spawnTeam({ name: 'ops', scope_accepts: ['ops'] }, 'root', makeDeps());
    expect(result.message_for_user).toMatch(/being set up|confirm.*ready/i);
  });

  it('duplicate team returns success:false and NO status field', async () => {
    await spawnTeam({ name: 'dup-ops', scope_accepts: ['ops'] }, 'root', makeDeps());
    const dup = await spawnTeam({ name: 'dup-ops', scope_accepts: ['ops'] }, 'root', makeDeps());
    expect(dup.success).toBe(false);
    expect(dup.error).toBeTruthy();
    expect(dup.status).toBeUndefined();
    expect(dup.bootstrap_task_id).toBeUndefined();
  });

  it('enqueue failure returns success:false and does not leak status:queued', async () => {
    const failQueue = {
      ...mockTaskQueue,
      enqueue: () => { throw new Error('queue full'); },
    };
    const result = await spawnTeam({ name: 'fail-enq', scope_accepts: ['test'] }, 'root', makeDeps({ taskQueue: failQueue }));
    expect(result.success).toBe(false);
    expect(result.status).toBeUndefined();
  });

  it('TaskConsumer ready notification text preserved', () => {
    const src = readFileSync(join(process.cwd(), 'src/sessions/task-consumer.ts'), 'utf8');
    expect(src).toContain('Team bootstrapped and ready.');
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
        loadConfig: (_n: string, _cp?: string, hints?: { description?: string; parent?: string }) => ({
          name: _n, parent: hints?.parent ?? null, description: hints?.description ?? '',
          allowed_tools: ['*'], provider_profile: 'default', maxSteps: 100,
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
    writeFileSync(cfgPath, 'name: custom\nallowed_tools: ["*"]\nprovider_profile: default\nmaxSteps: 50\n');

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
  let mockVaultStore: { set: ReturnType<typeof vi.fn>; removeByTeam: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openhive-l5-note-'));
    mkdirSync(join(dir, 'teams'), { recursive: true });
    const store = createMemoryOrgStore();
    tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    mockSpawner = { spawn: vi.fn().mockResolvedValue('sid'), stop: vi.fn() };
    mockTaskQueue = createMockTaskQueue();
    mockVaultStore = { set: vi.fn(), removeByTeam: vi.fn() };
  });

  // AC-10: vaultStore is required whenever credentials are provided. The
  // note path therefore always runs through vault, never through the removed
  // config.yaml fallback.
  function makeDeps() {
    return {
      orgTree: tree,
      spawner: mockSpawner,
      runDir: dir,
      loadConfig: (_name: string, _cp?: string, hints?: { description?: string; parent?: string }) => ({
        name: _name, parent: hints?.parent ?? null, description: hints?.description ?? '',
        allowed_tools: ['*'], provider_profile: 'default', maxSteps: 100,
      }),
      taskQueue: mockTaskQueue,
      vaultStore: mockVaultStore,
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

// ── spawn_team vault integration ─────────────────────────────────────────

describe('spawn_team vault integration', () => {
  let dir: string;
  let tree: OrgTree;
  let mockSpawner: { spawn: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  let mockTaskQueue: ReturnType<typeof createMockTaskQueue>;
  let mockVaultStore: { set: ReturnType<typeof vi.fn>; removeByTeam: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openhive-vault-spawn-'));
    mkdirSync(join(dir, 'teams'), { recursive: true });
    const store = createMemoryOrgStore();
    tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    mockSpawner = { spawn: vi.fn().mockResolvedValue('sid'), stop: vi.fn() };
    mockTaskQueue = createMockTaskQueue();
    mockVaultStore = { set: vi.fn(), removeByTeam: vi.fn() };
  });

  function makeDeps(overrides?: Partial<Parameters<typeof spawnTeam>[2]>) {
    return {
      orgTree: tree,
      spawner: mockSpawner,
      runDir: dir,
      loadConfig: (_name: string, _cp?: string, hints?: { description?: string; parent?: string }) => ({
        name: _name, parent: hints?.parent ?? null, description: hints?.description ?? '',
        allowed_tools: ['*'], provider_profile: 'default', maxSteps: 100,
      }),
      taskQueue: mockTaskQueue,
      vaultStore: mockVaultStore,
      ...overrides,
    };
  }

  it('writes credentials to vault with is_secret=true when vaultStore present', async () => {
    const testToken = 'test-fake-token-value-1234567890';
    await spawnTeam(
      { name: 'vault-team', scope_accepts: ['ops'], credentials: { api_key: testToken, subdomain: 'acme' } },
      'root', makeDeps(),
    );
    expect(mockVaultStore.set).toHaveBeenCalledWith('vault-team', 'api_key', testToken, true, 'root');
    expect(mockVaultStore.set).toHaveBeenCalledWith('vault-team', 'subdomain', 'acme', true, 'root');
    // Credentials should NOT be in config.yaml
    const raw = readFileSync(join(dir, 'teams', 'vault-team', 'config.yaml'), 'utf-8');
    const cfg = yamlParse(raw) as { credentials?: Record<string, string> };
    expect(cfg.credentials).toBeUndefined();
  });

  it('does not write to vault when no credentials provided', async () => {
    await spawnTeam(
      { name: 'no-cred-vault', scope_accepts: ['ops'] },
      'root', makeDeps(),
    );
    expect(mockVaultStore.set).not.toHaveBeenCalled();
  });

  it('cleans vault on spawn failure', async () => {
    mockSpawner.spawn.mockRejectedValueOnce(new Error('docker down'));
    const result = await spawnTeam(
      { name: 'fail-vault', scope_accepts: ['test'], credentials: { key: 'test-fake-secret-value-12345' } },
      'root', makeDeps(),
    );
    expect(result.success).toBe(false);
    expect(mockVaultStore.removeByTeam).toHaveBeenCalledWith('fail-vault');
  });

  it('cleans vault on enqueue failure', async () => {
    const failQueue = {
      ...mockTaskQueue,
      enqueue: () => { throw new Error('queue full'); },
    };
    const result = await spawnTeam(
      { name: 'fail-enqueue', scope_accepts: ['test'], credentials: { key: 'test-fake-secret-value-12345' } },
      'root', makeDeps({ taskQueue: failQueue }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('init enqueue failed');
    expect(mockVaultStore.removeByTeam).toHaveBeenCalledWith('fail-enqueue');
  });

  it('init task mentions vault_get when vaultStore present', async () => {
    await spawnTeam(
      { name: 'vault-init', scope_accepts: ['ops'], init_context: 'Setup with vault' },
      'root', makeDeps(),
    );
    const initTask = mockTaskQueue.tasks.find(t => t.teamId === 'vault-init');
    expect(initTask?.task).toContain('vault_get');
    expect(initTask?.task).not.toContain('get_credential');
  });

  it('init task always mentions vault_get even without vaultStore', async () => {
    await spawnTeam(
      { name: 'legacy-init', scope_accepts: ['ops'], init_context: 'Setup without vault' },
      'root', makeDeps({ vaultStore: undefined }),
    );
    const initTask = mockTaskQueue.tasks.find(t => t.teamId === 'legacy-init');
    expect(initTask?.task).toContain('vault_get');
    expect(initTask?.task).not.toContain('get_credential');
  });
});

// ── Learning-cycle trigger seeding ──────────────────────────────────────

function createMockTriggerConfigStore(): ITriggerConfigStore & { configs: TriggerConfig[] } {
  const configs: TriggerConfig[] = [];
  return {
    configs,
    upsert(config: TriggerConfig): void {
      const idx = configs.findIndex(c => c.team === config.team && c.name === config.name);
      if (idx >= 0) configs[idx] = config;
      else configs.push(config);
    },
    remove(_team: string, _name: string): void {
      const idx = configs.findIndex(c => c.team === _team && c.name === _name);
      if (idx >= 0) configs.splice(idx, 1);
    },
    removeByTeam(team: string): void {
      for (let i = configs.length - 1; i >= 0; i--) {
        if (configs[i].team === team) configs.splice(i, 1);
      }
    },
    getByTeam(team: string): TriggerConfig[] {
      return configs.filter(c => c.team === team);
    },
    getAll(): TriggerConfig[] {
      return [...configs];
    },
    setState(team: string, name: string, state: TriggerState): void {
      const c = configs.find(x => x.team === team && x.name === name);
      if (c) (c as { state: TriggerState }).state = state;
    },
    incrementFailures(): number { return 0; },
    resetFailures(): void { /* no-op */ },
    get(team: string, name: string): TriggerConfig | undefined {
      return configs.find(c => c.team === team && c.name === name);
    },
    setActiveTask(): void { /* no-op */ },
    clearActiveTask(): void { /* no-op */ },
    setOverlapCount(): void { /* no-op */ },
    resetOverlapState(): void { /* no-op */ },
  };
}

describe('jitteredCron', () => {
  it('returns a valid cron with minute 0-30 at hour 2', () => {
    const cron = jitteredCron('test-team');
    const match = /^(\d{1,2}) 2 \* \* \*$/.exec(cron);
    expect(match).not.toBeNull();
    const minute = Number(match![1]);
    expect(minute).toBeGreaterThanOrEqual(0);
    expect(minute).toBeLessThan(31);
  });

  it('is deterministic — same name produces same cron', () => {
    expect(jitteredCron('analytics')).toBe(jitteredCron('analytics'));
  });

  it('different names produce different minutes (with high probability)', () => {
    const a = jitteredCron('alpha');
    const b = jitteredCron('beta');
    // Not guaranteed to differ but overwhelmingly likely for distinct names
    expect(a !== b || a === b).toBe(true); // always true — real check is the set below
    const minutes = new Set(['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map(n => jitteredCron(n)));
    expect(minutes.size).toBeGreaterThan(1);
  });
});

describe('seedLearningTrigger', () => {
  it('creates active learning-cycle trigger with always-skip overlap', () => {
    const store = createMockTriggerConfigStore();
    seedLearningTrigger('ops', undefined, store);
    expect(store.configs).toHaveLength(1);
    const trigger = store.configs[0];
    expect(trigger.name).toBe('learning-cycle');
    expect(trigger.team).toBe('ops');
    expect(trigger.state).toBe('active');
    expect(trigger.type).toBe('schedule');
    expect(trigger.overlapPolicy).toBe('always-skip');
    expect(trigger.subagent).toBeUndefined();
  });

  it('does not overwrite existing trigger (get-guard)', () => {
    const store = createMockTriggerConfigStore();
    // Pre-populate with an enabled trigger
    store.upsert({
      name: 'learning-cycle', type: 'schedule', team: 'ops',
      config: { cron: '0 3 * * *' }, task: 'custom task', state: 'active',
    });
    seedLearningTrigger('ops', undefined, store);
    expect(store.configs).toHaveLength(1);
    expect(store.configs[0].state).toBe('active');
    expect(store.configs[0].task).toBe('custom task');
  });

  it('is a no-op when store is undefined', () => {
    // Should not throw
    seedLearningTrigger('ops');
  });

  it('uses jittered cron schedule', () => {
    const store = createMockTriggerConfigStore();
    seedLearningTrigger('my-team', undefined, store);
    const cfg = store.configs[0].config as { cron: string };
    expect(cfg.cron).toBe(jitteredCron('my-team'));
  });

  // AC-17: per-subagent learning-cycle seeding.
  it('names trigger `learning-cycle-{subagent}` and sets subagent field when provided', () => {
    const store = createMockTriggerConfigStore();
    seedLearningTrigger('ops', 'research-analyst', store);
    expect(store.configs).toHaveLength(1);
    const trigger = store.configs[0];
    expect(trigger.name).toBe('learning-cycle-research-analyst');
    expect(trigger.team).toBe('ops');
    expect(trigger.subagent).toBe('research-analyst');
    expect(trigger.state).toBe('active');
    expect(trigger.overlapPolicy).toBe('always-skip');
  });

  it('per-subagent seeding is independent of generic seeding (separate rows)', () => {
    const store = createMockTriggerConfigStore();
    seedLearningTrigger('ops', undefined, store);
    seedLearningTrigger('ops', 'analyst', store);
    seedLearningTrigger('ops', 'writer', store);
    expect(store.configs.map(c => c.name).sort()).toEqual([
      'learning-cycle', 'learning-cycle-analyst', 'learning-cycle-writer',
    ]);
    // Subagent-scoped rows carry the subagent field; generic does not.
    expect(store.configs.find(c => c.name === 'learning-cycle')!.subagent).toBeUndefined();
    expect(store.configs.find(c => c.name === 'learning-cycle-analyst')!.subagent).toBe('analyst');
    expect(store.configs.find(c => c.name === 'learning-cycle-writer')!.subagent).toBe('writer');
  });

  it('per-subagent seeding is idempotent on repeat call', () => {
    const store = createMockTriggerConfigStore();
    seedLearningTrigger('ops', 'analyst', store);
    seedLearningTrigger('ops', 'analyst', store);
    expect(store.configs).toHaveLength(1);
  });
});

// AC-18: per-subagent reflection-cycle seeding mirrors learning-cycle.
describe('seedReflectionTrigger', () => {
  it('creates generic reflection-cycle when no subagent is provided', () => {
    const store = createMockTriggerConfigStore();
    seedReflectionTrigger('ops', undefined, store);
    expect(store.configs).toHaveLength(1);
    expect(store.configs[0].name).toBe('reflection-cycle');
    expect(store.configs[0].subagent).toBeUndefined();
    expect(store.configs[0].maxSteps).toBe(30);
  });

  it('names trigger `reflection-cycle-{subagent}` and sets subagent when provided', () => {
    const store = createMockTriggerConfigStore();
    seedReflectionTrigger('ops', 'research-analyst', store);
    expect(store.configs).toHaveLength(1);
    const trigger = store.configs[0];
    expect(trigger.name).toBe('reflection-cycle-research-analyst');
    expect(trigger.subagent).toBe('research-analyst');
    expect(trigger.maxSteps).toBe(30);
    expect(trigger.state).toBe('active');
  });

  it('is a no-op when store is undefined', () => {
    seedReflectionTrigger('ops');
  });

  it('per-subagent seeding produces one row per subagent', () => {
    const store = createMockTriggerConfigStore();
    seedReflectionTrigger('ops', 'analyst', store);
    seedReflectionTrigger('ops', 'writer', store);
    expect(store.configs).toHaveLength(2);
    expect(store.configs.map(c => c.name).sort()).toEqual([
      'reflection-cycle-analyst', 'reflection-cycle-writer',
    ]);
  });
});

describe('spawn_team learning trigger integration', () => {
  let dir: string;
  let tree: OrgTree;
  let mockSpawner: { spawn: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  let mockTaskQueue: ReturnType<typeof createMockTaskQueue>;
  let mockTriggerStore: ReturnType<typeof createMockTriggerConfigStore>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openhive-trigger-seed-'));
    mkdirSync(join(dir, 'teams'), { recursive: true });
    const store = createMemoryOrgStore();
    tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    mockSpawner = { spawn: vi.fn().mockResolvedValue('sid'), stop: vi.fn() };
    mockTaskQueue = createMockTaskQueue();
    mockTriggerStore = createMockTriggerConfigStore();
  });

  function makeDeps(overrides?: Partial<Parameters<typeof spawnTeam>[2]>) {
    return {
      orgTree: tree,
      spawner: mockSpawner,
      runDir: dir,
      loadConfig: (_name: string, _cp?: string, hints?: { description?: string; parent?: string }) => ({
        name: _name, parent: hints?.parent ?? null, description: hints?.description ?? '',
        allowed_tools: ['*'], provider_profile: 'default', maxSteps: 100,
      }),
      taskQueue: mockTaskQueue,
      triggerConfigStore: mockTriggerStore,
      ...overrides,
    };
  }

  // Bug #1: spawn_team no longer seeds learning/reflection triggers at spawn time.
  // Subagents don't exist yet — the bootstrap task creates them, and seeding now
  // happens after bootstrap completion in task-consumer via seedLearningTriggersForTeam.
  it('does NOT seed learning/reflection triggers at spawn time', async () => {
    const result = await spawnTeam({ name: 'analytics', scope_accepts: ['data'] }, 'root', makeDeps());
    expect(result.success).toBe(true);
    expect(mockTriggerStore.configs).toHaveLength(0);
  });

  it('does not seed trigger when triggerConfigStore is absent', async () => {
    const result = await spawnTeam(
      { name: 'no-trigger', scope_accepts: ['test'] }, 'root',
      makeDeps({ triggerConfigStore: undefined }),
    );
    expect(result.success).toBe(true);
    expect(mockTriggerStore.configs).toHaveLength(0);
  });

  it('does not overwrite existing learning-cycle trigger on re-spawn attempt', async () => {
    // Pre-seed an active trigger
    mockTriggerStore.upsert({
      name: 'learning-cycle', type: 'schedule', team: 'reuse',
      config: { cron: '0 3 * * *' }, task: 'custom', state: 'active',
    });
    // Unit-level guard on seedLearningTrigger: pre-existing active trigger is not overwritten.
    seedLearningTrigger('reuse', undefined, mockTriggerStore);
    expect(mockTriggerStore.configs).toHaveLength(1);
    expect(mockTriggerStore.configs[0].state).toBe('active');
  });
});
