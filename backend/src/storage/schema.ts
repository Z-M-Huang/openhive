/**
 * Drizzle ORM schema definitions for OpenHive v3.
 *
 * 7 tables: org_tree, scope_keywords, task_queue, trigger_dedup, team_status, log_entries, escalation_correlations
 */

import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
} from 'drizzle-orm/sqlite-core';

// ── org_tree ────────────────────────────────────────────────────────────────

export const orgTree = sqliteTable('org_tree', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  parentId: text('parent_id'),
  status: text('status').notNull().default('idle'),
  createdAt: text('created_at').notNull(),
});

// ── scope_keywords ─────────────────────────────────────────────────────────

export const scopeKeywords = sqliteTable(
  'scope_keywords',
  {
    teamId: text('team_id').notNull(),
    keyword: text('keyword').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.keyword] }),
  ],
);

// ── task_queue ──────────────────────────────────────────────────────────────

export const taskQueue = sqliteTable(
  'task_queue',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id').notNull(),
    task: text('task').notNull(),
    priority: text('priority').notNull().default('normal'),
    status: text('status').notNull().default('pending'),
    createdAt: text('created_at').notNull(),
    correlationId: text('correlation_id'),
    result: text('result'),
  },
  (table) => [
    index('idx_task_queue_team_id').on(table.teamId),
    index('idx_task_queue_status').on(table.status),
  ],
);

// ── trigger_dedup ───────────────────────────────────────────────────────────

export const triggerDedup = sqliteTable(
  'trigger_dedup',
  {
    eventId: text('event_id').notNull(),
    source: text('source').notNull(),
    createdAt: text('created_at').notNull(),
    ttlSeconds: integer('ttl_seconds').notNull().default(300),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.source] }),
  ],
);

// ── team_status ─────────────────────────────────────────────────────────────

export const teamStatus = sqliteTable('team_status', {
  teamId: text('team_id').primaryKey(),
  status: text('status').notNull().default('idle'),
  lastActive: text('last_active'),
});

// ── log_entries ─────────────────────────────────────────────────────────────

export const logEntries = sqliteTable(
  'log_entries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    level: text('level').notNull(),
    message: text('message').notNull(),
    context: text('context'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_log_entries_level').on(table.level),
    index('idx_log_entries_created_at').on(table.createdAt),
  ],
);

// ── escalation_correlations ─────────────────────────────────────────────────

export const escalationCorrelations = sqliteTable(
  'escalation_correlations',
  {
    correlationId: text('correlation_id').primaryKey(),
    sourceTeam: text('source_team').notNull(),
    targetTeam: text('target_team').notNull(),
    taskId: text('task_id'),
    status: text('status').notNull().default('pending'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_escalation_source_team').on(table.sourceTeam),
  ],
);
