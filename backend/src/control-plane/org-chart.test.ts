import { describe, it, expect, beforeEach } from 'vitest';
import { OrgChartImpl } from './org-chart.js';
import type { OrgChartAgent, OrgChartTeam } from '../domain/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/index.js';
import { AgentStatus, ContainerHealth } from '../domain/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTeam(overrides: Partial<OrgChartTeam> = {}): OrgChartTeam {
  return {
    tid: 'tid-alpha-001',
    slug: 'alpha-team',
    leaderAid: 'aid-alice-001',
    parentTid: '',
    depth: 0,
    containerId: 'cid-alpha',
    health: ContainerHealth.Running,
    agentAids: [],
    workspacePath: '/app/workspace/teams/alpha-team',
    ...overrides,
  };
}

function makeAgent(overrides: Partial<OrgChartAgent> = {}): OrgChartAgent {
  return {
    aid: 'aid-alice-001',
    name: 'Alice',
    teamSlug: 'root-team',
    role: 'team_lead',
    status: AgentStatus.Idle,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OrgChartImpl', () => {
  let chart: OrgChartImpl;

  function bootstrapRootTeam(c: OrgChartImpl): void {
    // Use type assertion to access private maps for bootstrap only.
    // This simulates what the real orchestrator bootstrap would do.
    const raw = c as unknown as {
      teamsByTid: Map<string, OrgChartTeam>;
      teamsBySlug: Map<string, OrgChartTeam>;
      agentsByAid: Map<string, OrgChartAgent>;
      agentsByTeam: Map<string, Set<string>>;
    };

    const rootTeam = makeTeam({
      tid: 'tid-root-001',
      slug: 'root-team',
      leaderAid: 'aid-main-001',
      parentTid: '',
      depth: 0,
    });

    const mainAgent = makeAgent({
      aid: 'aid-main-001',
      name: 'MainAssistant',
      teamSlug: 'root-team',
      role: 'main_assistant',
    });

    raw.teamsByTid.set(rootTeam.tid, rootTeam);
    raw.teamsBySlug.set(rootTeam.slug, rootTeam);
    raw.agentsByAid.set(mainAgent.aid, mainAgent);
    raw.agentsByTeam.set('root-team', new Set([mainAgent.aid]));
  }

  beforeEach(() => {
    chart = new OrgChartImpl();
  });

  // -----------------------------------------------------------------------
  // addTeam
  // -----------------------------------------------------------------------

  describe('addTeam', () => {
    it('rejects duplicate TID', () => {
      bootstrapRootTeam(chart);
      chart.addAgent(makeAgent({ aid: 'aid-alice-001', teamSlug: 'root-team' }));

      const team = makeTeam({
        tid: 'tid-alpha-001',
        slug: 'alpha-team',
        leaderAid: 'aid-alice-001',
        parentTid: 'tid-root-001',
      });
      chart.addTeam(team);

      chart.addAgent(makeAgent({ aid: 'aid-bob-001', name: 'Bob', teamSlug: 'root-team' }));
      const dup = makeTeam({
        tid: 'tid-alpha-001',
        slug: 'beta-team',
        leaderAid: 'aid-bob-001',
        parentTid: 'tid-root-001',
      });
      expect(() => chart.addTeam(dup)).toThrow(ConflictError);
    });

    it('rejects duplicate slug', () => {
      bootstrapRootTeam(chart);
      chart.addAgent(makeAgent({ aid: 'aid-alice-001', teamSlug: 'root-team' }));

      const team = makeTeam({
        tid: 'tid-alpha-001',
        slug: 'alpha-team',
        leaderAid: 'aid-alice-001',
        parentTid: 'tid-root-001',
      });
      chart.addTeam(team);

      chart.addAgent(makeAgent({ aid: 'aid-bob-001', name: 'Bob', teamSlug: 'root-team' }));
      const dup = makeTeam({
        tid: 'tid-alpha-002',
        slug: 'alpha-team',
        leaderAid: 'aid-bob-001',
        parentTid: 'tid-root-001',
      });
      expect(() => chart.addTeam(dup)).toThrow(ConflictError);
    });

    it('rejects leader not found in org chart (INV-01)', () => {
      bootstrapRootTeam(chart);

      const team = makeTeam({
        leaderAid: 'aid-ghost-001',
        parentTid: 'tid-root-001',
      });
      expect(() => chart.addTeam(team)).toThrow(ValidationError);
      expect(() => chart.addTeam(team)).toThrow(/INV-01/);
    });

    it('rejects leader not in parent team (INV-01)', () => {
      bootstrapRootTeam(chart);

      // Add alice to root team
      chart.addAgent(makeAgent({ aid: 'aid-alice-001', teamSlug: 'root-team' }));
      // Create alpha-team led by alice
      chart.addTeam(makeTeam({
        tid: 'tid-alpha-001',
        slug: 'alpha-team',
        leaderAid: 'aid-alice-001',
        parentTid: 'tid-root-001',
      }));
      // Add carol to alpha-team
      chart.addAgent(makeAgent({ aid: 'aid-carol-001', name: 'Carol', teamSlug: 'alpha-team' }));

      // Try to create a child of root-team led by carol (who is in alpha-team, not root-team)
      const badTeam = makeTeam({
        tid: 'tid-bad-001',
        slug: 'bad-team',
        leaderAid: 'aid-carol-001',
        parentTid: 'tid-root-001',
      });
      expect(() => chart.addTeam(badTeam)).toThrow(ValidationError);
      expect(() => chart.addTeam(badTeam)).toThrow(/INV-01/);
    });

    it('succeeds when leader is in parent team (INV-01)', () => {
      bootstrapRootTeam(chart);
      chart.addAgent(makeAgent({ aid: 'aid-alice-001', teamSlug: 'root-team' }));

      const team = makeTeam({
        tid: 'tid-alpha-001',
        slug: 'alpha-team',
        leaderAid: 'aid-alice-001',
        parentTid: 'tid-root-001',
      });

      expect(() => chart.addTeam(team)).not.toThrow();
      expect(chart.getTeam('tid-alpha-001')).toBeDefined();
      expect(chart.getTeamBySlug('alpha-team')).toBeDefined();
    });

    it('rejects unknown parent TID', () => {
      bootstrapRootTeam(chart);
      chart.addAgent(makeAgent({ aid: 'aid-alice-001', teamSlug: 'root-team' }));

      const team = makeTeam({
        leaderAid: 'aid-alice-001',
        parentTid: 'tid-nonexistent-001',
      });
      expect(() => chart.addTeam(team)).toThrow(ValidationError);
    });
  });

  // -----------------------------------------------------------------------
  // removeTeam
  // -----------------------------------------------------------------------

  describe('removeTeam', () => {
    it('throws NotFoundError for unknown TID', () => {
      expect(() => chart.removeTeam('tid-unknown-001')).toThrow(NotFoundError);
    });

    it('throws ValidationError when team has children', () => {
      bootstrapRootTeam(chart);
      chart.addAgent(makeAgent({ aid: 'aid-alice-001', teamSlug: 'root-team' }));
      chart.addTeam(makeTeam({
        tid: 'tid-alpha-001',
        slug: 'alpha-team',
        leaderAid: 'aid-alice-001',
        parentTid: 'tid-root-001',
      }));
      chart.addAgent(makeAgent({ aid: 'aid-carol-001', name: 'Carol', teamSlug: 'alpha-team' }));
      chart.addTeam(makeTeam({
        tid: 'tid-beta-001',
        slug: 'beta-team',
        leaderAid: 'aid-carol-001',
        parentTid: 'tid-alpha-001',
        depth: 2,
      }));

      expect(() => chart.removeTeam('tid-alpha-001')).toThrow(ValidationError);
    });

    it('succeeds when team has no children and cleans up agents', () => {
      bootstrapRootTeam(chart);
      chart.addAgent(makeAgent({ aid: 'aid-alice-001', teamSlug: 'root-team' }));
      chart.addTeam(makeTeam({
        tid: 'tid-alpha-001',
        slug: 'alpha-team',
        leaderAid: 'aid-alice-001',
        parentTid: 'tid-root-001',
      }));
      chart.addAgent(makeAgent({ aid: 'aid-dave-001', name: 'Dave', teamSlug: 'alpha-team' }));

      chart.removeTeam('tid-alpha-001');

      expect(chart.getTeam('tid-alpha-001')).toBeUndefined();
      expect(chart.getTeamBySlug('alpha-team')).toBeUndefined();
      expect(chart.getAgent('aid-dave-001')).toBeUndefined();
      expect(chart.getChildren('tid-root-001')).toHaveLength(0);
    });

    it('cleans up lead->team mapping on removal', () => {
      bootstrapRootTeam(chart);
      chart.addAgent(makeAgent({
        aid: 'aid-alice-001',
        teamSlug: 'root-team',
        leadsTeam: 'alpha-team',
      }));
      chart.addTeam(makeTeam({
        tid: 'tid-alpha-001',
        slug: 'alpha-team',
        leaderAid: 'aid-alice-001',
        parentTid: 'tid-root-001',
      }));

      // Alice should be authorized to talk to alpha-team members
      chart.addAgent(makeAgent({ aid: 'aid-dave-001', name: 'Dave', teamSlug: 'alpha-team' }));
      expect(chart.isAuthorized('aid-alice-001', 'aid-dave-001')).toBe(true);

      chart.removeAgent('aid-dave-001');
      chart.removeTeam('tid-alpha-001');

      // The team is gone
      expect(chart.getTeam('tid-alpha-001')).toBeUndefined();
      // Alice still exists (she's in root-team, not alpha-team)
      expect(chart.getAgent('aid-alice-001')).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Team lookups
  // -----------------------------------------------------------------------

  describe('team lookups', () => {
    it('getTeam returns undefined for missing TID', () => {
      expect(chart.getTeam('tid-missing-001')).toBeUndefined();
    });

    it('getTeamBySlug returns undefined for missing slug', () => {
      expect(chart.getTeamBySlug('no-such-team')).toBeUndefined();
    });

    it('listTeams returns snapshot array', () => {
      bootstrapRootTeam(chart);
      chart.addAgent(makeAgent({ aid: 'aid-alice-001', teamSlug: 'root-team' }));
      chart.addTeam(makeTeam({
        tid: 'tid-alpha-001',
        slug: 'alpha-team',
        leaderAid: 'aid-alice-001',
        parentTid: 'tid-root-001',
      }));

      const teams = chart.listTeams();
      // root-team + alpha-team
      expect(teams.length).toBe(2);
      // Mutating the returned array does not affect internal state
      teams.pop();
      expect(chart.listTeams().length).toBe(2);
    });

    it('getChildren returns empty for team with no children', () => {
      bootstrapRootTeam(chart);
      expect(chart.getChildren('tid-root-001')).toEqual([]);
    });

    it('getChildren returns child teams', () => {
      bootstrapRootTeam(chart);
      chart.addAgent(makeAgent({ aid: 'aid-alice-001', teamSlug: 'root-team' }));
      chart.addTeam(makeTeam({
        tid: 'tid-alpha-001',
        slug: 'alpha-team',
        leaderAid: 'aid-alice-001',
        parentTid: 'tid-root-001',
      }));

      const children = chart.getChildren('tid-root-001');
      expect(children).toHaveLength(1);
      expect(children[0].tid).toBe('tid-alpha-001');
    });

    it('getParent returns parent team', () => {
      bootstrapRootTeam(chart);
      chart.addAgent(makeAgent({ aid: 'aid-alice-001', teamSlug: 'root-team' }));
      chart.addTeam(makeTeam({
        tid: 'tid-alpha-001',
        slug: 'alpha-team',
        leaderAid: 'aid-alice-001',
        parentTid: 'tid-root-001',
      }));

      const parent = chart.getParent('tid-alpha-001');
      expect(parent).toBeDefined();
      expect(parent!.tid).toBe('tid-root-001');
    });

    it('getParent returns undefined for root team', () => {
      bootstrapRootTeam(chart);
      expect(chart.getParent('tid-root-001')).toBeUndefined();
    });

    it('getParent returns undefined for unknown team', () => {
      expect(chart.getParent('tid-ghost-001')).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Agent CRUD
  // -----------------------------------------------------------------------

  describe('agent CRUD', () => {
    it('addAgent succeeds and can be retrieved', () => {
      bootstrapRootTeam(chart);
      const agent = makeAgent({ aid: 'aid-bob-001', name: 'Bob', teamSlug: 'root-team' });
      chart.addAgent(agent);

      const retrieved = chart.getAgent('aid-bob-001');
      expect(retrieved).toBeDefined();
      expect(retrieved!.name).toBe('Bob');
    });

    it('addAgent rejects duplicate AID', () => {
      bootstrapRootTeam(chart);
      chart.addAgent(makeAgent({ aid: 'aid-bob-001', teamSlug: 'root-team' }));
      expect(() =>
        chart.addAgent(makeAgent({ aid: 'aid-bob-001', teamSlug: 'root-team' }))
      ).toThrow(ConflictError);
    });

    it('addAgent rejects unknown team slug', () => {
      bootstrapRootTeam(chart);
      expect(() =>
        chart.addAgent(makeAgent({ aid: 'aid-bob-001', teamSlug: 'no-team' }))
      ).toThrow(NotFoundError);
    });

    it('removeAgent succeeds', () => {
      bootstrapRootTeam(chart);
      chart.addAgent(makeAgent({ aid: 'aid-bob-001', teamSlug: 'root-team' }));
      chart.removeAgent('aid-bob-001');
      expect(chart.getAgent('aid-bob-001')).toBeUndefined();
    });

    it('removeAgent throws for unknown AID', () => {
      expect(() => chart.removeAgent('aid-ghost-001')).toThrow(NotFoundError);
    });

    it('getAgentsByTeam returns all agents in a team', () => {
      bootstrapRootTeam(chart);
      chart.addAgent(makeAgent({ aid: 'aid-bob-001', name: 'Bob', teamSlug: 'root-team' }));
      chart.addAgent(makeAgent({ aid: 'aid-carol-001', name: 'Carol', teamSlug: 'root-team' }));

      const agents = chart.getAgentsByTeam('root-team');
      // main-001 (bootstrap) + bob + carol = 3
      expect(agents.length).toBe(3);
    });

    it('getAgentsByTeam returns empty for unknown team', () => {
      expect(chart.getAgentsByTeam('phantom-team')).toEqual([]);
    });

    it('getLeadOf returns team leader', () => {
      bootstrapRootTeam(chart);
      chart.addAgent(makeAgent({ aid: 'aid-alice-001', teamSlug: 'root-team' }));
      chart.addTeam(makeTeam({
        tid: 'tid-alpha-001',
        slug: 'alpha-team',
        leaderAid: 'aid-alice-001',
        parentTid: 'tid-root-001',
      }));

      const lead = chart.getLeadOf('alpha-team');
      expect(lead).toBeDefined();
      expect(lead!.aid).toBe('aid-alice-001');
    });

    it('getLeadOf returns undefined for unknown team', () => {
      expect(chart.getLeadOf('phantom')).toBeUndefined();
    });

    it('removeAgent with leadsTeam cleans up lead mapping', () => {
      bootstrapRootTeam(chart);
      chart.addAgent(makeAgent({
        aid: 'aid-alice-001',
        teamSlug: 'root-team',
        leadsTeam: 'alpha-team',
      }));
      chart.addTeam(makeTeam({
        tid: 'tid-alpha-001',
        slug: 'alpha-team',
        leaderAid: 'aid-alice-001',
        parentTid: 'tid-root-001',
      }));
      chart.addAgent(makeAgent({ aid: 'aid-dave-001', name: 'Dave', teamSlug: 'alpha-team' }));

      // Before removal: alice can reach dave (downward)
      expect(chart.isAuthorized('aid-alice-001', 'aid-dave-001')).toBe(true);

      chart.removeAgent('aid-alice-001');

      // After removal: alice no longer exists
      expect(chart.getAgent('aid-alice-001')).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Authorization
  // -----------------------------------------------------------------------

  describe('isAuthorized', () => {
    /**
     * Hierarchy for authorization tests:
     *
     * root-team: main-assistant, alice (leads alpha), bob (leads gamma)
     * alpha-team (led by alice): carol (leads beta), dave
     * beta-team (led by carol): eve, frank
     * gamma-team (led by bob): grace
     */
    function seedAuthHierarchy(): void {
      bootstrapRootTeam(chart);

      // root-team agents
      chart.addAgent(makeAgent({
        aid: 'aid-alice-001',
        name: 'Alice',
        teamSlug: 'root-team',
        leadsTeam: 'alpha-team',
      }));
      chart.addAgent(makeAgent({
        aid: 'aid-bob-001',
        name: 'Bob',
        teamSlug: 'root-team',
        leadsTeam: 'gamma-team',
      }));

      // alpha-team
      chart.addTeam(makeTeam({
        tid: 'tid-alpha-001',
        slug: 'alpha-team',
        leaderAid: 'aid-alice-001',
        parentTid: 'tid-root-001',
        depth: 1,
      }));
      chart.addAgent(makeAgent({
        aid: 'aid-carol-001',
        name: 'Carol',
        teamSlug: 'alpha-team',
        leadsTeam: 'beta-team',
      }));
      chart.addAgent(makeAgent({
        aid: 'aid-dave-001',
        name: 'Dave',
        teamSlug: 'alpha-team',
      }));

      // beta-team
      chart.addTeam(makeTeam({
        tid: 'tid-beta-001',
        slug: 'beta-team',
        leaderAid: 'aid-carol-001',
        parentTid: 'tid-alpha-001',
        depth: 2,
      }));
      chart.addAgent(makeAgent({
        aid: 'aid-eve-001',
        name: 'Eve',
        teamSlug: 'beta-team',
      }));
      chart.addAgent(makeAgent({
        aid: 'aid-frank-001',
        name: 'Frank',
        teamSlug: 'beta-team',
      }));

      // gamma-team (sibling of alpha, led by bob)
      chart.addTeam(makeTeam({
        tid: 'tid-gamma-001',
        slug: 'gamma-team',
        leaderAid: 'aid-bob-001',
        parentTid: 'tid-root-001',
        depth: 1,
      }));
      chart.addAgent(makeAgent({
        aid: 'aid-grace-001',
        name: 'Grace',
        teamSlug: 'gamma-team',
      }));
    }

    it('same agent -> YES', () => {
      seedAuthHierarchy();
      expect(chart.isAuthorized('aid-alice-001', 'aid-alice-001')).toBe(true);
    });

    it('same team -> YES', () => {
      seedAuthHierarchy();
      // carol and dave are both in alpha-team
      expect(chart.isAuthorized('aid-carol-001', 'aid-dave-001')).toBe(true);
      expect(chart.isAuthorized('aid-dave-001', 'aid-carol-001')).toBe(true);
    });

    it('lead -> member (downward direct) -> YES', () => {
      seedAuthHierarchy();
      // alice leads alpha-team, dave is in alpha-team
      expect(chart.isAuthorized('aid-alice-001', 'aid-dave-001')).toBe(true);
      expect(chart.isAuthorized('aid-alice-001', 'aid-carol-001')).toBe(true);
    });

    it('lead -> deep descendant (downward transitive) -> YES', () => {
      seedAuthHierarchy();
      // alice leads alpha-team -> beta-team is child -> eve is in beta-team
      expect(chart.isAuthorized('aid-alice-001', 'aid-eve-001')).toBe(true);
      expect(chart.isAuthorized('aid-alice-001', 'aid-frank-001')).toBe(true);
    });

    it('member -> team lead (upward one level) -> YES', () => {
      seedAuthHierarchy();
      // dave is in alpha-team, alice leads alpha-team
      expect(chart.isAuthorized('aid-dave-001', 'aid-alice-001')).toBe(true);
      // eve is in beta-team, carol leads beta-team
      expect(chart.isAuthorized('aid-eve-001', 'aid-carol-001')).toBe(true);
    });

    it('cross-branch (alpha member <-> gamma member) -> NO', () => {
      seedAuthHierarchy();
      // dave is in alpha-team, grace is in gamma-team (sibling branches)
      expect(chart.isAuthorized('aid-dave-001', 'aid-grace-001')).toBe(false);
      expect(chart.isAuthorized('aid-grace-001', 'aid-dave-001')).toBe(false);
    });

    it('cross-branch (beta member <-> gamma member) -> NO', () => {
      seedAuthHierarchy();
      // eve is in beta-team (under alpha), grace is in gamma-team
      expect(chart.isAuthorized('aid-eve-001', 'aid-grace-001')).toBe(false);
      expect(chart.isAuthorized('aid-grace-001', 'aid-eve-001')).toBe(false);
    });

    it('upward beyond one level -> NO', () => {
      seedAuthHierarchy();
      // eve is in beta-team. alice leads alpha-team (grandparent lead).
      // eve can reach carol (her lead) but NOT alice (two levels up).
      expect(chart.isAuthorized('aid-eve-001', 'aid-alice-001')).toBe(false);
    });

    it('member -> non-lead in parent team -> NO', () => {
      seedAuthHierarchy();
      // eve is in beta-team. dave is in alpha-team but is NOT the lead of beta.
      expect(chart.isAuthorized('aid-eve-001', 'aid-dave-001')).toBe(false);
    });

    it('unknown source -> NO', () => {
      seedAuthHierarchy();
      expect(chart.isAuthorized('aid-unknown-001', 'aid-alice-001')).toBe(false);
    });

    it('unknown target -> NO', () => {
      seedAuthHierarchy();
      expect(chart.isAuthorized('aid-alice-001', 'aid-unknown-001')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Topology
  // -----------------------------------------------------------------------

  describe('getTopology', () => {
    function seedForTopology(): void {
      bootstrapRootTeam(chart);

      chart.addAgent(makeAgent({ aid: 'aid-alice-001', teamSlug: 'root-team', leadsTeam: 'alpha-team' }));
      chart.addTeam(makeTeam({
        tid: 'tid-alpha-001',
        slug: 'alpha-team',
        leaderAid: 'aid-alice-001',
        parentTid: 'tid-root-001',
        depth: 1,
      }));

      chart.addAgent(makeAgent({ aid: 'aid-carol-001', name: 'Carol', teamSlug: 'alpha-team', leadsTeam: 'beta-team' }));
      chart.addTeam(makeTeam({
        tid: 'tid-beta-001',
        slug: 'beta-team',
        leaderAid: 'aid-carol-001',
        parentTid: 'tid-alpha-001',
        depth: 2,
      }));

      chart.addAgent(makeAgent({ aid: 'aid-eve-001', name: 'Eve', teamSlug: 'beta-team', leadsTeam: 'delta-team' }));
      chart.addTeam(makeTeam({
        tid: 'tid-delta-001',
        slug: 'delta-team',
        leaderAid: 'aid-eve-001',
        parentTid: 'tid-beta-001',
        depth: 3,
      }));

      chart.addAgent(makeAgent({ aid: 'aid-frank-001', name: 'Frank', teamSlug: 'delta-team' }));
    }

    it('returns full tree with no depth limit', () => {
      seedForTopology();
      const topo = chart.getTopology();

      expect(topo).toHaveLength(1);
      expect(topo[0].slug).toBe('root-team');
      expect(topo[0].children).toHaveLength(1);
      expect(topo[0].children[0].slug).toBe('alpha-team');
      expect(topo[0].children[0].children).toHaveLength(1);
      expect(topo[0].children[0].children[0].slug).toBe('beta-team');
      expect(topo[0].children[0].children[0].children).toHaveLength(1);
      expect(topo[0].children[0].children[0].children[0].slug).toBe('delta-team');
    });

    it('limits depth when specified', () => {
      seedForTopology();

      // depth=2: root + alpha (children of root at depth 0 and 1)
      const topo = chart.getTopology(2);

      expect(topo).toHaveLength(1);
      expect(topo[0].slug).toBe('root-team');
      expect(topo[0].children).toHaveLength(1);
      expect(topo[0].children[0].slug).toBe('alpha-team');
      // alpha's children should NOT be included (depth 2 = indices 0 and 1)
      expect(topo[0].children[0].children).toHaveLength(0);
    });

    it('depth=1 returns only root', () => {
      seedForTopology();
      const topo = chart.getTopology(1);

      expect(topo).toHaveLength(1);
      expect(topo[0].slug).toBe('root-team');
      expect(topo[0].children).toHaveLength(0);
    });

    it('includes agents in topology nodes', () => {
      seedForTopology();
      const topo = chart.getTopology();

      // root-team has: main-001, alice-001
      expect(topo[0].agents.length).toBe(2);
    });

    it('returns empty array when no teams exist', () => {
      expect(chart.getTopology()).toEqual([]);
    });

    it('includes leaderAid and health in nodes', () => {
      seedForTopology();
      const topo = chart.getTopology();

      expect(topo[0].leaderAid).toBe('aid-main-001');
      expect(topo[0].health).toBe(ContainerHealth.Running);
    });
  });
});
