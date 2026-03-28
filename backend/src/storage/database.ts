/**
 * Database initialization for OpenHive v3.
 *
 * Opens a better-sqlite3 database with WAL mode and wraps it with Drizzle ORM.
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export interface DatabaseInstance {
  readonly db: BetterSQLite3Database<typeof schema>;
  readonly raw: Database.Database;
}

export function createDatabase(dbPath: string): DatabaseInstance {
  const raw = new Database(dbPath);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');

  const db = drizzle(raw, { schema });

  return { db, raw };
}

/**
 * Creates all tables from the Drizzle schema using raw SQL DDL.
 * Used for initial setup and in-memory test databases.
 */
export function createTables(raw: Database.Database): void {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS org_tree (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scope_keywords (
      team_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      PRIMARY KEY (team_id, keyword)
    );

    CREATE TABLE IF NOT EXISTS task_queue (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      task TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      correlation_id TEXT,
      result TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_queue_team_id ON task_queue(team_id);
    CREATE INDEX IF NOT EXISTS idx_task_queue_status ON task_queue(status);

    CREATE TABLE IF NOT EXISTS trigger_dedup (
      event_id TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      ttl_seconds INTEGER NOT NULL DEFAULT 300,
      PRIMARY KEY (event_id, source)
    );

    CREATE TABLE IF NOT EXISTS team_status (
      team_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'idle',
      last_active TEXT
    );

    CREATE TABLE IF NOT EXISTS log_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      context TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_log_entries_level ON log_entries(level);
    CREATE INDEX IF NOT EXISTS idx_log_entries_created_at ON log_entries(created_at);

    CREATE TABLE IF NOT EXISTS escalation_correlations (
      correlation_id TEXT PRIMARY KEY,
      source_team TEXT NOT NULL,
      target_team TEXT NOT NULL,
      task_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_escalation_source_team ON escalation_correlations(source_team);

    CREATE TABLE IF NOT EXISTS trigger_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config TEXT NOT NULL,
      task TEXT NOT NULL,
      skill TEXT,
      state TEXT NOT NULL DEFAULT 'pending',
      max_turns INTEGER NOT NULL DEFAULT 100,
      failure_threshold INTEGER NOT NULL DEFAULT 3,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      disabled_reason TEXT,
      source_channel_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(team, name)
    );
    CREATE INDEX IF NOT EXISTS idx_trigger_configs_team ON trigger_configs(team);
    CREATE INDEX IF NOT EXISTS idx_trigger_configs_state ON trigger_configs(state);

    CREATE TABLE IF NOT EXISTS channel_interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL,
      channel_type TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT,
      team_id TEXT,
      content_snippet TEXT,
      content_length INTEGER,
      duration_ms INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_interactions_channel ON channel_interactions(channel_id);
    CREATE INDEX IF NOT EXISTS idx_interactions_direction ON channel_interactions(direction);
    CREATE INDEX IF NOT EXISTS idx_interactions_created_at ON channel_interactions(created_at);
  `);

  // Safe migrations: add columns that may not exist yet (for existing DBs)
  const migrations = [
    'ALTER TABLE task_queue ADD COLUMN result TEXT',
    'ALTER TABLE task_queue ADD COLUMN duration_ms INTEGER',
    'ALTER TABLE task_queue ADD COLUMN options TEXT',
    'ALTER TABLE task_queue ADD COLUMN source_channel_id TEXT',
    'ALTER TABLE log_entries ADD COLUMN duration_ms INTEGER',
    'ALTER TABLE trigger_configs ADD COLUMN source_channel_id TEXT',
  ];
  for (const sql of migrations) {
    try { raw.prepare(sql).run(); } catch { /* already exists */ }
  }
}
