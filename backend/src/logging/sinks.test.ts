import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LogLevel } from '../domain/enums.js';
import type { LogEntry } from '../domain/domain.js';
import type { LogStore } from '../domain/interfaces.js';

// ---------------------------------------------------------------------------
// Mock pino at the top level (hoisted by vitest)
// ---------------------------------------------------------------------------

const pinoMethods = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
};

vi.mock('pino', () => ({
  default: () => pinoMethods,
}));

// Import AFTER mock is declared (vitest hoists vi.mock above imports)
import { SQLiteSink, StdoutSink, PluginManager } from './sinks.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal LogEntry with overrides. */
function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: 1,
    level: LogLevel.Info,
    event_type: 'test',
    component: 'test-component',
    action: 'test-action',
    message: 'test message',
    params: '{}',
    team_slug: 'test-team',
    task_id: 'task-1',
    agent_aid: 'aid-test-abc',
    request_id: 'req-1',
    correlation_id: 'corr-1',
    error: '',
    duration_ms: 0,
    created_at: Date.now(),
    ...overrides,
  };
}

/** Create a mock LogStore with vi.fn() for each method. */
function makeLogStore(): LogStore {
  return {
    create: vi.fn<(entries: LogEntry[]) => Promise<void>>().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    deleteBefore: vi.fn().mockResolvedValue(0),
    deleteByLevelBefore: vi.fn().mockResolvedValue(0),
    count: vi.fn().mockResolvedValue(0),
    getOldest: vi.fn().mockResolvedValue([]),
  };
}

// ---------------------------------------------------------------------------
// StdoutSink
// ---------------------------------------------------------------------------

describe('StdoutSink', () => {
  beforeEach(() => {
    pinoMethods.trace.mockClear();
    pinoMethods.debug.mockClear();
    pinoMethods.info.mockClear();
    pinoMethods.warn.mockClear();
    pinoMethods.error.mockClear();
    pinoMethods.fatal.mockClear();
  });

  it('filters entries below minLevel', async () => {
    const sink = new StdoutSink(LogLevel.Warn);
    const entries = [
      makeEntry({ level: LogLevel.Trace }),
      makeEntry({ level: LogLevel.Debug }),
      makeEntry({ level: LogLevel.Info }),
    ];

    await sink.write(entries);

    expect(pinoMethods.trace).not.toHaveBeenCalled();
    expect(pinoMethods.debug).not.toHaveBeenCalled();
    expect(pinoMethods.info).not.toHaveBeenCalled();
    expect(pinoMethods.warn).not.toHaveBeenCalled();
  });

  it('passes entries at or above minLevel', async () => {
    const sink = new StdoutSink(LogLevel.Warn);
    const entries = [
      makeEntry({ level: LogLevel.Warn, message: 'warn msg' }),
      makeEntry({ level: LogLevel.Error, message: 'error msg' }),
      makeEntry({ level: LogLevel.Audit, message: 'audit msg' }),
    ];

    await sink.write(entries);

    expect(pinoMethods.warn).toHaveBeenCalledTimes(1);
    expect(pinoMethods.error).toHaveBeenCalledTimes(1);
    expect(pinoMethods.fatal).toHaveBeenCalledTimes(1);
  });

  it('defaults minLevel to Info', async () => {
    const sink = new StdoutSink();
    const entries = [
      makeEntry({ level: LogLevel.Trace }),
      makeEntry({ level: LogLevel.Debug }),
      makeEntry({ level: LogLevel.Info, message: 'info msg' }),
    ];

    await sink.write(entries);

    expect(pinoMethods.trace).not.toHaveBeenCalled();
    expect(pinoMethods.debug).not.toHaveBeenCalled();
    expect(pinoMethods.info).toHaveBeenCalledTimes(1);
  });

  it('maps LogLevel to correct pino method', async () => {
    const sink = new StdoutSink(LogLevel.Trace);

    await sink.write([makeEntry({ level: LogLevel.Trace, message: 'a' })]);
    expect(pinoMethods.trace).toHaveBeenCalledTimes(1);

    await sink.write([makeEntry({ level: LogLevel.Debug, message: 'b' })]);
    expect(pinoMethods.debug).toHaveBeenCalledTimes(1);

    await sink.write([makeEntry({ level: LogLevel.Info, message: 'c' })]);
    expect(pinoMethods.info).toHaveBeenCalledTimes(1);

    await sink.write([makeEntry({ level: LogLevel.Warn, message: 'd' })]);
    expect(pinoMethods.warn).toHaveBeenCalledTimes(1);

    await sink.write([makeEntry({ level: LogLevel.Error, message: 'e' })]);
    expect(pinoMethods.error).toHaveBeenCalledTimes(1);

    await sink.write([makeEntry({ level: LogLevel.Audit, message: 'f' })]);
    expect(pinoMethods.fatal).toHaveBeenCalledTimes(1);
  });

  it('passes entry fields as pino context object', async () => {
    const sink = new StdoutSink(LogLevel.Info);
    const entry = makeEntry({
      level: LogLevel.Info,
      message: 'test message',
      component: 'orchestrator',
      event_type: 'task_dispatch',
      team_slug: 'weather-team',
      agent_aid: 'aid-agent-abc',
      task_id: 'task-42',
      request_id: 'req-99',
      correlation_id: 'corr-77',
      action: 'dispatch',
      duration_ms: 150,
      error: 'something failed',
    });

    await sink.write([entry]);

    expect(pinoMethods.info).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'orchestrator',
        event_type: 'task_dispatch',
        team_slug: 'weather-team',
        agent_aid: 'aid-agent-abc',
        task_id: 'task-42',
        request_id: 'req-99',
        correlation_id: 'corr-77',
        action: 'dispatch',
        duration_ms: 150,
        error: 'something failed',
      }),
      'test message',
    );
  });

  it('omits error field when empty string', async () => {
    const sink = new StdoutSink(LogLevel.Info);
    const entry = makeEntry({ level: LogLevel.Info, error: '' });

    await sink.write([entry]);

    const context = pinoMethods.info.mock.calls[0][0] as Record<string, unknown>;
    expect(context.error).toBeUndefined();
  });

  it('close() resolves without error', async () => {
    const sink = new StdoutSink();
    await expect(sink.close()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SQLiteSink
// ---------------------------------------------------------------------------

describe('SQLiteSink', () => {
  let store: LogStore;
  let sink: SQLiteSink;

  beforeEach(() => {
    store = makeLogStore();
    sink = new SQLiteSink(store);
  });

  it('delegates write() to store.create()', async () => {
    const entries = [makeEntry(), makeEntry({ id: 2 })];
    await sink.write(entries);

    expect(store.create).toHaveBeenCalledTimes(1);
    expect(store.create).toHaveBeenCalledWith(entries);
  });

  it('calls store.create() even with empty entries array', async () => {
    await sink.write([]);
    expect(store.create).toHaveBeenCalledWith([]);
  });

  it('catches store errors and logs to console.error', async () => {
    const testError = new Error('DB write failed');
    (store.create as ReturnType<typeof vi.fn>).mockRejectedValue(testError);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Should not throw
    await expect(sink.write([makeEntry()])).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith('SQLiteSink write failed:', testError);
    consoleSpy.mockRestore();
  });

  it('close() resolves without error', async () => {
    await expect(sink.close()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PluginManager (no-op stubs)
// ---------------------------------------------------------------------------

describe('PluginManager', () => {
  let manager: PluginManager;

  beforeEach(() => {
    manager = new PluginManager('/app/workspace');
  });

  it('loadAll() returns empty array', async () => {
    const result = await manager.loadAll();
    expect(result).toEqual([]);
  });

  it('getLoadedSinks() returns empty array', async () => {
    expect(manager.getLoadedSinks()).toEqual([]);
  });

  it('startWatching() does not throw', () => {
    expect(() => manager.startWatching()).not.toThrow();
  });

  it('stopWatching() resolves without error', async () => {
    await expect(manager.stopWatching()).resolves.toBeUndefined();
  });

  it('reloadPlugin() returns undefined', async () => {
    const result = await manager.reloadPlugin('test-plugin.js');
    expect(result).toBeUndefined();
  });

  it('unloadPlugin() resolves without error', async () => {
    await expect(manager.unloadPlugin('test-plugin.js')).resolves.toBeUndefined();
  });
});
