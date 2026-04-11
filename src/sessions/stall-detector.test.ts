import { describe, it, expect, vi } from 'vitest';
import { checkStalledTasks, startStallDetector, stopStallDetector } from './stall-detector.js';
import { createDatabase, createTables } from '../storage/database.js';
import type Database from 'better-sqlite3';

function createTestDb(): Database.Database {
  const instance = createDatabase(':memory:');
  createTables(instance.raw);
  return instance.raw;
}

function insertPendingTask(db: Database.Database, id: string, createdAt: string) {
  db.prepare(
    "INSERT INTO task_queue (id, team_id, task, priority, type, status, created_at) VALUES (?, 'main', 'test', 'normal', 'delegate', 'pending', ?)",
  ).run(id, createdAt);
}

describe('StallDetector', () => {
  it('warns on tasks pending >1 hour', () => {
    const db = createTestDb();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    insertPendingTask(db, 'task-2h', twoHoursAgo);

    const logger = { warn: vi.fn(), error: vi.fn() };
    checkStalledTasks(db, logger);

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith('Task stalled >1h', expect.objectContaining({ taskId: 'task-2h', ageHours: 2 }));
    expect(logger.error).not.toHaveBeenCalled();
    db.close();
  });

  it('errors on tasks pending >24 hours', () => {
    const db = createTestDb();
    const thirtyHoursAgo = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    insertPendingTask(db, 'task-30h', thirtyHoursAgo);

    const logger = { warn: vi.fn(), error: vi.fn() };
    checkStalledTasks(db, logger);

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith('Task stalled >24h', expect.objectContaining({ taskId: 'task-30h', ageHours: 30 }));
    expect(logger.warn).not.toHaveBeenCalled();
    db.close();
  });

  it('does not warn on recent tasks', () => {
    const db = createTestDb();
    const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    insertPendingTask(db, 'task-recent', thirtyMinsAgo);

    const logger = { warn: vi.fn(), error: vi.fn() };
    checkStalledTasks(db, logger);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    db.close();
  });

  it('stopStallDetector clears interval', () => {
    const db = createTestDb();
    const logger = { warn: vi.fn(), error: vi.fn() };
    startStallDetector(db, logger);
    stopStallDetector();
    stopStallDetector(); // idempotent
    db.close();
  });
});
