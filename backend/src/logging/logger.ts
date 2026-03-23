/**
 * Structured JSON logger built on Pino.
 *
 * Outputs to stdout (primary). When a LogStore is provided, each log entry
 * is also written to SQLite (secondary, best-effort — errors are swallowed
 * to avoid recursive logging failures).
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

export function createLogger(options?: LoggerOptions): pino.Logger {
  const logStore = options?.logStore;

  if (!logStore) {
    return pino({
      level: options?.level ?? 'info',
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level(label) {
          return { level: label };
        },
      },
    });
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

  return pino({
    level: options?.level ?? 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  }, tee);
}
