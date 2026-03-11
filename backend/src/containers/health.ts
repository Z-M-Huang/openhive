/**
 * Health monitor — container and agent health monitoring and recovery.
 *
 * Implements the {@link HealthMonitor} interface for tracking container
 * heartbeats, managing health state transitions, detecting stuck agents,
 * and triggering recovery actions.
 *
 * // INV-05: Root spawns all containers
 * This module runs exclusively in the root container (`OPENHIVE_IS_ROOT=true`).
 * Non-root containers send heartbeats via WebSocket; the root container
 * runs the HealthMonitor to aggregate and evaluate them.
 *
 * ## Heartbeat Monitoring (CON-05)
 *
 * Each team container sends a heartbeat message via WebSocket at a 30-second
 * interval. The heartbeat includes the container's TID and the status of all
 * agents running in that container. The HealthMonitor records each heartbeat
 * timestamp and uses it to detect missed heartbeats and state transitions.
 *
 * ## Health State Machine
 *
 * Container health follows a state machine with these transitions:
 *
 * ```
 * starting → running → degraded → unhealthy → unreachable
 *    ↑          ↑          ↑
 *    └──────────┴──────────┘  (recovery on heartbeat received)
 * ```
 *
 * - **starting** — Container has been spawned but no heartbeat received yet.
 * - **running** — Heartbeats arriving on schedule (within 30s window).
 * - **degraded** — Heartbeat delayed by 30+ seconds (1 missed interval, CON-06).
 * - **unhealthy** — Heartbeat delayed by 60+ seconds (1 missed heartbeat after
 *   degraded threshold, CON-06). Recovery actions may be initiated.
 * - **unreachable** — Heartbeat delayed by 90+ seconds (3 consecutive missed
 *   heartbeats, CON-06). Container is considered dead and may be restarted.
 *
 * ## Health Check Thresholds (CON-06)
 *
 * | State       | Missed Time | Missed Heartbeats |
 * |-------------|-------------|--------------------|
 * | degraded    | 30s         | 1 missed interval  |
 * | unhealthy   | 60s         | ~2 missed          |
 * | unreachable | 90s         | 3 missed           |
 *
 * A received heartbeat resets the container to `running` state regardless of
 * the current degraded/unhealthy state.
 *
 * ## Agent Timeout (30min configurable)
 *
 * Individual agents within a container have a configurable timeout (default
 * 30 minutes). If an agent remains in `busy` status for longer than this
 * timeout without progress, it is considered stuck.
 *
 * ## Stuck Agent Detection
 *
 * When a stuck agent is detected:
 * 1. Send SIGTERM to the agent's SDK process
 * 2. Wait 5 seconds for graceful shutdown
 * 3. If still running after 5 seconds, send SIGKILL to force-terminate
 * 4. Log the stuck agent event with full context (agent AID, task ID, duration)
 * 5. Publish a `agent.stuck` event via the EventBus
 *
 * The `checkTimeouts()` internal method runs periodically (aligned with the
 * heartbeat interval) to evaluate all tracked containers and agents against
 * their respective thresholds. It updates health states and returns lists of
 * containers and agents that have transitioned to a worse state.
 *
 * @module containers/health
 */

import type { HealthMonitor } from '../domain/index.js';
import type { ContainerHealth, AgentStatus } from '../domain/index.js';

/**
 * Container and agent health monitor.
 *
 * Implements the {@link HealthMonitor} interface with heartbeat tracking,
 * health state machine evaluation, and stuck agent detection.
 *
 * **State tracking:**
 * - Maintains a map of TID → last heartbeat timestamp for all registered containers
 * - Maintains a map of AID → (status, last activity timestamp) for all agents
 * - Evaluates health on each `checkTimeouts()` cycle (called internally by the
 *   periodic check timer started via `start()`)
 *
 * **Heartbeat protocol:**
 * - Containers send heartbeats every 30 seconds via WebSocket
 * - Each heartbeat includes agent statuses for all agents in that container
 * - Receiving a heartbeat resets the container to `running` state
 *
 * **Thresholds (CON-06):**
 * - 30s since last heartbeat → `degraded`
 * - 60s since last heartbeat → `unhealthy`
 * - 90s since last heartbeat (3 missed) → `unreachable`
 *
 * **Agent timeout:**
 * - Default 30 minutes (configurable)
 * - Agents in `busy` state beyond timeout are flagged as stuck
 * - Stuck agents receive SIGTERM → 5s grace → SIGKILL
 *
 * **Internal methods (not on interface):**
 * - `checkTimeouts()` — Periodic evaluation of all health states. Runs on
 *   the interval timer started by `start()`. Iterates all tracked containers,
 *   computes elapsed time since last heartbeat, transitions health state
 *   according to thresholds. Also checks all agents for stuck status.
 */
export class HealthMonitorImpl implements HealthMonitor {
  /**
   * Records a heartbeat from a team container.
   *
   * Updates the last heartbeat timestamp for the given TID and resets
   * the container's health state to `running` (regardless of current
   * degraded/unhealthy state). Also updates the status of each agent
   * reported in the heartbeat payload.
   *
   * Called by the WebSocket message handler when a `heartbeat` message
   * is received from a container.
   *
   * @param _tid - Team identifier of the container sending the heartbeat
   * @param _agents - Array of agent statuses reported in this heartbeat,
   *   each containing the agent's AID, current status, and detail string
   *
   * @example
   * ```ts
   * monitor.recordHeartbeat('tid-abc-123', [
   *   { aid: 'aid-001', status: AgentStatus.Idle, detail: 'waiting' },
   *   { aid: 'aid-002', status: AgentStatus.Busy, detail: 'processing task-42' },
   * ]);
   * ```
   */
  recordHeartbeat(
    _tid: string,
    _agents: Array<{ aid: string; status: AgentStatus; detail: string }>,
  ): void {
    throw new Error('Not implemented');
  }

  /**
   * Returns the current health state of a container.
   *
   * Looks up the container's health in the internal tracking map. If the
   * container has never sent a heartbeat, returns `starting`. The health
   * state is updated by `recordHeartbeat()` (resets to `running`) and by
   * the periodic `checkTimeouts()` cycle (degrades based on elapsed time).
   *
   * @param _tid - Team identifier of the container to query
   * @returns Current health state of the container
   *
   * @see {@link ContainerHealth} for possible values
   */
  getHealth(_tid: string): ContainerHealth {
    throw new Error('Not implemented');
  }

  /**
   * Returns the current status of a specific agent.
   *
   * Looks up the agent's last reported status from heartbeat data.
   * Returns `undefined` if the agent has never been reported in any
   * heartbeat (unknown agent).
   *
   * @param _aid - Agent identifier to query
   * @returns Agent's last reported status, or `undefined` if unknown
   *
   * @see {@link AgentStatus} for possible values
   */
  getAgentHealth(_aid: string): AgentStatus | undefined {
    throw new Error('Not implemented');
  }

  /**
   * Returns the health state of all tracked containers.
   *
   * Returns a map of TID → {@link ContainerHealth} for every container
   * that has been registered (either via `recordHeartbeat()` or by the
   * container manager when spawning). Includes containers in all states
   * (starting, running, degraded, unhealthy, unreachable).
   *
   * @returns Map of all container TIDs to their current health states
   */
  getAllHealth(): Map<string, ContainerHealth> {
    throw new Error('Not implemented');
  }

  /**
   * Returns a list of agent AIDs that are considered stuck.
   *
   * An agent is stuck if it has been in `busy` status continuously for
   * longer than `timeoutMs` without any status change. The timeout is
   * typically 30 minutes (configurable) but can be overridden per call.
   *
   * Stuck agents should be terminated via the SIGTERM → 5s → SIGKILL
   * sequence by the caller.
   *
   * @param _timeoutMs - Duration in milliseconds after which a busy agent
   *   is considered stuck (default recommendation: 1_800_000 = 30 minutes)
   * @returns Array of agent AIDs that exceed the stuck threshold
   */
  getStuckAgents(_timeoutMs: number): string[] {
    throw new Error('Not implemented');
  }

  /**
   * Starts the periodic health check timer.
   *
   * Begins a recurring interval (aligned with the 30-second heartbeat
   * period) that calls the internal `checkTimeouts()` method. Each cycle:
   *
   * 1. Iterates all tracked containers
   * 2. Computes elapsed time since last heartbeat for each
   * 3. Transitions health state based on thresholds:
   *    - 30s → degraded
   *    - 60s → unhealthy
   *    - 90s → unreachable
   * 4. Checks all agents for stuck status (busy beyond timeout)
   * 5. Publishes health transition events via the EventBus
   *
   * Calling `start()` when already running is a no-op.
   */
  start(): void {
    throw new Error('Not implemented');
  }

  /**
   * Stops the periodic health check timer.
   *
   * Clears the interval timer started by `start()`. Does not clear
   * tracked state — heartbeat data is preserved so health can be
   * queried even after stopping periodic checks.
   *
   * Calling `stop()` when not running is a no-op.
   */
  stop(): void {
    throw new Error('Not implemented');
  }
}
