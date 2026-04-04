/**
 * Memory Tools — UAT tests.
 *
 * Tests the 4 handler functions (memorySave, memoryDelete, memorySearch, memoryList)
 * and the buildMemoryTools() tool builder.
 *
 * Handler tests use a mock IMemoryStore.
 * Builder tests verify tool registration shape.
 *
 * Covers: UAT-13 (tool registration), UAT-14 (config cases)
 */

import { describe, it, expect, vi } from 'vitest';
import type { IMemoryStore } from '../../domain/interfaces.js';
import type { MemoryEntry, MemorySearchResult } from '../../domain/types.js';
import { memorySave } from './memory-save.js';
import { memoryDelete } from './memory-delete.js';
import { memorySearch } from './memory-search.js';
import { memoryList } from './memory-list.js';
import { buildMemoryTools } from '../../sessions/tools/memory-tools.js';
import type { OrgToolContext } from '../../sessions/tools/org-tool-context.js';

// ── Mock factory ────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
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

function makeMockStore(): {
  [K in keyof IMemoryStore]: ReturnType<typeof vi.fn>;
} {
  return {
    save: vi.fn(),
    delete: vi.fn(),
    search: vi.fn(),
    list: vi.fn(),
    getActive: vi.fn(),
    getInjectable: vi.fn(),
    removeByTeam: vi.fn(),
  };
}

// ── UAT-13: Tool Registration ───────────────────────────────────────────

describe('MemoryTools — UAT-13: Tool Registration', () => {
  function makeMinimalCtx(memoryStore?: IMemoryStore): OrgToolContext {
    return {
      teamName: 'test-team',
      orgTree: {} as OrgToolContext['orgTree'],
      spawner: {} as OrgToolContext['spawner'],
      sessionManager: {} as OrgToolContext['sessionManager'],
      taskQueue: {} as OrgToolContext['taskQueue'],
      escalationStore: {} as OrgToolContext['escalationStore'],
      runDir: '/tmp/test',
      loadConfig: () => { throw new Error('not wired'); },
      getTeamConfig: () => { throw new Error('not wired'); },
      log: () => {},
      memoryStore,
    };
  }

  it('buildMemoryTools() returns a record containing memory_save tool', () => {
    const tools = buildMemoryTools(makeMinimalCtx(makeMockStore() as unknown as IMemoryStore));
    expect(tools).toHaveProperty('memory_save');
  });

  it('buildMemoryTools() returns a record containing memory_search tool', () => {
    const tools = buildMemoryTools(makeMinimalCtx(makeMockStore() as unknown as IMemoryStore));
    expect(tools).toHaveProperty('memory_search');
  });

  it('buildMemoryTools() returns a record containing memory_list tool', () => {
    const tools = buildMemoryTools(makeMinimalCtx(makeMockStore() as unknown as IMemoryStore));
    expect(tools).toHaveProperty('memory_list');
  });

  it('buildMemoryTools() returns a record containing memory_delete tool', () => {
    const tools = buildMemoryTools(makeMinimalCtx(makeMockStore() as unknown as IMemoryStore));
    expect(tools).toHaveProperty('memory_delete');
  });

  it('tool names are bare (no mcp__ prefix)', () => {
    const tools = buildMemoryTools(makeMinimalCtx(makeMockStore() as unknown as IMemoryStore));
    for (const name of Object.keys(tools)) {
      expect(name).not.toMatch(/^mcp__/);
    }
  });

  it('returns empty object when memoryStore is undefined', () => {
    const tools = buildMemoryTools(makeMinimalCtx(undefined));
    expect(Object.keys(tools)).toHaveLength(0);
  });
});

// ── UAT-14: Handler Behavior ────────────────────────────────────────────

describe('MemoryTools — UAT-14: Handler Behavior', () => {
  it('memorySave calls store.save and returns success', async () => {
    const mockStore = makeMockStore();
    const entry = makeEntry();
    mockStore.save.mockReturnValue(entry);

    const result = await memorySave(
      { key: 'test-key', content: 'test content', type: 'context' },
      'test-team',
      { memoryStore: mockStore as unknown as IMemoryStore, log: vi.fn() },
    );

    expect(result.success).toBe(true);
    expect(result.entry).toBe(entry);
    expect(mockStore.save).toHaveBeenCalledWith('test-team', 'test-key', 'test content', 'context', undefined);
  });

  it('memorySave returns error when store throws', async () => {
    const mockStore = makeMockStore();
    mockStore.save.mockImplementation(() => { throw new Error('duplicate key'); });

    const result = await memorySave(
      { key: 'dup', content: 'c', type: 'context' },
      'test-team',
      { memoryStore: mockStore as unknown as IMemoryStore, log: vi.fn() },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('duplicate key');
  });

  it('memorySave passes supersede_reason when provided', async () => {
    const mockStore = makeMockStore();
    mockStore.save.mockReturnValue(makeEntry());

    await memorySave(
      { key: 'k', content: 'c', type: 'context', supersede_reason: 'updated' },
      'test-team',
      { memoryStore: mockStore as unknown as IMemoryStore, log: vi.fn() },
    );

    expect(mockStore.save).toHaveBeenCalledWith('test-team', 'k', 'c', 'context', 'updated');
  });

  it('memoryDelete calls store.delete and returns deleted status', async () => {
    const mockStore = makeMockStore();
    mockStore.delete.mockReturnValue(true);

    const result = await memoryDelete(
      { key: 'to-delete' },
      'test-team',
      { memoryStore: mockStore as unknown as IMemoryStore },
    );

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(true);
    expect(mockStore.delete).toHaveBeenCalledWith('test-team', 'to-delete');
  });

  it('memoryDelete returns deleted=false for nonexistent key', async () => {
    const mockStore = makeMockStore();
    mockStore.delete.mockReturnValue(false);

    const result = await memoryDelete(
      { key: 'nope' },
      'test-team',
      { memoryStore: mockStore as unknown as IMemoryStore },
    );

    expect(result.deleted).toBe(false);
  });

  it('memorySearch calls store.search and returns results', async () => {
    const mockStore = makeMockStore();
    const searchResults: MemorySearchResult[] = [
      { key: 'k1', snippet: 'found it', score: 0.9, type: 'context', is_active: true, source: 'keyword' },
    ];
    mockStore.search.mockResolvedValue(searchResults);

    const result = await memorySearch(
      { query: 'test query', max_results: 5 },
      'test-team',
      { memoryStore: mockStore as unknown as IMemoryStore },
    );

    expect(result).toBe(searchResults);
    expect(mockStore.search).toHaveBeenCalledWith('test-team', 'test query', 5, undefined);
  });

  it('memoryList calls store.list and returns entries', async () => {
    const mockStore = makeMockStore();
    const entries = [makeEntry({ key: 'k1' }), makeEntry({ key: 'k2' })];
    mockStore.list.mockReturnValue(entries);

    const result = await memoryList(
      { type: 'context' },
      'test-team',
      { memoryStore: mockStore as unknown as IMemoryStore },
    );

    expect(result).toBe(entries);
    expect(mockStore.list).toHaveBeenCalledWith('test-team', 'context');
  });

  it('memoryList passes undefined type when not provided', async () => {
    const mockStore = makeMockStore();
    mockStore.list.mockReturnValue([]);

    await memoryList(
      {},
      'test-team',
      { memoryStore: mockStore as unknown as IMemoryStore },
    );

    expect(mockStore.list).toHaveBeenCalledWith('test-team', undefined);
  });
});
