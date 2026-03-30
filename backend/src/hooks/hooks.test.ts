/**
 * Hooks + Governance tests (migrated from layer-4.test.ts)
 *
 * Tests:
 * - UT-4: Workspace boundary blocks ../traversal, symlink escape, handles tool_input extraction
 * - UT-5: Governance blocks global rules, other team dirs, allows own team-rules/skills + logs
 * - UT-5: Audit logger records PreToolUse with tool_name, PostToolUse with duration
 * - Hook composer: buildHookConfig returns correct structure
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, symlinkSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import type { HookInput, HookJSONOutput } from './types.js';
import { createWorkspaceBoundaryHook } from './workspace-boundary.js';
import { createGovernanceHook } from './governance.js';
import type { GovernancePaths } from './governance.js';
import { createAuditPreHook, createAuditPostHook } from './audit-logger.js';
import { buildHookConfig } from './index.js';
import { SecretString } from '../secrets/secret-string.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `openhive-l4-${randomBytes(8).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Cast partial hook input for tests — our hooks only read tool_name + tool_input. */
function hookInput(input: { tool_name: string; tool_input: Record<string, unknown>; tool_response?: unknown }): HookInput {
  return input as unknown as HookInput;
}

const hookOpts = { signal: new AbortController().signal };

function isDenied(result: HookJSONOutput): boolean {
  const r = result as Record<string, unknown>;
  const out = r['hookSpecificOutput'] as Record<string, unknown> | undefined;
  return out?.['permissionDecision'] === 'deny';
}

function denyReason(result: HookJSONOutput): string {
  const r = result as Record<string, unknown>;
  const out = r['hookSpecificOutput'] as Record<string, unknown>;
  return out['permissionDecisionReason'] as string;
}

// ── UT-4: Workspace Boundary ──────────────────────────────────────────────

describe('UT-4: Workspace Boundary Hook', () => {
  let cwd: string;
  let outsideDir: string;

  beforeEach(() => {
    cwd = makeTmpDir();
    outsideDir = makeTmpDir();
  });

  afterEach(() => {
    if (existsSync(cwd)) rmSync(cwd, { recursive: true });
    if (existsSync(outsideDir)) rmSync(outsideDir, { recursive: true });
  });

  it('blocks ../traversal attempt', async () => {
    const hook = createWorkspaceBoundaryHook(cwd, []);
    const result = await hook(
      hookInput({ tool_name: 'Read', tool_input: { file_path: join(cwd, '..', 'etc', 'passwd') } }),
      'tu-1',
      hookOpts,
    );

    expect(isDenied(result)).toBe(true);
    expect(denyReason(result)).toContain('outside workspace boundaries');
  });

  it('blocks symlink escape', async () => {
    // Create a real file outside cwd
    const escapedFile = join(outsideDir, 'secret.txt');
    writeFileSync(escapedFile, 'secret data');

    // Create symlink inside cwd pointing outside
    const linkPath = join(cwd, 'sneaky-link');
    symlinkSync(outsideDir, linkPath);

    const hook = createWorkspaceBoundaryHook(cwd, []);
    const result = await hook(
      hookInput({ tool_name: 'Read', tool_input: { file_path: join(linkPath, 'secret.txt') } }),
      'tu-2',
      hookOpts,
    );

    expect(isDenied(result)).toBe(true);
    expect(denyReason(result)).toContain('outside workspace boundaries');
  });

  it('allows files within cwd', async () => {
    const hook = createWorkspaceBoundaryHook(cwd, []);
    const result = await hook(
      hookInput({ tool_name: 'Write', tool_input: { file_path: join(cwd, 'file.txt') } }),
      'tu-3',
      hookOpts,
    );

    expect(result).toEqual({});
  });

  it('allows files within additionalDirectories', async () => {
    const extraDir = makeTmpDir();
    try {
      const hook = createWorkspaceBoundaryHook(cwd, [extraDir]);
      const result = await hook(
        hookInput({ tool_name: 'Edit', tool_input: { file_path: join(extraDir, 'allowed.ts') } }),
        'tu-4',
        hookOpts,
      );

      expect(result).toEqual({});
    } finally {
      if (existsSync(extraDir)) rmSync(extraDir, { recursive: true });
    }
  });

  it('extracts path from Read tool_input (file_path)', async () => {
    const hook = createWorkspaceBoundaryHook(cwd, []);
    const result = await hook(
      hookInput({ tool_name: 'Read', tool_input: { file_path: join(cwd, 'readme.md') } }),
      'tu-5',
      hookOpts,
    );
    expect(result).toEqual({});
  });

  it('extracts path from Write tool_input (file_path)', async () => {
    const hook = createWorkspaceBoundaryHook(cwd, []);
    const result = await hook(
      hookInput({ tool_name: 'Write', tool_input: { file_path: '/tmp/outside/file' } }),
      'tu-6',
      hookOpts,
    );
    expect(isDenied(result)).toBe(true);
  });

  it('extracts path from Edit tool_input (file_path)', async () => {
    const hook = createWorkspaceBoundaryHook(cwd, []);
    const result = await hook(
      hookInput({ tool_name: 'Edit', tool_input: { file_path: join(cwd, 'src', 'code.ts') } }),
      'tu-7',
      hookOpts,
    );
    expect(result).toEqual({});
  });

  it('extracts path from Glob tool_input (path)', async () => {
    const hook = createWorkspaceBoundaryHook(cwd, []);
    const result = await hook(
      hookInput({ tool_name: 'Glob', tool_input: { path: cwd, pattern: '**/*.ts' } }),
      'tu-8',
      hookOpts,
    );
    expect(result).toEqual({});
  });

  it('extracts path from Glob tool_input (pattern as fallback)', async () => {
    const hook = createWorkspaceBoundaryHook(cwd, []);
    const result = await hook(
      hookInput({ tool_name: 'Glob', tool_input: { pattern: join(cwd, 'src') } }),
      'tu-9',
      hookOpts,
    );
    expect(result).toEqual({});
  });

  it('extracts path from Grep tool_input (path)', async () => {
    const hook = createWorkspaceBoundaryHook(cwd, []);
    const result = await hook(
      hookInput({ tool_name: 'Grep', tool_input: { path: join(cwd, 'search-here'), pattern: 'foo' } }),
      'tu-10',
      hookOpts,
    );
    expect(result).toEqual({});
  });

  it('allows when tool_input has no extractable path', async () => {
    const hook = createWorkspaceBoundaryHook(cwd, []);
    const result = await hook(
      hookInput({ tool_name: 'Grep', tool_input: { pattern: 'hello' } }),
      'tu-11',
      hookOpts,
    );
    expect(result).toEqual({});
  });
});

// ── UT-5: Governance Hook ──────────────────────────────────────────────────

describe('UT-5: Governance Hook', () => {
  let tmpDir: string;
  let systemRulesDir: string;
  let dataDir: string;
  let runDir: string;
  let paths: GovernancePaths;
  let logMessages: Array<{ msg: string; meta?: Record<string, unknown> }>;
  let logger: { info: (msg: string, meta?: Record<string, unknown>) => void };

  beforeEach(() => {
    tmpDir = makeTmpDir();
    systemRulesDir = join(tmpDir, 'system-rules');
    dataDir = join(tmpDir, 'data');
    runDir = join(tmpDir, 'run');
    paths = { systemRulesDir, dataDir, runDir };
    logMessages = [];
    logger = {
      info: (msg: string, meta?: Record<string, unknown>) => {
        logMessages.push({ msg, meta });
      },
    };
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it('blocks write to admin org rules (dataDir/rules/)', async () => {
    const hook = createGovernanceHook('my-team', paths, logger);
    const result = await hook(
      hookInput({ tool_name: 'Write', tool_input: { file_path: join(dataDir, 'rules', 'global', 'safety.md') } }),
      'tu-g1',
      hookOpts,
    );

    expect(isDenied(result)).toBe(true);
    expect(denyReason(result)).toContain('admin-org-rules');
  });

  it('blocks write to system-rules dir', async () => {
    const hook = createGovernanceHook('my-team', paths, logger);
    const result = await hook(
      hookInput({ tool_name: 'Edit', tool_input: { file_path: join(systemRulesDir, 'policy.md') } }),
      'tu-g2',
      hookOpts,
    );

    expect(isDenied(result)).toBe(true);
    expect(denyReason(result)).toContain('system-rules');
  });

  it('blocks write to other team directory', async () => {
    const hook = createGovernanceHook('my-team', paths, logger);
    const result = await hook(
      hookInput({ tool_name: 'Write', tool_input: { file_path: join(runDir, 'teams', 'rival-team', 'team-rules', 'hack.md') } }),
      'tu-g3',
      hookOpts,
    );

    expect(isDenied(result)).toBe(true);
    expect(denyReason(result)).toContain('other-team');
  });

  it('allows write to own team-rules/ and logs', async () => {
    const hook = createGovernanceHook('my-team', paths, logger);
    const result = await hook(
      hookInput({ tool_name: 'Write', tool_input: { file_path: join(runDir, 'teams', 'my-team', 'team-rules', 'style.md') } }),
      'tu-g4',
      hookOpts,
    );

    expect(result).toEqual({});
    expect(logMessages).toHaveLength(1);
    expect(logMessages[0]?.msg).toContain('self-evolution');
    expect(logMessages[0]?.meta?.['fileClass']).toBe('own-team-rules');
  });

  it('allows write to own org-rules/ and logs', async () => {
    const hook = createGovernanceHook('my-team', paths, logger);
    const result = await hook(
      hookInput({ tool_name: 'Edit', tool_input: { file_path: join(runDir, 'teams', 'my-team', 'org-rules', 'rule.md') } }),
      'tu-g5',
      hookOpts,
    );

    expect(result).toEqual({});
    expect(logMessages).toHaveLength(1);
    expect(logMessages[0]?.meta?.['fileClass']).toBe('own-org-rules');
  });

  it('allows write to own skills/ and logs', async () => {
    const hook = createGovernanceHook('my-team', paths, logger);
    const result = await hook(
      hookInput({ tool_name: 'Write', tool_input: { file_path: join(runDir, 'teams', 'my-team', 'skills', 'SKILL.md') } }),
      'tu-g6',
      hookOpts,
    );

    expect(result).toEqual({});
    expect(logMessages).toHaveLength(1);
    expect(logMessages[0]?.meta?.['fileClass']).toBe('own-skills');
  });

  it('allows write to own subagents/ and logs', async () => {
    const hook = createGovernanceHook('my-team', paths, logger);
    const result = await hook(
      hookInput({ tool_name: 'Write', tool_input: { file_path: join(runDir, 'teams', 'my-team', 'subagents', 'agent.md') } }),
      'tu-g7',
      hookOpts,
    );

    expect(result).toEqual({});
    expect(logMessages).toHaveLength(1);
    expect(logMessages[0]?.meta?.['fileClass']).toBe('own-subagents');
  });

  it('allows write to own memory/ without special log', async () => {
    const hook = createGovernanceHook('my-team', paths, logger);
    const result = await hook(
      hookInput({ tool_name: 'Write', tool_input: { file_path: join(runDir, 'teams', 'my-team', 'memory', 'notes.md') } }),
      'tu-g8',
      hookOpts,
    );

    expect(result).toEqual({});
    expect(logMessages).toHaveLength(0);
  });

  it('allows write to non-data paths (workspace)', async () => {
    const hook = createGovernanceHook('my-team', paths, logger);
    const result = await hook(
      hookInput({ tool_name: 'Write', tool_input: { file_path: '/app/workspace/work/output.txt' } }),
      'tu-g9',
      hookOpts,
    );

    expect(result).toEqual({});
  });

  it('allows when file_path is missing from tool_input', async () => {
    const hook = createGovernanceHook('my-team', paths, logger);
    const result = await hook(
      hookInput({ tool_name: 'Write', tool_input: { content: 'no path here' } }),
      'tu-g10',
      hookOpts,
    );

    expect(result).toEqual({});
  });
});

// ── UT-5: Audit Logger ─────────────────────────────────────────────────────

describe('UT-5: Audit Logger', () => {
  let logMessages: Array<{ msg: string; meta?: Record<string, unknown> }>;
  let logger: { info: (msg: string, meta?: Record<string, unknown>) => void };

  beforeEach(() => {
    logMessages = [];
    logger = {
      info: (msg: string, meta?: Record<string, unknown>) => {
        logMessages.push({ msg, meta });
      },
    };
  });

  it('PreToolUse records tool_name and params', async () => {
    const { hook } = createAuditPreHook(logger);

    await hook(
      hookInput({ tool_name: 'Read', tool_input: { file_path: '/app/workspace/file.ts' } }),
      'tu-a1',
      hookOpts,
    );

    expect(logMessages).toHaveLength(1);
    expect(logMessages[0]?.msg).toBe('PreToolUse');
    expect(logMessages[0]?.meta?.['tool']).toBe('Read');
    expect(logMessages[0]?.meta?.['toolUseId']).toBe('tu-a1');
  });

  it('PreToolUse redacts secret-like values', async () => {
    const secret = new SecretString('my-api-key-12345');
    const { hook } = createAuditPreHook(logger, [secret]);

    await hook(
      hookInput({ tool_name: 'Write', tool_input: { file_path: '/app/file', content: 'my-api-key-12345' } }),
      'tu-a2',
      hookOpts,
    );

    expect(logMessages).toHaveLength(1);
    const params = logMessages[0]?.meta?.['params'] as Record<string, unknown>;
    expect(params['content']).toBe('[REDACTED]');
    expect(params['file_path']).toBe('/app/file');
  });

  it('PreToolUse redacts team credential values via rawSecrets', async () => {
    const teamCredValues = ['sk-team-secret-abc123'];
    const { hook } = createAuditPreHook(logger, [], teamCredValues);

    await hook(
      hookInput({ tool_name: 'Bash', tool_input: { command: 'curl -H "Authorization: Bearer sk-team-secret-abc123" https://api.example.com' } }),
      'tu-cred1',
      hookOpts,
    );

    expect(logMessages).toHaveLength(1);
    const params = logMessages[0]?.meta?.['params'] as Record<string, unknown>;
    expect(params['command']).not.toContain('sk-team-secret-abc123');
    expect(params['command']).toContain('[REDACTED]');
  });

  it('PostToolUse redacts team credential values via rawSecrets', async () => {
    const teamCredValues = ['sk-team-secret-abc123'];
    const startTimes = new Map<string, number>();
    const postHook = createAuditPostHook(logger, startTimes, [], teamCredValues);

    await postHook(
      hookInput({ tool_name: 'Bash', tool_input: {}, tool_response: { output: 'key is sk-team-secret-abc123 done' } }),
      'tu-cred2',
      hookOpts,
    );

    expect(logMessages).toHaveLength(1);
    const summary = logMessages[0]?.meta?.['summary'] as string;
    expect(summary).not.toContain('sk-team-secret-abc123');
    expect(summary).toContain('[REDACTED]');
  });

  it('PostToolUse records tool_name and duration', async () => {
    const { hook: preHook, startTimes } = createAuditPreHook(logger);
    const postHook = createAuditPostHook(logger, startTimes);

    // Pre call records start time
    await preHook(
      hookInput({ tool_name: 'Read', tool_input: { file_path: '/app/file' } }),
      'tu-a3',
      hookOpts,
    );

    // Post call records duration
    await postHook(
      hookInput({ tool_name: 'Read', tool_input: { file_path: '/app/file' }, tool_response: { content: 'file contents here' } }),
      'tu-a3',
      hookOpts,
    );

    expect(logMessages).toHaveLength(2);
    const postLog = logMessages[1];
    expect(postLog?.msg).toBe('PostToolUse');
    expect(postLog?.meta?.['tool']).toBe('Read');
    expect(typeof postLog?.meta?.['durationMs']).toBe('number');
    expect((postLog?.meta?.['durationMs'] as number) >= 0).toBe(true);
  });

  it('PostToolUse truncates result summary to 200 chars', async () => {
    const startTimes = new Map<string, number>();
    const postHook = createAuditPostHook(logger, startTimes);

    const longResult = { data: 'x'.repeat(500) };
    await postHook(
      hookInput({ tool_name: 'Grep', tool_input: { pattern: 'foo' }, tool_response: longResult }),
      'tu-a4',
      hookOpts,
    );

    expect(logMessages).toHaveLength(1);
    const summary = logMessages[0]?.meta?.['summary'] as string;
    expect(summary.length).toBeLessThanOrEqual(200);
  });

  it('PostToolUse handles missing toolUseId', async () => {
    const startTimes = new Map<string, number>();
    const postHook = createAuditPostHook(logger, startTimes);

    await postHook(
      hookInput({ tool_name: 'Read', tool_input: {} }),
      undefined,
      hookOpts,
    );

    expect(logMessages).toHaveLength(1);
    expect(logMessages[0]?.meta?.['durationMs']).toBeUndefined();
  });

  // ── Dynamic credential extraction tests ──────────────────────────────

  it('PreToolUse scrubs credentials from tool_input', async () => {
    const credValue = randomBytes(16).toString('hex');
    const { hook } = createAuditPreHook(logger);

    await hook(
      hookInput({ tool_name: 'spawn_team', tool_input: { name: 'child', credentials: { api_key: credValue } } }),
      'tu-dyn1',
      hookOpts,
    );

    expect(logMessages).toHaveLength(1);
    const params = logMessages[0]?.meta?.['params'] as Record<string, unknown>;
    const paramStr = JSON.stringify(params);
    expect(paramStr).not.toContain(credValue);
    expect(paramStr).toContain('[REDACTED]');
  });

  it('PostToolUse scrubs credentials echoed in tool_response', async () => {
    const credValue = randomBytes(16).toString('hex');
    const startTimes = new Map<string, number>();
    const postHook = createAuditPostHook(logger, startTimes);

    await postHook(
      hookInput({
        tool_name: 'spawn_team',
        tool_input: { name: 'child', credentials: { api_key: credValue } },
        tool_response: { status: 'ok', echo: credValue },
      }),
      'tu-dyn2',
      hookOpts,
    );

    expect(logMessages).toHaveLength(1);
    const summary = logMessages[0]?.meta?.['summary'] as string;
    expect(summary).not.toContain(credValue);
    expect(summary).toContain('[REDACTED]');
  });

  it('PreToolUse extracts credentials generically (not tool-name specific)', async () => {
    const credValue = randomBytes(16).toString('hex');
    const { hook } = createAuditPreHook(logger);

    await hook(
      hookInput({ tool_name: 'custom_tool', tool_input: { credentials: { token: credValue } } }),
      'tu-dyn3',
      hookOpts,
    );

    expect(logMessages).toHaveLength(1);
    const params = logMessages[0]?.meta?.['params'] as Record<string, unknown>;
    const paramStr = JSON.stringify(params);
    expect(paramStr).not.toContain(credValue);
    expect(paramStr).toContain('[REDACTED]');
  });

  it('PreToolUse skips short credential values (< 8 chars)', async () => {
    const { hook } = createAuditPreHook(logger);

    await hook(
      hookInput({ tool_name: 'spawn_team', tool_input: { credentials: { pin: 'short' } } }),
      'tu-dyn4',
      hookOpts,
    );

    expect(logMessages).toHaveLength(1);
    const params = logMessages[0]?.meta?.['params'] as Record<string, unknown>;
    const paramStr = JSON.stringify(params);
    expect(paramStr).toContain('short');
  });

  it('Pre-configured rawSecrets AND dynamic credentials both scrubbed', async () => {
    const dynamicCred = randomBytes(16).toString('hex');
    const staticCred = randomBytes(16).toString('hex');
    const { hook } = createAuditPreHook(logger, [], [staticCred]);

    await hook(
      hookInput({
        tool_name: 'spawn_team',
        tool_input: {
          credentials: { new_key: dynamicCred },
          command: `use ${staticCred} and ${dynamicCred}`,
        },
      }),
      'tu-dyn5',
      hookOpts,
    );

    expect(logMessages).toHaveLength(1);
    const params = logMessages[0]?.meta?.['params'] as Record<string, unknown>;
    const paramStr = JSON.stringify(params);
    expect(paramStr).not.toContain(dynamicCred);
    expect(paramStr).not.toContain(staticCred);
  });
});

// ── Hook Composer ──────────────────────────────────────────────────────────

describe('Hook Composer: buildHookConfig', () => {
  it('returns correct structure with all hooks', () => {
    const logger = { info: vi.fn() };
    const config = buildHookConfig({
      teamName: 'test-team',
      cwd: '/app/workspace',
      additionalDirs: ['/app/common'],
      paths: { systemRulesDir: '/app/system-rules', dataDir: '/app/data', runDir: '/app/run' },
      logger,
    });

    // PreToolUse has 4 matcher entries (workspace boundary, governance+cred guard, bash guard, audit)
    expect(config.PreToolUse).toHaveLength(4);
    expect(config.PreToolUse[0]?.matcher).toBe('Read|Write|Edit|Glob|Grep');
    expect(config.PreToolUse[0]?.hooks).toHaveLength(1);
    expect(config.PreToolUse[1]?.matcher).toBe('Write|Edit');
    expect(config.PreToolUse[1]?.hooks).toHaveLength(2); // governance + credential write guard
    expect(config.PreToolUse[2]?.matcher).toBe('Bash');
    expect(config.PreToolUse[2]?.hooks).toHaveLength(1); // bash credential guard
    expect(config.PreToolUse[3]?.matcher).toBe('.*');
    expect(config.PreToolUse[3]?.hooks).toHaveLength(1);

    // PostToolUse has 1 matcher entry
    expect(config.PostToolUse).toHaveLength(1);
    expect(config.PostToolUse[0]?.matcher).toBe('.*');
    expect(config.PostToolUse[0]?.hooks).toHaveLength(1);
  });

  it('returned hooks are callable functions', () => {
    const logger = { info: vi.fn() };
    const config = buildHookConfig({
      teamName: 'test-team',
      cwd: '/app/workspace',
      additionalDirs: [],
      paths: { systemRulesDir: '/app/system-rules', dataDir: '/app/data', runDir: '/app/run' },
      logger,
    });

    for (const entry of config.PreToolUse) {
      for (const hook of entry.hooks) {
        expect(typeof hook).toBe('function');
      }
    }
    for (const entry of config.PostToolUse) {
      for (const hook of entry.hooks) {
        expect(typeof hook).toBe('function');
      }
    }
  });
});
