/**
 * Proactive scheduling and health state management for the orchestrator.
 *
 * Standalone functions extracted from OrchestratorImpl to reduce file size.
 * Each function takes explicit params instead of relying on class `this`.
 *
 * @module control-plane/orchestrator-proactive
 */

import type {
  Logger,
  OrgChart,
  WSHub,
  TaskStore,
  AgentExecutor,
  HealthMonitor,
  TokenManager,
  ContainerManager,
} from '../domain/interfaces.js';
import type { EscalationReason } from '../domain/enums.js';
import { TaskStatus as TS } from '../domain/enums.js';
import type { ProactiveScheduler } from './proactive-scheduler.js';

// ---------------------------------------------------------------------------
// Dependencies interfaces
// ---------------------------------------------------------------------------

/** Dependencies for stuck-agent checking. */
export interface StuckAgentDeps {
  logger: Logger;
  healthMonitor?: HealthMonitor;
  agentExecutor: AgentExecutor;
  stores?: { taskStore: TaskStore };
  orgChart: OrgChart;
  wsHub?: WSHub;
  handleEscalation: (agentAid: string, taskId: string, reason: EscalationReason, context: Record<string, unknown>) => Promise<string>;
}

/** Dependencies for health state change handling. */
export interface HealthStateChangedDeps {
  logger: Logger;
  orgChart: OrgChart;
  containerManager?: ContainerManager;
  tokenManager?: TokenManager;
  restartCounts: Map<string, { count: number; windowStart: number }>;
}

/** Dependencies for proactive agent registration. */
export interface ProactiveRegistrationDeps {
  logger: Logger;
  orgChart: OrgChart;
  proactiveScheduler: ProactiveScheduler;
}

// ---------------------------------------------------------------------------
// checkStuckAgents
// ---------------------------------------------------------------------------

/**
 * Check for stuck agents (busy longer than timeout) and kill them.
 * Per wiki: SIGTERM -> 5s grace -> SIGKILL -> mark task failed, escalate.
 */
export async function checkStuckAgents(deps: StuckAgentDeps, timeoutMs: number): Promise<void> {
  const { healthMonitor, agentExecutor, stores, orgChart, wsHub, logger } = deps;
  if (!healthMonitor || !agentExecutor || !stores) return;

  const stuckAgents = healthMonitor.getStuckAgents(timeoutMs);
  if (stuckAgents.length === 0) return;

  logger.warn('Detected stuck agents, stopping them', {
    count: stuckAgents.length,
    timeout_ms: timeoutMs,
  });

  for (const aid of stuckAgents) {
    try {
      // Stop the agent process with grace period (SIGTERM -> 5s -> SIGKILL)
      await agentExecutor.stop(aid, 5000);
      logger.info('Stopped stuck agent', { aid });

      // Find and fail any active tasks for this agent
      const activeTasks = await stores.taskStore.listByStatus(TS.Active);
      for (const task of activeTasks) {
        if (task.agent_aid === aid) {
          const updatedTask = {
            ...task,
            status: TS.Failed,
            error: 'Agent timed out (stuck)',
            updated_at: Date.now(),
          };
          await stores.taskStore.update(updatedTask);
          logger.info('Marked task as failed due to stuck agent', {
            task_id: task.id,
            aid,
          });

          // Escalate to team lead
          const team = orgChart.getTeamBySlug(task.team_slug);
          if (team && wsHub) {
            await deps.handleEscalation(aid, task.id, 'timeout' as EscalationReason, {
              original_error: 'Agent timed out (stuck)',
              team_slug: task.team_slug,
            });
          }
        }
      }
    } catch (err) {
      logger.error('Failed to stop stuck agent', { aid, error: String(err) });
    }
  }
}

// ---------------------------------------------------------------------------
// handleHealthStateChanged
// ---------------------------------------------------------------------------

/**
 * Handle a health state transition to 'unreachable': revoke stale tokens and
 * auto-restart the container, subject to a per-slug rate limit of 3/hour.
 *
 * Sequence (AC-B6):
 *   (a) Look up oldTid via orgChart.getTeamBySlug(slug)
 *   (b) Revoke all tokens bound to oldTid so stale auth cannot be reused
 *   (c) Call containerManager.restartTeamContainer(slug, reason)
 */
export async function handleHealthStateChanged(
  deps: HealthStateChangedDeps,
  tid: string,
  previousState: string,
  newState: string,
): Promise<void> {
  const { orgChart, containerManager, tokenManager, logger, restartCounts } = deps;
  if (!containerManager) return;

  // Find the team slug from the tid
  const allTeams = orgChart.listTeams();
  const team = allTeams.find((t) => t.tid === tid);
  if (!team) {
    logger.warn('health.auto_restart.no_team', { tid, newState });
    return;
  }
  const { slug } = team;

  // Rate limiting: max 3 restarts per hour per slug (AC-B2)
  const now = Date.now();
  const ONE_HOUR_MS = 60 * 60 * 1000;
  let rateEntry = restartCounts.get(slug);
  if (rateEntry) {
    if (now - rateEntry.windowStart >= ONE_HOUR_MS) {
      // Window expired — reset
      rateEntry = { count: 0, windowStart: now };
      restartCounts.set(slug, rateEntry);
    }
    if (rateEntry.count >= 3) {
      logger.warn(`Auto-restart rate limit exceeded for container ${slug}: 3/hour limit reached`, {
        slug,
        count: rateEntry.count,
        window_start: new Date(rateEntry.windowStart).toISOString(),
      });
      return;
    }
  } else {
    rateEntry = { count: 0, windowStart: now };
    restartCounts.set(slug, rateEntry);
  }

  // Increment before attempting restart
  rateEntry.count += 1;

  const reason = `health_auto_restart: ${previousState} -> ${newState}`;

  // Dispatches are intentionally NOT cleared here. When the container restarts and
  // sends 'ready', recoverTasks() will replay the unacknowledged dispatches (AC-B5).
  // Clearing them here would prevent replay.

  // (b) Revoke stale tokens bound to this TID before issuing new ones (AC-B6)
  const oldTid = orgChart.getTeamBySlug(slug)?.tid;
  if (oldTid && tokenManager) {
    tokenManager.revokeSessionsForTid(oldTid);
  }

  // (c) Restart the container
  logger.audit('health.auto_restart', { slug, tid, reason, restart_count: rateEntry.count });
  try {
    await containerManager.restartTeamContainer(slug, reason);
    logger.info('health.auto_restart.done', { slug, tid, reason });
  } catch (err) {
    logger.error('health.auto_restart.failed', { slug, tid, error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// startProactiveScheduler
// ---------------------------------------------------------------------------

/**
 * Start the proactive scheduler by registering agents and then starting the scheduler.
 */
export function startProactiveScheduler(
  proactiveScheduler: ProactiveScheduler | undefined,
  deps: ProactiveRegistrationDeps,
): void {
  if (!proactiveScheduler) return;

  // Register all agents from org chart, reading per-agent and team-level
  // proactive_interval_minutes from each team's config file (AC-D1).
  void registerProactiveAgents(deps).then(() => {
    proactiveScheduler?.start();
  });
}

// ---------------------------------------------------------------------------
// registerProactiveAgents
// ---------------------------------------------------------------------------

/**
 * Read each team's team.yaml and register agents with the correct proactive
 * interval (AC-D1).
 *
 * Priority (highest first):
 *   1. agents[].proactive_interval_minutes (per-agent in team.yaml)
 *   2. proactive_interval_minutes           (team-level in team.yaml)
 *   3. 30 minutes                           (CON-08 default)
 *
 * ProactiveScheduler.registerAgent() enforces the 5-minute minimum (CON-07).
 * Errors reading a team's config are logged and skipped; the default 30-min
 * interval is used for agents in the failing team.
 */
export async function registerProactiveAgents(deps: ProactiveRegistrationDeps): Promise<void> {
  const { logger, orgChart, proactiveScheduler } = deps;
  const teams = orgChart.listTeams();

  for (const team of teams) {
    const agents = orgChart.getAgentsByTeam(team.slug);
    if (agents.length === 0) continue;

    // Attempt to load raw TeamConfig from disk to read interval fields.
    let agentIntervalMap: Map<string, number> | undefined;
    let teamInterval: number | undefined;

    try {
      const fs = await import('node:fs/promises');
      const nodePath = await import('node:path');
      const { validateTeam } = await import('../config/validation.js');
      const YAML = await import('yaml');

      const teamYamlPath = nodePath.join(team.workspacePath, 'team.yaml');
      const raw = await fs.readFile(teamYamlPath, 'utf-8');
      const parsed: unknown = YAML.parse(raw);
      const teamConfig = validateTeam(parsed);

      teamInterval = teamConfig.proactive_interval_minutes;

      // Build per-agent lookup from agents[] array
      if (teamConfig.agents && teamConfig.agents.length > 0) {
        agentIntervalMap = new Map<string, number>();
        for (const agentEntry of teamConfig.agents) {
          if (agentEntry.proactive_interval_minutes !== undefined) {
            agentIntervalMap.set(agentEntry.aid, agentEntry.proactive_interval_minutes);
          }
        }
      }
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code;
      if (errno === 'ENOENT') {
        // team.yaml not present yet (e.g. root team) — use default
        logger.debug('proactive.no_team_yaml', { team_slug: team.slug });
      } else {
        logger.warn('proactive.team_yaml_error', {
          team_slug: team.slug,
          error: String(err),
        });
      }
      // Fall through — register all agents with fallback interval
    }

    for (const agent of agents) {
      // Priority: per-agent > team-level > default 30
      const intervalMinutes =
        agentIntervalMap?.get(agent.aid) ??
        teamInterval ??
        30; // CON-08

      proactiveScheduler.registerAgent(agent.aid, intervalMinutes);
    }
  }
}
