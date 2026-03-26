/**
 * Session Manager (TeamRegistry)
 *
 * Tests: tracks active, stop removes, idle timeout, touch resets, etc.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { TeamRegistry } from './team-registry.js';

// ── Session Manager ───────────────────────────────────────────────────────

describe('Session Manager', () => {
  let manager: TeamRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new TeamRegistry({ idleTimeoutMs: 5000 });
  });

  afterEach(() => {
    manager.stopAll();
    vi.useRealTimers();
  });

  it('spawn tracks active session', () => {
    manager.spawn('team-a');
    expect(manager.isActive('team-a')).toBe(true);
    expect(manager.getActive()).toEqual(['team-a']);
  });

  it('stop removes session', () => {
    manager.spawn('team-a');
    manager.stop('team-a');
    expect(manager.isActive('team-a')).toBe(false);
    expect(manager.getActive()).toEqual([]);
  });

  it('stop on non-existent team is a no-op', () => {
    expect(() => manager.stop('ghost')).not.toThrow();
  });

  it('spawn returns abort controller', () => {
    const ac = manager.spawn('team-a');
    expect(ac).toBeInstanceOf(AbortController);
    expect(ac.signal.aborted).toBe(false);
  });

  it('stop aborts the controller', () => {
    const ac = manager.spawn('team-a');
    manager.stop('team-a');
    expect(ac.signal.aborted).toBe(true);
  });

  it('idle timeout triggers stop', () => {
    const ac = manager.spawn('team-a');
    expect(manager.isActive('team-a')).toBe(true);

    vi.advanceTimersByTime(5000);

    expect(manager.isActive('team-a')).toBe(false);
    expect(ac.signal.aborted).toBe(true);
  });

  it('touch resets idle timeout', () => {
    manager.spawn('team-a');

    vi.advanceTimersByTime(3000);
    manager.touch('team-a');
    vi.advanceTimersByTime(3000);

    // Should still be active (3s + touch + 3s < 5s from touch)
    expect(manager.isActive('team-a')).toBe(true);

    vi.advanceTimersByTime(2000);

    // Now 5s since touch, should be timed out
    expect(manager.isActive('team-a')).toBe(false);
  });

  it('getStatus returns active with uptime', () => {
    manager.spawn('team-a');
    vi.advanceTimersByTime(1000);

    const status = manager.getStatus('team-a');
    expect(status.active).toBe(true);
    expect(status.uptimeMs).toBe(1000);
  });

  it('getStatus returns inactive for unknown team', () => {
    const status = manager.getStatus('ghost');
    expect(status.active).toBe(false);
    expect(status.uptimeMs).toBe(0);
  });

  it('spawn replaces existing session for same team', () => {
    const ac1 = manager.spawn('team-a');
    const ac2 = manager.spawn('team-a');

    expect(ac1.signal.aborted).toBe(true);
    expect(ac2.signal.aborted).toBe(false);
    expect(manager.getActive()).toEqual(['team-a']);
  });

  it('stopAll clears everything', () => {
    manager.spawn('team-a');
    manager.spawn('team-b');
    manager.stopAll();

    expect(manager.getActive()).toEqual([]);
    expect(manager.isActive('team-a')).toBe(false);
    expect(manager.isActive('team-b')).toBe(false);
  });

  it('uses default 30min timeout when not configured', () => {
    const defaultManager = new TeamRegistry();
    defaultManager.spawn('team-x');

    vi.advanceTimersByTime(29 * 60 * 1000);
    expect(defaultManager.isActive('team-x')).toBe(true);

    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(defaultManager.isActive('team-x')).toBe(false);

    defaultManager.stopAll();
  });
});
