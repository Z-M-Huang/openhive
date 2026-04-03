/**
 * Org Guards — unit tests.
 *
 * Tests assertCallerIsParent and assertBrowserEnabled:
 * allow paths, deny paths, and error types.
 */

import { describe, it, expect } from 'vitest';

import { assertCallerIsParent, assertBrowserEnabled } from './guards.js';
import { ScopeRejectionError } from '../../domain/errors.js';
import { OrgTree } from '../../domain/org-tree.js';
import { createMemoryOrgStore, makeNode } from '../../handlers/__test-helpers.js';
import type { TeamConfig } from '../../domain/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildOrgTree(): OrgTree {
  const store = createMemoryOrgStore();
  const tree = new OrgTree(store);

  tree.addTeam(makeNode({ teamId: 'root', name: 'root', parentId: null }));
  tree.addTeam(makeNode({ teamId: 'child-a', name: 'child-a', parentId: 'root' }));
  tree.addTeam(makeNode({ teamId: 'grandchild-a1', name: 'grandchild-a1', parentId: 'child-a' }));
  tree.addTeam(makeNode({ teamId: 'child-b', name: 'child-b', parentId: 'root' }));

  return tree;
}

// ── assertCallerIsParent ────────────────────────────────────────────────────

describe('assertCallerIsParent', () => {
  it('allows a team to target itself', () => {
    const tree = buildOrgTree();
    expect(() => assertCallerIsParent(tree, 'child-a', 'child-a')).not.toThrow();
  });

  it('allows a parent to target its child', () => {
    const tree = buildOrgTree();
    expect(() => assertCallerIsParent(tree, 'root', 'child-a')).not.toThrow();
  });

  it('allows an ancestor to target a grandchild', () => {
    const tree = buildOrgTree();
    expect(() => assertCallerIsParent(tree, 'root', 'grandchild-a1')).not.toThrow();
  });

  it('throws ScopeRejectionError for a non-ancestor caller', () => {
    const tree = buildOrgTree();
    expect(() => assertCallerIsParent(tree, 'child-b', 'child-a')).toThrow(ScopeRejectionError);
  });

  it('throws ScopeRejectionError for a child targeting its parent', () => {
    const tree = buildOrgTree();
    expect(() => assertCallerIsParent(tree, 'child-a', 'root')).toThrow(ScopeRejectionError);
  });

  it('includes caller and target in error message', () => {
    const tree = buildOrgTree();
    expect(() => assertCallerIsParent(tree, 'child-b', 'child-a')).toThrow(
      /child-b.*child-a/,
    );
  });
});

// ── assertBrowserEnabled ────────────────────────────────────────────────────

describe('assertBrowserEnabled', () => {
  it('allows when team has browser config', () => {
    const getTeamConfig = (name: string): TeamConfig | undefined => {
      if (name === 'browser-team') {
        return {
          name: 'browser-team',
          parent: null,
          description: 'Has browser',
          allowed_tools: [],
          mcp_servers: [],
          provider_profile: 'default',
          maxTurns: 50,
          browser: { headless: true },
        } as TeamConfig;
      }
      return undefined;
    };

    expect(() => assertBrowserEnabled(getTeamConfig, 'browser-team')).not.toThrow();
  });

  it('throws ScopeRejectionError when team has no browser config', () => {
    const getTeamConfig = (name: string): TeamConfig | undefined => {
      if (name === 'no-browser') {
        return {
          name: 'no-browser',
          parent: null,
          description: 'No browser',
          allowed_tools: [],
          mcp_servers: [],
          provider_profile: 'default',
          maxTurns: 50,
        } as TeamConfig;
      }
      return undefined;
    };

    expect(() => assertBrowserEnabled(getTeamConfig, 'no-browser')).toThrow(ScopeRejectionError);
  });

  it('throws ScopeRejectionError when team config is undefined', () => {
    const getTeamConfig = (): TeamConfig | undefined => undefined;

    expect(() => assertBrowserEnabled(getTeamConfig, 'missing-team')).toThrow(ScopeRejectionError);
  });

  it('includes team name in error message', () => {
    const getTeamConfig = (): TeamConfig | undefined => undefined;

    expect(() => assertBrowserEnabled(getTeamConfig, 'my-team')).toThrow(/my-team/);
  });
});
