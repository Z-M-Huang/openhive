/**
 * OpenHive Backend - Memory SDK Tool Handlers
 *
 * Registers agent memory management tool handlers on the ToolHandler.
 *
 * Tools:
 *   save_memory   - writes to agent's memory files and SQLite index
 *   recall_memory - searches agent memory by keyword query
 *
 * Memory is agent-scoped: each agent has its own memory namespace
 * identified by AID. The SQLite `agent_memories` table stores the
 * searchable index; workspace files are the source of truth (handled
 * separately by the workspace file layer).
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MemoryStore } from '../domain/interfaces.js';
import type { JsonValue, AgentMemory } from '../domain/types.js';
import { ValidationError, NotFoundError } from '../domain/errors.js';
import type { ToolFunc } from './toolhandler.js';
import type { ToolRegistry } from '../domain/interfaces.js';

// ---------------------------------------------------------------------------
// MemoryToolsDeps
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into memory tool handlers.
 */
export interface MemoryToolsDeps {
  memoryStore: MemoryStore;
  /** Workspace root path for file dual-write (e.g. '/app/workspace'). */
  workspaceRoot: string;
  logger: {
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, data?: Record<string, unknown>): void;
  };
}

// ---------------------------------------------------------------------------
// registerMemoryTools
// ---------------------------------------------------------------------------

/**
 * Registers all memory management SDK custom tool handlers on the ToolHandler.
 *
 * Registers:
 *   save_memory   - save a memory entry for the calling agent
 *   recall_memory - search memories for the calling agent by keyword
 */
export function registerMemoryTools(handler: ToolRegistry, deps: MemoryToolsDeps): void {
  handler.register('save_memory', makeSaveMemory(deps));
  handler.register('recall_memory', makeRecallMemory(deps));
}

// ---------------------------------------------------------------------------
// Workspace file dual-write
// ---------------------------------------------------------------------------

/**
 * Writes memory content to workspace files (source of truth).
 *
 * - curated → overwrites `<workspace>/memory/<agent-aid>/MEMORY.md`
 * - daily   → appends to  `<workspace>/memory/<agent-aid>/YYYY-MM-DD.md`
 *
 * Throws on failure — workspace files are the source of truth per the wiki.
 * The SQLite index is a secondary index written after the file succeeds.
 */
async function writeMemoryFile(
  workspaceRoot: string,
  agentAid: string,
  memoryType: string,
  content: string,
  _logger: MemoryToolsDeps['logger'],
): Promise<void> {
  const agentDir = join(workspaceRoot, 'memory', agentAid);
  await mkdir(agentDir, { recursive: true });

  if (memoryType === 'curated') {
    const filePath = join(agentDir, 'MEMORY.md');
    await writeFile(filePath, content, 'utf-8');
  } else {
    // daily — append to YYYY-MM-DD.md
    const dateStr = new Date().toISOString().slice(0, 10);
    const filePath = join(agentDir, `${dateStr}.md`);
    await appendFile(filePath, `${content}\n`, 'utf-8');
  }
}

// ---------------------------------------------------------------------------
// save_memory
// ---------------------------------------------------------------------------

/**
 * Saves a memory entry for the calling agent. If a memory with the same
 * agent_aid + key already exists, it is updated. Otherwise a new entry
 * is created (upsert behavior).
 *
 * Args:
 *   agent_aid:   string (required) - AID of the agent saving memory
 *   key:         string (required) - memory key (e.g. "user_preferences", "learned_patterns")
 *   content:     string (required) - memory content to save
 *   memory_type: string (optional) - 'curated' or 'daily' (default 'curated')
 *
 * Returns: { memory_id, key, status }
 */
function makeSaveMemory(deps: MemoryToolsDeps): ToolFunc {
  return async (args: Record<string, JsonValue>, context?: import('./toolhandler.js').ToolCallContext): Promise<JsonValue> => {
    // Use context.agentAid exclusively (server-authenticated). Never fall back to
    // caller-supplied args.agent_aid — that would allow AID spoofing.
    const agentAid = context?.agentAid ?? '';
    const key = typeof args['key'] === 'string' ? args['key'] : '';
    const content = typeof args['content'] === 'string' ? args['content'] : '';
    const memoryType = typeof args['memory_type'] === 'string' ? args['memory_type'] : 'curated';

    if (agentAid === '') {
      throw new ValidationError('agent_aid', 'agent_aid is required (must be provided via authenticated context)');
    }
    if (key === '') {
      throw new ValidationError('key', 'key is required');
    }
    if (content === '') {
      throw new ValidationError('content', 'content is required');
    }
    if (memoryType !== 'curated' && memoryType !== 'daily') {
      throw new ValidationError('memory_type', 'memory_type must be "curated" or "daily"');
    }

    const now = new Date();

    // Check if memory with this agent_aid + key already exists
    let existingMemory: AgentMemory | null = null;
    try {
      existingMemory = await deps.memoryStore.getByAgentAndKey(agentAid, key);
    } catch (err) {
      if (!(err instanceof NotFoundError)) {
        throw err;
      }
      // NotFoundError expected when key doesn't exist yet
    }

    if (existingMemory !== null) {
      // Update existing memory
      // team_slug comes from authenticated context (CSC-11), never from tool args.
      const updated: AgentMemory = {
        ...existingMemory,
        value: content,
        metadata: memoryType,
        team_slug: context?.teamSlug ?? '',
        updated_at: now,
      };
      // Write workspace file first (source of truth), then index in SQLite.
      await writeMemoryFile(deps.workspaceRoot, agentAid, memoryType, content, deps.logger);

      await deps.memoryStore.update(updated);

      deps.logger.info('memory updated', {
        memory_id: existingMemory.id,
        agent_aid: agentAid,
        key,
        memory_type: memoryType,
      });

      return {
        memory_id: existingMemory.id,
        key,
        status: 'updated',
      } as unknown as JsonValue;
    }

    // Create new memory entry
    // team_slug comes from authenticated context (CSC-11), never from tool args.
    const memoryId = randomUUID();
    const memory: AgentMemory = {
      id: memoryId,
      agent_aid: agentAid,
      key,
      value: content,
      metadata: memoryType,
      team_slug: context?.teamSlug ?? '',
      created_at: now,
      updated_at: now,
    };

    // Write workspace file first (source of truth), then index in SQLite.
    await writeMemoryFile(deps.workspaceRoot, agentAid, memoryType, content, deps.logger);

    await deps.memoryStore.create(memory);

    deps.logger.info('memory saved', {
      memory_id: memoryId,
      agent_aid: agentAid,
      key,
      memory_type: memoryType,
    });

    return {
      memory_id: memoryId,
      key,
      status: 'created',
    } as unknown as JsonValue;
  };
}

// ---------------------------------------------------------------------------
// recall_memory
// ---------------------------------------------------------------------------

/**
 * Searches the agent's memories by keyword query. Returns matching memory
 * entries sorted by most recently updated.
 *
 * Delegates to MemoryStore.search() for filtering and pagination.
 *
 * Args:
 *   agent_aid: string (required) - AID of the agent recalling memory (from context)
 *   query:     string (required) - search query (keyword-based substring match)
 *   keyword:   string (optional) - alias for query (if query not provided)
 *   limit:     number (optional) - max results (default: search() default of 100)
 *
 * Returns: Array of { key, value, updated_at } objects
 */
function makeRecallMemory(deps: MemoryToolsDeps): ToolFunc {
  return async (args: Record<string, JsonValue>, context?: import('./toolhandler.js').ToolCallContext): Promise<JsonValue> => {
    // Use context.agentAid exclusively (server-authenticated). Never fall back to
    // caller-supplied args.agent_aid — that would allow AID spoofing.
    const agentAid = context?.agentAid ?? '';
    // Accept either 'query' or 'keyword' as the search term
    const keyword = typeof args['query'] === 'string'
      ? args['query']
      : typeof args['keyword'] === 'string'
        ? args['keyword']
        : '';
    // Optional limit (let search() use its default of 100 when undefined)
    const limit = typeof args['limit'] === 'number' ? args['limit'] : undefined;

    if (agentAid === '') {
      throw new ValidationError('agent_aid', 'agent_aid is required (must be provided via authenticated context)');
    }
    if (keyword === '') {
      throw new ValidationError('query', 'query is required');
    }

    // Delegate to MemoryStore.search() instead of in-memory filtering.
    // team_slug comes from authenticated context (CSC-11), never from tool args.
    const matched = await deps.memoryStore.search({
      agent_aid: agentAid,
      keyword,
      limit,
    });

    deps.logger.info('memory recall', {
      agent_aid: agentAid,
      query: keyword,
      matched: matched.length,
    });

    return matched.map((m) => ({
      key: m.key,
      value: m.value,
      updated_at: m.updated_at.toISOString(),
    })) as unknown as JsonValue;
  };
}
