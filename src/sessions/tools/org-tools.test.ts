/**
 * Org Tool Builders — unit tests.
 *
 * Tests buildOrgTools: tool count, bare names, alphabetical sort,
 * and conditional query_team inclusion.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { buildOrgTools } from './org-tools.js';
import type { OrgToolContext } from './org-tool-context.js';
import { OrgTree } from '../../domain/org-tree.js';
import { TeamStatus } from '../../domain/types.js';
import { createMemoryOrgStore, createMockTaskQueue, createMockEscalationStore } from '../../handlers/__test-helpers.js';

const __dirn = dirname(fileURLToPath(import.meta.url));

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockContext(overrides?: Partial<OrgToolContext>): OrgToolContext {
  const store = createMemoryOrgStore();
  const orgTree = new OrgTree(store);

  return {
    teamName: 'main',
    orgTree,
    spawner: { spawn: vi.fn().mockResolvedValue('session-1') },
    sessionManager: { getSession: vi.fn(), terminateSession: vi.fn() },
    taskQueue: createMockTaskQueue(),
    escalationStore: createMockEscalationStore(),
    runDir: '/tmp/openhive-test',
    loadConfig: vi.fn(),
    getTeamConfig: vi.fn(),
    log: vi.fn(),
    queryRunner: async () => 'response',
    triggerConfigStore: undefined,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('buildOrgTools', () => {
  it('returns exactly 12 tools when queryRunner is defined', () => {
    const ctx = createMockContext({ queryRunner: async () => 'ok' });
    const tools = buildOrgTools(ctx);
    expect(Object.keys(tools)).toHaveLength(12);
  });

  it('returns exactly 10 tools when queryRunner is undefined', () => {
    const ctx = createMockContext({ queryRunner: undefined });
    const tools = buildOrgTools(ctx);
    expect(Object.keys(tools)).toHaveLength(10);
    expect(tools).not.toHaveProperty('query_team');
    expect(tools).not.toHaveProperty('query_teams');
  });

  it('registers enqueue_parent_task unconditionally (ADR-43)', () => {
    const withRunner = buildOrgTools(createMockContext({ queryRunner: async () => 'ok' }));
    const withoutRunner = buildOrgTools(createMockContext({ queryRunner: undefined }));
    expect(withRunner).toHaveProperty('enqueue_parent_task');
    expect(withoutRunner).toHaveProperty('enqueue_parent_task');
  });

  it('uses bare tool names (not prefixed)', () => {
    const ctx = createMockContext();
    const tools = buildOrgTools(ctx);
    const names = Object.keys(tools);

    const expected = [
      'delegate_task',
      'enqueue_parent_task',
      'escalate',
      'get_status',
      'list_completed_tasks',
      'list_teams',
      'query_team',
      'query_teams',
      'send_message',
      'shutdown_team',
      'spawn_team',
      'update_team',
    ];

    for (const name of expected) {
      expect(names).toContain(name);
    }

    // No prefixed names
    for (const name of names) {
      expect(name).not.toContain('mcp__');
    }
  });

  it('returns tools in alphabetical order', () => {
    const ctx = createMockContext();
    const tools = buildOrgTools(ctx);
    const names = Object.keys(tools);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  it('every tool has an execute function and description', () => {
    const ctx = createMockContext();
    const tools = buildOrgTools(ctx);

    for (const [name, t] of Object.entries(tools)) {
      expect(typeof t.execute, `${name} should have execute`).toBe('function');
      expect(typeof t.description, `${name} should have description`).toBe('string');
    }
  });
});

// ── delegate_task schema wiring (AC-7) ───────────────────────────────────────

type SchemaBag = { safeParse: (v: unknown) => { success: boolean; data: Record<string, unknown> } };

describe('delegate_task tool wiring', () => {
  it('tool schema accepts overlap_policy and defaults to confirm', () => {
    const ctx = createMockContext({ queryRunner: async () => 'ok' });
    const tools = buildOrgTools(ctx);
    const delegate = tools['delegate_task'];
    expect(delegate).toBeTruthy();

    const schema = delegate.inputSchema as unknown as SchemaBag;

    // Default overlap_policy is 'confirm'
    const r1 = schema.safeParse({ team: 'A', task: 'x' });
    expect(r1.success).toBe(true);
    expect(r1.data.overlap_policy).toBe('confirm');

    // Accepts explicit 'replace'
    const r2 = schema.safeParse({ team: 'A', task: 'x', overlap_policy: 'replace' });
    expect(r2.success).toBe(true);
    expect(r2.data.overlap_policy).toBe('replace');

    // Rejects invalid value
    const r3 = schema.safeParse({ team: 'A', task: 'x', overlap_policy: 'bogus' });
    expect(r3.success).toBe(false);
  });

  it('org-tools.ts imports schema from handler — overlap_policy not re-declared', () => {
    const src = readFileSync(join(__dirn, 'org-tools.ts'), 'utf8');
    // Schema is imported from the handler module
    expect(src).toMatch(/DelegateTaskInputSchema/);
    // overlap_policy lives in the handler schema, not re-declared here
    expect(src).not.toMatch(/overlap_policy/);
  });
});

// ── query_teams registration (AC-16) ─────────────────────────────────────────

describe('query_teams registration', () => {
  it('is exposed when queryRunner is present', () => {
    const tools = buildOrgTools({ queryRunner: {} as never } as never);
    expect(tools['query_teams']).toBeDefined();
  });

  it('is omitted when queryRunner is absent', () => {
    const tools = buildOrgTools({} as never);
    expect(tools['query_teams']).toBeUndefined();
  });

  it('preserves alphabetical registration order (query_team immediately before query_teams)', () => {
    const tools = buildOrgTools({ queryRunner: {} as never } as never);
    const names = Object.keys(tools);
    const idxTeam = names.indexOf('query_team');
    const idxTeams = names.indexOf('query_teams');
    expect(idxTeams).toBe(idxTeam + 1);
  });

  it('query_team description references query_teams and delegate_task (AC-26)', () => {
    const tools = buildOrgTools({ queryRunner: {} as never } as never);
    const desc = tools['query_team'].description;
    expect(desc).toMatch(/query_teams/);
    expect(desc).toMatch(/delegate_task/);
  });
});

// ── org-tools descriptions reflect ADR-41 behavior (AC-26, AC-37, AC-38) ─────

describe('org-tools descriptions reflect ADR-41 behavior', () => {
  const tools = buildOrgTools({ queryRunner: async () => 'ok' } as never);

  it('query_team description points callers to query_teams for multi-team', () => {
    const desc = tools['query_team']?.description ?? '';
    expect(desc).toMatch(/single/i);
    expect(desc).toMatch(/query_teams|delegate_task/);
  });

  it('spawn_team description instructs the caller to echo message_for_user', () => {
    const desc = tools['spawn_team']?.description ?? '';
    expect(desc).toMatch(/echo/i);
    expect(desc).toMatch(/message_for_user/);
  });

  it('escalate description states notification-only and mentions enqueue_parent_task', () => {
    const desc = tools['escalate']?.description ?? '';
    expect(desc).toMatch(/notification[-\s]only/i);
    expect(desc).toMatch(/enqueue_parent_task/);
  });
});

// ── query_teams / query_team scrub wiring (R11c) ────────────────────────────

describe('query scrub wiring at registration', () => {
  it('query_teams execute resolves caller credentials from ctx.vaultStore', async () => {
    // Synthetic placeholder longer than the 8-char scrub floor; never a real value.
    const placeholder = 'placeholder-value-for-scrub-test';
    const callerTeam = 'main';
    const childTeam = 'ops';

    const store = createMemoryOrgStore();
    const orgTree = new OrgTree(store);
    orgTree.addTeam({ teamId: callerTeam, name: callerTeam, parentId: null, status: TeamStatus.Active, agents: [], children: [] });
    orgTree.addTeam({ teamId: childTeam, name: childTeam, parentId: callerTeam, status: TeamStatus.Active, agents: [], children: [] });

    const vaultStore = {
      getSecrets: (team: string) =>
        team === callerTeam ? [{ key: 'k', value: placeholder, isSecret: true } as never] : [],
    } as never;

    const ctx = createMockContext({
      teamName: callerTeam,
      orgTree,
      vaultStore,
      queryRunner: async () => `leaked: ${placeholder}`,
    });
    const tools = buildOrgTools(ctx);
    const qt = tools['query_teams'];
    expect(qt).toBeDefined();

    const res = (await (qt.execute as (i: unknown, c: unknown) => Promise<unknown>)(
      { teams: [childTeam], query: 'hi' },
      {},
    )) as { success: boolean; results?: Array<{ team: string; ok: boolean; result_or_error: string }> };

    const first = res.results?.[0];
    expect(first?.team).toBe(childTeam);
    expect(first?.result_or_error).not.toContain(placeholder);
    expect(first?.result_or_error).toMatch(/\[REDACTED\]|\[CREDENTIAL:/);
  });
});
