import { describe, it, expect } from 'vitest';
import { ConcurrencyManager } from './concurrency-manager.js';

describe('ConcurrencyManager', () => {
  it('grants daily-op slots up to max and rejects the next one', () => {
    const mgr = new ConcurrencyManager({ maxConcurrentDailyOps: 2 });
    expect(mgr.acquireDaily('t1').ok).toBe(true);
    expect(mgr.acquireDaily('t1').ok).toBe(true);
    const third = mgr.acquireDaily('t1');
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.retry_after_ms).toBeGreaterThan(0);
  });

  it('reports saturation=false while below max (per wiki §get_status)', () => {
    const mgr = new ConcurrencyManager({ maxConcurrentDailyOps: 4 });
    mgr.acquireDaily('t1');
    mgr.acquireDaily('t1');
    expect(mgr.getSnapshot('t1').saturation).toBe(false);
  });

  it('serializes org-ops via a single slot per team', () => {
    const mgr = new ConcurrencyManager({ maxConcurrentDailyOps: 5 });
    expect(mgr.acquireOrg('t1').ok).toBe(true);
    expect(mgr.acquireOrg('t1').ok).toBe(false);
    expect(mgr.getSnapshot('t1').org_op_pending).toBe(true);
    mgr.releaseOrg('t1');
    expect(mgr.getSnapshot('t1').org_op_pending).toBe(false);
  });

  it('releaseDaily balances acquireDaily so active_daily_ops returns to 0', () => {
    const mgr = new ConcurrencyManager({ maxConcurrentDailyOps: 3 });
    mgr.acquireDaily('t1');
    mgr.releaseDaily('t1');
    expect(mgr.getSnapshot('t1').active_daily_ops).toBe(0);
  });

  it('org-op slots are independent per team', () => {
    const mgr = new ConcurrencyManager({ maxConcurrentDailyOps: 5 });
    expect(mgr.acquireOrg('t1').ok).toBe(true);
    expect(mgr.acquireOrg('t2').ok).toBe(true);
    expect(mgr.getSnapshot('t1').org_op_pending).toBe(true);
    expect(mgr.getSnapshot('t2').org_op_pending).toBe(true);
    mgr.releaseOrg('t1');
    expect(mgr.getSnapshot('t1').org_op_pending).toBe(false);
    expect(mgr.getSnapshot('t2').org_op_pending).toBe(true);
  });

  it('releaseDaily is safe when already at zero (floor guard)', () => {
    const mgr = new ConcurrencyManager({ maxConcurrentDailyOps: 3 });
    mgr.releaseDaily('t1');
    expect(mgr.getSnapshot('t1').active_daily_ops).toBe(0);
    expect(mgr.getSnapshot('t1').saturation).toBe(false);
  });

  it('saturation flips to true when active_daily_ops >= max (AC-54)', () => {
    const mgr = new ConcurrencyManager({ maxConcurrentDailyOps: 2 });
    mgr.acquireDaily('t1');
    mgr.acquireDaily('t1');
    expect(mgr.getSnapshot('t1').saturation).toBe(true);
  });

  it('acquireOrg retry_after_ms is positive when slot is held', () => {
    const mgr = new ConcurrencyManager({ maxConcurrentDailyOps: 5 });
    mgr.acquireOrg('t1');
    const result = mgr.acquireOrg('t1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retry_after_ms).toBeGreaterThan(0);
    }
  });

  it('daily-op counters are isolated per team (one saturated team does not starve another)', () => {
    const mgr = new ConcurrencyManager({ maxConcurrentDailyOps: 1 });
    expect(mgr.acquireDaily('t1').ok).toBe(true);
    // t1 saturated — but t2 should still have a free slot.
    expect(mgr.acquireDaily('t1').ok).toBe(false);
    expect(mgr.acquireDaily('t2').ok).toBe(true);
    expect(mgr.getSnapshot('t1').active_daily_ops).toBe(1);
    expect(mgr.getSnapshot('t1').saturation).toBe(true);
    expect(mgr.getSnapshot('t2').active_daily_ops).toBe(1);
    expect(mgr.getSnapshot('t2').saturation).toBe(true);
  });

  // ── Per-team cap override (ADR-41 G6) ────────────────────────────────────
  describe('setTeamCap — per-team cap override from TeamConfig', () => {
    it('a team with setTeamCap(2) saturates at 2 even when the default is 5', () => {
      const mgr = new ConcurrencyManager({ maxConcurrentDailyOps: 5 });
      mgr.setTeamCap('tight', 2);
      expect(mgr.acquireDaily('tight').ok).toBe(true);
      expect(mgr.acquireDaily('tight').ok).toBe(true);
      const third = mgr.acquireDaily('tight');
      expect(third.ok).toBe(false);
      expect(mgr.getSnapshot('tight').saturation).toBe(true);
    });

    it('a team with setTeamCap(10) gets more headroom than the global default of 3', () => {
      const mgr = new ConcurrencyManager({ maxConcurrentDailyOps: 3 });
      mgr.setTeamCap('wide', 10);
      for (let i = 0; i < 10; i++) {
        expect(mgr.acquireDaily('wide').ok).toBe(true);
      }
      expect(mgr.acquireDaily('wide').ok).toBe(false);
      expect(mgr.getSnapshot('wide').active_daily_ops).toBe(10);
    });

    it('a team without setTeamCap keeps the global default cap', () => {
      const mgr = new ConcurrencyManager({ maxConcurrentDailyOps: 2 });
      mgr.setTeamCap('other', 10);
      // 'default-team' has no override — default applies.
      expect(mgr.acquireDaily('default-team').ok).toBe(true);
      expect(mgr.acquireDaily('default-team').ok).toBe(true);
      expect(mgr.acquireDaily('default-team').ok).toBe(false);
    });

    it('setTeamCap with a non-positive value is a no-op (falls back to default)', () => {
      const mgr = new ConcurrencyManager({ maxConcurrentDailyOps: 2 });
      mgr.setTeamCap('weird', 0);
      mgr.setTeamCap('weird', -5);
      mgr.setTeamCap('weird', Number.NaN);
      expect(mgr.acquireDaily('weird').ok).toBe(true);
      expect(mgr.acquireDaily('weird').ok).toBe(true);
      expect(mgr.acquireDaily('weird').ok).toBe(false);
    });

    it('getSnapshot.saturation reflects the per-team cap', () => {
      const mgr = new ConcurrencyManager({ maxConcurrentDailyOps: 10 });
      mgr.setTeamCap('narrow', 1);
      mgr.acquireDaily('narrow');
      expect(mgr.getSnapshot('narrow').saturation).toBe(true);
      expect(mgr.getSnapshot('narrow').active_daily_ops).toBe(1);
    });
  });
});
