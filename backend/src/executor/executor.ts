/**
 * Agent executor — SDK process lifecycle management.
 *
 * Implements the {@link AgentExecutor} interface for managing Claude Agent SDK
 * instances as standalone processes. Each agent runs as its own process,
 * ensuring isolation and independent lifecycle management.
 *
 * // INV-06: Same image everywhere
 * This module runs the same compiled TypeScript codebase in every container.
 * The unified `openhive` Docker image is used for root and non-root containers
 * alike. The executor spawns SDK processes within the current container, never
 * across container boundaries.
 *
 * ## SDK Process Lifecycle
 *
 * Each agent managed by this executor follows a strict lifecycle:
 *
 * 1. **Spawn** (`start`) — A new Claude Agent SDK process is spawned as a
 *    standalone child process. The agent receives its {@link AgentInitConfig}
 *    (resolved provider credentials, tools, system prompt) and a workspace
 *    path. The process is monitored for unexpected exits.
 *
 * 2. **Monitor** (`isRunning`, `getStatus`) — The executor tracks the running
 *    state and health of each agent process. Status is reported via the
 *    heartbeat mechanism to the root container's {@link HealthMonitor}.
 *
 * 3. **Graceful Stop** (`stop`) — Sends SIGTERM to the agent process and waits
 *    up to `timeoutMs` for graceful shutdown. During this grace period the SDK
 *    process should finish its current turn, persist any state, and exit
 *    cleanly. If the process does not exit within the timeout, SIGKILL is sent
 *    to force termination.
 *
 * 4. **Force Kill** (`kill`) — Immediately sends SIGKILL to the agent process
 *    with no grace period. Used for unresponsive agents or emergency shutdown.
 *
 * ### Shutdown Sequence
 *
 * ```
 * stop(aid, 5000)
 *   |
 *   +-- SIGTERM --> [5s grace period] --> SIGKILL (if still alive)
 *   |
 *   +-- Process exits cleanly within timeout --> success
 * ```
 *
 * ### One SDK Instance Per Agent
 *
 * Each agent ID maps to exactly one SDK process. Calling `start()` for an
 * agent that is already running is an error. The executor maintains an internal
 * map of `agentAid -> process` for tracking.
 *
 * @module executor/executor
 */

import type { AgentExecutor, AgentInitConfig } from '../domain/index.js';
import type { AgentStatus } from '../domain/index.js';

// INV-06: Same image everywhere

/**
 * Manages Claude Agent SDK process lifecycle for agents within a container.
 *
 * Implements the {@link AgentExecutor} interface with one-process-per-agent
 * semantics. Each agent is spawned as a standalone child process running
 * the Claude Agent SDK. The executor is responsible for:
 *
 * - Spawning SDK processes with the correct configuration and credentials
 * - Tracking running state per agent (via internal process map)
 * - Graceful shutdown with SIGTERM and configurable timeout
 * - Forced termination via SIGKILL when graceful shutdown fails
 * - Cleanup of process resources on exit
 *
 * **Process model:** One Claude Agent SDK instance per agent. Each process
 * is fully isolated — separate stdin/stdout, separate working directory,
 * separate environment variables with resolved provider credentials.
 *
 * **Shutdown contract:** `stop()` sends SIGTERM, waits up to `timeoutMs`,
 * then sends SIGKILL if the process has not exited. `kill()` sends SIGKILL
 * immediately with no grace period.
 *
 * @see {@link AgentInitConfig} for the configuration passed to each SDK process
 * @see {@link AgentStatus} for the possible agent states
 */
export class AgentExecutorImpl implements AgentExecutor {
  /**
   * Spawns a new Claude Agent SDK process for the given agent.
   *
   * Creates a standalone child process running the SDK with the agent's
   * resolved configuration (provider credentials, tools, system prompt).
   * The process runs in the specified workspace directory and optionally
   * associates with a task ID for tracking.
   *
   * The SDK process is monitored for unexpected exits. If the process
   * crashes, the executor updates the agent's status to `error` and
   * emits an event for the health monitor to pick up.
   *
   * @param _agent - Agent initialization config with resolved provider, tools, and prompt
   * @param _workspacePath - Absolute path to the agent's workspace directory
   * @param _taskId - Optional task ID to associate with this SDK session
   * @throws {Error} If the agent is already running (one process per agent)
   * @throws {Error} If the SDK process fails to spawn
   */
  async start(
    _agent: AgentInitConfig,
    _workspacePath: string,
    _taskId?: string,
  ): Promise<void> {
    // INV-06: Same image everywhere
    throw new Error('Not implemented');
  }

  /**
   * Gracefully stops an agent's SDK process.
   *
   * Sends SIGTERM to the agent process and waits up to `timeoutMs` for
   * the process to exit cleanly. During the grace period, the SDK should
   * finish its current turn, persist conversation state, and shut down.
   *
   * If the process does not exit within `timeoutMs`, SIGKILL is sent to
   * force termination. The agent's status is updated to reflect the
   * shutdown outcome.
   *
   * Shutdown sequence:
   * 1. Send SIGTERM to the agent process
   * 2. Wait up to `timeoutMs` for graceful exit
   * 3. If still alive after timeout, send SIGKILL
   * 4. Clean up process resources and internal tracking state
   *
   * @param _agentAid - Agent ID identifying which process to stop
   * @param _timeoutMs - Maximum time in milliseconds to wait for graceful shutdown
   * @throws {Error} If the agent is not running
   */
  async stop(_agentAid: string, _timeoutMs: number): Promise<void> {
    throw new Error('Not implemented');
  }

  /**
   * Immediately terminates an agent's SDK process with SIGKILL.
   *
   * No grace period is given. The process is forcefully killed and all
   * resources are cleaned up. Use this for unresponsive agents or during
   * emergency shutdown sequences.
   *
   * This method is synchronous — it sends the kill signal and updates
   * internal state immediately. The actual process termination may be
   * asynchronous at the OS level, but the executor treats the agent as
   * terminated from this point forward.
   *
   * @param _agentAid - Agent ID identifying which process to kill
   * @throws {Error} If the agent is not running
   */
  kill(_agentAid: string): void {
    throw new Error('Not implemented');
  }

  /**
   * Checks whether an agent's SDK process is currently running.
   *
   * Returns `true` if the agent has been started and has not yet exited
   * (either normally or via kill). Returns `false` for unknown agent IDs
   * or agents that have been stopped/killed.
   *
   * @param _agentAid - Agent ID to check
   * @returns `true` if the agent's SDK process is alive, `false` otherwise
   */
  isRunning(_agentAid: string): boolean {
    throw new Error('Not implemented');
  }

  /**
   * Returns the current runtime status of an agent's SDK process.
   *
   * Maps the internal process state to an {@link AgentStatus} enum value:
   * - `starting` — Process has been spawned but SDK has not reported ready
   * - `idle` — SDK process is running and waiting for input
   * - `busy` — SDK process is actively executing a turn
   * - `error` — Process crashed or reported an error
   *
   * Returns `undefined` if the agent ID is not known to this executor
   * (never started, or already cleaned up after termination).
   *
   * @param _agentAid - Agent ID to query
   * @returns The agent's current status, or `undefined` if not tracked
   */
  getStatus(_agentAid: string): AgentStatus | undefined {
    throw new Error('Not implemented');
  }
}
