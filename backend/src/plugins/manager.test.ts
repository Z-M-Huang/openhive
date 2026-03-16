/**
 * Tests for PluginManagerImpl.
 *
 * Uses a temporary directory as the fake workspace so that real filesystem
 * operations (readdir, readFile, stat) exercise the actual code paths.
 * Dynamic import() is exercised against real .js files written to a temp dir.
 *
 * Coverage targets (AC-F1 through AC-F5):
 *   AC-F1: loadAll() discovers and loads plugins
 *   AC-F2: Error boundary — write() / close() errors do not propagate
 *   AC-F3: Content-hash dedup prevents spurious reloads
 *   AC-F4: Credential resolution via {secrets.XXX} templates in plugin configs
 *   AC-F5: PluginManager is a standalone module (not a stub in sinks.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginManagerImpl } from './manager.js';
import type { LogSink } from '../domain/interfaces.js';
import type { LogEntry } from '../domain/domain.js';
import { LogLevel } from '../domain/enums.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  const logs: Array<{ level: string; msg: string; params?: Record<string, unknown> }> = [];
  return {
    logs,
    info: vi.fn((msg: string, params?: Record<string, unknown>) => {
      logs.push({ level: 'info', msg, params });
    }),
    error: vi.fn((msg: string, params?: Record<string, unknown>) => {
      logs.push({ level: 'error', msg, params });
    }),
  };
}

function makeSink(overrides?: Partial<LogSink>): LogSink & { written: LogEntry[][] } {
  const written: LogEntry[][] = [];
  return {
    written,
    write: vi.fn(async (entries: LogEntry[]) => { written.push(entries); }),
    close: vi.fn(async () => {}),
    ...overrides,
  } as LogSink & { written: LogEntry[][] };
}

function makeEntry(): LogEntry {
  return {
    id: 0,
    level: LogLevel.Info,
    event_type: 'test',
    component: 'test',
    action: 'test',
    message: 'test message',
    params: '',
    team_slug: '',
    task_id: '',
    agent_aid: '',
    request_id: '',
    correlation_id: '',
    error: '',
    duration_ms: 0,
    created_at: Date.now(),
  };
}

/**
 * Write a fake plugin .js file that exports a default class implementing LogSink.
 * We use plain JS (not TS) so that the Node.js module loader can import it without
 * a transpile step.
 *
 * The test sink instance is stored in a global map keyed by the plugin's absolute
 * path. The class looks up the sink at CONSTRUCTION TIME (not module load time)
 * so that when a file is hot-reloaded with a different query string (new module
 * instance), the new instance picks up any updated sink in the global map.
 */
async function writePluginFile(
  dir: string,
  filename: string,
  sink: LogSink,
): Promise<string> {
  const filePath = join(dir, filename);

  const content = `
// Injected plugin — for tests only
export default class TestSink {
  constructor() {
    const g = globalThis;
    this._sink = g.__testSinks ? g.__testSinks.get(${JSON.stringify(filePath)}) : null;
  }
  write(entries) { return this._sink ? this._sink.write(entries) : Promise.resolve(); }
  close()        { return this._sink ? this._sink.close()        : Promise.resolve(); }
}
`;
  await writeFile(filePath, content, 'utf8');

  // Register sink in global map so the imported module can find it.
  const g = globalThis as unknown as { __testSinks: Map<string, LogSink> };
  if (!g.__testSinks) g.__testSinks = new Map();
  g.__testSinks.set(filePath, sink);

  return filePath;
}

/** Remove a test sink from the global map. */
function cleanupSink(filePath: string): void {
  const g = globalThis as unknown as { __testSinks?: Map<string, LogSink> };
  g.__testSinks?.delete(filePath);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let workspaceRoot: string;
let pluginDir: string;
let logger: ReturnType<typeof makeLogger>;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'ohive-plugin-test-'));
  pluginDir = join(workspaceRoot, 'plugins', 'sinks');
  await mkdir(pluginDir, { recursive: true });
  logger = makeLogger();
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PluginManagerImpl', () => {
  // -------------------------------------------------------------------------
  // Interface compliance (AC-F5)
  // -------------------------------------------------------------------------

  describe('interface compliance', () => {
    it('exports PluginManagerImpl class', () => {
      expect(typeof PluginManagerImpl).toBe('function');
    });

    it('implements all PluginManager interface methods', () => {
      const mgr = new PluginManagerImpl({ workspacePath: workspaceRoot, logger });
      expect(typeof mgr.loadAll).toBe('function');
      expect(typeof mgr.startWatching).toBe('function');
      expect(typeof mgr.stopWatching).toBe('function');
      expect(typeof mgr.getLoadedSinks).toBe('function');
      expect(typeof mgr.reloadPlugin).toBe('function');
    });
  });

  // -------------------------------------------------------------------------
  // loadAll — AC-F1
  // -------------------------------------------------------------------------

  describe('loadAll()', () => {
    it('resolves successfully when plugin directory does not exist', async () => {
      const emptyWorkspace = await mkdtemp(join(tmpdir(), 'ohive-empty-'));
      try {
        const mgr = new PluginManagerImpl({ workspacePath: emptyWorkspace, logger });
        await expect(mgr.loadAll()).resolves.toBeUndefined();
        expect(mgr.getLoadedSinks()).toHaveLength(0);
      } finally {
        await rm(emptyWorkspace, { recursive: true, force: true });
      }
    });

    it('loads zero sinks when plugin directory is empty', async () => {
      const mgr = new PluginManagerImpl({ workspacePath: workspaceRoot, logger });
      await mgr.loadAll();
      expect(mgr.getLoadedSinks()).toHaveLength(0);
    });

    it('loads a single .js plugin and exposes it via getLoadedSinks()', async () => {
      const sink = makeSink();
      const filePath = await writePluginFile(pluginDir, 'my-sink.js', sink);

      try {
        const mgr = new PluginManagerImpl({ workspacePath: workspaceRoot, logger });
        await mgr.loadAll();

        expect(mgr.getLoadedSinks()).toHaveLength(1);
      } finally {
        cleanupSink(filePath);
      }
    });

    it('loads multiple plugins from the directory', async () => {
      const sink1 = makeSink();
      const sink2 = makeSink();
      const path1 = await writePluginFile(pluginDir, 'sink-a.js', sink1);
      const path2 = await writePluginFile(pluginDir, 'sink-b.js', sink2);

      try {
        const mgr = new PluginManagerImpl({ workspacePath: workspaceRoot, logger });
        await mgr.loadAll();

        expect(mgr.getLoadedSinks()).toHaveLength(2);
      } finally {
        cleanupSink(path1);
        cleanupSink(path2);
      }
    });

    it('ignores files without .ts/.js extension', async () => {
      await writeFile(join(pluginDir, 'README.md'), '# not a plugin');
      await writeFile(join(pluginDir, 'config.json'), '{}');
      await writeFile(join(pluginDir, 'plugin.txt'), 'not js');

      const mgr = new PluginManagerImpl({ workspacePath: workspaceRoot, logger });
      await mgr.loadAll();
      expect(mgr.getLoadedSinks()).toHaveLength(0);
    });

    it('skips dot-files', async () => {
      await writeFile(join(pluginDir, '.hidden.js'), 'export default {}');

      const mgr = new PluginManagerImpl({ workspacePath: workspaceRoot, logger });
      await mgr.loadAll();
      expect(mgr.getLoadedSinks()).toHaveLength(0);
    });

    it('logs an error and skips a plugin that cannot be imported', async () => {
      // Invalid JS that will throw on dynamic import
      await writeFile(join(pluginDir, 'bad-plugin.js'), 'INVALID JAVASCRIPT !!!');

      const mgr = new PluginManagerImpl({ workspacePath: workspaceRoot, logger });
      await mgr.loadAll();

      expect(mgr.getLoadedSinks()).toHaveLength(0);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('import'),
        expect.objectContaining({ plugin: expect.stringContaining('bad-plugin.js') }),
      );
    });

    it('logs an error and skips a plugin with no valid LogSink export', async () => {
      // File imports fine but exports nothing that qualifies as a LogSink
      await writeFile(
        join(pluginDir, 'no-sink.js'),
        'export const value = 42; export default { notASink: true };',
      );

      const mgr = new PluginManagerImpl({ workspacePath: workspaceRoot, logger });
      await mgr.loadAll();

      expect(mgr.getLoadedSinks()).toHaveLength(0);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('valid LogSink'),
        expect.objectContaining({ plugin: expect.stringContaining('no-sink.js') }),
      );
    });

    it('a failed plugin does not prevent other plugins from loading', async () => {
      await writeFile(join(pluginDir, 'bad-plugin.js'), 'INVALID JAVASCRIPT !!!');
      const sink = makeSink();
      const goodPath = await writePluginFile(pluginDir, 'good-sink.js', sink);

      try {
        const mgr = new PluginManagerImpl({ workspacePath: workspaceRoot, logger });
        await mgr.loadAll();

        expect(mgr.getLoadedSinks()).toHaveLength(1);
      } finally {
        cleanupSink(goodPath);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Error boundaries — AC-F2
  // -------------------------------------------------------------------------

  describe('error boundaries', () => {
    it('write() error from plugin is caught and logged — host does not throw', async () => {
      const throwingSink = makeSink({
        write: vi.fn(async () => { throw new Error('write explosion'); }),
      });
      const filePath = await writePluginFile(pluginDir, 'throwing-sink.js', throwingSink);

      try {
        const mgr = new PluginManagerImpl({ workspacePath: workspaceRoot, logger });
        await mgr.loadAll();

        const sinks = mgr.getLoadedSinks();
        expect(sinks).toHaveLength(1);

        // Should resolve (not throw)
        await expect(sinks[0]!.write([makeEntry()])).resolves.toBeUndefined();

        // Error must be logged
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining('write()'),
          expect.objectContaining({ plugin: filePath }),
        );
      } finally {
        cleanupSink(filePath);
      }
    });

    it('plugin is NOT unloaded after a write() error (transient error policy)', async () => {
      const throwingSink = makeSink({
        write: vi.fn(async () => { throw new Error('transient error'); }),
      });
      const filePath = await writePluginFile(pluginDir, 'transient-sink.js', throwingSink);

      try {
        const mgr = new PluginManagerImpl({ workspacePath: workspaceRoot, logger });
        await mgr.loadAll();

        const sinks = mgr.getLoadedSinks();
        await sinks[0]!.write([makeEntry()]);

        // Plugin must still be registered after the error
        expect(mgr.getLoadedSinks()).toHaveLength(1);
      } finally {
        cleanupSink(filePath);
      }
    });

    it('close() error from plugin is caught and logged — host does not throw', async () => {
      const throwingSink = makeSink({
        close: vi.fn(async () => { throw new Error('close explosion'); }),
      });
      const filePath = await writePluginFile(pluginDir, 'close-throw-sink.js', throwingSink);

      try {
        const mgr = new PluginManagerImpl({ workspacePath: workspaceRoot, logger });
        await mgr.loadAll();

        const sinks = mgr.getLoadedSinks();
        expect(sinks).toHaveLength(1);

        await expect(sinks[0]!.close()).resolves.toBeUndefined();

        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining('close()'),
          expect.objectContaining({ plugin: filePath }),
        );
      } finally {
        cleanupSink(filePath);
      }
    });

    it('write() on a loaded sink delegates to the underlying plugin implementation', async () => {
      const sink = makeSink();
      const filePath = await writePluginFile(pluginDir, 'delegate-sink.js', sink);

      try {
        const mgr = new PluginManagerImpl({ workspacePath: workspaceRoot, logger });
        await mgr.loadAll();

        const entries = [makeEntry()];
        await mgr.getLoadedSinks()[0]!.write(entries);

        expect(sink.write).toHaveBeenCalledWith(entries);
      } finally {
        cleanupSink(filePath);
      }
    });
  });

  // -------------------------------------------------------------------------
  // reloadPlugin — AC-F3 content-hash dedup
  // -------------------------------------------------------------------------

  describe('reloadPlugin()', () => {
    it('loads a plugin that was not previously known', async () => {
      const sink = makeSink();
      const filePath = await writePluginFile(pluginDir, 'new-sink.js', sink);

      try {
        const mgr = new PluginManagerImpl({ workspacePath: workspaceRoot, logger });
        // Intentionally skip loadAll()
        await mgr.reloadPlugin(filePath);

        expect(mgr.getLoadedSinks()).toHaveLength(1);
      } finally {
        cleanupSink(filePath);
      }
    });

    it('is a no-op when file content has not changed (content-hash dedup)', async () => {
      const sink = makeSink();
      const filePath = await writePluginFile(pluginDir, 'stable-sink.js', sink);

      try {
        const mgr = new PluginManagerImpl({ workspacePath: workspaceRoot, logger });
        await mgr.loadAll();

        // Second reload with identical content
        await mgr.reloadPlugin(filePath);

        // Still exactly one sink
        expect(mgr.getLoadedSinks()).toHaveLength(1);
        expect(logger.info).toHaveBeenCalledWith(
          expect.stringContaining('unchanged'),
          expect.objectContaining({ plugin: filePath }),
        );
      } finally {
        cleanupSink(filePath);
      }
    });

    it('replaces old sink after content changes', async () => {
      const sink1 = makeSink();
      const filePath = await writePluginFile(pluginDir, 'changing-sink.js', sink1);

      try {
        const mgr = new PluginManagerImpl({ workspacePath: workspaceRoot, logger });
        await mgr.loadAll();

        // Swap the backing sink and modify the file content so the hash changes
        const sink2 = makeSink();
        const g = globalThis as unknown as { __testSinks: Map<string, LogSink> };
        g.__testSinks.set(filePath, sink2);

        const oldContent = await readFile(filePath, 'utf8');
        await writeFile(filePath, oldContent + '\n// version 2', 'utf8');

        await mgr.reloadPlugin(filePath);

        // Old sink must have been closed
        expect(sink1.close).toHaveBeenCalled();

        // New sink is now active
        expect(mgr.getLoadedSinks()).toHaveLength(1);
        await mgr.getLoadedSinks()[0]!.write([makeEntry()]);
        expect(sink2.write).toHaveBeenCalled();
      } finally {
        cleanupSink(filePath);
      }
    });

    it('silently ignores paths with non-plugin extensions', async () => {
      const mgr = new PluginManagerImpl({ workspacePath: workspaceRoot, logger });
      await expect(mgr.reloadPlugin('/some/file.txt')).resolves.toBeUndefined();
      expect(mgr.getLoadedSinks()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Credential resolution — AC-F4
  // -------------------------------------------------------------------------

  describe('credential resolution (AC-F4)', () => {
    it('resolves {secrets.XXX} templates in plugin config', async () => {
      const receivedConfigs: Record<string, unknown>[] = [];
      const pluginPath = join(pluginDir, 'config-sink.js');

      const source = `
const g = globalThis;
if (!g.__testSinks) g.__testSinks = new Map();
export default class ConfigSink {
  constructor(config) {
    const store = g.__testSinks.get(${JSON.stringify(pluginPath)});
    if (store && store.onConstruct) store.onConstruct(config);
  }
  write() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}
`;
      await writeFile(pluginPath, source, 'utf8');

      // Config file uses template placeholders
      const rawConfig = {
        endpoint: 'https://{secrets.LOG_HOST}/ingest',
        apiToken: '{secrets.LOG_API_TOKEN}',
      };
      await writeFile(pluginPath + '.config.json', JSON.stringify(rawConfig), 'utf8');

      const g = globalThis as unknown as {
        __testSinks: Map<string, { onConstruct: (c: Record<string, unknown>) => void }>;
      };
      if (!g.__testSinks) g.__testSinks = new Map();
      g.__testSinks.set(pluginPath, {
        onConstruct: (config: Record<string, unknown>) => { receivedConfigs.push(config); },
      });

      const secrets = { LOG_HOST: 'logs.example.com', LOG_API_TOKEN: 'test-bearer-value' };

      const mgr = new PluginManagerImpl({ workspacePath: workspaceRoot, secrets, logger });
      await mgr.loadAll();

      expect(mgr.getLoadedSinks()).toHaveLength(1);
      expect(receivedConfigs).toHaveLength(1);
      expect(receivedConfigs[0]).toEqual({
        endpoint: 'https://logs.example.com/ingest',
        apiToken: 'test-bearer-value',
      });

      cleanupSink(pluginPath);
    });

    it('passes numeric config values through unchanged', async () => {
      const receivedConfigs: Record<string, unknown>[] = [];
      const pluginPath = join(pluginDir, 'plain-config-sink.js');

      const source = `
const g = globalThis;
if (!g.__testSinks) g.__testSinks = new Map();
export default class PlainConfigSink {
  constructor(config) {
    const store = g.__testSinks.get(${JSON.stringify(pluginPath)});
    if (store && store.onConstruct) store.onConstruct(config);
  }
  write() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}
`;
      await writeFile(pluginPath, source, 'utf8');
      await writeFile(pluginPath + '.config.json', JSON.stringify({ timeout: 5000 }), 'utf8');

      const g = globalThis as unknown as {
        __testSinks: Map<string, { onConstruct: (c: Record<string, unknown>) => void }>;
      };
      if (!g.__testSinks) g.__testSinks = new Map();
      g.__testSinks.set(pluginPath, {
        onConstruct: (c: Record<string, unknown>) => { receivedConfigs.push(c); },
      });

      const mgr = new PluginManagerImpl({ workspacePath: workspaceRoot, logger });
      await mgr.loadAll();

      expect(receivedConfigs[0]).toEqual({ timeout: 5000 });

      cleanupSink(pluginPath);
    });

    it('loads plugin without errors when no config file exists', async () => {
      const sink = makeSink();
      const filePath = await writePluginFile(pluginDir, 'no-config-sink.js', sink);

      try {
        const mgr = new PluginManagerImpl({
          workspacePath: workspaceRoot,
          secrets: { SOME_KEY: 'some-value' },
          logger,
        });
        await mgr.loadAll();

        expect(mgr.getLoadedSinks()).toHaveLength(1);
        expect(logger.error).not.toHaveBeenCalled();
      } finally {
        cleanupSink(filePath);
      }
    });
  });

  // -------------------------------------------------------------------------
  // startWatching / stopWatching
  // -------------------------------------------------------------------------

  describe('startWatching() / stopWatching()', () => {
    it('stopWatching() is safe to call before startWatching()', () => {
      const mgr = new PluginManagerImpl({ workspacePath: workspaceRoot, logger });
      expect(() => mgr.stopWatching()).not.toThrow();
    });

    it('startWatching() is idempotent — second call does not create a second watcher', async () => {
      const mgr = new PluginManagerImpl({ workspacePath: workspaceRoot, logger });
      mgr.startWatching();
      // Allow the async chokidar import to settle
      await new Promise((r) => setTimeout(r, 50));
      expect(() => mgr.startWatching()).not.toThrow();
      mgr.stopWatching();
    });

    it('stopWatching() after startWatching() does not throw', async () => {
      const mgr = new PluginManagerImpl({ workspacePath: workspaceRoot, logger });
      mgr.startWatching();
      await new Promise((r) => setTimeout(r, 50));
      expect(() => mgr.stopWatching()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // getLoadedSinks
  // -------------------------------------------------------------------------

  describe('getLoadedSinks()', () => {
    it('returns empty array before loadAll()', () => {
      const mgr = new PluginManagerImpl({ workspacePath: workspaceRoot, logger });
      expect(mgr.getLoadedSinks()).toEqual([]);
    });

    it('returns a snapshot — mutating it does not affect internal state', async () => {
      const sink = makeSink();
      const filePath = await writePluginFile(pluginDir, 'snapshot-sink.js', sink);

      try {
        const mgr = new PluginManagerImpl({ workspacePath: workspaceRoot, logger });
        await mgr.loadAll();

        const sinks = mgr.getLoadedSinks();
        sinks.pop(); // Mutate the returned array

        // Internal state must be unaffected
        expect(mgr.getLoadedSinks()).toHaveLength(1);
      } finally {
        cleanupSink(filePath);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Named Sink export alternative
  // -------------------------------------------------------------------------

  describe('named Sink export', () => {
    it('accepts a named export "Sink" in addition to default', async () => {
      const sink = makeSink();
      const filePath = join(pluginDir, 'named-sink.js');

      const content = `
const g = globalThis;
if (!g.__testSinks) g.__testSinks = new Map();
const _sink = g.__testSinks.get(${JSON.stringify(filePath)});

export class Sink {
  write(entries) { return _sink ? _sink.write(entries) : Promise.resolve(); }
  close()        { return _sink ? _sink.close()        : Promise.resolve(); }
}
`;
      await writeFile(filePath, content, 'utf8');

      const g = globalThis as unknown as { __testSinks: Map<string, LogSink> };
      if (!g.__testSinks) g.__testSinks = new Map();
      g.__testSinks.set(filePath, sink);

      try {
        const mgr = new PluginManagerImpl({ workspacePath: workspaceRoot, logger });
        await mgr.loadAll();

        expect(mgr.getLoadedSinks()).toHaveLength(1);
      } finally {
        cleanupSink(filePath);
      }
    });
  });
});
