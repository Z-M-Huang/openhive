/**
 * OpenHive Backend - Memory Store
 *
 * Implements the MemoryStore interface using Drizzle ORM and better-sqlite3.
 * Provides persistence for agent memory entries.
 */

import { eq, and, desc, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { DB } from './db.js';
import { agent_memories } from './schema.js';
import type * as schema from './schema.js';

import { NotFoundError } from '../domain/errors.js';
import type { AgentMemory } from '../domain/types.js';
import type { MemoryStore } from '../domain/interfaces.js';

// ---------------------------------------------------------------------------
// Row conversion helpers
// ---------------------------------------------------------------------------

function rowToDomain(row: typeof agent_memories.$inferSelect): AgentMemory {
  return {
    id: row.id,
    agent_aid: row.agent_aid,
    key: row.key,
    value: row.value,
    metadata: row.metadata !== '' ? row.metadata : undefined,
    team_slug: row.team_slug !== '' ? row.team_slug : undefined,
    deleted_at: row.deleted_at ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function domainToRow(m: AgentMemory): typeof agent_memories.$inferInsert {
  return {
    id: m.id,
    agent_aid: m.agent_aid,
    key: m.key,
    value: m.value,
    metadata: m.metadata ?? '',
    team_slug: m.team_slug ?? '',
    deleted_at: m.deleted_at ?? null,
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Raw row type for search() — better-sqlite3 returns plain objects
// ---------------------------------------------------------------------------

/**
 * Raw row shape returned by better-sqlite3 for agent_memories.
 * Timestamps are integers (Unix ms). Nullable fields may be null.
 */
interface RawMemoryRow {
  id: string;
  agent_aid: string;
  key: string;
  value: string;
  metadata: string;
  team_slug: string;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

function rawRowToDomain(row: RawMemoryRow): AgentMemory {
  return {
    id: row.id,
    agent_aid: row.agent_aid,
    key: row.key,
    value: row.value,
    metadata: row.metadata !== '' ? row.metadata : undefined,
    team_slug: row.team_slug !== '' ? row.team_slug : undefined,
    deleted_at: row.deleted_at !== null ? new Date(row.deleted_at) : undefined,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// MemoryStoreImpl
// ---------------------------------------------------------------------------

export class MemoryStoreImpl implements MemoryStore {
  private readonly db: DB;
  private readonly writer: BetterSQLite3Database<typeof schema>;
  private readonly reader: BetterSQLite3Database<typeof schema>;

  constructor(db: DB, reader?: BetterSQLite3Database<typeof schema>) {
    this.db = db;
    this.writer = db.writer;
    this.reader = reader ?? db.writer;
  }

  async create(memory: AgentMemory): Promise<void> {
    this.writer.insert(agent_memories).values(domainToRow(memory)).run();
  }

  async get(id: string): Promise<AgentMemory> {
    const rows = this.reader
      .select()
      .from(agent_memories)
      .where(and(eq(agent_memories.id, id), isNull(agent_memories.deleted_at)))
      .all();
    if (rows.length === 0) {
      throw new NotFoundError('agent_memory', id);
    }
    return rowToDomain(rows[0]!);
  }

  async getByAgentAndKey(agentAid: string, key: string): Promise<AgentMemory> {
    const rows = this.reader
      .select()
      .from(agent_memories)
      .where(
        and(
          eq(agent_memories.agent_aid, agentAid),
          eq(agent_memories.key, key),
          isNull(agent_memories.deleted_at),
        ),
      )
      .all();
    if (rows.length === 0) {
      throw new NotFoundError('agent_memory', `${agentAid}/${key}`);
    }
    return rowToDomain(rows[0]!);
  }

  async update(memory: AgentMemory): Promise<void> {
    const result = this.writer
      .update(agent_memories)
      .set({
        agent_aid: memory.agent_aid,
        key: memory.key,
        value: memory.value,
        metadata: memory.metadata ?? '',
        updated_at: memory.updated_at,
      })
      .where(eq(agent_memories.id, memory.id))
      .run();

    if (result.changes === 0) {
      throw new NotFoundError('agent_memory', memory.id);
    }
  }

  async delete(id: string): Promise<void> {
    this.writer.delete(agent_memories).where(eq(agent_memories.id, id)).run();
  }

  async deleteAllByAgent(agentAid: string): Promise<number> {
    const result = this.writer
      .delete(agent_memories)
      .where(eq(agent_memories.agent_aid, agentAid))
      .run();
    return result.changes;
  }

  async listByAgent(agentAid: string): Promise<AgentMemory[]> {
    const rows = this.reader
      .select()
      .from(agent_memories)
      .where(and(eq(agent_memories.agent_aid, agentAid), isNull(agent_memories.deleted_at)))
      .orderBy(desc(agent_memories.updated_at))
      .all();
    return rows.map(rowToDomain);
  }

  async search(query: {
    agent_aid?: string;
    team_slug?: string;
    keyword?: string;
    since?: Date;
    limit?: number;
  }): Promise<AgentMemory[]> {
    const conditions: string[] = ['deleted_at IS NULL'];
    const params: (string | number)[] = [];

    if (query.agent_aid !== undefined) {
      conditions.push('agent_aid = ?');
      params.push(query.agent_aid);
    }

    if (query.team_slug !== undefined) {
      conditions.push('team_slug = ?');
      params.push(query.team_slug);
    }

    if (query.keyword !== undefined) {
      // Escape LIKE wildcards in the keyword
      const escaped = query.keyword
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_');
      const pattern = `%${escaped}%`;
      conditions.push("(key LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern);
    }

    if (query.since !== undefined) {
      conditions.push('updated_at >= ?');
      params.push(query.since.getTime());
    }

    const limit = query.limit ?? 100;
    const whereClause = conditions.join(' AND ');
    const sql = `SELECT * FROM agent_memories WHERE ${whereClause} ORDER BY updated_at DESC LIMIT ?`;
    params.push(limit);

    const stmt = this.db._writerConn.prepare(sql);
    const rows = stmt.all(...params) as RawMemoryRow[];
    return rows.map(rawRowToDomain);
  }

  async softDeleteByAgent(agentAid: string): Promise<number> {
    const now = Date.now();
    const stmt = this.db._writerConn.prepare(
      'UPDATE agent_memories SET deleted_at = ? WHERE agent_aid = ? AND deleted_at IS NULL',
    );
    const result = stmt.run(now, agentAid);
    return result.changes;
  }

  async softDeleteByTeam(teamSlug: string): Promise<number> {
    const now = Date.now();
    const stmt = this.db._writerConn.prepare(
      'UPDATE agent_memories SET deleted_at = ? WHERE team_slug = ? AND deleted_at IS NULL',
    );
    const result = stmt.run(now, teamSlug);
    return result.changes;
  }

  async purgeDeleted(olderThanDays: number): Promise<number> {
    const threshold = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const stmt = this.db._writerConn.prepare(
      'DELETE FROM agent_memories WHERE deleted_at IS NOT NULL AND deleted_at < ?',
    );
    const result = stmt.run(threshold);
    return result.changes;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function newMemoryStore(
  db: DB,
  reader?: BetterSQLite3Database<typeof schema>,
): MemoryStoreImpl {
  return new MemoryStoreImpl(db, reader);
}
