/**
 * OpenHive Backend - File Watcher
 *
 * Debounced file watching using chokidar. Listens for 'change' and 'add'
 * events on individual files and fires the registered callback after a
 * configurable debounce delay (default 200ms).
 */

import chokidar, { type FSWatcher } from 'chokidar';

// ---------------------------------------------------------------------------
// Default debounce duration (ms)
// ---------------------------------------------------------------------------

const DEFAULT_DEBOUNCE_MS = 200;

// ---------------------------------------------------------------------------
// FileWatcher
// ---------------------------------------------------------------------------

/**
 * Watches individual files for changes with debounce support.
 *
 * Usage:
 *   const fw = new FileWatcher();
 *   fw.watch('/path/to/file.yaml', () => reloadConfig());
 *   // later...
 *   await fw.stop();
 */
export class FileWatcher {
  private readonly watcher: FSWatcher;
  private readonly callbacks: Map<string, () => void>;
  private readonly timers: Map<string, ReturnType<typeof setTimeout>>;
  private readonly debounceMs: number;

  constructor(debounceMs: number = DEFAULT_DEBOUNCE_MS) {
    this.debounceMs = debounceMs;
    this.callbacks = new Map();
    this.timers = new Map();

    // persistent: false — don't keep the Node.js event loop alive just for
    // file watching.
    // ignoreInitial: true — don't fire 'add' for files already present at
    // watch start; only fire for subsequent changes.
    this.watcher = chokidar.watch([], {
      persistent: false,
      ignoreInitial: true,
    });

    // Respond to file changes and new files.
    this.watcher.on('change', (path: string) => {
      this.debouncedCallback(path);
    });

    this.watcher.on('add', (path: string) => {
      this.debouncedCallback(path);
    });
  }

  // -------------------------------------------------------------------------
  // watch
  // -------------------------------------------------------------------------

  /**
   * Registers a file path with a callback that fires (debounced) on change.
   *
   * Calling watch() a second time for the same path replaces the callback.
   * The file is added to the underlying chokidar watcher on the first call;
   * subsequent calls with the same path only update the callback.
   */
  watch(path: string, callback: () => void): void {
    const alreadyWatched = this.callbacks.has(path);
    this.callbacks.set(path, callback);

    if (!alreadyWatched) {
      this.watcher.add(path);
    }
  }

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------

  /**
   * Stops all file watching and cancels any pending debounce timers.
   *
   * Returns a Promise that resolves when the underlying chokidar watcher
   * has been closed (chokidar v4's close() is async).
   */
  async stop(): Promise<void> {
    // Cancel all pending debounce timers first.
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    await this.watcher.close();
  }

  // -------------------------------------------------------------------------
  // debouncedCallback (internal)
  // -------------------------------------------------------------------------

  /**
   * Resets the debounce timer for the given path and schedules the callback.
   */
  private debouncedCallback(path: string): void {
    const callback = this.callbacks.get(path);
    if (callback === undefined) {
      return;
    }

    // Cancel any existing pending timer for this path.
    const existing = this.timers.get(path);
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    // Schedule the callback after the debounce delay.
    const timer = setTimeout(() => {
      this.timers.delete(path);
      callback();
    }, this.debounceMs);

    this.timers.set(path, timer);
  }
}
