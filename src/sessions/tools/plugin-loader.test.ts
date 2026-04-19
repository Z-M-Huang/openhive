import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPluginTools } from './plugin-loader.js';
import type { LoadedPluginTools } from './plugin-loader.js';
import type { IPluginToolStore, PluginToolMeta } from '../../domain/interfaces.js';

// ── Shared helpers for AC-15.x tests ──────────────────────────────────────────

function makePluginStore(teams: Record<string, Record<string, { status: string }>>): IPluginToolStore {
  const metaMap = new Map<string, PluginToolMeta>();
  for (const [teamName, tools] of Object.entries(teams)) {
    for (const [toolName, { status }] of Object.entries(tools)) {
      metaMap.set(`${teamName}:${toolName}`, { teamName, toolName, status } as PluginToolMeta);
    }
  }
  return {
    get: (team: string, name: string) => metaMap.get(`${team}:${name}`),
    getAll: () => [],
    getByTeam: () => [],
    upsert: (m: Partial<PluginToolMeta>) => metaMap.set(`${m.teamName!}:${m.toolName!}`, m as PluginToolMeta),
    setStatus: () => undefined,
    deprecate: () => undefined,
    markRemoved: () => undefined,
    remove: () => undefined,
    removeByTeam: () => undefined,
  } as unknown as IPluginToolStore;
}

async function writePluginFixture(teamName: string, toolName: string, content?: string): Promise<string> {
  const d = mkdtempSync(join(tmpdir(), 'plugin-ac15-'));
  const pluginDir = join(d, 'teams', teamName, 'plugins');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, `${toolName}.ts`),
    content ?? `export const description = 'test'; export const inputSchema = {}; export async function execute() { return {}; }`,
  );
  return d;
}

// Cast to accept optional logger parameter (U2 will implement)
type LoadPluginToolsWithLogger = (
  teamName: string,
  requiredTools: string[],
  allowedTools: readonly string[],
  pluginToolStore: IPluginToolStore,
  runDir: string,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void; error?: (msg: string, meta?: Record<string, unknown>) => void },
) => Promise<LoadedPluginTools>;

const loadPlugin = loadPluginTools as LoadPluginToolsWithLogger;

describe('loadPluginTools', () => {
  let runDir: string;
  let store: IPluginToolStore;
  let logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), 'plugin-loader-'));
    mkdirSync(join(runDir, 'teams', 'ops-team', 'plugins'), { recursive: true });
    const metaMap = new Map<string, PluginToolMeta>();
    store = {
      get: (team: string, name: string) => metaMap.get(`${team}:${name}`),
      getAll: () => [],
      getByTeam: () => [],
      upsert: (m: Partial<PluginToolMeta>) => metaMap.set(`${m.teamName!}:${m.toolName!}`, m as PluginToolMeta),
      setStatus: () => undefined,
      deprecate: () => undefined,
      markRemoved: () => undefined,
      remove: () => undefined,
      removeByTeam: () => undefined,
    } as unknown as IPluginToolStore;
    logger = { warn: vi.fn(), error: vi.fn() };
  });

  afterEach(() => rmSync(runDir, { recursive: true, force: true }));

  it('loads named-export plugin format', async () => {
    writeFileSync(
      join(runDir, 'teams', 'ops-team', 'plugins', 'query_loggly.ts'),
      `import { z } from 'zod';
       export const description = 'Query Loggly';
       export const inputSchema = z.object({ query: z.string() });
       export async function execute({ query }) { return { ok: true, query }; }`
    );
    store.upsert({ teamName: 'ops-team', toolName: 'query_loggly', status: 'active' } as PluginToolMeta);

    const { tools, infos } = await loadPlugin('ops-team', ['query_loggly'], ['*'], store, runDir, logger);

    expect(tools['ops-team.query_loggly']).toBeDefined();
    expect(infos).toEqual([{ name: 'ops-team.query_loggly', description: 'Query Loggly' }]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('still loads legacy default-export plugin', async () => {
    writeFileSync(
      join(runDir, 'teams', 'ops-team', 'plugins', 'legacy.ts'),
      `import { tool } from 'ai';
       import { z } from 'zod';
       export default tool({ description: 'legacy', inputSchema: z.object({}), execute: async () => ({}) });`
    );
    store.upsert({ teamName: 'ops-team', toolName: 'legacy', status: 'active' } as PluginToolMeta);

    const { tools } = await loadPlugin('ops-team', ['legacy'], ['*'], store, runDir, logger);

    expect(tools['ops-team.legacy']).toBeDefined();
  });

  it('skips reserved tool names', async () => {
    const { tools } = await loadPlugin('ops-team', ['bash', 'read'], ['*'], store, runDir, logger);
    expect(tools['ops-team.bash']).toBeUndefined();
    expect(tools['ops-team.read']).toBeUndefined();
  });

  it('skips inactive store entries', async () => {
    writeFileSync(
      join(runDir, 'teams', 'ops-team', 'plugins', 'inactive.ts'),
      `export const description = 'x'; export const inputSchema = {}; export async function execute() {}`
    );
    store.upsert({ teamName: 'ops-team', toolName: 'inactive', status: 'deprecated' } as PluginToolMeta);

    const { tools } = await loadPlugin('ops-team', ['inactive'], ['*'], store, runDir, logger);
    expect(tools['ops-team.inactive']).toBeUndefined();
  });

  it('skips when allowed_tools filter rejects', async () => {
    writeFileSync(
      join(runDir, 'teams', 'ops-team', 'plugins', 'foo.ts'),
      `export const description = 'x'; export const inputSchema = {}; export async function execute() {}`
    );
    store.upsert({ teamName: 'ops-team', toolName: 'foo', status: 'active' } as PluginToolMeta);

    const { tools } = await loadPlugin('ops-team', ['foo'], ['Read'], store, runDir, logger);
    expect(tools['ops-team.foo']).toBeUndefined();
  });

  it('logs warning when plugin export shape is unrecognized', async () => {
    writeFileSync(
      join(runDir, 'teams', 'ops-team', 'plugins', 'weird.ts'),
      `export const somethingElse = 42;`
    );
    store.upsert({ teamName: 'ops-team', toolName: 'weird', status: 'active' } as PluginToolMeta);

    const { tools } = await loadPlugin('ops-team', ['weird'], ['*'], store, runDir, logger);

    expect(tools['ops-team.weird']).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('export'),
      expect.objectContaining({ team: 'ops-team', tool: 'weird' })
    );
  });

  it('logs error on import throw and keeps loading siblings', async () => {
    writeFileSync(
      join(runDir, 'teams', 'ops-team', 'plugins', 'broken.ts'),
      `this is not valid typescript !!!`
    );
    writeFileSync(
      join(runDir, 'teams', 'ops-team', 'plugins', 'valid.ts'),
      `export const description = 'ok'; export const inputSchema = {}; export async function execute() { return {}; }`
    );
    store.upsert({ teamName: 'ops-team', toolName: 'broken', status: 'active' } as PluginToolMeta);
    store.upsert({ teamName: 'ops-team', toolName: 'valid', status: 'active' } as PluginToolMeta);

    const { tools } = await loadPlugin('ops-team', ['broken', 'valid'], ['*'], store, runDir, logger);

    expect(tools['ops-team.broken']).toBeUndefined();
    expect(tools['ops-team.valid']).toBeDefined();
    const logFn = logger.error.mock.calls.length ? logger.error : logger.warn;
    expect(logFn).toHaveBeenCalledWith(
      expect.stringContaining('Plugin load'),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      expect.objectContaining({ team: 'ops-team', tool: 'broken', error: expect.any(String) })
    );
  });
});

// ── AC-15.1: reserved name skip ───────────────────────────────────────────────

describe('plugin-loader AC-15.1 reserved names', () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const d of createdDirs) rmSync(d, { recursive: true, force: true });
    createdDirs.length = 0;
  });

  it('skips reserved tool name "bash"', async () => {
    const warn = vi.fn();
    const store = makePluginStore({ ops: { bash: { status: 'active' } } });
    const runDir = await writePluginFixture('ops', 'bash');
    createdDirs.push(runDir);
    const result = await loadPluginTools('ops', ['bash'], ['*'], store, runDir, { warn });
    expect(result.tools).toEqual({});
    expect(result.infos).toEqual([]);
  });

  it('skips reserved tool name "Read" case-insensitively', async () => {
    const store = makePluginStore({ ops: { Read: { status: 'active' } } });
    const result = await loadPluginTools('ops', ['Read'], ['*'], store, '/tmp', { warn: vi.fn() });
    expect(result.tools).toEqual({});
    expect(result.infos).toEqual([]);
  });
});

// ── AC-15.2: structured error log fields ─────────────────────────────────────

describe('plugin-loader AC-15.2 structured error logs', () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const d of createdDirs) rmSync(d, { recursive: true, force: true });
    createdDirs.length = 0;
  });

  it('logger call carries team, tool, and message', async () => {
    const warn = vi.fn();
    const runDir = await writePluginFixture('ops', 'broken', '<<syntax error>>');
    createdDirs.push(runDir);
    const store = makePluginStore({ ops: { broken: { status: 'active' } } });
    await loadPluginTools('ops', ['broken'], ['*'], store, runDir, { warn });
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      expect.objectContaining({ team: 'ops', tool: 'broken', error: expect.any(String) }),
    );
  });
});
