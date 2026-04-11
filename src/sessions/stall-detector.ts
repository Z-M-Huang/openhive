/**
 * Engine-level stall detection per ADR-38.
 *
 * Replaces the dead-letter-scan LLM trigger with a lightweight interval
 * that queries task_queue for pending tasks exceeding age thresholds.
 *
 * Thresholds: >1hr = warn, >24hr = error.
 * Interval: every 10 minutes.
 */

import type Database from 'better-sqlite3';

interface StallLogger {
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const INTERVAL_MS = 10 * 60 * 1000;  // 10 minutes
const WARN_THRESHOLD_MS = 60 * 60 * 1000;  // 1 hour
const ERROR_THRESHOLD_MS = 24 * 60 * 60 * 1000;  // 24 hours

let stallInterval: ReturnType<typeof setInterval> | null = null;

interface PendingRow {
  id: string;
  team_id: string;
  type: string;
  created_at: string;
}

/** Check for stalled tasks and log warnings/errors. Exported for testing. */
export function checkStalledTasks(db: Database.Database, logger: StallLogger): void {
  const now = Date.now();
  const rows = db.prepare(
    "SELECT id, team_id, type, created_at FROM task_queue WHERE status = 'pending'",
  ).all() as PendingRow[];

  for (const row of rows) {
    const createdAt = new Date(row.created_at).getTime();
    if (isNaN(createdAt)) continue;
    const ageMs = now - createdAt;

    if (ageMs > ERROR_THRESHOLD_MS) {
      logger.error('Task stalled >24h', {
        taskId: row.id, team: row.team_id, type: row.type,
        ageHours: Math.floor(ageMs / 3_600_000),
      });
    } else if (ageMs > WARN_THRESHOLD_MS) {
      logger.warn('Task stalled >1h', {
        taskId: row.id, team: row.team_id, type: row.type,
        ageHours: Math.floor(ageMs / 3_600_000),
      });
    }
  }
}

/** Start the stall detector interval. */
export function startStallDetector(db: Database.Database, logger: StallLogger): void {
  stopStallDetector();
  stallInterval = setInterval(() => checkStalledTasks(db, logger), INTERVAL_MS);
  // Don't block shutdown
  if (stallInterval.unref) stallInterval.unref();
}

/** Stop the stall detector interval. */
export function stopStallDetector(): void {
  if (stallInterval) {
    clearInterval(stallInterval);
    stallInterval = null;
  }
}
