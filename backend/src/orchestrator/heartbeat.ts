/**
 * OpenHive Backend - Heartbeat Monitor
 *
 * Implements HeartbeatMonitor — tracks container health via heartbeat messages,
 * detects unhealthy containers after a configurable timeout, and triggers
 * callbacks. Uses setInterval-based health checking.
 *
 * Key design choices:
 *   - Uses a plain Map<string, HeartbeatStatus> (single-threaded, no races).
 *   - Boolean 'started' flag ensures startMonitoring() is idempotent.
 *   - setInterval fires on the event loop for periodic checks.
 *   - Startup jitter: random delay [0, maxJitterMs) before the interval starts.
 *     Disabled (0) when constructed with newHeartbeatMonitorWithIntervals().
 *   - The test helper injectStaleStatus() backdates lastSeen to force detection.
 */

import type { HeartbeatMonitor } from '../domain/interfaces.js';
import type { AgentHeartbeatStatus, HeartbeatStatus } from '../domain/types.js';
import type { EventBus } from '../domain/interfaces.js';
import { NotFoundError } from '../domain/errors.js';
import { validateAgentStatusType } from '../domain/enums.js';
import type { AgentStatus } from '../ws/messages.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default health check interval in milliseconds (30 seconds). */
const DEFAULT_CHECK_INTERVAL_MS = 30_000;

/** Default unhealthy timeout in milliseconds (90 seconds). */
const DEFAULT_UNHEALTHY_TIMEOUT_MS = 90_000;

/** Maximum startup jitter in milliseconds (5 seconds). */
const MAX_JITTER_MS = 5_000;

// ---------------------------------------------------------------------------
// Logger interface — minimal structured logger compatible with pino or stubs
// ---------------------------------------------------------------------------

/**
 * Minimal structured logger interface required by HeartbeatMonitorImpl.
 * Compatible with pino or any standard structured logger.
 */
export interface HeartbeatLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// HeartbeatMonitorImpl
// ---------------------------------------------------------------------------

/**
 * Implements domain.HeartbeatMonitor.
 *
 * Tracks container health by recording heartbeat timestamps. A setInterval
 * ticker periodically calls checkHealth() which marks stale containers
 * unhealthy and fires the onUnhealthy callback + publishes an event.
 */
export class HeartbeatMonitorImpl implements HeartbeatMonitor {
  /** Per-team health status, keyed by teamID. */
  private readonly statuses: Map<string, HeartbeatStatus>;

  /** Callback fired when a team transitions from healthy to unhealthy. */
  private onUnhealthyCallback: ((teamID: string) => void) | null;

  private readonly eventBus: EventBus | null;
  private readonly logger: HeartbeatLogger;

  /** Interval between health checks in milliseconds. */
  private readonly checkIntervalMs: number;

  /** Time without a heartbeat before a container is considered unhealthy, in ms. */
  private readonly unhealthyTimeoutMs: number;

  /** Maximum startup jitter in milliseconds. 0 disables jitter (for tests). */
  private readonly maxJitterMs: number;

  /** Handle for the setInterval ticker, or null if not started. */
  private intervalHandle: ReturnType<typeof setInterval> | null;

  /** Handle for the startup jitter setTimeout, or null if not pending. */
  private jitterHandle: ReturnType<typeof setTimeout> | null;

  /** Prevents startMonitoring() from creating multiple intervals. */
  private started: boolean;

  /** When true, the monitor has been stopped and the interval cleared. */
  private stopped: boolean;

  constructor(
    eventBus: EventBus | null,
    logger: HeartbeatLogger,
    checkIntervalMs: number,
    unhealthyTimeoutMs: number,
    maxJitterMs: number,
  ) {
    this.statuses = new Map();
    this.onUnhealthyCallback = null;
    this.eventBus = eventBus;
    this.logger = logger;
    this.checkIntervalMs = checkIntervalMs;
    this.unhealthyTimeoutMs = unhealthyTimeoutMs;
    this.maxJitterMs = maxJitterMs;
    this.intervalHandle = null;
    this.jitterHandle = null;
    this.started = false;
    this.stopped = false;
  }

  // -------------------------------------------------------------------------
  // processHeartbeat
  // -------------------------------------------------------------------------

  /**
   * Records a heartbeat for the given team. Resets lastSeen to now and marks
   * the team healthy. Publishes a heartbeat_received event.
   */
  processHeartbeat(teamID: string, agents: AgentHeartbeatStatus[]): void {
    const now = new Date();
    const status: HeartbeatStatus = {
      team_id: teamID,
      agents,
      last_seen: now,
      is_healthy: true,
    };

    this.statuses.set(teamID, status);

    this.logger.debug('heartbeat processed', {
      team_id: teamID,
      agent_count: agents.length,
    });

    if (this.eventBus !== null) {
      this.eventBus.publish({
        type: 'heartbeat_received',
        payload: {
          kind: 'heartbeat_received',
          team_id: teamID,
          status,
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // getStatus
  // -------------------------------------------------------------------------

  /**
   * Returns the latest heartbeat status for a team.
   * Throws NotFoundError if the teamID has never sent a heartbeat.
   */
  getStatus(teamID: string): HeartbeatStatus {
    const status = this.statuses.get(teamID);
    if (status === undefined) {
      throw new NotFoundError('heartbeat_status', teamID);
    }
    return status;
  }

  // -------------------------------------------------------------------------
  // getAllStatuses
  // -------------------------------------------------------------------------

  /**
   * Returns a snapshot of all team statuses.
   * The returned object is a shallow copy — callers must not mutate entries.
   */
  getAllStatuses(): Record<string, HeartbeatStatus> {
    const result: Record<string, HeartbeatStatus> = {};
    for (const [teamID, status] of this.statuses) {
      result[teamID] = status;
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // setOnUnhealthy
  // -------------------------------------------------------------------------

  /**
   * Registers a callback to invoke when a team becomes unhealthy.
   * Replaces any previously registered callback.
   */
  setOnUnhealthy(callback: (teamID: string) => void): void {
    this.onUnhealthyCallback = callback;
  }

  // -------------------------------------------------------------------------
  // startMonitoring
  // -------------------------------------------------------------------------

  /**
   * Begins the background health-check ticker.
   * Safe to call multiple times — only the first call takes effect.
   *
   * Applies a startup jitter delay [0, maxJitterMs) before the interval
   * begins, to spread restarts across time. Jitter is 0 in test mode.
   */
  startMonitoring(): void {
    if (this.started || this.stopped) {
      return;
    }
    this.started = true;

    const jitterMs =
      this.maxJitterMs > 0 ? Math.floor(Math.random() * this.maxJitterMs) : 0;

    if (jitterMs === 0) {
      // No jitter — start the interval immediately.
      this.intervalHandle = setInterval(() => {
        this.checkHealth();
      }, this.checkIntervalMs);
    } else {
      // Wait for jitter before starting the interval.
      this.jitterHandle = setTimeout(() => {
        this.jitterHandle = null;
        if (!this.stopped) {
          this.intervalHandle = setInterval(() => {
            this.checkHealth();
          }, this.checkIntervalMs);
        }
      }, jitterMs);
    }
  }

  // -------------------------------------------------------------------------
  // stopMonitoring
  // -------------------------------------------------------------------------

  /**
   * Stops the background health-check ticker.
   * Idempotent — safe to call multiple times.
   */
  stopMonitoring(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;

    if (this.jitterHandle !== null) {
      clearTimeout(this.jitterHandle);
      this.jitterHandle = null;
    }

    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  // -------------------------------------------------------------------------
  // checkHealth (internal)
  // -------------------------------------------------------------------------

  /**
   * Iterates all known team statuses. Marks stale containers unhealthy and
   * fires the onUnhealthy callback + publishes a container_state_changed event.
   * Only fires once per health→unhealthy transition (is_healthy gate).
   */
  checkHealth(): void {
    const now = Date.now();

    for (const [teamID, status] of this.statuses) {
      const ageMs = now - status.last_seen.getTime();

      if (ageMs > this.unhealthyTimeoutMs) {
        if (status.is_healthy) {
          // Transition: healthy → unhealthy. Update the stored status.
          const updated: HeartbeatStatus = {
            ...status,
            is_healthy: false,
          };
          this.statuses.set(teamID, updated);

          this.logger.warn('container heartbeat timeout', {
            team_id: teamID,
            last_seen: status.last_seen.toISOString(),
            threshold_ms: this.unhealthyTimeoutMs,
          });

          // Fire the callback.
          if (this.onUnhealthyCallback !== null) {
            this.onUnhealthyCallback(teamID);
          }

          // Publish a container_state_changed event.
          if (this.eventBus !== null) {
            this.eventBus.publish({
              type: 'container_state_changed',
              payload: {
                kind: 'container_state_changed',
                team_id: teamID,
                state: 'error',
              },
            });
          }
        }
        // If already unhealthy, do nothing (no repeat callback).
      }
    }
  }

  // -------------------------------------------------------------------------
  // clearAll
  // -------------------------------------------------------------------------

  /**
   * Clears all cached heartbeat statuses.
   * Called during startup recovery so containers are re-evaluated fresh.
   */
  clearAll(): void {
    this.statuses.clear();
  }

  // -------------------------------------------------------------------------
  // injectStaleStatus (test helper)
  // -------------------------------------------------------------------------

  /**
   * Backdates the lastSeen for a team to 2× the unhealthyTimeout ago.
   * Used only in tests — do not call from production code.
   */
  injectStaleStatus(teamID: string): void {
    const status = this.statuses.get(teamID);
    if (status === undefined) {
      return;
    }
    const staleDate = new Date(Date.now() - 2 * this.unhealthyTimeoutMs);
    this.statuses.set(teamID, {
      ...status,
      last_seen: staleDate,
    });
  }
}

// ---------------------------------------------------------------------------
// convertAgentStatuses
// ---------------------------------------------------------------------------

/**
 * Converts a ws.AgentStatus array to a domain.AgentHeartbeatStatus array.
 * Validates the status string; falls back to 'error' on unknown values.
 */
export function convertAgentStatuses(wsAgents: AgentStatus[]): AgentHeartbeatStatus[] {
  return wsAgents.map((a) => {
    const statusType = validateAgentStatusType(a.status) ? a.status : 'error';
    return {
      aid: a.aid,
      status: statusType,
      detail: a.detail ?? '',
      elapsed_seconds: a.elapsed_seconds,
      memory_mb: a.memory_mb,
    };
  });
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/**
 * Creates a new HeartbeatMonitorImpl with production defaults.
 * Startup jitter is enabled (up to MAX_JITTER_MS = 5s).
 */
export function newHeartbeatMonitor(
  eventBus: EventBus | null,
  logger: HeartbeatLogger,
): HeartbeatMonitorImpl {
  return new HeartbeatMonitorImpl(
    eventBus,
    logger,
    DEFAULT_CHECK_INTERVAL_MS,
    DEFAULT_UNHEALTHY_TIMEOUT_MS,
    MAX_JITTER_MS,
  );
}

/**
 * Creates a new HeartbeatMonitorImpl with custom intervals for testing.
 * Jitter is disabled (0) to keep tests deterministic.
 */
export function newHeartbeatMonitorWithIntervals(
  eventBus: EventBus | null,
  logger: HeartbeatLogger,
  checkIntervalMs: number,
  unhealthyTimeoutMs: number,
): HeartbeatMonitorImpl {
  return new HeartbeatMonitorImpl(
    eventBus,
    logger,
    checkIntervalMs,
    unhealthyTimeoutMs,
    0, // no jitter in tests
  );
}
