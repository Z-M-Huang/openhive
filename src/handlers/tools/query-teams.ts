/**
 * query_teams tool — fan-out query to multiple direct-child teams.
 *
 * ADR-41 G1 decisions applied here:
 *   - Input schema:  {teams: string[], query: string, timeout_ms?: number}  (AC-17)
 *   - Result shape:  wiki-style {team, ok, result_or_error: string}  (AC-18)
 *   - Timeout default:  DEFAULT_TIMEOUT_MS (30 000 ms)  (AC-19)
 *   - Timeout maximum:  MAX_TIMEOUT_MS (60 000 ms), Zod-enforced  (AC-19)
 *   - Invocation style: inject queryTeamHandler per call (wraps queryTeam handler)  (AC-20)
 *   - Fan-out:  Promise.allSettled — partial failures do not abort siblings  (AC-22)
 *   - Cancellation:  no abort support — outstanding calls run to completion or
 *     timeout; no queue mutations on timeout  (AC-23)
 *   - Classification:  daily-op, charges caller pool only
 *
 * Scope: direct children only. Every target must have parentId === callerId (AC-21).
 */

import { z } from 'zod';
import type { IOrgStore } from '../../domain/interfaces.js';
import type { TeamQueryRunner } from '../../sessions/tools/org-tool-context.js';
import { errorMessage } from '../../domain/errors.js';
import { scrubSecrets } from '../../logging/credential-scrubber.js';

// ── Timeout constants (ADR-41 G1) ─────────────────────────────────────────────

/** Default per-query timeout in milliseconds (ADR-41 G1: 30 s). */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Maximum per-query timeout in milliseconds, Zod-enforced (ADR-41 G1: 60 s). */
export const MAX_TIMEOUT_MS = 60_000;

// ── Schema ────────────────────────────────────────────────────────────────────

export const QueryTeamsInputSchema = z.object({
  teams: z.array(z.string().min(1)).min(1),
  query: z.string().min(1),
  timeout_ms: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
});

export type QueryTeamsInput = z.infer<typeof QueryTeamsInputSchema>;

// ── Result ────────────────────────────────────────────────────────────────────

/**
 * Per-target result entry.
 * ADR-41 G1 selected wiki-style shape — result_or_error holds either the
 * successful result or the failure reason in a single field. Split-field
 * {result?, error?} was explicitly rejected (ADR-41:45).
 */
export interface QueryTeamsChildResult {
  readonly team: string;
  readonly ok: boolean;
  readonly result_or_error: string;
}

export interface QueryTeamsResult {
  readonly success: boolean;
  readonly results?: QueryTeamsChildResult[];
  readonly error?: string;
}

// ── Deps ──────────────────────────────────────────────────────────────────────

/** ITeamQueryRunner matches the TeamQueryRunner signature from org-tool-context. */
export type ITeamQueryRunner = TeamQueryRunner;

/**
 * Per-target invocation callback.
 * ADR-41 G1 chose to wrap the existing queryTeam handler rather than calling
 * TeamQueryRunner directly. The caller pre-binds callerId and deps before passing
 * this into QueryTeamsDeps.
 */
export type QueryTeamHandlerFn = (input: {
  team: string;
  query: string;
}) => Promise<{ success: boolean; result?: string; error?: string }>;

export interface QueryTeamsDeps {
  /** Presence check: runner availability gate (carried over from Unit 14 shell). */
  readonly queryRunner?: ITeamQueryRunner;
  /**
   * Per-target invocation. Must be pre-bound to the caller's callerId, deps, and
   * sourceChannelId by the tool-assembly layer before the handler is invoked.
   */
  readonly queryTeamHandler?: QueryTeamHandlerFn;
  readonly orgTree: IOrgStore;
  /**
   * Returns the caller's raw credential strings for secret scrubbing.
   * Values shorter than 8 characters are ignored by the scrubber to avoid
   * false positives (AC-24).
   */
  readonly credentialsLookup?: () => readonly string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Races a promise against a deadline timer. Clears the timer on settlement to
 * prevent NodeJS timer leaks. Rejects with an Error whose message contains
 * "timeout" when the deadline fires (AC-23; test depends on /timeout/i match).
 */
function withTimeoutMs<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timerId: ReturnType<typeof setTimeout>;
  const race = Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timerId = setTimeout(
        () => reject(new Error(`timeout after ${ms}ms`)),
        ms,
      );
    }),
  ]);
  // Clear timer regardless of which branch wins to avoid timer leaks.
  return race.finally(() => clearTimeout(timerId));
}

// ── Handler ───────────────────────────────────────────────────────────────────

/**
 * query_teams handler.
 *
 * Fan-out across direct-child targets using Promise.allSettled so that partial
 * failures do not abort successful siblings (AC-22, AC-23). A single query and
 * timeout_ms (defaulting to DEFAULT_TIMEOUT_MS) apply to all teams per the
 * ADR-41 G1 input schema. Aggregate success is false only when every target fails.
 */
export async function queryTeams(
  input: QueryTeamsInput,
  callerId: string,
  deps: QueryTeamsDeps,
  sourceChannelId?: string,
): Promise<QueryTeamsResult> {
  // sourceChannelId is forwarded to queryTeamHandler by the pre-bound closure
  // assembled at tool-registration time — not forwarded inline here.
  void sourceChannelId;

  const parsed = QueryTeamsInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'invalid_input' };
  }

  const { teams, query, timeout_ms } = parsed.data;

  // Runner availability gate — both fields must be wired for execution to proceed.
  if (!deps.queryRunner || !deps.queryTeamHandler) {
    return { success: false, error: 'runner_unavailable' };
  }

  // Scope: direct children only — validate every target before fan-out (AC-21).
  for (const team of teams) {
    const node = deps.orgTree.getTeam(team);
    if (!node || node.parentId !== callerId) {
      return {
        success: false,
        error: `scope_violation: "${team}" is not a direct child of caller "${callerId}"`,
      };
    }
  }

  const effectiveTimeout = timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const handler = deps.queryTeamHandler;

  // Fan-out: all targets run concurrently; partial failures are preserved (AC-22).
  // Promise.allSettled never throws — failed children become { status: 'rejected' }.
  // Timeout via Promise.race per target; completed siblings are unaffected (AC-23).
  const settled = await Promise.allSettled(
    teams.map((team) =>
      withTimeoutMs(
        handler({ team, query }),
        effectiveTimeout,
      ),
    ),
  );

  // Collect caller credentials for secret scrubbing (AC-24).
  // Values shorter than 8 chars are skipped by scrubSecrets() to avoid false positives.
  const rawSecrets: readonly string[] = deps.credentialsLookup ? deps.credentialsLookup() : [];
  const scrub = (s: string): string =>
    rawSecrets.length > 0 ? scrubSecrets(s, [], rawSecrets) : s;

  // Map settled results to the ADR-41 G1 wiki-style shape (result_or_error).
  // Every result string is scrubbed before being returned (AC-24).
  const results: QueryTeamsChildResult[] = settled.map((s, i) => {
    const team = teams[i];
    if (s.status === 'fulfilled') {
      const payload = s.value.result ?? s.value.error ?? '';
      return {
        team,
        ok: s.value.success,
        result_or_error: scrub(payload),
      };
    }
    return {
      team,
      ok: false,
      result_or_error: scrub(errorMessage(s.reason)),
    };
  });

  // Aggregate: success is false only when ALL targets failed.
  const anyOk = results.some((r) => r.ok);
  return { success: anyOk, results };
}
