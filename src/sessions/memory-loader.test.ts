/**
 * Memory Loader — UAT tests.
 *
 * Tests buildMemorySection() which queries IMemoryStore for injectable
 * entries and formats them as a structured prompt section.
 *
 * Covers: UAT-6 (injection format)
 */

import { describe, it, expect, vi } from 'vitest';
import type { IMemoryStore } from '../domain/interfaces.js';
import type { MemoryEntry } from '../domain/types.js';
import { buildMemorySection } from './memory-loader.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: 1,
    team_name: 'test-team',
    key: 'test-key',
    content: 'test content',
    type: 'context',
    is_active: true,
    supersedes_id: null,
    supersede_reason: null,
    updated_by: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeMockStore(entries: MemoryEntry[] = []): IMemoryStore {
  return {
    save: vi.fn(),
    delete: vi.fn(),
    search: vi.fn(),
    list: vi.fn(),
    getActive: vi.fn(),
    getInjectable: vi.fn().mockReturnValue(entries),
    removeByTeam: vi.fn(),
  };
}

// ── UAT-6: Injection Format ─────────────────────────────────────────────

describe('Memory Loader — UAT-6: Injection Format', () => {
  it('returns empty string when store is undefined', () => {
    const result = buildMemorySection(undefined, 'test-team');
    expect(result).toBe('');
  });

  it('returns empty string when store has no entries for the team', () => {
    const store = makeMockStore([]);
    const result = buildMemorySection(store, 'test-team');
    expect(result).toBe('');
  });

  it('injects entries with a header marker (--- Memory ---)', () => {
    const store = makeMockStore([makeEntry({ type: 'context', key: 'k1', content: 'c1' })]);
    const result = buildMemorySection(store, 'test-team');
    expect(result).toContain('--- Memory ---');
  });

  it('renders each entry with its type label and content', () => {
    const store = makeMockStore([
      makeEntry({ type: 'context', key: 'project', content: 'We build robots' }),
    ]);

    const result = buildMemorySection(store, 'test-team');

    expect(result).toContain('[CONTEXT]');
    expect(result).toContain('[project]: We build robots');
  });

  it('groups entries by type with type label as header', () => {
    const store = makeMockStore([
      makeEntry({ type: 'identity', key: 'who', content: 'We are engineers' }),
      makeEntry({ type: 'context', key: 'what', content: 'Building a platform' }),
    ]);

    const result = buildMemorySection(store, 'test-team');

    expect(result).toContain('[IDENTITY]');
    expect(result).toContain('[CONTEXT]');
  });

  it('orders entries by type: IDENTITY > LESSON > DECISION > CONTEXT', () => {
    // Feed entries in reverse order to test that output follows canonical order
    const store = makeMockStore([
      makeEntry({ type: 'context', key: 'ctx', content: 'c' }),
      makeEntry({ type: 'decision', key: 'dec', content: 'd' }),
      makeEntry({ type: 'lesson', key: 'les', content: 'l' }),
      makeEntry({ type: 'identity', key: 'id', content: 'i' }),
    ]);

    const result = buildMemorySection(store, 'test-team');

    const identityPos = result.indexOf('[IDENTITY]');
    const lessonPos = result.indexOf('[LESSON]');
    const decisionPos = result.indexOf('[DECISION]');
    const contextPos = result.indexOf('[CONTEXT]');

    expect(identityPos).toBeLessThan(lessonPos);
    expect(lessonPos).toBeLessThan(decisionPos);
    expect(decisionPos).toBeLessThan(contextPos);
  });

  it('logs console.warn when entries >= 40 (80% of 50 cap)', () => {
    const entries = Array.from({ length: 42 }, (_, i) =>
      makeEntry({ id: i + 1, key: `k${String(i)}`, content: `c${String(i)}`, type: 'context' }),
    );
    const store = makeMockStore(entries);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildMemorySection(store, 'test-team');

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('42 injected memories'),
    );
    warnSpy.mockRestore();
  });

  it('does not log warning when entries < 40', () => {
    const entries = [makeEntry({ type: 'context', key: 'k1', content: 'c1' })];
    const store = makeMockStore(entries);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildMemorySection(store, 'test-team');

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('calls getInjectable with team name and limit 50', () => {
    const store = makeMockStore([]);
    buildMemorySection(store, 'my-team');

    expect(store.getInjectable).toHaveBeenCalledWith('my-team', 50);
  });
});
