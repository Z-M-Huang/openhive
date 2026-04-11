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
  blob,
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
  bootstrapped: integer('bootstrapped').notNull().default(0),
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
    overlapPolicy: text('overlap_policy').notNull().default('skip-then-replace'),
    overlapCount: integer('overlap_count').notNull().default(0),
    activeTaskId: text('active_task_id'),
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
    trustDecision: text('trust_decision'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_interactions_channel').on(table.channelId),
    index('idx_interactions_direction').on(table.direction),
    index('idx_interactions_created_at').on(table.createdAt),
  ],
);

// ── memories ─────────────────────────────────────────────────────────────────
export const memories = sqliteTable('memories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  teamName: text('team_name').notNull(),
  key: text('key').notNull(),
  content: text('content').notNull(),
  type: text('type').notNull().default('context'),
  isActive: integer('is_active').notNull().default(1),
  supersedesId: integer('supersedes_id'),
  supersedeReason: text('supersede_reason'),
  updatedBy: text('updated_by'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ── memory_chunks ────────────────────────────────────────────────────────────
export const memoryChunks = sqliteTable(
  'memory_chunks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    memoryId: integer('memory_id').notNull(),
    teamName: text('team_name').notNull(),
    chunkContent: text('chunk_content').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    contentHash: text('content_hash').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_chunks_by_memory').on(table.memoryId),
    index('idx_chunks_by_team').on(table.teamName),
    index('idx_chunks_by_hash').on(table.contentHash),
  ],
);

// ── embedding_cache ──────────────────────────────────────────────────────────
export const embeddingCache = sqliteTable('embedding_cache', {
  contentHash: text('content_hash').primaryKey(),
  embedding: blob('embedding').notNull(),
  model: text('model').notNull(),
  createdAt: text('created_at').notNull(),
});

// ── sender_trust ────────────────────────────────────────────────────────────
export const senderTrust = sqliteTable(
  'sender_trust',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    channelType: text('channel_type').notNull(),
    channelId: text('channel_id'),
    senderId: text('sender_id').notNull(),
    trustLevel: text('trust_level').notNull(),
    grantedBy: text('granted_by').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_sender_trust_lookup').on(table.channelType, table.senderId),
  ],
);

// ── trust_audit_log ─────────────────────────────────────────────────────────
export const trustAuditLog = sqliteTable(
  'trust_audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    channelType: text('channel_type').notNull(),
    channelId: text('channel_id').notNull(),
    senderId: text('sender_id').notNull(),
    decision: text('decision').notNull(),
    reason: text('reason').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_trust_audit_created_at').on(table.createdAt),
    index('idx_trust_audit_sender').on(table.senderId),
  ],
);

// ── plugin_tools ──────────────────────────────────────────────────────────
export const pluginTools = sqliteTable(
  'plugin_tools',
  {
    teamName: text('team_name').notNull(),
    toolName: text('tool_name').notNull(),
    status: text('status').notNull().default('active'),
    sourcePath: text('source_path').notNull(),
    sourceHash: text('source_hash').notNull(),
    verification: text('verification').notNull().default('{}'),
    verifiedAt: text('verified_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.teamName, table.toolName] }),
    index('idx_plugin_tools_team').on(table.teamName),
    index('idx_plugin_tools_status').on(table.status),
  ],
);

// ── team_vault ─────────────────────────────────────────────────────────────
export const teamVault = sqliteTable(
  'team_vault',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    teamName: text('team_name').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    isSecret: integer('is_secret').notNull().default(0),
    updatedBy: text('updated_by'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_team_vault_team_name').on(table.teamName),
    unique('uq_team_vault_team_key').on(table.teamName, table.key),
  ],
);
