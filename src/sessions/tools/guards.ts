/**
 * Org-specific guards — scope and capability assertions for org tool builders.
 *
 * Separate from tool-guards.ts which handles workspace boundary, governance,
 * and credential safety. These guards enforce org-tree hierarchy and
 * team-level capability checks.
 */

import type { OrgTree } from '../../domain/org-tree.js';
import type { TeamConfig } from '../../domain/types.js';
import { ScopeRejectionError } from '../../domain/errors.js';

/**
 * Assert that `callerId` is the parent (or an ancestor) of `targetTeamId`
 * in the org tree. Throws ScopeRejectionError if the caller has no
 * hierarchical authority over the target.
 */
export function assertCallerIsParent(
  orgTree: OrgTree,
  callerId: string,
  targetTeamId: string,
): void {
  // A team can always target itself
  if (callerId === targetTeamId) return;

  // Check if callerId is an ancestor of targetTeamId
  const ancestors = orgTree.getAncestors(targetTeamId);
  const isAncestor = ancestors.some((node) => node.teamId === callerId);

  if (!isAncestor) {
    throw new ScopeRejectionError(
      `Scope rejected: ${callerId} is not a parent or ancestor of ${targetTeamId}`,
    );
  }
}

/**
 * Assert that the caller's team has browser capabilities enabled.
 * Throws ScopeRejectionError if the team config has no browser section.
 */
export function assertBrowserEnabled(
  getTeamConfig: (name: string) => TeamConfig | undefined,
  callerId: string,
): void {
  const config = getTeamConfig(callerId);
  if (!config?.browser) {
    throw new ScopeRejectionError(
      `Browser not enabled for team ${callerId}: no browser config found`,
    );
  }
}
