import type {
  HealthMonitor,
  Logger,
} from '../domain/interfaces.js';
import { AgentStatus } from '../domain/enums.js';

/** Callback to dispatch a proactive check task. */
export type ProactiveDispatcher = (agentAid: string, checkId: string) => Promise<void>;

const MIN_INTERVAL_MS = 5 * 60 * 1000;     // CON-07: 5 min
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // CON-08: 30 min

/**
 * Manages proactive behavior timers per agent.
 *
 * Per-agent timers with configurable interval (default 30 min, min 5 min).
 * On timer fire: check if agent idle, dispatch proactive_check task if so.
 * Idempotent: proactive_check_id = YYYY-MM-DD-HH:MM-{aid} (AC-L8-13).
 */
export class ProactiveScheduler {
  private readonly healthMonitor: HealthMonitor;
  private readonly logger: Logger;
  private readonly dispatcher: ProactiveDispatcher;

  /** Per-agent timer handles. */
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();

  /** Dispatched check IDs for dedup (AC-L8-13). */
  private readonly dispatchedChecks = new Set<string>();

  constructor(deps: {
    healthMonitor: HealthMonitor;
    logger: Logger;
    dispatcher: ProactiveDispatcher;
  }) {
    this.healthMonitor = deps.healthMonitor;
    this.logger = deps.logger;
    this.dispatcher = deps.dispatcher;
  }

  /**
   * Register an agent for proactive checks.
   * @param agentAid - Agent ID
   * @param intervalMinutes - Interval in minutes (default 30, min 5)
   */
  registerAgent(agentAid: string, intervalMinutes?: number): void {
    // Clean up existing timer
    this.unregisterAgent(agentAid);

    const intervalMs = Math.max(
      MIN_INTERVAL_MS,
      (intervalMinutes ?? DEFAULT_INTERVAL_MS / 60_000) * 60_000,
    );

    const timer = setInterval(() => {
      void this.fireCheck(agentAid);
    }, intervalMs);

    // Prevent timer from keeping the process alive
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref();
    }

    this.timers.set(agentAid, timer);
  }

  /** Unregister an agent and clear its timer. */
  unregisterAgent(agentAid: string): void {
    const timer = this.timers.get(agentAid);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(agentAid);
    }
  }

  /** Stop all timers. */
  stop(): void {
    for (const [aid, timer] of this.timers) {
      clearInterval(timer);
      this.timers.delete(aid);
    }
    this.dispatchedChecks.clear();
  }

  /** Manually trigger a check for an agent (used in tests). */
  async fireCheck(agentAid: string): Promise<void> {
    const status = this.healthMonitor.getAgentHealth(agentAid);

    if (status !== AgentStatus.Idle) {
      this.logger.debug('proactive.skip', {
        agent_aid: agentAid,
        reason: `agent status: ${status ?? 'unknown'}`,
      });
      return;
    }

    // Generate idempotent check ID: YYYY-MM-DD-HH:MM-{aid}
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const checkId = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}:${pad(now.getMinutes())}-${agentAid}`;

    if (this.dispatchedChecks.has(checkId)) {
      this.logger.debug('proactive.dedup', {
        agent_aid: agentAid,
        check_id: checkId,
      });
      return;
    }

    this.dispatchedChecks.add(checkId);
    await this.dispatcher(agentAid, checkId);
  }

  /** Get number of registered agents. */
  getRegisteredCount(): number {
    return this.timers.size;
  }
}
