/**
 * Tests for memory SDK tool handlers (save_memory, recall_memory).
 *
 * Covers:
 *   - save_memory: creates new memory entry
 *   - save_memory: updates existing memory (upsert)
 *   - save_memory: passes team_slug from context.teamSlug (CSC-11)
 *   - save_memory: ignores team_slug from tool args
 *   - save_memory: validates required fields
 *   - save_memory: validates memory_type
 *   - recall_memory: delegates to MemoryStore.search()
 *   - recall_memory: accepts keyword alias for query
 *   - recall_memory: passes limit to search()
 *   - recall_memory: validates required fields
 *   - registerMemoryTools: registers both tools
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerMemoryTools } from './tools-memory.js';
import type { MemoryToolsDeps } from './tools-memory.js';
import type { MemoryStore, ToolRegistry } from '../domain/interfaces.js';
import type { AgentMemory, JsonValue } from '../domain/types.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';
import type { ToolCallContext } from './toolhandler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ToolFunc = (args: Record<string, JsonValue>, context?: ToolCallContext) => Promise<JsonValue>;

/** Creates a ToolCallContext with the given agentAid. */
function ctx(agentAid: string): ToolCallContext {
  return { teamSlug: 'main', agentAid };
}

/** Creates a silent logger. */
function makeLogger(): MemoryToolsDeps['logger'] {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

/** Search call record for verification. */
interface SearchCall {
  agent_aid?: string;
  team_slug?: string;
  keyword?: string;
  since?: Date;
  limit?: number;
}

/** Creates an in-memory mock MemoryStore with search() tracking. */
function makeMockMemoryStore(): MemoryStore & {
  memories: Map<string, AgentMemory>;
  searchCalls: SearchCall[];
} {
  const memories = new Map<string, AgentMemory>();
  const searchCalls: SearchCall[] = [];

  return {
    memories,
    searchCalls,
    async create(memory: AgentMemory) {
      memories.set(memory.id, { ...memory });
    },
    async get(id: string): Promise<AgentMemory> {
      const m = memories.get(id);
      if (m === undefined) throw new NotFoundError('agent_memory', id);
      return { ...m };
    },
    async getByAgentAndKey(agentAid: string, key: string): Promise<AgentMemory> {
      for (const m of memories.values()) {
        if (m.agent_aid === agentAid && m.key === key) {
          return { ...m };
        }
      }
      throw new NotFoundError('agent_memory', `${agentAid}/${key}`);
    },
    async update(memory: AgentMemory) {
      if (!memories.has(memory.id)) throw new NotFoundError('agent_memory', memory.id);
      memories.set(memory.id, { ...memory });
    },
    async delete(id: string) {
      memories.delete(id);
    },
    async deleteAllByAgent(agentAid: string): Promise<number> {
      let count = 0;
      for (const [id, m] of memories) {
        if (m.agent_aid === agentAid) {
          memories.delete(id);
          count++;
        }
      }
      return count;
    },
    async listByAgent(agentAid: string): Promise<AgentMemory[]> {
      const result: AgentMemory[] = [];
      for (const m of memories.values()) {
        if (m.agent_aid === agentAid) {
          result.push({ ...m });
        }
      }
      // Sort by updated_at DESC
      result.sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime());
      return result;
    },
    async search(query: {
      agent_aid?: string;
      team_slug?: string;
      keyword?: string;
      since?: Date;
      limit?: number;
    }): Promise<AgentMemory[]> {
      // Track search calls for test assertions
      searchCalls.push({ ...query });

      // In-memory search implementation matching MemoryStoreImpl behavior
      const result: AgentMemory[] = [];
      for (const m of memories.values()) {
        // Skip soft-deleted
        if (m.deleted_at !== undefined) continue;
        // Filter by agent_aid
        if (query.agent_aid !== undefined && m.agent_aid !== query.agent_aid) continue;
        // Filter by team_slug
        if (query.team_slug !== undefined && (m.team_slug ?? '') !== query.team_slug) continue;
        // Filter by keyword (substring match on key or value)
        if (query.keyword !== undefined) {
          const kw = query.keyword.toLowerCase();
          if (!m.key.toLowerCase().includes(kw) && !m.value.toLowerCase().includes(kw)) continue;
        }
        // Filter by since
        if (query.since !== undefined && m.updated_at < query.since) continue;
        result.push({ ...m });
      }
      // Sort by updated_at DESC
      result.sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime());
      // Apply limit
      const limit = query.limit ?? 100;
      return result.slice(0, limit);
    },
    async softDeleteByAgent(): Promise<number> {
      return 0;
    },
    async softDeleteByTeam(): Promise<number> {
      return 0;
    },
    async purgeDeleted(): Promise<number> {
      return 0;
    },
  };
}

/** Creates a mock ToolRegistry that captures registered tools. */
function makeMockRegistry(): ToolRegistry & { tools: Map<string, ToolFunc> } {
  const tools = new Map<string, ToolFunc>();
  return {
    tools,
    register(name: string, fn: ToolFunc) {
      tools.set(name, fn);
    },
  };
}

// ---------------------------------------------------------------------------
// registerMemoryTools
// ---------------------------------------------------------------------------

describe('registerMemoryTools', () => {
  it('registers save_memory and recall_memory', () => {
    const registry = makeMockRegistry();
    const deps: MemoryToolsDeps = {
      memoryStore: makeMockMemoryStore(),
      workspaceRoot: '/tmp/test-workspace',
      logger: makeLogger(),
    };
    registerMemoryTools(registry, deps);

    expect(registry.tools.has('save_memory')).toBe(true);
    expect(registry.tools.has('recall_memory')).toBe(true);
    expect(registry.tools.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// save_memory
// ---------------------------------------------------------------------------

describe('save_memory', () => {
  let memStore: ReturnType<typeof makeMockMemoryStore>;
  let saveFn: ToolFunc;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openhive-mem-test-'));
    memStore = makeMockMemoryStore();
    const registry = makeMockRegistry();
    registerMemoryTools(registry, {
      memoryStore: memStore,
      workspaceRoot: tmpDir,
      logger: makeLogger(),
    });
    saveFn = registry.tools.get('save_memory')!;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates a new memory entry', async () => {
    const result = await saveFn({
      key: 'user_preferences',
      content: 'prefers concise answers',
    }, ctx('aid-bot-1')) as Record<string, string>;

    expect(result['status']).toBe('created');
    expect(result['key']).toBe('user_preferences');
    expect(result['memory_id']).toBeDefined();
    expect(memStore.memories.size).toBe(1);

    const stored = [...memStore.memories.values()][0]!;
    expect(stored.agent_aid).toBe('aid-bot-1');
    expect(stored.key).toBe('user_preferences');
    expect(stored.value).toBe('prefers concise answers');
    expect(stored.metadata).toBe('curated');
  });

  it('uses "daily" memory_type when specified', async () => {
    await saveFn({
      key: 'daily_log',
      content: 'processed 5 tasks today',
      memory_type: 'daily',
    }, ctx('aid-bot-1'));

    const stored = [...memStore.memories.values()][0]!;
    expect(stored.metadata).toBe('daily');
  });

  it('updates existing memory with same agent + key (upsert)', async () => {
    // First save
    await saveFn({
      key: 'user_preferences',
      content: 'original content',
    }, ctx('aid-bot-1'));

    expect(memStore.memories.size).toBe(1);
    const firstId = [...memStore.memories.values()][0]!.id;

    // Second save with same key
    const result = await saveFn({
      key: 'user_preferences',
      content: 'updated content',
    }, ctx('aid-bot-1')) as Record<string, string>;

    expect(result['status']).toBe('updated');
    expect(result['memory_id']).toBe(firstId);
    expect(memStore.memories.size).toBe(1);

    const stored = [...memStore.memories.values()][0]!;
    expect(stored.value).toBe('updated content');
  });

  it('throws ValidationError when context has no agentAid', async () => {
    await expect(
      saveFn({ key: 'k', content: 'c' }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when key is missing', async () => {
    await expect(
      saveFn({ content: 'c' }, ctx('aid-1')),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when content is missing', async () => {
    await expect(
      saveFn({ key: 'k' }, ctx('aid-1')),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError for invalid memory_type', async () => {
    await expect(
      saveFn({ key: 'k', content: 'c', memory_type: 'invalid' }, ctx('aid-1')),
    ).rejects.toThrow(ValidationError);
  });

  it('passes team_slug from context.teamSlug when creating new memory', async () => {
    const context: ToolCallContext = { teamSlug: 'weather-team', agentAid: 'aid-bot-1' };
    await saveFn({ key: 'prefs', content: 'test content' }, context);

    const stored = [...memStore.memories.values()][0]!;
    expect(stored.team_slug).toBe('weather-team');
  });

  it('passes team_slug from context.teamSlug when updating existing memory', async () => {
    // Create memory with 'main' team context
    await saveFn({ key: 'prefs', content: 'original' }, ctx('aid-bot-1'));
    const stored1 = [...memStore.memories.values()][0]!;
    expect(stored1.team_slug).toBe('main');

    // Update with different team context
    const context2: ToolCallContext = { teamSlug: 'new-team', agentAid: 'aid-bot-1' };
    await saveFn({ key: 'prefs', content: 'updated' }, context2);

    const stored2 = [...memStore.memories.values()][0]!;
    expect(stored2.team_slug).toBe('new-team');
  });

  it('ignores team_slug from tool args — uses context only (CSC-11)', async () => {
    // Pass team_slug in args (should be ignored)
    const context: ToolCallContext = { teamSlug: 'real-team', agentAid: 'aid-bot-1' };
    await saveFn({ key: 'prefs', content: 'test', team_slug: 'attacker-team' }, context);

    const stored = [...memStore.memories.values()][0]!;
    expect(stored.team_slug).toBe('real-team');
    expect(stored.team_slug).not.toBe('attacker-team');
  });

  it('defaults team_slug to empty string when context has no teamSlug', async () => {
    // Context with empty teamSlug
    const context: ToolCallContext = { teamSlug: '', agentAid: 'aid-bot-1' };
    await saveFn({ key: 'prefs', content: 'test' }, context);

    const stored = [...memStore.memories.values()][0]!;
    expect(stored.team_slug).toBe('');
  });

  // -------------------------------------------------------------------------
  // Workspace file dual-write
  // -------------------------------------------------------------------------

  it('writes curated memory to MEMORY.md (overwrite)', async () => {
    await saveFn({
      key: 'prefs',
      content: 'first content',
    }, ctx('aid-bot-1'));

    const filePath = join(tmpDir, 'memory', 'aid-bot-1', 'MEMORY.md');
    const fileContent = await readFile(filePath, 'utf-8');
    expect(fileContent).toBe('first content');
  });

  it('overwrites MEMORY.md on curated update', async () => {
    await saveFn({ key: 'prefs', content: 'original' }, ctx('aid-bot-1'));
    await saveFn({ key: 'prefs', content: 'updated' }, ctx('aid-bot-1'));

    const filePath = join(tmpDir, 'memory', 'aid-bot-1', 'MEMORY.md');
    const fileContent = await readFile(filePath, 'utf-8');
    expect(fileContent).toBe('updated');
  });

  it('appends daily memory to YYYY-MM-DD.md', async () => {
    await saveFn({
      key: 'log1',
      content: 'first entry',
      memory_type: 'daily',
    }, ctx('aid-bot-1'));

    const dateStr = new Date().toISOString().slice(0, 10);
    const filePath = join(tmpDir, 'memory', 'aid-bot-1', `${dateStr}.md`);
    const fileContent = await readFile(filePath, 'utf-8');
    expect(fileContent).toBe('first entry\n');
  });

  it('appends multiple daily entries to the same date file', async () => {
    await saveFn({
      key: 'log1',
      content: 'entry one',
      memory_type: 'daily',
    }, ctx('aid-bot-1'));

    await saveFn({
      key: 'log2',
      content: 'entry two',
      memory_type: 'daily',
    }, ctx('aid-bot-1'));

    const dateStr = new Date().toISOString().slice(0, 10);
    const filePath = join(tmpDir, 'memory', 'aid-bot-1', `${dateStr}.md`);
    const fileContent = await readFile(filePath, 'utf-8');
    expect(fileContent).toBe('entry one\nentry two\n');
  });

  it('creates separate directories for different agents', async () => {
    await saveFn({ key: 'k', content: 'agent1 memory' }, ctx('aid-bot-1'));
    await saveFn({ key: 'k', content: 'agent2 memory' }, ctx('aid-bot-2'));

    const file1 = await readFile(join(tmpDir, 'memory', 'aid-bot-1', 'MEMORY.md'), 'utf-8');
    const file2 = await readFile(join(tmpDir, 'memory', 'aid-bot-2', 'MEMORY.md'), 'utf-8');
    expect(file1).toBe('agent1 memory');
    expect(file2).toBe('agent2 memory');
  });

  it('throws on workspace file write failure (files are source of truth)', async () => {
    // Use an invalid workspace root path (a file, not a directory)
    const registry = makeMockRegistry();
    registerMemoryTools(registry, {
      memoryStore: makeMockMemoryStore(),
      workspaceRoot: '/dev/null/impossible-path',
      logger: makeLogger(),
    });
    const failSaveFn = registry.tools.get('save_memory')!;

    // Should throw — workspace files are the source of truth
    await expect(
      failSaveFn({ key: 'test', content: 'test content' }, ctx('aid-bot-1')),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// recall_memory
// ---------------------------------------------------------------------------

describe('recall_memory', () => {
  let memStore: ReturnType<typeof makeMockMemoryStore>;
  let recallFn: ToolFunc;

  beforeEach(() => {
    memStore = makeMockMemoryStore();
    const registry = makeMockRegistry();
    registerMemoryTools(registry, {
      memoryStore: memStore,
      workspaceRoot: '/tmp/recall-test',
      logger: makeLogger(),
    });
    recallFn = registry.tools.get('recall_memory')!;

    // Seed some memories
    const now = new Date();
    memStore.memories.set('mem-1', {
      id: 'mem-1',
      agent_aid: 'aid-bot-1',
      key: 'user_preferences',
      value: 'prefers concise answers and dark mode',
      team_slug: 'main',
      created_at: now,
      updated_at: now,
    });
    memStore.memories.set('mem-2', {
      id: 'mem-2',
      agent_aid: 'aid-bot-1',
      key: 'learned_patterns',
      value: 'TypeScript projects use vitest for testing',
      team_slug: 'main',
      created_at: now,
      updated_at: new Date(now.getTime() + 1000),
    });
    memStore.memories.set('mem-3', {
      id: 'mem-3',
      agent_aid: 'aid-other',
      key: 'other_memory',
      value: 'this is another agents memory',
      team_slug: 'other-team',
      created_at: now,
      updated_at: now,
    });
  });

  it('delegates to MemoryStore.search() with agent_aid and keyword', async () => {
    await recallFn({ query: 'concise' }, ctx('aid-bot-1'));

    expect(memStore.searchCalls).toHaveLength(1);
    expect(memStore.searchCalls[0]!.agent_aid).toBe('aid-bot-1');
    expect(memStore.searchCalls[0]!.keyword).toBe('concise');
  });

  it('returns matching memories filtered by query on value', async () => {
    const result = await recallFn({
      query: 'concise',
    }, ctx('aid-bot-1')) as Array<Record<string, string>>;

    expect(result).toHaveLength(1);
    expect(result[0]!['key']).toBe('user_preferences');
    expect(result[0]!['value']).toContain('concise');
  });

  it('returns matching memories filtered by query on key', async () => {
    const result = await recallFn({
      query: 'patterns',
    }, ctx('aid-bot-1')) as Array<Record<string, string>>;

    expect(result).toHaveLength(1);
    expect(result[0]!['key']).toBe('learned_patterns');
  });

  it('returns all memories when query matches broadly', async () => {
    // Both memories for aid-bot-1 contain lowercase content
    const result = await recallFn({
      query: 'e',  // matches both values
    }, ctx('aid-bot-1')) as Array<Record<string, string>>;

    expect(result).toHaveLength(2);
  });

  it('returns empty array when no memories match', async () => {
    const result = await recallFn({
      query: 'zzzzz_nonexistent',
    }, ctx('aid-bot-1')) as Array<Record<string, string>>;

    expect(result).toHaveLength(0);
  });

  it('does not return memories from other agents', async () => {
    const result = await recallFn({
      query: 'another',
    }, ctx('aid-bot-1')) as Array<Record<string, string>>;

    expect(result).toHaveLength(0);
  });

  it('accepts keyword arg as alias for query', async () => {
    const result = await recallFn({
      keyword: 'concise',
    }, ctx('aid-bot-1')) as Array<Record<string, string>>;

    expect(result).toHaveLength(1);
    expect(result[0]!['key']).toBe('user_preferences');

    // Verify search was called with the keyword
    expect(memStore.searchCalls).toHaveLength(1);
    expect(memStore.searchCalls[0]!.keyword).toBe('concise');
  });

  it('passes limit arg to search()', async () => {
    await recallFn({ query: 'e', limit: 1 }, ctx('aid-bot-1'));

    expect(memStore.searchCalls).toHaveLength(1);
    expect(memStore.searchCalls[0]!.limit).toBe(1);
  });

  it('does not pass limit when not provided (uses search default)', async () => {
    await recallFn({ query: 'concise' }, ctx('aid-bot-1'));

    expect(memStore.searchCalls).toHaveLength(1);
    expect(memStore.searchCalls[0]!.limit).toBeUndefined();
  });

  it('throws ValidationError when context has no agentAid', async () => {
    await expect(
      recallFn({ query: 'test' }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when query is missing', async () => {
    await expect(
      recallFn({}, ctx('aid-1')),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when keyword is also missing', async () => {
    await expect(
      recallFn({ limit: 10 }, ctx('aid-1')),
    ).rejects.toThrow(ValidationError);
  });
});
