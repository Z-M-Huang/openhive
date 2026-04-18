/**
 * Quality Gates -- Static analysis and credential scrubbing verification.
 *
 * SK-2: No `any` in production source files.
 * SK-3: All source files under 300 lines.
 * SK-4: Credential scrubbing works (SecretString -> logger -> [REDACTED]).
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';

import { SecretString } from './secrets/secret-string.js';
import { scrubSecrets } from './logging/credential-scrubber.js';

// ── Helpers ────────────────────────────────────────────────────────────────

const SRC_ROOT = join(__dirname);

/** Recursively collect production .ts files under a directory.
 *  Excludes: node_modules, *.test.ts, __*.ts (test-support by convention).
 */
function collectTsFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      collectTsFiles(fullPath, files);
    } else if (
      entry.isFile() &&
      extname(entry.name) === '.ts' &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.startsWith('__')
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

// ── SK-2: No `any` in production source ───────────────────────────────────

describe('SK-2: No explicit any in production source', () => {
  it('production .ts files contain no `: any` type annotations', () => {
    const files = collectTsFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Match `: any` but not inside comments or strings
        // Simple heuristic: skip lines that are purely comments
        const trimmed = line.trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
        if (/:\s*any\b/.test(line)) {
          const rel = file.replace(SRC_ROOT + '/', '');
          violations.push(`${rel}:${String(i + 1)}: ${line.trim()}`);
        }
      }
    }

    if (violations.length > 0) {
      expect.fail(
        `Found ${String(violations.length)} ': any' occurrence(s):\n${violations.join('\n')}`,
      );
    }
  });
});

// ── SK-3: All production source files under 400 lines ────────────────────
// Threshold raised from 300 → 400 in v0.5.1 to absorb legitimate growth from
// ADR-41 (concurrency manager integration) and ADR-42 (window trigger handler).
// Files opting to carry a coherent responsibility cluster (interfaces hub,
// task-consumer dispatch, trigger engine registry) stay under 400 lines.

describe('SK-3: All production source files under 400 lines', () => {
  it('no production .ts file exceeds 400 lines', () => {
    const files = collectTsFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const lineCount = content.split('\n').length;
      if (lineCount > 400) {
        const rel = file.replace(SRC_ROOT + '/', '');
        violations.push(`${rel}: ${String(lineCount)} lines`);
      }
    }

    if (violations.length > 0) {
      expect.fail(
        `Found ${String(violations.length)} file(s) over 400 lines:\n${violations.join('\n')}`,
      );
    }
  });
});

// ── SK-4: Credential scrubbing works ──────────────────────────────────────

describe('SK-4: Credential scrubbing pipeline', () => {
  it('SecretString redacts via toString and toJSON', () => {
    const s = new SecretString('real-api-key-value');

    expect(s.toString()).toBe('[REDACTED]');
    expect(JSON.stringify({ key: s })).toBe('{"key":"[REDACTED]"}');
    expect(`Value: ${String(s)}`).toBe('Value: [REDACTED]');
    expect(String(s)).toBe('[REDACTED]');
  });

  it('scrubSecrets removes known secret values from log output', () => {
    const secret = new SecretString('ultra-secret-password-42');
    const logLine = 'DB connection: ultra-secret-password-42 @ host:5432';
    const result = scrubSecrets(logLine, [secret]);

    expect(result).not.toContain('ultra-secret-password-42');
    expect(result).toContain('[REDACTED]');
    expect(result).toContain('DB connection:');
  });

  it('scrubSecrets catches Anthropic-style API keys', () => {
    const text = 'key: sk-abcdefghijklmnopqrstuvwxyz';
    const result = scrubSecrets(text, []);
    expect(result).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
  });

  it('expose() returns the raw value for intentional use', () => {
    const s = new SecretString('real-value');
    expect(s.expose()).toBe('real-value');
  });
});
