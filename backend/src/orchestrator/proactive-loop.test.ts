/**
 * Tests for ProactiveLoopImpl.
 *
 * Covers:
 *   1. start() creates timers for agents with proactive intervals
 *   2. start() skips agents with proactive_interval_minutes = 0
 *   3. start() uses default interval (30 min) when not specified
 *   4. start() enforces minimum interval (5 min, CON-07)
 *   5. check() skips when agent is busy (skip-if-busy)
 *   6. check() dispatches task with PROACTIVE.md content
 *   7. check() handles missing PROACTIVE.md gracefully
 *   8. check() handles team not found gracefully
 *   9. triggerNow() dispatches an immediate check
 *   10. wasSkipped() returns true after a skip
 *   11. stop() clears all timers
 *   12. start() is idempotent
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ProactiveLoopImpl,
  MIN_PROACTIVE_INTERVAL_MINUTES,
  DEFAULT_PROACTIVE_INTERVAL_MINUTES,
  type ProactiveLoopDeps,
} from './proactive-loop.js';
import type { Agent } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Mock fs
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('## Checks\n1. Check inbox\n2. Check calendar\n'),
}));

vi.mock('./orchestrator.js', () => ({
  resolveTeamWorkspacePath: vi.fn().mockImplementation((_runDir: string, slug: string) => {
    if (slug === 'main' || slug === 'master') {
      return `/run/openhive/workspace`;
    }
    return `/run/openhive/workspace/teams/${slug}`;
  }),
}));

import { readFile as fsReadFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<Agent> & { aid: string }): Agent {
  return {
    aid: overrides.aid,
    name: overrides.name ?? 'test-agent',
    proactive_interval_minutes: overrides.proactive_interval_minutes,
    ...overrides,
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeDeps(overrides: Partial<ProactiveLoopDeps> = {}): ProactiveLoopDeps {
  return {
    runDir: '/run/openhive',
    dispatchTask: vi.fn().mockResolvedValue('task-proactive-1'),
    isAgentBusy: vi.fn().mockResolvedValue(false),
    getTeamSlugForAgent: vi.fn().mockReturnValue('test-team'),
    logger: makeLogger(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('proactive loop constants', () => {
  it('minimum interval is 5 minutes', () => {
    expect(MIN_PROACTIVE_INTERVAL_MINUTES).toBe(5);
  });

  it('default interval is 30 minutes', () => {
    expect(DEFAULT_PROACTIVE_INTERVAL_MINUTES).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// ProactiveLoopImpl
// ---------------------------------------------------------------------------

describe('ProactiveLoopImpl', () => {
  let deps: ProactiveLoopDeps;
  let loop: ProactiveLoopImpl;

  beforeEach(() => {
    deps = makeDeps();
    loop = new ProactiveLoopImpl(deps);
    (fsReadFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      '## Checks\n1. Check inbox\n2. Check calendar\n',
    );
  });

  it('start() creates timers for agents with proactive intervals', async () => {
    const agent = makeAgent({ aid: 'aid-a', proactive_interval_minutes: 15 });
    await loop.start([agent]);

    expect(deps.logger.info).toHaveBeenCalledWith('proactive loop started', {
      agent_count: 1,
      active_loops: 1,
    });

    await loop.stop();
  });

  it('start() skips agents with proactive_interval_minutes = 0 (disabled)', async () => {
    const agent = makeAgent({ aid: 'aid-disabled', proactive_interval_minutes: 0 });
    await loop.start([agent]);

    expect(deps.logger.info).toHaveBeenCalledWith('proactive loop started', {
      agent_count: 1,
      active_loops: 0,
    });

    await loop.stop();
  });

  it('start() uses default interval when proactive_interval_minutes is undefined', async () => {
    const agent = makeAgent({ aid: 'aid-default' }); // no proactive_interval_minutes
    await loop.start([agent]);

    // Agent should get default 30-min interval and be active
    expect(deps.logger.info).toHaveBeenCalledWith('proactive loop started', {
      agent_count: 1,
      active_loops: 1,
    });

    await loop.stop();
  });

  it('start() enforces minimum interval (CON-07) when below 5 minutes', async () => {
    const agent = makeAgent({ aid: 'aid-fast', proactive_interval_minutes: 2 });
    await loop.start([agent]);

    expect(deps.logger.warn).toHaveBeenCalledWith(
      'proactive interval below minimum, using minimum',
      expect.objectContaining({
        aid: 'aid-fast',
        requested: 2,
        minimum: MIN_PROACTIVE_INTERVAL_MINUTES,
      }),
    );

    await loop.stop();
  });

  it('triggerNow() dispatches a proactive check task', async () => {
    const agent = makeAgent({ aid: 'aid-now', proactive_interval_minutes: 30 });
    await loop.start([agent]);

    await loop.triggerNow('aid-now');

    expect(deps.dispatchTask).toHaveBeenCalledWith(
      'test-team',
      'aid-now',
      expect.stringContaining('Proactive check'),
    );
    expect(deps.dispatchTask).toHaveBeenCalledWith(
      'test-team',
      'aid-now',
      expect.stringContaining('Check inbox'),
    );

    await loop.stop();
  });

  it('check skips when agent is busy (skip-if-busy)', async () => {
    (deps.isAgentBusy as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const agent = makeAgent({ aid: 'aid-busy', proactive_interval_minutes: 15 });
    await loop.start([agent]);

    await loop.triggerNow('aid-busy');

    expect(deps.dispatchTask).not.toHaveBeenCalled();
    expect(deps.logger.info).toHaveBeenCalledWith(
      'proactive check skipped (agent busy)',
      expect.objectContaining({ aid: 'aid-busy' }),
    );
    expect(loop.wasSkipped('aid-busy')).toBe(true);

    await loop.stop();
  });

  it('wasSkipped() returns false when check was not skipped', async () => {
    const agent = makeAgent({ aid: 'aid-ok', proactive_interval_minutes: 15 });
    await loop.start([agent]);

    await loop.triggerNow('aid-ok');

    expect(loop.wasSkipped('aid-ok')).toBe(false);

    await loop.stop();
  });

  it('wasSkipped() returns false for unknown agent', () => {
    expect(loop.wasSkipped('aid-unknown')).toBe(false);
  });

  it('handles missing PROACTIVE.md gracefully', async () => {
    const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
    enoent.code = 'ENOENT';
    (fsReadFile as ReturnType<typeof vi.fn>).mockRejectedValue(enoent);

    const agent = makeAgent({ aid: 'aid-nofile', proactive_interval_minutes: 15 });
    await loop.start([agent]);

    await loop.triggerNow('aid-nofile');

    expect(deps.dispatchTask).not.toHaveBeenCalled();
    expect(deps.logger.info).toHaveBeenCalledWith(
      'no PROACTIVE.md found, skipping proactive check',
      expect.objectContaining({ aid: 'aid-nofile' }),
    );

    await loop.stop();
  });

  it('handles team not found gracefully', async () => {
    (deps.getTeamSlugForAgent as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const agent = makeAgent({ aid: 'aid-orphan', proactive_interval_minutes: 15 });
    await loop.start([agent]);

    await loop.triggerNow('aid-orphan');

    expect(deps.dispatchTask).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'cannot dispatch proactive check: team not found for agent',
      expect.objectContaining({ aid: 'aid-orphan' }),
    );

    await loop.stop();
  });

  it('stop() clears all timers and prevents further checks', async () => {
    const agent = makeAgent({ aid: 'aid-stop', proactive_interval_minutes: 15 });
    await loop.start([agent]);
    await loop.stop();

    // After stop, triggerNow should be a no-op (running = false)
    await loop.triggerNow('aid-stop');
    expect(deps.dispatchTask).not.toHaveBeenCalled();
  });

  it('start() is idempotent when called twice', async () => {
    const agent = makeAgent({ aid: 'aid-idem', proactive_interval_minutes: 15 });
    await loop.start([agent]);
    await loop.start([agent]); // second call is no-op

    // Should still work normally
    await loop.triggerNow('aid-idem');
    expect(deps.dispatchTask).toHaveBeenCalledTimes(1);

    await loop.stop();
  });

  it('dispatches with proactive_check_id for idempotency', async () => {
    const agent = makeAgent({ aid: 'aid-check-id', proactive_interval_minutes: 15 });
    await loop.start([agent]);

    await loop.triggerNow('aid-check-id');

    const dispatchCalls = (deps.dispatchTask as ReturnType<typeof vi.fn>).mock.calls;
    const prompt = dispatchCalls[0]![2] as string;
    expect(prompt).toContain('Proactive check (ID:');
    expect(prompt).toContain('aid-check-id');

    await loop.stop();
  });

  it('handles dispatch failure gracefully', async () => {
    (deps.dispatchTask as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('dispatch failed'),
    );

    const agent = makeAgent({ aid: 'aid-fail', proactive_interval_minutes: 15 });
    await loop.start([agent]);

    await loop.triggerNow('aid-fail');

    expect(deps.logger.error).toHaveBeenCalledWith(
      'failed to dispatch proactive check',
      expect.objectContaining({ aid: 'aid-fail' }),
    );

    await loop.stop();
  });
});
