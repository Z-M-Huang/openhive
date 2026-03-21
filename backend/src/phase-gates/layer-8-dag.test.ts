/**
 * Layer 8 Phase Gate: TaskDAGManager
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskDAGManager } from '../control-plane/task-dag-manager.js';
import { TaskStatus, AgentStatus, AgentRole } from '../domain/enums.js';
import { NotFoundError } from '../domain/errors.js';
import type { OrgChart, OrgChartAgent, OrgChartTeam, WSHub, TaskStore, Logger } from '../domain/interfaces.js';
import type { Task } from '../domain/domain.js';
import { createMockOrgChart, createMockWSHub, createMockTaskStore, createMockLogger } from './__layer-8-helpers.js';
import { EventBusImpl } from '../control-plane/event-bus.js';

describe('Layer 8: TaskDAGManager', () => {
  let logger: Logger;
  let eventBus: EventBusImpl;

  beforeEach(() => {
    logger = createMockLogger();
    eventBus = new EventBusImpl();
  });

  afterEach(() => {
    eventBus.close();
  });

  describe('TaskDAGManager dispatch and DAG', () => {
    let dagManager: TaskDAGManager;
    let taskStore: TaskStore;
    let orgChart: OrgChart;
    let wsHub: WSHub;
    let escalationHandler: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      taskStore = createMockTaskStore();
      orgChart = createMockOrgChart();
      wsHub = createMockWSHub();
      escalationHandler = vi.fn().mockResolvedValue('esc-1');

      dagManager = new TaskDAGManager({
        taskStore,
        orgChart,
        wsHub,
        eventBus,
        logger,
        onEscalation: escalationHandler,
      });
    });

    it('dispatches pending task to active', async () => {
      const task: Task = {
        id: 'task-1',
        parent_id: '',
        team_slug: 'team-a',
        agent_aid: 'aid-worker',
        title: 'Test task',
        status: TaskStatus.Pending,
        prompt: 'Do something',
        result: '',
        error: '',
        blocked_by: [],
        priority: 0,
        retry_count: 0,
        max_retries: 3,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      };

      vi.mocked(taskStore.validateDependencies).mockResolvedValue(undefined);
      vi.mocked(taskStore.getBlockedBy).mockResolvedValue([]);
      vi.mocked(orgChart.getAgent).mockReturnValue({
        aid: 'aid-worker',
        teamSlug: 'team-a',
        name: 'Worker',
        role: AgentRole.Member,
        status: AgentStatus.Idle,
      } as OrgChartAgent);
      vi.mocked(orgChart.getTeamBySlug).mockReturnValue({
        tid: 'tid-a',
        slug: 'team-a',
        leaderAid: 'aid-lead',
        parentTid: '',
        depth: 0,
        containerId: 'container-1',
        health: 'running' as never,
        agentAids: ['aid-worker'],
        workspacePath: '/workspace/team-a',
      } as OrgChartTeam);

      await dagManager.dispatchTask(task);

      expect(taskStore.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'task-1',
          status: TaskStatus.Active,
        }),
      );
      expect(wsHub.send).toHaveBeenCalledWith(
        'tid-a',
        expect.objectContaining({
          type: 'task_dispatch',
        }),
      );
    });

    it('AC05: task_dispatch wire format has blocked_by (not parent_task_id)', async () => {
      // Verifies the exact task_dispatch data payload shape per the wire protocol spec.
      // The field must be `blocked_by: []`, never `parent_task_id`.
      const task: Task = {
        id: 'task-wire-fmt',
        parent_id: '',
        team_slug: 'team-a',
        agent_aid: 'aid-worker',
        title: 'Wire format test',
        status: TaskStatus.Pending,
        prompt: 'Test wire format',
        result: '',
        error: '',
        blocked_by: [],
        priority: 0,
        retry_count: 0,
        max_retries: 3,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      };

      vi.mocked(taskStore.validateDependencies).mockResolvedValue(undefined);
      vi.mocked(taskStore.getBlockedBy).mockResolvedValue([]);
      vi.mocked(orgChart.getAgent).mockReturnValue({
        aid: 'aid-worker',
        teamSlug: 'team-a',
        name: 'Worker',
        role: AgentRole.Member,
        status: AgentStatus.Idle,
      } as OrgChartAgent);
      vi.mocked(orgChart.getTeamBySlug).mockReturnValue({
        tid: 'tid-a',
        slug: 'team-a',
        leaderAid: 'aid-lead',
        parentTid: '',
        depth: 0,
        containerId: 'container-1',
        health: 'running' as never,
        agentAids: ['aid-worker'],
        workspacePath: '/workspace/team-a',
      } as OrgChartTeam);

      await dagManager.dispatchTask(task);

      // Verify exact data payload shape: must use blocked_by, not parent_task_id
      expect(wsHub.send).toHaveBeenCalledWith(
        'tid-a',
        {
          type: 'task_dispatch',
          data: {
            task_id: 'task-wire-fmt',
            agent_aid: 'aid-worker',
            prompt: 'Test wire format',
            blocked_by: [],
          },
        },
      );
      // Verify parent_task_id is NOT present in the payload
      const sentPayload = vi.mocked(wsHub.send).mock.calls[0][1] as {
        type: string;
        data: Record<string, unknown>;
      };
      expect('parent_task_id' in sentPayload.data).toBe(false);
    });

    it('defers dispatch when blocked', async () => {
      const task: Task = {
        id: 'task-2',
        parent_id: '',
        team_slug: 'team-a',
        agent_aid: 'aid-worker',
        title: 'Blocked task',
        status: TaskStatus.Pending,
        prompt: 'Do something',
        result: '',
        error: '',
        blocked_by: ['task-1'],
        priority: 0,
        retry_count: 0,
        max_retries: 3,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      };

      vi.mocked(taskStore.validateDependencies).mockResolvedValue(undefined);
      vi.mocked(taskStore.getBlockedBy).mockResolvedValue(['task-1']);

      await dagManager.dispatchTask(task);

      // Should NOT update status when blocked
      expect(taskStore.update).not.toHaveBeenCalled();
      expect(wsHub.send).not.toHaveBeenCalled();
    });

    it('auto-dispatches dependent after blocker completes', async () => {
      const blockerTask: Task = {
        id: 'task-1',
        parent_id: 'parent-1',
        team_slug: 'team-a',
        agent_aid: 'aid-worker-1',
        title: 'Blocker',
        status: TaskStatus.Active,
        prompt: 'Do work',
        result: '',
        error: '',
        blocked_by: [],
        priority: 0,
        retry_count: 0,
        max_retries: 3,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      };

      const dependentTask: Task = {
        id: 'task-2',
        parent_id: 'parent-1',
        team_slug: 'team-a',
        agent_aid: 'aid-worker-2',
        title: 'Dependent',
        status: TaskStatus.Pending,
        prompt: 'Do more work',
        result: '',
        error: '',
        blocked_by: ['task-1'],
        priority: 0,
        retry_count: 0,
        max_retries: 3,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      };

      // Store mock with tasks
      const tasks = new Map<string, Task>();
      tasks.set('task-1', blockerTask);
      tasks.set('task-2', dependentTask);

      vi.mocked(taskStore.get).mockImplementation(async (id: string) => {
        const t = tasks.get(id);
        if (!t) throw new NotFoundError(`Task ${id} not found`);
        return t;
      });
      vi.mocked(taskStore.update).mockImplementation(async (task: Task) => {
        tasks.set(task.id, task);
      });
      vi.mocked(taskStore.getSubtree).mockResolvedValue([blockerTask, dependentTask]);
      vi.mocked(taskStore.unblockTask).mockResolvedValue(true);
      vi.mocked(orgChart.getAgent).mockReturnValue({
        aid: 'aid-worker-2',
        teamSlug: 'team-a',
        name: 'Worker 2',
        role: AgentRole.Member,
        status: AgentStatus.Idle,
      } as OrgChartAgent);
      vi.mocked(orgChart.getTeamBySlug).mockReturnValue({
        tid: 'tid-a',
        slug: 'team-a',
        leaderAid: 'aid-lead',
        parentTid: '',
        depth: 0,
        containerId: 'container-1',
        health: 'running' as never,
        agentAids: ['aid-worker-2'],
        workspacePath: '/workspace/team-a',
      } as OrgChartTeam);
      vi.mocked(taskStore.getBlockedBy).mockResolvedValue([]);

      // Complete the blocker
      await dagManager.handleTaskResult('task-1', 'aid-worker-1', TaskStatus.Completed, 'done');

      // Verify unblockTask was called for the dependent
      expect(taskStore.unblockTask).toHaveBeenCalledWith('task-2', 'task-1');
    });
  });

  // -------------------------------------------------------------------------
  // 7. Task DAG Mixed Terminal (User Decision #4)
  // -------------------------------------------------------------------------

  describe('TaskDAGManager mixed terminal (User Decision #4)', () => {
    let dagManager: TaskDAGManager;
    let taskStore: TaskStore;
    let orgChart: OrgChart;
    let wsHub: WSHub;
    let escalationHandler: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      taskStore = createMockTaskStore();
      orgChart = createMockOrgChart();
      wsHub = createMockWSHub();
      escalationHandler = vi.fn().mockResolvedValue('esc-terminal');

      dagManager = new TaskDAGManager({
        taskStore,
        orgChart,
        wsHub,
        eventBus,
        logger,
        onEscalation: escalationHandler,
      });
    });

    it('escalates when blocker fails terminally (no retries)', async () => {
      const blockerTask: Task = {
        id: 'task-blocker',
        parent_id: 'parent-1',
        team_slug: 'team-a',
        agent_aid: 'aid-worker-1',
        title: 'Blocker',
        status: TaskStatus.Active,
        prompt: 'Do work',
        result: '',
        error: '',
        blocked_by: [],
        priority: 0,
        retry_count: 2, // Already used retries
        max_retries: 2, // No more retries
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      };

      vi.mocked(taskStore.get).mockResolvedValue(blockerTask);
      vi.mocked(orgChart.getTeamBySlug).mockReturnValue({
        tid: 'tid-a',
        slug: 'team-a',
        leaderAid: 'aid-lead',
      } as OrgChartTeam);

      // Blocker fails with no retries left
      await dagManager.handleTaskResult('task-blocker', 'aid-worker-1', TaskStatus.Failed, '', 'Critical error');

      // Should escalate — the DAGManager passes the worker's AID to the escalation callback
      expect(escalationHandler).toHaveBeenCalledWith(
        'aid-worker-1',
        'task-blocker',
        'error',
        expect.objectContaining({
          failed_task_id: 'task-blocker',
          retries_exhausted: true,
        }),
      );
    });

    it('cascade cancels dependent when blocker is cancelled', async () => {
      const blockerTask: Task = {
        id: 'task-blocker',
        parent_id: 'parent-1',
        team_slug: 'team-a',
        agent_aid: 'aid-worker-1',
        title: 'Blocker',
        status: TaskStatus.Active,
        prompt: 'Do work',
        result: '',
        error: '',
        blocked_by: [],
        priority: 0,
        retry_count: 0,
        max_retries: 3,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      };

      const dependentTask: Task = {
        id: 'task-dependent',
        parent_id: 'parent-1',
        team_slug: 'team-a',
        agent_aid: 'aid-worker-2',
        title: 'Dependent',
        status: TaskStatus.Pending,
        prompt: 'Wait for blocker',
        result: '',
        error: '',
        blocked_by: ['task-blocker'],
        priority: 0,
        retry_count: 0,
        max_retries: 3,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      };

      const tasks = new Map<string, Task>();
      tasks.set('task-blocker', blockerTask);
      tasks.set('task-dependent', dependentTask);

      vi.mocked(taskStore.get).mockImplementation(async (id: string) => {
        const t = tasks.get(id);
        if (!t) throw new NotFoundError(`Task ${id} not found`);
        return t;
      });
      vi.mocked(taskStore.update).mockImplementation(async (task: Task) => {
        tasks.set(task.id, task);
      });
      vi.mocked(taskStore.getSubtree).mockResolvedValue([blockerTask, dependentTask]);

      // User cancels blocker
      await dagManager.handleTaskResult('task-blocker', 'aid-worker-1', TaskStatus.Cancelled);

      // Verify dependent was cascade cancelled
      expect(taskStore.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'task-dependent',
          status: TaskStatus.Cancelled,
          error: expect.stringContaining('Cascade'),
        }),
      );
    });

    it('retry transitions failed to pending when retries remain', async () => {
      const task: Task = {
        id: 'task-retry',
        parent_id: '',
        team_slug: 'team-a',
        agent_aid: 'aid-worker',
        title: 'Retry task',
        status: TaskStatus.Active,
        prompt: 'Do work',
        result: '',
        error: '',
        blocked_by: [],
        priority: 0,
        retry_count: 0,
        max_retries: 3,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      };

      const tasks = new Map<string, Task>();
      tasks.set('task-retry', task);

      vi.mocked(taskStore.get).mockImplementation(async (id: string) => {
        const t = tasks.get(id);
        if (!t) throw new NotFoundError(`Task ${id} not found`);
        return t;
      });
      vi.mocked(taskStore.update).mockImplementation(async (t: Task) => {
        tasks.set(t.id, t);
      });
      vi.mocked(taskStore.getBlockedBy).mockResolvedValue([]);
      vi.mocked(orgChart.getAgent).mockReturnValue({
        aid: 'aid-worker',
        teamSlug: 'team-a',
      } as OrgChartAgent);
      vi.mocked(orgChart.getTeamBySlug).mockReturnValue({
        tid: 'tid-a',
        containerId: 'container-1',
      } as OrgChartTeam);

      // Task fails but has retries
      await dagManager.handleTaskResult('task-retry', 'aid-worker', TaskStatus.Failed, '', 'Temporary error');

      // After failure with retries, the task transitions:
      // Failed -> Pending (for retry), then dispatchTask is called which makes it Active
      // The retry_count should be incremented
      const updatedTask = tasks.get('task-retry');
      expect(updatedTask?.retry_count).toBe(1);
      // Task should be dispatched (active) since dispatchTask is called after retry
      expect([TaskStatus.Pending, TaskStatus.Active]).toContain(updatedTask?.status);
    });
  });

  // -------------------------------------------------------------------------
  // 8. Escalation Chain
  // -------------------------------------------------------------------------

});
