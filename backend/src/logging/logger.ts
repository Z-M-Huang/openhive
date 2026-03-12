/**
 * Logger implementation — structured logging with fan-out to sinks.
 *
 * - Six log levels: trace=0, debug=10, info=20, warn=30, error=40, audit=50
 * - Audit level bypasses the minimum-level filter (always emitted)
 * - Batch writer: flushes every batchSize entries or flushIntervalMs, whichever comes first
 * - Fan-out to all registered LogSink instances via Promise.allSettled (sink error isolation)
 * - Redaction of sensitive keys in params and message strings (NFR09)
 */

import type { LogEntry } from '../domain/domain.js';
import { LogLevel } from '../domain/enums.js';
import type { Logger, LogSink } from '../domain/interfaces.js';
import { redactMessage, redactParams } from './redaction.js';

export interface LoggerOptions {
  minLevel: LogLevel;
  sinks: LogSink[];
  batchSize?: number;
  flushIntervalMs?: number;
}

let nextId = 1;

export class LoggerImpl implements Logger {
  private readonly minLevel: LogLevel;
  private readonly sinks: LogSink[];
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;

  private batch: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(options: LoggerOptions) {
    this.minLevel = options.minLevel;
    this.sinks = options.sinks;
    this.batchSize = options.batchSize ?? 50;
    this.flushIntervalMs = options.flushIntervalMs ?? 100;

    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
  }

  log(entry: Partial<LogEntry> & { level: LogLevel; message: string }): void {
    if (this.stopped) {
      return;
    }

    // Audit always passes; otherwise check minLevel
    if (entry.level !== LogLevel.Audit && entry.level < this.minLevel) {
      return;
    }

    // Build full LogEntry with defaults
    const full: LogEntry = {
      id: entry.id ?? nextId++,
      level: entry.level,
      event_type: entry.event_type ?? '',
      component: entry.component ?? '',
      action: entry.action ?? '',
      message: redactMessage(entry.message),
      params: entry.params != null
        ? JSON.stringify(redactParams(JSON.parse(entry.params)))
        : '{}',
      team_slug: entry.team_slug ?? '',
      task_id: entry.task_id ?? '',
      agent_aid: entry.agent_aid ?? '',
      request_id: entry.request_id ?? '',
      correlation_id: entry.correlation_id ?? '',
      error: entry.error ?? '',
      duration_ms: entry.duration_ms ?? 0,
      created_at: entry.created_at ?? Date.now(),
    };

    this.batch.push(full);

    if (this.batch.length >= this.batchSize) {
      void this.flush();
    }
  }

  trace(message: string, params?: Record<string, unknown>): void {
    this.log({
      level: LogLevel.Trace,
      message,
      params: params ? JSON.stringify(params) : undefined,
    });
  }

  debug(message: string, params?: Record<string, unknown>): void {
    this.log({
      level: LogLevel.Debug,
      message,
      params: params ? JSON.stringify(params) : undefined,
    });
  }

  info(message: string, params?: Record<string, unknown>): void {
    this.log({
      level: LogLevel.Info,
      message,
      params: params ? JSON.stringify(params) : undefined,
    });
  }

  warn(message: string, params?: Record<string, unknown>): void {
    this.log({
      level: LogLevel.Warn,
      message,
      params: params ? JSON.stringify(params) : undefined,
    });
  }

  error(message: string, params?: Record<string, unknown>): void {
    this.log({
      level: LogLevel.Error,
      message,
      params: params ? JSON.stringify(params) : undefined,
    });
  }

  audit(message: string, params?: Record<string, unknown>): void {
    this.log({
      level: LogLevel.Audit,
      message,
      params: params ? JSON.stringify(params) : undefined,
    });
  }

  async flush(): Promise<void> {
    // Swap-and-reset: atomic grab of pending entries
    const pending = this.batch;
    this.batch = [];

    if (pending.length === 0) {
      return;
    }

    await Promise.allSettled(
      this.sinks.map((sink) => sink.write(pending)),
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.flushTimer);
    await this.flush();
    await Promise.allSettled(
      this.sinks.map((sink) => sink.close()),
    );
  }
}
