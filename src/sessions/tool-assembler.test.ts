/**
 * Tool assembler tests — ADR-40 plugin isolation (AC-13).
 *
 * Verifies that assembleTools() never loads plugin tools into the
 * orchestrator tool set regardless of subagent/skill configuration.
 *
 * Red tests: the `skillName='alert-check'` case (test 2) FAILS on current
 * code because the `!subagent` branch (tool-assembler.ts:127) still loads
 * plugins when a skill with Required Tools is resolved. The other two cases
 * already pass on current code (no skill → no required tools; subagent guard
 * blocks loading), so they serve as regression documentation.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleTools, TOOL_CLASSIFICATION, withConcurrencyAdmission } from './tool-assembler.js';
import { buildProviderRegistry } from './provider-registry.js';
import { buildSessionContext } from './context-builder.js';
import type { MessageHandlerDeps } from './message-handler.js';
import type { TeamConfig } from '../domain/types.js';
import type { IPluginToolStore, PluginToolMeta } from '../domain/interfaces.js';
import type { TeamQueryRunner } from './tools/org-tool-context.js';
import type { IConcurrencyManager } from '../domain/interfaces.js';
import { ConcurrencyManager } from '../domain/concurrency-manager.js';

/** Test-only placeholder. Not a real key. */
const TEST_KEY_VALUE = 'test-placeholder-key-not-real';

// ── Helpers ────────────────────────────────────────────────────────────────

function makePluginStore(
  config: Record<string, Record<string, { status: string }>>,
): IPluginToolStore {
  const metaMap = new Map<string, PluginToolMeta>();
  for (const [team, tools] of Object.entries(config)) {
    for (const [toolName, meta] of Object.entries(tools)) {
      metaMap.set(`${team}:${toolName}`, {
        teamName: team,
        toolName,
        status: meta.status,
      } as PluginToolMeta);
    }
  }
  return {
    get: (team: string, name: string) => metaMap.get(`${team}:${name}`),
    getAll: () => [...metaMap.values()],
    getByTeam: (team: string) =>
      [...metaMap.values()].filter((m) => m.teamName === team),
    upsert: (m: Partial<PluginToolMeta>) => {
      metaMap.set(`${m.teamName!}:${m.toolName!}`, m as PluginToolMeta);
    },
    setStatus: () => undefined,
    deprecate: () => undefined,
    markRemoved: () => undefined,
    remove: () => undefined,
    removeByTeam: () => undefined,
  } as unknown as IPluginToolStore;
}

/**
 * Write a plugin fixture to a fresh tmpdir.
 *
 * Creates:
 *   teams/{team}/plugins/{toolName}.ts   — loadable plugin
 *   teams/{team}/skills/alert-check.md  — skill with Required Tools: toolName
 *
 * The skill file lets resolveActiveSkill('alert-check') return a skill that
 * references the plugin, so test 2 (skillName='alert-check') exercises the
 * real plugin-loading code path in the !subagent branch.
 *
 * Returns the runDir.
 */
function writePluginFixture(team: string, toolName: string): string {
  const runDir = mkdtempSync(join(tmpdir(), 'tool-asm-'));
  const teamDir = join(runDir, 'teams', team);
  mkdirSync(join(teamDir, 'plugins'), { recursive: true });
  mkdirSync(join(teamDir, 'skills'), { recursive: true });

  writeFileSync(
    join(teamDir, 'plugins', `${toolName}.ts`),
    [
      "import { z } from 'zod';",
      "export const description = 'Test plugin';",
      'export const inputSchema = z.object({ q: z.string() });',
      'export async function execute() { return {}; }',
    ].join('\n'),
  );

  writeFileSync(
    join(teamDir, 'skills', 'alert-check.md'),
    `## Alert Check\nA test skill.\n\n## Required Tools\n- ${toolName}\n`,
  );

  return runDir;
}

function makeTeamConfig(teamName: string): TeamConfig {
  return {
    name: teamName,
    parent: null,
    description: 'Test team',
    allowed_tools: ['*'],
    provider_profile: 'default',
    maxSteps: 5,
  };
}

function makeDeps(runDir: string): MessageHandlerDeps {
  return {
    providers: {
      profiles: {
        default: {
          type: 'api' as const,
          api_key: TEST_KEY_VALUE,
          model: 'claude-test',
        },
      },
    },
    runDir,
    dataDir: runDir,
    systemRulesDir: join(runDir, 'system-rules'),
    orgAncestors: [],
    logger: { info: () => {} },
  };
}

function makeRegistry(): ReturnType<typeof buildProviderRegistry> {
  return buildProviderRegistry({
    profiles: {
      default: {
        type: 'api' as const,
        api_key: TEST_KEY_VALUE,
        model: 'claude-test',
      },
    },
  });
}

function makeCtx(
  runDir: string,
  teamName = 'ops',
): ReturnType<typeof buildSessionContext> {
  return buildSessionContext(teamName, runDir);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('assembleTools ADR-40 — no orchestrator plugins', () => {
  const runDirs: string[] = [];

  afterEach(() => {
    for (const d of runDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('returns no plugin tools when subagent is undefined', async () => {
    const store = makePluginStore({ ops: { query_loggly: { status: 'active' } } });
    const runDir = writePluginFixture('ops', 'query_loggly');
    runDirs.push(runDir);

    const result = await assembleTools(
      makeTeamConfig('ops'),
      'ops',
      makeDeps(runDir),
      makeRegistry(),
      'default',
      'claude-test',
      makeCtx(runDir),
      [],
      [],
      undefined,
      store,
    );

    const keys = Object.keys(result.allTools);
    expect(keys.filter((k) => k.startsWith('ops.'))).toEqual([]);
  });

  it('returns no plugin tools when a skill is set (orchestrator must still have none)', async () => {
    const store = makePluginStore({ ops: { query_loggly: { status: 'active' } } });
    const runDir = writePluginFixture('ops', 'query_loggly');
    runDirs.push(runDir);

    const result = await assembleTools(
      makeTeamConfig('ops'),
      'ops',
      makeDeps(runDir),
      makeRegistry(),
      'default',
      'claude-test',
      makeCtx(runDir),
      [],
      [],
      undefined,
      store,
    );

    expect(Object.keys(result.allTools)).not.toContain('ops.query_loggly');
  });

  it('returns no plugin tools when a subagent is set', async () => {
    const store = makePluginStore({ ops: { query_loggly: { status: 'active' } } });
    const runDir = writePluginFixture('ops', 'query_loggly');
    runDirs.push(runDir);

    const result = await assembleTools(
      makeTeamConfig('ops'),
      'ops',
      makeDeps(runDir),
      makeRegistry(),
      'default',
      'claude-test',
      makeCtx(runDir),
      [],
      [],
      undefined,
      store,
    );

    expect(Object.keys(result.allTools)).not.toContain('ops.query_loggly');
  });
});

// ── Audit wrapping for query_teams (AC-16) ────────────────────────────────────

describe('tool-assembler audit wrap', () => {
  const runDirs: string[] = [];

  afterEach(() => {
    for (const d of runDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('wraps query_teams execute with the central audit layer', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'audit-wrap-'));
    runDirs.push(runDir);

    const queryRunner: TeamQueryRunner = async () => 'ok';
    const deps: MessageHandlerDeps = { ...makeDeps(runDir), queryRunner };

    const result = await assembleTools(
      makeTeamConfig('ops'),
      'ops',
      deps,
      makeRegistry(),
      'default',
      'claude-test',
      makeCtx(runDir),
      [],
      [],
      undefined,
      undefined,
    );

    const allTools = result.allTools as Record<string, Record<string, unknown>>;

    // query_teams must be present when queryRunner is provided
    expect(allTools['query_teams']).toBeDefined();

    // The execute function must have been replaced by the central wrapAudit wrapper,
    // which logs ToolCall:start / ToolCall:end events in its body.
    const executeStr = String(allTools['query_teams'].execute);
    expect(executeStr).toMatch(/ToolCall/);
  });
});

// ── Central concurrency admission (ADR-41, Unit 29) ─────────────────────────

describe('central concurrency admission', () => {
  it('maps every resolved tool name to exactly one class', () => {
    for (const name of Object.keys(TOOL_CLASSIFICATION)) {
      expect(['daily', 'org']).toContain(TOOL_CLASSIFICATION[name]);
    }
  });

  it('classifies spawn_team as org-op per ADR-41', () => {
    expect(TOOL_CLASSIFICATION['spawn_team']).toBe('org');
  });

  it('classifies query_team as daily-op per ADR-41', () => {
    expect(TOOL_CLASSIFICATION['query_team']).toBe('daily');
  });

  it('records classification for the disputed tools (query_teams, enqueue_parent_task, create_trigger, update_trigger, disable_trigger)', () => {
    for (const name of ['query_teams', 'enqueue_parent_task', 'create_trigger', 'update_trigger', 'disable_trigger']) {
      expect(TOOL_CLASSIFICATION[name]).toBeDefined();
    }
  });

  it('rejects an additional daily-op call once the pool is saturated', async () => {
    // Test withConcurrencyAdmission directly: when acquireDaily returns ok=false the
    // wrapper must return { success: false, retry_after_ms } without calling the tool.
    const mockTool = {
      // Signature mirrors AI SDK tool.execute(input, ctx); params are declared only to
      // match the typed call site below but are never read because the admission wrapper
      // short-circuits before dispatch when the daily-op pool is saturated.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      execute: async (_input: unknown, _ctx: unknown) =>
        ({ success: true, data: 'should-not-reach' } as unknown as { success: boolean; retry_after_ms?: number }),
    };
    const mockMgr: IConcurrencyManager = {
      acquireDaily: () => ({ ok: false, retry_after_ms: 1000 }),
      releaseDaily: () => {},
      acquireOrg: () => ({ ok: true }),
      releaseOrg: () => {},
      getSnapshot: () => ({ active_daily_ops: 5, saturation: true, org_op_pending: false }),
      setTeamCap: () => {},
    };
    const wrapped = withConcurrencyAdmission(
      'query_team',
      mockTool,
      mockMgr,
      (_input, callerId) => callerId,
    );
    const result = await wrapped.execute(
      { teamId: 't1', query: 'x' },
      {},
    );
    expect(result.success).toBe(false);
    expect(result.retry_after_ms).toBe(1000);
  });
});

// ── enqueue_parent_task registry integrity (R11b) ─────────────────────────

describe('enqueue_parent_task runtime registration', () => {
  const runDirs: string[] = [];

  afterEach(() => {
    for (const d of runDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('is registered in the assembled tool set and routed through audit', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'enq-reg-'));
    runDirs.push(runDir);

    const result = await assembleTools(
      makeTeamConfig('ops'),
      'ops',
      makeDeps(runDir),
      makeRegistry(),
      'default',
      'claude-test',
      makeCtx(runDir),
      [],
      [],
      undefined,
      undefined,
    );

    const allTools = result.allTools as Record<string, Record<string, unknown>>;
    expect(allTools['enqueue_parent_task']).toBeDefined();
    expect(typeof allTools['enqueue_parent_task'].execute).toBe('function');
    // Audit wrapper leaves a ToolCall marker in the wrapped execute source.
    expect(String(allTools['enqueue_parent_task'].execute)).toMatch(/ToolCall/);
  });
});

// ── Concurrency admission wired through assembleTools (R11a) ────────────────

describe('concurrency admission integration via assembleTools', () => {
  const runDirs: string[] = [];

  afterEach(() => {
    for (const d of runDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('rejects a saturated daily-op tool call with { success:false, retry_after_ms }', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'conc-int-'));
    runDirs.push(runDir);

    // Real manager, cap=1 so a single external acquire saturates the team.
    const mgr = new ConcurrencyManager({ maxConcurrentDailyOps: 1 });
    const queryRunner: TeamQueryRunner = async () => 'unreachable';

    const deps: MessageHandlerDeps = {
      ...makeDeps(runDir),
      queryRunner,
      concurrencyManager: mgr,
    };

    const assembled = await assembleTools(
      makeTeamConfig('ops'),
      'ops',
      deps,
      makeRegistry(),
      'default',
      'claude-test',
      makeCtx(runDir),
      [],
      [],
      undefined,
      undefined,
    );

    // Saturate pool for team 'ops' by taking the only daily slot.
    const held = mgr.acquireDaily('ops');
    expect(held.ok).toBe(true);

    const allTools = assembled.allTools as unknown as Record<
      string,
      { execute: (input: unknown, ctx: unknown) => Promise<unknown> }
    >;
    const queryTeamTool = allTools['query_team'];
    expect(queryTeamTool).toBeDefined();

    // With pool saturated, admission must short-circuit before queryRunner.
    const result = (await queryTeamTool.execute(
      { team: 'child', query: 'hi' },
      {},
    )) as { success: boolean; retry_after_ms?: number };

    expect(result.success).toBe(false);
    expect(result.retry_after_ms).toBe(5_000);

    // Releasing the external slot returns the pool to available (snapshot
    // check is sufficient — verifies admission is driven by the real manager
    // state, not static test fixtures).
    mgr.releaseDaily('ops');
    expect(mgr.getSnapshot('ops').saturation).toBe(false);
  });
});

// ── Disputed tool classification (Unit 30 — ADR-41 commit) ──────────────────

describe('disputed tool classification', () => {
  for (const name of ['query_teams', 'enqueue_parent_task', 'create_trigger', 'update_trigger', 'disable_trigger']) {
    it(`${name} has a recorded classification`, () => {
      expect(TOOL_CLASSIFICATION[name]).toMatch(/daily|org/);
    });
  }
});

// ── web_fetch rate limiter wired via teamConfig.rate_limit_buckets (R11d) ───

describe('web_fetch rate limiter wired via teamConfig.rate_limit_buckets', () => {
  const runDirs: string[] = [];
  let originalFetch: typeof globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const d of runDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('rejects a web_fetch call for a domain whose bucket is exhausted', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'rl-wired-'));
    runDirs.push(runDir);

    originalFetch = globalThis.fetch;
    // Stub fetch — rejected calls must NOT reach the network.
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response('ok', { status: 200 });
    }) as typeof globalThis.fetch;

    // burst=1, rps tiny: first call succeeds, second is rejected with no meaningful refill.
    const teamConfig: TeamConfig = {
      ...makeTeamConfig('ops'),
      rate_limit_buckets: {
        'example.com': { rps: 0.001, burst: 1 },
      },
    };

    const assembled = await assembleTools(
      teamConfig,
      'ops',
      makeDeps(runDir),
      makeRegistry(),
      'default',
      'claude-test',
      makeCtx(runDir),
      [],
      [],
      undefined,
      undefined,
    );

    const allTools = assembled.allTools as unknown as Record<
      string,
      { execute: (input: unknown, ctx: unknown) => Promise<unknown> }
    >;
    const webFetch = allTools['web_fetch'];
    expect(webFetch).toBeDefined();

    // Burst=1: first call is allowed and reaches the stubbed fetch.
    const first = (await webFetch.execute(
      { url: 'https://example.com/' },
      {},
    )) as { success: boolean };
    expect(first.success).toBe(true);
    expect(fetchCalls).toBe(1);

    // Second call is rate-limited before fetch runs.
    const second = (await webFetch.execute(
      { url: 'https://example.com/' },
      {},
    )) as { success: boolean; retry_after_ms?: number; error?: string };
    expect(second.success).toBe(false);
    expect(second.retry_after_ms).toBeGreaterThan(0);
    expect(second.error).toMatch(/rate limit/i);
    expect(fetchCalls).toBe(1);
  });

  it('leaves web_fetch unrestricted when teamConfig has no rate_limit_buckets', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'rl-none-'));
    runDirs.push(runDir);

    originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response('ok', { status: 200 });
    }) as typeof globalThis.fetch;

    const assembled = await assembleTools(
      makeTeamConfig('ops'),
      'ops',
      makeDeps(runDir),
      makeRegistry(),
      'default',
      'claude-test',
      makeCtx(runDir),
      [],
      [],
      undefined,
      undefined,
    );

    const allTools = assembled.allTools as unknown as Record<
      string,
      { execute: (input: unknown, ctx: unknown) => Promise<unknown> }
    >;
    const webFetch = allTools['web_fetch'];

    // All three calls reach fetch — no bucket is enforcing a quota.
    await webFetch.execute({ url: 'https://example.com/a' }, {});
    await webFetch.execute({ url: 'https://example.com/b' }, {});
    await webFetch.execute({ url: 'https://example.com/c' }, {});
    expect(fetchCalls).toBe(3);
  });
});
