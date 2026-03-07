/**
 * Tests for ChildProcessManager.
 *
 * Uses a fake spawn function injected via ChildProcessConfig.spawnFn to
 * avoid spawning real processes. The fake ChildProcess is an EventEmitter
 * with a controllable 'exit' event and a kill() spy.
 *
 * Test scenarios:
 *   1. start() spawns child process with correct args
 *   2. stop() sends SIGTERM and waits for exit
 *   3. Crash triggers restart with backoff
 *   4. Backoff doubles up to maxBackoff
 *   5. Max retries exceeded stops restart attempts
 *   6. Env vars merge correctly (config.env merged with process.env)
 *   7. uid/gid passed to spawn options when config.uid > 0
 *
 * NOTE: We use vi.useFakeTimers() and vi.advanceTimersByTime() (synchronous).
 * Do NOT use vi.advanceTimersByTimeAsync() — it does not work with bun+vitest.
 * After advancing fake time we flush pending microtasks with repeated
 * `await Promise.resolve()` to ensure async callbacks have run.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { ChildProcessManager, newChildProcessManager } from './childproc.js';
import type { ChildProcessConfig, ChildProcessLogger, SpawnFn } from './childproc.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flushes pending microtasks to ensure async callbacks complete. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

/** Creates a silent no-op logger for tests. */
function makeLogger(): ChildProcessLogger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

/** Creates a spy logger that records all calls. */
function makeSpyLogger(): ChildProcessLogger & {
  calls: Record<string, Array<[string, Record<string, unknown> | undefined]>>;
} {
  const calls: Record<string, Array<[string, Record<string, unknown> | undefined]>> = {
    info: [],
    warn: [],
    error: [],
  };
  return {
    calls,
    info(msg: string, data?: Record<string, unknown>) {
      calls['info']!.push([msg, data]);
    },
    warn(msg: string, data?: Record<string, unknown>) {
      calls['warn']!.push([msg, data]);
    },
    error(msg: string, data?: Record<string, unknown>) {
      calls['error']!.push([msg, data]);
    },
  };
}

/**
 * A fake ChildProcess — extends EventEmitter so we can emit 'exit' manually.
 * Records kill() calls.
 */
class FakeChildProcess extends EventEmitter {
  pid: number;
  killCalls: string[];
  killed: boolean;
  stdin: null;
  stdout: null;
  stderr: null;

  constructor(pid: number = 12345) {
    super();
    this.pid = pid;
    this.killCalls = [];
    this.killed = false;
    this.stdin = null;
    this.stdout = null;
    this.stderr = null;
  }

  kill(signal?: string): boolean {
    this.killCalls.push(signal ?? 'SIGTERM');
    this.killed = true;
    return true;
  }

  /** Simulates a process exit — triggers the 'exit' event. */
  simulateExit(code: number | null = 0, signal: string | null = null): void {
    this.emit('exit', code, signal);
  }

  /** Simulates a crash — triggers 'exit' with non-zero code. */
  simulateCrash(): void {
    this.emit('exit', 1, null);
  }
}

/**
 * Creates a fake spawn function that returns FakeChildProcess instances.
 * Records all calls so tests can inspect args and options.
 */
function makeFakeSpawn(): {
  spawnFn: SpawnFn;
  calls: Array<{ cmd: string; args: string[]; opts: SpawnOptions }>;
  children: FakeChildProcess[];
} {
  const calls: Array<{ cmd: string; args: string[]; opts: SpawnOptions }> = [];
  const children: FakeChildProcess[] = [];
  let pidCounter = 10000;

  const spawnFn = (cmd: string, args: string[], opts: SpawnOptions): ChildProcess => {
    const child = new FakeChildProcess(pidCounter++);
    calls.push({ cmd, args, opts });
    children.push(child);
    return child as unknown as ChildProcess;
  };

  return { spawnFn, calls, children };
}

/** Minimal ChildProcessConfig for tests. */
function makeConfig(overrides: Partial<ChildProcessConfig> = {}): ChildProcessConfig {
  return {
    command: 'node',
    args: ['index.js'],
    maxRetries: 3,
    initialBackoff: 1_000,
    maxBackoff: 60_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1: start() spawns child process with correct args
// ---------------------------------------------------------------------------

describe('start', () => {
  it('spawns child process with correct command, args, and stdio', async () => {
    const { spawnFn, calls } = makeFakeSpawn();
    const manager = new ChildProcessManager(
      makeConfig({ command: 'node', args: ['server.js'], spawnFn }),
      makeLogger(),
    );

    await manager.start();
    await flushMicrotasks();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('node');
    expect(calls[0]!.args).toEqual(['server.js']);
    expect((calls[0]!.opts as SpawnOptions).stdio).toBe('inherit');

    expect(manager.isRunning()).toBe(true);
    expect(manager.retryCount()).toBe(0);

    // Clean up — stop so the monitor loop doesn't linger.
    const { children } = makeFakeSpawn();
    void manager.stop();
  });

  it('is idempotent — second start() is a no-op', async () => {
    const { spawnFn, calls } = makeFakeSpawn();
    const manager = new ChildProcessManager(makeConfig({ spawnFn }), makeLogger());

    await manager.start();
    await manager.start(); // second call
    await flushMicrotasks();

    expect(calls).toHaveLength(1); // spawned only once
  });

  it('fires onReady callback after spawning', async () => {
    const { spawnFn } = makeFakeSpawn();
    const manager = new ChildProcessManager(makeConfig({ spawnFn }), makeLogger());
    const readyCalls: number[] = [];
    manager.setOnReady(() => readyCalls.push(Date.now()));

    await manager.start();
    await flushMicrotasks();

    expect(readyCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Test 2: stop() sends SIGTERM and resolves when exit fires
// ---------------------------------------------------------------------------

describe('stop', () => {
  it('sends SIGTERM and resolves when the child exits', async () => {
    const { spawnFn, children } = makeFakeSpawn();
    const manager = new ChildProcessManager(makeConfig({ spawnFn }), makeLogger());

    await manager.start();
    await flushMicrotasks();

    const child = children[0]!;

    // stop() should resolve only after exit fires
    let stopResolved = false;
    const stopPromise = manager.stop().then(() => {
      stopResolved = true;
    });

    // Not yet resolved — waiting for exit event.
    await flushMicrotasks();
    expect(stopResolved).toBe(false);
    expect(child.killCalls).toContain('SIGTERM');

    // Simulate the process exiting after SIGTERM.
    child.simulateExit(0);
    await stopPromise;

    expect(stopResolved).toBe(true);
    expect(manager.isRunning()).toBe(false);
  });

  it('is idempotent — subsequent stop() calls return resolved promises', async () => {
    const { spawnFn, children } = makeFakeSpawn();
    const manager = new ChildProcessManager(makeConfig({ spawnFn }), makeLogger());

    await manager.start();
    await flushMicrotasks();

    const child = children[0]!;
    const firstStop = manager.stop();
    child.simulateExit(0);
    await firstStop;

    // Second stop() should resolve immediately.
    await expect(manager.stop()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 3: Crash triggers restart with backoff
// ---------------------------------------------------------------------------

describe('crash and restart', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('restarts after crash with initial backoff', async () => {
    const { spawnFn, children } = makeFakeSpawn();
    const logger = makeSpyLogger();
    const manager = new ChildProcessManager(
      makeConfig({ spawnFn, maxRetries: 3, initialBackoff: 1_000 }),
      logger,
    );

    await manager.start();
    await flushMicrotasks();

    expect(children).toHaveLength(1);

    // Simulate a crash.
    children[0]!.simulateCrash();
    await flushMicrotasks();

    // Manager should be in backoff — not yet restarted.
    expect(children).toHaveLength(1);
    expect(manager.retryCount()).toBe(1);

    // Advance past the 1s backoff.
    vi.advanceTimersByTime(1_001);
    await flushMicrotasks();

    // Should have spawned a second child.
    expect(children).toHaveLength(2);

    // Clean up.
    void manager.stop();
    children[1]!.simulateExit(0);
    await flushMicrotasks();
  });

  it('fires onReady again after each restart', async () => {
    const { spawnFn, children } = makeFakeSpawn();
    const readyCount = { value: 0 };
    const manager = new ChildProcessManager(
      makeConfig({ spawnFn, maxRetries: 3, initialBackoff: 500 }),
      makeLogger(),
    );
    manager.setOnReady(() => {
      readyCount.value++;
    });

    await manager.start();
    await flushMicrotasks();
    expect(readyCount.value).toBe(1);

    // Crash → backoff → restart.
    children[0]!.simulateCrash();
    await flushMicrotasks();
    vi.advanceTimersByTime(501);
    await flushMicrotasks();

    expect(readyCount.value).toBe(2);

    void manager.stop();
    children[1]!.simulateExit(0);
    await flushMicrotasks();
  });
});

// ---------------------------------------------------------------------------
// Test 4: Backoff doubles up to maxBackoff
// ---------------------------------------------------------------------------

describe('exponential backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('doubles backoff on each retry, capped at maxBackoff', async () => {
    const { spawnFn, children } = makeFakeSpawn();
    const logger = makeSpyLogger();

    const manager = new ChildProcessManager(
      makeConfig({
        spawnFn,
        maxRetries: 10,
        initialBackoff: 1_000,
        maxBackoff: 8_000,
      }),
      logger,
    );

    await manager.start();
    await flushMicrotasks();

    // Expected backoffs: 1s, 2s, 4s, 8s (capped), 8s, ...
    const expectedBackoffs = [1_000, 2_000, 4_000, 8_000];

    for (let i = 0; i < expectedBackoffs.length; i++) {
      const backoffMs = expectedBackoffs[i]!;

      // Crash current child.
      children[i]!.simulateCrash();
      await flushMicrotasks();

      // Verify no new child yet (still in backoff).
      expect(children).toHaveLength(i + 1);

      // Check logger reported the correct backoff.
      const restartLogs = logger.calls['info']!.filter(
        ([msg]) => msg === 'restarting child process',
      );
      const lastLog = restartLogs[restartLogs.length - 1];
      expect(lastLog).toBeDefined();
      expect((lastLog![1] as Record<string, unknown>)['backoff_ms']).toBe(backoffMs);

      // Advance past this backoff.
      vi.advanceTimersByTime(backoffMs + 1);
      await flushMicrotasks();

      // New child should be spawned.
      expect(children).toHaveLength(i + 2);
    }

    void manager.stop();
    children[children.length - 1]!.simulateExit(0);
    await flushMicrotasks();
  });
});

// ---------------------------------------------------------------------------
// Test 5: Max retries exceeded stops restart attempts
// ---------------------------------------------------------------------------

describe('max retries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops restarting after maxRetries and marks not running', async () => {
    const { spawnFn, children } = makeFakeSpawn();
    const logger = makeSpyLogger();

    const manager = new ChildProcessManager(
      makeConfig({
        spawnFn,
        maxRetries: 2,
        initialBackoff: 100,
        maxBackoff: 1_000,
      }),
      logger,
    );

    await manager.start();
    await flushMicrotasks();

    // Crash #1 → retry 1.
    children[0]!.simulateCrash();
    await flushMicrotasks();
    vi.advanceTimersByTime(101);
    await flushMicrotasks();
    expect(children).toHaveLength(2);

    // Crash #2 → retry 2.
    children[1]!.simulateCrash();
    await flushMicrotasks();
    vi.advanceTimersByTime(201);
    await flushMicrotasks();
    expect(children).toHaveLength(3);

    // Crash #3 → retry 3 exceeds maxRetries (2) → stop.
    children[2]!.simulateCrash();
    await flushMicrotasks();

    // Should NOT have spawned a new child.
    expect(children).toHaveLength(3);
    expect(manager.isRunning()).toBe(false);
    expect(manager.retryCount()).toBe(3);

    // Error log should have been emitted.
    const errorLogs = logger.calls['error']!.filter(
      ([msg]) => msg === 'max restart retries exceeded',
    );
    expect(errorLogs).toHaveLength(1);
    expect((errorLogs[0]![1] as Record<string, unknown>)['max']).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test 6: Env vars merge correctly
// ---------------------------------------------------------------------------

describe('environment variables', () => {
  it('merges config.env on top of process.env', async () => {
    const { spawnFn, calls } = makeFakeSpawn();
    const manager = new ChildProcessManager(
      makeConfig({
        spawnFn,
        env: {
          MY_VAR: 'hello',
          ANOTHER: 'world',
        },
      }),
      makeLogger(),
    );

    await manager.start();
    await flushMicrotasks();

    expect(calls).toHaveLength(1);
    const spawnEnv = calls[0]!.opts.env as Record<string, string>;
    expect(spawnEnv).toBeDefined();

    // Config env vars should be present.
    expect(spawnEnv['MY_VAR']).toBe('hello');
    expect(spawnEnv['ANOTHER']).toBe('world');

    // Should also include at least one key from process.env (PATH is universal).
    // We check that it's not empty — the exact keys depend on the test runner.
    expect(Object.keys(spawnEnv).length).toBeGreaterThan(2);

    void manager.stop();
  });

  it('does not set env option when config.env is empty', async () => {
    const { spawnFn, calls } = makeFakeSpawn();
    const manager = new ChildProcessManager(
      makeConfig({ spawnFn, env: {} }),
      makeLogger(),
    );

    await manager.start();
    await flushMicrotasks();

    expect(calls[0]!.opts.env).toBeUndefined();

    void manager.stop();
  });

  it('does not set env option when config.env is not provided', async () => {
    const { spawnFn, calls } = makeFakeSpawn();
    const manager = new ChildProcessManager(
      makeConfig({ spawnFn }),
      makeLogger(),
    );

    await manager.start();
    await flushMicrotasks();

    expect(calls[0]!.opts.env).toBeUndefined();

    void manager.stop();
  });
});

// ---------------------------------------------------------------------------
// Test 7: uid/gid passed to spawn options
// ---------------------------------------------------------------------------

describe('uid and gid', () => {
  it('passes uid and gid to spawn options when uid > 0', async () => {
    const { spawnFn, calls } = makeFakeSpawn();
    const manager = new ChildProcessManager(
      makeConfig({ spawnFn, uid: 1000, gid: 1000 }),
      makeLogger(),
    );

    await manager.start();
    await flushMicrotasks();

    expect(calls[0]!.opts.uid).toBe(1000);
    expect(calls[0]!.opts.gid).toBe(1000);

    void manager.stop();
  });

  it('does not set uid/gid when uid is 0 or not provided', async () => {
    const { spawnFn, calls } = makeFakeSpawn();
    const manager = new ChildProcessManager(
      makeConfig({ spawnFn, uid: 0, gid: 0 }),
      makeLogger(),
    );

    await manager.start();
    await flushMicrotasks();

    expect(calls[0]!.opts.uid).toBeUndefined();
    expect(calls[0]!.opts.gid).toBeUndefined();

    void manager.stop();
  });

  it('does not set uid/gid when neither provided', async () => {
    const { spawnFn, calls } = makeFakeSpawn();
    const manager = new ChildProcessManager(makeConfig({ spawnFn }), makeLogger());

    await manager.start();
    await flushMicrotasks();

    expect(calls[0]!.opts.uid).toBeUndefined();
    expect(calls[0]!.opts.gid).toBeUndefined();

    void manager.stop();
  });
});

// ---------------------------------------------------------------------------
// Test: stop() during backoff cancels restart
// ---------------------------------------------------------------------------

describe('stop during backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels backoff timer and resolves stop promise without spawning again', async () => {
    const { spawnFn, children } = makeFakeSpawn();
    const manager = new ChildProcessManager(
      makeConfig({ spawnFn, maxRetries: 5, initialBackoff: 10_000 }),
      makeLogger(),
    );

    await manager.start();
    await flushMicrotasks();

    // Crash — enters backoff.
    children[0]!.simulateCrash();
    await flushMicrotasks();

    // Still waiting for backoff (10s).
    expect(children).toHaveLength(1);

    // Call stop() while in backoff.
    const stopPromise = manager.stop();

    // Flush so the cancel takes effect.
    await flushMicrotasks();

    // stop() should resolve without advancing timers further.
    await stopPromise;

    // No additional child spawned.
    expect(children).toHaveLength(1);
    expect(manager.isRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test: newChildProcessManager factory
// ---------------------------------------------------------------------------

describe('newChildProcessManager', () => {
  it('creates a manager with default values', async () => {
    const { spawnFn } = makeFakeSpawn();
    const manager = newChildProcessManager(
      { command: 'node', args: ['index.js'], spawnFn },
      makeLogger(),
    );

    expect(manager).toBeInstanceOf(ChildProcessManager);
    expect(manager.isRunning()).toBe(false);
    expect(manager.retryCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test: cwd passed to spawn options
// ---------------------------------------------------------------------------

describe('working directory', () => {
  it('passes dir as cwd to spawn options when provided', async () => {
    const { spawnFn, calls } = makeFakeSpawn();
    const manager = new ChildProcessManager(
      makeConfig({ spawnFn, dir: '/app/workspace' }),
      makeLogger(),
    );

    await manager.start();
    await flushMicrotasks();

    expect(calls[0]!.opts.cwd).toBe('/app/workspace');

    void manager.stop();
  });

  it('does not set cwd when dir is not provided', async () => {
    const { spawnFn, calls } = makeFakeSpawn();
    const manager = new ChildProcessManager(makeConfig({ spawnFn }), makeLogger());

    await manager.start();
    await flushMicrotasks();

    expect(calls[0]!.opts.cwd).toBeUndefined();

    void manager.stop();
  });
});
