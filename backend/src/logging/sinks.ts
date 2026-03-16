/**
 * Log sinks — pluggable log output backends.
 *
 * Built-in sinks:
 *   - StdoutSink: Writes structured JSON log entries to stdout via pino.
 *     Used in all containers. Respects a minimum log level filter.
 *   - SQLiteSink: Persists log entries to the SQLite database via LogStore.
 *     Root-only sink. Never throws from write() — errors are logged to stderr.
 *
 * Plugin system:
 *   - PluginManager lives in backend/src/plugins/manager.ts.
 *   - It loads custom LogSink implementations from workspace/plugins/sinks/.
 *   - Hot-reload via chokidar with content-hash deduplication (CON-04, AC-F3).
 */

import pino from 'pino';
import type { LogEntry } from '../domain/domain.js';
import { LogLevel } from '../domain/enums.js';
import type { LogSink, LogStore } from '../domain/interfaces.js';

// ---------------------------------------------------------------------------
// LogLevel → pino method mapping
// ---------------------------------------------------------------------------

type PinoLogMethod = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_TO_PINO: Record<LogLevel, PinoLogMethod> = {
  [LogLevel.Trace]: 'trace',
  [LogLevel.Debug]: 'debug',
  [LogLevel.Info]: 'info',
  [LogLevel.Warn]: 'warn',
  [LogLevel.Error]: 'error',
  [LogLevel.Audit]: 'fatal', // pino has no audit level; fatal is closest
};

// ---------------------------------------------------------------------------
// StdoutSink
// ---------------------------------------------------------------------------

/**
 * Stdout log sink — writes structured JSON to stdout via pino.
 *
 * Used in all containers. Formats LogEntry fields into pino-compatible
 * JSON objects. Respects a minimum log level filter (entries below
 * the threshold are silently dropped).
 */
export class StdoutSink implements LogSink {
  private readonly minLevel: LogLevel;
  private readonly pino: pino.Logger;

  /**
   * @param minLevel - Minimum log level to emit (entries below are dropped).
   *   Defaults to LogLevel.Info (20).
   */
  constructor(minLevel: LogLevel = LogLevel.Info) {
    this.minLevel = minLevel;
    // Let pino accept all levels; we filter ourselves based on LogLevel enum
    this.pino = pino({ level: 'trace' });
  }

  /** Write a batch of log entries to stdout as structured JSON. */
  async write(entries: LogEntry[]): Promise<void> {
    for (const entry of entries) {
      if (entry.level < this.minLevel) {
        continue;
      }
      const method = LEVEL_TO_PINO[entry.level];
      this.pino[method](
        {
          component: entry.component,
          event_type: entry.event_type,
          team_slug: entry.team_slug,
          agent_aid: entry.agent_aid,
          task_id: entry.task_id,
          request_id: entry.request_id,
          correlation_id: entry.correlation_id,
          action: entry.action,
          duration_ms: entry.duration_ms,
          error: entry.error || undefined,
        },
        entry.message,
      );
    }
  }

  /** No-op for stdout (nothing to close). */
  async close(): Promise<void> {
    // pino stdout needs no cleanup
  }
}

// ---------------------------------------------------------------------------
// SQLiteSink
// ---------------------------------------------------------------------------

/**
 * SQLite log sink — persists log entries to the database.
 *
 * Root-only sink. Receives batched LogEntry arrays from the Logger
 * and writes them via LogStore.create(). Never throws from write() —
 * errors are caught and logged to console.error as a fallback.
 */
export class SQLiteSink implements LogSink {
  constructor(private readonly store: LogStore) {}

  /** Write a batch of log entries to SQLite via LogStore. */
  async write(entries: LogEntry[]): Promise<void> {
    try {
      await this.store.create(entries);
    } catch (err: unknown) {
      // Never throw from a sink — fallback to console.error
      console.error('SQLiteSink write failed:', err);
    }
  }

  /** No-op — LogStore manages its own lifecycle. */
  async close(): Promise<void> {
    // LogStore handles cleanup; nothing to do here
  }
}

// PluginManager has been moved to backend/src/plugins/manager.ts (AC-F5).
// Import from that module instead.
