/**
 * Structural tests for domain interfaces.
 *
 * These tests verify that the interface shapes are correct by creating
 * conforming test doubles via vi.fn(). TypeScript enforces structural
 * compatibility at compile time; the runtime tests confirm the interfaces
 * are importable and the expected members exist on conforming objects.
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  TokenManager,
  DispatchTracker,
  PluginManager,
  ConfigLoader,
  LogSink,
} from './interfaces.js';
import type { LogEntry } from './domain.js';

// ---------------------------------------------------------------------------
// TokenManager — session extension
// ---------------------------------------------------------------------------

describe('TokenManager interface', () => {
  it('has the original one-time token methods', () => {
    const tm: TokenManager = {
      generate: vi.fn().mockReturnValue('one-time-token'),
      validate: vi.fn().mockReturnValue(true),
      revoke: vi.fn(),
      revokeAll: vi.fn(),
      startCleanup: vi.fn(),
      stopCleanup: vi.fn(),
      generateSession: vi.fn().mockReturnValue('session-token'),
      validateSession: vi.fn().mockReturnValue(true),
      revokeSessionsForTid: vi.fn(),
      revokeSession: vi.fn(),
    };

    expect(tm.generate('tid-root-abc')).toBe('one-time-token');
    expect(tm.validate('token', 'tid-root-abc')).toBe(true);
  });

  it('generateSession returns a token string', () => {
    const tm: TokenManager = {
      generate: vi.fn(),
      validate: vi.fn(),
      revoke: vi.fn(),
      revokeAll: vi.fn(),
      startCleanup: vi.fn(),
      stopCleanup: vi.fn(),
      generateSession: vi.fn().mockReturnValue('sess-abc123'),
      validateSession: vi.fn().mockReturnValue(true),
      revokeSessionsForTid: vi.fn(),
      revokeSession: vi.fn(),
    };

    const token = tm.generateSession('tid-team-abc');
    expect(typeof token).toBe('string');
    expect(token).toBe('sess-abc123');
  });

  it('validateSession returns boolean', () => {
    const tm: TokenManager = {
      generate: vi.fn(),
      validate: vi.fn(),
      revoke: vi.fn(),
      revokeAll: vi.fn(),
      startCleanup: vi.fn(),
      stopCleanup: vi.fn(),
      generateSession: vi.fn(),
      validateSession: vi.fn().mockReturnValue(false),
      revokeSessionsForTid: vi.fn(),
      revokeSession: vi.fn(),
    };

    expect(tm.validateSession('stale-token', 'tid-team-abc')).toBe(false);
  });

  it('revokeSessionsForTid accepts a tid string', () => {
    const revoke = vi.fn();
    const tm: TokenManager = {
      generate: vi.fn(),
      validate: vi.fn(),
      revoke: vi.fn(),
      revokeAll: vi.fn(),
      startCleanup: vi.fn(),
      stopCleanup: vi.fn(),
      generateSession: vi.fn(),
      validateSession: vi.fn(),
      revokeSessionsForTid: revoke,
      revokeSession: vi.fn(),
    };

    tm.revokeSessionsForTid('tid-team-abc');
    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('tid-team-abc');
  });

  it('revokeSessionsForTid is idempotent (can be called multiple times)', () => {
    const revoke = vi.fn();
    const tm: TokenManager = {
      generate: vi.fn(),
      validate: vi.fn(),
      revoke: vi.fn(),
      revokeAll: vi.fn(),
      startCleanup: vi.fn(),
      stopCleanup: vi.fn(),
      generateSession: vi.fn(),
      validateSession: vi.fn(),
      revokeSessionsForTid: revoke,
      revokeSession: vi.fn(),
    };

    tm.revokeSessionsForTid('tid-team-abc');
    tm.revokeSessionsForTid('tid-team-abc');
    expect(revoke).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// DispatchTracker interface
// ---------------------------------------------------------------------------

describe('DispatchTracker interface', () => {
  const makeTracker = (): DispatchTracker => ({
    trackDispatch: vi.fn(),
    acknowledgeDispatch: vi.fn(),
    getUnacknowledged: vi.fn().mockReturnValue([]),
    getUnacknowledgedByAgent: vi.fn().mockReturnValue([]),
    transferOwnership: vi.fn().mockReturnValue(0),
    isTracked: vi.fn().mockReturnValue(false),
    start: vi.fn(),
    stop: vi.fn(),
  });

  it('trackDispatch accepts taskId, tid, and agentAid', () => {
    const tracker = makeTracker();
    tracker.trackDispatch('task-001', 'tid-team-abc', 'aid-agent-0001');
    expect(tracker.trackDispatch).toHaveBeenCalledWith('task-001', 'tid-team-abc', 'aid-agent-0001');
  });

  it('acknowledgeDispatch accepts taskId', () => {
    const tracker = makeTracker();
    tracker.acknowledgeDispatch('task-001');
    expect(tracker.acknowledgeDispatch).toHaveBeenCalledWith('task-001');
  });

  it('getUnacknowledged returns string array for a tid', () => {
    const getUnacknowledged = vi.fn().mockReturnValue(['task-001', 'task-002']);
    const tracker: DispatchTracker = {
      trackDispatch: vi.fn(),
      acknowledgeDispatch: vi.fn(),
      getUnacknowledged,
      getUnacknowledgedByAgent: vi.fn().mockReturnValue([]),
      transferOwnership: vi.fn().mockReturnValue(0),
      isTracked: vi.fn().mockReturnValue(false),
      start: vi.fn(),
      stop: vi.fn(),
    };

    const result = tracker.getUnacknowledged('tid-team-abc');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(['task-001', 'task-002']);
  });

  it('start and stop lifecycle methods exist', () => {
    const tracker = makeTracker();
    tracker.start();
    tracker.stop();
    expect(tracker.start).toHaveBeenCalledOnce();
    expect(tracker.stop).toHaveBeenCalledOnce();
  });

  it('returns empty array for tid with no unacknowledged dispatches', () => {
    const tracker = makeTracker();
    expect(tracker.getUnacknowledged('tid-unknown')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PluginManager interface
// ---------------------------------------------------------------------------

describe('PluginManager interface', () => {
  const makeSink = (): LogSink => ({
    write: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  });

  const makePluginManager = (sinks: LogSink[] = []): PluginManager => ({
    loadAll: vi.fn().mockResolvedValue(undefined),
    startWatching: vi.fn(),
    stopWatching: vi.fn(),
    getLoadedSinks: vi.fn().mockReturnValue(sinks),
    reloadPlugin: vi.fn().mockResolvedValue(undefined),
  });

  it('loadAll is async (returns Promise)', async () => {
    const pm = makePluginManager();
    await expect(pm.loadAll()).resolves.toBeUndefined();
  });

  it('startWatching and stopWatching are synchronous lifecycle methods', () => {
    const pm = makePluginManager();
    pm.startWatching();
    pm.stopWatching();
    expect(pm.startWatching).toHaveBeenCalledOnce();
    expect(pm.stopWatching).toHaveBeenCalledOnce();
  });

  it('getLoadedSinks returns LogSink array', () => {
    const sink = makeSink();
    const pm = makePluginManager([sink]);
    const sinks = pm.getLoadedSinks();
    expect(Array.isArray(sinks)).toBe(true);
    expect(sinks).toHaveLength(1);
    expect(sinks[0]).toBe(sink);
  });

  it('getLoadedSinks returns empty array when no plugins loaded', () => {
    const pm = makePluginManager([]);
    expect(pm.getLoadedSinks()).toEqual([]);
  });

  it('reloadPlugin accepts an absolute path and is async', async () => {
    const pm = makePluginManager();
    await expect(pm.reloadPlugin('/app/workspace/plugins/sinks/my-sink.js')).resolves.toBeUndefined();
    expect(pm.reloadPlugin).toHaveBeenCalledWith('/app/workspace/plugins/sinks/my-sink.js');
  });

  it('returned LogSink instances have write and close methods', async () => {
    const sink = makeSink();
    const pm = makePluginManager([sink]);
    const [loaded] = pm.getLoadedSinks();
    const entries: LogEntry[] = [];
    await loaded.write(entries);
    await loaded.close();
    expect(sink.write).toHaveBeenCalledWith(entries);
    expect(sink.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// ConfigLoader.getConfigWithSources
// ---------------------------------------------------------------------------

describe('ConfigLoader.getConfigWithSources', () => {
  it('returns a record with value, source, and optional isSecret fields', async () => {
    const mockResult: Record<string, { value: unknown; source: 'default' | 'yaml' | 'env'; isSecret?: boolean }> = {
      'limits.max_depth': { value: 3, source: 'default' },
      'limits.max_teams': { value: 10, source: 'yaml' },
      'channels.discord.token': { value: '***', source: 'env', isSecret: true },
    };

    const loader: Partial<ConfigLoader> & { getConfigWithSources: ConfigLoader['getConfigWithSources'] } = {
      getConfigWithSources: vi.fn().mockResolvedValue(mockResult),
    } as unknown as ConfigLoader & { getConfigWithSources: ConfigLoader['getConfigWithSources'] };

    const result = await loader.getConfigWithSources();
    expect(result).toBe(mockResult);

    const depthEntry = result['limits.max_depth'];
    expect(depthEntry).toBeDefined();
    expect(depthEntry.value).toBe(3);
    expect(depthEntry.source).toBe('default');
    expect(depthEntry.isSecret).toBeUndefined();

    const tokenEntry = result['channels.discord.token'];
    expect(tokenEntry.source).toBe('env');
    expect(tokenEntry.isSecret).toBe(true);
  });

  it('source is one of default | yaml | env', async () => {
    const validSources: Array<'default' | 'yaml' | 'env'> = ['default', 'yaml', 'env'];
    const mockResult: Record<string, { value: unknown; source: 'default' | 'yaml' | 'env' }> = {
      'a': { value: 1, source: 'default' },
      'b': { value: 2, source: 'yaml' },
      'c': { value: 3, source: 'env' },
    };

    const loader = {
      getConfigWithSources: vi.fn().mockResolvedValue(mockResult),
    } as unknown as ConfigLoader;

    const result = await loader.getConfigWithSources();
    for (const entry of Object.values(result)) {
      expect(validSources).toContain(entry.source);
    }
  });

  it('can return empty record (no config fields)', async () => {
    const loader = {
      getConfigWithSources: vi.fn().mockResolvedValue({}),
    } as unknown as ConfigLoader;

    const result = await loader.getConfigWithSources();
    expect(result).toEqual({});
  });
});
