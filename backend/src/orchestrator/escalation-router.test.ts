/**
 * Tests for EscalationRouter.
 *
 * Covers:
 *   - handleEscalation: routes escalation upward via OrgChart
 *   - handleEscalation: persists escalation record
 *   - handleEscalation: marks task as 'escalated'
 *   - handleEscalation: rejects depth limit exceeded
 *   - handleEscalation: handles missing supervisor
 *   - handleEscalation: detects cycle (self-supervisor)
 *   - handleEscalationResponse: resolves pending escalation
 *   - handleEscalationResponse: resumes task to 'running'
 *   - handleEscalationResponse: routes response to originating container
 *   - handleEscalationResponse: handles no pending escalation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EscalationRouter, newEscalationRouter } from './escalation-router.js';
import type { EscalationRouterLogger } from './escalation-router.js';
import type { OrgChart, EscalationStore, TaskStore, WSHub } from '../domain/interfaces.js';
import type { Escalation, EscalationStatus, Task, Agent, Team } from '../domain/types.js';
import type { TaskStatus } from '../domain/enums.js';
import type { EscalationMsg, EscalationResponseMsg } from '../ws/messages.js';
import type { JsonValue } from '../domain/types.js';
import { NotFoundError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flushes microtasks. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

/** Creates a spy logger that records calls. */
function makeSpyLogger(): EscalationRouterLogger & {
  calls: Record<string, Array<[string, Record<string, unknown> | undefined]>>;
} {
  const calls: Record<string, Array<[string, Record<string, unknown> | undefined]>> = {
    debug: [],
    info: [],
    warn: [],
    error: [],
  };
  return {
    calls,
    debug(msg: string, data?: Record<string, unknown>) { calls['debug']!.push([msg, data]); },
    info(msg: string, data?: Record<string, unknown>) { calls['info']!.push([msg, data]); },
    warn(msg: string, data?: Record<string, unknown>) { calls['warn']!.push([msg, data]); },
    error(msg: string, data?: Record<string, unknown>) { calls['error']!.push([msg, data]); },
  };
}

/** Creates a minimal Agent. */
function makeAgent(aid: string, name: string): Agent {
  return {
    aid,
    name,
    slug: name,
    provider_preset: 'default',
    model_tier: 'sonnet',
  };
}

/** Creates a minimal Team. */
function makeTeam(slug: string): Team {
  return {
    slug,
    leader_aid: `aid-lead-${slug}`,
    agents: [],
  };
}

/** Creates a minimal mock OrgChart. */
function makeOrgChart(overrides?: Partial<OrgChart>): OrgChart {
  const supervisorMap = new Map<string, Agent | null>();
  const teamMap = new Map<string, Team>();

  return {
    getOrgChart: () => ({}),
    getAgentByAID: (aid: string) => makeAgent(aid, aid),
    getTeamBySlug: (slug: string) => {
      const t = teamMap.get(slug);
      if (t !== undefined) return t;
      return makeTeam(slug);
    },
    getTeamForAgent: (aid: string) => {
      for (const [, team] of teamMap) {
        if (team.leader_aid === aid || team.agents.some(a => a.aid === aid)) {
          return team;
        }
      }
      return makeTeam('default');
    },
    getLeadTeams: () => [],
    getSubordinates: () => [],
    getSupervisor: (aid: string) => {
      if (supervisorMap.has(aid)) return supervisorMap.get(aid) ?? null;
      return null;
    },
    rebuildFromConfig: () => undefined,
    _setSupervisor(aid: string, supervisor: Agent | null) {
      supervisorMap.set(aid, supervisor);
    },
    _setTeam(slug: string, team: Team) {
      teamMap.set(slug, team);
    },
    _setTeamForAgent(aid: string, team: Team) {
      teamMap.set(`__agent_${aid}`, team);
    },
    ...overrides,
  } as OrgChart & {
    _setSupervisor: (aid: string, supervisor: Agent | null) => void;
    _setTeam: (slug: string, team: Team) => void;
    _setTeamForAgent: (aid: string, team: Team) => void;
  };
}

/** Creates a minimal mock EscalationStore. */
function makeEscalationStore(): EscalationStore & {
  stored: Escalation[];
  updates: Escalation[];
} {
  const stored: Escalation[] = [];
  const updates: Escalation[] = [];

  return {
    stored,
    updates,
    async create(escalation: Escalation) {
      stored.push({ ...escalation });
    },
    async get(id: string): Promise<Escalation> {
      const e = stored.find((x) => x.id === id);
      if (e === undefined) throw new NotFoundError('escalation', id);
      return { ...e };
    },
    async update(escalation: Escalation) {
      updates.push({ ...escalation });
      const idx = stored.findIndex((x) => x.id === escalation.id);
      if (idx >= 0) {
        stored[idx] = { ...escalation };
      }
    },
    async listByAgent() { return []; },
    async listByCorrelation(correlationId: string): Promise<Escalation[]> {
      return stored.filter((e) => e.correlation_id === correlationId);
    },
    async listByStatus() { return []; },
    async listByTask() { return []; },
  };
}

/** Creates a mock TaskStore. */
function makeTaskStore(): TaskStore & {
  tasks: Map<string, Task>;
} {
  const tasks = new Map<string, Task>();
  return {
    tasks,
    async create(task: Task) {
      tasks.set(task.id, { ...task });
    },
    async get(id: string): Promise<Task> {
      const t = tasks.get(id);
      if (t === undefined) throw new NotFoundError('task', id);
      return { ...t };
    },
    async update(task: Task) {
      tasks.set(task.id, { ...task });
    },
    async delete(id: string) {
      tasks.delete(id);
    },
    async listByTeam(): Promise<Task[]> { return []; },
    async listByStatus(): Promise<Task[]> { return []; },
    async getSubtree(): Promise<Task[]> { return []; },
    async getDependents(_blockerID: string): Promise<Task[]> { return []; },
    async getBlockedBy(_taskId: string): Promise<string[]> { return []; },
    async unblockTask(_taskId: string, _completedDependencyId: string): Promise<boolean> { return true; },
    async retryTask(_taskId: string): Promise<boolean> { return false; },
    async validateDependencies(_taskId: string, _blockedByIds: string[]): Promise<void> {},
  };
}

/** Creates a mock WSHub. */
function makeWSHub(): WSHub & {
  sent: Array<{ teamID: string; msg: string }>;
} {
  const sent: Array<{ teamID: string; msg: string }> = [];
  return {
    sent,
    registerConnection: () => undefined,
    unregisterConnection: () => undefined,
    async sendToTeam(teamID: string, msg: Buffer | string) {
      sent.push({ teamID, msg: typeof msg === 'string' ? msg : msg.toString('utf8') });
    },
    async broadcastAll() {},
    generateToken: () => 'tok',
    getUpgradeHandler: () => () => undefined,
    getConnectedTeams: () => [],
    setOnMessage: () => undefined,
    setOnConnect: () => undefined,
    async close() {},
  };
}

/** Creates a running task for the test task store. */
function makeTask(id: string, status: TaskStatus = 'running'): Task {
  return {
    id,
    team_slug: 'team-a1',
    agent_aid: 'aid-worker',
    status,
    prompt: 'do something',
    created_at: new Date(1_000_000),
    updated_at: new Date(1_000_000),
    completed_at: null,
  };
}

/** Creates a valid EscalationMsg. */
function makeEscalationMsg(overrides?: Partial<EscalationMsg>): EscalationMsg {
  return {
    correlation_id: 'esc-corr-1',
    task_id: 'task-1',
    agent_aid: 'aid-worker',
    source_team: 'tid-team-a1',
    destination_team: '',
    escalation_level: 1,
    reason: 'need_guidance',
    context: { detail: 'stuck on API call' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// handleEscalation
// ---------------------------------------------------------------------------

describe('EscalationRouter — handleEscalation', () => {
  let orgChart: ReturnType<typeof makeOrgChart>;
  let escStore: ReturnType<typeof makeEscalationStore>;
  let taskStore: ReturnType<typeof makeTaskStore>;
  let wsHub: ReturnType<typeof makeWSHub>;
  let logger: ReturnType<typeof makeSpyLogger>;
  let router: EscalationRouter;

  beforeEach(() => {
    orgChart = makeOrgChart();
    escStore = makeEscalationStore();
    taskStore = makeTaskStore();
    wsHub = makeWSHub();
    logger = makeSpyLogger();

    // Set up org chart: aid-worker -> aid-lead (supervisor) in team-a
    const supervisor = makeAgent('aid-lead', 'team-lead');
    const teamA = makeTeam('team-a');
    teamA.leader_aid = 'aid-lead';
    orgChart._setSupervisor('aid-worker', supervisor);
    orgChart._setTeam('team-a', teamA);

    // Override getTeamForAgent to return team-a for the supervisor
    const orig = orgChart.getTeamForAgent;
    orgChart.getTeamForAgent = (aid: string) => {
      if (aid === 'aid-lead') return teamA;
      return orig(aid);
    };

    // Create a running task
    taskStore.tasks.set('task-1', makeTask('task-1'));

    router = newEscalationRouter(orgChart, escStore, taskStore, wsHub, logger);
  });

  it('routes escalation to supervisor container', async () => {
    await router.handleEscalation('tid-team-a1', makeEscalationMsg());

    expect(wsHub.sent).toHaveLength(1);
    expect(wsHub.sent[0]!.teamID).toBe('team-a');
    const parsed = JSON.parse(wsHub.sent[0]!.msg) as { type: string; data: EscalationMsg };
    expect(parsed.type).toBe('escalation');
    expect(parsed.data.correlation_id).toBe('esc-corr-1');
    expect(parsed.data.destination_team).toBe('team-a');
  });

  it('persists escalation record to store', async () => {
    await router.handleEscalation('tid-team-a1', makeEscalationMsg());

    expect(escStore.stored).toHaveLength(1);
    const record = escStore.stored[0]!;
    expect(record.correlation_id).toBe('esc-corr-1');
    expect(record.from_aid).toBe('aid-worker');
    expect(record.to_aid).toBe('aid-lead');
    expect(record.source_team).toBe('tid-team-a1');
    expect(record.destination_team).toBe('team-a');
    expect(record.escalation_level).toBe(1);
    expect(record.status).toBe('pending');
  });

  it('marks task as escalated', async () => {
    await router.handleEscalation('tid-team-a1', makeEscalationMsg());

    const task = taskStore.tasks.get('task-1')!;
    expect(task.status).toBe('escalated');
  });

  it('throws on escalation exceeding depth limit', async () => {
    const msg = makeEscalationMsg({ escalation_level: 11 });
    await expect(router.handleEscalation('tid-team-a1', msg))
      .rejects.toThrow('escalation depth limit exceeded');

    expect(wsHub.sent).toHaveLength(0);
    expect(escStore.stored).toHaveLength(0);
    const errorCalls = logger.calls['error']!;
    const depthError = errorCalls.find(([m]) => m === 'escalation depth limit exceeded');
    expect(depthError).toBeDefined();
  });

  it('throws when no supervisor found', async () => {
    orgChart._setSupervisor('aid-orphan', null);
    const msg = makeEscalationMsg({ agent_aid: 'aid-orphan' });
    await expect(router.handleEscalation('tid-team-a1', msg))
      .rejects.toThrow('no supervisor found');

    expect(wsHub.sent).toHaveLength(0);
    expect(escStore.stored).toHaveLength(0);
  });

  it('throws on cycle when agent is its own supervisor', async () => {
    const selfAgent = makeAgent('aid-cycle', 'cycle-agent');
    orgChart._setSupervisor('aid-cycle', selfAgent);
    const msg = makeEscalationMsg({ agent_aid: 'aid-cycle' });
    await expect(router.handleEscalation('tid-team-a1', msg))
      .rejects.toThrow('escalation cycle detected');

    expect(wsHub.sent).toHaveLength(0);
  });

  it('logs escalation routing info on success', async () => {
    await router.handleEscalation('tid-team-a1', makeEscalationMsg());

    const infoCalls = logger.calls['info']!;
    const routed = infoCalls.find(([m]) => m === 'escalation routed');
    expect(routed).toBeDefined();
    expect(routed![1]!['correlation_id']).toBe('esc-corr-1');
    expect(routed![1]!['from_aid']).toBe('aid-worker');
    expect(routed![1]!['to_aid']).toBe('aid-lead');
  });
});

// ---------------------------------------------------------------------------
// handleEscalationResponse
// ---------------------------------------------------------------------------

describe('EscalationRouter — handleEscalationResponse', () => {
  let orgChart: ReturnType<typeof makeOrgChart>;
  let escStore: ReturnType<typeof makeEscalationStore>;
  let taskStore: ReturnType<typeof makeTaskStore>;
  let wsHub: ReturnType<typeof makeWSHub>;
  let logger: ReturnType<typeof makeSpyLogger>;
  let router: EscalationRouter;

  beforeEach(async () => {
    orgChart = makeOrgChart();
    escStore = makeEscalationStore();
    taskStore = makeTaskStore();
    wsHub = makeWSHub();
    logger = makeSpyLogger();

    // Seed a pending escalation record
    const pendingEsc: Escalation = {
      id: 'esc-record-1',
      correlation_id: 'esc-corr-1',
      task_id: 'task-1',
      from_aid: 'aid-worker',
      to_aid: 'aid-lead',
      source_team: 'tid-team-a1',
      destination_team: 'team-a',
      escalation_level: 1,
      reason: 'need_guidance',
      status: 'pending',
      created_at: new Date(1_000_000),
      updated_at: new Date(1_000_000),
      resolved_at: null,
    };
    await escStore.create(pendingEsc);

    // Seed an escalated task
    taskStore.tasks.set('task-1', makeTask('task-1', 'escalated'));

    router = newEscalationRouter(orgChart, escStore, taskStore, wsHub, logger);
  });

  it('resolves the pending escalation record', async () => {
    const response: EscalationResponseMsg = {
      correlation_id: 'esc-corr-1',
      task_id: 'task-1',
      agent_aid: 'aid-lead',
      source_team: 'team-a',
      destination_team: 'tid-team-a1',
      resolution: 'use approach B',
      context: { confidence: 'high' },
    };

    await router.handleEscalationResponse(response);

    expect(escStore.updates).toHaveLength(1);
    expect(escStore.updates[0]!.status).toBe('resolved');
    expect(escStore.updates[0]!.resolution).toBe('use approach B');
    expect(escStore.updates[0]!.resolved_at).not.toBeNull();
  });

  it('resumes task to running', async () => {
    const response: EscalationResponseMsg = {
      correlation_id: 'esc-corr-1',
      task_id: 'task-1',
      agent_aid: 'aid-lead',
      source_team: 'team-a',
      destination_team: 'tid-team-a1',
      resolution: 'fixed',
      context: {},
    };

    await router.handleEscalationResponse(response);

    const task = taskStore.tasks.get('task-1')!;
    expect(task.status).toBe('running');
  });

  it('routes response to originating container', async () => {
    const response: EscalationResponseMsg = {
      correlation_id: 'esc-corr-1',
      task_id: 'task-1',
      agent_aid: 'aid-lead',
      source_team: 'team-a',
      destination_team: 'tid-team-a1',
      resolution: 'use approach B',
      context: {},
    };

    await router.handleEscalationResponse(response);

    expect(wsHub.sent).toHaveLength(1);
    expect(wsHub.sent[0]!.teamID).toBe('tid-team-a1');
    const parsed = JSON.parse(wsHub.sent[0]!.msg) as { type: string; data: EscalationResponseMsg };
    expect(parsed.type).toBe('escalation_response');
    expect(parsed.data.correlation_id).toBe('esc-corr-1');
    expect(parsed.data.destination_team).toBe('tid-team-a1');
  });

  it('throws when no pending escalation exists for correlation_id', async () => {
    const response: EscalationResponseMsg = {
      correlation_id: 'esc-unknown',
      task_id: 'task-1',
      agent_aid: 'aid-lead',
      source_team: 'team-a',
      destination_team: 'tid-team-a1',
      resolution: 'answer',
      context: {},
    };

    await expect(router.handleEscalationResponse(response))
      .rejects.toThrow('no pending escalation found');
    expect(wsHub.sent).toHaveLength(0);
  });

  it('logs escalation response routing info on success', async () => {
    const response: EscalationResponseMsg = {
      correlation_id: 'esc-corr-1',
      task_id: 'task-1',
      agent_aid: 'aid-lead',
      source_team: 'team-a',
      destination_team: 'tid-team-a1',
      resolution: 'done',
      context: {},
    };

    await router.handleEscalationResponse(response);

    const infoCalls = logger.calls['info']!;
    const routed = infoCalls.find(([m]) => m === 'escalation response routed');
    expect(routed).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

describe('newEscalationRouter', () => {
  it('returns an EscalationRouter instance', () => {
    const router = newEscalationRouter(
      makeOrgChart(),
      makeEscalationStore(),
      makeTaskStore(),
      makeWSHub(),
      makeSpyLogger(),
    );
    expect(router).toBeInstanceOf(EscalationRouter);
  });
});
