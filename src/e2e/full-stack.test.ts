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
import { TeamStatus, TaskStatus } from '../domain/types.js';
import { createToolInvoker } from '../handlers/tool-invoker.js';
import type { OrgToolDeps } from '../handlers/tool-invoker.js';
import type { OrgTreeNode, TeamConfig } from '../domain/types.js';
import { assertInsideBoundary, assertGovernanceAllowed } from '../sessions/tools/tool-guards.js';
import { withAudit } from '../sessions/tools/tool-audit.js';
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
    result = await bootstrap({ runDir: dir, dataDir: join(dir, 'data'), skipListen: true, skipCli: true });
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

    const tid = taskStore.enqueue('t1', 'do work', 'normal', 'delegate');
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

// ── E2E-4: Tool guards + audit compose correctly ─────────────────────────

describe('E2E-4: Workspace boundary + governance + audit compose correctly', () => {
  it('boundary allows inside cwd and blocks outside cwd', () => {
    const dir = makeTempDir();

    // Allowed: path inside cwd
    expect(() =>
      assertInsideBoundary(join(dir, 'file.ts'), dir, []),
    ).not.toThrow();

    // Blocked: path outside cwd
    expect(() =>
      assertInsideBoundary('/etc/passwd', dir, []),
    ).toThrow('outside workspace boundaries');
  });

  it('governance blocks system-rules and allows own memory', () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, 'system-rules'), { recursive: true });
    mkdirSync(join(dir, 'run', 'teams', 'alpha', 'memory'), { recursive: true });

    const paths = {
      systemRulesDir: join(dir, 'system-rules'),
      dataDir: join(dir, 'data'),
      runDir: join(dir, 'run'),
    };

    // Blocked: system-rules
    expect(() =>
      assertGovernanceAllowed(join(dir, 'system-rules', 'policy.md'), 'alpha', paths),
    ).toThrow('system-rules');

    // Allowed: own memory
    expect(() =>
      assertGovernanceAllowed(join(dir, 'run', 'teams', 'alpha', 'memory', 'notes.md'), 'alpha', paths),
    ).not.toThrow();
  });

  it('audit wrapper logs ToolCall:start and ToolCall:end', async () => {
    const logs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const logger = { info: (msg: string, meta?: Record<string, unknown>) => { logs.push({ msg, meta }); } };

    const execute = async (input: { file_path: string }) => ({ content: `read ${input.file_path}` });
    const wrapped = withAudit('Read', execute, { logger });

    await wrapped({ file_path: '/tmp/test.ts' });

    expect(logs.some((l) => l.msg === 'ToolCall:start' && (l.meta as Record<string, unknown>)?.tool === 'Read')).toBe(true);
    expect(logs.some((l) => l.msg === 'ToolCall:end' && (l.meta as Record<string, unknown>)?.tool === 'Read')).toBe(true);
  });
});

// ── E2E-5: Org MCP 6 tools ───────────────────────────────────────────────

describe('E2E-5: Org MCP 10 tools with real stores', () => {
  it('spawn, delegate, escalate, message, status, shutdown', async () => {
    const dir = makeTempDir();
    const { db, raw } = makeDb(dir);
    const orgStore = new OrgStore(db);
    const taskStore = new TaskQueueStore(db);
    const escStore = new EscalationStore(db);
    const tree = new OrgTree(orgStore);
    const configs = new Map<string, TeamConfig>();
    configs.set('ops', makeConfig({ name: 'ops' }));

    const deps: OrgToolDeps = {
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
      delegateTask: async (team, task) => { taskStore.enqueue(team, task, 'normal', 'trigger'); },
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
    const tid = taskStore.enqueue('t1', 'unfinished work', 'high', 'delegate');
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

    const mcpDeps: OrgToolDeps = {
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
      delegateTask: async (team, task) => { taskStore.enqueue(team, task, 'normal', 'trigger'); },
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

    const deps: OrgToolDeps = {
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

    // Config does not inject org into mcp_servers (org MCP removed)
    const cfgRaw = readFileSync(join(dir, 'teams', 'ops', 'config.yaml'), 'utf-8');
    const cfg = yamlParse(cfgRaw) as { mcp_servers: string[] };
    expect(cfg.mcp_servers).not.toContain('org');

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
    const tid = taskStore.enqueue('ops', 'Bootstrap this team. Create skills.', 'critical', 'bootstrap');
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

// ── E2E-12: LLM Notification Decision ─────────────────────────────────────

import { TriggerConfigStore } from '../storage/stores/trigger-config-store.js';
import { parseLlmNotifyDecision, stripNotifyBlock } from '../sessions/task-consumer.js';

describe('E2E-12: LLM notification decision', () => {
  it('parseLlmNotifyDecision extracts notify: true with reason', () => {
    const response = `Analysis complete. Found 3 critical issues.\n\n\`\`\`json:notify\n{"notify": true, "reason": "critical issues found"}\n\`\`\``;
    const decision = parseLlmNotifyDecision(response);
    expect(decision.notify).toBe(true);
    expect(decision.reason).toBe('critical issues found');
  });

  it('parseLlmNotifyDecision extracts notify: false (suppresses notification)', () => {
    const response = `All systems healthy. No issues found.\n\n\`\`\`json:notify\n{"notify": false, "reason": "routine check, nothing new"}\n\`\`\``;
    const decision = parseLlmNotifyDecision(response);
    expect(decision.notify).toBe(false);
    expect(decision.reason).toBe('routine check, nothing new');
  });

  it('parseLlmNotifyDecision returns fail-safe notify: true when block is missing', () => {
    const response = 'Task completed with no issues. Everything looks good.';
    const decision = parseLlmNotifyDecision(response);
    expect(decision.notify).toBe(true);
  });

  it('stripNotifyBlock removes the notify block from stored content', () => {
    const response = `Report: 5 deployments today.\n\n\`\`\`json:notify\n{"notify": true, "reason": "deploy count"}\n\`\`\``;
    const stripped = stripNotifyBlock(response);
    expect(stripped).toContain('Report: 5 deployments today');
    expect(stripped).not.toContain('json:notify');
    expect(stripped).not.toContain('"notify"');
  });

  it('trigger config store hardcodes notifyPolicy to always', () => {
    const dir = makeTempDir();
    const { db, raw } = makeDb(dir);
    const trigConfigStore = new TriggerConfigStore(db);

    trigConfigStore.upsert({
      name: 'test-trigger',
      type: 'schedule' as const,
      config: { cron: '* * * * *' },
      team: 'test-team',
      task: 'check health',
      state: 'active' as const,
    });

    const stored = trigConfigStore.get('test-team', 'test-trigger');
    expect(stored).toBeDefined();
    expect(stored!.notifyPolicy).toBe('always');

    raw.close();
  });
});

// ── E2E-13: Conversation Context ─────────────────────────────────────────

import { InteractionStore } from '../storage/stores/interaction-store.js';

describe('E2E-13: Conversation context', () => {
  it('logs inbound+outbound interactions and retrieves by channel', () => {
    const dir = makeTempDir();
    const { db, raw } = makeDb(dir);
    const store = new InteractionStore(db);

    // Log inbound message
    store.log({
      direction: 'inbound',
      channelType: 'cli',
      channelId: 'cli-1',
      userId: 'user-a',
      contentSnippet: 'What is the deployment status?',
      contentLength: 31,
    });

    // Log outbound response
    store.log({
      direction: 'outbound',
      channelType: 'cli',
      channelId: 'cli-1',
      teamId: 'ops',
      contentSnippet: 'All services are running normally.',
      contentLength: 34,
      durationMs: 1500,
    });

    // Log interaction on different channel
    store.log({
      direction: 'inbound',
      channelType: 'slack',
      channelId: 'slack-general',
      userId: 'user-b',
      contentSnippet: 'Hello from Slack',
      contentLength: 16,
    });

    // Query recent interactions using the actual API (channelId, teamIds, limit)
    const records = store.getRecentByChannel('cli-1', ['ops'], 10);
    expect(records).toHaveLength(2);
    expect(records.some(r => r.direction === 'inbound' && r.contentSnippet === 'What is the deployment status?')).toBe(true);
    expect(records.some(r => r.direction === 'outbound' && r.contentSnippet === 'All services are running normally.')).toBe(true);

    // Should not include messages from other channels
    const slackRecords = store.getRecentByChannel('slack-general', [], 10);
    expect(slackRecords).toHaveLength(1);
    expect(slackRecords[0].channelId).toBe('slack-general');

    raw.close();
  });

  it('conversation history appears in system prompt', async () => {
    const dir = makeTempDir();
    const { db, raw } = makeDb(dir);
    const store = new InteractionStore(db);

    // Seed some conversation history
    store.log({
      direction: 'inbound',
      channelType: 'cli',
      channelId: 'cli-1',
      userId: 'user-a',
      contentSnippet: 'Deploy the app to staging',
      contentLength: 25,
    });

    store.log({
      direction: 'outbound',
      channelType: 'cli',
      channelId: 'cli-1',
      teamId: 'ops',
      contentSnippet: 'Deployment to staging completed successfully',
      contentLength: 44,
      durationMs: 5000,
    });

    // RED: buildSystemPrompt does not yet accept conversationHistory
    // We test that when it does, the prompt includes the history section.
    const { buildSystemPrompt: buildPrompt } = await import('../sessions/prompt-builder.js');

    // Build prompt with current API (no conversation history yet)
    const prompt = buildPrompt({
      teamName: 'ops',
      cwd: '/data/teams/ops',
      allowedTools: ['*'],
      credentialKeys: [],
      ruleCascade: { staticRules: '', dynamicRules: '' },
      skillsContent: '',
      memorySection: '',
    });

    // The prompt should NOT yet contain conversation history (no history passed)
    const fullPromptText = [prompt.staticPrefix, prompt.dynamicSuffix].filter(Boolean).join('\n\n');
    expect(fullPromptText).not.toContain('## Recent Channel Conversation');

    // Build with conversation history using the actual API
    const { buildConversationHistorySection } = await import('../sessions/prompt-builder.js');
    const historySection = buildConversationHistorySection([
      { direction: 'inbound' as const, channelType: 'ws', channelId: 'ws:test', userId: 'user-a', contentSnippet: 'Deploy the app to staging', createdAt: new Date().toISOString() },
      { direction: 'outbound' as const, channelType: 'ws', channelId: 'ws:test', teamId: 'ops', contentSnippet: 'Deployment to staging completed successfully', createdAt: new Date().toISOString() },
    ]);
    const promptWithHistory = buildPrompt({
      teamName: 'ops',
      cwd: '/data/teams/ops',
      allowedTools: ['*'],
      credentialKeys: [],
      ruleCascade: { staticRules: '', dynamicRules: '' },
      skillsContent: '',
      memorySection: '',
      conversationHistory: historySection,
    });

    const fullHistoryText = [promptWithHistory.staticPrefix, promptWithHistory.dynamicSuffix].filter(Boolean).join('\n\n');
    expect(fullHistoryText).toContain('## Recent Channel Conversation');
    expect(fullHistoryText).toContain('Deploy the app to staging');
    expect(fullHistoryText).toContain('ops');

    raw.close();
  });

  it('hierarchical history includes descendant team interactions', () => {
    const dir = makeTempDir();
    const { db, raw } = makeDb(dir);
    const orgStore = new OrgStore(db);
    const store = new InteractionStore(db);
    const tree = new OrgTree(orgStore);

    // 3-level hierarchy: main → A1 → A11
    tree.addTeam(makeNode({ teamId: 'main', name: 'main' }));
    tree.addTeam(makeNode({ teamId: 'A1', name: 'A1', parentId: 'main' }));
    tree.addTeam(makeNode({ teamId: 'A11', name: 'A11', parentId: 'A1' }));

    // Log interactions per team — all on the same channel (shared Discord channel)
    const channelId = 'discord:shared-channel';
    store.log({
      direction: 'outbound',
      channelType: 'discord',
      channelId,
      teamId: 'main',
      contentSnippet: 'Main team processed request',
      contentLength: 27,
    });

    store.log({
      direction: 'outbound',
      channelType: 'discord',
      channelId,
      teamId: 'A1',
      contentSnippet: 'A1 analyzed data',
      contentLength: 17,
    });

    store.log({
      direction: 'outbound',
      channelType: 'discord',
      channelId,
      teamId: 'A11',
      contentSnippet: 'A11 ran deep analysis',
      contentLength: 21,
    });

    // For 'main': should see all 3 interactions (its own + A1 + A11)
    const mainRecords = store.getRecentByChannel(channelId, ['main', 'A1', 'A11'], 50);
    expect(mainRecords).toHaveLength(3);
    expect(mainRecords.some(r => r.teamId === 'main')).toBe(true);
    expect(mainRecords.some(r => r.teamId === 'A1')).toBe(true);
    expect(mainRecords.some(r => r.teamId === 'A11')).toBe(true);

    // For A1: should see only A1 + A11 messages (its descendant + own)
    const a1Records = store.getRecentByChannel(channelId, ['A1', 'A11'], 50);
    expect(a1Records).toHaveLength(2);
    expect(a1Records.some(r => r.teamId === 'A1')).toBe(true);
    expect(a1Records.some(r => r.teamId === 'A11')).toBe(true);
    // A1 should NOT see main's messages
    expect(a1Records.some(r => r.teamId === 'main')).toBe(false);

    // A11 sees only its own
    const a11Records = store.getRecentByChannel(channelId, ['A11'], 50);
    expect(a11Records).toHaveLength(1);
    expect(a11Records[0].teamId).toBe('A11');

    raw.close();
  });
});

// ── E2E-14: Team deletion cleanup ──────────────────────────────────────────

describe('E2E-14: Team deletion cleanup', () => {
  it('single team shutdown cleans all tables + filesystem', async () => {
    const dir = makeTempDir();
    const { db, raw } = makeDb(dir);
    const orgStore = new OrgStore(db);
    const taskStore = new TaskQueueStore(db);
    const escStore = new EscalationStore(db);
    const triggerConfigStore = new TriggerConfigStore(db);
    const interactionStore = new InteractionStore(db);
    const tree = new OrgTree(orgStore);
    const configs = new Map<string, TeamConfig>();

    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'ops', name: 'ops', parentId: 'root' }));

    triggerConfigStore.upsert({
      name: 'test-trigger',
      type: 'schedule' as const,
      config: { cron: '* * * * *' },
      team: 'ops',
      task: 'test',
      state: 'active' as const,
    });

    taskStore.enqueue('ops', 'test task', 'normal', 'delegate');

    escStore.create({
      correlationId: 'esc-1',
      sourceTeam: 'ops',
      targetTeam: 'root',
      taskId: null,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });

    interactionStore.log({
      direction: 'outbound',
      channelType: 'ws',
      channelId: 'ws:test',
      teamId: 'ops',
      contentSnippet: 'test',
    });

    mkdirSync(join(dir, 'teams', 'ops'), { recursive: true });

    const deps: OrgToolDeps = {
      orgTree: tree,
      taskQueue: taskStore,
      escalationStore: escStore,
      triggerConfigStore,
      interactionStore,
      spawner: { spawn: async () => 'sid' },
      sessionManager: { getSession: async () => null, terminateSession: async () => {} },
      loadConfig: (n) => { const c = configs.get(n); if (!c) throw new Error('no cfg'); return c; },
      getTeamConfig: (id) => configs.get(id),
      runDir: dir,
      log: () => {},
    };
    const server = createToolInvoker(deps);

    const shutRes = await server.invoke('shutdown_team', { name: 'ops' }, 'root') as { success: boolean };
    expect(shutRes.success).toBe(true);

    expect(triggerConfigStore.getByTeam('ops')).toEqual([]);
    expect(taskStore.getByTeam('ops')).toEqual([]);

    // Check escalation gone via raw SQL
    const escRows = raw.prepare("SELECT * FROM escalation_correlations WHERE source_team='ops' OR target_team='ops'").all();
    expect(escRows).toEqual([]);

    // Check interactions gone via raw SQL
    const intRows = raw.prepare("SELECT * FROM channel_interactions WHERE team_id='ops'").all();
    expect(intRows).toEqual([]);

    expect(existsSync(join(dir, 'teams', 'ops'))).toBe(false);
    expect(tree.getTeam('root')).toBeDefined();

    raw.close();
  });

  it('cascade shutdown cleans all descendants', async () => {
    const dir = makeTempDir();
    const { db, raw } = makeDb(dir);
    const orgStore = new OrgStore(db);
    const taskStore = new TaskQueueStore(db);
    const escStore = new EscalationStore(db);
    const triggerConfigStore = new TriggerConfigStore(db);
    const interactionStore = new InteractionStore(db);
    const tree = new OrgTree(orgStore);
    const configs = new Map<string, TeamConfig>();

    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'A1', name: 'A1', parentId: 'root' }));
    tree.addTeam(makeNode({ teamId: 'A11', name: 'A11', parentId: 'A1' }));

    // Insert data for A1
    triggerConfigStore.upsert({
      name: 'trigger-a1',
      type: 'schedule' as const,
      config: { cron: '* * * * *' },
      team: 'A1',
      task: 'task-a1',
      state: 'active' as const,
    });
    taskStore.enqueue('A1', 'task for A1', 'normal', 'delegate');
    escStore.create({
      correlationId: 'esc-a1',
      sourceTeam: 'A1',
      targetTeam: 'root',
      taskId: null,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    interactionStore.log({
      direction: 'outbound',
      channelType: 'ws',
      channelId: 'ws:test',
      teamId: 'A1',
      contentSnippet: 'A1 msg',
    });

    // Insert data for A11
    triggerConfigStore.upsert({
      name: 'trigger-a11',
      type: 'schedule' as const,
      config: { cron: '*/5 * * * *' },
      team: 'A11',
      task: 'task-a11',
      state: 'active' as const,
    });
    taskStore.enqueue('A11', 'task for A11', 'normal', 'delegate');
    escStore.create({
      correlationId: 'esc-a11',
      sourceTeam: 'A11',
      targetTeam: 'A1',
      taskId: null,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    interactionStore.log({
      direction: 'outbound',
      channelType: 'ws',
      channelId: 'ws:test',
      teamId: 'A11',
      contentSnippet: 'A11 msg',
    });

    // Scaffold directories
    mkdirSync(join(dir, 'teams', 'A1'), { recursive: true });
    mkdirSync(join(dir, 'teams', 'A11'), { recursive: true });

    // Insert trigger_dedup record (should survive shutdown)
    raw.prepare("INSERT INTO trigger_dedup (event_id, source, created_at, ttl_seconds) VALUES ('evt-1', 'test', datetime('now'), 300)").run();

    // Insert log_entries record (should survive shutdown)
    raw.prepare("INSERT INTO log_entries (level, message, created_at) VALUES ('info', 'test', datetime('now'))").run();

    const deps: OrgToolDeps = {
      orgTree: tree,
      taskQueue: taskStore,
      escalationStore: escStore,
      triggerConfigStore,
      interactionStore,
      spawner: { spawn: async () => 'sid' },
      sessionManager: { getSession: async () => null, terminateSession: async () => {} },
      loadConfig: (n) => { const c = configs.get(n); if (!c) throw new Error('no cfg'); return c; },
      getTeamConfig: (id) => configs.get(id),
      runDir: dir,
      log: () => {},
    };
    const server = createToolInvoker(deps);

    const shutRes = await server.invoke('shutdown_team', { name: 'A1', cascade: true }, 'root') as { success: boolean };
    expect(shutRes.success).toBe(true);

    // All tables clean for A1
    expect(triggerConfigStore.getByTeam('A1')).toEqual([]);
    expect(taskStore.getByTeam('A1')).toEqual([]);
    const escRowsA1 = raw.prepare("SELECT * FROM escalation_correlations WHERE source_team='A1' OR target_team='A1'").all();
    expect(escRowsA1).toEqual([]);
    const intRowsA1 = raw.prepare("SELECT * FROM channel_interactions WHERE team_id='A1'").all();
    expect(intRowsA1).toEqual([]);

    // All tables clean for A11
    expect(triggerConfigStore.getByTeam('A11')).toEqual([]);
    expect(taskStore.getByTeam('A11')).toEqual([]);
    const escRowsA11 = raw.prepare("SELECT * FROM escalation_correlations WHERE source_team='A11' OR target_team='A11'").all();
    expect(escRowsA11).toEqual([]);
    const intRowsA11 = raw.prepare("SELECT * FROM channel_interactions WHERE team_id='A11'").all();
    expect(intRowsA11).toEqual([]);

    // Both directories removed
    expect(existsSync(join(dir, 'teams', 'A1'))).toBe(false);
    expect(existsSync(join(dir, 'teams', 'A11'))).toBe(false);

    // trigger_dedup record still exists
    const dedupRows = raw.prepare("SELECT * FROM trigger_dedup WHERE event_id='evt-1'").all();
    expect(dedupRows).toHaveLength(1);

    // log_entries record still exists
    const logRows = raw.prepare("SELECT * FROM log_entries WHERE message='test'").all();
    expect(logRows).toHaveLength(1);

    // Root still exists
    expect(tree.getTeam('root')).toBeDefined();

    raw.close();
  });
});
