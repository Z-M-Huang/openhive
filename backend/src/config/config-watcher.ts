/**
 * File watching for config hot-reload with debounce and content-hash dedup.
 *
 * @module config/config-watcher
 */

import { readFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'chokidar';
import { contentHash } from './config-utils.js';

/** State for the config watcher: timers, watchers, and content hashes. */
export interface WatcherState {
  watchers: FSWatcher[];
  debounceTimers: ReturnType<typeof setTimeout>[];
  hashes: Map<string, string>;
}

/**
 * Create a new empty watcher state.
 */
export function createWatcherState(): WatcherState {
  return {
    watchers: [],
    debounceTimers: [],
    hashes: new Map(),
  };
}

/**
 * Watches a single file for changes with 500ms debounce (CON-04) and
 * content-hash deduplication.
 */
export function watchFile(
  state: WatcherState,
  filePath: string,
  onChange: () => Promise<void>,
): void {
  const watcher = watch(filePath, {
    persistent: true,
    ignoreInitial: true,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;

  watcher.on('change', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      // Content-hash check
      try {
        const raw = await readFile(filePath, 'utf-8');
        const hash = contentHash(raw);
        const prevHash = state.hashes.get(filePath);
        if (prevHash === hash) return; // No-op: content unchanged
        state.hashes.set(filePath, hash);
        await onChange();
      } catch {
        // File may have been deleted
      }
    }, 500); // CON-04: 500ms debounce

    if (timer) state.debounceTimers.push(timer);
  });

  state.watchers.push(watcher);
}

/**
 * Stop all watchers and clear timers.
 */
export function stopWatching(state: WatcherState): void {
  for (const timer of state.debounceTimers) {
    clearTimeout(timer);
  }
  state.debounceTimers = [];
  for (const watcher of state.watchers) {
    void watcher.close();
  }
  state.watchers = [];
  state.hashes.clear();
}
