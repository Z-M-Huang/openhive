/**
 * Structured JSON logger built on Pino.
 *
 * Outputs to stdout (primary). When a LogStore is provided, each log entry
 * is also written to SQLite (secondary, best-effort — errors are swallowed
 * to avoid recursive logging failures).
 *
 * Pino's native API is (meta, msg). The codebase convention is (msg, meta?).
 * createLogger() returns an AppLogger that uses our convention, wrapping pino
 * internally. There is ONE logger — no separate "adapted" wrapper.
 */

import { Writable } from 'node:stream';
import pino from 'pino';
import type { ILogStore } from '../domain/interfaces.js';
import type { LogEntry } from '../domain/types.js';

export interface LoggerOptions {
  readonly level?: string;
  readonly logStore?: ILogStore;
}

/** Pino level names that map to our LogEntry levels. */
const VALID_LOG_LEVELS = new Set<string>(['trace', 'debug', 'info', 'warn', 'error']);

let logEntryCounter = 0;

type LogMethod = (msg: string, meta?: Record<string, unknown>) => void;

/** Application logger — all standard levels, (msg, meta?) convention. */
export interface AppLogger {
  trace: LogMethod;
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  fatal: LogMethod;
}

/** Wrap a pino level method to accept (msg, meta?) instead of pino's (meta?, msg). */
function wrapLevel(pinoLogger: pino.Logger, level: keyof AppLogger): LogMethod {
  return (msg, meta) => {
    if (meta) pinoLogger[level](meta, msg);
    else pinoLogger[level](msg);
  };
}

/** Wrap a pino.Logger into our AppLogger convention. Internal — prefer createLogger(). */
export function wrapPinoLogger(pinoLogger: pino.Logger): AppLogger {
  return {
    trace: wrapLevel(pinoLogger, 'trace'),
    debug: wrapLevel(pinoLogger, 'debug'),
    info: wrapLevel(pinoLogger, 'info'),
    warn: wrapLevel(pinoLogger, 'warn'),
    error: wrapLevel(pinoLogger, 'error'),
    fatal: wrapLevel(pinoLogger, 'fatal'),
  };
}

export function createLogger(options?: LoggerOptions): AppLogger {
  const logStore = options?.logStore;

  const pinoOpts: pino.LoggerOptions = {
    level: options?.level ?? 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  };

  if (!logStore) {
    return wrapPinoLogger(pino(pinoOpts));
  }

  // Tee stream: write to stdout and also persist to the log store.
  const tee = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const line = chunk.toString();

      // Always write to stdout first
      process.stdout.write(line);

      // Best-effort store write
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const rawLevel = parsed['level'];
        const level = typeof rawLevel === 'string' ? rawLevel : 'info';
        const rawMsg = parsed['msg'];
        const message = typeof rawMsg === 'string' ? rawMsg : '';
        const entry: LogEntry = {
          id: `log-${Date.now()}-${++logEntryCounter}`,
          level: (VALID_LOG_LEVELS.has(level) ? level : 'info') as LogEntry['level'],
          message,
          timestamp: Date.now(),
          source: 'logger',
          metadata: parsed,
        };
        logStore.append(entry);
      } catch {
        // Swallow — never let store errors break logging
      }

      callback();
    },
  });

  return wrapPinoLogger(pino(pinoOpts, tee));
}
