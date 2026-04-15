/**
 * Structural Invariant Tests — single-source-of-truth and codebase hygiene.
 *
 * These tests verify codebase-wide structural rules by scanning source files.
 * They are RED by design — each subsequent refactoring unit turns tests green.
 *
 * Run: bun test src/__invariants.test.ts
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

// ── Helpers ─────────────────────────────────────────────────────────────────

const SRC_ROOT = join(__dirname);

/** Recursively collect all .ts files under a directory, excluding tests and node_modules. */
function collectTsFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'e2e') continue;
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

/** Get relative path from SRC_ROOT for readable output. */
function rel(filePath: string): string {
  return relative(SRC_ROOT, filePath);
}

// ── INV-1: OWN_TEAM_PREFIXES defined in exactly 1 non-test file ────────────

describe('INV-1: OWN_TEAM_PREFIXES is single-source-of-truth', () => {
  it('OWN_TEAM_PREFIXES is defined in exactly one non-test file (domain/governance.ts)', () => {
    const files = collectTsFiles(SRC_ROOT);
    const defining: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      if (/\bOWN_TEAM_PREFIXES\b/.test(content)) {
        defining.push(rel(file));
      }
    }

    // Must be exactly 1 file — currently sessions/tools/tool-guards.ts
    expect(defining).toHaveLength(1);
    expect(defining[0]).toBe('sessions/tools/tool-guards.ts');
  });
});

// ── INV-2: classifyPath defined in exactly 1 non-test file ──────────────────

describe('INV-2: classifyPath is single-source-of-truth', () => {
  it('classifyPath is defined in exactly one non-test file (sessions/tools/tool-guards.ts)', () => {
    const files = collectTsFiles(SRC_ROOT);
    const defining: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      // Match function definitions, not just references
      if (/\bfunction classifyPath\b/.test(content)) {
        defining.push(rel(file));
      }
    }

    expect(defining).toHaveLength(1);
    expect(defining[0]).toBe('sessions/tools/tool-guards.ts');
  });
});

// ── INV-3: All credential filter patterns import from domain/credential-utils.ts ─

describe('INV-3: Credential filter patterns are centralized', () => {
  it('all credential value extraction uses domain/credential-utils.ts', () => {
    const files = collectTsFiles(SRC_ROOT);
    const targetFile = 'domain/credential-utils.ts';

    // First: the canonical module must exist
    const canonicalPath = join(SRC_ROOT, targetFile);
    expect(
      existsSync(canonicalPath),
      `Expected ${targetFile} to exist as the single source for credential extraction`,
    ).toBe(true);

    // Second: no other file should have inline credential filtering patterns
    // Pattern: .filter(... .length >= 8) on credential values
    const inlinePattern = /Object\.values\(.*credentials.*\)\.filter/;
    const violations: string[] = [];
    for (const file of files) {
      if (rel(file) === targetFile) continue;
      const content = readFileSync(file, 'utf-8');
      if (inlinePattern.test(content)) {
        violations.push(rel(file));
      }
    }

    if (violations.length > 0) {
      expect.fail(
        `Found ${String(violations.length)} file(s) with inline credential filtering (should import from ${targetFile}):\n${violations.join('\n')}`,
      );
    }
  });
});

// ── INV-4: All error extraction uses errorMessage() from domain/errors.ts ───

describe('INV-4: Error extraction uses errorMessage() utility', () => {
  it('no inline "err instanceof Error ? err.message : String(err)" patterns', () => {
    const files = collectTsFiles(SRC_ROOT);
    const inlinePattern = /instanceof Error \? \w+\.message : String\(/;
    const canonicalFile = 'domain/errors.ts'; // errorMessage() lives here — exclude it
    const violations: string[] = [];

    for (const file of files) {
      if (rel(file) === canonicalFile) continue;
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (inlinePattern.test(lines[i])) {
          violations.push(`${rel(file)}:${String(i + 1)}`);
        }
      }
    }

    if (violations.length > 0) {
      expect.fail(
        `Found ${String(violations.length)} inline error extraction(s) (should use errorMessage() from domain/errors.ts):\n${violations.join('\n')}`,
      );
    }
  });
});

// ── INV-5: No JSON.parse outside domain/safe-json.ts without try-catch ──────

describe('INV-5: JSON.parse is guarded or centralized', () => {
  it('no unguarded JSON.parse outside domain/safe-json.ts', () => {
    const files = collectTsFiles(SRC_ROOT);
    const safeJsonFile = 'domain/safe-json.ts';
    const violations: string[] = [];

    for (const file of files) {
      const relPath = rel(file);
      if (relPath === safeJsonFile) continue;

      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!/JSON\.parse/.test(line)) continue;

        // Check if this JSON.parse is inside a try block.
        // Simple heuristic: look backwards for a `try {` within 10 lines
        // that isn't closed yet.
        let insideTry = false;
        let braceDepth = 0;
        for (let j = i; j >= Math.max(0, i - 15); j--) {
          const prev = lines[j];
          // Count braces (rough heuristic)
          for (const ch of prev) {
            if (ch === '}') braceDepth++;
            if (ch === '{') braceDepth--;
          }
          if (/\btry\s*\{/.test(prev) && braceDepth <= 0) {
            insideTry = true;
            break;
          }
        }

        if (!insideTry) {
          violations.push(`${relPath}:${String(i + 1)}: ${line.trim()}`);
        }
      }
    }

    if (violations.length > 0) {
      expect.fail(
        `Found ${String(violations.length)} unguarded JSON.parse call(s) outside ${safeJsonFile}:\n${violations.join('\n')}`,
      );
    }
  });
});

// ── INV-6: No `env: { ...process.env }` in tool implementations ────────────

describe('INV-6: No env spread of process.env in tools', () => {
  it('tool implementations do not spread process.env into child processes', () => {
    const files = collectTsFiles(SRC_ROOT);
    const pattern = /env:\s*\{[^}]*\.\.\.process\.env/;
    const violations: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          violations.push(`${rel(file)}:${String(i + 1)}: ${lines[i].trim()}`);
        }
      }
    }

    if (violations.length > 0) {
      expect.fail(
        `Found ${String(violations.length)} instance(s) of env: { ...process.env } (should use allowlisted env):\n${violations.join('\n')}`,
      );
    }
  });
});

// ── INV-7: No hooks/ directory exists ───────────────────────────────────────

describe('INV-7: hooks/ directory has been removed', () => {
  it('src/hooks/ directory does not exist', () => {
    const hooksDir = join(SRC_ROOT, 'hooks');
    expect(
      existsSync(hooksDir),
      'hooks/ directory still exists — governance logic should be in domain/',
    ).toBe(false);
  });
});

// ── INV-8: No query-options.ts exists ───────────────────────────────────────

describe('INV-8: query-options.ts has been removed', () => {
  it('sessions/query-options.ts does not exist', () => {
    const queryOpts = join(SRC_ROOT, 'sessions', 'query-options.ts');
    expect(
      existsSync(queryOpts),
      'query-options.ts still exists — its logic should be inlined or consolidated',
    ).toBe(false);
  });
});

// ── INV-9: All org tools wrapped with audit hooks ─────────────────────────

describe('INV-9: All org tools have audit wrapping', () => {
  it('org tools are wrapped with audit at the assembly boundary', () => {
    // Audit wrapping is in message-handler.ts which wraps tools with withAudit
    // when assembling sessions. All tool invocation goes through the inline
    // AI SDK path.

    // Audit wrapping lives in tool-assembler.ts (imported by message-handler.ts).
    const assemblerPath = join(SRC_ROOT, 'sessions', 'tool-assembler.ts');
    expect(existsSync(assemblerPath), 'sessions/tool-assembler.ts must exist').toBe(true);
    const asmContent = readFileSync(assemblerPath, 'utf-8');
    const asmImportsAudit = /import.*withAudit/.test(asmContent) ||
      /import.*tool-audit/.test(asmContent);
    expect(
      asmImportsAudit,
      'sessions/tool-assembler.ts does not import withAudit — org tools lack audit wrapping',
    ).toBe(true);
    // Verify message-handler.ts delegates to tool-assembler.ts
    const messageHandlerPath = join(SRC_ROOT, 'sessions', 'message-handler.ts');
    const mhContent = readFileSync(messageHandlerPath, 'utf-8');
    expect(
      /import.*tool-assembler/.test(mhContent),
      'sessions/message-handler.ts must import tool-assembler.ts',
    ).toBe(true);
  });
});
