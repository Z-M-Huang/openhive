/**
 * Layer 4 Phase Gate -- Hooks + Governance
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

import { createWorkspaceBoundaryHook } from '../hooks/workspace-boundary.js';
import { createGovernanceHook } from '../hooks/governance.js';
import { createAuditPreHook, createAuditPostHook } from '../hooks/audit-logger.js';
import { buildHookConfig } from '../hooks/index.js';
import { SecretString } from '../secrets/secret-string.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `openhive-l4-${randomBytes(8).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function isDenied(result: Record<string, unknown>): boolean {
  const out = result['hookSpecificOutput'] as Record<string, unknown> | undefined;
  return out?.['permissionDecision'] === 'deny';
}

function denyReason(result: Record<string, unknown>): string {
  const out = result['hookSpecificOutput'] as Record<string, unknown>;
  return out['permissionDecisionReason'] as string;
}

const emptyCtx = {};

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
      { tool_name: 'Read', tool_input: { file_path: join(cwd, '..', 'etc', 'passwd') } },
      'tu-1',
      emptyCtx,
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
      { tool_name: 'Read', tool_input: { file_path: join(linkPath, 'secret.txt') } },
      'tu-2',
      emptyCtx,
    );

    expect(isDenied(result)).toBe(true);
    expect(denyReason(result)).toContain('outside workspace boundaries');
  });

  it('allows files within cwd', async () => {
    const hook = createWorkspaceBoundaryHook(cwd, []);
    const result = await hook(
      { tool_name: 'Write', tool_input: { file_path: join(cwd, 'file.txt') } },
      'tu-3',
      emptyCtx,
    );

    expect(result).toEqual({});
  });

  it('allows files within additionalDirectories', async () => {
    const extraDir = makeTmpDir();
    try {
      const hook = createWorkspaceBoundaryHook(cwd, [extraDir]);
      const result = await hook(
        { tool_name: 'Edit', tool_input: { file_path: join(extraDir, 'allowed.ts') } },
        'tu-4',
        emptyCtx,
      );

      expect(result).toEqual({});
    } finally {
      if (existsSync(extraDir)) rmSync(extraDir, { recursive: true });
    }
  });

  it('extracts path from Read tool_input (file_path)', async () => {
    const hook = createWorkspaceBoundaryHook(cwd, []);
    const result = await hook(
      { tool_name: 'Read', tool_input: { file_path: join(cwd, 'readme.md') } },
      'tu-5',
      emptyCtx,
    );
    expect(result).toEqual({});
  });

  it('extracts path from Write tool_input (file_path)', async () => {
    const hook = createWorkspaceBoundaryHook(cwd, []);
    const result = await hook(
      { tool_name: 'Write', tool_input: { file_path: '/tmp/outside/file' } },
      'tu-6',
      emptyCtx,
    );
    expect(isDenied(result)).toBe(true);
  });

  it('extracts path from Edit tool_input (file_path)', async () => {
    const hook = createWorkspaceBoundaryHook(cwd, []);
    const result = await hook(
      { tool_name: 'Edit', tool_input: { file_path: join(cwd, 'src', 'code.ts') } },
      'tu-7',
      emptyCtx,
    );
    expect(result).toEqual({});
  });

  it('extracts path from Glob tool_input (path)', async () => {
    const hook = createWorkspaceBoundaryHook(cwd, []);
    const result = await hook(
      { tool_name: 'Glob', tool_input: { path: cwd, pattern: '**/*.ts' } },
      'tu-8',
      emptyCtx,
    );
    expect(result).toEqual({});
  });

  it('extracts path from Glob tool_input (pattern as fallback)', async () => {
    const hook = createWorkspaceBoundaryHook(cwd, []);
    const result = await hook(
      { tool_name: 'Glob', tool_input: { pattern: join(cwd, 'src') } },
      'tu-9',
      emptyCtx,
    );
    expect(result).toEqual({});
  });

  it('extracts path from Grep tool_input (path)', async () => {
    const hook = createWorkspaceBoundaryHook(cwd, []);
    const result = await hook(
      { tool_name: 'Grep', tool_input: { path: join(cwd, 'search-here'), pattern: 'foo' } },
      'tu-10',
      emptyCtx,
    );
    expect(result).toEqual({});
  });

  it('allows when tool_input has no extractable path', async () => {
    const hook = createWorkspaceBoundaryHook(cwd, []);
    const result = await hook(
      { tool_name: 'Grep', tool_input: { pattern: 'hello' } },
      'tu-11',
      emptyCtx,
    );
    expect(result).toEqual({});
  });
});

// ── UT-5: Governance Hook ──────────────────────────────────────────────────

describe('UT-5: Governance Hook', () => {
  let dataDir: string;
  let logMessages: Array<{ msg: string; meta?: Record<string, unknown> }>;
  let logger: { info: (msg: string, meta?: Record<string, unknown>) => void };

  beforeEach(() => {
    dataDir = makeTmpDir();
    logMessages = [];
    logger = {
      info: (msg: string, meta?: Record<string, unknown>) => {
        logMessages.push({ msg, meta });
      },
    };
  });

  afterEach(() => {
    if (existsSync(dataDir)) rmSync(dataDir, { recursive: true });
  });

  it('blocks write to /data/rules/global/', async () => {
    const hook = createGovernanceHook('my-team', dataDir, logger);
    const result = await hook(
      { tool_name: 'Write', tool_input: { file_path: join(dataDir, 'rules', 'global', 'safety.md') } },
      'tu-g1',
      emptyCtx,
    );

    expect(isDenied(result)).toBe(true);
    expect(denyReason(result)).toContain('global-rules');
  });

  it('blocks write to /data/main/org-rules/', async () => {
    const hook = createGovernanceHook('my-team', dataDir, logger);
    const result = await hook(
      { tool_name: 'Edit', tool_input: { file_path: join(dataDir, 'main', 'org-rules', 'policy.md') } },
      'tu-g2',
      emptyCtx,
    );

    expect(isDenied(result)).toBe(true);
    expect(denyReason(result)).toContain('main-org-rules');
  });

  it('blocks write to other team directory', async () => {
    const hook = createGovernanceHook('my-team', dataDir, logger);
    const result = await hook(
      { tool_name: 'Write', tool_input: { file_path: join(dataDir, 'teams', 'rival-team', 'team-rules', 'hack.md') } },
      'tu-g3',
      emptyCtx,
    );

    expect(isDenied(result)).toBe(true);
    expect(denyReason(result)).toContain('other-team');
  });

  it('allows write to own team-rules/ and logs', async () => {
    const hook = createGovernanceHook('my-team', dataDir, logger);
    const result = await hook(
      { tool_name: 'Write', tool_input: { file_path: join(dataDir, 'teams', 'my-team', 'team-rules', 'style.md') } },
      'tu-g4',
      emptyCtx,
    );

    expect(result).toEqual({});
    expect(logMessages).toHaveLength(1);
    expect(logMessages[0]?.msg).toContain('self-evolution');
    expect(logMessages[0]?.meta?.['fileClass']).toBe('own-team-rules');
  });

  it('allows write to own org-rules/ and logs', async () => {
    const hook = createGovernanceHook('my-team', dataDir, logger);
    const result = await hook(
      { tool_name: 'Edit', tool_input: { file_path: join(dataDir, 'teams', 'my-team', 'org-rules', 'rule.md') } },
      'tu-g5',
      emptyCtx,
    );

    expect(result).toEqual({});
    expect(logMessages).toHaveLength(1);
    expect(logMessages[0]?.meta?.['fileClass']).toBe('own-org-rules');
  });

  it('allows write to own skills/ and logs', async () => {
    const hook = createGovernanceHook('my-team', dataDir, logger);
    const result = await hook(
      { tool_name: 'Write', tool_input: { file_path: join(dataDir, 'teams', 'my-team', 'skills', 'SKILL.md') } },
      'tu-g6',
      emptyCtx,
    );

    expect(result).toEqual({});
    expect(logMessages).toHaveLength(1);
    expect(logMessages[0]?.meta?.['fileClass']).toBe('own-skills');
  });

  it('allows write to own subagents/ and logs', async () => {
    const hook = createGovernanceHook('my-team', dataDir, logger);
    const result = await hook(
      { tool_name: 'Write', tool_input: { file_path: join(dataDir, 'teams', 'my-team', 'subagents', 'agent.md') } },
      'tu-g7',
      emptyCtx,
    );

    expect(result).toEqual({});
    expect(logMessages).toHaveLength(1);
    expect(logMessages[0]?.meta?.['fileClass']).toBe('own-subagents');
  });

  it('allows write to own memory/ without special log', async () => {
    const hook = createGovernanceHook('my-team', dataDir, logger);
    const result = await hook(
      { tool_name: 'Write', tool_input: { file_path: join(dataDir, 'teams', 'my-team', 'memory', 'notes.md') } },
      'tu-g8',
      emptyCtx,
    );

    expect(result).toEqual({});
    expect(logMessages).toHaveLength(0);
  });

  it('allows write to non-data paths (workspace)', async () => {
    const hook = createGovernanceHook('my-team', dataDir, logger);
    const result = await hook(
      { tool_name: 'Write', tool_input: { file_path: '/app/workspace/work/output.txt' } },
      'tu-g9',
      emptyCtx,
    );

    expect(result).toEqual({});
  });

  it('allows when file_path is missing from tool_input', async () => {
    const hook = createGovernanceHook('my-team', dataDir, logger);
    const result = await hook(
      { tool_name: 'Write', tool_input: { content: 'no path here' } },
      'tu-g10',
      emptyCtx,
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
      { tool_name: 'Read', tool_input: { file_path: '/app/workspace/file.ts' } },
      'tu-a1',
      emptyCtx,
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
      { tool_name: 'Write', tool_input: { file_path: '/app/file', content: 'my-api-key-12345' } },
      'tu-a2',
      emptyCtx,
    );

    expect(logMessages).toHaveLength(1);
    const params = logMessages[0]?.meta?.['params'] as Record<string, unknown>;
    expect(params['content']).toBe('[REDACTED]');
    expect(params['file_path']).toBe('/app/file');
  });

  it('PostToolUse records tool_name and duration', async () => {
    const { hook: preHook, startTimes } = createAuditPreHook(logger);
    const postHook = createAuditPostHook(logger, startTimes);

    // Pre call records start time
    await preHook(
      { tool_name: 'Read', tool_input: { file_path: '/app/file' } },
      'tu-a3',
      emptyCtx,
    );

    // Post call records duration
    await postHook(
      { tool_name: 'Read', tool_input: { file_path: '/app/file' } },
      'tu-a3',
      emptyCtx,
      { content: 'file contents here' },
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
      { tool_name: 'Grep', tool_input: { pattern: 'foo' } },
      'tu-a4',
      emptyCtx,
      longResult,
    );

    expect(logMessages).toHaveLength(1);
    const summary = logMessages[0]?.meta?.['summary'] as string;
    expect(summary.length).toBeLessThanOrEqual(200);
  });

  it('PostToolUse handles missing toolUseId', async () => {
    const startTimes = new Map<string, number>();
    const postHook = createAuditPostHook(logger, startTimes);

    await postHook(
      { tool_name: 'Read', tool_input: {} },
      undefined,
      emptyCtx,
    );

    expect(logMessages).toHaveLength(1);
    expect(logMessages[0]?.meta?.['durationMs']).toBeUndefined();
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
      dataDir: '/app/data',
      logger,
    });

    // PreToolUse has 3 matcher entries
    expect(config.PreToolUse).toHaveLength(3);
    expect(config.PreToolUse[0]?.matcher).toBe('Read|Write|Edit|Glob|Grep');
    expect(config.PreToolUse[0]?.hooks).toHaveLength(1);
    expect(config.PreToolUse[1]?.matcher).toBe('Write|Edit');
    expect(config.PreToolUse[1]?.hooks).toHaveLength(1);
    expect(config.PreToolUse[2]?.matcher).toBe('.*');
    expect(config.PreToolUse[2]?.hooks).toHaveLength(1);

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
      dataDir: '/app/data',
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
