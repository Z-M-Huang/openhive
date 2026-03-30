#!/usr/bin/env bun
/**
 * lint-patterns.ts — Detects known anti-patterns in backend/src/**\/*.ts files.
 *
 * Exits 0 if no violations found, 1 otherwise.
 * Run: bun run scripts/lint-patterns.ts
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

// ── Config ──────────────────────────────────────────────────────────────────

const BACKEND_SRC = join(import.meta.dir, '..', 'backend', 'src');

interface PatternRule {
  name: string;
  /** Regex applied per-line (unless `multiline` is set). */
  linePattern?: RegExp;
  /** For multi-line checks, receives (lines, lineIndex) and returns true if violation. */
  check?: (lines: string[], lineIndex: number) => boolean;
  /** Relative paths (from backend/src/) where this pattern is allowed. */
  allowedIn: string[];
  /** If true, also skip test files for this pattern. */
  skipTests: boolean;
  /** Human-readable fix suggestion. */
  fix: string;
}

const RULES: PatternRule[] = [
  {
    name: 'Inline credential filter',
    linePattern: /typeof v === 'string' && v\.length >= 8/,
    allowedIn: ['domain/credential-utils.ts'],
    skipTests: true,
    fix: 'Use extractStringCredentials() from domain/credential-utils.ts',
  },
  {
    name: 'Inline error extraction',
    linePattern: /instanceof Error \? \w+\.message : String\(/,
    allowedIn: ['domain/errors.ts'],
    skipTests: true,
    fix: 'Use errorMessage() from domain/errors.ts',
  },
  {
    name: 'Bare JSON.parse without try-catch',
    check: (lines, i) => {
      if (!/JSON\.parse\(/.test(lines[i])) return false;
      // Look backwards up to 3 lines for a `try` keyword
      for (let j = i; j >= Math.max(0, i - 3); j--) {
        if (/\btry\b/.test(lines[j])) return false;
      }
      return true;
    },
    allowedIn: ['domain/safe-json.ts'],
    skipTests: true,
    fix: 'Use safeJsonParse() from domain/safe-json.ts, or wrap in try-catch',
  },
  {
    name: 'process.env spreading',
    linePattern: /env:\s*\{[^}]*\.\.\.process\.env/,
    allowedIn: [],
    skipTests: true,
    fix: 'Use an explicit env allowlist instead of spreading process.env',
  },
  {
    name: 'Governance logic definition (OWN_TEAM_PREFIXES)',
    linePattern: /\bOWN_TEAM_PREFIXES\b.*(?:export|const|let|var)\b|\b(?:export|const|let|var)\b.*\bOWN_TEAM_PREFIXES\b/,
    allowedIn: ['sessions/tools/tool-guards.ts'],
    skipTests: true,
    fix: 'Import OWN_TEAM_PREFIXES from the shared governance module',
  },
  {
    name: 'Governance classifier definition (classifyPath)',
    linePattern: /\bfunction classifyPath\b/,
    allowedIn: ['sessions/tools/tool-guards.ts'],
    skipTests: true,
    fix: 'Import classifyPath from the shared governance module',
  },
];

// ── File Collection ─────────────────────────────────────────────────────────

function collectTsFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      collectTsFiles(fullPath, files);
    } else if (entry.isFile() && extname(entry.name) === '.ts') {
      files.push(fullPath);
    }
  }
  return files;
}

function isTestFile(filePath: string): boolean {
  const name = filePath.split('/').pop() ?? '';
  return (
    name.endsWith('.test.ts') ||
    name.startsWith('__') ||
    filePath.includes('/e2e/')
  );
}

// ── Main ────────────────────────────────────────────────────────────────────

interface Violation {
  rule: string;
  file: string;
  line: number;
  text: string;
  fix: string;
}

function run(): void {
  const allFiles = collectTsFiles(BACKEND_SRC);
  const violations: Violation[] = [];

  for (const file of allFiles) {
    const relPath = relative(BACKEND_SRC, file);
    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n');

    for (const rule of RULES) {
      // Skip if this file is in the allowed list
      if (rule.allowedIn.includes(relPath)) continue;

      // Skip test files if the rule says so
      if (rule.skipTests && isTestFile(file)) continue;

      for (let i = 0; i < lines.length; i++) {
        let isViolation = false;

        if (rule.check) {
          isViolation = rule.check(lines, i);
        } else if (rule.linePattern) {
          isViolation = rule.linePattern.test(lines[i]);
        }

        if (isViolation) {
          violations.push({
            rule: rule.name,
            file: relPath,
            line: i + 1,
            text: lines[i].trim(),
            fix: rule.fix,
          });
        }
      }
    }
  }

  if (violations.length === 0) {
    console.log('lint-patterns: All clean. No anti-pattern violations found.');
    process.exit(0);
  }

  console.error(`lint-patterns: Found ${violations.length} violation(s):\n`);

  // Group by rule for readability
  const byRule = new Map<string, Violation[]>();
  for (const v of violations) {
    const list = byRule.get(v.rule) ?? [];
    list.push(v);
    byRule.set(v.rule, list);
  }

  for (const [rule, items] of byRule) {
    console.error(`  [${rule}]`);
    console.error(`  Fix: ${items[0].fix}`);
    for (const v of items) {
      console.error(`    ${v.file}:${v.line}  ${v.text}`);
    }
    console.error('');
  }

  process.exit(1);
}

run();
