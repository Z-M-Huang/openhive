/**
 * OpenHive Backend - Drizzle ORM Schema
 *
 * Defines SQLite table schemas for all four database tables.
 *
 * Design decisions:
 *   - Timestamps are stored as integers (Unix milliseconds) via
 *     integer({ mode: 'timestamp_ms' }). Drizzle maps Date <-> integer
 *     automatically.
 *   - Nullable timestamp (completed_at) uses .default(null).
 *   - log_entries.id uses autoincrement.
 *   - params column in log_entries is stored as plain text (JSON string).
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
