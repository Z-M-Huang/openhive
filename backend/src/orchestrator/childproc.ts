/**
 * OpenHive Backend - ChildProcessManager
 *
 * Manages a long-running child process with automatic restart on crash.
 * Uses Node.js child_process.spawn with an async monitor loop awaiting
 * 'exit' events. Exponential backoff (capped at maxBackoff) delays
 * restarts, cancellable via a shared cancel callback.
 *
 * Key design choices:
 *   - No Mutex needed — Node.js is single-threaded; no concurrent writes.
 *   - Uses 'exit' event + setTimeout for backoff (no goroutines).
 *   - stop() returns a Promise that resolves once the child exits.
 *   - spawnFn is an injectable dependency for unit testing.
 *   - uid/gid are passed as spawn options (Linux only, ignored elsewhere).
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum restart attempts. */
const DEFAULT_MAX_RETRIES = 10;

/** Default initial backoff in milliseconds. */
const DEFAULT_INITIAL_BACKOFF_MS = 1_000;

/** Default maximum backoff in milliseconds. */
const DEFAULT_MAX_BACKOFF_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Spawn function signature — matches node:child_process.spawn. */
export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

/**
 * Configuration for ChildProcessManager.
 * All durations are in milliseconds.
 */
export interface ChildProcessConfig {
  /** Executable to run. */
  command: string;
  /** Arguments to pass to the executable. */
  args: string[];
  /** Additional environment variables merged on top of process.env. */
  env?: Record<string, string>;
  /** Working directory for the child process. */
  dir?: string;
  /** User ID to run the child process as (Linux only, ignored elsewhere). */
  uid?: number;
  /** Group ID to run the child process as (Linux only, ignored elsewhere). */
  gid?: number;
  /** Maximum restart attempts before giving up. Default: 10. */
  maxRetries?: number;
  /** Initial backoff delay in milliseconds. Default: 1000. */
  initialBackoff?: number;
  /** Maximum backoff delay in milliseconds. Default: 60000. */
  maxBackoff?: number;
  /**
   * Injectable spawn function — for testing only.
   * Production code leaves this undefined (uses node:child_process.spawn).
   */
  spawnFn?: SpawnFn;
}

/**
 * Minimal structured logger interface required by ChildProcessManager.
 * Compatible with pino or any standard structured logger.
 */
export interface ChildProcessLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// ChildProcessManager
// ---------------------------------------------------------------------------

/**
 * Manages a long-running child process with automatic restart on crash.
 *
 * Call start() to spawn the process. If the process exits unexpectedly,
 * it will be restarted with exponential backoff up to maxRetries times.
 * Call stop() to terminate the process and disable restart logic.
 */
export class ChildProcessManager {
  private readonly command: string;
  private readonly args: string[];
  private readonly env: Record<string, string> | undefined;
  private readonly dir: string | undefined;
  private readonly uid: number | undefined;
  private readonly gid: number | undefined;
  private readonly maxRetries: number;
  private readonly initialBackoff: number;
  private readonly maxBackoff: number;
  private readonly logger: ChildProcessLogger;
  private readonly spawnFn: SpawnFn;

  /** Currently running child process, or null if not started / stopped. */
  private child: ChildProcess | null;

  /** Callback fired once after the process is successfully spawned. */
  private onReadyCallback: (() => void) | null;

  /** Number of restart attempts since the manager was started. */
  private retries: number;

  /** True after start() has been called and the process is alive. */
  private running: boolean;

  /** True once stop() has been called — disables restart loop. */
  private stopped: boolean;

  /**
   * Resolves the Promise returned by stop() once the monitor loop exits.
   * Set by the first stop() call; null until then.
   */
  private stopResolver: (() => void) | null;

  /**
   * Called by stop() to cancel any in-progress backoff sleep.
   * Set by sleepCancellable() before each sleep; null otherwise.
   */
  private cancelBackoff: (() => void) | null;

  constructor(config: ChildProcessConfig, logger: ChildProcessLogger) {
    this.command = config.command;
    this.args = config.args;
    this.env = config.env;
    this.dir = config.dir;
    this.uid = config.uid;
    this.gid = config.gid;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.initialBackoff = config.initialBackoff ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoff = config.maxBackoff ?? DEFAULT_MAX_BACKOFF_MS;
    this.logger = logger;
    this.spawnFn = config.spawnFn ?? spawn;

    this.child = null;
    this.onReadyCallback = null;
    this.retries = 0;
    this.running = false;
    this.stopped = false;
    this.stopResolver = null;
    this.cancelBackoff = null;
  }

  // -------------------------------------------------------------------------
  // setOnReady
  // -------------------------------------------------------------------------

  /**
   * Registers a callback to invoke each time the process is successfully
   * spawned (including after restarts).
   */
  setOnReady(fn: () => void): void {
    this.onReadyCallback = fn;
  }

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  /**
   * Starts the child process and launches the monitor loop.
   * Idempotent — subsequent calls when already running are no-ops.
   *
   * Throws if the initial spawn fails synchronously (injected spawnFn can
   * throw for test purposes).
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.startProcess();
    this.running = true;
    // Launch monitor loop in the background — do not await.
    void this.monitor();
  }

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------

  /**
   * Stops the child process and disables the restart loop.
   * Returns a Promise that resolves once the monitor loop has exited
   * (i.e., the process has been killed and the exit event has fired).
   *
   * Idempotent — subsequent calls return a resolved Promise.
   */
  stop(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    this.stopped = true;
    this.running = false;

    return new Promise<void>((resolve) => {
      this.stopResolver = resolve;

      // If we are currently sleeping in a backoff delay, cancel it immediately
      // so the monitor loop wakes up and exits.
      if (this.cancelBackoff !== null) {
        this.cancelBackoff();
        this.cancelBackoff = null;
        // The monitor will see stopped=true and call stopResolver itself.
        return;
      }

      // Kill the live child process. The monitor loop will see stopped=true
      // after the exit event fires and call stopResolver.
      this.killProcess();
    });
  }

  // -------------------------------------------------------------------------
  // isRunning
  // -------------------------------------------------------------------------

  /**
   * Returns true if the child process is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  // -------------------------------------------------------------------------
  // retryCount
  // -------------------------------------------------------------------------

  /**
   * Returns the number of restart attempts since the manager was started.
   */
  retryCount(): number {
    return this.retries;
  }

  // -------------------------------------------------------------------------
  // startProcess (private)
  // -------------------------------------------------------------------------

  /**
   * Spawns the child process, configures stdio/env/cwd/uid/gid, and fires
   * the onReady callback.
   *
   * Sets this.child to the new ChildProcess.
   */
  private startProcess(): void {
    const spawnOpts: SpawnOptions = {
      stdio: 'inherit',
    };

    // Merge env: inherit parent process.env, overlay config.env on top.
    if (this.env !== undefined && Object.keys(this.env).length > 0) {
      spawnOpts.env = { ...process.env, ...this.env };
    }

    if (this.dir !== undefined && this.dir !== '') {
      spawnOpts.cwd = this.dir;
    }

    // uid/gid: Node.js passes these to the OS. Ignored on non-Linux platforms.
    if (this.uid !== undefined && this.uid > 0) {
      spawnOpts.uid = this.uid;
      if (this.gid !== undefined) {
        spawnOpts.gid = this.gid;
      }
    }

    const child = this.spawnFn(this.command, this.args, spawnOpts);
    this.child = child;

    this.logger.info('child process started', {
      command: this.command,
      pid: child.pid,
    });

    if (this.onReadyCallback !== null) {
      this.onReadyCallback();
    }
  }

  // -------------------------------------------------------------------------
  // killProcess (private)
  // -------------------------------------------------------------------------

  /**
   * Sends SIGTERM to the current child process.
   * Logs a warning if the signal fails. If there is no live child,
   * resolves the stop promise immediately.
   */
  private killProcess(): void {
    if (this.child === null) {
      if (this.stopResolver !== null) {
        this.stopResolver();
        this.stopResolver = null;
      }
      return;
    }
    try {
      this.child.kill('SIGTERM');
      // The stop promise resolves when the monitor sees stopped=true after the
      // 'exit' event fires. No need to resolve here.
    } catch (err) {
      this.logger.warn('failed to kill child process', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Resolve stop() promise so it doesn't hang when kill fails.
      if (this.stopResolver !== null) {
        this.stopResolver();
        this.stopResolver = null;
      }
    }
  }

  // -------------------------------------------------------------------------
  // monitor (private)
  // -------------------------------------------------------------------------

  /**
   * Background loop: waits for the child process to exit, then either
   * resolves the stop promise or restarts with backoff.
   */
  private async monitor(): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Wait for the current child process to exit.
      await this.waitForExit();

      // If stop() was called (possibly triggered by the kill we just did),
      // resolve the stop promise and exit the loop.
      if (this.stopped) {
        if (this.stopResolver !== null) {
          this.stopResolver();
          this.stopResolver = null;
        }
        return;
      }

      // Unexpected exit — log and attempt a restart.
      this.logger.error('child process crashed', {
        command: this.command,
        retries: this.retries,
      });

      const shouldContinue = await this.restart();
      if (!shouldContinue) {
        // Max retries or stop() called during backoff.
        if (this.stopResolver !== null) {
          this.stopResolver();
          this.stopResolver = null;
        }
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // waitForExit (private)
  // -------------------------------------------------------------------------

  /**
   * Returns a Promise that resolves when the current child process emits
   * the 'exit' event. If child is null, resolves immediately.
   */
  private waitForExit(): Promise<void> {
    if (this.child === null) {
      return Promise.resolve();
    }
    const child = this.child;
    return new Promise<void>((resolve) => {
      child.once('exit', () => {
        resolve();
      });
    });
  }

  // -------------------------------------------------------------------------
  // restart (private)
  // -------------------------------------------------------------------------

  /**
   * Increments retry counter, enforces max-retries limit, waits for
   * exponential backoff, then respawns the process.
   *
   * Returns true if the monitor loop should continue, false if it should stop
   * (max retries exceeded or stop() was called during backoff).
   */
  private async restart(): Promise<boolean> {
    this.retries++;

    if (this.retries > this.maxRetries) {
      this.logger.error('max restart retries exceeded', {
        retries: this.retries,
        max: this.maxRetries,
      });
      this.running = false;
      return false;
    }

    // Exponential backoff: initialBackoff * 2^(retries-1), capped at maxBackoff.
    let backoff = this.initialBackoff * Math.pow(2, this.retries - 1);
    if (backoff > this.maxBackoff) {
      backoff = this.maxBackoff;
    }

    this.logger.info('restarting child process', {
      retry: this.retries,
      backoff_ms: backoff,
    });

    // Wait for backoff — returns false if stop() was called during sleep.
    const completed = await this.sleepCancellable(backoff);
    if (!completed || this.stopped) {
      return false;
    }

    try {
      this.startProcess();
    } catch (err) {
      this.logger.error('failed to restart child process', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Return true — the monitor loop continues and will call waitForExit
      // Return true — the monitor loop continues and will call waitForExit then retry.
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // sleepCancellable (private)
  // -------------------------------------------------------------------------

  /**
   * Waits for `ms` milliseconds.
   *
   * Returns true if the delay elapsed normally.
   * Returns false if stop() cancelled the delay (via this.cancelBackoff).
   */
  private sleepCancellable(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.cancelBackoff = null;
        resolve(true);
      }, ms);

      // Expose a cancel hook so stop() can interrupt this sleep.
      this.cancelBackoff = () => {
        clearTimeout(timer);
        this.cancelBackoff = null;
        resolve(false);
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a new ChildProcessManager with production defaults.
 */
export function newChildProcessManager(
  config: ChildProcessConfig,
  logger: ChildProcessLogger,
): ChildProcessManager {
  return new ChildProcessManager(config, logger);
}
