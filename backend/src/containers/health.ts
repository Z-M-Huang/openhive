/**
 * Health monitor — container and agent health monitoring.
 *
 * Implements the {@link HealthMonitor} interface for tracking container
 * heartbeats, managing health state transitions, and detecting stuck agents.
 *
 * Runs exclusively in the root container (INV-05).
 *
 * ## Health State Machine
 *
 * ```
 * starting → running → degraded (30s) → unhealthy (60s) → unreachable (90s)
 *    ↑          ↑          ↑
 *    └──────────┴──────────┘  (recovery on heartbeat received)
 * ```
 *
 * Thresholds (CON-06): 30s = degraded, 60s = unhealthy, 90s = unreachable.
 * Heartbeat interval (CON-05): 30s.
 *
 * @module containers/health
 */

import type { EventBus, HealthMonitor } from '../domain/index.js';
import { ContainerHealth, AgentStatus } from '../domain/index.js';

/** Threshold in ms before state degrades to 'degraded'. */
const DEGRADED_THRESHOLD_MS = 30_000;
/** Threshold in ms before state degrades to 'unhealthy'. */
const UNHEALTHY_THRESHOLD_MS = 60_000;
/** Threshold in ms before state degrades to 'unreachable'. */
const UNREACHABLE_THRESHOLD_MS = 90_000;
/** Check interval aligned with heartbeat interval (CON-05). */
const CHECK_INTERVAL_MS = 30_000;

/** Per-agent tracking info stored internally. */
interface AgentHealthEntry {
  aid: string;
  status: AgentStatus;
  detail: string;
  /** Timestamp when the agent entered its current status. */
  statusSince: number;
}

/** Per-container tracking info stored internally. */
interface ContainerHealthEntry {
  /** Last computed/stored health state. */
  state: ContainerHealth;
  /** Timestamp of last heartbeat received. */
  lastHeartbeat: number;
  /** Per-agent health info. */
  agents: Map<string, AgentHealthEntry>;
}

/**
 * Computes health state from elapsed time since last heartbeat.
 */
function computeHealthState(elapsedMs: number): ContainerHealth {
  if (elapsedMs >= UNREACHABLE_THRESHOLD_MS) return ContainerHealth.Unreachable;
  if (elapsedMs >= UNHEALTHY_THRESHOLD_MS) return ContainerHealth.Unhealthy;
  if (elapsedMs >= DEGRADED_THRESHOLD_MS) return ContainerHealth.Degraded;
  return ContainerHealth.Running;
}

export class HealthMonitorImpl implements HealthMonitor {
  private readonly containers = new Map<string, ContainerHealthEntry>();
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private readonly eventBus: EventBus;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  recordHeartbeat(
    tid: string,
    agents: Array<{ aid: string; status: AgentStatus; detail: string }>,
  ): void {
    const now = Date.now();
    let entry = this.containers.get(tid);
    const previousState = entry?.state ?? ContainerHealth.Starting;

    if (!entry) {
      entry = {
        state: ContainerHealth.Running,
        lastHeartbeat: now,
        agents: new Map(),
      };
      this.containers.set(tid, entry);
    } else {
      entry.state = ContainerHealth.Running;
      entry.lastHeartbeat = now;
    }

    // Update agent statuses
    for (const agent of agents) {
      const existing = entry.agents.get(agent.aid);
      if (existing && existing.status === agent.status) {
        // Same status — keep the original statusSince timestamp
        existing.detail = agent.detail;
      } else {
        entry.agents.set(agent.aid, {
          aid: agent.aid,
          status: agent.status,
          detail: agent.detail,
          statusSince: now,
        });
      }
    }

    // Publish recovery event if transitioning back to running
    if (previousState !== ContainerHealth.Starting && previousState !== ContainerHealth.Running) {
      this.eventBus.publish({
        type: 'health.recovered',
        data: { tid, previousState },
        timestamp: now,
        source: 'health-monitor',
      });
    }
  }

  getHealth(tid: string): ContainerHealth {
    const entry = this.containers.get(tid);
    if (!entry) return ContainerHealth.Starting;

    const elapsed = Date.now() - entry.lastHeartbeat;
    return computeHealthState(elapsed);
  }

  getAgentHealth(aid: string): AgentStatus | undefined {
    for (const [, entry] of this.containers) {
      const agent = entry.agents.get(aid);
      if (agent) return agent.status;
    }
    return undefined;
  }

  getAllHealth(): Map<string, ContainerHealth> {
    const result = new Map<string, ContainerHealth>();
    const now = Date.now();
    for (const [tid, entry] of this.containers) {
      const elapsed = now - entry.lastHeartbeat;
      result.set(tid, computeHealthState(elapsed));
    }
    return result;
  }

  getStuckAgents(timeoutMs: number): string[] {
    const now = Date.now();
    const stuck: string[] = [];
    for (const [, entry] of this.containers) {
      for (const [, agent] of entry.agents) {
        if (agent.status === AgentStatus.Busy && (now - agent.statusSince) > timeoutMs) {
          stuck.push(agent.aid);
        }
      }
    }
    return stuck;
  }

  start(): void {
    if (this.checkTimer !== null) return;
    this.checkTimer = setInterval(() => this.checkTimeouts(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.checkTimer !== null) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * Periodic check: evaluate all containers and publish state change events.
   */
  private checkTimeouts(): void {
    const now = Date.now();
    for (const [tid, entry] of this.containers) {
      const elapsed = now - entry.lastHeartbeat;
      const newState = computeHealthState(elapsed);
      if (newState !== entry.state) {
        const previousState = entry.state;
        entry.state = newState;
        this.eventBus.publish({
          type: 'health.state_changed',
          data: { tid, previousState, newState },
          timestamp: now,
          source: 'health-monitor',
        });
      }
    }
  }
}
