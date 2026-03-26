/**
 * Memory Loader
 *
 * Tests: buildMemorySection for empty, populated, corrupt, whitespace MEMORY.md
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync } from 'node:fs';

import { buildMemorySection } from './memory-loader.js';
import { MemoryStore } from '../storage/stores/memory-store.js';

// ── Memory Loader ────────────────────────────────────────────────────────

describe('Memory Loader', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openhive-l6-mem-'));
    // MemoryStore baseDir = .run/teams/, so files go to {baseDir}/{team}/memory/{file}
    store = new MemoryStore(dir);
    // Create the memory directory for the test team
    mkdirSync(join(dir, 'test-team', 'memory'), { recursive: true });
  });

  it('returns empty string when no MEMORY.md exists', () => {
    expect(buildMemorySection(store, 'test-team')).toBe('');
  });

  it('injects MEMORY.md content with header', () => {
    store.writeFile('test-team', 'MEMORY.md', '# Memory Index\nTeam context here');
    const result = buildMemorySection(store, 'test-team');
    expect(result).toContain('--- Team Memory ---');
    expect(result).toContain('# Memory Index');
  });

  it('does NOT inject other memory files (no fallbacks)', () => {
    store.writeFile('test-team', 'context.md', 'This should NOT appear');
    store.writeFile('test-team', 'decisions.md', 'This too');
    const result = buildMemorySection(store, 'test-team');
    expect(result).toBe(''); // Only MEMORY.md is injected
  });

  it('handles corrupt/unreadable MEMORY.md gracefully', () => {
    const badStore = {
      readFile: () => { throw new Error('permission denied'); },
      writeFile: store.writeFile.bind(store),
      listFiles: store.listFiles.bind(store),
    };
    const result = buildMemorySection(badStore, 'test-team');
    expect(result).toBe('');
  });

  it('skips empty/whitespace MEMORY.md', () => {
    store.writeFile('test-team', 'MEMORY.md', '   ');
    const result = buildMemorySection(store, 'test-team');
    expect(result).toBe('');
  });
});
