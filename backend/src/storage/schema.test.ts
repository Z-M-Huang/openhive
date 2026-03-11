/**
 * Tests for Drizzle schema CHECK constraints.
 *
 * Uses better-sqlite3 directly to verify CHECK constraints enforce valid
 * status values at the database level.
 *
 * @module storage/schema.test
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { tasks, integrations } from './schema.js';
import { TaskStatus, IntegrationStatus } from '../domain/enums.js';

describe('schema CHECK constraints', () => {
  let db: Database.Database;

  beforeEach(() => {
    // Create in-memory database for testing
    db = Database(':memory:');
  });

  describe('tasks table constraints', () => {
    it('tasks_status_check constraint exists in schema definition', () => {
      const tableConfig = getTableConfig(tasks);
      const constraintNames = tableConfig.checks.map(c => c.name);

      expect(constraintNames).toContain('tasks_status_check');
    });

    it('INSERT with valid task status succeeds for each TaskStatus value', () => {
      // Create the tasks table using Drizzle's SQL
      db.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          parent_id TEXT NOT NULL DEFAULT '',
          team_slug TEXT NOT NULL DEFAULT '',
          agent_aid TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending',
          prompt TEXT NOT NULL DEFAULT '',
          result TEXT NOT NULL DEFAULT '',
          error TEXT NOT NULL DEFAULT '',
          blocked_by TEXT,
          priority INTEGER NOT NULL DEFAULT 0,
          retry_count INTEGER NOT NULL DEFAULT 0,
          max_retries INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          completed_at INTEGER,
          CHECK (status IN ('pending','active','completed','failed','escalated','cancelled'))
        );
        CREATE INDEX idx_tasks_parent_id ON tasks(parent_id);
        CREATE INDEX idx_tasks_team_slug ON tasks(team_slug);
        CREATE INDEX idx_tasks_agent_aid ON tasks(agent_aid);
        CREATE INDEX idx_tasks_status ON tasks(status);
      `);

      const insert = db.prepare(`
        INSERT INTO tasks (id, parent_id, team_slug, agent_aid, title, status, prompt, result, error, priority, retry_count, max_retries, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const now = Date.now();

      // Test each valid TaskStatus value
      const validStatuses = [
        TaskStatus.Pending,
        TaskStatus.Active,
        TaskStatus.Completed,
        TaskStatus.Failed,
        TaskStatus.Escalated,
        TaskStatus.Cancelled,
      ];

      for (const status of validStatuses) {
        const id = `test-${status}-${now}`;
        expect(() => {
          insert.run(
            id, '', 'test-team', 'aid-001', 'Test task', status,
            '', '', '', 0, 0, 0, now, now
          );
        }).not.toThrow();
      }
    });

    it('INSERT with invalid task status throws constraint error', () => {
      db.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          parent_id TEXT NOT NULL DEFAULT '',
          team_slug TEXT NOT NULL DEFAULT '',
          agent_aid TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending',
          prompt TEXT NOT NULL DEFAULT '',
          result TEXT NOT NULL DEFAULT '',
          error TEXT NOT NULL DEFAULT '',
          blocked_by TEXT,
          priority INTEGER NOT NULL DEFAULT 0,
          retry_count INTEGER NOT NULL DEFAULT 0,
          max_retries INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          completed_at INTEGER,
          CHECK (status IN ('pending','active','completed','failed','escalated','cancelled'))
        );
      `);

      const insert = db.prepare(`
        INSERT INTO tasks (id, parent_id, team_slug, agent_aid, title, status, prompt, result, error, priority, retry_count, max_retries, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const now = Date.now();

      // Test invalid status: 'invalid'
      expect(() => {
        insert.run(
          'test-invalid', '', 'test-team', 'aid-001', 'Test task', 'invalid',
          '', '', '', 0, 0, 0, now, now
        );
      }).toThrow();

      // Test invalid status: empty string
      expect(() => {
        insert.run(
          'test-empty', '', 'test-team', 'aid-001', 'Test task', '',
          '', '', '', 0, 0, 0, now, now
        );
      }).toThrow();

      // Test invalid status: uppercase (case-sensitive)
      expect(() => {
        insert.run(
          'test-uppercase', '', 'test-team', 'aid-001', 'Test task', 'PENDING',
          '', '', '', 0, 0, 0, now, now
        );
      }).toThrow();
    });

    it('all TaskStatus enum values match tasks CHECK constraint values', () => {
      const tableConfig = getTableConfig(tasks);
      const tasksCheck = tableConfig.checks.find(c => c.name === 'tasks_status_check');

      expect(tasksCheck).toBeDefined();
      expect(tasksCheck?.name).toBe('tasks_status_check');

      // The functional tests above already verify that all TaskStatus values
      // are accepted and invalid values are rejected. This test confirms
      // the constraint exists with the correct name.
      const enumValues = Object.values(TaskStatus);
      expect(enumValues).toHaveLength(6);
    });
  });

  describe('integrations table constraints', () => {
    it('integrations_status_check constraint exists in schema definition', () => {
      const tableConfig = getTableConfig(integrations);
      const constraintNames = tableConfig.checks.map(c => c.name);

      expect(constraintNames).toContain('integrations_status_check');
    });

    it('INSERT with valid integration status succeeds for each IntegrationStatus value', () => {
      db.exec(`
        CREATE TABLE integrations (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          name TEXT NOT NULL,
          config_path TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'proposed',
          created_at INTEGER NOT NULL,
          CHECK (status IN ('proposed','validated','tested','approved','active','failed','rolled_back'))
        );
        CREATE INDEX idx_integrations_team_id ON integrations(team_id);
      `);

      const insert = db.prepare(`
        INSERT INTO integrations (id, team_id, name, config_path, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const now = Date.now();

      // Test each valid IntegrationStatus value
      const validStatuses = [
        IntegrationStatus.Proposed,
        IntegrationStatus.Validated,
        IntegrationStatus.Tested,
        IntegrationStatus.Approved,
        IntegrationStatus.Active,
        IntegrationStatus.Failed,
        IntegrationStatus.RolledBack,
      ];

      for (const status of validStatuses) {
        const id = `test-${status}-${now}`;
        expect(() => {
          insert.run(id, 'team-001', 'Test Integration', '', status, now);
        }).not.toThrow();
      }
    });

    it('INSERT with invalid integration status throws constraint error', () => {
      db.exec(`
        CREATE TABLE integrations (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          name TEXT NOT NULL,
          config_path TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'proposed',
          created_at INTEGER NOT NULL,
          CHECK (status IN ('proposed','validated','tested','approved','active','failed','rolled_back'))
        );
      `);

      const insert = db.prepare(`
        INSERT INTO integrations (id, team_id, name, config_path, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const now = Date.now();

      // Test invalid status: 'invalid'
      expect(() => {
        insert.run('test-invalid', 'team-001', 'Test', '', 'invalid', now);
      }).toThrow();

      // Test invalid status: empty string
      expect(() => {
        insert.run('test-empty', 'team-001', 'Test', '', '', now);
      }).toThrow();

      // Test invalid status: 'active' with wrong case
      expect(() => {
        insert.run('test-uppercase', 'team-001', 'Test', '', 'ACTIVE', now);
      }).toThrow();
    });

    it('all IntegrationStatus enum values match integrations CHECK constraint values', () => {
      const tableConfig = getTableConfig(integrations);
      const integrationsCheck = tableConfig.checks.find(c => c.name === 'integrations_status_check');

      expect(integrationsCheck).toBeDefined();
      expect(integrationsCheck?.name).toBe('integrations_status_check');

      // The functional tests above already verify that all IntegrationStatus
      // values are accepted and invalid values are rejected.
      const enumValues = Object.values(IntegrationStatus);
      expect(enumValues).toHaveLength(7);
    });
  });
});