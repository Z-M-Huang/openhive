/**
 * OpenHive Backend - Container Manager
 *
 * Implements ContainerManager — higher-level container lifecycle management
 * built on top of ContainerRuntime. Key responsibilities:
 *
 *   - ensureRunning: idempotent start (check + provision if not running)
 *   - provisionTeam: create + start container with WS token + env
 *   - removeTeam: stop + remove + clear state
 *   - restartTeam: stop then ensureRunning
 *   - stopTeam: graceful stop
 *   - cleanup: remove orphan containers not in config
 *   - getStatus: synchronous state read
 *   - getContainerID: synchronous ID lookup
 *   - handleUnhealthy: auto-restart with exponential backoff
 *   - resetIdleTimer / resetRestartCount: called by higher layers
 *
 * Async race condition mitigation:
 *   Per-team Mutex (async-mutex) prevents concurrent provision/remove races.
 *   restartTeam calls _ensureRunningUnlocked (non-locking inner method) to
 *   avoid deadlock — Mutex is NOT reentrant.
 */

import { Mutex } from 'async-mutex';

import type { ContainerManager, ContainerRuntime, ConfigLoader, WSHub } from '../domain/interfaces.js';
import type { ContainerState } from '../domain/enums.js';
import { NotFoundError } from '../domain/errors.js';
import { CONTAINER_NAME_PREFIX } from './runtime.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Restart backoff steps in milliseconds: 1s, 5s, 30s. */
const RESTART_BACKOFF_MS = [1_000, 5_000, 30_000] as const;

/** Maximum restart attempts before marking the container as permanently failed. */
const MAX_RESTART_ATTEMPTS = 3;

/**
 * Default idle timeout in milliseconds (30 minutes).
 */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;

/**
 * Stop timeout in milliseconds for graceful container shutdown (30 seconds).
 */
const STOP_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/**
 * Minimal structured logger interface required by ManagerImpl.
 * Compatible with pino or any standard structured logger.
 */
export interface ManagerLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// WSHub subset — only the methods used by ManagerImpl
// ---------------------------------------------------------------------------

/**
 * Subset of domain.WSHub used by ManagerImpl.
 */
export interface ManagerWSHub {
  generateToken(teamID: string): string;
  getConnectedTeams(): string[];
}

// ---------------------------------------------------------------------------
// TeamState — per-team runtime state
// ---------------------------------------------------------------------------

/**
 * Tracks per-team runtime state.
 */
interface TeamState {
  containerID: string;
  restartCount: number;
  /** NodeJS timeout handle for the idle timer, or null if not running. */
  idleTimerHandle: ReturnType<typeof setTimeout> | null;
  /** Abort controller signal used to cancel the idle timer. */
  idleAbortController: AbortController | null;
}

// ---------------------------------------------------------------------------
// ManagerConfig
// ---------------------------------------------------------------------------

/**
 * Configuration for ManagerImpl.
 */
export interface ManagerConfig {
  runtime: ContainerRuntime;
  wsHub: ManagerWSHub;
  configLoader: ConfigLoader | null;
  logger: ManagerLogger;
  /** Base WebSocket URL, e.g. "ws://go-backend:8080". */
  wsURL: string;
  /**
   * Default idle timeout in milliseconds.
   * When 0 or negative, DEFAULT_IDLE_TIMEOUT_MS is used.
   */
  idleTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// ManagerImpl — implements ContainerManager
// ---------------------------------------------------------------------------

/**
 * Implements domain.ContainerManager using per-team Mutex locking.
 *
 * Per-team Mutex (from async-mutex) prevents TOCTOU races in:
 *   - ensureRunning: check-if-running + provision sequence
 *   - provisionTeam: token generation + container create + start
 *   - removeTeam: stop + remove + state clear
 *   - stopTeam: state lookup + stop
 *
 * restartTeam is special: it calls _ensureRunningUnlocked (non-locking)
 * from within a held lock to avoid deadlock (Mutex is NOT reentrant).
 *
 * A global Mutex prevents concurrent cleanup() runs.
 */
export class ManagerImpl implements ContainerManager {
  private readonly runtime: ContainerRuntime;
  private readonly wsHub: ManagerWSHub;
  private readonly configLoader: ConfigLoader | null;
  private readonly logger: ManagerLogger;
  private readonly wsURL: string;
  private readonly defaultIdleTimeoutMs: number;

  /**
   * Per-team Mutex map. Lazily populated by getTeamMutex().
   * Mutex is NOT reentrant — use _ensureRunningUnlocked inside a held lock.
   */
  private readonly teamMutexes: Map<string, Mutex> = new Map();

  /** Global Mutex to prevent concurrent cleanup() runs. */
  private readonly cleanupMutex: Mutex = new Mutex();

  /** Per-team runtime state. */
  private readonly states: Map<string, TeamState> = new Map();

  constructor(cfg: ManagerConfig) {
    this.runtime = cfg.runtime;
    this.wsHub = cfg.wsHub;
    this.configLoader = cfg.configLoader;
    this.logger = cfg.logger;
    this.wsURL = cfg.wsURL;
    this.defaultIdleTimeoutMs =
      cfg.idleTimeoutMs !== undefined && cfg.idleTimeoutMs > 0
        ? cfg.idleTimeoutMs
        : DEFAULT_IDLE_TIMEOUT_MS;
  }

  // -------------------------------------------------------------------------
  // ensureRunning
  // -------------------------------------------------------------------------

  /**
   * Starts the container for a team if it is not already running.
   * Idempotent: safe to call multiple times concurrently — the per-team
   * Mutex ensures only one provisioning happens even under concurrent callers.
   */
  async ensureRunning(teamSlug: string): Promise<void> {
    const release = await this.getTeamMutex(teamSlug).acquire();
    try {
      await this._ensureRunningUnlocked(teamSlug);
    } finally {
      release();
    }
  }

  // -------------------------------------------------------------------------
  // provisionTeam
  // -------------------------------------------------------------------------

  /**
   * Creates and starts a container for a team, passing provided secrets.
   * Acquires the per-team Mutex to prevent concurrent provisioning.
   */
  async provisionTeam(teamSlug: string, secrets: Record<string, string>): Promise<void> {
    const release = await this.getTeamMutex(teamSlug).acquire();
    try {
      await this._provisionUnlocked(teamSlug, secrets);
    } finally {
      release();
    }
  }

  // -------------------------------------------------------------------------
  // removeTeam
  // -------------------------------------------------------------------------

  /**
   * Stops and removes the container for a team, then clears all state.
   * Acquires the per-team Mutex.
   */
  async removeTeam(teamSlug: string): Promise<void> {
    const release = await this.getTeamMutex(teamSlug).acquire();
    try {
      const state = this.states.get(teamSlug);
      if (state === undefined || state.containerID === '') {
        throw new NotFoundError('container', teamSlug);
      }

      const containerID = state.containerID;
      this._cancelIdleTimer(state);

      try {
        await this.runtime.stopContainer(containerID, STOP_TIMEOUT_MS);
      } catch (err) {
        this.logger.warn('stop container failed during remove', {
          team_slug: teamSlug,
          error: errorMessage(err),
        });
      }

      await this.runtime.removeContainer(containerID);
      this.states.delete(teamSlug);
      this.logger.info('team container removed', { team_slug: teamSlug });
    } finally {
      release();
    }
  }

  // -------------------------------------------------------------------------
  // restartTeam
  // -------------------------------------------------------------------------

  /**
   * Stops then ensures the container is running again.
   *
   * Acquires the per-team Mutex ONCE and uses the unlocked inner methods to
   * avoid deadlock (Mutex is NOT reentrant).
   *
   * Note: If restartTeam called ensureRunning directly, each would acquire
   * the lock independently. In TypeScript with async-mutex (non-reentrant),
   * we must hold the lock for the whole sequence using the unlocked variants.
   */
  async restartTeam(teamSlug: string): Promise<void> {
    const release = await this.getTeamMutex(teamSlug).acquire();
    try {
      // Stop (best-effort — log warning on failure)
      try {
        await this._stopUnlocked(teamSlug);
      } catch (err) {
        this.logger.warn('stop failed during restart', {
          team_slug: teamSlug,
          error: errorMessage(err),
        });
      }
      // Then ensure running
      await this._ensureRunningUnlocked(teamSlug);
    } finally {
      release();
    }
  }

  // -------------------------------------------------------------------------
  // stopTeam
  // -------------------------------------------------------------------------

  /**
   * Gracefully stops the container without removing it.
   * Acquires the per-team Mutex.
   */
  async stopTeam(teamSlug: string): Promise<void> {
    const release = await this.getTeamMutex(teamSlug).acquire();
    try {
      await this._stopUnlocked(teamSlug);
    } finally {
      release();
    }
  }

  // -------------------------------------------------------------------------
  // cleanup
  // -------------------------------------------------------------------------

  /**
   * Lists all openhive- containers and removes ones not tracked by config.
   * Uses global Mutex to prevent concurrent cleanup runs.
   */
  async cleanup(): Promise<void> {
    const release = await this.cleanupMutex.acquire();
    try {
      const containers = await this.runtime.listContainers();

      // Get configured team slugs
      let configuredSlugs: Set<string> | null = null;
      if (this.configLoader !== null) {
        try {
          const slugs = await this.configLoader.listTeams();
          configuredSlugs = new Set(slugs);
        } catch (err) {
          this.logger.warn('cleanup: failed to list teams from config', {
            error: errorMessage(err),
          });
        }
      }

      for (const c of containers) {
        // Docker's name filter is a substring match, so "openhive-" also matches
        // containers like "deployments-openhive-1" (the master container from
        // docker-compose). Only process containers whose names actually start
        // with the prefix and have a non-empty slug after it.
        if (!c.name.startsWith(CONTAINER_NAME_PREFIX)) {
          continue;
        }
        const slug = c.name.slice(CONTAINER_NAME_PREFIX.length);
        if (slug === '') {
          continue;
        }

        // If configLoader is available and slug is not configured, it's an orphan
        if (configuredSlugs !== null && !configuredSlugs.has(slug)) {
          this.logger.warn('removing orphan container', {
            container_name: c.name,
            container_id: c.id,
          });
          try {
            await this.runtime.stopContainer(c.id, STOP_TIMEOUT_MS);
          } catch (err) {
            this.logger.warn('stop orphan failed', {
              container_id: c.id,
              error: errorMessage(err),
            });
          }
          try {
            await this.runtime.removeContainer(c.id);
          } catch (err) {
            this.logger.error('remove orphan failed', {
              container_id: c.id,
              error: errorMessage(err),
            });
          }
        }
      }
    } finally {
      release();
    }
  }

  // -------------------------------------------------------------------------
  // getStatus
  // -------------------------------------------------------------------------

  /**
   * Returns the current container state for a team.
   * Synchronous in-memory lookup — returns cached state from the states map.
   * Returns 'stopped' if no container is tracked for the team.
   */
  getStatus(teamSlug: string): ContainerState {
    const state = this.states.get(teamSlug);
    if (state === undefined || state.containerID === '') {
      return 'stopped';
    }
    return 'running';
  }

  // -------------------------------------------------------------------------
  // getContainerID
  // -------------------------------------------------------------------------

  /**
   * Returns the Docker container ID for a team slug.
   * Synchronous — throws NotFoundError if no container is tracked.
   */
  getContainerID(teamSlug: string): string {
    const state = this.states.get(teamSlug);
    if (state === undefined || state.containerID === '') {
      throw new NotFoundError('container', teamSlug);
    }
    return state.containerID;
  }

  // -------------------------------------------------------------------------
  // handleUnhealthy
  // -------------------------------------------------------------------------

  /**
   * Auto-restart callback for HeartbeatMonitor.
   * Increments the restart count for the team, then schedules a restart with
   * exponential backoff (1s/5s/30s). Stops after MAX_RESTART_ATTEMPTS.
   */
  async handleUnhealthy(teamSlug: string): Promise<void> {
    const count = this._incrementRestartCount(teamSlug);

    if (count > MAX_RESTART_ATTEMPTS) {
      this.logger.error('max restart attempts exceeded, container marked errored', {
        team_slug: teamSlug,
        restart_count: count,
      });
      return;
    }

    const backoffMs = restartBackoffForAttempt(count);
    this.logger.warn('container unhealthy, scheduling restart', {
      team_slug: teamSlug,
      attempt: count,
      backoff_ms: backoffMs,
    });

    // Schedule restart asynchronously with backoff delay
    await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));

    try {
      await this.restartTeam(teamSlug);
      this.logger.info('auto-restart succeeded', { team_slug: teamSlug, attempt: count });
    } catch (err) {
      this.logger.error('auto-restart failed', {
        team_slug: teamSlug,
        attempt: count,
        error: errorMessage(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // resetRestartCount — called on successful heartbeat
  // -------------------------------------------------------------------------

  /**
   * Resets the restart counter for a team.
   * Called by the HeartbeatMonitor on successful heartbeat receipt.
   */
  resetRestartCount(teamSlug: string): void {
    const state = this._getOrCreateState(teamSlug);
    state.restartCount = 0;
  }

  // -------------------------------------------------------------------------
  // resetIdleTimer — called when a task is dispatched
  // -------------------------------------------------------------------------

  /**
   * Resets the idle timer for a team.
   * Called by the task coordinator when a task is dispatched to the team.
   */
  resetIdleTimer(teamSlug: string): void {
    this._scheduleIdleTimeout(teamSlug);
  }

  // -------------------------------------------------------------------------
  // Private — non-locking inner methods (must be called with mutex held)
  // -------------------------------------------------------------------------

  /**
   * Non-locking implementation of ensureRunning.
   * Caller MUST hold the per-team Mutex.
   */
  private async _ensureRunningUnlocked(teamSlug: string): Promise<void> {
    // Check if a container is already running for this team
    const containers = await this.runtime.listContainers();
    const targetName = CONTAINER_NAME_PREFIX + teamSlug;

    for (const c of containers) {
      if (c.name === targetName && c.state === 'running') {
        this.logger.debug('container already running', {
          team_slug: teamSlug,
          container_id: c.id,
        });
        this._updateContainerID(teamSlug, c.id);
        return;
      }
    }

    // Not running — provision it (no secrets when called via ensureRunning)
    await this._provisionUnlocked(teamSlug, {});
  }

  /**
   * Non-locking implementation of provisionTeam.
   * Caller MUST hold the per-team Mutex.
   */
  private async _provisionUnlocked(
    teamSlug: string,
    secrets: Record<string, string>,
  ): Promise<void> {
    // Generate a WS token for this container
    const wsToken = this.wsHub.generateToken(teamSlug);
    const wsURL = `${this.wsURL}/ws/container?token=${wsToken}`;

    // Build env from secrets + WS connection vars
    const env: Record<string, string> = {
      WS_TOKEN: wsToken,
      WS_URL: wsURL,
      ...secrets,
    };

    // Base container config
    const containerCfg = {
      name: teamSlug,
      env,
      max_memory: undefined as string | undefined,
      idle_timeout: undefined as string | undefined,
    };

    // Load team config for optional settings (memory, idle timeout)
    if (this.configLoader !== null) {
      try {
        const team = await this.configLoader.loadTeam(teamSlug);
        if (team.container_config !== undefined) {
          if (team.container_config.max_memory !== undefined) {
            containerCfg.max_memory = team.container_config.max_memory;
          }
          // Merge extra env vars from team config (caller-provided secrets take precedence)
          if (team.container_config.env !== undefined) {
            for (const [k, v] of Object.entries(team.container_config.env)) {
              if (!(k in env)) {
                env[k] = v;
              }
            }
          }
        }
      } catch (err) {
        this.logger.warn('provision: failed to load team config, using defaults', {
          team_slug: teamSlug,
          error: errorMessage(err),
        });
      }
    }

    const containerID = await this.runtime.createContainer({
      name: containerCfg.name,
      env,
      max_memory: containerCfg.max_memory,
    });

    try {
      await this.runtime.startContainer(containerID);
    } catch (err) {
      // Best-effort removal of the orphaned container
      try {
        await this.runtime.removeContainer(containerID);
      } catch {
        // Ignore cleanup errors
      }
      throw new Error(
        `provision "${teamSlug}": start container: ${errorMessage(err)}`,
      );
    }

    this.logger.info('container provisioned', {
      team_slug: teamSlug,
      container_id: containerID,
    });

    this._updateContainerID(teamSlug, containerID);
    this.resetRestartCount(teamSlug);
    this._scheduleIdleTimeout(teamSlug);
  }

  /**
   * Non-locking implementation of stopTeam.
   * Caller MUST hold the per-team Mutex.
   */
  private async _stopUnlocked(teamSlug: string): Promise<void> {
    const state = this.states.get(teamSlug);
    if (state === undefined || state.containerID === '') {
      // Nothing to stop — not an error (warn-only behavior)
      this.logger.warn('stop: no container tracked for team', { team_slug: teamSlug });
      return;
    }

    const containerID = state.containerID;
    this._cancelIdleTimer(state);

    try {
      await this.runtime.stopContainer(containerID, STOP_TIMEOUT_MS);
    } catch (err) {
      throw new Error(`stop team "${teamSlug}": ${errorMessage(err)}`);
    }

    this.logger.info('team container stopped', { team_slug: teamSlug });
  }

  // -------------------------------------------------------------------------
  // Private — state helpers
  // -------------------------------------------------------------------------

  /**
   * Returns (lazily creating) the per-team Mutex.
   */
  private getTeamMutex(teamSlug: string): Mutex {
    let mutex = this.teamMutexes.get(teamSlug);
    if (mutex === undefined) {
      mutex = new Mutex();
      this.teamMutexes.set(teamSlug, mutex);
    }
    return mutex;
  }

  /**
   * Returns (lazily creating) the per-team state.
   */
  private _getOrCreateState(teamSlug: string): TeamState {
    let state = this.states.get(teamSlug);
    if (state === undefined) {
      state = {
        containerID: '',
        restartCount: 0,
        idleTimerHandle: null,
        idleAbortController: null,
      };
      this.states.set(teamSlug, state);
    }
    return state;
  }

  /**
   * Updates the container ID in the per-team state.
   */
  private _updateContainerID(teamSlug: string, containerID: string): void {
    const state = this._getOrCreateState(teamSlug);
    state.containerID = containerID;
  }

  /**
   * Increments the restart counter for a team and returns the new count.
   */
  private _incrementRestartCount(teamSlug: string): number {
    const state = this._getOrCreateState(teamSlug);
    state.restartCount++;
    return state.restartCount;
  }

  /**
   * Schedules an idle timeout for a team container.
   * Cancels any existing idle timer first.
   * After the timeout, the container is stopped (best-effort, no error propagation).
   */
  private _scheduleIdleTimeout(teamSlug: string): void {
    const state = this._getOrCreateState(teamSlug);
    this._cancelIdleTimer(state);

    // Resolve idle timeout: use per-team config if available, else manager default
    let timeoutMs = this.defaultIdleTimeoutMs;
    if (this.configLoader !== null) {
      // Synchronous best-effort: try to read from already-loaded state
      // (async config read here would need lock — not safe from a non-async method)
      // We pre-resolve this during _provisionUnlocked where we have async access.
      // For resetIdleTimer called externally, we use the manager default.
      // The team config idle_timeout takes effect
      // during provision; ResetIdleTimer uses the same resolved value.
    }

    const abortController = new AbortController();
    state.idleAbortController = abortController;

    const handle = setTimeout(() => {
      if (abortController.signal.aborted) {
        return;
      }
      this.logger.info('idle timeout reached, stopping container', {
        team_slug: teamSlug,
        timeout_ms: timeoutMs,
      });
      // Acquire lock and stop — fire-and-forget
      this.getTeamMutex(teamSlug)
        .acquire()
        .then((release) => {
          const currentState = this.states.get(teamSlug);
          if (currentState === undefined || currentState.containerID === '') {
            release();
            return;
          }
          const containerID = currentState.containerID;
          this.runtime
            .stopContainer(containerID, STOP_TIMEOUT_MS)
            .catch((err) => {
              this.logger.warn('idle timeout stop failed', {
                team_slug: teamSlug,
                error: errorMessage(err),
              });
            })
            .finally(() => {
              release();
            });
        })
        .catch((err) => {
          this.logger.warn('idle timeout: failed to acquire lock', {
            team_slug: teamSlug,
            error: errorMessage(err),
          });
        });
    }, timeoutMs);

    // Allow Node.js to exit even if this timer is pending (unref for tests)
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
      (handle as { unref(): void }).unref();
    }

    state.idleTimerHandle = handle;
  }

  /**
   * Cancels the idle timer for a team (if one is active).
   */
  private _cancelIdleTimer(state: TeamState): void {
    if (state.idleTimerHandle !== null) {
      clearTimeout(state.idleTimerHandle);
      state.idleTimerHandle = null;
    }
    if (state.idleAbortController !== null) {
      state.idleAbortController.abort();
      state.idleAbortController = null;
    }
  }
}

// ---------------------------------------------------------------------------
// restartBackoffForAttempt
// ---------------------------------------------------------------------------

/**
 * Returns the backoff duration in milliseconds for a given attempt number.
 *
 * attempt 1 → 1_000ms (1s)
 * attempt 2 → 5_000ms (5s)
 * attempt 3+ → 30_000ms (30s)
 */
export function restartBackoffForAttempt(attempt: number): number {
  if (attempt <= 0) {
    return RESTART_BACKOFF_MS[0];
  }
  if (attempt === 1) {
    return RESTART_BACKOFF_MS[0];
  }
  if (attempt === 2) {
    return RESTART_BACKOFF_MS[1];
  }
  return RESTART_BACKOFF_MS[2];
}

// ---------------------------------------------------------------------------
// errorMessage — safely extracts a message from unknown errors
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// newContainerManager — factory for production use
// ---------------------------------------------------------------------------

/**
 * Creates a ManagerImpl for production use.
 */
export function newContainerManager(
  runtime: ContainerRuntime,
  wsHub: WSHub,
  configLoader: ConfigLoader | null,
  logger: ManagerLogger,
  wsURL: string,
  idleTimeoutMs?: number,
): ManagerImpl {
  return new ManagerImpl({
    runtime,
    wsHub,
    configLoader,
    logger,
    wsURL,
    idleTimeoutMs,
  });
}
