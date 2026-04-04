/**
 * Drizzle ORM schema definitions for OpenHive v3.
 *
 * 9 tables: org_tree, scope_keywords, task_queue, trigger_dedup,
 * log_entries, escalation_correlations, trigger_configs, channel_interactions, topics
 */

import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
  unique,
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
    type: text('type').notNull().default('delegate'),
    status: text('status').notNull().default('pending'),
    createdAt: text('created_at').notNull(),
    correlationId: text('correlation_id'),
    result: text('result'),
    durationMs: integer('duration_ms'),
    options: text('options'),
    sourceChannelId: text('source_channel_id'),
    topicId: text('topic_id'),
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

// ── log_entries ─────────────────────────────────────────────────────────────

export const logEntries = sqliteTable(
  'log_entries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    level: text('level').notNull(),
    message: text('message').notNull(),
    context: text('context'),
    durationMs: integer('duration_ms'),
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

// ── trigger_configs ───────────────────────────────────────────────────────

export const triggerConfigs = sqliteTable(
  'trigger_configs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    team: text('team').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    config: text('config').notNull(),
    task: text('task').notNull(),
    skill: text('skill'),
    state: text('state').notNull().default('pending'),
    maxTurns: integer('max_turns').notNull().default(100),
    failureThreshold: integer('failure_threshold').notNull().default(3),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    disabledReason: text('disabled_reason'),
    sourceChannelId: text('source_channel_id'),
    notifyPolicy: text('notify_policy').notNull().default('always'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_trigger_configs_team').on(table.team),
    index('idx_trigger_configs_state').on(table.state),
    unique('uq_trigger_configs_team_name').on(table.team, table.name),
  ],
);

// ── topics ────────────────────────────────────────────────────────────────

export const topics = sqliteTable(
  'topics',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    state: text('state').notNull().default('active'),
    createdAt: text('created_at').notNull(),
    lastActivity: text('last_activity').notNull(),
  },
  (table) => [
    index('idx_topics_channel_id').on(table.channelId),
    index('idx_topics_state').on(table.state),
  ],
);

// ── channel_interactions ──────────────────────────────────────────────────

export const channelInteractions = sqliteTable(
  'channel_interactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    direction: text('direction').notNull(),
    channelType: text('channel_type').notNull(),
    channelId: text('channel_id').notNull(),
    userId: text('user_id'),
    teamId: text('team_id'),
    contentSnippet: text('content_snippet'),
    contentLength: integer('content_length'),
    durationMs: integer('duration_ms'),
    topicId: text('topic_id'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_interactions_channel').on(table.channelId),
    index('idx_interactions_direction').on(table.direction),
    index('idx_interactions_created_at').on(table.createdAt),
  ],
);
