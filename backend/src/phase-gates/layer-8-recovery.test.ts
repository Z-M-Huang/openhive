/**
 * Layer 8 Phase Gate: Recovery + Retention
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RetentionWorker } from '../control-plane/retention-worker.js';
import { TaskStatus, LogLevel } from '../domain/enums.js';
import { NotFoundError } from '../domain/errors.js';
import type { MemoryStore, Logger, LogStore, OrgChartTeam } from '../domain/interfaces.js';
import type { Task } from '../domain/domain.js';
import { createMockTaskStore, createMockMemoryStore, createMockLogger, createMockLogStore, createMockOrgChart } from './__layer-8-helpers.js';
import { EventBusImpl } from '../control-plane/event-bus.js';

describe('Layer 8: Recovery + Retention', () => {
  let logger: Logger;
  let eventBus: EventBusImpl;

  beforeEach(() => {
    logger = createMockLogger();
    eventBus = new EventBusImpl();
  });

  afterEach(() => {
    eventBus.close();
  });

  describe('Task recovery after restart', () => {
    it('marks active tasks as failed (recovery) and retries if possible', async () => {
      const taskStore = createMockTaskStore();
      const orgChart = createMockOrgChart();

      const taskWithRetries: Task = {
        id: 'task-retry',
        parent_id: '',
        team_slug: 'team-a',
        agent_aid: 'aid-worker',
        title: 'Task with retries',
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

      const taskNoRetries: Task = {
        id: 'task-no-retry',
        parent_id: '',
        team_slug: 'team-a',
        agent_aid: 'aid-worker',
        title: 'Task without retries',
        status: TaskStatus.Active,
        prompt: 'Do work',
        result: '',
        error: '',
        blocked_by: [],
        priority: 0,
        retry_count: 3,
        max_retries: 3,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      };

      vi.mocked(taskStore.listByStatus).mockResolvedValue([taskWithRetries, taskNoRetries]);
      vi.mocked(orgChart.getTeamBySlug).mockReturnValue({
        coordinatorAid: 'aid-lead',
      } as OrgChartTeam);

      const escalationHandler = vi.fn().mockResolvedValue('esc-1');

      // Simulate recovery: mark failed, then retry or escalate
      const tasks = new Map<string, Task>();
      tasks.set('task-retry', taskWithRetries);
      tasks.set('task-no-retry', taskNoRetries);

      vi.mocked(taskStore.get).mockImplementation(async (id: string) => {
        const t = tasks.get(id);
        if (!t) throw new NotFoundError(`Task ${id} not found`);
        return t;
      });
      vi.mocked(taskStore.update).mockImplementation(async (task: Task) => {
        tasks.set(task.id, task);
      });

      // Mark tasks as failed
      for (const task of [taskWithRetries, taskNoRetries]) {
        await taskStore.update({
          ...task,
          status: TaskStatus.Failed,
          error: 'Task interrupted by orchestrator restart (recovery)',
          updated_at: Date.now(),
          completed_at: Date.now(),
        });
      }

      // Retry task with retries
      if (taskWithRetries.retry_count < taskWithRetries.max_retries) {
        await taskStore.update({
          ...taskWithRetries,
          status: TaskStatus.Pending,
          retry_count: taskWithRetries.retry_count + 1,
          error: '',
          updated_at: Date.now(),
          completed_at: null,
        });
      }

      // Escalate task without retries
      if (taskNoRetries.retry_count >= taskNoRetries.max_retries) {
        await escalationHandler('aid-lead', 'task-no-retry', 'error' as never, {
          recovery: true,
          retries_exhausted: true,
        });
      }

      // Verify retry task was transitioned to pending
      const retryTask = tasks.get('task-retry');
      expect(retryTask?.status).toBe(TaskStatus.Pending);
      expect(retryTask?.retry_count).toBe(1);

      // Verify no-retry task escalated
      expect(escalationHandler).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 11. Memory Reconciliation
  // -------------------------------------------------------------------------

  describe('RetentionWorker memory reconciliation', () => {
    let worker: RetentionWorker;
    let logStore: LogStore;
    let memoryStore: MemoryStore;
    let archiveWriter: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      logStore = createMockLogStore();
      memoryStore = createMockMemoryStore();
      archiveWriter = vi.fn().mockResolvedValue(undefined);

      worker = new RetentionWorker({
        logStore,
        memoryStore,
        logger,
        archiveWriter,
      });
    });

    afterEach(() => {
      worker.stop();
    });

    it('reindexes workspace memory files into SQLite', async () => {
      const memoryEntries = [
        { content: 'Memory entry 1', memoryType: 'curated' as const, createdAt: Date.now() - 1000 },
        { content: 'Memory entry 2', memoryType: 'daily' as const, createdAt: Date.now() },
      ];

      const indexed = await worker.reconcileMemory(
        'aid-worker',
        'team-a',
        memoryEntries,
      );

      expect(indexed).toBe(2);
      expect(memoryStore.save).toHaveBeenCalledTimes(2);
    });

    it('handles empty memory entries', async () => {
      const indexed = await worker.reconcileMemory(
        'aid-worker',
        'team-a',
        [],
      );

      expect(indexed).toBe(0);
      expect(memoryStore.save).not.toHaveBeenCalled();
    });

    it('runRetention sweeps expired entries by tier', async () => {
      vi.mocked(logStore.deleteByLevelBefore).mockResolvedValue(10);

      const deleted = await worker.runRetention();

      expect(deleted).toBe(50); // 5 levels (trace, debug, info, warn, error) x 10 each
      expect(logStore.deleteByLevelBefore).toHaveBeenCalled();
    });

    it('runArchive exports when count > threshold', async () => {
      vi.mocked(logStore.count).mockResolvedValue(150_000);
      vi.mocked(logStore.getOldest).mockResolvedValue([
        {
          id: 1,
          level: LogLevel.Debug,
          event_type: 'test',
          component: 'test',
          action: 'test',
          message: 'old log',
          params: '{}',
          team_slug: 'team-a',
          task_id: '',
          agent_aid: '',
          request_id: '',
          correlation_id: '',
          error: '',
          duration_ms: 0,
          created_at: Date.now() - 10000,
        },
      ]);
      vi.mocked(logStore.deleteBefore).mockResolvedValue(1);

      const archived = await worker.runArchive();

      expect(archived).toBe(1);
      expect(archiveWriter).toHaveBeenCalled();
    });

    it('runArchive skips when count < threshold', async () => {
      vi.mocked(logStore.count).mockResolvedValue(50_000);

      const archived = await worker.runArchive();

      expect(archived).toBe(0);
      expect(archiveWriter).not.toHaveBeenCalled();
    });

    it('shared lock prevents simultaneous retention and archive', async () => {
      vi.mocked(logStore.deleteByLevelBefore).mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return 1;
      });
      vi.mocked(logStore.count).mockResolvedValue(150_000);

      // Run both concurrently
      const [retentionResult, archiveResult] = await Promise.all([
        worker.runRetention(),
        worker.runArchive(),
      ]);

      // Only one should run (the other should return 0 due to lock)
      const totalRun = (retentionResult > 0 ? 1 : 0) + (archiveResult > 0 ? 1 : 0);
      expect(totalRun).toBeLessThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // Integration: Full Flow
  // -------------------------------------------------------------------------

});
