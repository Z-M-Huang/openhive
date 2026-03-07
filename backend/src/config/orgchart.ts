/**
 * OpenHive Backend - OrgChartService
 *
 * In-memory hierarchy cache built from config files. Tracks teams, agents,
 * team membership, lead assignments, and detects circular parent chains.
 *
 * All methods are synchronous — the cache is rebuilt atomically via
 * rebuildFromConfig() and all subsequent lookups are pure Map reads.
 */

import type { Team, Agent, MasterConfig } from '../domain/types.js';
import type { OrgChart } from '../domain/interfaces.js';
import { NotFoundError, ConflictError, ValidationError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// OrgChartService
// ---------------------------------------------------------------------------

/**
 * Implements the OrgChart interface.
 * Maintains an in-memory index of the agent/team hierarchy
 * built from all config files.
 */
export class OrgChartService implements OrgChart {
  /** teams keyed by slug */
  private teams: Map<string, Team> = new Map();

  /** agents keyed by AID */
  private agents: Map<string, Agent> = new Map();

  /** AID -> team slug (which team this agent is a member of) */
  private agentTeam: Map<string, string> = new Map();

  /** AID -> team slugs that this agent leads */
  private leadTeams: Map<string, string[]> = new Map();

  // -------------------------------------------------------------------------
  // rebuildFromConfig
  // -------------------------------------------------------------------------

  /**
   * Rebuilds the OrgChart cache from master config and team configs.
   *
   * Steps:
   *   1. Reset all internal maps.
   *   2. Register main assistant (if AID is set).
   *   3. Register top-level agents from master.agents (check for duplicate AIDs).
   *   4. Process each team's agents (check duplicates, register leadTeams).
   *   5. Validate for circular parent chains.
   *
   * Throws ConflictError on duplicate AID.
   * Throws ValidationError on circular parent chain.
   */
  rebuildFromConfig(master: MasterConfig, teams: Record<string, Team>): void {
    // Reset maps
    this.teams = new Map();
    this.agents = new Map();
    this.agentTeam = new Map();
    this.leadTeams = new Map();

    // Track all AIDs for uniqueness check: AID -> source (team slug or "master")
    const allAIDs = new Map<string, string>();

    // Register synthetic 'main' team for the main container.
    // The main assistant and top-level team leaders run in the main container.
    // This team has no config file — it's derived from master config.
    this.teams.set('main', {
      tid: '',
      slug: 'main',
      leader_aid: master.assistant.aid,
    });

    // Register main assistant
    if (master.assistant.aid !== '') {
      const assistant: Agent = {
        aid: master.assistant.aid,
        name: master.assistant.name,
        provider: master.assistant.provider,
        model_tier: master.assistant.model_tier,
        max_turns: master.assistant.max_turns,
        timeout_minutes: master.assistant.timeout_minutes,
      };
      this.agents.set(assistant.aid, assistant);
      this.agentTeam.set(assistant.aid, 'main');
      allAIDs.set(assistant.aid, 'master');
    }

    // Register top-level team lead agents from master config.
    // These agents run in the main container, so map them to 'main' in
    // agentTeam so getTeamForAgent can route tasks to them.
    if (master.agents !== undefined) {
      for (const agent of master.agents) {
        if (allAIDs.has(agent.aid)) {
          throw new ConflictError('agent', `duplicate AID ${agent.aid} in master config`);
        }
        this.agents.set(agent.aid, agent);
        this.agentTeam.set(agent.aid, 'main');
        allAIDs.set(agent.aid, 'master');
      }
    }

    // Process teams
    for (const [slug, team] of Object.entries(teams)) {
      // Ensure slug is set on the team
      const teamWithSlug: Team = { ...team, slug };
      this.teams.set(slug, teamWithSlug);

      // Register leader in leadTeams
      if (teamWithSlug.leader_aid !== '') {
        const existing = this.leadTeams.get(teamWithSlug.leader_aid);
        if (existing !== undefined) {
          existing.push(slug);
        } else {
          this.leadTeams.set(teamWithSlug.leader_aid, [slug]);
        }
      }

      // Register team agents
      if (teamWithSlug.agents !== undefined) {
        for (const agent of teamWithSlug.agents) {
          const existingSource = allAIDs.get(agent.aid);
          if (existingSource !== undefined) {
            throw new ConflictError(
              'agent',
              `duplicate AID ${agent.aid} (in ${slug} and ${existingSource})`,
            );
          }
          this.agents.set(agent.aid, agent);
          this.agentTeam.set(agent.aid, slug);
          allAIDs.set(agent.aid, slug);
        }
      }
    }

    // Validate: check for circular parents
    for (const [slug, team] of this.teams.entries()) {
      this.detectCircularParent(slug, team.parent_slug ?? '');
    }
  }

  // -------------------------------------------------------------------------
  // detectCircularParent
  // -------------------------------------------------------------------------

  /**
   * Traverses the parent chain from startSlug to detect cycles.
   *
   * Throws ValidationError if a cycle is detected.
   */
  private detectCircularParent(startSlug: string, parentSlug: string): void {
    const visited = new Set<string>([startSlug]);
    let current = parentSlug;
    while (current !== '') {
      if (visited.has(current)) {
        throw new ValidationError(
          'parent_slug',
          `circular parent chain detected involving ${startSlug}`,
        );
      }
      visited.add(current);
      const team = this.teams.get(current);
      if (team === undefined) {
        break;
      }
      current = team.parent_slug ?? '';
    }
  }

  // -------------------------------------------------------------------------
  // getOrgChart
  // -------------------------------------------------------------------------

  /**
   * Returns all teams in the hierarchy as a plain object keyed by slug.
   *
   * Returns a shallow copy of the internal map.
   */
  getOrgChart(): Record<string, Team> {
    const result: Record<string, Team> = {};
    for (const [k, v] of this.teams.entries()) {
      // Exclude the synthetic 'main' team — it's an internal routing entry.
      if (k === 'main') continue;
      result[k] = v;
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // getAgentByAID
  // -------------------------------------------------------------------------

  /**
   * Returns an agent by its AID.
   *
   * Throws NotFoundError if the agent does not exist.
   */
  getAgentByAID(aid: string): Agent {
    const agent = this.agents.get(aid);
    if (agent === undefined) {
      throw new NotFoundError('agent', aid);
    }
    return agent;
  }

  // -------------------------------------------------------------------------
  // getTeamBySlug
  // -------------------------------------------------------------------------

  /**
   * Returns a team by its slug.
   *
   * Throws NotFoundError if the team does not exist.
   */
  getTeamBySlug(slug: string): Team {
    const team = this.teams.get(slug);
    if (team === undefined) {
      throw new NotFoundError('team', slug);
    }
    return team;
  }

  // -------------------------------------------------------------------------
  // getTeamForAgent
  // -------------------------------------------------------------------------

  /**
   * Returns the team an agent belongs to.
   *
   * Throws NotFoundError if the agent has no team mapping or the team is missing.
   */
  getTeamForAgent(aid: string): Team {
    const slug = this.agentTeam.get(aid);
    if (slug === undefined) {
      throw new NotFoundError('team for agent', aid);
    }
    const team = this.teams.get(slug);
    if (team === undefined) {
      throw new NotFoundError('team', slug);
    }
    return team;
  }

  // -------------------------------------------------------------------------
  // getLeadTeams
  // -------------------------------------------------------------------------

  /**
   * Returns the team slugs that an agent leads.
   *
   * Returns an empty array if the agent does not lead any teams.
   */
  getLeadTeams(aid: string): string[] {
    const slugs = this.leadTeams.get(aid);
    if (slugs === undefined) {
      return [];
    }
    return [...slugs];
  }

  // -------------------------------------------------------------------------
  // getSubordinates
  // -------------------------------------------------------------------------

  /**
   * Returns agents that report to the given agent (i.e. members of all teams
   * the given agent leads).
   *
   * Returns an empty array if the agent leads no teams.
   */
  getSubordinates(aid: string): Agent[] {
    const teamSlugs = this.leadTeams.get(aid);
    if (teamSlugs === undefined) {
      return [];
    }
    const subordinates: Agent[] = [];
    for (const slug of teamSlugs) {
      const team = this.teams.get(slug);
      if (team === undefined || team.agents === undefined) {
        continue;
      }
      subordinates.push(...team.agents);
    }
    return subordinates;
  }

  // -------------------------------------------------------------------------
  // getSupervisor
  // -------------------------------------------------------------------------

  /**
   * Returns the lead agent of the team this agent belongs to.
   *
   * Returns null if:
   *   - the agent has no team membership (top-level or master agent)
   *   - the team's leader_aid does not resolve to a known agent
   */
  getSupervisor(aid: string): Agent | null {
    const slug = this.agentTeam.get(aid);
    if (slug === undefined) {
      return null;
    }
    const team = this.teams.get(slug);
    if (team === undefined) {
      return null;
    }
    // An agent cannot be its own supervisor.
    if (team.leader_aid === aid) {
      return null;
    }
    const leader = this.agents.get(team.leader_aid);
    if (leader === undefined) {
      return null;
    }
    return leader;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a new OrgChartService instance.
 */
export function newOrgChart(): OrgChartService {
  return new OrgChartService();
}
