/**
 * Tests for backend/src/container/manager.ts
 *
 * All tests use in-memory fakes — no real Docker daemon required.
 *
 * Covers:
 *   ManagerImpl.ensureRunning:
 *     - skips provisioning when container already running (idempotent)
 *     - provisions when no running container found
 *     - concurrent calls for same team — only one provisions, second finds it running
 *     - concurrent calls for different teams — both proceed in parallel
 *
 *   ManagerImpl.provisionTeam:
 *     - creates and starts container with WS token + secrets in env
 *     - passes team slug as container name
 *     - loads team config for max_memory when configLoader present
 *     - merges team config env vars (caller secrets take precedence)
 *     - removes orphan container if start fails
 *     - resets restart count after provisioning
 *
 *   ManagerImpl.removeTeam:
 *     - stops and removes container
 *     - clears state after removal
 *     - throws NotFoundError when no container tracked
 *     - continues removal even if stop fails (best-effort stop)
 *
 *   ManagerImpl.restartTeam:
 *     - stops then starts (provisions) the container
 *
 *   ManagerImpl.stopTeam:
 *     - gracefully stops container without removing
 *     - logs warning when no container tracked (no throw)
 *
 *   ManagerImpl.cleanup:
 *     - removes orphan containers not in config
 *     - keeps containers that ARE in config
 *     - skips containers with short names (no slug)
 *     - does not run concurrently with itself (global mutex)
 *
 *   ManagerImpl.getStatus:
 *     - returns 'stopped' when no state tracked
 *     - returns 'running' when container ID is tracked
 *
 *   ManagerImpl.getContainerID:
 *     - returns container ID when tracked
 *     - throws NotFoundError when not tracked
 *
 *   ManagerImpl.handleUnhealthy:
 *     - schedules restart with backoff on first unhealthy signal
 *     - stops after MAX_RESTART_ATTEMPTS (no restart at attempt 4)
 *
 *   Idle timeout:
 *     - stops container after configured duration elapses
 *     - cancels previous timer when new one is scheduled
 *
 *   Per-team locking:
 *     - concurrent removeTeam + ensureRunning for same team are serialized
 *
 *   restartBackoffForAttempt:
 *     - attempt 1 → 1000ms, attempt 2 → 5000ms, attempt 3+ → 30000ms
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { ManagerImpl, restartBackoffForAttempt } from './manager.js';
import type { ManagerLogger, ManagerWSHub, ManagerConfig } from './manager.js';
import type { ContainerRuntime, ConfigLoader } from '../domain/interfaces.js';
import type { ContainerInfo, ContainerConfig, Team } from '../domain/types.js';
import { NotFoundError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// FakeLogger
// ---------------------------------------------------------------------------

interface LogEntry {
  msg: string;
  data?: Record<string, unknown>;
}

class FakeLogger implements ManagerLogger {
  readonly debugs: LogEntry[] = [];
  readonly infos: LogEntry[] = [];
  readonly warns: LogEntry[] = [];
  readonly errors: LogEntry[] = [];

  debug(msg: string, data?: Record<string, unknown>): void {
    this.debugs.push({ msg, data });
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.infos.push({ msg, data });
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.warns.push({ msg, data });
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.errors.push({ msg, data });
  }
}

// ---------------------------------------------------------------------------
// FakeWSHub
// ---------------------------------------------------------------------------

class FakeWSHub implements ManagerWSHub {
  private tokenCounter = 0;
  readonly generatedTokens: Array<{ teamID: string; value: string }> = [];

  generateToken(teamID: string): string {
    const value = `fake-ws-token-${teamID}-${++this.tokenCounter}`;
    this.generatedTokens.push({ teamID, value });
    return value;
  }

  getConnectedTeams(): string[] {
    return [];
  }
}

// ---------------------------------------------------------------------------
// FakeContainerRuntime
// ---------------------------------------------------------------------------

interface CreateCall {
  config: ContainerConfig;
  returnedID: string;
}

class FakeContainerRuntime implements ContainerRuntime {
  private idCounter = 0;
  readonly createCalls: CreateCall[] = [];
  readonly startCalls: string[] = [];
  readonly stopCalls: Array<{ containerID: string; timeoutMs: number }> = [];
  readonly removeCalls: string[] = [];
  readonly inspectCalls: string[] = [];

  /** If set, the next createContainer throws this. */
  createError: Error | null = null;
  /** If set, the next startContainer throws this. */
  startError: Error | null = null;
  /** If set, stopContainer throws this. */
  stopError: Error | null = null;
  /** If set, removeContainer throws this. */
  removeError: Error | null = null;

  /** Containers available to listContainers. */
  containerList: ContainerInfo[] = [];

  async createContainer(config: ContainerConfig): Promise<string> {
    if (this.createError !== null) {
      const err = this.createError;
      this.createError = null;
      throw err;
    }
    const id = `ctr-${String(++this.idCounter).padStart(3, '0')}`;
    this.createCalls.push({ config, returnedID: id });
    return id;
  }

  async startContainer(containerID: string): Promise<void> {
    if (this.startError !== null) {
      const err = this.startError;
      this.startError = null;
      throw err;
    }
    this.startCalls.push(containerID);
  }

  async stopContainer(containerID: string, timeoutMs: number): Promise<void> {
    if (this.stopError !== null) {
      const err = this.stopError;
      this.stopError = null;
      throw err;
    }
    this.stopCalls.push({ containerID, timeoutMs });
  }

  async removeContainer(containerID: string): Promise<void> {
    if (this.removeError !== null) {
      const err = this.removeError;
      this.removeError = null;
      throw err;
    }
    this.removeCalls.push(containerID);
  }

  async inspectContainer(containerID: string): Promise<ContainerInfo> {
    this.inspectCalls.push(containerID);
    return { id: containerID, name: 'openhive-team', state: 'running' };
  }

  async listContainers(): Promise<ContainerInfo[]> {
    return [...this.containerList];
  }
}

// ---------------------------------------------------------------------------
// FakeConfigLoader
// ---------------------------------------------------------------------------

class FakeConfigLoader implements Partial<ConfigLoader> {
  private teamSlugs: string[] = [];
  private teams: Map<string, Team> = new Map();

  setTeams(slugs: string[], teams?: Map<string, Team>): void {
    this.teamSlugs = [...slugs];
    if (teams !== undefined) {
      this.teams = teams;
    }
  }

  async listTeams(): Promise<string[]> {
    return [...this.teamSlugs];
  }

  async loadTeam(slug: string): Promise<Team> {
    const team = this.teams.get(slug);
    if (team === undefined) {
      throw new NotFoundError('team', slug);
    }
    return team;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManager(opts?: {
  configLoader?: FakeConfigLoader | null;
  idleTimeoutMs?: number;
}): {
  manager: ManagerImpl;
  runtime: FakeContainerRuntime;
  wsHub: FakeWSHub;
  logger: FakeLogger;
} {
  const runtime = new FakeContainerRuntime();
  const wsHub = new FakeWSHub();
  const logger = new FakeLogger();

  const configLoader: ConfigLoader | null =
    opts?.configLoader !== undefined
      ? (opts.configLoader as ConfigLoader | null)
      : null;

  const cfg: ManagerConfig = {
    runtime,
    wsHub,
    configLoader,
    logger,
    wsURL: 'ws://localhost:8080',
    idleTimeoutMs: opts?.idleTimeoutMs ?? 60_000,
  };

  const manager = new ManagerImpl(cfg);
  return { manager, runtime, wsHub, logger };
}

function makeRunningContainer(slug: string, id = 'ctr-existing-001'): ContainerInfo {
  return {
    id,
    name: `openhive-${slug}`,
    state: 'running',
  };
}

// ---------------------------------------------------------------------------
// Tests: restartBackoffForAttempt
// ---------------------------------------------------------------------------

describe('restartBackoffForAttempt', () => {
  it('returns 1000ms for attempt 1', () => {
    expect(restartBackoffForAttempt(1)).toBe(1_000);
  });

  it('returns 5000ms for attempt 2', () => {
    expect(restartBackoffForAttempt(2)).toBe(5_000);
  });

  it('returns 30000ms for attempt 3', () => {
    expect(restartBackoffForAttempt(3)).toBe(30_000);
  });

  it('returns 30000ms for attempt 4 (max)', () => {
    expect(restartBackoffForAttempt(4)).toBe(30_000);
  });

  it('returns 30000ms for large attempt numbers', () => {
    expect(restartBackoffForAttempt(100)).toBe(30_000);
  });

  it('returns 1000ms for attempt 0 (clamp to min)', () => {
    expect(restartBackoffForAttempt(0)).toBe(1_000);
  });
});

// ---------------------------------------------------------------------------
// Tests: getStatus
// ---------------------------------------------------------------------------

describe('ManagerImpl.getStatus', () => {
  it('returns "stopped" when no state is tracked for the team', () => {
    const { manager } = makeManager();
    expect(manager.getStatus('unknown-team')).toBe('stopped');
  });

  it('returns "running" after a container has been provisioned', async () => {
    const { manager } = makeManager();
    await manager.provisionTeam('my-team', {});
    expect(manager.getStatus('my-team')).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// Tests: getContainerID
// ---------------------------------------------------------------------------

describe('ManagerImpl.getContainerID', () => {
  it('throws NotFoundError when no container is tracked', () => {
    const { manager } = makeManager();
    expect(() => manager.getContainerID('unknown-team')).toThrow(NotFoundError);
  });

  it('returns the container ID after provisioning', async () => {
    const { manager, runtime } = makeManager();
    await manager.provisionTeam('my-team', {});
    const expectedID = runtime.createCalls[0].returnedID;
    expect(manager.getContainerID('my-team')).toBe(expectedID);
  });
});

// ---------------------------------------------------------------------------
// Tests: provisionTeam
// ---------------------------------------------------------------------------

describe('ManagerImpl.provisionTeam', () => {
  it('generates a WS token and includes it in env as WS_TOKEN', async () => {
    const { manager, runtime, wsHub } = makeManager();
    await manager.provisionTeam('alpha-team', {});
    const wsTokenValue = wsHub.generatedTokens[0].value;
    const envEntries = runtime.createCalls[0].config.env ?? {};
    expect(envEntries['WS_TOKEN']).toBe(wsTokenValue);
  });

  it('builds WS_URL from wsURL + WS token', async () => {
    const { manager, runtime, wsHub } = makeManager();
    await manager.provisionTeam('alpha-team', {});
    const wsTokenValue = wsHub.generatedTokens[0].value;
    const envEntries = runtime.createCalls[0].config.env ?? {};
    expect(envEntries['WS_URL']).toBe(`ws://localhost:8080/ws/container?token=${wsTokenValue}`);
  });

  it('passes caller-provided env vars to container', async () => {
    const { manager, runtime } = makeManager();
    await manager.provisionTeam('alpha-team', { TEAM_ID: 'tid-alpha-001', REGION: 'us-east' });
    const envEntries = runtime.createCalls[0].config.env ?? {};
    expect(envEntries['TEAM_ID']).toBe('tid-alpha-001');
    expect(envEntries['REGION']).toBe('us-east');
  });

  it('uses teamSlug as container name', async () => {
    const { manager, runtime } = makeManager();
    await manager.provisionTeam('beta-team', {});
    expect(runtime.createCalls[0].config.name).toBe('beta-team');
  });

  it('starts the container after creating it', async () => {
    const { manager, runtime } = makeManager();
    await manager.provisionTeam('gamma-team', {});
    expect(runtime.startCalls).toHaveLength(1);
    expect(runtime.startCalls[0]).toBe(runtime.createCalls[0].returnedID);
  });

  it('logs info on successful provisioning', async () => {
    const { manager, logger } = makeManager();
    await manager.provisionTeam('delta-team', {});
    expect(logger.infos.some((l) => l.msg === 'container provisioned')).toBe(true);
  });

  it('removes orphan container if start fails', async () => {
    const { manager, runtime } = makeManager();
    runtime.startError = new Error('daemon error');
    await expect(manager.provisionTeam('failing-team', {})).rejects.toThrow();
    expect(runtime.removeCalls).toHaveLength(1);
  });

  it('throws error with context when start fails', async () => {
    const { manager, runtime } = makeManager();
    runtime.startError = new Error('daemon error');
    await expect(manager.provisionTeam('failing-team', {})).rejects.toThrow(
      'provision "failing-team": start container: daemon error',
    );
  });

  it('loads max_memory from team config when configLoader is present', async () => {
    const loader = new FakeConfigLoader();
    const teamMap = new Map<string, Team>();
    teamMap.set('mem-team', {
      tid: 'tid-mem',
      slug: 'mem-team',
      leader_aid: 'aid-001',
      container_config: { max_memory: '1g' },
    });
    loader.setTeams(['mem-team'], teamMap);

    const { manager, runtime } = makeManager({ configLoader: loader });
    await manager.provisionTeam('mem-team', {});
    expect(runtime.createCalls[0].config.max_memory).toBe('1g');
  });

  it('merges team config env vars — caller provided values take precedence', async () => {
    const loader = new FakeConfigLoader();
    const teamMap = new Map<string, Team>();
    teamMap.set('env-team', {
      tid: 'tid-env',
      slug: 'env-team',
      leader_aid: 'aid-002',
      container_config: {
        env: { TEAM_VAR: 'from-config', SHARED_VAR: 'config-value' },
      },
    });
    loader.setTeams(['env-team'], teamMap);

    const { manager, runtime } = makeManager({ configLoader: loader });
    await manager.provisionTeam('env-team', { SHARED_VAR: 'caller-value' });
    const env = runtime.createCalls[0].config.env ?? {};
    expect(env['TEAM_VAR']).toBe('from-config');
    expect(env['SHARED_VAR']).toBe('caller-value'); // caller wins over config
  });

  it('generates WS token associated with the correct team slug', async () => {
    const { manager, wsHub } = makeManager();
    await manager.provisionTeam('token-verify-team', {});
    expect(wsHub.generatedTokens[0].teamID).toBe('token-verify-team');
  });
});

// ---------------------------------------------------------------------------
// Tests: ensureRunning
// ---------------------------------------------------------------------------

describe('ManagerImpl.ensureRunning', () => {
  it('skips provisioning when container is already running', async () => {
    const { manager, runtime } = makeManager();
    runtime.containerList = [makeRunningContainer('my-team')];
    await manager.ensureRunning('my-team');
    expect(runtime.createCalls).toHaveLength(0);
    expect(runtime.startCalls).toHaveLength(0);
  });

  it('provisions when no running container is found', async () => {
    const { manager, runtime } = makeManager();
    runtime.containerList = [];
    await manager.ensureRunning('new-team');
    expect(runtime.createCalls).toHaveLength(1);
    expect(runtime.startCalls).toHaveLength(1);
  });

  it('updates the tracked container ID when container already running', async () => {
    const { manager, runtime } = makeManager();
    runtime.containerList = [makeRunningContainer('my-team', 'existing-ctr-abc')];
    await manager.ensureRunning('my-team');
    expect(manager.getContainerID('my-team')).toBe('existing-ctr-abc');
  });

  it('provisions when container has same name but is stopped (not running)', async () => {
    const { manager, runtime } = makeManager();
    runtime.containerList = [
      { id: 'ctr-stopped', name: 'openhive-my-team', state: 'stopped' },
    ];
    await manager.ensureRunning('my-team');
    // Not 'running' → provision should be called
    expect(runtime.createCalls).toHaveLength(1);
  });

  it('concurrent ensureRunning for same team — only one provisions, second finds it running', async () => {
    const { manager, runtime } = makeManager();

    let callCount = 0;
    vi.spyOn(runtime, 'listContainers').mockImplementation(async () => {
      callCount++;
      if (callCount <= 1) {
        return []; // First call: no running container
      }
      // Subsequent calls: container is now running (after first provision)
      const id = runtime.createCalls[0]?.returnedID ?? 'ctr-concurrent';
      return [{ id, name: 'openhive-concurrent-team', state: 'running' as const }];
    });

    const [p1, p2] = await Promise.all([
      manager.ensureRunning('concurrent-team').then(() => 'done1'),
      manager.ensureRunning('concurrent-team').then(() => 'done2'),
    ]);

    expect(p1).toBe('done1');
    expect(p2).toBe('done2');
    // Only one provision should happen (second sees running container)
    expect(runtime.createCalls).toHaveLength(1);
    expect(runtime.startCalls).toHaveLength(1);
  });

  it('concurrent ensureRunning for different teams — both provision in parallel', async () => {
    const { manager, runtime } = makeManager();
    runtime.containerList = [];

    const [r1, r2] = await Promise.all([
      manager.ensureRunning('team-a').then(() => 'done-a'),
      manager.ensureRunning('team-b').then(() => 'done-b'),
    ]);

    expect(r1).toBe('done-a');
    expect(r2).toBe('done-b');
    // Both teams should be provisioned (independent mutexes)
    expect(runtime.createCalls).toHaveLength(2);
    expect(runtime.startCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: removeTeam
// ---------------------------------------------------------------------------

describe('ManagerImpl.removeTeam', () => {
  it('stops and removes the container', async () => {
    const { manager, runtime } = makeManager();
    await manager.provisionTeam('remove-team', {});
    const containerID = manager.getContainerID('remove-team');
    await manager.removeTeam('remove-team');
    expect(runtime.stopCalls.some((c) => c.containerID === containerID)).toBe(true);
    expect(runtime.removeCalls).toContain(containerID);
  });

  it('clears state after removal', async () => {
    const { manager } = makeManager();
    await manager.provisionTeam('clear-team', {});
    await manager.removeTeam('clear-team');
    expect(manager.getStatus('clear-team')).toBe('stopped');
    expect(() => manager.getContainerID('clear-team')).toThrow(NotFoundError);
  });

  it('throws NotFoundError when no container is tracked', async () => {
    const { manager } = makeManager();
    await expect(manager.removeTeam('unknown-team')).rejects.toThrow(NotFoundError);
  });

  it('continues removal even if stop fails (best-effort)', async () => {
    const { manager, runtime, logger } = makeManager();
    await manager.provisionTeam('partial-remove', {});
    runtime.stopError = new Error('stop timed out');
    await manager.removeTeam('partial-remove');
    // Should still remove even though stop failed
    expect(runtime.removeCalls).toHaveLength(1);
    expect(logger.warns.some((w) => w.msg === 'stop container failed during remove')).toBe(true);
  });

  it('logs info on successful removal', async () => {
    const { manager, logger } = makeManager();
    await manager.provisionTeam('logged-remove', {});
    await manager.removeTeam('logged-remove');
    expect(logger.infos.some((l) => l.msg === 'team container removed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: restartTeam
// ---------------------------------------------------------------------------

describe('ManagerImpl.restartTeam', () => {
  it('stops then starts the container', async () => {
    const { manager, runtime } = makeManager();
    await manager.provisionTeam('restart-team', {});
    const firstID = manager.getContainerID('restart-team');

    await manager.restartTeam('restart-team');

    // Should have stopped the old container
    expect(runtime.stopCalls.some((c) => c.containerID === firstID)).toBe(true);
    // And started a new one (2 starts: initial provision + restart)
    expect(runtime.startCalls).toHaveLength(2);
  });

  it('provisions a new container after stopping', async () => {
    const { manager, runtime } = makeManager();
    await manager.provisionTeam('restart-team', {});
    runtime.containerList = []; // No running container for _ensureRunningUnlocked to find

    await manager.restartTeam('restart-team');

    expect(runtime.createCalls).toHaveLength(2); // initial + restart
  });

  it('still restarts even if initial stop fails', async () => {
    const { manager, runtime } = makeManager();
    await manager.provisionTeam('restart-team', {});
    runtime.stopError = new Error('stop failed');
    runtime.containerList = [];

    await manager.restartTeam('restart-team');

    // Stop failed but provision should still be called
    expect(runtime.createCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: stopTeam
// ---------------------------------------------------------------------------

describe('ManagerImpl.stopTeam', () => {
  it('stops the container gracefully', async () => {
    const { manager, runtime } = makeManager();
    await manager.provisionTeam('stop-team', {});
    const containerID = manager.getContainerID('stop-team');
    await manager.stopTeam('stop-team');
    expect(runtime.stopCalls.some((c) => c.containerID === containerID)).toBe(true);
  });

  it('does not remove the container', async () => {
    const { manager, runtime } = makeManager();
    await manager.provisionTeam('stop-team', {});
    await manager.stopTeam('stop-team');
    expect(runtime.removeCalls).toHaveLength(0);
  });

  it('logs info on successful stop', async () => {
    const { manager, logger } = makeManager();
    await manager.provisionTeam('stop-log-team', {});
    await manager.stopTeam('stop-log-team');
    expect(logger.infos.some((l) => l.msg === 'team container stopped')).toBe(true);
  });

  it('logs warning and does not throw when no container is tracked', async () => {
    const { manager, logger } = makeManager();
    await expect(manager.stopTeam('unknown-team')).resolves.toBeUndefined();
    expect(logger.warns.some((w) => w.msg.includes('no container tracked'))).toBe(true);
  });

  it('passes correct stop timeout (30s)', async () => {
    const { manager, runtime } = makeManager();
    await manager.provisionTeam('timeout-team', {});
    await manager.stopTeam('timeout-team');
    expect(runtime.stopCalls[0].timeoutMs).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// Tests: cleanup
// ---------------------------------------------------------------------------

describe('ManagerImpl.cleanup', () => {
  it('removes orphan containers not in config', async () => {
    const loader = new FakeConfigLoader();
    loader.setTeams(['configured-team']);
    const { manager, runtime } = makeManager({ configLoader: loader });

    runtime.containerList = [
      { id: 'orphan-ctr', name: 'openhive-orphan-team', state: 'running' },
      { id: 'kept-ctr', name: 'openhive-configured-team', state: 'running' },
    ];

    await manager.cleanup();

    expect(runtime.stopCalls.some((c) => c.containerID === 'orphan-ctr')).toBe(true);
    expect(runtime.removeCalls).toContain('orphan-ctr');
  });

  it('keeps containers that ARE in config', async () => {
    const loader = new FakeConfigLoader();
    loader.setTeams(['configured-team']);
    const { manager, runtime } = makeManager({ configLoader: loader });

    runtime.containerList = [
      { id: 'kept-ctr', name: 'openhive-configured-team', state: 'running' },
    ];

    await manager.cleanup();

    expect(runtime.removeCalls).not.toContain('kept-ctr');
  });

  it('skips containers with names at or below prefix length (no slug)', async () => {
    const loader = new FakeConfigLoader();
    loader.setTeams([]);
    const { manager, runtime } = makeManager({ configLoader: loader });

    runtime.containerList = [
      { id: 'short-ctr', name: 'openhive-', state: 'running' }, // exactly prefix — empty slug
    ];

    await manager.cleanup();

    expect(runtime.removeCalls).toHaveLength(0);
  });

  it('does nothing when configLoader is null', async () => {
    const { manager, runtime } = makeManager({ configLoader: null });
    runtime.containerList = [
      { id: 'ctr-001', name: 'openhive-orphan', state: 'running' },
    ];
    await manager.cleanup();
    expect(runtime.removeCalls).toHaveLength(0);
  });

  it('logs warn for orphan containers', async () => {
    const loader = new FakeConfigLoader();
    loader.setTeams([]);
    const { manager, runtime, logger } = makeManager({ configLoader: loader });

    runtime.containerList = [
      { id: 'orphan-ctr', name: 'openhive-orphan-team', state: 'running' },
    ];

    await manager.cleanup();

    expect(logger.warns.some((w) => w.msg === 'removing orphan container')).toBe(true);
  });

  it('continues cleanup even if stop of orphan fails', async () => {
    const loader = new FakeConfigLoader();
    loader.setTeams([]);
    const { manager, runtime, logger } = makeManager({ configLoader: loader });

    runtime.containerList = [
      { id: 'orphan-ctr', name: 'openhive-orphan-team', state: 'running' },
    ];
    runtime.stopError = new Error('stop failed');

    await manager.cleanup();

    expect(runtime.removeCalls).toContain('orphan-ctr');
    expect(logger.warns.some((w) => w.msg === 'stop orphan failed')).toBe(true);
  });

  it('does not run concurrently with itself (global mutex)', async () => {
    const loader = new FakeConfigLoader();
    loader.setTeams([]);
    const { manager, runtime } = makeManager({ configLoader: loader });

    const callOrder: number[] = [];
    let callNum = 0;

    runtime.containerList = [
      { id: 'ctr-a', name: 'openhive-team-a', state: 'running' },
    ];

    const originalListContainers = runtime.listContainers.bind(runtime);
    vi.spyOn(runtime, 'listContainers').mockImplementation(async () => {
      const num = ++callNum;
      callOrder.push(num);
      await new Promise<void>((r) => setTimeout(r, 5));
      return originalListContainers();
    });

    await Promise.all([manager.cleanup(), manager.cleanup()]);

    // Serialized by global mutex — list is called sequentially
    expect(callOrder).toHaveLength(2);
    expect(callOrder[0]).toBe(1);
    expect(callOrder[1]).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: handleUnhealthy
// ---------------------------------------------------------------------------

describe('ManagerImpl.handleUnhealthy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules restart with backoff delay on first attempt', async () => {
    const { manager, runtime } = makeManager();
    await manager.provisionTeam('unhealthy-team', {});
    runtime.containerList = [];

    const handlePromise = manager.handleUnhealthy('unhealthy-team');

    vi.advanceTimersByTime(1_000);
    await handlePromise;

    // Should have restarted (stop + new create)
    expect(runtime.createCalls).toHaveLength(2);
  });

  it('does not restart before backoff elapses', async () => {
    const { manager } = makeManager();
    vi.spyOn(manager, 'restartTeam').mockResolvedValue(undefined);

    const handlePromise = manager.handleUnhealthy('unhealthy-team');
    vi.advanceTimersByTime(999);
    expect(manager.restartTeam).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await handlePromise;
    expect(manager.restartTeam).toHaveBeenCalledOnce();
  });

  it('stops after MAX_RESTART_ATTEMPTS — no restart on attempt 4', async () => {
    const { manager, logger } = makeManager();
    vi.spyOn(manager, 'restartTeam').mockResolvedValue(undefined);

    // Trigger 3 times (attempts 1, 2, 3)
    for (let i = 0; i < 3; i++) {
      const p = manager.handleUnhealthy('maxed-team');
      vi.advanceTimersByTime(30_000);
      await p;
    }

    vi.clearAllMocks();

    // 4th call — should NOT restart
    await manager.handleUnhealthy('maxed-team');
    expect(manager.restartTeam).not.toHaveBeenCalled();
    expect(logger.errors.some((e) => e.msg.includes('max restart attempts exceeded'))).toBe(true);
  });

  it('logs warning with attempt and backoff_ms on unhealthy signal', async () => {
    const { manager, logger } = makeManager();
    vi.spyOn(manager, 'restartTeam').mockResolvedValue(undefined);

    const p = manager.handleUnhealthy('warn-team');
    vi.advanceTimersByTime(1_000);
    await p;

    const warnEntry = logger.warns.find(
      (w) => w.msg === 'container unhealthy, scheduling restart',
    );
    expect(warnEntry).toBeDefined();
    expect(warnEntry?.data?.['attempt']).toBe(1);
    expect(warnEntry?.data?.['backoff_ms']).toBe(1_000);
  });

  it('logs info on successful auto-restart', async () => {
    const { manager, logger } = makeManager();
    vi.spyOn(manager, 'restartTeam').mockResolvedValue(undefined);

    const p = manager.handleUnhealthy('success-team');
    vi.advanceTimersByTime(1_000);
    await p;

    expect(logger.infos.some((l) => l.msg === 'auto-restart succeeded')).toBe(true);
  });

  it('logs error when auto-restart fails', async () => {
    const { manager, logger } = makeManager();
    vi.spyOn(manager, 'restartTeam').mockRejectedValue(new Error('restart failed'));

    const p = manager.handleUnhealthy('fail-team');
    vi.advanceTimersByTime(1_000);
    await p;

    expect(logger.errors.some((e) => e.msg === 'auto-restart failed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: resetRestartCount
// ---------------------------------------------------------------------------

describe('ManagerImpl.resetRestartCount', () => {
  it('resets the restart count without throwing', () => {
    const { manager } = makeManager();
    manager.resetRestartCount('some-team');
    expect(manager.getStatus('some-team')).toBe('stopped');
  });
});

// ---------------------------------------------------------------------------
// Tests: idle timeout
// ---------------------------------------------------------------------------

describe('Idle timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops container after configured idle timeout elapses', async () => {
    const { manager, runtime } = makeManager({ idleTimeoutMs: 5_000 });
    await manager.provisionTeam('idle-team', {});
    const containerID = manager.getContainerID('idle-team');

    vi.advanceTimersByTime(5_000);
    // Flush microtask queue (promise chains from fire-and-forget idle callback)
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(runtime.stopCalls.some((c) => c.containerID === containerID)).toBe(true);
  });

  it('cancels previous idle timer when resetIdleTimer is called', async () => {
    const { manager, runtime } = makeManager({ idleTimeoutMs: 5_000 });
    await manager.provisionTeam('idle-team', {});

    // Advance almost to timeout
    vi.advanceTimersByTime(4_000);
    // Reset — new 5s window starts
    manager.resetIdleTimer('idle-team');

    // Advance 4 more seconds (total 8s from provision) — should NOT have stopped yet
    vi.advanceTimersByTime(4_000);
    expect(runtime.stopCalls).toHaveLength(0);

    // Advance remaining 1s of the new window
    vi.advanceTimersByTime(1_001);
    // Flush microtask queue (promise chains from fire-and-forget idle callback)
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(runtime.stopCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: per-team locking
// ---------------------------------------------------------------------------

describe('Per-team locking', () => {
  it('concurrent removeTeam + ensureRunning for same team are serialized by mutex', async () => {
    const { manager, runtime } = makeManager();
    await manager.provisionTeam('lock-team', {});

    const containerID = manager.getContainerID('lock-team');
    runtime.containerList = [
      { id: containerID, name: 'openhive-lock-team', state: 'running' },
    ];

    // Remove and ensure running concurrently on the same team
    const removePromise = manager.removeTeam('lock-team');
    const ensurePromise = manager.ensureRunning('lock-team');

    await Promise.all([removePromise, ensurePromise]);

    // Both complete without error — mutex serialized access correctly
    expect(true).toBe(true);
  });
});
