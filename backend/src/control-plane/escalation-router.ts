import crypto from 'node:crypto';
import type { EscalationReason } from '../domain/enums.js';
import { TaskStatus } from '../domain/enums.js';
import { assertValidTransition } from '../domain/domain.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';
import type {
  OrgChart,
  WSHub,
  TaskStore,
  EventBus,
  Logger,
} from '../domain/interfaces.js';

/** Tracked escalation record. */
interface EscalationRecord {
  correlationId: string;
  sourceAid: string;
  taskId: string;
  targetAid: string;
  reason: EscalationReason;
  context: Record<string, unknown>;
  hopCount: number;
  resolved: boolean;
  createdAt: number;
}

const MAX_HOPS = 10;

/**
 * Handles escalation chain walking and response routing.
 *
 * AC-L8-11: Max hops exceeded -> forced to user with context.max_hops_exceeded=true.
 */
export class EscalationRouter {
  private readonly orgChart: OrgChart;
  private readonly wsHub: WSHub;
  private readonly taskStore: TaskStore;
  private readonly eventBus: EventBus;
  private readonly logger: Logger;

  /** Active escalations keyed by correlation_id. */
  private readonly escalations = new Map<string, EscalationRecord>();

  /** Dedup set: "correlation_id:direction" to prevent duplicate routing. */
  private readonly dedupSet = new Set<string>();

  constructor(deps: {
    orgChart: OrgChart;
    wsHub: WSHub;
    taskStore: TaskStore;
    eventBus: EventBus;
    logger: Logger;
  }) {
    this.orgChart = deps.orgChart;
    this.wsHub = deps.wsHub;
    this.taskStore = deps.taskStore;
    this.eventBus = deps.eventBus;
    this.logger = deps.logger;
  }

  /**
   * Handle an escalation from an agent.
   * Walks the OrgChart upward (max 10 hops), dedup by correlation_id+direction.
   * Returns the correlation_id.
   * AC-L8-10: Accepts optional caller-supplied correlation_id for deduplication.
   */
  async handleEscalation(
    agentAid: string,
    taskId: string,
    reason: EscalationReason,
    context: Record<string, unknown>,
    callerCorrelationId?: string,
  ): Promise<string> {
    // AC-L8-10: Use caller-supplied correlation_id if provided, otherwise generate
    const correlationId = callerCorrelationId ?? crypto.randomUUID();

    // Dedup check - prevents duplicate escalation for same correlation_id+direction
    const dedupKey = `${correlationId}:up`;
    if (this.dedupSet.has(dedupKey)) {
      this.logger.info('Escalation deduplicated', { correlation_id: correlationId });
      return correlationId;
    }
    this.dedupSet.add(dedupKey);

    // Walk OrgChart upward to find escalation target
    let currentAid = agentAid;
    let hopCount = 0;
    let targetAid: string | undefined;

    while (hopCount < MAX_HOPS) {
      const agent = this.orgChart.getAgent(currentAid);
      if (!agent) break;

      const team = this.orgChart.getTeamBySlug(agent.teamSlug);
      if (!team) break;

      // Target is the team lead (unless the agent IS the lead)
      if (team.leaderAid !== currentAid) {
        targetAid = team.leaderAid;
        break;
      }

      // Agent is the team lead — go up to parent team
      const parent = this.orgChart.getParent(team.tid);
      if (!parent) {
        // No parent — force to user
        targetAid = undefined;
        break;
      }

      currentAid = parent.leaderAid;
      hopCount++;
    }

    // Transition task to escalated
    const task = await this.taskStore.get(taskId);
    assertValidTransition(task.status, TaskStatus.Escalated);
    await this.taskStore.update({
      ...task,
      status: TaskStatus.Escalated,
      updated_at: Date.now(),
    });

    const escalationContext = hopCount >= MAX_HOPS
      ? {
          ...context,
          max_hops_exceeded: true,
          hop_count: MAX_HOPS,
          // AC-L8-11: Explicit chain-exhaustion context
          exhaustion_reason: 'escalation_chain_exhausted',
          exhaustion_message: `Escalation walked ${MAX_HOPS} hops without finding authorized target; forcing to user`,
        }
      : context;

    const record: EscalationRecord = {
      correlationId,
      sourceAid: agentAid,
      taskId,
      targetAid: targetAid ?? 'user',
      reason,
      context: escalationContext,
      hopCount,
      resolved: false,
      createdAt: Date.now(),
    };
    this.escalations.set(correlationId, record);

    // Deliver via WS if target is an agent
    if (targetAid) {
      const targetAgent = this.orgChart.getAgent(targetAid);
      if (targetAgent) {
        const targetTeam = this.orgChart.getTeamBySlug(targetAgent.teamSlug);
        if (targetTeam) {
          this.wsHub.send(targetTeam.tid, {
            type: 'escalation_response',
            data: {
              correlation_id: correlationId,
              source_aid: agentAid,
              task_id: taskId,
              reason,
              context: escalationContext,
            },
          });
        }
      }
    }

    this.eventBus.publish({
      type: 'task.escalated',
      data: {
        correlation_id: correlationId,
        source_aid: agentAid,
        target_aid: targetAid ?? 'user',
        task_id: taskId,
        reason,
        hop_count: hopCount,
      },
      timestamp: Date.now(),
      source: agentAid,
    });

    this.logger.debug('escalation.created', {
      correlation_id: correlationId,
      source_aid: agentAid,
      target_aid: targetAid ?? 'user',
      task_id: taskId,
    });

    return correlationId;
  }

  /**
   * Handle a response to a prior escalation.
   * Dedup: reject if already resolved.
   * Delivers resolution to blocked agent, transitions task back to pending.
   */
  async handleEscalationResponse(
    correlationId: string,
    resolution: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    const record = this.escalations.get(correlationId);
    if (!record) {
      throw new NotFoundError(`Escalation '${correlationId}' not found`);
    }

    // Dedup: reject if already resolved
    if (record.resolved) {
      throw new ValidationError(`Escalation '${correlationId}' already resolved`);
    }

    const dedupKey = `${correlationId}:down`;
    if (this.dedupSet.has(dedupKey)) {
      throw new ValidationError(`Escalation response '${correlationId}' already processed`);
    }
    this.dedupSet.add(dedupKey);

    record.resolved = true;

    // Transition task escalated -> pending
    const task = await this.taskStore.get(record.taskId);
    assertValidTransition(task.status, TaskStatus.Pending);
    await this.taskStore.update({
      ...task,
      status: TaskStatus.Pending,
      updated_at: Date.now(),
    });

    // Deliver resolution to the original agent
    const sourceAgent = this.orgChart.getAgent(record.sourceAid);
    if (sourceAgent) {
      const sourceTeam = this.orgChart.getTeamBySlug(sourceAgent.teamSlug);
      if (sourceTeam) {
        this.wsHub.send(sourceTeam.tid, {
          type: 'escalation_response',
          data: {
            correlation_id: correlationId,
            resolution,
            context,
          },
        });
      }
    }

    this.eventBus.publish({
      type: 'escalation.resolved',
      data: {
        correlation_id: correlationId,
        source_aid: record.sourceAid,
        resolution,
      },
      timestamp: Date.now(),
    });
  }
}
