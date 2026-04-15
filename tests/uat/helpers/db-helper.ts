/**
 * Database helpers for UAT scenarios.
 *
 * Provides utilities for opening SQLite databases and inspecting schema.
 */

import Database from 'better-sqlite3';

/**
 * Open a SQLite database at the given path.
 * Returns the raw better-sqlite3 database instance.
 */
export function openDb(path: string): Database.Database {
  return new Database(path);
}

/**
 * Open an in-memory SQLite database.
 */
export function openMemoryDb(): Database.Database {
  return new Database(':memory:');
}

/**
 * Get table info (columns) for a table.
 */
export function getTableInfo(db: Database.Database, tableName: string): Array<{
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}> {
  return db.pragma(`table_info(${tableName})`) as Array<{
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>;
}

/**
 * Check if a column exists in a table.
 */
export function columnExists(db: Database.Database, tableName: string, columnName: string): boolean {
  const info = getTableInfo(db, tableName);
  return info.some(col => col.name === columnName);
}

/**
 * Get list of all tables in the database.
 */
export function listTables(db: Database.Database): string[] {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts'")
    .all() as Array<{ name: string }>;
  return tables.map(t => t.name).sort();
}

/**
 * Execute a query and return all results.
 */
export function queryAll<T = unknown>(db: Database.Database, sql: string, params?: unknown[]): T[] {
  const stmt = db.prepare(sql);
  if (params) {
    return stmt.all(...params) as T[];
  }
  return stmt.all() as T[];
}

/**
 * Execute a query and return the first result.
 */
export function queryOne<T = unknown>(db: Database.Database, sql: string, params?: unknown[]): T | undefined {
  const stmt = db.prepare(sql);
  if (params) {
    return stmt.get(...params) as T | undefined;
  }
  return stmt.get() as T | undefined;
}

/**
 * Execute a statement (INSERT, UPDATE, DELETE).
 */
export function execute(db: Database.Database, sql: string, params?: unknown[]): Database.RunResult {
  const stmt = db.prepare(sql);
  if (params) {
    return stmt.run(...params);
  }
  return stmt.run();
}

/**
 * Close the database connection.
 */
export function closeDb(db: Database.Database): void {
  db.close();
}