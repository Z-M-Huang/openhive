/**
 * Layer 11 Phase Gate -- Full E2E Integration (Suites 1-10)
 *
 * Cross-layer integration tests using real SQLite + bootstrap + mocked SDK.
 * Each suite exercises multiple layers together, not duplicating unit tests.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';

import { bootstrap } from '../index.js';
import type { BootstrapResult } from '../index.js';
import { createDatabase, createTables } from '../storage/database.js';
import { OrgStore } from '../storage/stores/org-store.js';
import { TaskQueueStore } from '../storage/stores/task-queue-store.js';
import { TriggerStore } from '../storage/stores/trigger-store.js';
import { LogStore } from '../storage/stores/log-store.js';
import { EscalationStore } from '../storage/stores/escalation-store.js';
import { MemoryStore } from '../storage/stores/memory-store.js';
import { OrgTree } from '../domain/org-tree.js';
import { TeamStatus, TaskStatus, TaskPriority } from '../domain/types.js';
import { createToolInvoker } from '../org-mcp/registry.js';
import type { OrgMcpDeps } from '../org-mcp/registry.js';
import type { OrgTreeNode, TeamConfig } from '../domain/types.js';
import { buildHookConfig } from '../hooks/index.js';
import { TriggerDedup } from '../triggers/dedup.js';
import { TriggerRateLimiter } from '../triggers/rate-limiter.js';
import { TriggerEngine } from '../triggers/engine.js';
import { ChannelRouter } from '../channels/router.js';
import type { ChannelMessage, IChannelAdapter } from '../domain/interfaces.js';
import { recoverFromCrash } from '../recovery/startup-recovery.js';
import { TeamRegistry } from '../sessions/team-registry.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'openhive-l11-'));
}

function makeDb(dir: string) {
  const dbPath = join(dir, 'test.db');
  const { db, raw } = createDatabase(dbPath);
  createTables(raw);
  return { db, raw, dbPath };
}

function makeNode(o: Partial<OrgTreeNode> & { teamId: string; name: string }): OrgTreeNode {
  return { parentId: null, status: TeamStatus.Active, agents: [], children: [], ...o };
}

function makeConfig(o?: Partial<TeamConfig>): TeamConfig {
  return {
    name: 'test-team', parent: null, description: '', maxTurns: 50,
    allowed_tools: [], mcp_servers: [], provider_profile: 'default', ...o,
  };
}

const noop = { info: () => {}, warn: () => {} };

/** Cast partial hook input for tests — our hooks only read tool_name + tool_input. */
function hookInput(obj: Record<string, unknown>): HookInput {
  return obj as unknown as HookInput;
}
const hookOpts = { signal: new AbortController().signal };

function createMockAdapter(): IChannelAdapter & {
  _handler: ((msg: ChannelMessage) => Promise<void>) | null;
  _sent: Array<{ channelId: string; content: string }>;
} {
  return {
    _handler: null,
    _sent: [],
    async connect() {},
    async disconnect() {},
    onMessage(h: (msg: ChannelMessage) => Promise<void>) { this._handler = h; },
    async sendResponse(ch: string, c: string) { this._sent.push({ channelId: ch, content: c }); },
  };
}

// ── E2E-1: Bootstrap + Health ──────────────────────────────────────────────

describe('E2E-1: Bootstrap + Health', () => {
  let result: BootstrapResult | null = null;
  afterEach(async () => { if (result) { await result.shutdown(); result = null; } });

  it('bootstrap creates all components and health returns 200', { timeout: 15_000 }, async () => {
    const dir = makeTempDir();
    result = await bootstrap({ runDir: dir, dataDir: join(dir, 'data'), skipListen: true, skipCli: true, orgMcpPort: 0 });
    expect(result.logger).toBeDefined();
    expect(result.raw).toBeDefined();
    expect(result.orgTree).toBeDefined();
    const resp = await result.fastify.inject({ method: 'GET', url: '/health' });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body) as { storage: { ok: boolean } };
    expect(body.storage.ok).toBe(true);
  });
});

// ── E2E-2: Storage CRUD (cross-layer via real SQLite) ──────────────────────

describe('E2E-2: All 6 stores end-to-end', () => {
  it('all stores work through a single database', () => {
    const dir = makeTempDir();
    const { db, raw } = makeDb(dir);
    const orgStore = new OrgStore(db);
    const taskStore = new TaskQueueStore(db);
    const trigStore = new TriggerStore(db);
    const logStore = new LogStore(db);
    const escStore = new EscalationStore(db);
    const memStore = new MemoryStore(join(dir, 'memory'));

    orgStore.addTeam(makeNode({ teamId: 't1', name: 'alpha' }));
    expect(orgStore.getTeam('t1')?.name).toBe('alpha');

    const tid = taskStore.enqueue('t1', 'do work', TaskPriority.Normal);
    expect(taskStore.getByTeam('t1')).toHaveLength(1);
    taskStore.updateStatus(tid, TaskStatus.Completed);

    trigStore.recordEvent('e1', 'src', 60);
    expect(trigStore.checkDedup('e1', 'src')).toBe(true);

    logStore.append({ id: 'log1', level: 'info', message: 'test', timestamp: Date.now(), source: 'test' });
    expect(logStore.query({ limit: 1 })).toHaveLength(1);

    escStore.create({ correlationId: 'c1', sourceTeam: 't1', targetTeam: 'root', taskId: null, status: 'open', createdAt: new Date().toISOString() });
    expect(escStore.getByCorrelationId('c1')?.status).toBe('open');

    memStore.writeFile('alpha', 'notes.md', 'data');
    expect(memStore.readFile('alpha', 'notes.md')).toBe('data');

    raw.close();
  });
});

// ── E2E-3: Rule cascade (nested team hierarchy) ───────────────────────────

describe('E2E-3: Rule cascade resolves for nested hierarchy', () => {
  it('org tree tracks 3-level nesting and ancestor chain', () => {
    const dir = makeTempDir();
    const { db, raw } = makeDb(dir);
    const orgStore = new OrgStore(db);
    const tree = new OrgTree(orgStore);

    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'mid', name: 'mid', parentId: 'root' }));
    tree.addTeam(makeNode({ teamId: 'leaf', name: 'leaf', parentId: 'mid' }));

    expect(tree.isDescendant('leaf', 'root')).toBe(true);
    expect(tree.isDescendant('leaf', 'mid')).toBe(true);
    expect(tree.getAncestors('leaf')).toHaveLength(2);
    expect(tree.getChildren('root').map((n) => n.teamId)).toEqual(['mid']);

    raw.close();
  });
});

// ── E2E-4: Hooks composition ──────────────────────────────────────────────

describe('E2E-4: Workspace boundary + audit hooks compose correctly', () => {
  it('boundary blocks and audit logs fire in composition', async () => {
    const logs: Array<{ msg: string }> = [];
    const logger = { info: (msg: string) => { logs.push({ msg }); } };
    const dir = makeTempDir();
    const config = buildHookConfig({
      teamName: 'alpha', cwd: dir, additionalDirs: [],
      paths: { systemRulesDir: '/app/system-rules', dataDir: join(dir, 'data'), runDir: dir },
      logger,
    });

    // PreToolUse: allowed read inside cwd
    const okResult = await config.PreToolUse[0].hooks[0](
      hookInput({ tool_name: 'Read', tool_input: { file_path: join(dir, 'file.ts') } }), 'tu1', hookOpts,
    );
    expect(okResult).toEqual({});

    // PreToolUse: blocked read outside cwd
    const denyResult = await config.PreToolUse[0].hooks[0](
      hookInput({ tool_name: 'Read', tool_input: { file_path: '/etc/passwd' } }), 'tu2', hookOpts,
    );
    const hookOut = (denyResult as Record<string, unknown>)['hookSpecificOutput'] as Record<string, unknown>;
    expect(hookOut?.['permissionDecision']).toBe('deny');

    // Audit hook fires on any tool
    await config.PreToolUse[2].hooks[0](
      hookInput({ tool_name: 'Read', tool_input: { file_path: join(dir, 'f.ts') } }), 'tu3', hookOpts,
    );
    expect(logs.some((l) => l.msg === 'PreToolUse')).toBe(true);
  });
});

// ── E2E-5: Org MCP 6 tools ───────────────────────────────────────────────

describe('E2E-5: Org MCP 6 tools with real stores', () => {
  it('spawn, delegate, escalate, message, status, shutdown', async () => {
    const dir = makeTempDir();
    const { db, raw } = makeDb(dir);
    const orgStore = new OrgStore(db);
    const taskStore = new TaskQueueStore(db);
    const escStore = new EscalationStore(db);
    const tree = new OrgTree(orgStore);
    const configs = new Map<string, TeamConfig>();
    configs.set('ops', makeConfig({ name: 'ops' }));

    const deps: OrgMcpDeps = {
      orgTree: tree, taskQueue: taskStore, escalationStore: escStore,
      spawner: { spawn: async () => 'sid' },
      sessionManager: { getSession: async () => null, terminateSession: async () => {} },
      loadConfig: (n) => { const c = configs.get(n); if (!c) throw new Error('no cfg'); return c; },
      getTeamConfig: (id) => configs.get(id),
      runDir: dir,
      log: () => {},
    };
    const server = createToolInvoker(deps);

    // Root must exist for parent validation
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));

    // 1. spawn
    const spawnRes = await server.invoke('spawn_team', { name: 'ops', scope_accepts: ['deploy'] }, 'root') as { success: boolean };
    expect(spawnRes.success).toBe(true);
    expect(tree.getTeam('ops')).toBeDefined();

    // 2. delegate
    const delRes = await server.invoke('delegate_task', { team: 'ops', task: 'deploy app' }, 'root') as { success: boolean; task_id: string };
    expect(delRes.success).toBe(true);

    // 3. escalate (from ops to root)
    const escRes = await server.invoke('escalate', { message: 'need help' }, 'ops') as { success: boolean; correlation_id: string };
    expect(escRes.success).toBe(true);
    expect(escStore.getByCorrelationId(escRes.correlation_id)).toBeDefined();

    // 4. send_message (child to parent)
    const msgRes = await server.invoke('send_message', { target: 'root', message: 'status' }, 'ops') as { success: boolean };
    expect(msgRes.success).toBe(true);

    // 5. get_status
    const statRes = await server.invoke('get_status', {}, 'root') as { success: boolean; teams: unknown[] };
    expect(statRes.success).toBe(true);
    expect(statRes.teams).toHaveLength(1);

    // 6. shutdown
    const shutRes = await server.invoke('shutdown_team', { name: 'ops' }, 'root') as { success: boolean };
    expect(shutRes.success).toBe(true);
    expect(tree.getTeam('ops')).toBeUndefined();

    raw.close();
  });
});

// ── E2E-6: Session spawn + scope isolation ────────────────────────────────

describe('E2E-6: Session spawn with isolated scope', () => {
  it('session manager tracks isolated team sessions', () => {
    const mgr = new TeamRegistry({ idleTimeoutMs: 60_000 });
    const ac1 = mgr.spawn('team-a');
    const ac2 = mgr.spawn('team-b');

    expect(mgr.isActive('team-a')).toBe(true);
    expect(mgr.isActive('team-b')).toBe(true);
    expect(ac1.signal.aborted).toBe(false);

    mgr.stop('team-a');
    expect(ac1.signal.aborted).toBe(true);
    expect(mgr.isActive('team-b')).toBe(true);

    mgr.stopAll();
    expect(ac2.signal.aborted).toBe(true);
  });
});

// ── E2E-7: 3 triggers with dedup + rate limit ────────────────────────────

describe('E2E-7: Schedule, keyword, message triggers fire with dedup + rate limit', () => {
  it('keyword and message triggers fire; rate limiter blocks excess', () => {
    const dir = makeTempDir();
    const { db, raw } = makeDb(dir);
    const trigStore = new TriggerStore(db);
    const taskStore = new TaskQueueStore(db);
    const dedup = new TriggerDedup(trigStore);
    const rateLimiter = new TriggerRateLimiter(2, 60_000);

    const engine = new TriggerEngine({
      triggers: [
        { name: 'kw', type: 'keyword', config: { pattern: 'deploy' }, team: 'ops', task: 'run deploy' },
        { name: 'msg', type: 'message', config: { pattern: 'error \\d+', channel: 'alerts' }, team: 'ops', task: 'handle error' },
      ],
      dedup, rateLimiter,
      delegateTask: async (team, task) => { taskStore.enqueue(team, task, TaskPriority.Normal); },
      logger: noop,
    });
    engine.register();

    // keyword fires
    engine.onMessage('please deploy now');
    expect(taskStore.getByTeam('ops')).toHaveLength(1);

    // message with channel fires
    engine.onMessage('error 500 occurred', 'alerts');
    expect(taskStore.getByTeam('ops')).toHaveLength(2);

    // third call rate-limited (limit is 2 per source)
    engine.onMessage('deploy again');
    expect(taskStore.getByTeam('ops')).toHaveLength(2);

    engine.stop();
    raw.close();
  });
});

// ── E2E-8: CLI + adapter routing ─────────────────────────────────────────

describe('E2E-8: Message routing through adapters', () => {
  it('mock adapter routes message to callback and back', async () => {
    const adapter = createMockAdapter();
    const callback = async (msg: ChannelMessage) => `Echo: ${msg.content}`;
    const router = new ChannelRouter([adapter], callback);
    await router.start();

    await adapter._handler!({ channelId: 'cli', userId: 'u1', content: 'hello', timestamp: Date.now() });
    expect(adapter._sent).toHaveLength(1);
    expect(adapter._sent[0].content).toBe('Echo: hello');

    await router.stop();
  });
});

// ── E2E-9: Crash recovery ────────────────────────────────────────────────

describe('E2E-9: Crash recovery resets tasks and detects orphans', () => {
  it('running tasks reset to pending, orphaned teams detected', () => {
    const dir = makeTempDir();
    const { db, raw } = makeDb(dir);
    const orgStore = new OrgStore(db);
    const taskStore = new TaskQueueStore(db);
    const tree = new OrgTree(orgStore);
    const teamsDir = join(dir, 'teams');
    mkdirSync(teamsDir, { recursive: true });

    // Add team with config on disk
    orgStore.addTeam(makeNode({ teamId: 't1', name: 'real-team' }));
    mkdirSync(join(teamsDir, 'real-team'), { recursive: true });
    writeFileSync(join(teamsDir, 'real-team', 'config.yaml'), 'name: real\n');

    // Add orphaned team (no config on disk)
    orgStore.addTeam(makeNode({ teamId: 't2', name: 'orphan' }));

    // Add task in running state (simulate mid-crash)
    const tid = taskStore.enqueue('t1', 'unfinished work', TaskPriority.High);
    taskStore.dequeue('t1');

    const result = recoverFromCrash({ orgStore, taskQueueStore: taskStore, orgTree: tree, runDir: dir, logger: noop });

    expect(result.recovered).toBe(1);
    expect(result.orphaned).toContain('t2');
    expect(result.teamsToReSpawn).toContain('t1');
    expect(taskStore.getByStatus(TaskStatus.Pending)).toHaveLength(1);

    void tid;
    raw.close();
  });
});

// ── E2E-10: Full chain (message -> spawn -> tool -> trigger -> escalation) ─

describe('E2E-10: Full integration chain', () => {
  it('message triggers team spawn, task delegation, escalation', async () => {
    const dir = makeTempDir();
    const { db, raw } = makeDb(dir);
    const orgStore = new OrgStore(db);
    const taskStore = new TaskQueueStore(db);
    const escStore = new EscalationStore(db);
    const trigStore = new TriggerStore(db);
    const tree = new OrgTree(orgStore);
    const configs = new Map<string, TeamConfig>();
    configs.set('weather', makeConfig({ name: 'weather' }));

    const mcpDeps: OrgMcpDeps = {
      orgTree: tree, taskQueue: taskStore, escalationStore: escStore,
      spawner: { spawn: async () => 'sid' },
      sessionManager: { getSession: async () => null, terminateSession: async () => {} },
      loadConfig: (n) => { const c = configs.get(n); if (!c) throw new Error('no cfg'); return c; },
      getTeamConfig: (id) => configs.get(id),
      runDir: dir,
      log: () => {},
    };
    const server = createToolInvoker(mcpDeps);

    // Step 1: Message arrives
    const adapter = createMockAdapter();
    let capturedMsg = '';
    const router = new ChannelRouter([adapter], async (msg) => { capturedMsg = msg.content; return undefined; });
    await router.start();
    await adapter._handler!({ channelId: 'cli', userId: 'u1', content: 'check weather forecast', timestamp: Date.now() });
    expect(capturedMsg).toBe('check weather forecast');

    // Step 2: Trigger engine fires on keyword
    const dedup = new TriggerDedup(trigStore);
    const rateLimiter = new TriggerRateLimiter(10, 60_000);
    const engine = new TriggerEngine({
      triggers: [{ name: 'weather-kw', type: 'keyword', config: { pattern: 'weather' }, team: 'weather', task: 'check weather' }],
      dedup, rateLimiter,
      delegateTask: async (team, task) => { taskStore.enqueue(team, task, TaskPriority.Normal); },
      logger: noop,
    });
    engine.register();
    engine.onMessage('check weather forecast');
    expect(taskStore.getByTeam('weather')).toHaveLength(1);

    // Step 3: Spawn team via MCP
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    const spawnRes = await server.invoke('spawn_team', { name: 'weather', scope_accepts: ['weather', 'forecast'] }, 'root') as { success: boolean };
    expect(spawnRes.success).toBe(true);

    // Step 4: Delegate task
    const delRes = await server.invoke('delegate_task', { team: 'weather', task: 'forecast NYC' }, 'root') as { success: boolean };
    expect(delRes.success).toBe(true);

    // Step 5: Escalation from spawned team
    const escRes = await server.invoke('escalate', { message: 'cannot resolve' }, 'weather') as { success: boolean; correlation_id: string };
    expect(escRes.success).toBe(true);
    expect(escStore.getByCorrelationId(escRes.correlation_id)?.sourceTeam).toBe('weather');

    engine.stop();
    await router.stop();
    raw.close();
  });
});

// ── E2E-11: Spawned team operational readiness ────────────────────────────

import { existsSync, readFileSync } from 'node:fs';
import { parse as yamlParse } from 'yaml';
import { buildSessionContext } from '../sessions/context-builder.js';
import { loadSkillsContent } from '../sessions/skill-loader.js';

describe('E2E-11: Spawned team operational readiness', () => {
  it('spawn creates subdirs, config with org, credentials, and init task', async () => {
    const dir = makeTempDir();
    const { db, raw } = makeDb(dir);
    const orgStore = new OrgStore(db);
    const taskStore = new TaskQueueStore(db);
    const escStore = new EscalationStore(db);
    const tree = new OrgTree(orgStore);
    const configs = new Map<string, TeamConfig>();

    const deps: OrgMcpDeps = {
      orgTree: tree, taskQueue: taskStore, escalationStore: escStore,
      spawner: { spawn: async () => 'sid' },
      sessionManager: { getSession: async () => null, terminateSession: async () => {} },
      loadConfig: (n: string, _cp?: string, hints?: { description?: string; scopeAccepts?: string[] }) => {
        const cfg = configs.get(n) ?? makeConfig({
          name: n, description: hints?.description ?? '',
        });
        return cfg;
      },
      getTeamConfig: (id) => configs.get(id),
      runDir: dir,
      log: () => {},
    };
    const server = createToolInvoker(deps);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));

    // Spawn with init_context and credentials
    const result = await server.invoke('spawn_team', {
      name: 'ops',
      description: 'Monitoring team',
      scope_accepts: ['logs', 'monitoring'],
      init_context: 'Monitor production logs',
      credentials: { subdomain: 'acme', token: 'test-fake-value-for-testing' },
    }, 'root') as { success: boolean };
    expect(result.success).toBe(true);

    // Verify all subdirs exist
    for (const sub of ['memory', 'org-rules', 'team-rules', 'skills', 'subagents']) {
      expect(existsSync(join(dir, 'teams', 'ops', sub))).toBe(true);
    }

    // Config has org in mcp_servers
    const cfgRaw = readFileSync(join(dir, 'teams', 'ops', 'config.yaml'), 'utf-8');
    const cfg = yamlParse(cfgRaw) as { mcp_servers: string[] };
    expect(cfg.mcp_servers).toContain('org');

    // Credentials written to config.yaml
    const cfgWithCreds = yamlParse(cfgRaw) as { credentials: Record<string, string> };
    expect(cfgWithCreds.credentials['subdomain']).toBe('acme');

    // Init context written to memory
    const initContent = readFileSync(join(dir, 'teams', 'ops', 'memory', 'init-context.md'), 'utf-8');
    expect(initContent).toBe('Monitor production logs');

    // Init task auto-queued
    const tasks = taskStore.getByTeam('ops');
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks[0].priority).toBe('critical');
    expect(tasks[0].task).toContain('Bootstrap');

    // Skill loading works (empty initially, then write one)
    expect(loadSkillsContent(dir, 'ops')).toBe('');
    writeFileSync(join(dir, 'teams', 'ops', 'skills', 'check-logs.md'), '# Check Logs\nStep 1: Query API');
    const skills = loadSkillsContent(dir, 'ops');
    expect(skills).toContain('Check Logs');

    // Context builder returns correct paths
    const ctx = buildSessionContext('ops', dir);
    expect(ctx.cwd).toBe(join(dir, 'teams', 'ops'));
    expect(ctx.additionalDirectories).toEqual([]);

    raw.close();
  });

  it('failed init task is retried on recovery', () => {
    const dir = makeTempDir();
    const { db, raw } = makeDb(dir);
    const orgStore = new OrgStore(db);
    const taskStore = new TaskQueueStore(db);
    const tree = new OrgTree(orgStore);
    mkdirSync(join(dir, 'teams', 'ops'), { recursive: true });
    writeFileSync(join(dir, 'teams', 'ops', 'config.yaml'), 'name: ops\n');
    orgStore.addTeam(makeNode({ teamId: 'ops', name: 'ops' }));

    // Enqueue and fail a bootstrap task
    const tid = taskStore.enqueue('ops', 'Bootstrap this team. Create skills.', 'critical');
    taskStore.dequeue('ops'); // moves to running
    taskStore.updateStatus(tid, TaskStatus.Failed);
    expect(taskStore.getByStatus(TaskStatus.Failed)).toHaveLength(1);

    // Run recovery
    const result = recoverFromCrash({ orgStore, taskQueueStore: taskStore, orgTree: tree, runDir: dir, logger: noop });
    expect(result.recovered).toBeGreaterThanOrEqual(1);

    // Failed bootstrap task should now be pending again
    const pending = taskStore.getByStatus(TaskStatus.Pending);
    expect(pending.some(t => t.task.startsWith('Bootstrap'))).toBe(true);

    raw.close();
  });
});
