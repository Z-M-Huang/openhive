import type {
  OrgChart,
  OrgChartAgent,
  OrgChartTeam,
  TopologyNode,
} from '../domain/index.js';

import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../domain/index.js';

/**
 * In-memory org chart — tracks all agents and teams in the hierarchy.
 *
 * Six Maps for O(1) lookups. INV-01 enforced in addTeam(): leader must
 * exist in the parent team, not in the team being added.
 */
export class OrgChartImpl implements OrgChart {
  // INV-01: Team lead always in parent container.

  private readonly teamsByTid = new Map<string, OrgChartTeam>();
  private readonly teamsBySlug = new Map<string, OrgChartTeam>();
  private readonly agentsByAid = new Map<string, OrgChartAgent>();
  private readonly childrenByTid = new Map<string, Set<string>>();
  private readonly agentsByTeam = new Map<string, Set<string>>();
  private readonly leadToTeam = new Map<string, string>();

  addTeam(team: OrgChartTeam): void {
    if (this.teamsByTid.has(team.tid)) {
      throw new ConflictError(`Team with TID '${team.tid}' already exists`);
    }
    if (this.teamsBySlug.has(team.slug)) {
      throw new ConflictError(`Team with slug '${team.slug}' already exists`);
    }

    // INV-01: leader must already exist as an agent in the parent team
    const leader = this.agentsByAid.get(team.leaderAid);
    if (!leader) {
      throw new ValidationError(
        `Leader '${team.leaderAid}' not found in org chart (INV-01)`
      );
    }

    // For root teams (no parent), the leader just needs to exist.
    // For non-root teams, verify the leader is in the parent team.
    if (team.parentTid) {
      const parent = this.teamsByTid.get(team.parentTid);
      if (!parent) {
        throw new ValidationError(
          `Parent team '${team.parentTid}' not found`
        );
      }
      const parentAgents = this.agentsByTeam.get(parent.slug);
      if (!parentAgents || !parentAgents.has(team.leaderAid)) {
        throw new ValidationError(
          `Leader '${team.leaderAid}' is not in parent team '${parent.slug}' (INV-01)`
        );
      }
    }

    this.teamsByTid.set(team.tid, team);
    this.teamsBySlug.set(team.slug, team);

    // Register parent->child relationship
    if (team.parentTid) {
      let children = this.childrenByTid.get(team.parentTid);
      if (!children) {
        children = new Set();
        this.childrenByTid.set(team.parentTid, children);
      }
      children.add(team.tid);
    }

    // Initialize agent set for this team
    if (!this.agentsByTeam.has(team.slug)) {
      this.agentsByTeam.set(team.slug, new Set());
    }

    // Update lead->team mapping
    this.leadToTeam.set(team.leaderAid, team.tid);
  }

  removeTeam(tid: string): void {
    const team = this.teamsByTid.get(tid);
    if (!team) {
      throw new NotFoundError(`Team '${tid}' not found`);
    }

    const children = this.childrenByTid.get(tid);
    if (children && children.size > 0) {
      throw new ValidationError(
        `Cannot remove team '${tid}': still has ${children.size} child team(s)`
      );
    }

    // Remove all agents belonging to this team
    const agentAids = this.agentsByTeam.get(team.slug);
    if (agentAids) {
      for (const aid of agentAids) {
        this.agentsByAid.delete(aid);
        // Clean up lead->team if this agent leads another team
        this.leadToTeam.delete(aid);
      }
      this.agentsByTeam.delete(team.slug);
    }

    // Remove from parent's children set
    if (team.parentTid) {
      const parentChildren = this.childrenByTid.get(team.parentTid);
      if (parentChildren) {
        parentChildren.delete(tid);
      }
    }

    // Clean up lead->team mapping for this team's leader
    // (leader is in parent team, so the agent itself stays — just the mapping goes)
    if (this.leadToTeam.get(team.leaderAid) === tid) {
      this.leadToTeam.delete(team.leaderAid);
    }

    // Remove children set for this team
    this.childrenByTid.delete(tid);

    this.teamsByTid.delete(tid);
    this.teamsBySlug.delete(team.slug);
  }

  getTeam(tid: string): OrgChartTeam | undefined {
    return this.teamsByTid.get(tid);
  }

  getTeamBySlug(slug: string): OrgChartTeam | undefined {
    return this.teamsBySlug.get(slug);
  }

  listTeams(): OrgChartTeam[] {
    return [...this.teamsByTid.values()];
  }

  getChildren(tid: string): OrgChartTeam[] {
    const childTids = this.childrenByTid.get(tid);
    if (!childTids) return [];
    const result: OrgChartTeam[] = [];
    for (const childTid of childTids) {
      const team = this.teamsByTid.get(childTid);
      if (team) result.push(team);
    }
    return result;
  }

  getParent(tid: string): OrgChartTeam | undefined {
    const team = this.teamsByTid.get(tid);
    if (!team || !team.parentTid) return undefined;
    return this.teamsByTid.get(team.parentTid);
  }

  addAgent(agent: OrgChartAgent): void {
    if (this.agentsByAid.has(agent.aid)) {
      throw new ConflictError(`Agent with AID '${agent.aid}' already exists`);
    }

    if (!this.teamsBySlug.has(agent.teamSlug)) {
      throw new NotFoundError(
        `Team '${agent.teamSlug}' not found in org chart`
      );
    }

    this.agentsByAid.set(agent.aid, agent);

    let teamAgents = this.agentsByTeam.get(agent.teamSlug);
    if (!teamAgents) {
      teamAgents = new Set();
      this.agentsByTeam.set(agent.teamSlug, teamAgents);
    }
    teamAgents.add(agent.aid);

    if (agent.leadsTeam) {
      const ledTeam = this.teamsBySlug.get(agent.leadsTeam);
      if (ledTeam) {
        this.leadToTeam.set(agent.aid, ledTeam.tid);
      }
    }
  }

  removeAgent(aid: string): void {
    const agent = this.agentsByAid.get(aid);
    if (!agent) {
      throw new NotFoundError(`Agent '${aid}' not found`);
    }

    this.agentsByAid.delete(aid);

    const teamAgents = this.agentsByTeam.get(agent.teamSlug);
    if (teamAgents) {
      teamAgents.delete(aid);
    }

    this.leadToTeam.delete(aid);
  }

  getAgent(aid: string): OrgChartAgent | undefined {
    return this.agentsByAid.get(aid);
  }

  getAgentsByTeam(teamSlug: string): OrgChartAgent[] {
    const aids = this.agentsByTeam.get(teamSlug);
    if (!aids) return [];
    const result: OrgChartAgent[] = [];
    for (const aid of aids) {
      const agent = this.agentsByAid.get(aid);
      if (agent) result.push(agent);
    }
    return result;
  }

  getLeadOf(teamSlug: string): OrgChartAgent | undefined {
    const team = this.teamsBySlug.get(teamSlug);
    if (!team) return undefined;
    return this.agentsByAid.get(team.leaderAid);
  }

  isAuthorized(sourceAid: string, targetAid: string): boolean {
    if (sourceAid === targetAid) return true;

    const source = this.agentsByAid.get(sourceAid);
    const target = this.agentsByAid.get(targetAid);
    if (!source || !target) return false;

    // 1. Same team — always authorized
    if (source.teamSlug === target.teamSlug) return true;

    // 2. Downward — source leads a team that is an ancestor of target's team
    const ledTeamTid = this.leadToTeam.get(sourceAid);
    if (ledTeamTid) {
      const targetTeam = this.teamsBySlug.get(target.teamSlug);
      if (targetTeam && this.isAncestor(ledTeamTid, targetTeam.tid)) {
        return true;
      }
    }

    // 3. Upward one level — target is the lead of source's team
    const sourceTeam = this.teamsBySlug.get(source.teamSlug);
    if (sourceTeam && sourceTeam.leaderAid === targetAid) {
      return true;
    }

    // 4. Cross-branch — denied
    return false;
  }

  getTopology(depth?: number): TopologyNode[] {
    // Find root teams (no parentTid)
    const roots: OrgChartTeam[] = [];
    for (const team of this.teamsByTid.values()) {
      if (!team.parentTid) {
        roots.push(team);
      }
    }

    return roots.map((root) => this.buildTopologyNode(root, depth, 0));
  }

  // ---- Private helpers ----

  /** Check if ancestorTid is an ancestor of descendantTid (or equal). */
  private isAncestor(ancestorTid: string, descendantTid: string): boolean {
    if (ancestorTid === descendantTid) return true;

    const children = this.childrenByTid.get(ancestorTid);
    if (!children) return false;

    for (const childTid of children) {
      if (this.isAncestor(childTid, descendantTid)) return true;
    }
    return false;
  }

  /** Build a TopologyNode recursively. */
  private buildTopologyNode(
    team: OrgChartTeam,
    maxDepth: number | undefined,
    currentDepth: number
  ): TopologyNode {
    const agents = this.getAgentsByTeam(team.slug);

    let children: TopologyNode[] = [];
    if (maxDepth === undefined || currentDepth + 1 < maxDepth) {
      const childTeams = this.getChildren(team.tid);
      children = childTeams.map((child) =>
        this.buildTopologyNode(child, maxDepth, currentDepth + 1)
      );
    }

    return {
      tid: team.tid,
      slug: team.slug,
      leaderAid: team.leaderAid,
      health: team.health,
      agents,
      children,
    };
  }
}
