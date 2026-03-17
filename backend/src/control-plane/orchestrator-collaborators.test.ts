/**
 * Integration tests for the 5 orchestrator collaborators.
 * AC-L8-01, AC-L8-04 through AC-L8-15, AC-L8-18, AC-L8-19.
 * AC21, AC22: archiveWriter callback path validation and gzip write.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { ValidationError } from '../domain/errors.js';

import { ToolCallDispatcher } from './tool-call-dispatcher';
import { TaskDAGManager } from './task-dag-manager';
import { EscalationRouter } from './escalation-router';
import { ProactiveScheduler } from './proactive-scheduler';
import { RetentionWorker } from './retention-worker';

import { TaskStatus, AgentStatus, LogLevel, AgentRole } from '../domain/enums.js';
import { RateLimitedError, AccessDeniedError } from '../domain/errors.js';

// Mock factory functions
function createMockOrgChart() {
  return {
    addTeam: vi.fn(), updateTeam: vi.fn(), removeTeam: vi.fn(), addAgent: vi.fn(), updateAgent: vi.fn(), removeAgent: vi.fn(),
    getTeam: vi.fn(), getParent: vi.fn(), getLeadOf: vi.fn(),
    getTeamBySlug: vi.fn(), getTeamByTid: vi.fn(), getAgent: vi.fn(),
    getAgentsByTeam: vi.fn(), getTeamLead: vi.fn(), getParentTeam: vi.fn(),
    getChildren: vi.fn(), isAncestor: vi.fn(), isAuthorized: vi.fn(),
    getTopology: vi.fn(), listTeams: vi.fn(),
  };
}

function createMockWSHub() {
  return {
    register: vi.fn(), unregister: vi.fn(), route: vi.fn(), send: vi.fn(),
    broadcast: vi.fn(), handleUpgrade: vi.fn(), isConnected: vi.fn(),
    setReady: vi.fn(), isReady: vi.fn(),
    close: vi.fn(), getConnectedTeams: vi.fn(),
  };
}

function createMockTaskStore() {
  return {
    create: vi.fn(), get: vi.fn(), getById: vi.fn(), update: vi.fn(),
    updateStatus: vi.fn(), delete: vi.fn(), listByTeam: vi.fn(),
    listByStatus: vi.fn(), listBlockedBy: vi.fn(), getBlockedBy: vi.fn(),
    getSubtree: vi.fn(), unblockTask: vi.fn(), validateDependencies: vi.fn(),
    retryTask: vi.fn(),
    getRecentUserTasks: vi.fn().mockResolvedValue([]),
  };
}

function createMockEventBus() {
  return {
    subscribe: vi.fn(), filteredSubscribe: vi.fn(), unsubscribe: vi.fn(),
    publish: vi.fn(), close: vi.fn(),
  };
}

function createMockLogger() {
  return {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
    error: vi.fn(), audit: vi.fn(), log: vi.fn(), flush: vi.fn(), stop: vi.fn(),
  };
}

function createMockMCPRegistry() {
  return {
    registerTool: vi.fn(), unregisterTool: vi.fn(), getTool: vi.fn(),
    isAllowed: vi.fn(), listTools: vi.fn(), getToolsForRole: vi.fn(),
  };
}

function createMockToolCallStore() {
  return {
    create: vi.fn(), getByTask: vi.fn(), getByAgent: vi.fn(),
    getByToolName: vi.fn(), listByAgent: vi.fn(),
  };
}

function createMockHealthMonitor() {
  return {
    recordHeartbeat: vi.fn(), getHealth: vi.fn(), getAgentHealth: vi.fn(),
    getAllHealth: vi.fn(), getStuckAgents: vi.fn(), start: vi.fn(), stop: vi.fn(),
  };
}

function createMockLogStore() {
  return {
    create: vi.fn().mockResolvedValue(undefined),
    createWithIds: vi.fn().mockResolvedValue([1]),
    list: vi.fn(), deleteByIds: vi.fn(),
    count: vi.fn(), getOldest: vi.fn(), deleteByLevelBefore: vi.fn(), deleteBefore: vi.fn(),
    query: vi.fn(),
  };
}

function createMockMemoryStore() {
  return {
    save: vi.fn().mockResolvedValue(1), search: vi.fn(), listByAgent: vi.fn(),
    softDeleteByAgent: vi.fn(), purgeDeleted: vi.fn(), reconcileWorkspace: vi.fn(),
    getByAgent: vi.fn(), deleteBefore: vi.fn(), softDeleteByTeam: vi.fn(),
    searchBM25: vi.fn().mockResolvedValue([]),
    searchHybrid: vi.fn().mockResolvedValue([]),
    saveChunks: vi.fn().mockResolvedValue(undefined),
    getChunks: vi.fn().mockResolvedValue([]),
    deleteChunks: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ToolCallDispatcher', () => {
  let dispatcher: ToolCallDispatcher;
  let orgChart: ReturnType<typeof createMockOrgChart>;
  let mcpRegistry: ReturnType<typeof createMockMCPRegistry>;
  let logStore: ReturnType<typeof createMockLogStore>;
  let toolCallStore: ReturnType<typeof createMockToolCallStore>;

  beforeEach(() => {
    orgChart = createMockOrgChart();
    mcpRegistry = createMockMCPRegistry();
    logStore = createMockLogStore();
    toolCallStore = createMockToolCallStore();

    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>>();
    handlers.set('test_tool', vi.fn().mockResolvedValue({ success: true }));

    dispatcher = new ToolCallDispatcher({
      orgChart,
      mcpRegistry,
      logStore,
      toolCallStore,
      logger: createMockLogger(),
      handlers,
    });
  });

  it('dedup - duplicate call_id returns cached result', async () => {
    const callId = crypto.randomUUID();
    vi.mocked(orgChart.getAgent).mockReturnValue({ role: AgentRole.Member, teamSlug: 'team-a' } as any);
    vi.mocked(mcpRegistry.isAllowed).mockReturnValue(true);

    // First call executes
    const result1 = await dispatcher.handleToolCall('aid-test', 'test_tool', { x: 1 }, callId);

    // Second call with same call_id returns cached (doesn't re-execute)
    const result2 = await dispatcher.handleToolCall('aid-test', 'test_tool', { x: 2 }, callId);

    expect(result1).toEqual(result2);
    // Tool should only be called once (cached on second)
    expect(toolCallStore.create).toHaveBeenCalledTimes(1);
  });

  it('rate limiting - exceeds limit throws RateLimitedError', async () => {
    const callId1 = crypto.randomUUID();
    const callId2 = crypto.randomUUID();
    const callId3 = crypto.randomUUID();
    const callId4 = crypto.randomUUID();
    const callId5 = crypto.randomUUID();
    const callId6 = crypto.randomUUID();

    vi.mocked(orgChart.getAgent).mockReturnValue({ role: AgentRole.Member, teamSlug: 'team-a' } as any);
    vi.mocked(mcpRegistry.isAllowed).mockReturnValue(true);

    // create_team has limit of 5/minute - call 6 times should fail on 6th
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>>();
    handlers.set('create_team', vi.fn().mockResolvedValue({ success: true }));

    const disp = new ToolCallDispatcher({
      orgChart,
      mcpRegistry,
      logStore,
      toolCallStore,
      logger: createMockLogger(),
      handlers,
    });

    // First 5 should succeed
    await disp.handleToolCall('aid-test', 'create_team', {}, callId1);
    await disp.handleToolCall('aid-test', 'create_team', {}, callId2);
    await disp.handleToolCall('aid-test', 'create_team', {}, callId3);
    await disp.handleToolCall('aid-test', 'create_team', {}, callId4);
    await disp.handleToolCall('aid-test', 'create_team', {}, callId5);

    // 6th should throw
    await expect(disp.handleToolCall('aid-test', 'create_team', {}, callId6))
      .rejects.toThrow(RateLimitedError);
  });

  it('authorization - denied when not allowed', async () => {
    vi.mocked(orgChart.getAgent).mockReturnValue({ role: AgentRole.Member, teamSlug: 'team-a' } as any);
    vi.mocked(mcpRegistry.isAllowed).mockReturnValue(false);

    await expect(
      dispatcher.handleToolCall('aid-test', 'test_tool', {}, crypto.randomUUID())
    ).rejects.toThrow(AccessDeniedError);
  });

  it('cleanupAgent removes rate limiter entry', () => {
    vi.mocked(orgChart.getAgent).mockReturnValue({ role: AgentRole.Member, teamSlug: 'team-a' } as any);
    vi.mocked(mcpRegistry.isAllowed).mockReturnValue(true);

    // Trigger lazy init of rate limiter
    (dispatcher as any).rateLimiters.set('aid-test', { timestamps: [] });

    dispatcher.cleanupAgent('aid-test');

    expect((dispatcher as any).rateLimiters.has('aid-test')).toBe(false);
  });
});

describe('TaskDAGManager', () => {
  let taskStore: ReturnType<typeof createMockTaskStore>;
  let orgChart: ReturnType<typeof createMockOrgChart>;
  let wsHub: ReturnType<typeof createMockWSHub>;
  let eventBus: ReturnType<typeof createMockEventBus>;
  let dagManager: TaskDAGManager;

  beforeEach(() => {
    taskStore = createMockTaskStore();
    orgChart = createMockOrgChart();
    wsHub = createMockWSHub();
    eventBus = createMockEventBus();

    dagManager = new TaskDAGManager({
      taskStore,
      orgChart,
      wsHub,
      eventBus,
      logger: createMockLogger(),
      onEscalation: vi.fn().mockResolvedValue('esc-test'),
    });
  });

  it('dispatchTask transitions pending to active', async () => {
    const task = {
      id: 'task-1',
      status: TaskStatus.Pending,
      blocked_by: [],
      agent_aid: 'aid-worker',
      prompt: 'test',
    };

    vi.mocked(taskStore.validateDependencies).mockResolvedValue(undefined as any);
    vi.mocked(taskStore.getBlockedBy).mockResolvedValue([]);
    vi.mocked(orgChart.getAgent).mockReturnValue({ teamSlug: 'team-a' } as any);
    vi.mocked(orgChart.getTeamBySlug).mockReturnValue({ tid: 'tid-a', containerId: 'container-1' } as any);
    vi.mocked(wsHub.isConnected).mockReturnValue(true);

    await dagManager.dispatchTask(task as any);

    expect(taskStore.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: TaskStatus.Active })
    );
    expect(wsHub.send).toHaveBeenCalled();
  });

  it('handleTaskResult completes task', async () => {
    const task = {
      id: 'task-1',
      status: TaskStatus.Active,
      blocked_by: [],
      agent_aid: 'aid-worker',
      prompt: 'test',
    };

    vi.mocked(taskStore.get).mockResolvedValue(task as any);
    vi.mocked(taskStore.getBlockedBy).mockResolvedValue([]);
    vi.mocked(taskStore.listBlockedBy).mockResolvedValue([]);

    await dagManager.handleTaskResult('task-1', 'aid-worker', TaskStatus.Completed, 'done');

    expect(taskStore.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: TaskStatus.Completed })
    );
  });
});

describe('EscalationRouter', () => {
  let router: EscalationRouter;
  let taskStore: ReturnType<typeof createMockTaskStore>;
  let orgChart: ReturnType<typeof createMockOrgChart>;
  let wsHub: ReturnType<typeof createMockWSHub>;

  beforeEach(() => {
    taskStore = createMockTaskStore();
    orgChart = createMockOrgChart();
    wsHub = createMockWSHub();

    router = new EscalationRouter({
      orgChart,
      wsHub,
      taskStore,
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
    });
  });

  it('handleEscalation creates record and returns correlationId', async () => {
    vi.mocked(orgChart.getAgent).mockReturnValue({ teamSlug: 'team-a' } as any);
    vi.mocked(orgChart.getTeamBySlug).mockReturnValue({ tid: 'tid-a', leaderAid: 'aid-lead' } as any);
    vi.mocked(taskStore.get).mockResolvedValue({ id: 'task-123', status: TaskStatus.Active } as any);
    vi.mocked(taskStore.update).mockResolvedValue(undefined as any);
    vi.mocked(wsHub.isConnected).mockReturnValue(true);

    const correlationId = await router.handleEscalation(
      'aid-member',
      'task-123',
      'NEEDS_HUMAN_INPUT' as any,
      { test: true },
    );

    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('handleEscalationResponse throws for unknown correlation_id', async () => {
    await expect(
      router.handleEscalationResponse('unknown-id', 'retry', {})
    ).rejects.toThrow();
  });
});

describe('ProactiveScheduler', () => {
  let scheduler: ProactiveScheduler;
  let healthMonitor: ReturnType<typeof createMockHealthMonitor>;
  let dispatchFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    healthMonitor = createMockHealthMonitor();
    dispatchFn = vi.fn().mockResolvedValue(undefined);

    scheduler = new ProactiveScheduler({
      healthMonitor,
      logger: createMockLogger(),
      dispatcher: dispatchFn,
    });
  });

  afterEach(() => {
    scheduler.stop();
  });

  it('registerAgent creates timer entry', () => {
    scheduler.registerAgent('aid-test', 5);
    expect((scheduler as any).timers.has('aid-test')).toBe(true);
  });

  it('unregisterAgent clears timer', () => {
    scheduler.registerAgent('aid-test', 5);
    scheduler.unregisterAgent('aid-test');
    expect((scheduler as any).timers.has('aid-test')).toBe(false);
  });

  it('stop() clears all timers', () => {
    scheduler.registerAgent('aid-1', 5);
    scheduler.registerAgent('aid-2', 5);
    scheduler.stop();
    expect((scheduler as any).timers.size).toBe(0);
  });

  it('fireCheck skips non-idle agent', async () => {
    vi.mocked(healthMonitor.getAgentHealth).mockResolvedValue({ status: AgentStatus.Busy } as any);
    await (scheduler as any).fireCheck('aid-busy');
    expect(dispatchFn).not.toHaveBeenCalled();
  });
});

describe('RetentionWorker', () => {
  let worker: RetentionWorker;
  let logStore: ReturnType<typeof createMockLogStore>;
  let archiveWriter: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logStore = createMockLogStore();
    archiveWriter = vi.fn().mockResolvedValue(undefined);

    worker = new RetentionWorker({
      logStore,
      memoryStore: createMockMemoryStore(),
      logger: createMockLogger(),
      archiveWriter,
    });
  });

  afterEach(() => {
    worker.stop();
  });

  it('runRetention deletes expired entries', async () => {
    vi.mocked(logStore.deleteByLevelBefore).mockResolvedValue(2);
    await (worker as any).runRetention();
    expect(logStore.deleteByLevelBefore).toHaveBeenCalled();
  });

  it('runArchive exports when count > 100K', async () => {
    vi.mocked(logStore.count).mockResolvedValue(150_000);
    vi.mocked(logStore.getOldest).mockResolvedValue([
      { id: 1, level: LogLevel.Trace, message: 'old1', created_at: Date.now() - 1000 },
    ] as any);
    vi.mocked(logStore.deleteBefore).mockResolvedValue(1);

    await (worker as any).runArchive();

    expect(logStore.getOldest).toHaveBeenCalled();
    expect(archiveWriter).toHaveBeenCalled();
  });

  it('runArchive skips when count < 100K', async () => {
    vi.mocked(logStore.count).mockResolvedValue(50_000);

    await (worker as any).runArchive();

    expect(logStore.getOldest).not.toHaveBeenCalled();
  });

  it('stop() clears both timers', () => {
    worker.start();
    worker.stop();
    expect((worker as any).retentionTimer).toBeUndefined();
    expect((worker as any).archiveTimer).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// archiveWriter callback — path validation and file writing (AC21, AC22)
// ---------------------------------------------------------------------------

/**
 * Builds the archiveWriter callback in isolation (same logic as OrchestratorImpl)
 * so we can test it without standing up the full orchestrator.
 */
function buildArchiveWriter(archiveDir: string | undefined, dataDir: string | undefined, logger: ReturnType<typeof createMockLogger>) {
  return async (entries: string, copyIndex: number): Promise<void> => {
    const nodePath = await import('node:path');
    const resolvedArchiveDir = nodePath.resolve(archiveDir ?? 'data/archives');
    const expectedBase = nodePath.resolve(dataDir ?? 'data');

    if (resolvedArchiveDir !== expectedBase && !resolvedArchiveDir.startsWith(expectedBase + nodePath.sep)) {
      logger.error('archive.path_traversal', {
        archive_dir: resolvedArchiveDir,
        expected_base: expectedBase,
      });
      throw new ValidationError(
        `Archive directory '${resolvedArchiveDir}' is outside allowed base '${expectedBase}'`
      );
    }

    const nodeFs = await import('node:fs/promises');
    await nodeFs.mkdir(resolvedArchiveDir, { recursive: true });

    const filename = `logs-archive-${copyIndex}.ndjson.gz`;
    const filePath = nodePath.resolve(resolvedArchiveDir, filename);
    await nodeFs.writeFile(filePath, Buffer.from(entries, 'base64'));

    logger.info('archive.written', { path: filePath, copy_index: copyIndex });
  };
}

const gunzip = promisify(zlib.gunzip);

describe('archiveWriter callback (AC21, AC22)', () => {
  let tmpBase: string;
  let archivePath: string;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'openhive-test-'));
    archivePath = path.join(tmpBase, 'archives');
    logger = createMockLogger();
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it('writes base64-decoded gzip content to the archive directory', async () => {
    const ndjson = '{"level":10,"message":"hello"}\n';
    const gzipped = zlib.gzipSync(Buffer.from(ndjson, 'utf-8'));
    const base64 = gzipped.toString('base64');

    const writer = buildArchiveWriter(archivePath, tmpBase, logger);
    await writer(base64, 0);

    const writtenFile = path.join(archivePath, 'logs-archive-0.ndjson.gz');
    const raw = await fs.readFile(writtenFile);
    const decompressed = await gunzip(raw);
    expect(decompressed.toString('utf-8')).toBe(ndjson);
  });

  it('creates the archive directory recursively if it does not exist', async () => {
    const deepArchive = path.join(tmpBase, 'nested', 'deep', 'archives');
    const ndjson = '{"level":10,"message":"x"}\n';
    const base64 = zlib.gzipSync(Buffer.from(ndjson)).toString('base64');

    const writer = buildArchiveWriter(deepArchive, tmpBase, logger);
    await writer(base64, 1);

    const stat = await fs.stat(deepArchive);
    expect(stat.isDirectory()).toBe(true);
  });

  it('uses copyIndex in the filename', async () => {
    const base64 = zlib.gzipSync(Buffer.from('')).toString('base64');
    const writer = buildArchiveWriter(archivePath, tmpBase, logger);
    await writer(base64, 42);

    const writtenFile = path.join(archivePath, 'logs-archive-42.ndjson.gz');
    const stat = await fs.stat(writtenFile);
    expect(stat.isFile()).toBe(true);
  });

  it('logs archive.written after successful write', async () => {
    const base64 = zlib.gzipSync(Buffer.from('')).toString('base64');
    const writer = buildArchiveWriter(archivePath, tmpBase, logger);
    await writer(base64, 7);

    expect(logger.info).toHaveBeenCalledWith(
      'archive.written',
      expect.objectContaining({ copy_index: 7 })
    );
  });

  it('throws ValidationError for a sibling-prefix path attack', async () => {
    // /tmp/openhive-test-XXX-evil starts with /tmp/openhive-test-XXX but is not under it
    const siblingAttack = tmpBase + '-evil';
    const writer = buildArchiveWriter(siblingAttack, tmpBase, logger);

    const base64 = zlib.gzipSync(Buffer.from('')).toString('base64');
    await expect(writer(base64, 0)).rejects.toThrow(ValidationError);
    expect(logger.error).toHaveBeenCalledWith(
      'archive.path_traversal',
      expect.objectContaining({ archive_dir: expect.any(String) })
    );
  });

  it('allows archiveDir equal to dataDir (exact match)', async () => {
    // archiveDir === expectedBase is explicitly allowed
    const base64 = zlib.gzipSync(Buffer.from('')).toString('base64');
    const writer = buildArchiveWriter(tmpBase, tmpBase, logger);
    await expect(writer(base64, 0)).resolves.toBeUndefined();
  });

  it('allows a proper subdirectory of dataDir', async () => {
    const base64 = zlib.gzipSync(Buffer.from('')).toString('base64');
    // archivePath = tmpBase/archives — proper subdirectory
    const writer = buildArchiveWriter(archivePath, tmpBase, logger);
    await expect(writer(base64, 0)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// proactiveDispatcher callback — PROACTIVE.md reading and task dispatch (AC23, AC24)
// ---------------------------------------------------------------------------

/**
 * Builds the proactive dispatcher callback in isolation (same logic as OrchestratorImpl)
 * so we can test it without standing up the full orchestrator.
 *
 * The factory accepts injectable collaborators so each behaviour path is exercisable
 * from unit tests: mock orgChart, mock taskStore, mock taskDAGManager, real filesystem.
 */
function buildProactiveDispatcher(deps: {
  orgChart: ReturnType<typeof createMockOrgChart>;
  taskStore: ReturnType<typeof createMockTaskStore>;
  taskDAGManager: { dispatchTask: ReturnType<typeof vi.fn> } | null;
  logger: ReturnType<typeof createMockLogger>;
}) {
  const { orgChart, taskStore, taskDAGManager, logger } = deps;

  return async (agentAid: string, checkId: string): Promise<void> => {
    const agent = orgChart.getAgent(agentAid);
    if (!agent) {
      logger.debug('proactive.skip.no_agent', { agent_aid: agentAid });
      return;
    }

    const team = orgChart.getTeamBySlug(agent.teamSlug);
    if (!team) {
      logger.debug('proactive.skip.no_team', { agent_aid: agentAid, team_slug: agent.teamSlug });
      return;
    }

    let prompt = 'Perform routine health check and report status.';
    try {
      const nodeFs = await import('node:fs/promises');
      const nodePath = await import('node:path');
      const proactivePath = nodePath.resolve(team.workspacePath, '.claude', 'skills', 'PROACTIVE.md');
      const content = await nodeFs.readFile(proactivePath, 'utf8');

      const lines = content.split('\n');
      if (lines.length > 500) {
        logger.warn('proactive.truncated', {
          agent_aid: agentAid,
          lines: lines.length,
          max: 500,
        });
        prompt = lines.slice(0, 500).join('\n') + '\n\n[Truncated: original had ' + lines.length + ' lines, CON-12 limit is 500]';
      } else {
        prompt = content;
      }
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code;
      if (errno === 'ENOENT') {
        logger.debug('proactive.no_proactive_md', {
          agent_aid: agentAid,
          team_slug: agent.teamSlug,
        });
        // Fall through — use default prompt
      } else {
        logger.warn('proactive.read_error', {
          agent_aid: agentAid,
          team_slug: agent.teamSlug,
          error_code: errno,
          error: String(err),
        });
        return;
      }
    }

    const crypto = await import('node:crypto');
    const promptHash = crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16);
    logger.info('proactive.dispatch', {
      agent_aid: agentAid,
      check_id: checkId,
      prompt_hash: promptHash,
    });

    const taskId = `proactive-${checkId}`;
    const now = Date.now();
    const task = {
      id: taskId,
      parent_id: '',
      team_slug: agent.teamSlug,
      agent_aid: agentAid,
      title: `Proactive: ${checkId}`,
      status: 'pending' as const,
      prompt,
      result: '',
      error: '',
      blocked_by: [] as string[],
      priority: 1,
      retry_count: 0,
      max_retries: 0,
      created_at: now,
      updated_at: now,
      completed_at: null,
    };
    await taskStore.create(task);

    if (taskDAGManager) {
      await taskDAGManager.dispatchTask(task);
    }
  };
}

describe('proactiveDispatcher callback (AC23, AC24)', () => {
  let orgChart: ReturnType<typeof createMockOrgChart>;
  let taskStore: ReturnType<typeof createMockTaskStore>;
  let taskDAGManager: { dispatchTask: ReturnType<typeof vi.fn> };
  let logger: ReturnType<typeof createMockLogger>;
  let tmpDir: string;
  let skillsDir: string;

  beforeEach(async () => {
    orgChart = createMockOrgChart();
    taskStore = createMockTaskStore();
    taskDAGManager = { dispatchTask: vi.fn().mockResolvedValue(undefined) };
    logger = createMockLogger();

    // Create a real temp workspace tree: <tmpDir>/.claude/skills/
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openhive-proactive-'));
    skillsDir = path.join(tmpDir, '.claude', 'skills');
    await fs.mkdir(skillsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('skips dispatch when agent is not in orgChart', async () => {
    vi.mocked(orgChart.getAgent).mockReturnValue(undefined as any);

    const dispatcher = buildProactiveDispatcher({ orgChart, taskStore, taskDAGManager, logger });
    await dispatcher('aid-unknown', 'check-1');

    expect(logger.debug).toHaveBeenCalledWith('proactive.skip.no_agent', expect.objectContaining({ agent_aid: 'aid-unknown' }));
    expect(taskStore.create).not.toHaveBeenCalled();
    expect(taskDAGManager.dispatchTask).not.toHaveBeenCalled();
  });

  it('skips dispatch when team is not in orgChart', async () => {
    vi.mocked(orgChart.getAgent).mockReturnValue({ teamSlug: 'ghost-team' } as any);
    vi.mocked(orgChart.getTeamBySlug).mockReturnValue(undefined as any);

    const dispatcher = buildProactiveDispatcher({ orgChart, taskStore, taskDAGManager, logger });
    await dispatcher('aid-orphan', 'check-2');

    expect(logger.debug).toHaveBeenCalledWith('proactive.skip.no_team', expect.objectContaining({ agent_aid: 'aid-orphan' }));
    expect(taskStore.create).not.toHaveBeenCalled();
  });

  it('uses default prompt and dispatches when PROACTIVE.md is absent (ENOENT)', async () => {
    vi.mocked(orgChart.getAgent).mockReturnValue({ teamSlug: 'team-a' } as any);
    vi.mocked(orgChart.getTeamBySlug).mockReturnValue({ workspacePath: tmpDir } as any);
    vi.mocked(taskStore.create).mockResolvedValue(undefined as any);

    // No PROACTIVE.md written — ENOENT expected
    const dispatcher = buildProactiveDispatcher({ orgChart, taskStore, taskDAGManager, logger });
    await dispatcher('aid-worker', 'check-3');

    expect(logger.debug).toHaveBeenCalledWith('proactive.no_proactive_md', expect.objectContaining({ agent_aid: 'aid-worker' }));
    expect(taskStore.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'proactive-check-3',
        prompt: 'Perform routine health check and report status.',
        status: 'pending',
        agent_aid: 'aid-worker',
        team_slug: 'team-a',
      })
    );
    expect(taskDAGManager.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'proactive-check-3' })
    );
    // Prompt hash logged for audit
    expect(logger.info).toHaveBeenCalledWith('proactive.dispatch', expect.objectContaining({
      agent_aid: 'aid-worker',
      check_id: 'check-3',
      prompt_hash: expect.any(String),
    }));
  });

  it('reads PROACTIVE.md content and uses it as the prompt', async () => {
    const proactiveContent = '# Health Check\nDo a health check and report.\n';
    await fs.writeFile(path.join(skillsDir, 'PROACTIVE.md'), proactiveContent, 'utf8');

    vi.mocked(orgChart.getAgent).mockReturnValue({ teamSlug: 'team-b' } as any);
    vi.mocked(orgChart.getTeamBySlug).mockReturnValue({ workspacePath: tmpDir } as any);
    vi.mocked(taskStore.create).mockResolvedValue(undefined as any);

    const dispatcher = buildProactiveDispatcher({ orgChart, taskStore, taskDAGManager, logger });
    await dispatcher('aid-agent', 'check-4');

    expect(taskStore.create).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: proactiveContent })
    );
    // No truncation warning
    expect(logger.warn).not.toHaveBeenCalledWith('proactive.truncated', expect.anything());
  });

  it('truncates PROACTIVE.md at 500 lines and appends note (CON-12)', async () => {
    // Generate a 501-line file
    const lines = Array.from({ length: 501 }, (_, i) => `line ${i + 1}`);
    const oversizedContent = lines.join('\n');
    await fs.writeFile(path.join(skillsDir, 'PROACTIVE.md'), oversizedContent, 'utf8');

    vi.mocked(orgChart.getAgent).mockReturnValue({ teamSlug: 'team-c' } as any);
    vi.mocked(orgChart.getTeamBySlug).mockReturnValue({ workspacePath: tmpDir } as any);
    vi.mocked(taskStore.create).mockResolvedValue(undefined as any);

    const dispatcher = buildProactiveDispatcher({ orgChart, taskStore, taskDAGManager, logger });
    await dispatcher('aid-agent', 'check-5');

    expect(logger.warn).toHaveBeenCalledWith('proactive.truncated', expect.objectContaining({
      agent_aid: 'aid-agent',
      lines: 501,
      max: 500,
    }));

    const createdTask = vi.mocked(taskStore.create).mock.calls[0][0] as { prompt: string };
    expect(createdTask.prompt).toContain('line 500');
    expect(createdTask.prompt).not.toContain('line 501');
    expect(createdTask.prompt).toContain('[Truncated: original had 501 lines, CON-12 limit is 500]');
  });

  it('skips dispatch on non-ENOENT I/O error and logs warning', async () => {
    // Simulate an EACCES error by writing a file but making the skills dir unreadable
    // Instead: mock the fs module's readFile to throw EACCES
    vi.mocked(orgChart.getAgent).mockReturnValue({ teamSlug: 'team-d' } as any);
    vi.mocked(orgChart.getTeamBySlug).mockReturnValue({ workspacePath: tmpDir } as any);

    // Create PROACTIVE.md then chmod it to 000 to trigger EACCES
    const proactivePath = path.join(skillsDir, 'PROACTIVE.md');
    await fs.writeFile(proactivePath, 'content', 'utf8');
    await fs.chmod(proactivePath, 0o000);

    const dispatcher = buildProactiveDispatcher({ orgChart, taskStore, taskDAGManager, logger });

    try {
      await dispatcher('aid-agent', 'check-6');
    } finally {
      // Restore permissions for cleanup
      await fs.chmod(proactivePath, 0o644);
    }

    expect(logger.warn).toHaveBeenCalledWith('proactive.read_error', expect.objectContaining({
      agent_aid: 'aid-agent',
      team_slug: 'team-d',
    }));
    expect(taskStore.create).not.toHaveBeenCalled();
    expect(taskDAGManager.dispatchTask).not.toHaveBeenCalled();
  });

  it('task id is proactive-{checkId}', async () => {
    vi.mocked(orgChart.getAgent).mockReturnValue({ teamSlug: 'team-e' } as any);
    vi.mocked(orgChart.getTeamBySlug).mockReturnValue({ workspacePath: tmpDir } as any);
    vi.mocked(taskStore.create).mockResolvedValue(undefined as any);

    const dispatcher = buildProactiveDispatcher({ orgChart, taskStore, taskDAGManager, logger });
    await dispatcher('aid-x', 'my-unique-check-id');

    expect(taskStore.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'proactive-my-unique-check-id' })
    );
  });
});