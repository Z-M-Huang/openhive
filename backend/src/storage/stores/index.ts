/**
 * Store implementations for all 10 database stores + Transactor.
 *
 * Each factory accepts a Database instance and returns an object implementing
 * the corresponding store interface from domain/interfaces.ts. Reads use
 * db.getDB() directly (WAL snapshot isolation). Writes use db.enqueueWrite()
 * for serialized mutation (INV-04).
 *
 * @module storage/stores
 */

import { eq, and, lt, lte, gte, desc, asc, sql, isNull } from 'drizzle-orm';
import type { Database } from '../database.js';
import * as schema from '../schema.js';
import type {
  TaskStore,
  MessageStore,
  LogStore,
  LogQueryOpts,
  TaskEventStore,
  ToolCallStore,
  DecisionStore,
  SessionStore,
  MemoryStore,
  MemoryQuery,
  IntegrationStore,
  CredentialStore,
  Transactor,
  TransactionCallback,
} from '../../domain/interfaces.js';
import type {
  Task,
  Message,
  LogEntry,
  TaskEvent,
  ToolCall,
  Decision,
  ChatSession,
  MemoryEntry,
  Integration,
  Credential,
} from '../../domain/domain.js';
import type { TaskStatus, IntegrationStatus } from '../../domain/enums.js';
import {
  NotFoundError,
  CycleDetectedError,
  InvalidTransitionError,
} from '../../domain/errors.js';
import { assertValidTransition } from '../../domain/domain.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse blocked_by JSON string to string[], or return empty array. */
function parseBlockedBy(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as string[];
    return [];
  } catch {
    return [];
  }
}

/** Convert DB row to Task domain type. */
function rowToTask(row: typeof schema.tasks.$inferSelect): Task {
  return {
    id: row.id,
    parent_id: row.parent_id,
    team_slug: row.team_slug,
    agent_aid: row.agent_aid,
    title: row.title,
    status: row.status as TaskStatus,
    prompt: row.prompt,
    result: row.result,
    error: row.error,
    blocked_by: parseBlockedBy(row.blocked_by),
    priority: row.priority,
    retry_count: row.retry_count,
    max_retries: row.max_retries,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at ?? null,
  };
}

/** Convert DB row to LogEntry domain type. */
function rowToLogEntry(row: typeof schema.logEntries.$inferSelect): LogEntry {
  return {
    id: row.id,
    level: row.level as LogEntry['level'],
    event_type: row.event_type,
    component: row.component,
    action: row.action,
    message: row.message,
    params: row.params,
    team_slug: row.team_slug,
    task_id: row.task_id,
    agent_aid: row.agent_aid,
    request_id: row.request_id,
    correlation_id: row.correlation_id,
    error: row.error,
    duration_ms: row.duration_ms,
    created_at: row.created_at,
  };
}

/** Convert DB row to MemoryEntry domain type. */
function rowToMemoryEntry(row: typeof schema.agentMemories.$inferSelect): MemoryEntry {
  return {
    id: row.id,
    agent_aid: row.agent_aid,
    team_slug: row.team_slug,
    content: row.content,
    memory_type: row.memory_type as MemoryEntry['memory_type'],
    created_at: row.created_at,
    deleted_at: row.deleted_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Valid integration status transitions
// ---------------------------------------------------------------------------

const VALID_INTEGRATION_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  proposed: new Set(['validated']),
  validated: new Set(['tested']),
  tested: new Set(['approved']),
  approved: new Set(['active']),
  active: new Set(['failed', 'rolled_back']),
  failed: new Set<string>(),
  rolled_back: new Set<string>(),
};

// ---------------------------------------------------------------------------
// TaskStore
// ---------------------------------------------------------------------------

export function newTaskStore(db: Database): TaskStore {
  return {
    async create(task: Task): Promise<void> {
      // Validate dependencies if any
      if (task.blocked_by && task.blocked_by.length > 0) {
        await this.validateDependencies(task.id, task.blocked_by);
      }

      await db.enqueueWrite(() => {
        db.getDB().insert(schema.tasks).values({
          id: task.id,
          parent_id: task.parent_id,
          team_slug: task.team_slug,
          agent_aid: task.agent_aid,
          title: task.title,
          status: task.status,
          prompt: task.prompt,
          result: task.result,
          error: task.error,
          blocked_by: task.blocked_by ? JSON.stringify(task.blocked_by) : null,
          priority: task.priority,
          retry_count: task.retry_count,
          max_retries: task.max_retries,
          created_at: task.created_at,
          updated_at: task.updated_at,
          completed_at: task.completed_at,
        }).run();
      });
    },

    async get(id: string): Promise<Task> {
      const row = db.getDB()
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, id))
        .get();
      if (!row) {
        throw new NotFoundError(`Task not found: ${id}`);
      }
      return rowToTask(row);
    },

    async update(task: Task): Promise<void> {
      // Validate state transition
      const existing = db.getDB()
        .select({ status: schema.tasks.status })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, task.id))
        .get();
      if (!existing) {
        throw new NotFoundError(`Task not found: ${task.id}`);
      }
      if (existing.status !== task.status) {
        assertValidTransition(existing.status as TaskStatus, task.status);
      }

      await db.enqueueWrite(() => {
        db.getDB().update(schema.tasks)
          .set({
            parent_id: task.parent_id,
            team_slug: task.team_slug,
            agent_aid: task.agent_aid,
            title: task.title,
            status: task.status,
            prompt: task.prompt,
            result: task.result,
            error: task.error,
            blocked_by: task.blocked_by ? JSON.stringify(task.blocked_by) : null,
            priority: task.priority,
            retry_count: task.retry_count,
            max_retries: task.max_retries,
            updated_at: task.updated_at,
            completed_at: task.completed_at,
          })
          .where(eq(schema.tasks.id, task.id))
          .run();
      });
    },

    async delete(id: string): Promise<void> {
      await db.enqueueWrite(() => {
        db.getDB().delete(schema.tasks).where(eq(schema.tasks.id, id)).run();
      });
    },

    async listByTeam(teamSlug: string): Promise<Task[]> {
      const rows = db.getDB()
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.team_slug, teamSlug))
        .all();
      return rows.map(rowToTask);
    },

    async listByStatus(status: TaskStatus): Promise<Task[]> {
      const rows = db.getDB()
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.status, status))
        .all();
      return rows.map(rowToTask);
    },

    async getSubtree(rootID: string): Promise<Task[]> {
      // Recursive CTE to get task + all descendants
      const conn = db.getConnection();
      const stmt = conn.prepare(`
        WITH RECURSIVE subtree AS (
          SELECT * FROM tasks WHERE id = ?
          UNION ALL
          SELECT t.* FROM tasks t
          JOIN subtree s ON t.parent_id = s.id
        )
        SELECT * FROM subtree
      `);
      const rows = stmt.all(rootID) as Array<typeof schema.tasks.$inferSelect>;
      return rows.map(rowToTask);
    },

    async getBlockedBy(taskId: string): Promise<string[]> {
      const row = db.getDB()
        .select({ blocked_by: schema.tasks.blocked_by })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, taskId))
        .get();
      if (!row) {
        throw new NotFoundError(`Task not found: ${taskId}`);
      }
      return parseBlockedBy(row.blocked_by);
    },

    async unblockTask(taskId: string, completedDependencyId: string): Promise<boolean> {
      return db.enqueueWrite(() => {
        const row = db.getDB()
          .select({ blocked_by: schema.tasks.blocked_by })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, taskId))
          .get();
        if (!row) {
          throw new NotFoundError(`Task not found: ${taskId}`);
        }

        const blockers = parseBlockedBy(row.blocked_by);
        const idx = blockers.indexOf(completedDependencyId);
        if (idx === -1) return false;

        blockers.splice(idx, 1);
        const newBlockedBy = blockers.length > 0 ? JSON.stringify(blockers) : null;

        db.getDB().update(schema.tasks)
          .set({
            blocked_by: newBlockedBy,
            updated_at: Date.now(),
          })
          .where(eq(schema.tasks.id, taskId))
          .run();

        // Return true if task is now fully unblocked
        return blockers.length === 0;
      });
    },

    async retryTask(taskId: string): Promise<boolean> {
      return db.enqueueWrite(() => {
        const row = db.getDB()
          .select({
            status: schema.tasks.status,
            retry_count: schema.tasks.retry_count,
            max_retries: schema.tasks.max_retries,
          })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, taskId))
          .get();
        if (!row) {
          throw new NotFoundError(`Task not found: ${taskId}`);
        }

        if (row.retry_count >= row.max_retries) {
          return false;
        }

        // Transition back to pending
        assertValidTransition(row.status as TaskStatus, 'pending' as TaskStatus);

        db.getDB().update(schema.tasks)
          .set({
            status: 'pending',
            retry_count: row.retry_count + 1,
            updated_at: Date.now(),
          })
          .where(eq(schema.tasks.id, taskId))
          .run();

        return true;
      });
    },

    async validateDependencies(taskId: string, blockedByIds: string[]): Promise<void> {
      // Verify all referenced tasks exist
      for (const depId of blockedByIds) {
        const exists = db.getDB()
          .select({ id: schema.tasks.id })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, depId))
          .get();
        if (!exists) {
          throw new NotFoundError(`Dependency task not found: ${depId}`);
        }
      }

      // DFS cycle detection: from each blocker, walk the dependency graph
      // checking if we can reach back to taskId
      const visited = new Set<string>();

      const dfs = (currentId: string, path: string[]): void => {
        if (currentId === taskId) {
          throw new CycleDetectedError(
            `Dependency cycle detected: ${[...path, taskId].join(' -> ')}`
          );
        }
        if (visited.has(currentId)) return;
        visited.add(currentId);

        const row = db.getDB()
          .select({ blocked_by: schema.tasks.blocked_by })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, currentId))
          .get();
        if (!row) return;

        const deps = parseBlockedBy(row.blocked_by);
        for (const dep of deps) {
          dfs(dep, [...path, currentId]);
        }
      };

      for (const blockerId of blockedByIds) {
        visited.clear();
        dfs(blockerId, [taskId]);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// MessageStore
// ---------------------------------------------------------------------------

export function newMessageStore(db: Database): MessageStore {
  return {
    async create(msg: Message): Promise<void> {
      await db.enqueueWrite(() => {
        db.getDB().insert(schema.messages).values({
          id: msg.id,
          chat_jid: msg.chat_jid,
          role: msg.role,
          content: msg.content,
          type: msg.type,
          timestamp: msg.timestamp,
        }).run();
      });
    },

    async getByChat(chatJID: string, since: Date, limit: number): Promise<Message[]> {
      const sinceTs = since.getTime();
      const rows = db.getDB()
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.chat_jid, chatJID),
            gte(schema.messages.timestamp, sinceTs),
          )
        )
        .orderBy(asc(schema.messages.timestamp))
        .limit(limit)
        .all();
      return rows as Message[];
    },

    async getLatest(chatJID: string, n: number): Promise<Message[]> {
      const rows = db.getDB()
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.chat_jid, chatJID))
        .orderBy(desc(schema.messages.timestamp))
        .limit(n)
        .all();
      // Reverse to return chronological order
      return (rows as Message[]).reverse();
    },

    async deleteByChat(chatJID: string): Promise<void> {
      await db.enqueueWrite(() => {
        db.getDB().delete(schema.messages)
          .where(eq(schema.messages.chat_jid, chatJID))
          .run();
      });
    },

    async deleteBefore(before: Date): Promise<number> {
      const ts = before.getTime();
      return db.enqueueWrite(() => {
        const result = db.getDB().delete(schema.messages)
          .where(lt(schema.messages.timestamp, ts))
          .run();
        return result.changes;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// LogStore
// ---------------------------------------------------------------------------

export function newLogStore(db: Database): LogStore {
  return {
    async create(entries: LogEntry[]): Promise<void> {
      if (entries.length === 0) return;

      await db.enqueueWrite(() => {
        // Batch insert in a single transaction for performance
        const conn = db.getConnection();
        const tx = conn.transaction(() => {
          for (const entry of entries) {
            db.getDB().insert(schema.logEntries).values({
              level: entry.level,
              event_type: entry.event_type,
              component: entry.component,
              action: entry.action,
              message: entry.message,
              params: entry.params,
              team_slug: entry.team_slug,
              task_id: entry.task_id,
              agent_aid: entry.agent_aid,
              request_id: entry.request_id,
              correlation_id: entry.correlation_id,
              error: entry.error,
              duration_ms: entry.duration_ms,
              created_at: entry.created_at,
            }).run();
          }
        });
        tx();
      });
    },

    async query(opts: LogQueryOpts): Promise<LogEntry[]> {
      const conditions = [];

      if (opts.level !== undefined) {
        conditions.push(gte(schema.logEntries.level, opts.level));
      }
      if (opts.eventType) {
        conditions.push(eq(schema.logEntries.event_type, opts.eventType));
      }
      if (opts.component) {
        conditions.push(eq(schema.logEntries.component, opts.component));
      }
      if (opts.teamSlug) {
        conditions.push(eq(schema.logEntries.team_slug, opts.teamSlug));
      }
      if (opts.taskId) {
        conditions.push(eq(schema.logEntries.task_id, opts.taskId));
      }
      if (opts.agentAid) {
        conditions.push(eq(schema.logEntries.agent_aid, opts.agentAid));
      }
      if (opts.requestId) {
        conditions.push(eq(schema.logEntries.request_id, opts.requestId));
      }
      if (opts.correlationId) {
        conditions.push(eq(schema.logEntries.correlation_id, opts.correlationId));
      }
      if (opts.since) {
        conditions.push(gte(schema.logEntries.created_at, opts.since.getTime()));
      }
      if (opts.until) {
        conditions.push(lte(schema.logEntries.created_at, opts.until.getTime()));
      }

      let query = db.getDB()
        .select()
        .from(schema.logEntries)
        .orderBy(desc(schema.logEntries.created_at))
        .$dynamic();

      if (conditions.length > 0) {
        query = query.where(and(...conditions));
      }

      if (opts.limit) {
        query = query.limit(opts.limit);
      }
      if (opts.offset) {
        query = query.offset(opts.offset);
      }

      const rows = query.all();
      return rows.map(rowToLogEntry);
    },

    async deleteBefore(before: Date): Promise<number> {
      const ts = before.getTime();
      return db.enqueueWrite(() => {
        const result = db.getDB().delete(schema.logEntries)
          .where(lt(schema.logEntries.created_at, ts))
          .run();
        return result.changes;
      });
    },

    async deleteByLevelBefore(level: number, before: Date): Promise<number> {
      const ts = before.getTime();
      return db.enqueueWrite(() => {
        const result = db.getDB().delete(schema.logEntries)
          .where(
            and(
              lte(schema.logEntries.level, level),
              lt(schema.logEntries.created_at, ts),
            )
          )
          .run();
        return result.changes;
      });
    },

    async count(): Promise<number> {
      const result = db.getDB()
        .select({ count: sql<number>`count(*)` })
        .from(schema.logEntries)
        .get();
      return result?.count ?? 0;
    },

    async getOldest(limit: number): Promise<LogEntry[]> {
      const rows = db.getDB()
        .select()
        .from(schema.logEntries)
        .orderBy(asc(schema.logEntries.created_at))
        .limit(limit)
        .all();
      return rows.map(rowToLogEntry);
    },
  };
}

// ---------------------------------------------------------------------------
// TaskEventStore
// ---------------------------------------------------------------------------

export function newTaskEventStore(db: Database): TaskEventStore {
  return {
    async create(event: TaskEvent): Promise<void> {
      await db.enqueueWrite(() => {
        db.getDB().insert(schema.taskEvents).values({
          log_entry_id: event.log_entry_id,
          task_id: event.task_id,
          from_status: event.from_status,
          to_status: event.to_status,
          agent_aid: event.agent_aid,
          reason: event.reason,
          created_at: event.created_at,
        }).run();
      });
    },

    async getByTask(taskId: string): Promise<TaskEvent[]> {
      const rows = db.getDB()
        .select()
        .from(schema.taskEvents)
        .where(eq(schema.taskEvents.task_id, taskId))
        .orderBy(asc(schema.taskEvents.created_at))
        .all();
      return rows as TaskEvent[];
    },

    async getByLogEntry(logEntryId: number): Promise<TaskEvent | null> {
      const row = db.getDB()
        .select()
        .from(schema.taskEvents)
        .where(eq(schema.taskEvents.log_entry_id, logEntryId))
        .get();
      return (row as TaskEvent) ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// ToolCallStore
// ---------------------------------------------------------------------------

export function newToolCallStore(db: Database): ToolCallStore {
  return {
    async create(call: ToolCall): Promise<void> {
      await db.enqueueWrite(() => {
        db.getDB().insert(schema.toolCalls).values({
          log_entry_id: call.log_entry_id,
          tool_use_id: call.tool_use_id,
          tool_name: call.tool_name,
          agent_aid: call.agent_aid,
          team_slug: call.team_slug,
          task_id: call.task_id,
          params: call.params,
          result_summary: call.result_summary,
          error: call.error,
          duration_ms: call.duration_ms,
          created_at: call.created_at,
        }).run();
      });
    },

    async getByTask(taskId: string): Promise<ToolCall[]> {
      const rows = db.getDB()
        .select()
        .from(schema.toolCalls)
        .where(eq(schema.toolCalls.task_id, taskId))
        .orderBy(asc(schema.toolCalls.created_at))
        .all();
      return rows as ToolCall[];
    },

    async getByAgent(agentAid: string, since: Date): Promise<ToolCall[]> {
      const ts = since.getTime();
      const rows = db.getDB()
        .select()
        .from(schema.toolCalls)
        .where(
          and(
            eq(schema.toolCalls.agent_aid, agentAid),
            gte(schema.toolCalls.created_at, ts),
          )
        )
        .orderBy(asc(schema.toolCalls.created_at))
        .all();
      return rows as ToolCall[];
    },

    async getByToolName(toolName: string, since: Date): Promise<ToolCall[]> {
      const ts = since.getTime();
      const rows = db.getDB()
        .select()
        .from(schema.toolCalls)
        .where(
          and(
            eq(schema.toolCalls.tool_name, toolName),
            gte(schema.toolCalls.created_at, ts),
          )
        )
        .orderBy(asc(schema.toolCalls.created_at))
        .all();
      return rows as ToolCall[];
    },
  };
}

// ---------------------------------------------------------------------------
// DecisionStore
// ---------------------------------------------------------------------------

export function newDecisionStore(db: Database): DecisionStore {
  return {
    async create(decision: Decision): Promise<void> {
      await db.enqueueWrite(() => {
        db.getDB().insert(schema.decisions).values({
          log_entry_id: decision.log_entry_id,
          decision_type: decision.decision_type,
          agent_aid: decision.agent_aid,
          task_id: decision.task_id,
          chosen_action: decision.chosen_action,
          alternatives: decision.alternatives,
          reasoning: decision.reasoning,
          created_at: decision.created_at,
        }).run();
      });
    },

    async getByTask(taskId: string): Promise<Decision[]> {
      const rows = db.getDB()
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.task_id, taskId))
        .orderBy(asc(schema.decisions.created_at))
        .all();
      return rows as Decision[];
    },

    async getByAgent(agentAid: string, since: Date): Promise<Decision[]> {
      const ts = since.getTime();
      const rows = db.getDB()
        .select()
        .from(schema.decisions)
        .where(
          and(
            eq(schema.decisions.agent_aid, agentAid),
            gte(schema.decisions.created_at, ts),
          )
        )
        .orderBy(asc(schema.decisions.created_at))
        .all();
      return rows as Decision[];
    },

    async getByType(type: string, since: Date): Promise<Decision[]> {
      const ts = since.getTime();
      const rows = db.getDB()
        .select()
        .from(schema.decisions)
        .where(
          and(
            eq(schema.decisions.decision_type, type),
            gte(schema.decisions.created_at, ts),
          )
        )
        .orderBy(asc(schema.decisions.created_at))
        .all();
      return rows as Decision[];
    },
  };
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

export function newSessionStore(db: Database): SessionStore {
  return {
    async get(id: string): Promise<ChatSession> {
      const row = db.getDB()
        .select()
        .from(schema.chatSessions)
        .where(eq(schema.chatSessions.chat_jid, id))
        .get();
      if (!row) {
        throw new NotFoundError(`Session not found: ${id}`);
      }
      return row as ChatSession;
    },

    async upsert(session: ChatSession): Promise<void> {
      await db.enqueueWrite(() => {
        // Check if exists
        const existing = db.getDB()
          .select({ chat_jid: schema.chatSessions.chat_jid })
          .from(schema.chatSessions)
          .where(eq(schema.chatSessions.chat_jid, session.chat_jid))
          .get();

        if (existing) {
          db.getDB().update(schema.chatSessions)
            .set({
              channel_type: session.channel_type,
              last_timestamp: session.last_timestamp,
              last_agent_timestamp: session.last_agent_timestamp,
              session_id: session.session_id,
              agent_aid: session.agent_aid,
            })
            .where(eq(schema.chatSessions.chat_jid, session.chat_jid))
            .run();
        } else {
          db.getDB().insert(schema.chatSessions).values({
            chat_jid: session.chat_jid,
            channel_type: session.channel_type,
            last_timestamp: session.last_timestamp,
            last_agent_timestamp: session.last_agent_timestamp,
            session_id: session.session_id,
            agent_aid: session.agent_aid,
          }).run();
        }
      });
    },

    async delete(id: string): Promise<void> {
      await db.enqueueWrite(() => {
        db.getDB().delete(schema.chatSessions)
          .where(eq(schema.chatSessions.chat_jid, id))
          .run();
      });
    },

    async listAll(): Promise<ChatSession[]> {
      const rows = db.getDB()
        .select()
        .from(schema.chatSessions)
        .all();
      return rows as ChatSession[];
    },
  };
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

export function newMemoryStore(db: Database): MemoryStore {
  return {
    async save(entry: MemoryEntry): Promise<void> {
      await db.enqueueWrite(() => {
        db.getDB().insert(schema.agentMemories).values({
          agent_aid: entry.agent_aid,
          team_slug: entry.team_slug,
          content: entry.content,
          memory_type: entry.memory_type,
          created_at: entry.created_at,
          deleted_at: entry.deleted_at,
        }).run();
      });
    },

    async search(query: MemoryQuery): Promise<MemoryEntry[]> {
      const conditions = [isNull(schema.agentMemories.deleted_at)];

      if (query.agentAid) {
        conditions.push(eq(schema.agentMemories.agent_aid, query.agentAid));
      }
      if (query.teamSlug) {
        conditions.push(eq(schema.agentMemories.team_slug, query.teamSlug));
      }
      if (query.since) {
        conditions.push(gte(schema.agentMemories.created_at, query.since.getTime()));
      }
      if (query.query) {
        // LIKE-based text matching on content with escaped wildcards
        const escapedQuery = query.query.replace(/[%_]/g, '\\$&');
        conditions.push(sql`${schema.agentMemories.content} LIKE ${'%' + escapedQuery + '%'} ESCAPE '\\'`);
      }

      let q = db.getDB()
        .select()
        .from(schema.agentMemories)
        .where(and(...conditions))
        .orderBy(desc(schema.agentMemories.created_at))
        .$dynamic();

      if (query.limit) {
        q = q.limit(query.limit);
      }

      const rows = q.all();
      return rows.map(rowToMemoryEntry);
    },

    async getByAgent(agentAID: string): Promise<MemoryEntry[]> {
      const rows = db.getDB()
        .select()
        .from(schema.agentMemories)
        .where(
          and(
            eq(schema.agentMemories.agent_aid, agentAID),
            isNull(schema.agentMemories.deleted_at),
          )
        )
        .orderBy(desc(schema.agentMemories.created_at))
        .all();
      return rows.map(rowToMemoryEntry);
    },

    async deleteBefore(date: Date): Promise<number> {
      const ts = date.getTime();
      return db.enqueueWrite(() => {
        const result = db.getDB().delete(schema.agentMemories)
          .where(lt(schema.agentMemories.created_at, ts))
          .run();
        return result.changes;
      });
    },

    async softDeleteByAgent(agentAID: string): Promise<number> {
      const now = Date.now();
      return db.enqueueWrite(() => {
        const result = db.getDB().update(schema.agentMemories)
          .set({ deleted_at: now })
          .where(
            and(
              eq(schema.agentMemories.agent_aid, agentAID),
              isNull(schema.agentMemories.deleted_at),
            )
          )
          .run();
        return result.changes;
      });
    },

    async softDeleteByTeam(teamSlug: string): Promise<number> {
      const now = Date.now();
      return db.enqueueWrite(() => {
        const result = db.getDB().update(schema.agentMemories)
          .set({ deleted_at: now })
          .where(
            and(
              eq(schema.agentMemories.team_slug, teamSlug),
              isNull(schema.agentMemories.deleted_at),
            )
          )
          .run();
        return result.changes;
      });
    },

    async purgeDeleted(olderThanDays: number): Promise<number> {
      const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
      return db.enqueueWrite(() => {
        const result = db.getDB().delete(schema.agentMemories)
          .where(
            and(
              sql`${schema.agentMemories.deleted_at} IS NOT NULL`,
              lte(schema.agentMemories.deleted_at, cutoff),
            )
          )
          .run();
        return result.changes;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// IntegrationStore
// ---------------------------------------------------------------------------

export function newIntegrationStore(db: Database): IntegrationStore {
  return {
    async create(integration: Integration): Promise<void> {
      await db.enqueueWrite(() => {
        db.getDB().insert(schema.integrations).values({
          id: integration.id,
          team_id: integration.team_id,
          name: integration.name,
          config_path: integration.config_path,
          status: integration.status,
          created_at: integration.created_at,
        }).run();
      });
    },

    async get(id: string): Promise<Integration> {
      const row = db.getDB()
        .select()
        .from(schema.integrations)
        .where(eq(schema.integrations.id, id))
        .get();
      if (!row) {
        throw new NotFoundError(`Integration not found: ${id}`);
      }
      return row as Integration;
    },

    async update(integration: Integration): Promise<void> {
      const existing = db.getDB()
        .select({ id: schema.integrations.id })
        .from(schema.integrations)
        .where(eq(schema.integrations.id, integration.id))
        .get();
      if (!existing) {
        throw new NotFoundError(`Integration not found: ${integration.id}`);
      }

      await db.enqueueWrite(() => {
        db.getDB().update(schema.integrations)
          .set({
            team_id: integration.team_id,
            name: integration.name,
            config_path: integration.config_path,
            status: integration.status,
          })
          .where(eq(schema.integrations.id, integration.id))
          .run();
      });
    },

    async delete(id: string): Promise<void> {
      await db.enqueueWrite(() => {
        db.getDB().delete(schema.integrations)
          .where(eq(schema.integrations.id, id))
          .run();
      });
    },

    async listByTeam(teamId: string): Promise<Integration[]> {
      const rows = db.getDB()
        .select()
        .from(schema.integrations)
        .where(eq(schema.integrations.team_id, teamId))
        .all();
      return rows as Integration[];
    },

    async updateStatus(id: string, status: IntegrationStatus): Promise<void> {
      const existing = db.getDB()
        .select({ status: schema.integrations.status })
        .from(schema.integrations)
        .where(eq(schema.integrations.id, id))
        .get();
      if (!existing) {
        throw new NotFoundError(`Integration not found: ${id}`);
      }

      const allowed = VALID_INTEGRATION_TRANSITIONS[existing.status];
      if (!allowed || !allowed.has(status)) {
        throw new InvalidTransitionError(
          `Invalid integration status transition: ${existing.status} -> ${status}`
        );
      }

      await db.enqueueWrite(() => {
        db.getDB().update(schema.integrations)
          .set({ status })
          .where(eq(schema.integrations.id, id))
          .run();
      });
    },
  };
}

// ---------------------------------------------------------------------------
// CredentialStore
// ---------------------------------------------------------------------------

export function newCredentialStore(db: Database): CredentialStore {
  return {
    async create(credential: Credential): Promise<void> {
      await db.enqueueWrite(() => {
        db.getDB().insert(schema.credentials).values({
          id: credential.id,
          name: credential.name,
          encrypted_value: credential.encrypted_value,
          team_id: credential.team_id,
          created_at: credential.created_at,
        }).run();
      });
    },

    async get(id: string): Promise<Credential> {
      const row = db.getDB()
        .select()
        .from(schema.credentials)
        .where(eq(schema.credentials.id, id))
        .get();
      if (!row) {
        throw new NotFoundError(`Credential not found: ${id}`);
      }
      return row as Credential;
    },

    async update(credential: Credential): Promise<void> {
      const existing = db.getDB()
        .select({ id: schema.credentials.id })
        .from(schema.credentials)
        .where(eq(schema.credentials.id, credential.id))
        .get();
      if (!existing) {
        throw new NotFoundError(`Credential not found: ${credential.id}`);
      }

      await db.enqueueWrite(() => {
        db.getDB().update(schema.credentials)
          .set({
            name: credential.name,
            encrypted_value: credential.encrypted_value,
            team_id: credential.team_id,
          })
          .where(eq(schema.credentials.id, credential.id))
          .run();
      });
    },

    async delete(id: string): Promise<void> {
      await db.enqueueWrite(() => {
        db.getDB().delete(schema.credentials)
          .where(eq(schema.credentials.id, id))
          .run();
      });
    },

    async listByTeam(teamId: string): Promise<Credential[]> {
      const rows = db.getDB()
        .select()
        .from(schema.credentials)
        .where(eq(schema.credentials.team_id, teamId))
        .all();
      return rows as Credential[];
    },
  };
}

// ---------------------------------------------------------------------------
// Transactor
// ---------------------------------------------------------------------------

export function newTransactor(db: Database): Transactor {
  return {
    async withTransaction<T>(fn: TransactionCallback<T>): Promise<T> {
      return db.enqueueWrite(() => {
        const conn = db.getConnection();
        let result: T;
        const tx = conn.transaction(() => {
          // better-sqlite3 transactions are synchronous. The callback must
          // return T synchronously (not a Promise). The TransactionCallback
          // type allows T | Promise<T> for interface flexibility, but at
          // the better-sqlite3 layer only sync execution is supported.
          const syncResult = fn(conn as unknown);
          if (syncResult instanceof Promise) {
            throw new Error(
              'Transaction callback must be synchronous when using better-sqlite3'
            );
          }
          result = syncResult as T;
        });
        tx();
        return result!;
      });
    },
  };
}
