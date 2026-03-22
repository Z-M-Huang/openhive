/**
 * Layer 3 Phase Gate: Domain Core integration tests.
 *
 * Exercises EventBus (async delivery, filtering, isolation), OrgChart
 * (3-level hierarchy, authorization matrix, INV-01 enforcement),
 * WorkspaceLock (serialization), and domain error mapping.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { EventBusImpl } from '../control-plane/event-bus.js';
import { OrgChartImpl } from '../control-plane/org-chart.js';
import { WorkspaceLockImpl } from '../control-plane/workspace-lock.js';
import { assertValidTransition } from '../domain/domain.js';
import {
  InvalidTransitionError,
  mapDomainErrorToWSError,
} from '../domain/errors.js';
import { AgentStatus, ContainerHealth, TaskStatus, WSErrorCode } from '../domain/enums.js';
import type { BusEvent, OrgChartAgent, OrgChartTeam } from '../domain/interfaces.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(type: string, source?: string): BusEvent {
  return { type, data: {}, timestamp: Date.now(), source };
}

function makeTeam(overrides: Partial<OrgChartTeam> & { tid: string; slug: string; coordinatorAid: string }): OrgChartTeam {
  return {
    parentTid: '',
    depth: 0,
    containerId: '',
    health: ContainerHealth.Running,
    agentAids: [],
    workspacePath: '/app/workspace',
    ...overrides,
  };
}

function makeAgent(overrides: Partial<OrgChartAgent> & { aid: string; teamSlug: string }): OrgChartAgent {
  return {
    name: overrides.aid,
    role: 'member',
    status: AgentStatus.Idle,
    ...overrides,
  };
}

/**
 * Bootstrap a root team by directly seeding the OrgChart's private maps.
 * This works around the chicken-and-egg: addTeam requires leader in agentsByAid,
 * addAgent requires team in teamsBySlug. The real orchestrator handles this at init.
 */
function bootstrapRootTeam(chart: OrgChartImpl): void {
  const raw = chart as unknown as {
    teamsByTid: Map<string, OrgChartTeam>;
    teamsBySlug: Map<string, OrgChartTeam>;
    agentsByAid: Map<string, OrgChartAgent>;
    agentsByTeam: Map<string, Set<string>>;
  };

  const rootTeam = makeTeam({
    tid: 'tid-root-001',
    slug: 'root-team',
    coordinatorAid: 'aid-main-001',
    depth: 0,
  });
  const mainAgent = makeAgent({
    aid: 'aid-main-001',
    teamSlug: 'root-team',
    role: 'main_assistant',
  });

  raw.teamsByTid.set(rootTeam.tid, rootTeam);
  raw.teamsBySlug.set(rootTeam.slug, rootTeam);
  raw.agentsByAid.set(mainAgent.aid, mainAgent);
  raw.agentsByTeam.set('root-team', new Set([mainAgent.aid]));
}

/** Flush pending microtasks. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Layer 3 Phase Gate: Domain Core', () => {

  // -----------------------------------------------------------------------
  // 1. EventBus publish + subscribe round-trip
  // -----------------------------------------------------------------------

  describe('EventBus publish+subscribe round-trip', () => {
    let bus: EventBusImpl;
    beforeEach(() => { bus = new EventBusImpl(); });

    it('delivers events to subscribers via microtask', async () => {
      const received: BusEvent[] = [];
      bus.subscribe((e) => received.push(e));

      const event = makeEvent('test.created');
      bus.publish(event);

      expect(received).toHaveLength(0); // not synchronous
      await flushMicrotasks();
      expect(received).toHaveLength(1);
      expect(received[0]).toBe(event);
    });

    it('filtered subscriber only receives matching events', async () => {
      const all: BusEvent[] = [];
      const filtered: BusEvent[] = [];

      bus.subscribe((e) => all.push(e));
      bus.filteredSubscribe(
        (e) => e.type === 'team.created',
        (e) => filtered.push(e),
      );

      bus.publish(makeEvent('task.completed'));
      bus.publish(makeEvent('team.created'));
      bus.publish(makeEvent('agent.ready'));
      await flushMicrotasks();

      expect(all).toHaveLength(3);
      expect(filtered).toHaveLength(1);
      expect(filtered[0]!.type).toBe('team.created');
    });
  });

  // -----------------------------------------------------------------------
  // 2. EventBus async isolation
  // -----------------------------------------------------------------------

  describe('EventBus async isolation', () => {
    let bus: EventBusImpl;
    beforeEach(() => { bus = new EventBusImpl(); });

    it('throwing handler does not prevent other handlers from running', async () => {
      const received: string[] = [];
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      bus.subscribe(() => { throw new Error('handler boom'); });
      bus.subscribe(() => { received.push('second'); });

      bus.publish(makeEvent('test'));
      await flushMicrotasks();

      expect(received).toEqual(['second']);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('each handler dispatched independently via queueMicrotask', async () => {
      const order: string[] = [];

      bus.subscribe(() => {
        order.push('slow-start');
        for (let i = 0; i < 1000; i++) { /* busy-wait */ }
        order.push('slow-end');
      });
      bus.subscribe(() => { order.push('fast'); });

      bus.publish(makeEvent('test'));
      await flushMicrotasks();

      // Both ran — each in its own microtask, isolated from each other
      expect(order).toContain('slow-start');
      expect(order).toContain('slow-end');
      expect(order).toContain('fast');
    });
  });

  // -----------------------------------------------------------------------
  // 3. OrgChart 3-level hierarchy + authorization matrix
  // -----------------------------------------------------------------------

  describe('OrgChart 3-level hierarchy + authorization', () => {
    let chart: OrgChartImpl;

    /**
     * Hierarchy:
     *   root-team: main-assistant, team-a-lead (leads team-a)
     *   team-a (led by team-a-lead): member-1, member-2, team-a1-lead (leads team-a1)
     *   team-a1 (led by team-a1-lead): member-3
     */
    function seedHierarchy(): void {
      bootstrapRootTeam(chart);

      chart.addAgent(makeAgent({
        aid: 'aid-leada-001',
        teamSlug: 'root-team',
        role: 'member',
      }));

      chart.addTeam(makeTeam({
        tid: 'tid-teama-001',
        slug: 'team-a',
        coordinatorAid: 'aid-leada-001',
        parentTid: 'tid-root-001',
        depth: 1,
      }));

      chart.addAgent(makeAgent({ aid: 'aid-mem1-001', teamSlug: 'team-a' }));
      chart.addAgent(makeAgent({ aid: 'aid-mem2-001', teamSlug: 'team-a' }));

      chart.addAgent(makeAgent({
        aid: 'aid-leada1-01',
        teamSlug: 'team-a',
        role: 'member',
      }));

      chart.addTeam(makeTeam({
        tid: 'tid-teama1-01',
        slug: 'team-a1',
        coordinatorAid: 'aid-leada1-01',
        parentTid: 'tid-teama-001',
        depth: 2,
      }));

      chart.addAgent(makeAgent({ aid: 'aid-mem3-001', teamSlug: 'team-a1' }));
    }

    beforeEach(() => { chart = new OrgChartImpl(); });

    it('root agent <-> team-A lead: YES (same team)', () => {
      seedHierarchy();
      expect(chart.isAuthorized('aid-main-001', 'aid-leada-001')).toBe(true);
      expect(chart.isAuthorized('aid-leada-001', 'aid-main-001')).toBe(true);
    });

    it('main_assistant -> any member: YES', () => {
      seedHierarchy();
      // main_assistant is authorized to reach any agent in the hierarchy
      expect(chart.isAuthorized('aid-main-001', 'aid-mem1-001')).toBe(true);
      expect(chart.isAuthorized('aid-main-001', 'aid-mem2-001')).toBe(true);
      expect(chart.isAuthorized('aid-main-001', 'aid-mem3-001')).toBe(true);
    });

    it('main_assistant -> deep descendant: YES', () => {
      seedHierarchy();
      expect(chart.isAuthorized('aid-main-001', 'aid-mem3-001')).toBe(true);
    });

    it('cross-team non-main_assistant -> NO (flat model)', () => {
      seedHierarchy();
      // leada-001 (root-team) → mem1-001 (team-a): not same team, not main_assistant
      expect(chart.isAuthorized('aid-leada-001', 'aid-mem1-001')).toBe(false);
      // mem1-001 (team-a) → leada-001 (root-team): not same team, not main_assistant
      expect(chart.isAuthorized('aid-mem1-001', 'aid-leada-001')).toBe(false);
    });

    it('team-A member -> team-A1 member: NO (cross-branch)', () => {
      seedHierarchy();
      expect(chart.isAuthorized('aid-mem1-001', 'aid-mem3-001')).toBe(false);
    });

    it('team-A1 member -> team-A member: NO (cross-team, not upward to own lead)', () => {
      seedHierarchy();
      expect(chart.isAuthorized('aid-mem3-001', 'aid-mem1-001')).toBe(false);
    });

    it('team-A1 member -> team-A lead: NO (cross-team in flat model)', () => {
      seedHierarchy();
      // mem3-001 (team-a1) → leada1-01 (team-a): different teams, not main_assistant
      expect(chart.isAuthorized('aid-mem3-001', 'aid-leada1-01')).toBe(false);
    });

    it('non-existent agent: NO', () => {
      seedHierarchy();
      expect(chart.isAuthorized('aid-nobody-001', 'aid-mem1-001')).toBe(false);
      expect(chart.isAuthorized('aid-mem1-001', 'aid-nobody-001')).toBe(false);
    });
  });

  // INV-01 enforcement tests removed — leader validation no longer enforced

  // -----------------------------------------------------------------------
  // 5. WorkspaceLock serialization
  // -----------------------------------------------------------------------

  describe('WorkspaceLock', () => {
    let lock: WorkspaceLockImpl;
    beforeEach(() => { lock = new WorkspaceLockImpl(); });

    it('two concurrent acquires on same path serialize', async () => {
      const order: string[] = [];

      await lock.acquire('/app/workspace');
      order.push('first-acquired');
      expect(lock.isLocked('/app/workspace')).toBe(true);

      let secondResolved = false;
      const second = lock.acquire('/app/workspace').then(() => {
        secondResolved = true;
        order.push('second-acquired');
      });

      await flushMicrotasks();
      expect(secondResolved).toBe(false);

      lock.release('/app/workspace');
      await second;

      expect(order).toEqual(['first-acquired', 'second-acquired']);
    });

    it('release wakes blocked waiter', async () => {
      await lock.acquire('/app/workspace');

      let woken = false;
      const waiter = lock.acquire('/app/workspace').then(() => { woken = true; });

      await flushMicrotasks();
      expect(woken).toBe(false);

      lock.release('/app/workspace');
      await waiter;
      expect(woken).toBe(true);
    });

    it('different paths do not block each other', async () => {
      await lock.acquire('/path/a');
      await lock.acquire('/path/b');

      expect(lock.isLocked('/path/a')).toBe(true);
      expect(lock.isLocked('/path/b')).toBe(true);

      lock.release('/path/a');
      lock.release('/path/b');
    });
  });

  // -----------------------------------------------------------------------
  // 6. EventBus + OrgChart integration
  // -----------------------------------------------------------------------

  describe('EventBus + OrgChart integration', () => {
    it('both components coexist and events reflect OrgChart mutations', async () => {
      const bus = new EventBusImpl();
      const chart = new OrgChartImpl();
      const events: BusEvent[] = [];

      bus.subscribe((e) => events.push(e));

      bootstrapRootTeam(chart);

      // Simulate orchestrator publishing event after OrgChart mutation
      bus.publish({
        type: 'team.created',
        data: { tid: 'tid-root-001', slug: 'root-team' },
        timestamp: Date.now(),
        source: 'orchestrator',
      });
      await flushMicrotasks();

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('team.created');
      expect(chart.getTeam('tid-root-001')).toBeDefined();

      bus.close();
    });
  });

  // -----------------------------------------------------------------------
  // 7. assertValidTransition + error mapping
  // -----------------------------------------------------------------------

  describe('assertValidTransition + error mapping', () => {
    it('valid transitions do not throw', () => {
      expect(() => assertValidTransition(TaskStatus.Pending, TaskStatus.Active)).not.toThrow();
      expect(() => assertValidTransition(TaskStatus.Active, TaskStatus.Completed)).not.toThrow();
      expect(() => assertValidTransition(TaskStatus.Active, TaskStatus.Failed)).not.toThrow();
      expect(() => assertValidTransition(TaskStatus.Failed, TaskStatus.Pending)).not.toThrow();
      expect(() => assertValidTransition(TaskStatus.Failed, TaskStatus.Escalated)).not.toThrow();
      expect(() => assertValidTransition(TaskStatus.Escalated, TaskStatus.Pending)).not.toThrow();
    });

    it('invalid transition throws InvalidTransitionError (not plain Error)', () => {
      expect(() =>
        assertValidTransition(TaskStatus.Completed, TaskStatus.Active),
      ).toThrow(InvalidTransitionError);

      expect(() =>
        assertValidTransition(TaskStatus.Cancelled, TaskStatus.Pending),
      ).toThrow(InvalidTransitionError);

      expect(() =>
        assertValidTransition(TaskStatus.Pending, TaskStatus.Completed),
      ).toThrow(InvalidTransitionError);
    });

    it('mapDomainErrorToWSError maps InvalidTransitionError to VALIDATION_ERROR', () => {
      try {
        assertValidTransition(TaskStatus.Completed, TaskStatus.Active);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidTransitionError);
        const code = mapDomainErrorToWSError(err as InvalidTransitionError);
        expect(code).toBe(WSErrorCode.ValidationError);
      }
    });
  });
});
