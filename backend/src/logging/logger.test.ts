import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry } from '../domain/domain.js';
import { LogLevel } from '../domain/enums.js';
import type { LogSink } from '../domain/interfaces.js';
import { LoggerImpl } from './logger.js';

/** Creates a mock LogSink that captures all written batches. */
function createMockSink(): LogSink & { batches: LogEntry[][] } {
  const batches: LogEntry[][] = [];
  return {
    batches,
    write: vi.fn(async (entries: LogEntry[]) => {
      batches.push([...entries]);
    }),
    close: vi.fn(async () => {}),
  };
}

// Test fixture: sensitive param key/value pair for redaction tests
const SENSITIVE_KEY = 'api_key';
const SENSITIVE_VALUE = 'should-be-redacted';

describe('LoggerImpl', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes when batch reaches batchSize threshold', async () => {
    const sink = createMockSink();
    const logger = new LoggerImpl({
      minLevel: LogLevel.Trace,
      sinks: [sink],
      batchSize: 3,
      flushIntervalMs: 60_000, // long interval so timer doesn't fire
    });

    logger.info('msg-1');
    logger.info('msg-2');
    expect(sink.batches).toHaveLength(0);

    logger.info('msg-3'); // triggers flush at batchSize=3
    // flush() was called via void — await a microtask tick for the promise to settle
    await Promise.resolve();

    expect(sink.batches).toHaveLength(1);
    expect(sink.batches[0]).toHaveLength(3);
    expect(sink.batches[0][0].message).toBe('msg-1');
    expect(sink.batches[0][2].message).toBe('msg-3');

    await logger.stop();
  });

  it('flushes periodically on timer', async () => {
    const sink = createMockSink();
    const logger = new LoggerImpl({
      minLevel: LogLevel.Trace,
      sinks: [sink],
      batchSize: 100,
      flushIntervalMs: 50,
    });

    logger.info('timed-entry');
    expect(sink.batches).toHaveLength(0);

    // Advance past flush interval
    await vi.advanceTimersByTimeAsync(50);

    expect(sink.batches).toHaveLength(1);
    expect(sink.batches[0]).toHaveLength(1);
    expect(sink.batches[0][0].message).toBe('timed-entry');

    await logger.stop();
  });

  it('audit level bypasses minLevel filter', async () => {
    const sink = createMockSink();
    const logger = new LoggerImpl({
      minLevel: LogLevel.Error,
      sinks: [sink],
      batchSize: 100,
      flushIntervalMs: 60_000,
    });

    // These should be filtered out (below Error)
    logger.trace('should-skip');
    logger.debug('should-skip');
    logger.info('should-skip');
    logger.warn('should-skip');

    // Audit should pass despite minLevel=Error
    logger.audit('audit-event');

    await logger.flush();

    expect(sink.batches).toHaveLength(1);
    expect(sink.batches[0]).toHaveLength(1);
    expect(sink.batches[0][0].message).toBe('audit-event');
    expect(sink.batches[0][0].level).toBe(LogLevel.Audit);

    await logger.stop();
  });

  it('applies redaction to params with sensitive keys', async () => {
    const sink = createMockSink();
    const logger = new LoggerImpl({
      minLevel: LogLevel.Trace,
      sinks: [sink],
      batchSize: 100,
      flushIntervalMs: 60_000,
    });

    logger.info('connecting', { [SENSITIVE_KEY]: SENSITIVE_VALUE, host: 'example.com' });
    await logger.flush();

    expect(sink.batches).toHaveLength(1);
    const params = JSON.parse(sink.batches[0][0].params) as Record<string, unknown>;
    expect(params[SENSITIVE_KEY]).toBe('[REDACTED]');
    expect(params.host).toBe('example.com');

    await logger.stop();
  });

  it('applies redaction to message strings', async () => {
    const sink = createMockSink();
    const logger = new LoggerImpl({
      minLevel: LogLevel.Trace,
      sinks: [sink],
      batchSize: 100,
      flushIntervalMs: 60_000,
    });

    logger.info('auth token=abc123 for user');
    await logger.flush();

    expect(sink.batches).toHaveLength(1);
    expect(sink.batches[0][0].message).toBe('auth token=[REDACTED] for user');

    await logger.stop();
  });

  it('isolates sink errors — one failing sink does not block others', async () => {
    const goodSink = createMockSink();
    const badSink: LogSink = {
      write: vi.fn(async () => {
        throw new Error('sink failure');
      }),
      close: vi.fn(async () => {}),
    };

    const logger = new LoggerImpl({
      minLevel: LogLevel.Trace,
      sinks: [badSink, goodSink],
      batchSize: 100,
      flushIntervalMs: 60_000,
    });

    logger.info('important-event');
    await logger.flush();

    // badSink threw, but goodSink still received the entries
    expect(goodSink.batches).toHaveLength(1);
    expect(goodSink.batches[0][0].message).toBe('important-event');
    expect(badSink.write).toHaveBeenCalledOnce();

    await logger.stop();
  });

  it('stop() drains remaining batch and closes all sinks', async () => {
    const sink = createMockSink();
    const logger = new LoggerImpl({
      minLevel: LogLevel.Trace,
      sinks: [sink],
      batchSize: 100,
      flushIntervalMs: 60_000,
    });

    logger.info('pending-1');
    logger.info('pending-2');

    expect(sink.batches).toHaveLength(0);

    await logger.stop();

    // Drain should have flushed
    expect(sink.batches).toHaveLength(1);
    expect(sink.batches[0]).toHaveLength(2);
    // close() should have been called
    expect(sink.close).toHaveBeenCalledOnce();
  });

  it('stopped logger silently rejects new entries', async () => {
    const sink = createMockSink();
    const logger = new LoggerImpl({
      minLevel: LogLevel.Trace,
      sinks: [sink],
      batchSize: 100,
      flushIntervalMs: 60_000,
    });

    await logger.stop();

    // Should not throw
    logger.info('after-stop');
    logger.error('after-stop-2');

    await logger.flush();

    // No entries should have been written (only the stop drain, which was empty)
    expect(sink.batches).toHaveLength(0);
  });

  it('empty batch flush is a no-op — sinks not called', async () => {
    const sink = createMockSink();
    const logger = new LoggerImpl({
      minLevel: LogLevel.Trace,
      sinks: [sink],
      batchSize: 100,
      flushIntervalMs: 60_000,
    });

    await logger.flush();

    expect(sink.write).not.toHaveBeenCalled();

    await logger.stop();
  });

  it('builds full LogEntry with defaults for missing fields', async () => {
    const sink = createMockSink();
    const logger = new LoggerImpl({
      minLevel: LogLevel.Trace,
      sinks: [sink],
      batchSize: 100,
      flushIntervalMs: 60_000,
    });

    logger.info('test-defaults');
    await logger.flush();

    const entry = sink.batches[0][0];
    expect(entry.id).toBeGreaterThan(0);
    expect(entry.level).toBe(LogLevel.Info);
    expect(entry.message).toBe('test-defaults');
    expect(entry.event_type).toBe('');
    expect(entry.component).toBe('');
    expect(entry.action).toBe('');
    expect(entry.params).toBe('{}');
    expect(entry.team_slug).toBe('');
    expect(entry.task_id).toBe('');
    expect(entry.agent_aid).toBe('');
    expect(entry.request_id).toBe('');
    expect(entry.correlation_id).toBe('');
    expect(entry.error).toBe('');
    expect(entry.duration_ms).toBe(0);
    expect(entry.created_at).toBeGreaterThan(0);

    await logger.stop();
  });

  it('log() accepts partial LogEntry with custom fields', async () => {
    const sink = createMockSink();
    const logger = new LoggerImpl({
      minLevel: LogLevel.Trace,
      sinks: [sink],
      batchSize: 100,
      flushIntervalMs: 60_000,
    });

    logger.log({
      level: LogLevel.Warn,
      message: 'custom-entry',
      component: 'test-component',
      team_slug: 'my-team',
      params: JSON.stringify({ foo: 'bar' }),
    });

    await logger.flush();

    const entry = sink.batches[0][0];
    expect(entry.level).toBe(LogLevel.Warn);
    expect(entry.message).toBe('custom-entry');
    expect(entry.component).toBe('test-component');
    expect(entry.team_slug).toBe('my-team');
    expect(JSON.parse(entry.params)).toEqual({ foo: 'bar' });

    await logger.stop();
  });

  it('filters entries below minLevel', async () => {
    const sink = createMockSink();
    const logger = new LoggerImpl({
      minLevel: LogLevel.Warn,
      sinks: [sink],
      batchSize: 100,
      flushIntervalMs: 60_000,
    });

    logger.trace('skip');
    logger.debug('skip');
    logger.info('skip');
    logger.warn('keep-warn');
    logger.error('keep-error');

    await logger.flush();

    expect(sink.batches).toHaveLength(1);
    expect(sink.batches[0]).toHaveLength(2);
    expect(sink.batches[0][0].message).toBe('keep-warn');
    expect(sink.batches[0][1].message).toBe('keep-error');

    await logger.stop();
  });
});
