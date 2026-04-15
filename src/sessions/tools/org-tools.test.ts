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
  it('returns exactly 10 tools when queryRunner is defined', () => {
    const ctx = createMockContext({ queryRunner: async () => 'ok' });
    const tools = buildOrgTools(ctx);
    expect(Object.keys(tools)).toHaveLength(10);
  });

  it('returns exactly 9 tools when queryRunner is undefined', () => {
    const ctx = createMockContext({ queryRunner: undefined });
    const tools = buildOrgTools(ctx);
    expect(Object.keys(tools)).toHaveLength(9);
    expect(tools).not.toHaveProperty('query_team');
  });

  it('uses bare tool names (not prefixed)', () => {
    const ctx = createMockContext();
    const tools = buildOrgTools(ctx);
    const names = Object.keys(tools);

    const expected = [
      'delegate_task',
      'escalate',
      'get_status',
      'list_completed_tasks',
      'list_teams',
      'query_team',
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
