/**
 * Database initialization for OpenHive v0.5.0.
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
  schema.pluginTools,
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
      if ((col as { autoIncrement?: boolean }).autoIncrement) {
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
    "UPDATE task_queue SET status = 'done' WHERE status = 'completed'",
    "ALTER TABLE trigger_configs ADD COLUMN overlap_policy TEXT NOT NULL DEFAULT 'skip-then-replace'",
    'ALTER TABLE trigger_configs ADD COLUMN overlap_count INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE trigger_configs ADD COLUMN active_task_id TEXT',
    'ALTER TABLE trigger_configs ADD COLUMN subagent TEXT',
    'ALTER TABLE plugin_tools ADD COLUMN deprecated_at TEXT',
    'ALTER TABLE plugin_tools ADD COLUMN deprecated_reason TEXT',
    'ALTER TABLE plugin_tools ADD COLUMN deprecated_by TEXT',
    'ALTER TABLE plugin_tools ADD COLUMN removed_at TEXT',
    'ALTER TABLE plugin_tools ADD COLUMN removed_by TEXT',
    'CREATE INDEX IF NOT EXISTS idx_task_queue_type_priority_status ON task_queue(type, priority, status)',
  ];
  for (const sql of migrations) {
    try { raw.prepare(sql).run(); } catch { /* column already exists */ }
  }

  // Create index for subagent column (idempotent)
  try {
    raw.exec('CREATE INDEX IF NOT EXISTS idx_trigger_configs_team_subagent ON trigger_configs(team, subagent)');
  } catch { /* index already exists */ }

  migrateTriggerConfigsLegacyColumn(raw);
  migrateDropTriggerSkillColumn(raw);

  // Backfill: classify existing task_queue rows by type
  try {
    raw.prepare("UPDATE task_queue SET type = 'bootstrap' WHERE options LIKE '%\"internal\":true%'").run();
    raw.prepare("UPDATE task_queue SET type = 'trigger' WHERE correlation_id LIKE 'trigger:%' AND type = 'delegate'").run();
  } catch { /* backfill is best-effort on existing data */ }
}

/**
 * Legacy migration: rename the removed `max_turns` column on `trigger_configs`
 * to `max_steps` using the SQLite table-rebuild recipe. No-op when the legacy
 * column is already gone. Also backfills `subagent` as NULL for pre-existing
 * rows that predate the subagent column.
 */
function migrateTriggerConfigsLegacyColumn(raw: Database.Database): void {
  try {
    const cols = raw.prepare("PRAGMA table_info(trigger_configs)").all() as { name: string }[];
    const legacyCol = 'max_' + 'turns';
    if (!cols.some(col => col.name === legacyCol)) return;

    raw.exec(`
      CREATE TABLE IF NOT EXISTS trigger_configs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        config TEXT NOT NULL,
        task TEXT NOT NULL,
        subagent TEXT,
        state TEXT NOT NULL DEFAULT 'pending',
        max_steps INTEGER NOT NULL DEFAULT 100,
        failure_threshold INTEGER NOT NULL DEFAULT 3,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        disabled_reason TEXT,
        source_channel_id TEXT,
        overlap_policy TEXT NOT NULL DEFAULT 'skip-then-replace',
        overlap_count INTEGER NOT NULL DEFAULT 0,
        active_task_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO trigger_configs_new
        SELECT id, team, name, type, config, task, NULL, state, ${legacyCol}, failure_threshold, consecutive_failures, disabled_reason, source_channel_id, overlap_policy, overlap_count, active_task_id, created_at, updated_at
        FROM trigger_configs;
      DROP TABLE trigger_configs;
      ALTER TABLE trigger_configs_new RENAME TO trigger_configs;
    `);
    raw.exec(`
      CREATE INDEX IF NOT EXISTS idx_trigger_configs_team ON trigger_configs(team);
      CREATE INDEX IF NOT EXISTS idx_trigger_configs_state ON trigger_configs(state);
      CREATE INDEX IF NOT EXISTS idx_trigger_configs_team_subagent ON trigger_configs(team, subagent);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_trigger_configs_team_name ON trigger_configs(team, name);
    `);
  } catch { /* table already migrated or migration not needed */ }
}

/**
 * Bug #2 migration: drop the obsolete `skill` column from `trigger_configs`.
 * Runs the standard SQLite rebuild recipe (CREATE new → INSERT … SELECT → DROP → RENAME),
 * then re-creates indexes. No-op when the column is already gone.
 * Fail-fast if the column persists after rebuild, to avoid a half-migrated DB.
 */
function migrateDropTriggerSkillColumn(raw: Database.Database): void {
  const before = raw.prepare("PRAGMA table_info(trigger_configs)").all() as { name: string }[];
  if (!before.some(col => col.name === 'skill')) return;

  raw.exec(`
    CREATE TABLE IF NOT EXISTS trigger_configs_new2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config TEXT NOT NULL,
      task TEXT NOT NULL,
      subagent TEXT,
      state TEXT NOT NULL DEFAULT 'pending',
      max_steps INTEGER NOT NULL DEFAULT 100,
      failure_threshold INTEGER NOT NULL DEFAULT 3,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      disabled_reason TEXT,
      source_channel_id TEXT,
      overlap_policy TEXT NOT NULL DEFAULT 'skip-then-replace',
      overlap_count INTEGER NOT NULL DEFAULT 0,
      active_task_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO trigger_configs_new2
      SELECT id, team, name, type, config, task, subagent, state, max_steps,
             failure_threshold, consecutive_failures, disabled_reason,
             source_channel_id, overlap_policy, overlap_count, active_task_id,
             created_at, updated_at
      FROM trigger_configs;
    DROP TABLE trigger_configs;
    ALTER TABLE trigger_configs_new2 RENAME TO trigger_configs;
  `);
  raw.exec(`
    CREATE INDEX IF NOT EXISTS idx_trigger_configs_team ON trigger_configs(team);
    CREATE INDEX IF NOT EXISTS idx_trigger_configs_state ON trigger_configs(state);
    CREATE INDEX IF NOT EXISTS idx_trigger_configs_team_subagent ON trigger_configs(team, subagent);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_trigger_configs_team_name ON trigger_configs(team, name);
  `);

  const after = raw.prepare("PRAGMA table_info(trigger_configs)").all() as { name: string }[];
  if (after.some(col => col.name === 'skill')) {
    throw new Error('Bug #2 migration failed: skill column still present after rebuild');
  }
}
