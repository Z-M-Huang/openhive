/**
 * Learning API subagent-aware behavior (AC-28, AC-37).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerLearningRoutes, type LearningDeps } from './learning.js';

interface TriggerRow {
  name: string; team: string; type: string; state: string;
  skill: string | null; subagent: string | null;
}
interface VaultRow { key: string; value: string; updated_at: string; }
interface MemoryRow { key: string; content: string; created_at: string; }
interface TaskRow { id: string; created_at: string; status: string; }

const TRIGGERS: TriggerRow[] = [
  { name: 'learning-cycle-planner', team: 'ops', type: 'schedule', state: 'active', skill: 'learning-cycle', subagent: 'planner' },
  { name: 'learning-cycle-coder', team: 'ops', type: 'schedule', state: 'active', skill: 'learning-cycle', subagent: 'coder' },
  { name: 'reflection-cycle-planner', team: 'ops', type: 'schedule', state: 'active', skill: 'reflection-cycle', subagent: 'planner' },
  { name: 'learning-cycle', team: 'data', type: 'schedule', state: 'active', skill: 'learning-cycle', subagent: null },
  // main team (should be excluded)
  { name: 'learning-cycle', team: 'main', type: 'schedule', state: 'active', skill: 'learning-cycle', subagent: null },
];

const VAULT: VaultRow[] = [
  { key: 'learning:ops:planner:journal', value: '{"note":"plan-entry"}', updated_at: '2026-04-10T00:00:00Z' },
  { key: 'learning:ops:coder:journal', value: '{"note":"code-entry"}', updated_at: '2026-04-11T00:00:00Z' },
  { key: 'reflection:ops:planner:journal', value: '{"note":"refl-plan"}', updated_at: '2026-04-12T00:00:00Z' },
  { key: 'unrelated:ops:notes', value: 'skip', updated_at: '2026-04-09T00:00:00Z' },
];

const MEMORIES: MemoryRow[] = [
  { key: 'lesson:ops:retry', content: 'retry pattern', created_at: '2026-04-10T00:00:00Z' },
];

function mockRawDb() {
  return {
    prepare(sql: string) {
      return {
        all(...rawParams: unknown[]) {
          const params = rawParams.flat();
          if (sql.includes('FROM trigger_configs')) return filterTriggers(sql, params);
          if (sql.includes('FROM team_vault')) return filterVault(sql, params);
          if (sql.includes('FROM memories')) return MEMORIES.filter(m => m.key.startsWith('lesson:'));
          return [];
        },
        get(...rawParams: unknown[]) {
          const params = rawParams.flat();
          if (sql.includes('FROM task_queue')) {
            const team = String(params[0]);
            // Return a deterministic last task only for 'ops' for coverage
            if (team === 'ops') {
              return { id: 'task-1', created_at: '2026-04-13T00:00:00Z', status: 'completed' } satisfies TaskRow;
            }
            return undefined;
          }
          return undefined;
        },
      };
    },
  };
}

function filterTriggers(sql: string, params: unknown[]): TriggerRow[] {
  let rows = TRIGGERS.filter(r => r.skill === 'learning-cycle' || r.skill === 'reflection-cycle');
  rows = rows.filter(r => r.team !== 'main');
  let idx = 0;
  if (sql.includes('team = ?')) {
    const team = String(params[idx++]);
    rows = rows.filter(r => r.team === team);
  }
  if (sql.includes('subagent = ?')) {
    const sub = String(params[idx++]);
    rows = rows.filter(r => r.subagent === sub);
  }
  return rows;
}

function filterVault(sql: string, params: unknown[]): VaultRow[] {
  const team = String(params[0]);
  let rows = VAULT.filter(v => (v.key.startsWith('learning:') || v.key.startsWith('reflection:')));
  // crude team match: key contains `:{team}:`
  rows = rows.filter(v => v.key.startsWith('learning:' + team + ':') || v.key.startsWith('reflection:' + team + ':'));
  if (sql.includes('key LIKE ? OR key LIKE ?')) {
    const prefixes = [String(params[1]).replace('%', ''), String(params[2]).replace('%', '')];
    rows = rows.filter(v => prefixes.some(p => v.key.startsWith(p)));
  }
  return rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

interface LearningListBody {
  data: Array<{
    team: string;
    triggers: Array<{ name: string; skill: string | null; state: string; subagent: string | null }>;
    lastTriggerRun: { taskId: string; createdAt: string; status: string } | null;
  }>;
}

interface JournalBody {
  data: {
    journal: Array<{ key: string; value: string; updatedAt: string }>;
    lessons: Array<{ key: string; content: string; createdAt: string }>;
  };
}

describe('GET /api/v1/learning — subagent awareness (AC-28)', () => {
  let fastify: FastifyInstance;
  beforeAll(async () => {
    fastify = Fastify({ logger: false });
    registerLearningRoutes(fastify, { raw: mockRawDb() as unknown as LearningDeps['raw'] });
    await fastify.ready();
  });
  afterAll(async () => { await fastify.close(); });

  it('returns non-main teams only by default', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/learning' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as LearningListBody;
    const teams = body.data.map(e => e.team);
    expect(teams).not.toContain('main');
    expect(teams).toContain('ops');
    expect(teams).toContain('data');
  });

  it('exposes subagent on each trigger row', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/learning' });
    const body = JSON.parse(res.body) as LearningListBody;
    const ops = body.data.find(e => e.team === 'ops');
    expect(ops).toBeDefined();
    const planner = ops!.triggers.find(t => t.subagent === 'planner');
    expect(planner?.name).toBe('learning-cycle-planner');
  });

  it('filters to a single team via ?team=', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/learning?team=ops' });
    const body = JSON.parse(res.body) as LearningListBody;
    expect(body.data.map(e => e.team)).toEqual(['ops']);
  });

  it('filters to a single subagent via ?subagent=', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/learning?team=ops&subagent=planner' });
    const body = JSON.parse(res.body) as LearningListBody;
    const ops = body.data.find(e => e.team === 'ops');
    expect(ops).toBeDefined();
    expect(ops!.triggers.every(t => t.subagent === 'planner')).toBe(true);
  });
});

describe('GET /api/v1/learning/:team/journal — per-subagent isolation (AC-37)', () => {
  let fastify: FastifyInstance;
  beforeAll(async () => {
    fastify = Fastify({ logger: false });
    registerLearningRoutes(fastify, { raw: mockRawDb() as unknown as LearningDeps['raw'] });
    await fastify.ready();
  });
  afterAll(async () => { await fastify.close(); });

  it('returns empty data for main team (routing-only)', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/learning/main/journal' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as JournalBody;
    expect(body.data.journal).toHaveLength(0);
    expect(body.data.lessons).toHaveLength(0);
  });

  it('returns all learning/reflection journal keys for a team by default', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/learning/ops/journal' });
    const body = JSON.parse(res.body) as JournalBody;
    const keys = body.data.journal.map(e => e.key).sort();
    expect(keys).toContain('learning:ops:planner:journal');
    expect(keys).toContain('learning:ops:coder:journal');
    expect(keys).toContain('reflection:ops:planner:journal');
  });

  it('narrows to a single subagent when ?subagent= is provided (AC-37)', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/learning/ops/journal?subagent=planner' });
    const body = JSON.parse(res.body) as JournalBody;
    const keys = body.data.journal.map(e => e.key);
    expect(keys.every(k => k.startsWith('learning:ops:planner:') || k.startsWith('reflection:ops:planner:'))).toBe(true);
    expect(keys).not.toContain('learning:ops:coder:journal');
  });
});
