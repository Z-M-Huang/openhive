/**
 * OpenHive Backend - ProactiveLoop
 *
 * Manages per-agent proactive check intervals. Orchestrator-driven:
 * reads PROACTIVE.md and dispatches proactive_check tasks to agents
 * on their configured interval.
 *
 * Design:
 *   - Each agent with a proactive_interval_minutes > 0 gets a timer.
 *   - When the timer fires, the orchestrator checks if the agent is busy.
 *   - If busy, the check is skipped (logged as proactive.skip).
 *   - If idle, reads PROACTIVE.md and dispatches a proactive_check task.
 *   - CON-07: Minimum interval 5 minutes. CON-08: Default interval 30 minutes.
 */

import { readFile } from 'node:fs/promises';
import { join as pathJoin } from 'node:path';
import type { Agent } from '../domain/types.js';
import type { ProactiveLoop } from '../domain/interfaces.js';
import { resolveTeamWorkspacePath } from './orchestrator.js';

// ---------------------------------------------------------------------------
// Constants — CON-07, CON-08
// ---------------------------------------------------------------------------

/** Minimum proactive check interval in minutes (CON-07). */
export const MIN_PROACTIVE_INTERVAL_MINUTES = 5;

/** Default proactive check interval in minutes (CON-08). */
export const DEFAULT_PROACTIVE_INTERVAL_MINUTES = 30;

// ---------------------------------------------------------------------------
// ProactiveLoopDeps
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into the ProactiveLoop.
 */
export interface ProactiveLoopDeps {
  /** Root run directory for workspace paths. */
  runDir: string;
  /** Dispatches a proactive check task. Returns the task ID. */
  dispatchTask: (teamSlug: string, agentAid: string, prompt: string) => Promise<string>;
  /** Checks if an agent currently has a running task. */
  isAgentBusy: (agentAid: string) => Promise<boolean>;
  /** Resolves the team slug for an agent. Returns null if not found. */
  getTeamSlugForAgent: (agentAid: string) => string | null;
  logger: {
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, data?: Record<string, unknown>): void;
  };
}

// ---------------------------------------------------------------------------
// AgentTimer — per-agent tracking state
// ---------------------------------------------------------------------------

interface AgentTimer {
  agent: Agent;
  intervalMs: number;
  timer: ReturnType<typeof setInterval>;
  lastSkipped: boolean;
  lastCheckAt: Date | null;
}

// ---------------------------------------------------------------------------
// ProactiveLoopImpl
// ---------------------------------------------------------------------------

export class ProactiveLoopImpl implements ProactiveLoop {
  private readonly deps: ProactiveLoopDeps;
  private readonly timers: Map<string, AgentTimer> = new Map();
  private running = false;

  constructor(deps: ProactiveLoopDeps) {
    this.deps = deps;
  }

  async start(agents: Agent[]): Promise<void> {
    if (this.running) return;
    this.running = true;

    let started = 0;

    for (const agent of agents) {
      const intervalMinutes = this.resolveInterval(agent);
      if (intervalMinutes === 0) continue; // Disabled

      const intervalMs = intervalMinutes * 60 * 1000;
      const timer = setInterval(() => {
        void this.check(agent.aid);
      }, intervalMs);

      this.timers.set(agent.aid, {
        agent,
        intervalMs,
        timer,
        lastSkipped: false,
        lastCheckAt: null,
      });

      started++;
    }

    this.deps.logger.info('proactive loop started', {
      agent_count: agents.length,
      active_loops: started,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    for (const [, entry] of this.timers) {
      clearInterval(entry.timer);
    }
    this.timers.clear();

    this.deps.logger.info('proactive loop stopped');
  }

  async triggerNow(agentAID: string): Promise<void> {
    await this.check(agentAID);
  }

  wasSkipped(agentAID: string): boolean {
    const entry = this.timers.get(agentAID);
    return entry?.lastSkipped ?? false;
  }

  /**
   * Resolves the effective proactive interval for an agent.
   * - 0 = disabled
   * - undefined = default (30 min)
   * - < 5 = rejected (use minimum)
   */
  private resolveInterval(agent: Agent): number {
    const raw = agent.proactive_interval_minutes;
    if (raw === 0) return 0;
    if (raw === undefined) return DEFAULT_PROACTIVE_INTERVAL_MINUTES;
    if (raw < MIN_PROACTIVE_INTERVAL_MINUTES) {
      this.deps.logger.warn('proactive interval below minimum, using minimum', {
        aid: agent.aid,
        requested: raw,
        minimum: MIN_PROACTIVE_INTERVAL_MINUTES,
      });
      return MIN_PROACTIVE_INTERVAL_MINUTES;
    }
    return raw;
  }

  /**
   * Performs a proactive check for a single agent.
   * Called by the per-agent timer or by triggerNow.
   */
  private async check(agentAID: string): Promise<void> {
    if (!this.running) return;

    const entry = this.timers.get(agentAID);

    // Skip-if-busy: check if agent has running tasks
    let busy: boolean;
    try {
      busy = await this.deps.isAgentBusy(agentAID);
    } catch (err) {
      this.deps.logger.warn('failed to check agent busy status', {
        aid: agentAID,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (busy) {
      if (entry) entry.lastSkipped = true;
      this.deps.logger.info('proactive check skipped (agent busy)', {
        aid: agentAID,
      });
      return;
    }

    // Resolve team for agent
    const teamSlug = this.deps.getTeamSlugForAgent(agentAID);
    if (teamSlug === null) {
      this.deps.logger.warn('cannot dispatch proactive check: team not found for agent', {
        aid: agentAID,
      });
      return;
    }

    // Read PROACTIVE.md from agent's team workspace
    let proactiveContent: string;
    try {
      const wsSlug = teamSlug === 'master' ? 'main' : teamSlug;
      const wsDir = resolveTeamWorkspacePath(this.deps.runDir, wsSlug);
      const proactivePath = pathJoin(wsDir, 'PROACTIVE.md');
      proactiveContent = await readFile(proactivePath, 'utf-8');
    } catch (err) {
      // PROACTIVE.md may not exist — that's fine, just skip
      if (isNodeError(err) && err.code === 'ENOENT') {
        this.deps.logger.info('no PROACTIVE.md found, skipping proactive check', {
          aid: agentAID,
          team_slug: teamSlug,
        });
        return;
      }
      this.deps.logger.warn('failed to read PROACTIVE.md', {
        aid: agentAID,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Build proactive check prompt with idempotency ID
    const checkId = `${new Date().toISOString().slice(0, 10)}-${agentAID}`;
    const prompt = [
      `Proactive check (ID: ${checkId})`,
      '',
      'The following checks should be evaluated. For each check that requires action,',
      'create a follow-up task using dispatch_task or dispatch_subtask.',
      '',
      proactiveContent,
    ].join('\n');

    try {
      const taskId = await this.deps.dispatchTask(teamSlug, agentAID, prompt);
      if (entry) {
        entry.lastSkipped = false;
        entry.lastCheckAt = new Date();
      }
      this.deps.logger.info('proactive check dispatched', {
        aid: agentAID,
        task_id: taskId,
        check_id: checkId,
      });
    } catch (err) {
      this.deps.logger.error('failed to dispatch proactive check', {
        aid: agentAID,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    'code' in err &&
    typeof (err as NodeJS.ErrnoException).code === 'string'
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function newProactiveLoop(deps: ProactiveLoopDeps): ProactiveLoopImpl {
  return new ProactiveLoopImpl(deps);
}
