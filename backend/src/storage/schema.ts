/**
 * Drizzle ORM schema — all tables and indexes from Database-Schema.md.
 *
 * 10 tables: tasks, messages, chat_sessions, log_entries, task_events,
 * tool_calls, decisions, agent_memories, integrations, credentials.
 *
 * All column types, defaults, CHECK constraints, and foreign keys match
 * the canonical SQL in the wiki. Indexes match the wiki index table.
 *
 * @module storage/schema
 */

import {
  sqliteTable,
  text,
  integer,
  index,
} from 'drizzle-orm/sqlite-core';

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

/** Tasks dispatched to teams. Supports DAG tracking via blocked_by. */
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  parent_id: text('parent_id').notNull().default(''),
  team_slug: text('team_slug').notNull().default(''),
  agent_aid: text('agent_aid').notNull().default(''),
  title: text('title').notNull().default(''),
  status: text('status').notNull().default('pending'),
  prompt: text('prompt').notNull().default(''),
  result: text('result').notNull().default(''),
  error: text('error').notNull().default(''),
  blocked_by: text('blocked_by'),
  priority: integer('priority').notNull().default(0),
  retry_count: integer('retry_count').notNull().default(0),
  max_retries: integer('max_retries').notNull().default(0),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
  completed_at: integer('completed_at'),
}, (table) => [
  index('idx_tasks_parent_id').on(table.parent_id),
  index('idx_tasks_team_slug').on(table.team_slug),
  index('idx_tasks_agent_aid').on(table.agent_aid),
  index('idx_tasks_status').on(table.status),
]);

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

/** Chat messages from messaging channels. */
export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  chat_jid: text('chat_jid').notNull().default(''),
  role: text('role').notNull().default(''),
  content: text('content').notNull().default(''),
  type: text('type').notNull().default(''),
  timestamp: integer('timestamp').notNull(),
}, (table) => [
  index('idx_messages_chat_jid').on(table.chat_jid),
  index('idx_messages_timestamp').on(table.timestamp),
]);

// ---------------------------------------------------------------------------
// chat_sessions
// ---------------------------------------------------------------------------

/** Active chat sessions for each messaging channel. */
export const chatSessions = sqliteTable('chat_sessions', {
  chat_jid: text('chat_jid').primaryKey(),
  channel_type: text('channel_type').notNull().default(''),
  last_timestamp: integer('last_timestamp').notNull(),
  last_agent_timestamp: integer('last_agent_timestamp').notNull(),
  session_id: text('session_id').notNull().default(''),
  agent_aid: text('agent_aid').notNull().default(''),
});

// ---------------------------------------------------------------------------
// log_entries
// ---------------------------------------------------------------------------

/** Unified log table. Specialized tables link back via log_entry_id. */
export const logEntries = sqliteTable('log_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  level: integer('level').notNull().default(0),
  event_type: text('event_type').notNull().default(''),
  component: text('component').notNull().default(''),
  action: text('action').notNull().default(''),
  message: text('message').notNull().default(''),
  params: text('params').notNull().default(''),
  team_slug: text('team_slug').notNull().default(''),
  task_id: text('task_id').notNull().default(''),
  agent_aid: text('agent_aid').notNull().default(''),
  request_id: text('request_id').notNull().default(''),
  correlation_id: text('correlation_id').notNull().default(''),
  error: text('error').notNull().default(''),
  duration_ms: integer('duration_ms').notNull().default(0),
  created_at: integer('created_at').notNull(),
}, (table) => [
  index('idx_log_entries_level').on(table.level),
  index('idx_log_entries_event_type').on(table.event_type),
  index('idx_log_entries_component').on(table.component),
  index('idx_log_entries_team_slug').on(table.team_slug),
  index('idx_log_entries_task_id').on(table.task_id),
  index('idx_log_entries_agent_aid').on(table.agent_aid),
  index('idx_log_entries_request_id').on(table.request_id),
  index('idx_log_entries_correlation_id').on(table.correlation_id),
  index('idx_log_entries_created_at').on(table.created_at),
]);

// ---------------------------------------------------------------------------
// task_events
// ---------------------------------------------------------------------------

/** Task lifecycle events. One row per state transition. FK to log_entries. */
export const taskEvents = sqliteTable('task_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  log_entry_id: integer('log_entry_id').notNull().references(() => logEntries.id, { onDelete: 'cascade' }),
  task_id: text('task_id').notNull(),
  from_status: text('from_status').notNull().default(''),
  to_status: text('to_status').notNull(),
  agent_aid: text('agent_aid').notNull().default(''),
  reason: text('reason').notNull().default(''),
  created_at: integer('created_at').notNull(),
}, (table) => [
  index('idx_task_events_task_id').on(table.task_id),
  index('idx_task_events_log_entry_id').on(table.log_entry_id),
  index('idx_task_events_created_at').on(table.created_at),
]);

// ---------------------------------------------------------------------------
// tool_calls
// ---------------------------------------------------------------------------

/** Tool invocation records from SDK PreToolUse/PostToolUse hooks. FK to log_entries. */
export const toolCalls = sqliteTable('tool_calls', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  log_entry_id: integer('log_entry_id').notNull().references(() => logEntries.id, { onDelete: 'cascade' }),
  tool_use_id: text('tool_use_id').notNull(),
  tool_name: text('tool_name').notNull(),
  agent_aid: text('agent_aid').notNull(),
  team_slug: text('team_slug').notNull().default(''),
  task_id: text('task_id').notNull().default(''),
  params: text('params').notNull().default(''),
  result_summary: text('result_summary').notNull().default(''),
  error: text('error').notNull().default(''),
  duration_ms: integer('duration_ms').notNull().default(0),
  created_at: integer('created_at').notNull(),
}, (table) => [
  index('idx_tool_calls_tool_name').on(table.tool_name),
  index('idx_tool_calls_agent_aid').on(table.agent_aid),
  index('idx_tool_calls_task_id').on(table.task_id),
  index('idx_tool_calls_log_entry_id').on(table.log_entry_id),
  index('idx_tool_calls_created_at').on(table.created_at),
]);

// ---------------------------------------------------------------------------
// decisions
// ---------------------------------------------------------------------------

/** LLM decision points for routing, escalation, delegation. FK to log_entries. */
export const decisions = sqliteTable('decisions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  log_entry_id: integer('log_entry_id').notNull().references(() => logEntries.id, { onDelete: 'cascade' }),
  decision_type: text('decision_type').notNull(),
  agent_aid: text('agent_aid').notNull(),
  task_id: text('task_id').notNull().default(''),
  chosen_action: text('chosen_action').notNull().default(''),
  alternatives: text('alternatives').notNull().default(''),
  reasoning: text('reasoning').notNull().default(''),
  created_at: integer('created_at').notNull(),
}, (table) => [
  index('idx_decisions_decision_type').on(table.decision_type),
  index('idx_decisions_agent_aid').on(table.agent_aid),
  index('idx_decisions_log_entry_id').on(table.log_entry_id),
  index('idx_decisions_created_at').on(table.created_at),
]);

// ---------------------------------------------------------------------------
// agent_memories
// ---------------------------------------------------------------------------

/** Searchable index for agent memory. Source of truth is workspace files. */
export const agentMemories = sqliteTable('agent_memories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  agent_aid: text('agent_aid').notNull(),
  team_slug: text('team_slug').notNull(),
  content: text('content').notNull(),
  memory_type: text('memory_type').notNull(),
  created_at: integer('created_at').notNull(),
  deleted_at: integer('deleted_at'),
}, (table) => [
  index('idx_memories_agent_aid').on(table.agent_aid),
  index('idx_memories_team_slug').on(table.team_slug),
]);

// ---------------------------------------------------------------------------
// integrations
// ---------------------------------------------------------------------------

/** Integration configurations created via create_integration. */
export const integrations = sqliteTable('integrations', {
  id: text('id').primaryKey(),
  team_id: text('team_id').notNull(),
  name: text('name').notNull(),
  config_path: text('config_path').notNull().default(''),
  status: text('status').notNull().default('proposed'),
  created_at: integer('created_at').notNull(),
}, (table) => [
  index('idx_integrations_team_id').on(table.team_id),
]);

// ---------------------------------------------------------------------------
// credentials
// ---------------------------------------------------------------------------

/** Encrypted credentials scoped per-team. AES-256-GCM via KeyManager. */
export const credentials = sqliteTable('credentials', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  encrypted_value: text('encrypted_value').notNull(),
  team_id: text('team_id').notNull(),
  created_at: integer('created_at').notNull(),
}, (table) => [
  index('idx_credentials_team_id').on(table.team_id),
  index('idx_credentials_name').on(table.name),
]);
