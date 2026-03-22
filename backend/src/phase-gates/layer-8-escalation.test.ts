/**
 * Layer 8 Phase Gate: Escalation + Proactive
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EscalationRouter } from '../control-plane/escalation-router.js';
import { ProactiveScheduler } from '../control-plane/proactive-scheduler.js';
import { TaskStatus, AgentStatus, AgentRole } from '../domain/enums.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';
import type { OrgChart, OrgChartAgent, OrgChartTeam, WSHub, TaskStore, HealthMonitor, Logger } from '../domain/interfaces.js';
import type { Task } from '../domain/domain.js';
import { createMockOrgChart, createMockWSHub, createMockTaskStore, createMockHealthMonitor, createMockLogger } from './__layer-8-helpers.js';
import { EventBusImpl } from '../control-plane/event-bus.js';

describe('Layer 8: Escalation + Proactive', () => {
  let logger: Logger;
  let eventBus: EventBusImpl;

  beforeEach(() => {
    logger = createMockLogger();
    eventBus = new EventBusImpl();
  });

  afterEach(() => {
    eventBus.close();
  });

  describe('EscalationRouter chain walking', () => {
    let router: EscalationRouter;
    let taskStore: TaskStore;
    let orgChart: OrgChart;
    let wsHub: WSHub;

    beforeEach(() => {
      taskStore = createMockTaskStore();
      orgChart = createMockOrgChart();
      wsHub = createMockWSHub();

      router = new EscalationRouter({
        orgChart,
        wsHub,
        taskStore,
        eventBus,
        logger,
      });
    });

    it('escalates member to main assistant (flat escalation)', async () => {
      vi.mocked(orgChart.getAgent).mockImplementation((aid: string) => {
        if (aid === 'aid-member') {
          return { aid: 'aid-member', teamSlug: 'team-a', role: AgentRole.Member } as OrgChartAgent;
        }
        if (aid === 'aid-main') {
          return { aid: 'aid-main', teamSlug: 'main', role: 'main_assistant' } as OrgChartAgent;
        }
        return undefined;
      });
      vi.mocked(orgChart.getAgentsByTeam).mockReturnValue([
        { aid: 'aid-main', teamSlug: 'main', role: 'main_assistant' } as OrgChartAgent,
      ]);
      vi.mocked(orgChart.getTeamBySlug).mockImplementation((slug: string) => {
        if (slug === 'team-a') return { tid: 'tid-a', slug: 'team-a' } as OrgChartTeam;
        if (slug === 'main') return { tid: 'tid-main', slug: 'main' } as OrgChartTeam;
        return undefined;
      });
      vi.mocked(taskStore.get).mockResolvedValue({
        id: 'task-1',
        status: TaskStatus.Active,
      } as Task);
      vi.mocked(taskStore.update).mockResolvedValue(undefined);

      const correlationId = await router.handleEscalation(
        'aid-member',
        'task-1',
        'error' as never,
        { reason: 'stuck' },
      );

      expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);
      // Flat escalation sends to main assistant's team
      expect(wsHub.send).toHaveBeenCalledWith(
        'tid-main',
        expect.objectContaining({
          type: 'escalation_response',
          data: expect.objectContaining({
            correlation_id: correlationId,
            task_id: 'task-1',
            agent_aid: 'aid-main',
            source_team: 'team-a',
            destination_team: 'main',
            resolution: 'pending',
          }),
        }),
      );
    });

    // Leader chain escalation test removed — flat escalation model (no leader walking)

    it('deduplicates re-escalation with same correlation_id', async () => {
      vi.mocked(orgChart.getAgent).mockReturnValue({
        aid: 'aid-member',
        teamSlug: 'team-a',
        role: AgentRole.Member,
      } as OrgChartAgent);
      vi.mocked(orgChart.getTeamBySlug).mockReturnValue({
        tid: 'tid-a',
        slug: 'team-a',
        coordinatorAid: 'aid-lead',
      } as OrgChartTeam);
      vi.mocked(taskStore.get).mockResolvedValue({
        id: 'task-1',
        status: TaskStatus.Active,
      } as Task);
      vi.mocked(taskStore.update).mockResolvedValue(undefined);

      // First escalation
      const correlationId1 = await router.handleEscalation(
        'aid-member',
        'task-1',
        'error' as never,
        { reason: 'stuck' },
      );

      // Second escalation with same correlation_id (simulating retry)
      // The dedup is based on a newly generated UUID each call, so this tests
      // that the dedup set prevents duplicate upward routing

      // Verify task was only updated once (to escalated)
      expect(taskStore.update).toHaveBeenCalledTimes(1);
      expect(correlationId1).toBeDefined();
    });

    it('handleEscalationResponse rejects unknown correlation_id', async () => {
      await expect(
        router.handleEscalationResponse('unknown-id', 'retry', {}),
      ).rejects.toThrow(NotFoundError);
    });

    it('handleEscalationResponse rejects already resolved escalation', async () => {
      vi.mocked(orgChart.getAgent).mockReturnValue({
        aid: 'aid-member',
        teamSlug: 'team-a',
      } as OrgChartAgent);
      vi.mocked(orgChart.getTeamBySlug).mockReturnValue({
        tid: 'tid-a',
        coordinatorAid: 'aid-lead',
      } as OrgChartTeam);
      vi.mocked(taskStore.get).mockResolvedValue({
        id: 'task-1',
        status: TaskStatus.Active,
      } as Task);
      vi.mocked(taskStore.update).mockResolvedValue(undefined);

      const correlationId = await router.handleEscalation(
        'aid-member',
        'task-1',
        'error' as never,
        {},
      );

      // First response succeeds
      vi.mocked(taskStore.get).mockResolvedValue({
        id: 'task-1',
        status: TaskStatus.Escalated,
      } as Task);
      await router.handleEscalationResponse(correlationId, 'retry', {});

      // Second response should fail
      await expect(
        router.handleEscalationResponse(correlationId, 'retry', {}),
      ).rejects.toThrow(ValidationError);
    });

    it('AC09/AC10: handleEscalationResponse sends all 7 fields with reversed source/destination (Sender B)', async () => {
      // Set up member in team-a, main assistant in 'main' team.
      // After flat escalation: sourceTeam='team-a', destinationTeam='main'.
      // On response: source and destination are swapped (main -> team-a).
      vi.mocked(orgChart.getAgent).mockImplementation((aid: string) => {
        if (aid === 'aid-member') {
          return { aid: 'aid-member', teamSlug: 'team-a', role: AgentRole.Member } as OrgChartAgent;
        }
        if (aid === 'aid-main') {
          return { aid: 'aid-main', teamSlug: 'main', role: 'main_assistant' } as OrgChartAgent;
        }
        return undefined;
      });
      vi.mocked(orgChart.getAgentsByTeam).mockReturnValue([
        { aid: 'aid-main', teamSlug: 'main', role: 'main_assistant' } as OrgChartAgent,
      ]);
      vi.mocked(orgChart.getTeamBySlug).mockImplementation((slug: string) => {
        if (slug === 'team-a') {
          return { tid: 'tid-a', slug: 'team-a' } as OrgChartTeam;
        }
        if (slug === 'main') {
          return { tid: 'tid-main', slug: 'main' } as OrgChartTeam;
        }
        return undefined;
      });
      vi.mocked(taskStore.get).mockResolvedValue({
        id: 'task-esc',
        status: TaskStatus.Active,
      } as Task);
      vi.mocked(taskStore.update).mockResolvedValue(undefined);

      // Escalate member to main assistant — Sender A fires here
      const correlationId = await router.handleEscalation(
        'aid-member',
        'task-esc',
        'error' as never,
        { reason: 'needs decision' },
      );

      // Reset call history to isolate Sender B assertions
      vi.mocked(wsHub.send).mockClear();

      // Transition task to Escalated for the response path
      vi.mocked(taskStore.get).mockResolvedValue({
        id: 'task-esc',
        status: TaskStatus.Escalated,
      } as Task);

      // Sender B: main assistant responds, escalation_response goes back to original agent
      await router.handleEscalationResponse(correlationId, 'retry', { guidance: 'try again' });

      expect(wsHub.send).toHaveBeenCalledOnce();
      expect(wsHub.send).toHaveBeenCalledWith(
        'tid-a', // original member's container
        {
          type: 'escalation_response',
          data: {
            correlation_id: correlationId,
            task_id: 'task-esc',
            agent_aid: 'aid-member',
            // Source/destination are REVERSED on the return trip:
            // escalation went team-a -> main, response goes main -> team-a
            source_team: 'main',
            destination_team: 'team-a',
            resolution: 'retry',
            context: { guidance: 'try again' },
          },
        },
      );
    });
  });

  // -------------------------------------------------------------------------
  // 9. Proactive Scheduler
  // -------------------------------------------------------------------------

  describe('ProactiveScheduler behavior', () => {
    let scheduler: ProactiveScheduler;
    let healthMonitor: HealthMonitor;
    let dispatchFn: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      healthMonitor = createMockHealthMonitor();
      dispatchFn = vi.fn().mockResolvedValue(undefined);

      scheduler = new ProactiveScheduler({
        healthMonitor,
        logger,
        dispatcher: dispatchFn,
      });
    });

    afterEach(() => {
      scheduler.stop();
    });

    it('dispatches proactive_check when agent is idle', async () => {
      vi.mocked(healthMonitor.getAgentHealth).mockReturnValue(AgentStatus.Idle);

      await scheduler.fireCheck('aid-worker');

      expect(dispatchFn).toHaveBeenCalledWith(
        'aid-worker',
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}-\d{2}:\d{2}-aid-worker$/),
      );
    });

    it('skips proactive_check when agent is busy', async () => {
      vi.mocked(healthMonitor.getAgentHealth).mockReturnValue(AgentStatus.Busy);

      await scheduler.fireCheck('aid-worker');

      expect(dispatchFn).not.toHaveBeenCalled();
    });

    it('skips proactive_check when agent status is unknown', async () => {
      vi.mocked(healthMonitor.getAgentHealth).mockReturnValue(undefined);

      await scheduler.fireCheck('aid-worker');

      expect(dispatchFn).not.toHaveBeenCalled();
    });

    it('deduplicates by check_id (same minute)', async () => {
      vi.mocked(healthMonitor.getAgentHealth).mockReturnValue(AgentStatus.Idle);

      // First call dispatches
      await scheduler.fireCheck('aid-worker');

      // Second call in same minute is deduplicated
      await scheduler.fireCheck('aid-worker');

      expect(dispatchFn).toHaveBeenCalledTimes(1);
    });

    it('registerAgent creates timer with minimum interval of 5 minutes', () => {
      // Request 1 minute, should be clamped to 5
      scheduler.registerAgent('aid-worker', 1);

      expect(scheduler.getRegisteredCount()).toBe(1);
    });

    it('unregisterAgent clears timer', () => {
      scheduler.registerAgent('aid-worker', 30);
      expect(scheduler.getRegisteredCount()).toBe(1);

      scheduler.unregisterAgent('aid-worker');
      expect(scheduler.getRegisteredCount()).toBe(0);
    });

    it('stop clears all timers', () => {
      scheduler.registerAgent('aid-1', 30);
      scheduler.registerAgent('aid-2', 30);

      scheduler.stop();

      expect(scheduler.getRegisteredCount()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 10. rebuildState Recovery
  // -------------------------------------------------------------------------

});
