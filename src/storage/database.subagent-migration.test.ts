/**
 * Tests for subagent column migration in trigger_configs table.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTables } from './database.js';

describe('subagent migration', () => {
  let raw: Database.Database;

  beforeEach(() => {
    raw = new Database(':memory:');
  });

  afterEach(() => {
    raw.close();
  });

  it('creates trigger_configs with subagent column', () => {
    createTables(raw);

    const columns = raw.prepare("PRAGMA table_info(trigger_configs)").all() as { name: string }[];
    const columnNames = columns.map(c => c.name);

    expect(columnNames).toContain('subagent');
  });

  it('subagent column is nullable and defaults to null', () => {
    createTables(raw);

    raw.prepare(`
      INSERT INTO trigger_configs (team, name, type, config, task, state, created_at, updated_at)
      VALUES ('test-team', 'test-trigger', 'schedule', '{}', 'do something', 'pending', datetime('now'), datetime('now'))
    `).run();

    const row = raw.prepare(`
      SELECT subagent FROM trigger_configs WHERE team = 'test-team' AND name = 'test-trigger'
    `).get() as { subagent: string | null };

    expect(row.subagent).toBeNull();
  });

  it('accepts explicit subagent value', () => {
    createTables(raw);

    raw.prepare(`
      INSERT INTO trigger_configs (team, name, type, config, task, state, subagent, created_at, updated_at)
      VALUES ('test-team', 'test-trigger', 'schedule', '{}', 'do something', 'pending', 'research-agent', datetime('now'), datetime('now'))
    `).run();

    const row = raw.prepare(`
      SELECT subagent FROM trigger_configs WHERE team = 'test-team' AND name = 'test-trigger'
    `).get() as { subagent: string | null };

    expect(row.subagent).toBe('research-agent');
  });

  it('creates idx_trigger_configs_team_subagent index', () => {
    createTables(raw);

    const indexes = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'trigger_configs'").all() as { name: string }[];
    const indexNames = indexes.map(i => i.name);

    expect(indexNames).toContain('idx_trigger_configs_team_subagent');
  });

  it('migration is idempotent - running createTables twice does not fail', () => {
    createTables(raw);
    
    // Running again should not throw
    expect(() => createTables(raw)).not.toThrow();

    const columns = raw.prepare("PRAGMA table_info(trigger_configs)").all() as { name: string }[];
    const columnNames = columns.map(c => c.name);

    expect(columnNames).toContain('subagent');
  });

  it('preserves existing data when adding subagent column', () => {
    // Create table without subagent column first
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
        max_steps INTEGER NOT NULL DEFAULT 100,
        failure_threshold INTEGER NOT NULL DEFAULT 3,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        disabled_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Insert data
    raw.prepare(`
      INSERT INTO trigger_configs (team, name, type, config, task, state, created_at, updated_at)
      VALUES ('legacy-team', 'legacy-trigger', 'schedule', '{}', 'old task', 'active', datetime('now'), datetime('now'))
    `).run();

    // Run migrations
    createTables(raw);

    // Verify data was preserved
    const row = raw.prepare(`
      SELECT team, name, task, subagent FROM trigger_configs WHERE team = 'legacy-team' AND name = 'legacy-trigger'
    `).get() as { team: string; name: string; task: string; subagent: string | null };

    expect(row.team).toBe('legacy-team');
    expect(row.name).toBe('legacy-trigger');
    expect(row.task).toBe('old task');
    expect(row.subagent).toBeNull();
  });
});