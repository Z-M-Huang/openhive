/**
 * OpenHive Backend - Escalation Router
 *
 * Routes escalation messages upward through the team hierarchy and
 * escalation responses back downward. Each hop passes through root's
 * WebSocket hub so it is logged.
 *
 * Key design choices:
 *   - Escalation routing uses the OrgChart to determine the supervisor
 *     and destination container for each escalation hop.
 *   - Each escalation is persisted to the EscalationStore with a
 *     correlation_id that tracks the entire chain.
 *   - The task being escalated is marked as 'escalated' in the TaskStore.
 *   - Escalation responses flow back downward via the same correlation_id,
 *     looking up the most recent pending escalation to find the originator.
 */

import type {
  OrgChart,
  EscalationStore,
  TaskStore,
  WSHub,
} from '../domain/interfaces.js';
import type { Escalation } from '../domain/types.js';
import type { EscalationMsg, EscalationResponseMsg } from '../ws/messages.js';
import {
  MsgTypeEscalation,
  MsgTypeEscalationResponse,
  WSErrorDepthLimitExceeded,
  WSErrorCycleDetected,
} from '../ws/messages.js';
import { encodeMessage } from '../ws/protocol.js';

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/** Minimal structured logger required by EscalationRouter. */
export interface EscalationRouterLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum escalation depth before rejecting (prevents infinite loops). */
const MAX_ESCALATION_DEPTH = 10;

// ---------------------------------------------------------------------------
// EscalationRouter
// ---------------------------------------------------------------------------

/**
 * Routes escalation messages upward through the team hierarchy and
 * escalation_response messages back downward.
 */
export class EscalationRouter {
  private readonly orgChart: OrgChart;
  private readonly escalationStore: EscalationStore;
  private readonly taskStore: TaskStore;
  private readonly wsHub: WSHub;
  private readonly logger: EscalationRouterLogger;

  constructor(
    orgChart: OrgChart,
    escalationStore: EscalationStore,
    taskStore: TaskStore,
    wsHub: WSHub,
    logger: EscalationRouterLogger,
  ) {
    this.orgChart = orgChart;
    this.escalationStore = escalationStore;
    this.taskStore = taskStore;
    this.wsHub = wsHub;
    this.logger = logger;
  }

  // -------------------------------------------------------------------------
  // handleEscalation
  // -------------------------------------------------------------------------

  /**
   * Handles an inbound escalation message from a container.
   *
   * 1. Validates escalation depth
   * 2. Looks up the supervisor via OrgChart
   * 3. Persists the escalation record
   * 4. Marks the task as 'escalated'
   * 5. Routes the message to the supervisor's container
   *
   * @param sourceTeamID  - TID of the container that sent the escalation.
   * @param escalation    - The parsed EscalationMsg payload.
   */
  async handleEscalation(
    sourceTeamID: string,
    escalation: EscalationMsg,
  ): Promise<void> {
    const {
      correlation_id,
      task_id,
      agent_aid,
      escalation_level,
      reason,
      context,
    } = escalation;

    // Validate depth limit
    if (escalation_level > MAX_ESCALATION_DEPTH) {
      this.logger.error('escalation depth limit exceeded', {
        correlation_id,
        task_id,
        agent_aid,
        level: escalation_level,
        max: MAX_ESCALATION_DEPTH,
        error_code: WSErrorDepthLimitExceeded,
      });
      throw new Error(`escalation depth limit exceeded: level ${escalation_level} > max ${MAX_ESCALATION_DEPTH}`);
    }

    // Resolve supervisor via OrgChart
    let supervisor;
    try {
      supervisor = this.orgChart.getSupervisor(agent_aid);
    } catch (err) {
      this.logger.error('failed to resolve supervisor for escalation', {
        correlation_id,
        agent_aid,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(`failed to resolve supervisor for agent ${agent_aid}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (supervisor === null) {
      this.logger.warn('no supervisor found for agent — escalation cannot be routed', {
        correlation_id,
        agent_aid,
        task_id,
      });
      throw new Error(`no supervisor found for agent ${agent_aid} — escalation cannot be routed`);
    }

    // Detect cycles: agent escalating to itself
    if (supervisor.aid === agent_aid) {
      this.logger.error('escalation cycle detected — agent is its own supervisor', {
        correlation_id,
        agent_aid,
        error_code: WSErrorCycleDetected,
      });
      throw new Error(`escalation cycle detected: agent ${agent_aid} is its own supervisor`);
    }

    // Find destination team for the supervisor
    let destTeam;
    try {
      destTeam = this.orgChart.getTeamForAgent(supervisor.aid);
    } catch (err) {
      this.logger.error('failed to resolve destination team for supervisor', {
        correlation_id,
        supervisor_aid: supervisor.aid,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(`failed to resolve destination team for supervisor ${supervisor.aid}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const destTeamSlug = destTeam.slug;

    // Persist escalation record
    const now = new Date();
    const escRecord: Escalation = {
      id: crypto.randomUUID(),
      correlation_id,
      task_id,
      from_aid: agent_aid,
      to_aid: supervisor.aid,
      source_team: sourceTeamID,
      destination_team: destTeamSlug,
      escalation_level,
      reason,
      context: context !== undefined ? JSON.stringify(context) : undefined,
      status: 'pending',
      created_at: now,
      updated_at: now,
      resolved_at: null,
    };

    try {
      await this.escalationStore.create(escRecord);
    } catch (err) {
      this.logger.error('failed to persist escalation', {
        correlation_id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(`failed to persist escalation ${correlation_id}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Mark task as escalated
    try {
      const task = await this.taskStore.get(task_id);
      await this.taskStore.update({
        ...task,
        status: 'escalated',
        updated_at: now,
      });
    } catch (err) {
      this.logger.warn('failed to mark task as escalated', {
        task_id,
        error: err instanceof Error ? err.message : String(err),
      });
      // Continue routing even if task update fails
    }

    // Route escalation message to supervisor's container
    const routedMsg: EscalationMsg = {
      correlation_id,
      task_id,
      agent_aid,
      source_team: sourceTeamID,
      destination_team: destTeamSlug,
      escalation_level,
      reason,
      context,
    };

    const encoded = encodeMessage(MsgTypeEscalation, routedMsg);

    try {
      await this.wsHub.sendToTeam(destTeamSlug, encoded);
    } catch (err) {
      this.logger.error('failed to route escalation to destination', {
        correlation_id,
        destination_team: destTeamSlug,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(`failed to route escalation to ${destTeamSlug}: ${err instanceof Error ? err.message : String(err)}`);
    }

    this.logger.info('escalation routed', {
      correlation_id,
      task_id,
      from_aid: agent_aid,
      to_aid: supervisor.aid,
      source_team: sourceTeamID,
      destination_team: destTeamSlug,
      level: escalation_level,
    });
  }

  // -------------------------------------------------------------------------
  // handleEscalationResponse
  // -------------------------------------------------------------------------

  /**
   * Handles an inbound escalation_response message.
   *
   * 1. Looks up the pending escalation by correlation_id
   * 2. Updates the escalation record to 'resolved'
   * 3. Resumes the task (status: 'running')
   * 4. Routes the response to the originating container
   *
   * @param response - The parsed EscalationResponseMsg payload.
   */
  async handleEscalationResponse(
    response: EscalationResponseMsg,
  ): Promise<void> {
    const { correlation_id, task_id, resolution, context } = response;

    // Find the pending escalation(s) by correlation_id
    let pendingEscalations: Escalation[];
    try {
      pendingEscalations = await this.escalationStore.listByCorrelation(correlation_id);
    } catch (err) {
      this.logger.error('failed to look up escalation for response', {
        correlation_id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(`failed to look up escalation for response ${correlation_id}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Find the most recent pending escalation (first in DESC order)
    const pending = pendingEscalations.find((e) => e.status === 'pending');
    if (pending === undefined) {
      this.logger.warn('no pending escalation found for response', {
        correlation_id,
        task_id,
      });
      throw new Error(`no pending escalation found for response ${correlation_id}`);
    }

    // Update escalation to resolved
    const now = new Date();
    try {
      await this.escalationStore.update({
        ...pending,
        status: 'resolved',
        resolution,
        updated_at: now,
        resolved_at: now,
      });
    } catch (err) {
      this.logger.error('failed to resolve escalation', {
        escalation_id: pending.id,
        correlation_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Resume task (back to 'running')
    try {
      const task = await this.taskStore.get(task_id);
      if (task.status === 'escalated') {
        await this.taskStore.update({
          ...task,
          status: 'running',
          updated_at: now,
        });
      }
    } catch (err) {
      this.logger.warn('failed to resume task after escalation response', {
        task_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Route response to originating container
    const routedResponse: EscalationResponseMsg = {
      correlation_id,
      task_id,
      agent_aid: response.agent_aid,
      source_team: response.source_team,
      destination_team: pending.source_team,
      resolution,
      context,
    };

    const encoded = encodeMessage(MsgTypeEscalationResponse, routedResponse);

    try {
      await this.wsHub.sendToTeam(pending.source_team, encoded);
    } catch (err) {
      this.logger.error('failed to route escalation response to originator', {
        correlation_id,
        destination_team: pending.source_team,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(`failed to route escalation response to ${pending.source_team}: ${err instanceof Error ? err.message : String(err)}`);
    }

    this.logger.info('escalation response routed', {
      correlation_id,
      task_id,
      from_team: response.source_team,
      to_team: pending.source_team,
      resolution,
    });
  }

  // -------------------------------------------------------------------------
  // getEscalationChain
  // -------------------------------------------------------------------------

  /**
   * Returns the full escalation chain for a correlation ID.
   * Used for debugging and logging escalation flows.
   */
  async getEscalationChain(correlationId: string): Promise<Escalation[]> {
    return this.escalationStore.listByCorrelation(correlationId);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a new EscalationRouter with the given dependencies.
 */
export function newEscalationRouter(
  orgChart: OrgChart,
  escalationStore: EscalationStore,
  taskStore: TaskStore,
  wsHub: WSHub,
  logger: EscalationRouterLogger,
): EscalationRouter {
  return new EscalationRouter(orgChart, escalationStore, taskStore, wsHub, logger);
}
