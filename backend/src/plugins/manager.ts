/**
 * PluginManager — loads and hot-reloads LogSink plugins from the filesystem.
 *
 * Plugin files live in `<workspacePath>/plugins/sinks/` and export a class (as
 * a default or named `Sink` export) that implements the LogSink interface.
 *
 * Lifecycle:
 *   1. Call `loadAll()` once at startup to scan the directory and import every
 *      `.ts` / `.js` file it finds.
 *   2. Call `startWatching()` to hot-reload plugins when files change on disk.
 *   3. Call `stopWatching()` to close the chokidar watcher (e.g. on shutdown).
 *
 * Error boundaries:
 *   Every call to a plugin's `write()` or `close()` is wrapped in try/catch.
 *   Errors are logged at error level but the plugin is NOT unloaded — transient
 *   errors should not permanently remove a sink from the pipeline.
 *
 * Content-hash deduplication (CON-04 / AC-F3):
 *   Before reloading a changed file the manager computes a SHA-256 hash of its
 *   content. If the hash matches the cached value the reload is skipped to avoid
 *   unnecessary churn on no-op editor saves.
 *
 * Credential resolution (AC-F4):
 *   If a plugin config file (same filename + `.config.json`) exists alongside the
 *   plugin, its string values are run through `resolveSecretsTemplate()` using the
 *   secrets map supplied at construction time.
 *
 * INV-08: Plugins are team-scoped local copies loaded from the workspace.
 * INV-09: Error policy (transient vs permanent) lives here; plugin business logic
 *         stays in the plugin files themselves.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { FSWatcher } from 'chokidar';
import type { LogSink, PluginManager as IPluginManager } from '../domain/interfaces.js';
import { resolveSecretsTemplatesInObject } from '../mcp/tools/index.js';

/** How long chokidar waits after the last change before triggering a reload (CON-04). */
const DEBOUNCE_MS = 500;

/** Supported plugin file extensions. */
const PLUGIN_EXTENSIONS = new Set(['.ts', '.js']);

/** Metadata stored alongside each loaded sink. */
interface PluginEntry {
  /** Absolute path to the plugin file. */
  pluginPath: string;
  /** SHA-256 hash of the file content at last load time. */
  contentHash: string;
  /** The wrapped (error-boundary) sink instance. */
  sink: LogSink;
}

/**
 * Resolves the plugin class from a dynamically-imported module.
 *
 * Accepts:
 *   - `module.default` — a class with `write` and `close` methods
 *   - `module.Sink`    — same
 *   - `module.default` as a plain object implementing LogSink
 */
function resolvePluginSink(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  module: Record<string, any>,
  config: Record<string, unknown>,
): LogSink | null {
  const candidates = [module['default'], module['Sink']];

  for (const candidate of candidates) {
    if (!candidate) continue;

    // Class constructor
    if (typeof candidate === 'function') {
      try {
        // Pass config as first constructor argument if provided
        const instance = Object.keys(config).length > 0
          ? new (candidate as new (cfg: Record<string, unknown>) => LogSink)(config)
          : new (candidate as new () => LogSink)();
        if (isLogSink(instance)) return instance;
      } catch {
        // Constructor failed — try next candidate
      }
    }

    // Plain object implementing LogSink
    if (typeof candidate === 'object' && isLogSink(candidate)) {
      return candidate as LogSink;
    }
  }

  return null;
}

/** Type guard: checks that the value implements LogSink. */
function isLogSink(value: unknown): value is LogSink {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>)['write'] === 'function' &&
    typeof (value as Record<string, unknown>)['close'] === 'function'
  );
}

/** Wraps a LogSink so that errors from write()/close() never propagate. */
function wrapWithErrorBoundary(
  sink: LogSink,
  pluginPath: string,
  logger: { error(msg: string, params?: Record<string, unknown>): void },
): LogSink {
  return {
    async write(entries) {
      try {
        await sink.write(entries);
      } catch (err) {
        logger.error('Plugin sink write() failed (plugin retained)', {
          plugin: pluginPath,
          error: String(err),
        });
      }
    },
    async close() {
      try {
        await sink.close();
      } catch (err) {
        logger.error('Plugin sink close() failed', {
          plugin: pluginPath,
          error: String(err),
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// PluginManagerImpl
// ---------------------------------------------------------------------------

/** Options for constructing a PluginManager. */
export interface PluginManagerOptions {
  /** Absolute path to the container workspace root. Plugins are loaded from `<workspacePath>/plugins/sinks/`. */
  workspacePath: string;
  /**
   * Resolved secrets map used for credential resolution in plugin configs (AC-F4).
   * Keys are secret names; values are the plaintext secret values.
   */
  secrets?: Record<string, string>;
  /**
   * Logger used for error-boundary logging.
   * Must provide at least `error()` and `info()`.
   */
  logger: {
    info(msg: string, params?: Record<string, unknown>): void;
    error(msg: string, params?: Record<string, unknown>): void;
  };
  /**
   * Called whenever a plugin sink is added or removed from the active set.
   * Receives the full current set of loaded sinks after the change.
   *
   * Use this to keep a live logger's sink list in sync with hot-reloaded
   * plugins (AC-F3).
   */
  onSinksChanged?: (sinks: LogSink[]) => void;
}

/**
 * Concrete implementation of the PluginManager interface.
 *
 * Instantiate once per container startup. Call `loadAll()` to scan and import
 * plugins, then `startWatching()` to enable hot-reload.
 */
export class PluginManagerImpl implements IPluginManager {
  private readonly pluginDir: string;
  private readonly secrets: Record<string, string>;
  private readonly logger: PluginManagerOptions['logger'];
  private readonly onSinksChanged: ((sinks: LogSink[]) => void) | undefined;

  /** Loaded plugin entries, keyed by absolute file path. */
  private readonly plugins = new Map<string, PluginEntry>();

  /** chokidar watcher instance; set by startWatching(), cleared by stopWatching(). */
  private watcher: FSWatcher | null = null;

  /** Pending debounce timers, keyed by absolute file path. */
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: PluginManagerOptions) {
    this.pluginDir = join(opts.workspacePath, 'plugins', 'sinks');
    this.secrets = opts.secrets ?? {};
    this.logger = opts.logger;
    this.onSinksChanged = opts.onSinksChanged;
  }

  // -------------------------------------------------------------------------
  // IPluginManager implementation
  // -------------------------------------------------------------------------

  /**
   * Scan the plugin directory and dynamically import every `.ts` / `.js` file.
   *
   * Files that fail to import or do not export a valid LogSink are logged at
   * error level and skipped; they do not prevent other plugins from loading.
   */
  async loadAll(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.pluginDir);
    } catch (err) {
      // Directory does not exist — that is fine; no plugins to load.
      this.logger.info('Plugin directory not found — skipping plugin load', {
        dir: this.pluginDir,
        error: String(err),
      });
      return;
    }

    const pluginFiles = entries.filter((name) =>
      PLUGIN_EXTENSIONS.has(extname(name)) && !name.startsWith('.')
    );

    for (const filename of pluginFiles) {
      const pluginPath = join(this.pluginDir, filename);
      await this.loadPlugin(pluginPath);
    }

    this.logger.info('Plugin load complete', {
      dir: this.pluginDir,
      loaded: this.plugins.size,
      scanned: pluginFiles.length,
    });
  }

  /**
   * Start watching the plugin directory for file additions, changes, and removals.
   *
   * Uses a 500ms debounce (CON-04) and content-hash deduplication to avoid
   * spurious reloads on no-op saves.
   *
   * Calling `startWatching()` a second time without calling `stopWatching()` is
   * a no-op — the existing watcher is retained.
   */
  startWatching(): void {
    if (this.watcher) return; // Already watching

    // Dynamic import to avoid pulling chokidar into non-watching paths.
    import('chokidar').then((chokidar) => {
      // Double-check: another call may have set watcher before the import resolved.
      if (this.watcher) return;

      const watcher = chokidar.watch(this.pluginDir, {
        ignoreInitial: true,
        persistent: false,
        usePolling: false,
      });

      watcher.on('add', (filePath: string) => this.scheduleReload(filePath));
      watcher.on('change', (filePath: string) => this.scheduleReload(filePath));
      watcher.on('unlink', (filePath: string) => this.unloadPlugin(filePath));

      this.watcher = watcher;

      this.logger.info('PluginManager watching for changes', { dir: this.pluginDir });
    }).catch((err) => {
      this.logger.error('PluginManager failed to start file watcher', {
        dir: this.pluginDir,
        error: String(err),
      });
    });
  }

  /**
   * Stop watching the plugin directory and close the chokidar watcher.
   *
   * Outstanding debounce timers are cancelled. Any already-loaded sinks remain
   * loaded until the next `loadAll()` call or process exit.
   */
  stopWatching(): void {
    // Cancel pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    if (this.watcher) {
      void this.watcher.close();
      this.watcher = null;
    }
  }

  /** Return all currently loaded LogSink instances (already wrapped in error boundaries). */
  getLoadedSinks(): LogSink[] {
    return Array.from(this.plugins.values()).map((e) => e.sink);
  }

  /**
   * Force-reload a single plugin by its absolute path.
   *
   * This is the same logic used by the chokidar watcher, exposed for testing
   * and programmatic use (e.g. an admin API endpoint).
   */
  async reloadPlugin(pluginPath: string): Promise<void> {
    await this.loadPlugin(pluginPath);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Load (or reload) a single plugin file.
   *
   * Steps:
   *   1. Read file content and compute SHA-256 hash.
   *   2. If hash matches cached value, skip (no-op save dedup).
   *   3. Close the old sink if one is loaded.
   *   4. Resolve plugin config (credential templates).
   *   5. Dynamic import() with cache-bust query string.
   *   6. Resolve LogSink from module exports.
   *   7. Wrap in error boundary and store.
   */
  private async loadPlugin(pluginPath: string): Promise<void> {
    if (!PLUGIN_EXTENSIONS.has(extname(pluginPath))) return;

    // 1. Read and hash
    let content: string;
    try {
      content = await readFile(pluginPath, 'utf8');
    } catch (err) {
      this.logger.error('Failed to read plugin file', { plugin: pluginPath, error: String(err) });
      return;
    }

    const contentHash = createHash('sha256').update(content).digest('hex');

    // 2. Dedup
    const existing = this.plugins.get(pluginPath);
    if (existing?.contentHash === contentHash) {
      this.logger.info('Plugin unchanged — skipping reload', { plugin: pluginPath });
      return;
    }

    // 3. Close old sink
    if (existing) {
      await existing.sink.close();
      this.plugins.delete(pluginPath);
    }

    // 4. Resolve config
    const config = await this.loadPluginConfig(pluginPath);

    // 5. Dynamic import with cache-bust
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let module: Record<string, any>;
    try {
      // Cache-bust by appending a timestamp query string.
      // This forces the module loader to treat each reload as a fresh import.
      module = await import(/* @vite-ignore */ `${pluginPath}?t=${Date.now()}`);
    } catch (err) {
      this.logger.error('Failed to import plugin', { plugin: pluginPath, error: String(err) });
      return;
    }

    // 6. Resolve LogSink
    const rawSink = resolvePluginSink(module, config);
    if (!rawSink) {
      this.logger.error('Plugin does not export a valid LogSink (needs write + close methods)', {
        plugin: pluginPath,
      });
      return;
    }

    // 7. Wrap and store
    const wrappedSink = wrapWithErrorBoundary(rawSink, pluginPath, this.logger);
    this.plugins.set(pluginPath, { pluginPath, contentHash, sink: wrappedSink });

    this.logger.info('Plugin loaded', { plugin: pluginPath });

    // Notify listener so the live logger can update its sink list (AC-F3)
    this.onSinksChanged?.(this.getLoadedSinks());
  }

  /**
   * Unload a plugin that has been deleted from disk.
   * Closes the sink and removes it from the registry.
   */
  private async unloadPlugin(pluginPath: string): Promise<void> {
    const entry = this.plugins.get(pluginPath);
    if (!entry) return;

    await entry.sink.close();
    this.plugins.delete(pluginPath);

    this.logger.info('Plugin unloaded (file removed)', { plugin: pluginPath });

    // Notify listener so the live logger can remove the stale sink (AC-F3)
    this.onSinksChanged?.(this.getLoadedSinks());
  }

  /**
   * Load optional per-plugin config from `<pluginFile>.config.json`.
   * Resolves `{secrets.XXX}` templates against the secrets map.
   * Returns an empty object if no config file exists.
   */
  private async loadPluginConfig(pluginPath: string): Promise<Record<string, unknown>> {
    const configPath = pluginPath + '.config.json';
    try {
      await stat(configPath);
    } catch {
      return {};
    }

    try {
      const raw = await readFile(configPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return resolveSecretsTemplatesInObject(parsed, this.secrets);
    } catch (err) {
      this.logger.error('Failed to load plugin config', {
        plugin: pluginPath,
        config: configPath,
        error: String(err),
      });
      return {};
    }
  }

  /**
   * Schedule a debounced reload for a file path (CON-04: 500ms debounce).
   * If a pending reload exists for the same path, the timer is reset.
   */
  private scheduleReload(pluginPath: string): void {
    const existing = this.debounceTimers.get(pluginPath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(pluginPath);
      this.loadPlugin(pluginPath).catch((err) => {
        this.logger.error('PluginManager scheduled reload failed', {
          plugin: pluginPath,
          error: String(err),
        });
      });
    }, DEBOUNCE_MS);

    this.debounceTimers.set(pluginPath, timer);
  }
}
