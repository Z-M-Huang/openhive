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

import { assembleTools } from './tool-assembler.js';
import { buildProviderRegistry } from './provider-registry.js';
import { buildSessionContext } from './context-builder.js';
import type { MessageHandlerDeps } from './message-handler.js';
import type { TeamConfig } from '../domain/types.js';
import type { IPluginToolStore, PluginToolMeta } from '../domain/interfaces.js';

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
      undefined /* skillName */,
      undefined /* subagent */,
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
      'alert-check' /* skillName */,
      undefined /* subagent */,
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
      undefined /* skillName */,
      'loggly-monitor' /* subagent */,
    );

    expect(Object.keys(result.allTools)).not.toContain('ops.query_loggly');
  });
});
