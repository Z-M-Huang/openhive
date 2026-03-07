/**
 * Tests for backend/src/config/watcher.ts
 *
 * Covers FileWatcher: watch callback triggering, debounce behaviour, stop
 * cleanup, and multiple simultaneous file watches.
 *
 * Strategy:
 *   - Write to real temp files so chokidar detects genuine filesystem events.
 *   - Use vitest fake timers to control debounce delays deterministically.
 *   - waitForCallbackRegistration() gives chokidar time to register paths
 *     before writing (avoids race conditions with inotify setup).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FileWatcher } from './watcher.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a temp directory and returns path + cleanup function. */
function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'openhive-watcher-test-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Waits for chokidar to register the path with the OS-level watch API.
 * Chokidar's 'ready' event fires after all initial paths are registered.
 * We wait for it before triggering file writes in tests.
 */
function waitForReady(fw: FileWatcher): Promise<void> {
  return new Promise((resolve) => {
    // Access the underlying watcher via the private field for test purposes.
    const watcher = (fw as unknown as { watcher: { once: (event: string, cb: () => void) => void } }).watcher;
    watcher.once('ready', resolve);
  });
}

/**
 * Waits a short real-time delay to let the OS deliver inotify events to
 * chokidar. Fake timers do not advance real I/O; a brief real wait is needed
 * between the file write and the fake-timer advance that triggers callbacks.
 */
function waitForEvent(ms = 150): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileWatcher', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = makeTmpDir());
  });

  afterEach(async () => {
    // Restore real timers after each test (vi.useFakeTimers tests must
    // restore before the watcher.stop() await, otherwise the close Promise
    // may never resolve if it relies on microtasks with fake timers active).
    vi.useRealTimers();
    cleanup();
  });

  // -------------------------------------------------------------------------
  // Basic watch + callback
  // -------------------------------------------------------------------------

  it('calls the callback when a watched file changes', async () => {
    const fw = new FileWatcher(50);
    const filePath = join(dir, 'config.yaml');
    writeFileSync(filePath, 'initial: true');

    const callback = vi.fn();
    fw.watch(filePath, callback);

    await waitForReady(fw);

    appendFileSync(filePath, '\nchanged: true');

    // Wait for the OS to deliver the event, then for the debounce to fire.
    await waitForEvent(200);

    expect(callback).toHaveBeenCalledTimes(1);

    await fw.stop();
  });

  // -------------------------------------------------------------------------
  // Debounce — rapid writes collapse into a single callback
  // -------------------------------------------------------------------------

  it('debounce prevents multiple rapid callbacks from firing separately', async () => {
    vi.useFakeTimers();

    const debounceMs = 200;
    const fw = new FileWatcher(debounceMs);
    const filePath = join(dir, 'debounce.yaml');
    writeFileSync(filePath, 'v0');

    const callback = vi.fn();
    fw.watch(filePath, callback);

    // Restore real timers briefly to let chokidar register the path.
    vi.useRealTimers();
    await waitForReady(fw);
    vi.useFakeTimers();

    // Trigger the chokidar 'change' event directly by calling the private
    // method, bypassing the real filesystem write (which real timers would
    // need). This tests the debounce logic in isolation.
    const watcher = fw as unknown as {
      debouncedCallback: (path: string) => void;
    };

    // Fire 5 rapid changes.
    for (let i = 0; i < 5; i++) {
      watcher.debouncedCallback(filePath);
    }

    // Callback must not have fired yet (debounce pending).
    expect(callback).not.toHaveBeenCalled();

    // Advance time past the debounce window.
    vi.advanceTimersByTime(debounceMs + 10);

    // Only one callback should have fired despite 5 rapid changes.
    expect(callback).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
    await fw.stop();
  });

  // -------------------------------------------------------------------------
  // Stop — closes watcher and cancels pending timers
  // -------------------------------------------------------------------------

  it('stop closes the watcher and cancels any pending debounce timer', async () => {
    vi.useFakeTimers();

    const debounceMs = 200;
    const fw = new FileWatcher(debounceMs);
    const filePath = join(dir, 'stop.yaml');
    writeFileSync(filePath, 'initial');

    const callback = vi.fn();
    fw.watch(filePath, callback);

    vi.useRealTimers();
    await waitForReady(fw);
    vi.useFakeTimers();

    // Trigger a debounce but don't advance time (callback still pending).
    const watcher = fw as unknown as {
      debouncedCallback: (path: string) => void;
      timers: Map<string, ReturnType<typeof setTimeout>>;
    };
    watcher.debouncedCallback(filePath);

    expect(watcher.timers.size).toBe(1);

    // Stop before the timer fires.
    vi.useRealTimers();
    await fw.stop();
    vi.useFakeTimers();

    // Timers map cleared after stop.
    expect(watcher.timers.size).toBe(0);

    // Callback was never called.
    expect(callback).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('stop resolves even when no files are watched', async () => {
    const fw = new FileWatcher();
    await expect(fw.stop()).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Multiple files watched simultaneously
  // -------------------------------------------------------------------------

  it('watches multiple files simultaneously and calls the correct callbacks', async () => {
    const fw = new FileWatcher(50);

    const file1 = join(dir, 'file1.yaml');
    const file2 = join(dir, 'file2.yaml');
    writeFileSync(file1, 'f1v0');
    writeFileSync(file2, 'f2v0');

    const cb1 = vi.fn();
    const cb2 = vi.fn();
    fw.watch(file1, cb1);
    fw.watch(file2, cb2);

    await waitForReady(fw);

    // Modify only file2.
    appendFileSync(file2, '\nf2v1');

    await waitForEvent(200);

    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);

    // Now modify only file1.
    appendFileSync(file1, '\nf1v1');

    await waitForEvent(200);

    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);

    await fw.stop();
  });

  // -------------------------------------------------------------------------
  // Replacing a callback for the same path
  // -------------------------------------------------------------------------

  it('replaces the callback when watch() is called again for the same path', async () => {
    vi.useFakeTimers();

    const debounceMs = 100;
    const fw = new FileWatcher(debounceMs);
    const filePath = join(dir, 'replace.yaml');
    writeFileSync(filePath, 'initial');

    const cb1 = vi.fn();
    const cb2 = vi.fn();

    fw.watch(filePath, cb1);

    vi.useRealTimers();
    await waitForReady(fw);
    vi.useFakeTimers();

    // Replace the callback.
    fw.watch(filePath, cb2);

    const watcher = fw as unknown as {
      debouncedCallback: (path: string) => void;
    };
    watcher.debouncedCallback(filePath);

    vi.advanceTimersByTime(debounceMs + 10);

    // Only cb2 should fire.
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
    await fw.stop();
  });

  // -------------------------------------------------------------------------
  // No callback fires for an unregistered path
  // -------------------------------------------------------------------------

  it('does not fire a callback for a path not registered via watch()', async () => {
    vi.useFakeTimers();

    const fw = new FileWatcher(100);
    const filePath = join(dir, 'unreg.yaml');

    // Trigger debounce for a path that was never watch()-ed.
    const watcher = fw as unknown as {
      debouncedCallback: (path: string) => void;
    };
    watcher.debouncedCallback(filePath);

    vi.advanceTimersByTime(200);

    // No timer should be pending (callback was undefined — early return).
    const fwInternal = fw as unknown as {
      timers: Map<string, ReturnType<typeof setTimeout>>;
    };
    expect(fwInternal.timers.size).toBe(0);

    vi.useRealTimers();
    await fw.stop();
  });
});
