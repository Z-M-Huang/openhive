/**
 * Rule loader tests (migrated from layer-3.test.ts)
 *
 * UT-3: Rule loader reads .md files sorted, ignores non-.md, handles missing/empty dirs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { loadRulesFromDirectory } from './loader.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `openhive-l3-${randomBytes(8).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── UT-3: Rule Loader ─────────────────────────────────────────────────────

describe('UT-3: Rule Loader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it('reads .md files sorted by filename', () => {
    writeFileSync(join(tmpDir, 'b-rule.md'), '# B Rule\nContent B');
    writeFileSync(join(tmpDir, 'a-rule.md'), '# A Rule\nContent A');
    writeFileSync(join(tmpDir, 'c-rule.md'), '# C Rule\nContent C');

    const rules = loadRulesFromDirectory(tmpDir);
    expect(rules).toHaveLength(3);
    expect(rules[0]?.filename).toBe('a-rule.md');
    expect(rules[1]?.filename).toBe('b-rule.md');
    expect(rules[2]?.filename).toBe('c-rule.md');
    expect(rules[0]?.content).toBe('# A Rule\nContent A');
  });

  it('ignores non-.md files', () => {
    writeFileSync(join(tmpDir, 'valid.md'), '# Valid');
    writeFileSync(join(tmpDir, 'readme.txt'), 'not a rule');
    writeFileSync(join(tmpDir, 'config.yaml'), 'key: value');
    writeFileSync(join(tmpDir, '.hidden'), 'hidden');

    const rules = loadRulesFromDirectory(tmpDir);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.filename).toBe('valid.md');
  });

  it('returns empty array for missing directory', () => {
    const rules = loadRulesFromDirectory(join(tmpDir, 'nonexistent'));
    expect(rules).toEqual([]);
  });

  it('returns empty array for empty directory', () => {
    const emptyDir = join(tmpDir, 'empty');
    mkdirSync(emptyDir);

    const rules = loadRulesFromDirectory(emptyDir);
    expect(rules).toEqual([]);
  });

  it('returns empty array for directory with no .md files', () => {
    writeFileSync(join(tmpDir, 'data.json'), '{}');
    writeFileSync(join(tmpDir, 'notes.txt'), 'hello');

    const rules = loadRulesFromDirectory(tmpDir);
    expect(rules).toEqual([]);
  });
});
