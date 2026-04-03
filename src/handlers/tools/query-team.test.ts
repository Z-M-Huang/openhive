/**
 * query_team tool tests — validation, handler logic, credential scrubbing.
 *
 * Migrated from phase-gates/layer-5.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { queryTeam } from './query-team.js';
import { OrgTree } from '../../domain/org-tree.js';
import type { TeamConfig } from '../../domain/types.js';
import {
  setupServer,
  makeNode,
  makeTeamConfig,
  createMemoryOrgStore,
} from '../__test-helpers.js';
import type { ServerFixtures } from '../__test-helpers.js';

// ── query_team (via server invoker) ──────────────────────────────────────

describe('query_team', () => {
  let f: ServerFixtures;

  beforeEach(() => {
    f = setupServer();
    f.orgTree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    f.orgTree.addTeam(makeNode({ teamId: 'weather-team', name: 'weather-team', parentId: 'root' }));
    f.orgTree.addScopeKeywords('weather-team', ['weather', 'forecast']);
    f.teamConfigs.set('weather-team', makeTeamConfig({ name: 'weather-team' }));
  });

  it('returns error if target team not found', async () => {
    const result = await f.server.invoke('query_team', { team: 'ghost', query: 'hello' }, 'root');
    const typed = result as { success: boolean; error: string };
    expect(typed.success).toBe(false);
    expect(typed.error).toContain('not found');
  });

  it('returns error if caller is not parent', async () => {
    f.orgTree.addTeam(makeNode({ teamId: 'stranger', name: 'stranger' }));
    const result = await f.server.invoke('query_team', { team: 'weather-team', query: 'weather?' }, 'stranger');
    const typed = result as { success: boolean; error: string };
    expect(typed.success).toBe(false);
    expect(typed.error).toContain('not parent');
  });

  it('returns error if queryRunner not configured', async () => {
    // queryRunner is undefined (no providers) — must pass scope first
    const result = await f.server.invoke('query_team', { team: 'weather-team', query: 'get weather forecast' }, 'root');
    const typed = result as { success: boolean; error: string };
    expect(typed.success).toBe(false);
    expect(typed.error).toContain('not available');
  });

  // buildAiSessionConfig test migrated to message-handler.test.ts (Unit 8)
});

// ── query_team: happy path + error detection ──────────────────────────────

describe('query_team handler logic', () => {
  it('returns success with mocked queryRunner response', async () => {
    const store = createMemoryOrgStore();
    const tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'child', name: 'child', parentId: 'root' }));
    const configs = new Map<string, TeamConfig>();
    configs.set('child', makeTeamConfig({ name: 'child' }));
    tree.addScopeKeywords('child', ['test']);

    const result = await queryTeam(
      { team: 'child', query: 'test query' },
      'root',
      {
        orgTree: tree,
        getTeamConfig: (id) => configs.get(id),
        queryRunner: async () => 'The weather is sunny',
        log: () => {},
      },
    );

    expect(result.success).toBe(true);
    expect(result.response).toBe('The weather is sunny');
  });

  it('detects thrown errors from queryRunner as failures', async () => {
    const store = createMemoryOrgStore();
    const tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'child', name: 'child', parentId: 'root' }));
    const configs = new Map<string, TeamConfig>();
    configs.set('child', makeTeamConfig({ name: 'child' }));
    tree.addScopeKeywords('child', ['test']);

    const result = await queryTeam(
      { team: 'child', query: 'test query' },
      'root',
      {
        orgTree: tree,
        getTeamConfig: (id) => configs.get(id),
        queryRunner: async () => { throw new Error('SDK not available'); },
        log: () => {},
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('SDK not available');
  });
});

// ── query_team credential scrubbing ───────────────────────────────────────

describe('query_team credential scrubbing', () => {
  it('scrubs child team credentials from response', async () => {
    const store = createMemoryOrgStore();
    const tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'child', name: 'child', parentId: 'root' }));

    const testFakeValue = 'test-fake-value-for-scrubbing';
    const configs = new Map<string, TeamConfig>();
    configs.set('child', makeTeamConfig({
      name: 'child',
      credentials: { subdomain: testFakeValue },
    }));
    tree.addScopeKeywords('child', ['test']);

    const result = await queryTeam(
      { team: 'child', query: 'test query' },
      'root',
      {
        orgTree: tree,
        getTeamConfig: (id) => configs.get(id),
        queryRunner: async () => `The value is ${testFakeValue} and it works`,
        log: () => {},
      },
    );
    expect(result.success).toBe(true);
    expect(result.response).not.toContain(testFakeValue);
    expect(result.response).toContain('[REDACTED]');
  });
});
