/**
 * Database initialization for OpenHive v3.
 *
 * Opens a better-sqlite3 database with WAL mode and wraps it with Drizzle ORM.
 * DDL is generated from the Drizzle schema (schema.ts is the single source of truth).
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { getTableConfig } from 'drizzle-orm/sqlite-core/utils';
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

/** All schema tables in creation order. */
const allTables: SQLiteTable[] = [
  schema.orgTree,
  schema.scopeKeywords,
  schema.taskQueue,
  schema.triggerDedup,
  schema.logEntries,
  schema.escalationCorrelations,
  schema.triggerConfigs,
  schema.topics,
  schema.channelInteractions,
  schema.memories,
  schema.memoryChunks,
  schema.embeddingCache,
  schema.senderTrust,
  schema.trustAuditLog,
  schema.teamVault,
];

/**
 * Generates CREATE TABLE IF NOT EXISTS + CREATE INDEX statements from a Drizzle
 * table definition. This keeps schema.ts as the single source of truth for DDL.
 */
function tableToSQL(table: SQLiteTable): string {
  const tc = getTableConfig(table);
  const colDefs: string[] = [];

  for (const col of tc.columns) {
    const parts = [col.name, col.getSQLType().toUpperCase()];

    if (col.primary) {
      parts.push('PRIMARY KEY');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((col as any).autoIncrement) {
        parts.push('AUTOINCREMENT');
      }
    }

    if (col.notNull && !col.primary) {
      parts.push('NOT NULL');
    }

    if (col.hasDefault && col.default !== undefined) {
      const val = typeof col.default === 'string'
        ? `'${col.default}'`
        : String(col.default);
      parts.push(`DEFAULT ${val}`);
    }

    colDefs.push(`      ${parts.join(' ')}`);
  }

  // Composite primary keys (tables without a single-column PK)
  for (const pk of tc.primaryKeys) {
    const cols = pk.columns.map((c) => c.name).join(', ');
    colDefs.push(`      PRIMARY KEY (${cols})`);
  }

  // UNIQUE constraints
  for (const uc of tc.uniqueConstraints) {
    const cols = uc.columns.map((c) => c.name).join(', ');
    colDefs.push(`      UNIQUE(${cols})`);
  }

  const lines = [
    `    CREATE TABLE IF NOT EXISTS ${tc.name} (`,
    colDefs.join(',\n'),
    '    );',
  ];

  // Indexes
  for (const idx of tc.indexes) {
    const keyword = idx.config.unique ? 'UNIQUE INDEX' : 'INDEX';
    const cols = idx.config.columns.map((c) => (c as { name: string }).name).join(', ');
    lines.push(`    CREATE ${keyword} IF NOT EXISTS ${idx.config.name} ON ${tc.name}(${cols});`);
  }

  return lines.join('\n');
}

/**
 * Creates all tables from the Drizzle schema definitions.
 * DDL is generated from schema.ts — no hand-written CREATE TABLE statements.
 * Used for initial setup and in-memory test databases.
 */
export function createTables(raw: Database.Database): void {
  const ddl = allTables.map(tableToSQL).join('\n\n');
  raw.exec(ddl);

  // FTS5 virtual table + partial indexes that Drizzle cannot express
  const rawDDL = [
    `CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(chunk_content, content='memory_chunks', content_rowid='id')`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_active_memory ON memories(team_name, key) WHERE is_active = 1`,
    `CREATE INDEX IF NOT EXISTS idx_memory_injection ON memories(team_name, type, is_active) WHERE is_active = 1`,
    `CREATE INDEX IF NOT EXISTS idx_memory_history ON memories(team_name, key, created_at DESC)`,
  ];
  for (const sql of rawDDL) {
    raw.exec(sql);
  }

  // Safe migrations: add columns that may not exist yet (for existing DBs created
  // before these columns were added to the schema).
  const migrations = [
    'ALTER TABLE task_queue ADD COLUMN result TEXT',
    'ALTER TABLE task_queue ADD COLUMN duration_ms INTEGER',
    'ALTER TABLE task_queue ADD COLUMN options TEXT',
    'ALTER TABLE task_queue ADD COLUMN source_channel_id TEXT',
    "ALTER TABLE task_queue ADD COLUMN type TEXT NOT NULL DEFAULT 'delegate'",
    'ALTER TABLE log_entries ADD COLUMN duration_ms INTEGER',
    'ALTER TABLE trigger_configs ADD COLUMN source_channel_id TEXT',
    'ALTER TABLE task_queue ADD COLUMN topic_id TEXT',
    'ALTER TABLE channel_interactions ADD COLUMN topic_id TEXT',
    'ALTER TABLE org_tree ADD COLUMN bootstrapped INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE channel_interactions ADD COLUMN trust_decision TEXT',
  ];
  for (const sql of migrations) {
    try { raw.prepare(sql).run(); } catch { /* column already exists */ }
  }

  // Backfill: classify existing task_queue rows by type
  try {
    raw.prepare("UPDATE task_queue SET type = 'bootstrap' WHERE options LIKE '%\"internal\":true%'").run();
    raw.prepare("UPDATE task_queue SET type = 'trigger' WHERE correlation_id LIKE 'trigger:%' AND type = 'delegate'").run();
  } catch { /* backfill is best-effort on existing data */ }
}
