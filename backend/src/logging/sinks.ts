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
 *   - PluginManager loads custom sinks from workspace/plugins/sinks/.
 *   - Currently ships as no-op stubs (sandboxing deferred — see ADR).
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

// ---------------------------------------------------------------------------
// PluginManager (no-op stubs — sandboxing deferred)
// ---------------------------------------------------------------------------

// TODO: Sandboxing deferred — plugins run in same process. See ADR for accepted risk.

/**
 * Plugin manager — hot-reloads custom log sinks from the filesystem.
 *
 * Currently ships as no-op stubs per user decision #5 (deferred sandboxing).
 * All methods are safe to call but perform no work.
 */
export class PluginManager {
  constructor(private readonly _workspacePath: string) {
    void this._workspacePath;
  }

  /** Load all plugins from the sinks directory. Returns empty array (deferred). */
  async loadAll(): Promise<LogSink[]> {
    return [];
  }

  /** Start watching the plugins directory. No-op (deferred). */
  startWatching(): void {
    // no-op
  }

  /** Stop the file watcher. No-op (deferred). */
  async stopWatching(): Promise<void> {
    // no-op
  }

  /** Get all currently loaded plugin sinks. Returns empty array (deferred). */
  getLoadedSinks(): LogSink[] {
    return [];
  }

  /** Reload a single plugin by filename. No-op (deferred). */
  async reloadPlugin(_filename: string): Promise<LogSink | undefined> {
    return undefined;
  }

  /** Unload a single plugin by filename. No-op (deferred). */
  async unloadPlugin(_filename: string): Promise<void> {
    // no-op
  }
}
