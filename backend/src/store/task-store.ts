/**
 * OpenHive Backend - Task Store
 *
 * Implements the TaskStore interface using Drizzle ORM and better-sqlite3.
 *
 * Design notes:
 *   - TaskStatus is stored as an integer in the DB (pending=0 ...
 *     cancelled=4) and converted to/from the TypeScript string enum on read.
 *   - All SELECT operations use db.writer in practice because newInMemoryDB()
 *     creates two independent in-memory databases; production code should
 *     also call through db.writer for write-path consistency.  Where a
 *     real file-based DB is used, the reader connection can be swapped in
 *     transparently — the store methods accept a configurable reader at
 *     construction time (defaults to db.writer so that in-memory tests work
 *     without special configuration).
 *   - GetSubtree executes a recursive CTE via the raw better-sqlite3 API
 *     because Drizzle does not yet have first-class recursive CTE support.
 *   - ListByTeamPaginated and GetSubtreeWithDepth are extra methods beyond
 *     the domain.TaskStore interface.
 */

import { eq, desc, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { DB } from './db.js';
import { tasks } from './schema.js';
import type * as schema from './schema.js';

import { NotFoundError } from '../domain/errors.js';
import { TASK_STATUSES } from '../domain/enums.js';
import type { Task } from '../domain/types.js';
import type { TaskStatus } from '../domain/enums.js';
import type { TaskStore } from '../domain/interfaces.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SUBTREE_MAX_DEPTH = 100;

// ---------------------------------------------------------------------------
// Row shape returned by the recursive CTE raw query
// ---------------------------------------------------------------------------

/**
 * The raw row returned by the recursive CTE SELECT.
 * better-sqlite3 returns plain objects with column names as keys.
 * Timestamps come back as numbers (Unix ms integers).
 */
interface TaskCTERow {
  id: string;
  parent_id: string;
  team_slug: string;
  agent_aid: string;
  jid: string;
  status: number;
  prompt: string;
  result: string;
  error: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/**
 * taskStatusToInt converts a TypeScript TaskStatus string to the integer value
 * stored in the database:
 *   pending=0, running=1, completed=2, failed=3, cancelled=4
 */
function taskStatusToInt(status: TaskStatus): number {
  return TASK_STATUSES.indexOf(status);
}

/**
 * intToTaskStatus converts a database integer back to the TypeScript
 * TaskStatus string. Returns 'pending' as a safe default for out-of-range
 * values (should never happen in a healthy database).
 */
function intToTaskStatus(n: number): TaskStatus {
  const status = TASK_STATUSES[n];
  if (status === undefined) {
    return 'pending';
  }
  return status;
}

/**
 * taskRowToDomain converts a Drizzle-typed row (from schema.tasks) to a
 * domain Task. The Drizzle integer(mode:'timestamp_ms') columns are mapped
 * to Date by Drizzle automatically; completed_at may be null.
 */
function taskRowToDomain(row: typeof tasks.$inferSelect): Task {
  return {
    id: row.id,
    parent_id: row.parent_id !== '' ? row.parent_id : undefined,
    team_slug: row.team_slug,
    agent_aid: row.agent_aid !== '' ? row.agent_aid : undefined,
    jid: row.jid !== '' ? row.jid : undefined,
    status: intToTaskStatus(row.status),
    prompt: row.prompt,
    result: row.result !== '' ? row.result : undefined,
    error: row.error !== '' ? row.error : undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at ?? null,
  };
}

/**
 * taskToRow converts a domain Task to the Drizzle insert shape for schema.tasks.
 * Optional string fields become empty strings (matching the NOT NULL DEFAULT ''
 * column constraints). completed_at is explicitly null when not set.
 */
function taskToRow(task: Task): typeof tasks.$inferInsert {
  return {
    id: task.id,
    parent_id: task.parent_id ?? '',
    team_slug: task.team_slug,
    agent_aid: task.agent_aid ?? '',
    jid: task.jid ?? '',
    status: taskStatusToInt(task.status),
    prompt: task.prompt,
    result: task.result ?? '',
    error: task.error ?? '',
    created_at: task.created_at,
    updated_at: task.updated_at,
    completed_at: task.completed_at ?? null,
  };
}

/**
 * cteRowToDomain converts a raw CTE result row (plain integer timestamps)
 * to a domain Task. The CTE returns integers directly, not Date objects,
 * so we must wrap them in new Date().
 */
function cteRowToDomain(row: TaskCTERow): Task {
  return {
    id: row.id,
    parent_id: row.parent_id !== '' ? row.parent_id : undefined,
    team_slug: row.team_slug,
    agent_aid: row.agent_aid !== '' ? row.agent_aid : undefined,
    jid: row.jid !== '' ? row.jid : undefined,
    status: intToTaskStatus(row.status),
    prompt: row.prompt,
    result: row.result !== '' ? row.result : undefined,
    error: row.error !== '' ? row.error : undefined,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    completed_at: row.completed_at !== null ? new Date(row.completed_at) : null,
  };
}

// ---------------------------------------------------------------------------
// TaskStoreImpl
// ---------------------------------------------------------------------------

/**
 * TaskStoreImpl implements domain.TaskStore using Drizzle ORM.
 *
 * The reader parameter defaults to db.writer. When using a file-based DB
 * with WAL mode, pass db.reader for concurrent read performance. When using
 * newInMemoryDB() in tests, always use db.writer (the two in-memory
 * connections are independent and do not share data).
 */
export class TaskStoreImpl implements TaskStore {
  private readonly writer: BetterSQLite3Database<typeof schema>;
  private readonly reader: BetterSQLite3Database<typeof schema>;
  private readonly db: DB;

  constructor(db: DB, reader?: BetterSQLite3Database<typeof schema>) {
    this.db = db;
    this.writer = db.writer;
    // Default reader to writer so in-memory tests see consistent data.
    this.reader = reader ?? db.writer;
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  /**
   * create inserts a new task into the database.
   * Implements TaskStore.create
   */
  async create(task: Task): Promise<void> {
    this.writer.insert(tasks).values(taskToRow(task)).run();
  }

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------

  /**
   * get retrieves a task by ID. Throws NotFoundError if the task does not
   * exist.
   */
  async get(id: string): Promise<Task> {
    const rows = this.reader.select().from(tasks).where(eq(tasks.id, id)).all();
    if (rows.length === 0) {
      throw new NotFoundError('task', id);
    }
    return taskRowToDomain(rows[0]!);
  }

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  /**
   * update modifies an existing task using an explicit column map.
   * Throws NotFoundError if no row was modified (task does not exist).
   * Uses an explicit column map for update.
   */
  async update(task: Task): Promise<void> {
    const result = this.writer
      .update(tasks)
      .set({
        parent_id: task.parent_id ?? '',
        team_slug: task.team_slug,
        agent_aid: task.agent_aid ?? '',
        jid: task.jid ?? '',
        status: taskStatusToInt(task.status),
        prompt: task.prompt,
        result: task.result ?? '',
        error: task.error ?? '',
        updated_at: task.updated_at,
        completed_at: task.completed_at ?? null,
      })
      .where(eq(tasks.id, task.id))
      .run();

    // better-sqlite3 RunResult.changes gives rows affected
    if (result.changes === 0) {
      throw new NotFoundError('task', task.id);
    }
  }

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  /**
   * delete removes a task by ID. Does not error if the task does not exist.
   */
  async delete(id: string): Promise<void> {
    this.writer.delete(tasks).where(eq(tasks.id, id)).run();
  }

  // -------------------------------------------------------------------------
  // listByTeam
  // -------------------------------------------------------------------------

  /**
   * listByTeam returns all tasks for a given team, ordered by created_at DESC.
   */
  async listByTeam(teamSlug: string): Promise<Task[]> {
    const rows = this.reader
      .select()
      .from(tasks)
      .where(eq(tasks.team_slug, teamSlug))
      .orderBy(desc(tasks.created_at))
      .all();
    return rows.map(taskRowToDomain);
  }

  // -------------------------------------------------------------------------
  // listByTeamPaginated
  // -------------------------------------------------------------------------

  /**
   * listByTeamPaginated returns paginated tasks for a given team, together
   * with the total count of matching rows.
   *
   * @returns [tasks, totalCount]
   */
  async listByTeamPaginated(
    teamSlug: string,
    limit: number,
    offset: number,
  ): Promise<[Task[], number]> {
    // Count query
    const countResult = this.reader
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(eq(tasks.team_slug, teamSlug))
      .get();
    const total = countResult?.count ?? 0;

    // Data query
    const rows = this.reader
      .select()
      .from(tasks)
      .where(eq(tasks.team_slug, teamSlug))
      .orderBy(desc(tasks.created_at))
      .limit(limit)
      .offset(offset)
      .all();

    return [rows.map(taskRowToDomain), total];
  }

  // -------------------------------------------------------------------------
  // listByStatus
  // -------------------------------------------------------------------------

  /**
   * listByStatus returns all tasks with the given status, ordered by
   * created_at DESC.
   */
  async listByStatus(status: TaskStatus): Promise<Task[]> {
    const statusInt = taskStatusToInt(status);
    const rows = this.reader
      .select()
      .from(tasks)
      .where(eq(tasks.status, statusInt))
      .orderBy(desc(tasks.created_at))
      .all();
    return rows.map(taskRowToDomain);
  }

  // -------------------------------------------------------------------------
  // getSubtree
  // -------------------------------------------------------------------------

  /**
   * getSubtree returns all tasks in the subtree rooted at the given task ID.
   * Uses DEFAULT_SUBTREE_MAX_DEPTH (100) as the recursion limit.
   */
  async getSubtree(rootID: string): Promise<Task[]> {
    return this.getSubtreeWithDepth(rootID, DEFAULT_SUBTREE_MAX_DEPTH);
  }

  // -------------------------------------------------------------------------
  // getSubtreeWithDepth
  // -------------------------------------------------------------------------

  /**
   * getSubtreeWithDepth returns the subtree with an explicit depth limit.
   * Uses a recursive CTE executed via raw better-sqlite3 for correctness.
   *
   * NOTE: The CTE is executed against the writer connection's underlying
   * better-sqlite3 handle so that in-memory tests (where writer == reader)
   * see the correct data.
   */
  getSubtreeWithDepth(rootID: string, maxDepth: number): Promise<Task[]> {
    const depth = maxDepth <= 0 ? DEFAULT_SUBTREE_MAX_DEPTH : maxDepth;

    // Recursive CTE for subtree traversal
    const query = `
      WITH RECURSIVE subtree(
        id, parent_id, team_slug, agent_aid, jid,
        status, prompt, result, error,
        created_at, updated_at, completed_at, depth
      ) AS (
        SELECT
          id, parent_id, team_slug, agent_aid, jid,
          status, prompt, result, error,
          created_at, updated_at, completed_at, 0
        FROM tasks WHERE id = ?
        UNION ALL
        SELECT
          t.id, t.parent_id, t.team_slug, t.agent_aid, t.jid,
          t.status, t.prompt, t.result, t.error,
          t.created_at, t.updated_at, t.completed_at, s.depth + 1
        FROM tasks t
        INNER JOIN subtree s ON t.parent_id = s.id
        WHERE s.depth < ?
      )
      SELECT
        id, parent_id, team_slug, agent_aid, jid,
        status, prompt, result, error,
        created_at, updated_at, completed_at
      FROM subtree
    `;

    // Use the raw writer connection so in-memory tests work correctly.
    const stmt = this.db._writerConn.prepare(query);
    const rows = stmt.all(rootID, depth) as TaskCTERow[];
    return Promise.resolve(rows.map(cteRowToDomain));
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * newTaskStore creates a TaskStoreImpl backed by the given DB.
 *
 * For file-based databases (production), pass db.reader as the second
 * argument to use the dedicated read connection for SELECT operations.
 *
 * For in-memory databases (tests), omit the reader argument — the store
 * defaults to db.writer for both reads and writes, ensuring visibility of
 * uncommitted data within the same connection.
 *
 * Example (production):
 *   const store = newTaskStore(db, db.reader);
 *
 * Example (tests):
 *   const db = newInMemoryDB();
 *   const store = newTaskStore(db);
 */
export function newTaskStore(
  db: DB,
  reader?: BetterSQLite3Database<typeof schema>,
): TaskStoreImpl {
  return new TaskStoreImpl(db, reader);
}
