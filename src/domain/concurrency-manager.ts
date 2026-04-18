/**
 * ConcurrencyManager — authoritative in-memory concurrency governance.
 *
 * ADR-41: runtime admission control for daily ops and org-level ops.
 *
 * Lifecycle semantics (ADR-41, AC-54):
 *   - Counters increment at acquire time (running-start time).
 *   - Counters decrement at release time (operation complete or failed).
 *   - Daily-op counters are **per-team** so one saturated team cannot starve
 *     another. Saturation per team is the boolean `active >= max`.
 *   - The guard threshold is strictly: active >= max → reject. This prevents
 *     off-by-one overflow (no "one extra" is ever allowed through).
 *
 * Rejection policy (ADR-41, AC-58):
 *   - Reject with retry_after_ms — no queuing; callers decide whether to retry.
 *   - The same policy applies to both acquireDaily and acquireOrg.
 *
 * Org-op model (ADR-41, AC-55):
 *   - Single serialized mutex slot per team.
 *   - org_op_pending is derived exclusively from the per-team mutex map —
 *     the guard and org_op_pending share the same source of truth.
 *
 * File location (ADR-41, AC-52):
 *   - Single authoritative implementation at src/domain/concurrency-manager.ts.
 *   - All imports use this path; no duplicate manager exists elsewhere.
 */

import type { IConcurrencyManager } from './interfaces.js';

/** Default retry hint returned when a slot is not available (5 seconds). */
const DEFAULT_RETRY_AFTER_MS = 5_000;

export class ConcurrencyManager implements IConcurrencyManager {
  private readonly _defaultMaxConcurrentDailyOps: number;

  /**
   * Per-team cap overrides from TeamConfig.max_concurrent_daily_ops.
   * Absent key → fall back to the default passed at construction.
   */
  private readonly _teamCapOverrides = new Map<string, number>();

  /**
   * Per-team active daily-op counter.
   * Incremented at acquireDaily(teamId), decremented at releaseDaily(teamId).
   * Absent key == 0 active ops.
   */
  private readonly _activeDailyOps = new Map<string, number>();

  /**
   * Per-team org-op mutex. true = slot is held; absent = free.
   * org_op_pending is derived exclusively from this map (AC-55).
   */
  private readonly _orgOpActive = new Map<string, boolean>();

  constructor(config: { maxConcurrentDailyOps: number }) {
    this._defaultMaxConcurrentDailyOps = config.maxConcurrentDailyOps;
  }

  /**
   * Register a per-team daily-op cap override. Called when a team's config is
   * loaded so TeamConfig.max_concurrent_daily_ops actually takes effect at the
   * admission layer (otherwise the global default wins).
   *
   * Passing a non-positive value is a no-op (falls back to default).
   */
  setTeamCap(teamId: string, max: number): void {
    if (!Number.isFinite(max) || max <= 0) return;
    this._teamCapOverrides.set(teamId, Math.floor(max));
  }

  private capFor(teamId: string): number {
    return this._teamCapOverrides.get(teamId) ?? this._defaultMaxConcurrentDailyOps;
  }

  /**
   * Attempt to acquire a daily-op slot for `teamId`.
   *
   * Returns ok=true when the slot is granted (per-team counter incremented).
   * Returns ok=false with retry_after_ms when this team is saturated.
   *
   * Guard: active >= max → reject (no off-by-one overflow; AC-54). The cap
   * is the team's override (via setTeamCap) or the constructor default.
   */
  acquireDaily(teamId: string): { ok: true } | { ok: false; retry_after_ms: number } {
    const active = this._activeDailyOps.get(teamId) ?? 0;
    if (active >= this.capFor(teamId)) {
      return { ok: false, retry_after_ms: DEFAULT_RETRY_AFTER_MS };
    }
    this._activeDailyOps.set(teamId, active + 1);
    return { ok: true };
  }

  /**
   * Release a previously acquired daily-op slot for `teamId`.
   * Floor is 0 — extra releases are safe.
   */
  releaseDaily(teamId: string): void {
    const active = this._activeDailyOps.get(teamId) ?? 0;
    if (active <= 1) {
      this._activeDailyOps.delete(teamId);
      return;
    }
    this._activeDailyOps.set(teamId, active - 1);
  }

  /**
   * Attempt to acquire the single org-op mutex for a team.
   *
   * Returns ok=false (with retry_after_ms) if any org-op is already active
   * for this team. The guard and org_op_pending share the same state (AC-55).
   */
  acquireOrg(teamId: string): { ok: true } | { ok: false; retry_after_ms: number } {
    if (this._orgOpActive.get(teamId)) {
      return { ok: false, retry_after_ms: DEFAULT_RETRY_AFTER_MS };
    }
    this._orgOpActive.set(teamId, true);
    return { ok: true };
  }

  /**
   * Release the org-op mutex for a team.
   */
  releaseOrg(teamId: string): void {
    this._orgOpActive.delete(teamId);
  }

  /**
   * Return a concurrency snapshot for a team.
   *
   * active_daily_ops: per-team active count (AC-54).
   * saturation: boolean — true iff active_daily_ops >= cap-for-team
   *   (per wiki Organization-Tools.md §get_status).
   * org_op_pending: derived from the per-team org-op mutex map only (AC-55).
   */
  getSnapshot(teamId: string): {
    active_daily_ops: number;
    saturation: boolean;
    org_op_pending: boolean;
  } {
    const active = this._activeDailyOps.get(teamId) ?? 0;
    return {
      active_daily_ops: active,
      saturation: active >= this.capFor(teamId),
      org_op_pending: this._orgOpActive.get(teamId) ?? false,
    };
  }
}
