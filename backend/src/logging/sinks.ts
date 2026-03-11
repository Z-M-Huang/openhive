/**
 * Log sinks — pluggable log output backends.
 *
 * Design (implemented in later layers):
 *
 * LogSink interface:
 *   Defined in domain/interfaces.ts. Each sink receives batched LogEntry
 *   arrays from the Logger and writes them to a destination.
 *
 * Built-in sinks:
 *   - SQLiteSink: Persists log entries to the SQLite database via LogStore.
 *     Used only in the root container (OPENHIVE_IS_ROOT=true). Accepts a
 *     LogStore instance in the constructor.
 *   - StdoutSink: Writes structured JSON log entries to stdout via pino.
 *     Used in all containers. Accepts an optional pino log-level filter
 *     in the constructor (defaults to LogLevel.Info).
 *
 * Plugin system:
 *   - PluginManager loads custom sinks from workspace/plugins/sinks/.
 *   - Plugin contract: each .js file exports a factory function
 *     `createSink(config: Record<string, unknown>): LogSink`.
 *   - Optional .yaml file alongside the .js provides default config.
 *   - Hot-reload: PluginManager watches the sinks directory with a
 *     500ms debounce file watcher. On change, it reloads the affected
 *     plugin (close old sink, require new module, create new sink).
 *   - Plugins are loaded in alphabetical order by filename.
 *   - Plugin errors are isolated — a failing plugin does not affect
 *     other sinks or the logger.
 */

import type { LogEntry } from '../domain/domain.js';
import type { LogLevel } from '../domain/enums.js';
import type { LogSink, LogStore } from '../domain/interfaces.js';

/**
 * SQLite log sink — persists log entries to the database.
 *
 * Root-only sink. Receives batched LogEntry arrays from the Logger
 * and writes them via LogStore.create(). The LogStore handles
 * the async write queue internally.
 */
export class SQLiteSink implements LogSink {
  /**
   * @param _store - LogStore instance for database persistence.
   */
  constructor(private readonly _store: LogStore) {
    void this._store;
  }

  /** Write a batch of log entries to SQLite via LogStore. */
  async write(_entries: LogEntry[]): Promise<void> {
    throw new Error('Not implemented');
  }

  /** Flush any pending writes and release database resources. */
  async close(): Promise<void> {
    throw new Error('Not implemented');
  }
}

/**
 * Stdout log sink — writes structured JSON to stdout via pino.
 *
 * Used in all containers. Formats LogEntry fields into pino-compatible
 * JSON objects. Respects a minimum log level filter (entries below
 * the threshold are silently dropped).
 */
export class StdoutSink implements LogSink {
  /**
   * @param _minLevel - Minimum log level to emit (entries below are dropped).
   *   Defaults to LogLevel.Info (20).
   */
  constructor(private readonly _minLevel?: LogLevel) {
    void this._minLevel;
  }

  /** Write a batch of log entries to stdout as structured JSON. */
  async write(_entries: LogEntry[]): Promise<void> {
    throw new Error('Not implemented');
  }

  /** No-op for stdout (nothing to close). */
  async close(): Promise<void> {
    throw new Error('Not implemented');
  }
}

/**
 * Plugin manager — hot-reloads custom log sinks from the filesystem.
 *
 * Watches `<workspacePath>/plugins/sinks/` for .js plugin files.
 * Each plugin .js must export a factory: `createSink(config): LogSink`.
 * An optional companion .yaml file provides default config for the factory.
 *
 * File watcher uses 500ms debounce to batch rapid filesystem events.
 * Plugin lifecycle: load → createSink(config) → register → on change →
 * close old sink → reload module → createSink(config) → register.
 *
 * Plugin errors are isolated — a failing plugin logs a warning but
 * does not affect other sinks or the logger pipeline.
 */
export class PluginManager {
  /**
   * @param _workspacePath - Root workspace path. Plugins are loaded
   *   from `<workspacePath>/plugins/sinks/`.
   */
  constructor(private readonly _workspacePath: string) {
    void this._workspacePath;
  }

  /** Load all plugins from the sinks directory and return their LogSink instances. */
  async loadAll(): Promise<LogSink[]> {
    throw new Error('Not implemented');
  }

  /** Start watching the plugins directory for changes (500ms debounce). */
  startWatching(): void {
    throw new Error('Not implemented');
  }

  /** Stop the file watcher and close all loaded plugin sinks. */
  async stopWatching(): Promise<void> {
    throw new Error('Not implemented');
  }

  /** Get all currently loaded plugin sinks. */
  getLoadedSinks(): LogSink[] {
    throw new Error('Not implemented');
  }

  /** Reload a single plugin by filename. Closes old sink, loads new module. */
  async reloadPlugin(_filename: string): Promise<LogSink | undefined> {
    throw new Error('Not implemented');
  }

  /** Unload a single plugin by filename. Closes its sink and removes it. */
  async unloadPlugin(_filename: string): Promise<void> {
    throw new Error('Not implemented');
  }
}
