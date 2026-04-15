/**
 * Per-subagent journal key helpers (AC-37).
 *
 * Learning and reflection cycles write journal entries to the team vault.
 * Because multiple subagents can run cycles concurrently within the same
 * team, each subagent's journal must be isolated by key so one subagent
 * cannot overwrite another's entries.
 *
 * Keys follow the shape `{cycle}:{team}:{subagent}:journal` — stable across
 * clients so the learning dashboard and reflection skill can locate them.
 */

const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

function assertSegment(value: string, label: string): void {
  if (!value || !SEGMENT_RE.test(value)) {
    throw new Error(`${label} must match /^[A-Za-z0-9_-]+$/ (got: ${JSON.stringify(value)})`);
  }
}

export function learningJournalKey(team: string, subagent: string): string {
  assertSegment(team, 'team');
  assertSegment(subagent, 'subagent');
  return `learning:${team}:${subagent}:journal`;
}

export function reflectionJournalKey(team: string, subagent: string): string {
  assertSegment(team, 'team');
  assertSegment(subagent, 'subagent');
  return `reflection:${team}:${subagent}:journal`;
}

/** True when key matches the per-subagent learning journal shape. */
export function isLearningJournalKey(key: string): boolean {
  const parts = key.split(':');
  return parts.length === 4 && parts[0] === 'learning' && parts[3] === 'journal';
}

/** True when key matches the per-subagent reflection journal shape. */
export function isReflectionJournalKey(key: string): boolean {
  const parts = key.split(':');
  return parts.length === 4 && parts[0] === 'reflection' && parts[3] === 'journal';
}
