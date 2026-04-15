/**
 * Tests for max_turns → max_steps migration in trigger_configs table.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTables } from './database.js';

describe('max_steps migration', () => {
  let raw: Database.Database;

  beforeEach(() => {
    raw = new Database(':memory:');
  });

  afterEach(() => {
    raw.close();
  });

  it('creates trigger_configs with max_steps column', () => {
    createTables(raw);

    const columns = raw.prepare("PRAGMA table_info(trigger_configs)").all() as { name: string }[];
    const columnNames = columns.map(c => c.name);

    expect(columnNames).toContain('max_steps');
    expect(columnNames).not.toContain('max_turns');
  });

  it('defaults max_steps to 100', () => {
    createTables(raw);

    raw.prepare(`
      INSERT INTO trigger_configs (team, name, type, config, task, state, created_at, updated_at)
      VALUES ('test-team', 'test-trigger', 'schedule', '{}', 'do something', 'pending', datetime('now'), datetime('now'))
    `).run();

    const row = raw.prepare(`
      SELECT max_steps FROM trigger_configs WHERE team = 'test-team' AND name = 'test-trigger'
    `).get() as { max_steps: number };

    expect(row.max_steps).toBe(100);
  });

  it('accepts explicit max_steps value', () => {
    createTables(raw);

    raw.prepare(`
      INSERT INTO trigger_configs (team, name, type, config, task, state, max_steps, created_at, updated_at)
      VALUES ('test-team', 'test-trigger', 'schedule', '{}', 'do something', 'pending', 50, datetime('now'), datetime('now'))
    `).run();

    const row = raw.prepare(`
      SELECT max_steps FROM trigger_configs WHERE team = 'test-team' AND name = 'test-trigger'
    `).get() as { max_steps: number };

    expect(row.max_steps).toBe(50);
  });

  it('migrates existing max_turns column to max_steps', () => {
    // First create the old schema with max_turns
    raw.exec(`
      CREATE TABLE trigger_configs (
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Insert with old column name
    raw.prepare(`
      INSERT INTO trigger_configs (team, name, type, config, task, state, max_turns, created_at, updated_at)
      VALUES ('legacy-team', 'legacy-trigger', 'schedule', '{}', 'old task', 'active', 75, datetime('now'), datetime('now'))
    `).run();

    // Run migrations
    createTables(raw);

    // Verify migration happened
    const columns = raw.prepare("PRAGMA table_info(trigger_configs)").all() as { name: string }[];
    const columnNames = columns.map(c => c.name);

    expect(columnNames).toContain('max_steps');
    expect(columnNames).not.toContain('max_turns');

    // Verify data was preserved
    const row = raw.prepare(`
      SELECT max_steps FROM trigger_configs WHERE team = 'legacy-team' AND name = 'legacy-trigger'
    `).get() as { max_steps: number };

    expect(row.max_steps).toBe(75);
  });
});