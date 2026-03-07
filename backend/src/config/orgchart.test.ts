/**
 * Tests for backend/src/config/orgchart.ts
 *
 * Covers OrgChartService:
 *   - rebuildFromConfig builds hierarchy from master + team configs
 *   - Detects duplicate AIDs across teams
 *   - Detects circular parent chains
 *   - getAgentByAID returns agent or throws NotFoundError
 *   - getTeamForAgent returns team containing agent
 *   - getLeadTeams returns team slugs led by an agent
 *   - getSubordinates returns agents in teams led by given agent
 *   - getSupervisor returns team leader for an agent
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OrgChartService, newOrgChart } from './orgchart.js';
import type { MasterConfig, Team, Agent } from '../domain/types.js';
import { NotFoundError, ConflictError, ValidationError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal MasterConfig with no agents and a named assistant. */
function makeMaster(overrides: Partial<MasterConfig> = {}): MasterConfig {
  return {
    system: {
      listen_address: ':8080',
      data_dir: 'data',
      workspace_root: '.run/teams',
      log_level: 'info',
      log_archive: { enabled: false, max_entries: 0, keep_copies: 0, archive_dir: '' },
      max_message_length: 4096,
      default_idle_timeout: '30m',
      event_bus_workers: 4,
      portal_ws_max_connections: 100,
      message_archive: { enabled: false, max_entries: 0, keep_copies: 0, archive_dir: '' },
    },
    assistant: {
      name: 'Main Assistant',
      aid: 'aid-main-001',
      provider: 'default',
      model_tier: 'sonnet',
      max_turns: 100,
      timeout_minutes: 30,
    },
    channels: {
      discord: { enabled: false },
      whatsapp: { enabled: false },
    },
    ...overrides,
  };
}

/** Creates a minimal Agent object. */
function makeAgent(aid: string, name: string): Agent {
  return { aid, name, provider: 'default', model_tier: 'sonnet' };
}

/** Creates a minimal Team object. */
function makeTeam(slug: string, leaderAID: string, agents: Agent[] = [], parentSlug?: string): Team {
  return {
    tid: `tid-${slug}`,
    slug,
    leader_aid: leaderAID,
    agents,
    ...(parentSlug !== undefined ? { parent_slug: parentSlug } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OrgChartService', () => {
  let svc: OrgChartService;

  beforeEach(() => {
    svc = newOrgChart();
  });

  // -------------------------------------------------------------------------
  // rebuildFromConfig
  // -------------------------------------------------------------------------

  describe('rebuildFromConfig', () => {
    it('builds hierarchy from master + team configs', () => {
      const leadAgent = makeAgent('aid-lead-eng', 'Engineering Lead');
      const devAgent = makeAgent('aid-dev-001', 'Developer');
      const master = makeMaster({ agents: [leadAgent] });
      const teams: Record<string, Team> = {
        engineering: makeTeam('engineering', 'aid-lead-eng', [devAgent]),
      };

      svc.rebuildFromConfig(master, teams);

      // Main assistant is registered
      const mainAsst = svc.getAgentByAID('aid-main-001');
      expect(mainAsst.name).toBe('Main Assistant');

      // Top-level lead agent from master.agents is registered
      const lead = svc.getAgentByAID('aid-lead-eng');
      expect(lead.name).toBe('Engineering Lead');

      // Team is registered
      const engTeam = svc.getTeamBySlug('engineering');
      expect(engTeam.slug).toBe('engineering');
      expect(engTeam.leader_aid).toBe('aid-lead-eng');

      // Team agent is registered
      const dev = svc.getAgentByAID('aid-dev-001');
      expect(dev.name).toBe('Developer');
    });

    it('sets the slug on each team from the map key', () => {
      const master = makeMaster();
      const leadAgent = makeAgent('aid-lead-ops', 'Ops Lead');
      // Simulate a team loaded from file without slug set (slug comes from map key)
      const rawTeam: Team = {
        tid: 'tid-ops',
        slug: '',  // will be overwritten by rebuild
        leader_aid: 'aid-lead-ops',
        agents: [leadAgent],
      };
      const teams: Record<string, Team> = { ops: rawTeam };

      svc.rebuildFromConfig(master, teams);

      // Team should have slug set to the map key
      const team = svc.getTeamBySlug('ops');
      expect(team.slug).toBe('ops');
    });

    it('registers multiple teams and their agents', () => {
      const lead1 = makeAgent('aid-lead-a', 'Lead A');
      const lead2 = makeAgent('aid-lead-b', 'Lead B');
      const agent1 = makeAgent('aid-agent-a1', 'Agent A1');
      const agent2 = makeAgent('aid-agent-b1', 'Agent B1');
      const master = makeMaster({ agents: [lead1, lead2] });
      const teams: Record<string, Team> = {
        'team-a': makeTeam('team-a', 'aid-lead-a', [agent1]),
        'team-b': makeTeam('team-b', 'aid-lead-b', [agent2]),
      };

      svc.rebuildFromConfig(master, teams);

      expect(svc.getTeamBySlug('team-a').leader_aid).toBe('aid-lead-a');
      expect(svc.getTeamBySlug('team-b').leader_aid).toBe('aid-lead-b');
      expect(svc.getAgentByAID('aid-agent-a1').name).toBe('Agent A1');
      expect(svc.getAgentByAID('aid-agent-b1').name).toBe('Agent B1');
    });

    it('resets state on each rebuild call', () => {
      const lead = makeAgent('aid-lead-x', 'Lead X');
      const master = makeMaster({ agents: [lead] });
      const teams: Record<string, Team> = {
        'team-x': makeTeam('team-x', 'aid-lead-x', []),
      };

      svc.rebuildFromConfig(master, teams);
      expect(() => svc.getTeamBySlug('team-x')).not.toThrow();

      // Rebuild with no teams — old data should be gone
      svc.rebuildFromConfig(makeMaster(), {});
      expect(() => svc.getTeamBySlug('team-x')).toThrow(NotFoundError);
      expect(() => svc.getAgentByAID('aid-lead-x')).toThrow(NotFoundError);
    });

    it('handles master config with no agents array', () => {
      const master = makeMaster(); // agents: undefined
      expect(() => svc.rebuildFromConfig(master, {})).not.toThrow();
      // Only main assistant registered
      expect(svc.getAgentByAID('aid-main-001').name).toBe('Main Assistant');
    });

    it('handles master assistant with empty AID gracefully', () => {
      const master = makeMaster();
      master.assistant.aid = '';
      expect(() => svc.rebuildFromConfig(master, {})).not.toThrow();
      expect(() => svc.getAgentByAID('')).toThrow(NotFoundError);
    });

    it('builds leadTeams from leader_aid references', () => {
      const lead = makeAgent('aid-lead-eng', 'Eng Lead');
      const master = makeMaster({ agents: [lead] });
      const teams: Record<string, Team> = {
        frontend: makeTeam('frontend', 'aid-lead-eng', []),
        backend: makeTeam('backend', 'aid-lead-eng', []),
      };

      svc.rebuildFromConfig(master, teams);

      const ledTeams = svc.getLeadTeams('aid-lead-eng');
      expect(ledTeams).toHaveLength(2);
      expect(ledTeams).toContain('frontend');
      expect(ledTeams).toContain('backend');
    });
  });

  // -------------------------------------------------------------------------
  // Duplicate AID detection
  // -------------------------------------------------------------------------

  describe('duplicate AID detection', () => {
    it('throws ConflictError when a team agent duplicates the main assistant AID', () => {
      const master = makeMaster(); // assistant AID = aid-main-001
      const dupAgent = makeAgent('aid-main-001', 'Dup');
      const teams: Record<string, Team> = {
        team1: makeTeam('team1', 'aid-ext-lead', [dupAgent]),
      };

      expect(() => svc.rebuildFromConfig(master, teams)).toThrow(ConflictError);
    });

    it('throws ConflictError when two teams share the same agent AID', () => {
      const sharedAID = 'aid-shared-001';
      const agent1 = makeAgent(sharedAID, 'Agent in Team 1');
      const agent2 = makeAgent(sharedAID, 'Agent in Team 2');
      const lead1 = makeAgent('aid-lead-1', 'Lead 1');
      const lead2 = makeAgent('aid-lead-2', 'Lead 2');
      const master = makeMaster({ agents: [lead1, lead2] });
      const teams: Record<string, Team> = {
        team1: makeTeam('team1', 'aid-lead-1', [agent1]),
        team2: makeTeam('team2', 'aid-lead-2', [agent2]),
      };

      expect(() => svc.rebuildFromConfig(master, teams)).toThrow(ConflictError);
    });

    it('throws ConflictError when a team agent duplicates a master.agents AID', () => {
      const topLevelAgent = makeAgent('aid-top-level', 'Top Level');
      const dupAgent = makeAgent('aid-top-level', 'Duplicate');
      const master = makeMaster({ agents: [topLevelAgent] });
      const teams: Record<string, Team> = {
        team1: makeTeam('team1', 'aid-top-level', [dupAgent]),
      };

      expect(() => svc.rebuildFromConfig(master, teams)).toThrow(ConflictError);
    });

    it('throws ConflictError when master.agents contains duplicate AIDs', () => {
      const a1 = makeAgent('aid-dup', 'First');
      const a2 = makeAgent('aid-dup', 'Second');
      const master = makeMaster({ agents: [a1, a2] });

      expect(() => svc.rebuildFromConfig(master, {})).toThrow(ConflictError);
    });

    it('ConflictError message includes the duplicate AID', () => {
      const master = makeMaster(); // assistant AID = aid-main-001
      const dupAgent = makeAgent('aid-main-001', 'Dup');
      const teams: Record<string, Team> = {
        team1: makeTeam('team1', 'aid-ext-lead', [dupAgent]),
      };

      let caught: unknown;
      try {
        svc.rebuildFromConfig(master, teams);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConflictError);
      expect((caught as ConflictError).message).toContain('aid-main-001');
    });
  });

  // -------------------------------------------------------------------------
  // Circular parent chain detection
  // -------------------------------------------------------------------------

  describe('circular parent chain detection', () => {
    it('throws ValidationError when team is its own parent', () => {
      const master = makeMaster();
      const teams: Record<string, Team> = {
        // team-a points to itself as parent
        'team-a': makeTeam('team-a', 'aid-lead-a', [], 'team-a'),
      };

      expect(() => svc.rebuildFromConfig(master, teams)).toThrow(ValidationError);
    });

    it('throws ValidationError for a 2-team cycle (A→B→A)', () => {
      const master = makeMaster();
      const teams: Record<string, Team> = {
        'team-a': makeTeam('team-a', 'aid-lead-a', [], 'team-b'),
        'team-b': makeTeam('team-b', 'aid-lead-b', [], 'team-a'),
      };

      expect(() => svc.rebuildFromConfig(master, teams)).toThrow(ValidationError);
    });

    it('throws ValidationError for a 3-team cycle (A→B→C→A)', () => {
      const master = makeMaster();
      const teams: Record<string, Team> = {
        'team-a': makeTeam('team-a', 'aid-lead-a', [], 'team-c'),
        'team-b': makeTeam('team-b', 'aid-lead-b', [], 'team-a'),
        'team-c': makeTeam('team-c', 'aid-lead-c', [], 'team-b'),
      };

      expect(() => svc.rebuildFromConfig(master, teams)).toThrow(ValidationError);
    });

    it('does NOT throw for valid parent chains', () => {
      const master = makeMaster();
      const teams: Record<string, Team> = {
        root: makeTeam('root', 'aid-lead-root', []),
        child: makeTeam('child', 'aid-lead-child', [], 'root'),
        grandchild: makeTeam('grandchild', 'aid-lead-grand', [], 'child'),
      };

      expect(() => svc.rebuildFromConfig(master, teams)).not.toThrow();
    });

    it('does NOT throw when parent_slug points to a non-existent team', () => {
      // Missing parent is tolerated — the traversal simply stops.
      const master = makeMaster();
      const teams: Record<string, Team> = {
        child: makeTeam('child', 'aid-lead-child', [], 'missing-parent'),
      };

      expect(() => svc.rebuildFromConfig(master, teams)).not.toThrow();
    });

    it('ValidationError message includes the slug involved', () => {
      const master = makeMaster();
      const teams: Record<string, Team> = {
        'team-a': makeTeam('team-a', 'aid-lead-a', [], 'team-a'),
      };

      let caught: unknown;
      try {
        svc.rebuildFromConfig(master, teams);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ValidationError);
      expect((caught as ValidationError).message).toContain('team-a');
    });
  });

  // -------------------------------------------------------------------------
  // getAgentByAID
  // -------------------------------------------------------------------------

  describe('getAgentByAID', () => {
    beforeEach(() => {
      const lead = makeAgent('aid-lead-001', 'Lead');
      const member = makeAgent('aid-member-001', 'Member');
      const master = makeMaster({ agents: [lead] });
      const teams: Record<string, Team> = {
        alpha: makeTeam('alpha', 'aid-lead-001', [member]),
      };
      svc.rebuildFromConfig(master, teams);
    });

    it('returns the main assistant by AID', () => {
      const agent = svc.getAgentByAID('aid-main-001');
      expect(agent.aid).toBe('aid-main-001');
      expect(agent.name).toBe('Main Assistant');
    });

    it('returns a top-level lead agent by AID', () => {
      const agent = svc.getAgentByAID('aid-lead-001');
      expect(agent.name).toBe('Lead');
    });

    it('returns a team member agent by AID', () => {
      const agent = svc.getAgentByAID('aid-member-001');
      expect(agent.name).toBe('Member');
    });

    it('throws NotFoundError for unknown AID', () => {
      expect(() => svc.getAgentByAID('aid-unknown')).toThrow(NotFoundError);
    });

    it('NotFoundError message includes the AID', () => {
      let caught: unknown;
      try {
        svc.getAgentByAID('aid-missing-xyz');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(NotFoundError);
      expect((caught as NotFoundError).message).toContain('aid-missing-xyz');
    });
  });

  // -------------------------------------------------------------------------
  // getTeamBySlug
  // -------------------------------------------------------------------------

  describe('getTeamBySlug', () => {
    beforeEach(() => {
      const master = makeMaster();
      const teams: Record<string, Team> = {
        engineering: makeTeam('engineering', 'aid-lead-eng', []),
      };
      svc.rebuildFromConfig(master, teams);
    });

    it('returns team by slug', () => {
      const team = svc.getTeamBySlug('engineering');
      expect(team.slug).toBe('engineering');
    });

    it('throws NotFoundError for unknown slug', () => {
      expect(() => svc.getTeamBySlug('nonexistent')).toThrow(NotFoundError);
    });

    it('NotFoundError message includes the slug', () => {
      let caught: unknown;
      try {
        svc.getTeamBySlug('no-such-team');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(NotFoundError);
      expect((caught as NotFoundError).message).toContain('no-such-team');
    });
  });

  // -------------------------------------------------------------------------
  // getTeamForAgent
  // -------------------------------------------------------------------------

  describe('getTeamForAgent', () => {
    beforeEach(() => {
      const leadAgent = makeAgent('aid-lead-eng', 'Eng Lead');
      const devAgent = makeAgent('aid-dev-001', 'Developer');
      const master = makeMaster({ agents: [leadAgent] });
      const teams: Record<string, Team> = {
        engineering: makeTeam('engineering', 'aid-lead-eng', [devAgent]),
      };
      svc.rebuildFromConfig(master, teams);
    });

    it('returns the team a member agent belongs to', () => {
      const team = svc.getTeamForAgent('aid-dev-001');
      expect(team.slug).toBe('engineering');
    });

    it('returns main team for top-level agent in master.agents', () => {
      // aid-lead-eng is a top-level agent in master.agents. These agents
      // run in the main container, so agentTeam maps them to 'main'.
      const team = svc.getTeamForAgent('aid-lead-eng');
      expect(team.slug).toBe('main');
    });

    it('returns main team for main assistant AID', () => {
      // Main assistant runs in the main container.
      const team = svc.getTeamForAgent('aid-main-001');
      expect(team.slug).toBe('main');
    });

    it('throws NotFoundError for completely unknown AID', () => {
      expect(() => svc.getTeamForAgent('aid-nobody')).toThrow(NotFoundError);
    });
  });

  // -------------------------------------------------------------------------
  // getLeadTeams
  // -------------------------------------------------------------------------

  describe('getLeadTeams', () => {
    beforeEach(() => {
      const lead = makeAgent('aid-lead-multi', 'Multi-Team Lead');
      const master = makeMaster({ agents: [lead] });
      const teams: Record<string, Team> = {
        frontend: makeTeam('frontend', 'aid-lead-multi', []),
        backend: makeTeam('backend', 'aid-lead-multi', []),
      };
      svc.rebuildFromConfig(master, teams);
    });

    it('returns all team slugs led by an agent', () => {
      const ledTeams = svc.getLeadTeams('aid-lead-multi');
      expect(ledTeams).toHaveLength(2);
      expect(ledTeams).toContain('frontend');
      expect(ledTeams).toContain('backend');
    });

    it('returns empty array for an agent that leads no teams', () => {
      const result = svc.getLeadTeams('aid-main-001');
      expect(result).toEqual([]);
    });

    it('returns empty array for unknown AID', () => {
      const result = svc.getLeadTeams('aid-does-not-exist');
      expect(result).toEqual([]);
    });

    it('returns a copy (mutations do not affect internal state)', () => {
      const result = svc.getLeadTeams('aid-lead-multi');
      result.push('injected-team');
      // Internal state should be unaffected
      expect(svc.getLeadTeams('aid-lead-multi')).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // getSubordinates
  // -------------------------------------------------------------------------

  describe('getSubordinates', () => {
    beforeEach(() => {
      const lead = makeAgent('aid-lead-full', 'Full Lead');
      const agentA = makeAgent('aid-agent-a', 'Agent A');
      const agentB = makeAgent('aid-agent-b', 'Agent B');
      const agentC = makeAgent('aid-agent-c', 'Agent C');
      const master = makeMaster({ agents: [lead] });
      const teams: Record<string, Team> = {
        'team-alpha': makeTeam('team-alpha', 'aid-lead-full', [agentA, agentB]),
        'team-beta': makeTeam('team-beta', 'aid-lead-full', [agentC]),
      };
      svc.rebuildFromConfig(master, teams);
    });

    it('returns all agents in teams led by the given agent', () => {
      const subs = svc.getSubordinates('aid-lead-full');
      expect(subs).toHaveLength(3);
      const aids = subs.map(a => a.aid);
      expect(aids).toContain('aid-agent-a');
      expect(aids).toContain('aid-agent-b');
      expect(aids).toContain('aid-agent-c');
    });

    it('returns empty array for an agent that leads no teams', () => {
      const result = svc.getSubordinates('aid-main-001');
      expect(result).toEqual([]);
    });

    it('returns empty array for unknown AID', () => {
      const result = svc.getSubordinates('aid-nobody');
      expect(result).toEqual([]);
    });

    it('returns empty array for lead whose teams have no agents', () => {
      const emptyLead = makeAgent('aid-empty-lead', 'Empty Lead');
      const master = makeMaster({ agents: [emptyLead] });
      const teams: Record<string, Team> = {
        empty: makeTeam('empty', 'aid-empty-lead', []),
      };
      svc.rebuildFromConfig(master, teams);
      expect(svc.getSubordinates('aid-empty-lead')).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getSupervisor
  // -------------------------------------------------------------------------

  describe('getSupervisor', () => {
    beforeEach(() => {
      const lead = makeAgent('aid-lead-sup', 'Supervisor');
      const member1 = makeAgent('aid-member-sup1', 'Member 1');
      const member2 = makeAgent('aid-member-sup2', 'Member 2');
      const master = makeMaster({ agents: [lead] });
      const teams: Record<string, Team> = {
        'team-sup': makeTeam('team-sup', 'aid-lead-sup', [member1, member2]),
      };
      svc.rebuildFromConfig(master, teams);
    });

    it('returns the team leader for a member agent', () => {
      const supervisor = svc.getSupervisor('aid-member-sup1');
      expect(supervisor).not.toBeNull();
      expect(supervisor!.aid).toBe('aid-lead-sup');
      expect(supervisor!.name).toBe('Supervisor');
    });

    it('returns the same team leader for all members of the same team', () => {
      const sup1 = svc.getSupervisor('aid-member-sup1');
      const sup2 = svc.getSupervisor('aid-member-sup2');
      expect(sup1!.aid).toBe(sup2!.aid);
    });

    it('returns null for the main assistant (self-supervised)', () => {
      // Main assistant is the leader of the synthetic 'main' team.
      // An agent cannot be its own supervisor.
      const result = svc.getSupervisor('aid-main-001');
      expect(result).toBeNull();
    });

    it('returns main assistant as supervisor for top-level agents', () => {
      // aid-lead-sup is in master.agents, runs in the main container.
      // The main assistant is the leader of the 'main' team.
      const result = svc.getSupervisor('aid-lead-sup');
      expect(result).not.toBeNull();
      expect(result!.aid).toBe('aid-main-001');
    });

    it('returns null for unknown AID', () => {
      const result = svc.getSupervisor('aid-unknown-xyz');
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // getOrgChart
  // -------------------------------------------------------------------------

  describe('getOrgChart', () => {
    it('returns all teams as a plain Record keyed by slug', () => {
      const master = makeMaster();
      const teams: Record<string, Team> = {
        alpha: makeTeam('alpha', 'aid-lead-a', []),
        beta: makeTeam('beta', 'aid-lead-b', []),
      };
      svc.rebuildFromConfig(master, teams);

      const chart = svc.getOrgChart();
      // Only config teams — synthetic 'main' is excluded from getOrgChart.
      expect(Object.keys(chart)).toHaveLength(2);
      expect(chart['alpha']).toBeDefined();
      expect(chart['beta']).toBeDefined();
      expect(chart['main']).toBeUndefined();
    });

    it('returns empty object when no config teams exist', () => {
      svc.rebuildFromConfig(makeMaster(), {});
      // Synthetic 'main' exists internally but is excluded from getOrgChart.
      expect(svc.getOrgChart()).toEqual({});
    });

    it('returns a copy (mutations do not affect internal state)', () => {
      const master = makeMaster();
      const teams: Record<string, Team> = {
        alpha: makeTeam('alpha', 'aid-lead-a', []),
      };
      svc.rebuildFromConfig(master, teams);

      const chart = svc.getOrgChart();
      // Deleting from the copy should not affect the service's internal map
      delete chart['alpha'];
      expect(svc.getTeamBySlug('alpha')).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // newOrgChart factory
  // -------------------------------------------------------------------------

  describe('newOrgChart', () => {
    it('creates a new empty OrgChartService', () => {
      const fresh = newOrgChart();
      expect(() => fresh.getAgentByAID('any')).toThrow(NotFoundError);
      expect(() => fresh.getTeamBySlug('any')).toThrow(NotFoundError);
      expect(fresh.getOrgChart()).toEqual({});
    });
  });
});
