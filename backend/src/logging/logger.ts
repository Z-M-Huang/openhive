/**
 * OpenHive Backend - DB Logger
 *
 * Implements dual-output structured logging: DB batch writing + pino stdout.
 *
 * Design notes:
 *   - Batches up to BATCH_SIZE (50) entries before writing to LogStore.
 *   - A setInterval timer fires every FLUSH_INTERVAL_MS (100ms) to flush
 *     partial batches that have not yet reached BATCH_SIZE.
 *   - Batching is synchronous (single-threaded JS): when the batch is full,
 *     log() drops the entry and increments droppedCount (non-blocking).
 *   - Each entry is redacted (params JSON walk + message string scan) before
 *     pino output and DB storage.
 *   - Pino maps domain LogLevel strings to pino levels: debug→debug,
 *     info→info, warn→warn, error→error.
 *   - stop() clears the timer, flushes remaining batch to DB, and returns a
 *     Promise that resolves after the final store.create() call completes.
 *     Calling stop() a second time is a no-op.
 */

import pino from 'pino';
import type { Logger as PinoLogger } from 'pino';
import type { LogStore } from '../domain/interfaces.js';
import type { LogEntry } from '../domain/types.js';
import type { LogLevel } from '../domain/enums.js';
import { LOG_LEVELS } from '../domain/enums.js';
import { newRedactor } from './redaction.js';
import type { Redactor } from './redaction.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 100;

// ---------------------------------------------------------------------------
// Level ordering helpers
// ---------------------------------------------------------------------------

/**
 * Returns the numeric index of a LogLevel in the LOG_LEVELS array.
 * Higher index = higher severity (debug=0, info=1, warn=2, error=3).
 */
function levelIndex(level: LogLevel): number {
  return LOG_LEVELS.indexOf(level);
}

// ---------------------------------------------------------------------------
// DBLogger
// ---------------------------------------------------------------------------

/**
 * DBLogger implements dual-output structured logging.
 *
 * Typical usage:
 *   const logger = newDBLogger(logStore, 'info');
 *   logger.log({ level: 'info', component: 'api', action: 'request', ... });
 *   await logger.stop(); // on shutdown
 */
export class DBLogger {
  private readonly store: LogStore;
  private readonly minLevelIndex: number;
  private readonly redactor: Redactor;
  private readonly pino: PinoLogger;
  private readonly defaultComponent: string;
  private batch: LogEntry[];
  private timer: ReturnType<typeof setInterval> | null;
  private dropped: number;
  private stopped: boolean;

  constructor(store: LogStore, minLevel: LogLevel, defaultComponent: string = '') {
    this.store = store;
    this.minLevelIndex = levelIndex(minLevel);
    this.defaultComponent = defaultComponent;
    this.redactor = newRedactor();
    this.batch = [];
    this.dropped = 0;
    this.stopped = false;

    // Create a pino logger. In tests the output goes to /dev/null equivalent
    // (process.stdout), which is acceptable. In production, pino-pretty can be
    // enabled via the PINO_PRETTY env var or a transport.
    this.pino = pino({
      level: minLevel,
    });

    // Start the periodic flush timer
    this.timer = setInterval(() => {
      this.flushIfNonEmpty();
    }, FLUSH_INTERVAL_MS);
  }

  // -------------------------------------------------------------------------
  // log
  // -------------------------------------------------------------------------

  /**
   * Records a log entry, applying level filtering and redaction.
   * Non-blocking: if the batch is full, the entry is dropped.
   */
  log(entry: LogEntry): void {
    if (this.stopped) {
      return;
    }

    // Level filter
    if (levelIndex(entry.level) < this.minLevelIndex) {
      return;
    }

    // Set timestamp if not already set (zero Date = epoch ms 0)
    if (entry.created_at.getTime() === 0) {
      entry.created_at = new Date();
    }

    // Redact params (JSON walk) and message (string pattern scan)
    const redactedEntry: LogEntry = {
      ...entry,
      params:
        entry.params !== undefined
          ? (JSON.parse(this.redactor.redactParams(JSON.stringify(entry.params))) as typeof entry.params)
          : undefined,
      message: this.redactor.redactString(entry.message),
    };

    // Emit to pino stdout
    this.pinoOutput(redactedEntry);

    // Non-blocking add to batch — drop if full
    if (this.batch.length >= BATCH_SIZE) {
      this.dropped++;
      this.pino.warn(
        { component: entry.component, action: entry.action },
        'log batch full, dropping entry',
      );
      return;
    }

    this.batch.push(redactedEntry);

    // Eager flush when batch is exactly full
    if (this.batch.length >= BATCH_SIZE) {
      this.flushBatch();
    }
  }

  // -------------------------------------------------------------------------
  // droppedCount
  // -------------------------------------------------------------------------

  /**
   * Returns the number of entries dropped due to backpressure or flush errors
   * since construction.
   */
  droppedCount(): number {
    return this.dropped;
  }

  // -------------------------------------------------------------------------
  // Convenience methods (satisfy component-specific logger interfaces)
  // -------------------------------------------------------------------------

  /** Logs a debug-level message. Satisfies HeartbeatLogger, HubLogger, etc. */
  debug(msg: string, data?: Record<string, unknown>): void {
    this.log(this.makeEntry('debug', msg, data));
  }

  /** Logs an info-level message. Satisfies DispatcherLogger, OrchestratorLogger, etc. */
  info(msg: string, data?: Record<string, unknown>): void {
    this.log(this.makeEntry('info', msg, data));
  }

  /** Logs a warn-level message. */
  warn(msg: string, data?: Record<string, unknown>): void {
    this.log(this.makeEntry('warn', msg, data));
  }

  /** Logs an error-level message. */
  error(msg: string, data?: Record<string, unknown>): void {
    this.log(this.makeEntry('error', msg, data));
  }

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------

  /**
   * Clears the flush timer and flushes any remaining batch entries to the DB.
   * Returns a Promise that resolves once the final store.create() call
   * completes. Idempotent — calling stop() a second time is a no-op.
   */
  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.batch.length > 0) {
      await this.flushBatchAsync();
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Builds a LogEntry from a convenience-method call.
   * Extracts well-known fields from the data record; remaining keys stay in params.
   */
  private makeEntry(level: LogLevel, msg: string, data?: Record<string, unknown>): LogEntry {
    return {
      id: 0,
      level,
      component: typeof data?.['component'] === 'string' ? data['component'] : this.defaultComponent,
      action: typeof data?.['action'] === 'string' ? data['action'] : '',
      message: msg,
      params: data !== undefined ? (data as unknown as import('../domain/types.js').JsonValue) : undefined,
      error: typeof data?.['error'] === 'string' ? data['error'] : undefined,
      team_name: typeof data?.['team_name'] === 'string' ? data['team_name'] : undefined,
      task_id: typeof data?.['task_id'] === 'string' ? data['task_id'] : undefined,
      agent_name: typeof data?.['agent_name'] === 'string' ? data['agent_name'] : undefined,
      request_id: typeof data?.['request_id'] === 'string' ? data['request_id'] : undefined,
      duration_ms: typeof data?.['duration_ms'] === 'number' ? data['duration_ms'] : undefined,
      created_at: new Date(),
    };
  }

  /**
   * Emits a log entry to pino stdout.
   * Maps domain LogLevel to the corresponding pino method.
   */
  private pinoOutput(entry: LogEntry): void {
    const fields: Record<string, string | number> = {
      component: entry.component,
      action: entry.action,
    };
    if (entry.team_name !== undefined && entry.team_name !== '') {
      fields['team'] = entry.team_name;
    }
    if (entry.task_id !== undefined && entry.task_id !== '') {
      fields['task_id'] = entry.task_id;
    }
    if (entry.agent_name !== undefined && entry.agent_name !== '') {
      fields['agent'] = entry.agent_name;
    }
    if (entry.request_id !== undefined && entry.request_id !== '') {
      fields['request_id'] = entry.request_id;
    }
    if (entry.error !== undefined && entry.error !== '') {
      fields['error'] = entry.error;
    }
    if (entry.duration_ms !== undefined && entry.duration_ms > 0) {
      fields['duration_ms'] = entry.duration_ms;
    }

    switch (entry.level) {
      case 'debug':
        this.pino.debug(fields, entry.message);
        break;
      case 'info':
        this.pino.info(fields, entry.message);
        break;
      case 'warn':
        this.pino.warn(fields, entry.message);
        break;
      case 'error':
        this.pino.error(fields, entry.message);
        break;
      default:
        this.pino.info(fields, entry.message);
    }
  }

  /**
   * Flushes the current batch to the DB if it is non-empty.
   * Called by the setInterval timer. Fire-and-forget (no await).
   */
  private flushIfNonEmpty(): void {
    if (this.batch.length > 0) {
      this.flushBatch();
    }
  }

  /**
   * Swaps out the current batch and writes it to the LogStore asynchronously.
   * Fire-and-forget — errors increment droppedCount.
   */
  private flushBatch(): void {
    const toFlush = this.batch;
    this.batch = [];
    void this.writeToStore(toFlush);
  }

  /**
   * Awaitable version of flushBatch — used only by stop().
   */
  private async flushBatchAsync(): Promise<void> {
    const toFlush = this.batch;
    this.batch = [];
    await this.writeToStore(toFlush);
  }

  /**
   * Calls store.create() with the given entries.
   * On failure, increments droppedCount and logs to pino.
   */
  private async writeToStore(entries: LogEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    try {
      await this.store.create(entries);
    } catch (err) {
      this.dropped += entries.length;
      this.pino.error(
        { error: String(err), count: entries.length },
        'failed to flush log batch to DB',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a new DBLogger with the given LogStore and minimum log level.
 * The batch writer timer starts immediately.
 */
export function newDBLogger(store: LogStore, minLevel: LogLevel, defaultComponent: string = ''): DBLogger {
  return new DBLogger(store, minLevel, defaultComponent);
}
