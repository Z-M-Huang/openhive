/**
 * Scope admission check for task delegation.
 *
 * Extracts keywords from a task description and checks them against
 * a team's scope (accepts/rejects patterns). Reject-by-default (F-9):
 * if no accept pattern matches, the task is rejected.
 */

import type { TeamScope } from '../domain/types.js';

export interface ScopeAdmissionResult {
  readonly admitted: boolean;
  readonly reason: string;
}

/**
 * Check whether a task description is admitted by a team's scope.
 *
 * Algorithm:
 * 1. Extract keywords from task (split on whitespace, lowercase, deduplicate).
 * 2. Check rejects first: if any keyword matches a reject pattern, reject.
 * 3. Check accepts: if any keyword matches an accept pattern, admit.
 * 4. Default: REJECT (F-9 reject-by-default).
 */
export function checkScopeAdmission(
  task: string,
  scope: TeamScope,
): ScopeAdmissionResult {
  const keywords = extractKeywords(task);

  // Check rejects first
  for (const keyword of keywords) {
    for (const pattern of scope.rejects) {
      if (matchesPattern(keyword, pattern.toLowerCase())) {
        return { admitted: false, reason: `rejected: keyword "${keyword}" matches reject pattern "${pattern}"` };
      }
    }
  }

  // Check accepts
  for (const keyword of keywords) {
    for (const pattern of scope.accepts) {
      if (matchesPattern(keyword, pattern.toLowerCase())) {
        return { admitted: true, reason: `admitted: keyword "${keyword}" matches accept pattern "${pattern}"` };
      }
    }
  }

  // F-9: reject by default
  return { admitted: false, reason: 'out-of-scope: no matching accept pattern' };
}

function extractKeywords(task: string): string[] {
  const words = task.split(/\s+/).map((w) => w.toLowerCase()).filter((w) => w.length > 0);
  return [...new Set(words)];
}

function matchesPattern(keyword: string, pattern: string): boolean {
  return keyword === pattern || keyword.includes(pattern) || pattern.includes(keyword);
}
