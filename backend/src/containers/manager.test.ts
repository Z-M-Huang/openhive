/**
 * Tests for ContainerManagerImpl.
 *
 * Mocks ContainerRuntime, TokenManager, and EventBus to verify lifecycle
 * coordination, event publication, deletion guard, and cleanup logic.
 *
 * @module containers/manager.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContainerManagerImpl } from './manager.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { ContainerHealth } from '../domain/enums.js';
import type {
  ContainerRuntime,
  ContainerConfig,
  ContainerInfo,
  TokenManager,
  EventBus,
  BusEvent,
} from '../domain/interfaces.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeContainerInfo(slug: string, overrides?: Partial<ContainerInfo>): ContainerInfo {
  return {
    id: `cid-${slug}`,
    name: `openhive-${slug}`,
    state: 'running',
    teamSlug: slug,
    tid: `tid-${slug}-abc123`,
    health: ContainerHealth.Running,
    createdAt: Date.now(),
    ...overrides,
  };
}

function createMockRuntime(): ContainerRuntime & { _calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {
    createContainer: [],
    startContainer: [],
    stopContainer: [],
    removeContainer: [],
    inspectContainer: [],
    listContainers: [],
  };

  return {
    _calls: calls,
    createContainer: vi.fn(async (config: ContainerConfig) => {
      calls.createContainer.push([config]);
      return `cid-${config.teamSlug}`;
    }),
    startContainer: vi.fn(async (id: string) => {
      calls.startContainer.push([id]);
    }),
    stopContainer: vi.fn(async (id: string, timeout: number) => {
      calls.stopContainer.push([id, timeout]);
    }),
    removeContainer: vi.fn(async (id: string) => {
      calls.removeContainer.push([id]);
    }),
    inspectContainer: vi.fn(async (id: string) => {
      const slug = id.replace('cid-', '');
      return makeContainerInfo(slug);
    }),
    listContainers: vi.fn(async () => [] as ContainerInfo[]),
  };
}

function createMockTokenManager(): TokenManager {
  let counter = 0;
  return {
    generate: vi.fn((tid: string) => `token-${tid}-${++counter}`),
    validate: vi.fn(() => true),
    revoke: vi.fn(),
    revokeAll: vi.fn(),
    startCleanup: vi.fn(),
    stopCleanup: vi.fn(),
    generateSession: vi.fn((tid: string) => `session-${tid}-${++counter}`),
    validateSession: vi.fn(() => true),
    revokeSessionsForTid: vi.fn(),
    revokeSession: vi.fn(),
  };
}

function createMockEventBus(): EventBus & { _events: BusEvent[] } {
  const events: BusEvent[] = [];
  return {
    _events: events,
    publish: vi.fn((event: BusEvent) => {
      events.push(event);
    }),
    subscribe: vi.fn(() => 'sub-1'),
    filteredSubscribe: vi.fn(() => 'sub-2'),
    unsubscribe: vi.fn(),
    close: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ContainerManagerImpl', () => {
  let runtime: ReturnType<typeof createMockRuntime>;
  let tokenManager: ReturnType<typeof createMockTokenManager>;
  let eventBus: ReturnType<typeof createMockEventBus>;
  let manager: ContainerManagerImpl;

  beforeEach(() => {
    runtime = createMockRuntime();
    tokenManager = createMockTokenManager();
    eventBus = createMockEventBus();
    manager = new ContainerManagerImpl(runtime, tokenManager, eventBus, undefined, {
      image: 'openhive',
      network: 'openhive-network',
      workspaceRoot: '/app/workspace',
      rootHost: 'root',
    });
  });

  // -------------------------------------------------------------------------
  // spawnTeamContainer
  // -------------------------------------------------------------------------

  describe('spawnTeamContainer()', () => {
    it('generates a WS token, creates and starts the container', async () => {
      const info = await manager.spawnTeamContainer('weather-team');

      expect(tokenManager.generate).toHaveBeenCalledTimes(1);
      expect(runtime.createContainer).toHaveBeenCalledTimes(1);
      expect(runtime.startContainer).toHaveBeenCalledTimes(1);

      // Verify the ContainerConfig passed to runtime
      const config = (runtime.createContainer as ReturnType<typeof vi.fn>).mock.calls[0][0] as ContainerConfig;
      expect(config.teamSlug).toBe('weather-team');
      expect(config.image).toBe('openhive');
      expect(config.networkMode).toBe('openhive-network');
      expect(config.workspacePath).toBe('/app/workspace/teams/weather-team');
      expect(config.env.OPENHIVE_WS_TOKEN).toBeDefined();
      expect(config.env.OPENHIVE_TEAM_TID).toMatch(/^tid-weather-team-/);
      expect(config.env.OPENHIVE_ROOT_HOST).toBe('root');

      // Verify returned ContainerInfo
      expect(info.teamSlug).toBe('weather-team');
      expect(info.state).toBe('running');
    });

    it('publishes container.spawned event', async () => {
      await manager.spawnTeamContainer('event-team');

      expect(eventBus._events).toHaveLength(1);
      const event = eventBus._events[0];
      expect(event.type).toBe('container.spawned');
      expect(event.data.slug).toBe('event-team');
      expect(event.data.containerId).toBe('cid-event-team');
      expect(event.source).toBe('container-manager');
    });

    it('rejects duplicate slug with ConflictError', async () => {
      await manager.spawnTeamContainer('dup-team');

      await expect(manager.spawnTeamContainer('dup-team')).rejects.toThrow(ConflictError);
      await expect(manager.spawnTeamContainer('dup-team')).rejects.toThrow(/already exists/);
    });
  });

  // -------------------------------------------------------------------------
  // stopTeamContainer
  // -------------------------------------------------------------------------

  describe('stopTeamContainer()', () => {
    it('stops, removes, and publishes container.stopped event', async () => {
      await manager.spawnTeamContainer('stop-team');
      eventBus._events.length = 0; // clear spawn event

      await manager.stopTeamContainer('stop-team', 'user request');

      expect(runtime.stopContainer).toHaveBeenCalledWith('cid-stop-team', 30_000);
      expect(runtime.removeContainer).toHaveBeenCalledWith('cid-stop-team');

      expect(eventBus._events).toHaveLength(1);
      const event = eventBus._events[0];
      expect(event.type).toBe('container.stopped');
      expect(event.data.slug).toBe('stop-team');
      expect(event.data.reason).toBe('user request');
    });

    it('throws NotFoundError for unknown slug', async () => {
      await expect(manager.stopTeamContainer('ghost', 'test')).rejects.toThrow(NotFoundError);
    });

    it('removes slug from internal map after stop', async () => {
      await manager.spawnTeamContainer('cleanup-test');
      await manager.stopTeamContainer('cleanup-test', 'done');

      const info = await manager.getContainerByTeam('cleanup-test');
      expect(info).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Deletion guard
  // -------------------------------------------------------------------------

  describe('deletion guard', () => {
    it('prevents infinite recursion when re-entering stopTeamContainer for same slug', async () => {
      await manager.spawnTeamContainer('guard-team');

      // Simulate re-entrant stop by making stopContainer call stopTeamContainer again
      let reentrantCalled = false;
      (runtime.stopContainer as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        if (!reentrantCalled) {
          reentrantCalled = true;
          // Re-entrant call — should be a no-op due to deletion guard
          await manager.stopTeamContainer('guard-team', 'recursive');
        }
      });

      // Should not throw or infinite-loop
      await manager.stopTeamContainer('guard-team', 'cascade');

      // stopContainer was called once by the outer call only
      expect(runtime.stopContainer).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // restartTeamContainer
  // -------------------------------------------------------------------------

  describe('restartTeamContainer()', () => {
    it('calls stop then spawn', async () => {
      await manager.spawnTeamContainer('restart-team');
      eventBus._events.length = 0;

      await manager.restartTeamContainer('restart-team', 'health recovery');

      // Should have both stopped and spawned events
      const types = eventBus._events.map((e) => e.type);
      expect(types).toContain('container.stopped');
      expect(types).toContain('container.spawned');

      // Container should be queryable after restart
      const info = await manager.getContainerByTeam('restart-team');
      expect(info).toBeDefined();
    });

    it('publishes container.restarted event with oldTid', async () => {
      await manager.spawnTeamContainer('restart-event-team');
      eventBus._events.length = 0;

      await manager.restartTeamContainer('restart-event-team', 'api_restart');

      const restartedEvt = eventBus._events.find((e) => e.type === 'container.restarted');
      expect(restartedEvt).toBeDefined();
      expect(restartedEvt!.data.slug).toBe('restart-event-team');
      expect(restartedEvt!.data.reason).toBe('api_restart');
      // oldTid should be a non-empty string (the TID from before the restart)
      expect(typeof restartedEvt!.data.oldTid).toBe('string');
      expect((restartedEvt!.data.oldTid as string).length).toBeGreaterThan(0);
    });

    it('revokes sessions for old TID before spawning fresh container', async () => {
      await manager.spawnTeamContainer('revoke-tid-team');

      await manager.restartTeamContainer('revoke-tid-team', 'test');

      expect(tokenManager.revokeSessionsForTid).toHaveBeenCalledTimes(1);
    });

    it('throws ValidationError for invalid slug format', async () => {
      await expect(manager.restartTeamContainer('INVALID_SLUG', 'test')).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for slug shorter than 3 chars', async () => {
      await expect(manager.restartTeamContainer('ab', 'test')).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for slug longer than 63 chars', async () => {
      const longSlug = 'a'.repeat(64);
      await expect(manager.restartTeamContainer(longSlug, 'test')).rejects.toThrow(ValidationError);
    });

    it('throws ConflictError when restart is already in progress for the same slug', async () => {
      await manager.spawnTeamContainer('concurrent-restart');

      // Simulate restart in-progress by making stopTeamContainer hang
      let resolveStop!: () => void;
      const stopPromise = new Promise<void>((resolve) => { resolveStop = resolve; });
      (runtime.stopContainer as ReturnType<typeof vi.fn>).mockImplementation(() => stopPromise);

      const firstRestart = manager.restartTeamContainer('concurrent-restart', 'first');

      // Give the first restart time to add slug to restartingSet
      await Promise.resolve();

      // Second restart should throw ConflictError immediately
      await expect(manager.restartTeamContainer('concurrent-restart', 'second')).rejects.toThrow(ConflictError);
      await expect(manager.restartTeamContainer('concurrent-restart', 'second')).rejects.toThrow(/in progress/);

      // Clean up by resolving the first restart
      resolveStop();
      await firstRestart.catch(() => {}); // may fail since stop was hung, that's fine for this test
    });

    it('removes slug from restartingSet even if restart fails', async () => {
      await manager.spawnTeamContainer('fail-restart-team');

      // Make stop throw
      (runtime.stopContainer as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Docker error'));

      await expect(manager.restartTeamContainer('fail-restart-team', 'test')).rejects.toThrow('Docker error');

      // After failure, restartingSet should be cleared so a subsequent restart can proceed
      // (it won't succeed here because the container was removed from map during failed stop path,
      // but we can verify ConflictError is NOT thrown)
      await expect(manager.restartTeamContainer('fail-restart-team', 'test')).rejects.not.toThrow(ConflictError);
    });
  });

  // -------------------------------------------------------------------------
  // getRestartCount
  // -------------------------------------------------------------------------

  describe('getRestartCount()', () => {
    it('returns 0 for a team that has never been restarted', () => {
      expect(manager.getRestartCount('never-restarted')).toBe(0);
    });

    it('increments restart count after each successful restart', async () => {
      await manager.spawnTeamContainer('count-team');
      expect(manager.getRestartCount('count-team')).toBe(0);

      await manager.restartTeamContainer('count-team', 'test');
      expect(manager.getRestartCount('count-team')).toBe(1);

      await manager.restartTeamContainer('count-team', 'test');
      expect(manager.getRestartCount('count-team')).toBe(2);
    });

    it('does NOT increment count when restart fails during stop', async () => {
      await manager.spawnTeamContainer('fail-count-team');
      (runtime.stopContainer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('stop failed'));

      await expect(manager.restartTeamContainer('fail-count-team', 'test')).rejects.toThrow();
      expect(manager.getRestartCount('fail-count-team')).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // getContainerByTeam
  // -------------------------------------------------------------------------

  describe('getContainerByTeam()', () => {
    it('returns ContainerInfo for known slug', async () => {
      await manager.spawnTeamContainer('lookup-team');
      const info = await manager.getContainerByTeam('lookup-team');

      expect(info).toBeDefined();
      expect(info!.teamSlug).toBe('lookup-team');
    });

    it('returns undefined for unknown slug', async () => {
      const info = await manager.getContainerByTeam('no-such-team');
      expect(info).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // listRunningContainers
  // -------------------------------------------------------------------------

  describe('listRunningContainers()', () => {
    it('delegates to runtime.listContainers()', async () => {
      const mockList = [makeContainerInfo('team-a'), makeContainerInfo('team-b')];
      (runtime.listContainers as ReturnType<typeof vi.fn>).mockResolvedValue(mockList);

      const result = await manager.listRunningContainers();

      expect(runtime.listContainers).toHaveBeenCalled();
      expect(result).toHaveLength(2);
      expect(result[0].teamSlug).toBe('team-a');
      expect(result[1].teamSlug).toBe('team-b');
    });
  });

  // -------------------------------------------------------------------------
  // cleanupStoppedContainers
  // -------------------------------------------------------------------------

  describe('cleanupStoppedContainers()', () => {
    it('removes only stopped containers', async () => {
      (runtime.listContainers as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeContainerInfo('running-team', { state: 'running' }),
        makeContainerInfo('exited-team', { state: 'exited' }),
        makeContainerInfo('dead-team', { state: 'dead' }),
      ]);

      const count = await manager.cleanupStoppedContainers();

      expect(count).toBe(2);
      expect(runtime.removeContainer).toHaveBeenCalledWith('cid-exited-team');
      expect(runtime.removeContainer).toHaveBeenCalledWith('cid-dead-team');
      expect(runtime.removeContainer).not.toHaveBeenCalledWith('cid-running-team');
    });

    it('returns 0 when all containers are running', async () => {
      (runtime.listContainers as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeContainerInfo('team-a', { state: 'running' }),
      ]);

      const count = await manager.cleanupStoppedContainers();
      expect(count).toBe(0);
    });

    it('cleans up internal map entries for stopped containers', async () => {
      // Spawn a container so it's in the internal map
      await manager.spawnTeamContainer('will-die');

      // Now simulate that container showing up as exited in Docker
      (runtime.listContainers as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeContainerInfo('will-die', { state: 'exited' }),
      ]);

      await manager.cleanupStoppedContainers();

      // Internal map should be cleaned up
      const info = await manager.getContainerByTeam('will-die');
      expect(info).toBeUndefined();
    });
  });
});
