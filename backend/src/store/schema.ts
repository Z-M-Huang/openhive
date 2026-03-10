/**
 * OpenHive Backend - Drizzle ORM Schema
 *
 * Defines SQLite table schemas for all database tables:
 *   - tasks, messages, log_entries, chat_sessions (original four)
 *   - escalations, agent_memories, triggers (new — wiki spec alignment)
 *
 * Design decisions:
 *   - Timestamps are stored as integers (Unix milliseconds) via
 *     integer({ mode: 'timestamp_ms' }). Drizzle maps Date <-> integer
 *     automatically.
 *   - Nullable timestamp (completed_at) uses .default(null).
 *   - log_entries.id uses autoincrement.
 *   - params column in log_entries is stored as plain text (JSON string).
 *   - blocked_by_task_id on tasks table supports task dependency tracking (AC-1.2).
 */

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

/** Stores tasks dispatched to teams. */
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    parent_id: text('parent_id').notNull().default(''),
    team_slug: text('team_slug').notNull().default(''),
    agent_aid: text('agent_aid').notNull().default(''),
    jid: text('jid').notNull().default(''),
    status: integer('status').notNull().default(0),
    prompt: text('prompt').notNull().default(''),
    result: text('result').notNull().default(''),
    error: text('error').notNull().default(''),
    /** ID of the task that blocks this task (empty string = not blocked). */
    blocked_by_task_id: text('blocked_by_task_id').notNull().default(''),
    /** JSON array of task IDs that block this task (task DAG). */
    blocked_by: text('blocked_by').notNull().default('[]'),
    /** Task priority (higher = more important). Default 0. */
    priority: integer('priority').notNull().default(0),
    /** Number of times this task has been retried. */
    retry_count: integer('retry_count').notNull().default(0),
    /** Maximum number of retries allowed. 0 = no retries. */
    max_retries: integer('max_retries').notNull().default(0),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    completed_at: integer('completed_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('idx_tasks_parent_id').on(t.parent_id),
    index('idx_tasks_team_slug').on(t.team_slug),
    index('idx_tasks_agent_aid').on(t.agent_aid),
    index('idx_tasks_jid').on(t.jid),
    index('idx_tasks_status').on(t.status),
    index('idx_tasks_blocked_by_task_id').on(t.blocked_by_task_id),
    index('idx_tasks_priority').on(t.priority),
  ],
);

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

/** Stores chat messages from messaging channels. */
export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    chat_jid: text('chat_jid').notNull().default(''),
    role: text('role').notNull().default(''),
    content: text('content').notNull().default(''),
    timestamp: integer('timestamp', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('idx_messages_chat_jid').on(t.chat_jid),
    index('idx_messages_timestamp').on(t.timestamp),
  ],
);

// ---------------------------------------------------------------------------
// log_entries
// ---------------------------------------------------------------------------

/** Stores structured log entries written to the database. */
export const log_entries = sqliteTable(
  'log_entries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    level: integer('level').notNull().default(0),
    component: text('component').notNull().default(''),
    action: text('action').notNull().default(''),
    message: text('message').notNull().default(''),
    params: text('params').notNull().default(''),
    team_name: text('team_name').notNull().default(''),
    task_id: text('task_id').notNull().default(''),
    agent_name: text('agent_name').notNull().default(''),
    request_id: text('request_id').notNull().default(''),
    error: text('error').notNull().default(''),
    duration_ms: integer('duration_ms').notNull().default(0),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('idx_log_entries_level').on(t.level),
    index('idx_log_entries_component').on(t.component),
    index('idx_log_entries_team_name').on(t.team_name),
    index('idx_log_entries_task_id').on(t.task_id),
    index('idx_log_entries_request_id').on(t.request_id),
    index('idx_log_entries_created_at').on(t.created_at),
  ],
);

// ---------------------------------------------------------------------------
// chat_sessions
// ---------------------------------------------------------------------------

/** Stores active chat sessions for each messaging channel JID. */
export const chat_sessions = sqliteTable('chat_sessions', {
  chat_jid: text('chat_jid').primaryKey(),
  channel_type: text('channel_type').notNull().default(''),
  last_timestamp: integer('last_timestamp', { mode: 'timestamp_ms' }).notNull(),
  last_agent_timestamp: integer('last_agent_timestamp', { mode: 'timestamp_ms' }).notNull(),
  session_id: text('session_id').notNull().default(''),
  agent_aid: text('agent_aid').notNull().default(''),
});

// ---------------------------------------------------------------------------
// escalations
// ---------------------------------------------------------------------------

/** Stores escalation requests from agents to their supervisors. */
export const escalations = sqliteTable(
  'escalations',
  {
    id: text('id').primaryKey(),
    correlation_id: text('correlation_id').notNull().default(''),
    task_id: text('task_id').notNull().default(''),
    from_aid: text('from_aid').notNull().default(''),
    to_aid: text('to_aid').notNull().default(''),
    source_team: text('source_team').notNull().default(''),
    destination_team: text('destination_team').notNull().default(''),
    escalation_level: integer('escalation_level').notNull().default(1),
    reason: text('reason').notNull().default(''),
    context: text('context').notNull().default(''),
    /** 0=pending, 1=resolved, 2=rejected, 3=timed_out */
    status: integer('status').notNull().default(0),
    resolution: text('resolution').notNull().default(''),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    resolved_at: integer('resolved_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('idx_escalations_correlation_id').on(t.correlation_id),
    index('idx_escalations_task_id').on(t.task_id),
    index('idx_escalations_from_aid').on(t.from_aid),
    index('idx_escalations_to_aid').on(t.to_aid),
    index('idx_escalations_status').on(t.status),
    index('idx_escalations_created_id').on(t.created_at),
  ],
);

// ---------------------------------------------------------------------------
// agent_memories
// ---------------------------------------------------------------------------

/** Stores persistent memory entries for agents. */
export const agent_memories = sqliteTable(
  'agent_memories',
  {
    id: text('id').primaryKey(),
    agent_aid: text('agent_aid').notNull().default(''),
    key: text('key').notNull().default(''),
    value: text('value').notNull().default(''),
    /** Optional metadata stored as JSON string. */
    metadata: text('metadata').notNull().default(''),
    /** Team slug for team-scoped memory queries. */
    team_slug: text('team_slug').notNull().default(''),
    /** Soft-delete timestamp (null = not deleted). */
    deleted_at: integer('deleted_at', { mode: 'timestamp_ms' }),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('idx_agent_memories_agent_aid').on(t.agent_aid),
    index('idx_agent_memories_key').on(t.key),
    index('idx_agent_memories_agent_key').on(t.agent_aid, t.key),
    index('idx_agent_memories_team_slug').on(t.team_slug),
  ],
);

// ---------------------------------------------------------------------------
// triggers
// ---------------------------------------------------------------------------

/** Stores automated trigger configurations. */
export const triggers = sqliteTable(
  'triggers',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull().default(''),
    team_slug: text('team_slug').notNull().default(''),
    agent_aid: text('agent_aid').notNull().default(''),
    /** Cron expression (e.g. "0 0/5 * * *"). */
    schedule: text('schedule').notNull().default(''),
    prompt: text('prompt').notNull().default(''),
    enabled: integer('enabled').notNull().default(1),
    /** Trigger type: 'cron' (default) or 'webhook'. */
    type: text('type').notNull().default('cron'),
    /** Webhook path for webhook triggers (empty = not a webhook). */
    webhook_path: text('webhook_path').notNull().default(''),
    /** Last execution timestamp (nullable). */
    last_run_at: integer('last_run_at', { mode: 'timestamp_ms' }),
    /** Next scheduled run timestamp (nullable). */
    next_run_at: integer('next_run_at', { mode: 'timestamp_ms' }),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('idx_triggers_team_slug').on(t.team_slug),
    index('idx_triggers_agent_aid').on(t.agent_aid),
    index('idx_triggers_enabled').on(t.enabled),
    index('idx_triggers_next_run_at').on(t.next_run_at),
    index('idx_triggers_webhook_path').on(t.webhook_path),
  ],
);
