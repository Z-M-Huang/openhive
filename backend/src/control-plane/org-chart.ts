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

import { AgentStatus } from '../domain/enums.js';

/**
 * In-memory org chart — tracks all agents and teams in the hierarchy.
 *
 * Five Maps for O(1) lookups. Flat team model — no team leads.
 */
export class OrgChartImpl implements OrgChart {
  private readonly teamsByTid = new Map<string, OrgChartTeam>();
  private readonly teamsBySlug = new Map<string, OrgChartTeam>();
  private readonly agentsByAid = new Map<string, OrgChartAgent>();
  private readonly childrenByTid = new Map<string, Set<string>>();
  private readonly agentsByTeam = new Map<string, Set<string>>();

  addTeam(team: OrgChartTeam): void {
    if (this.teamsByTid.has(team.tid)) {
      throw new ConflictError(`Team with TID '${team.tid}' already exists`);
    }
    if (this.teamsBySlug.has(team.slug)) {
      throw new ConflictError(`Team with slug '${team.slug}' already exists`);
    }

    // For non-root teams, verify parent exists
    if (team.parentTid) {
      const parent = this.teamsByTid.get(team.parentTid);
      if (!parent) {
        throw new ValidationError(
          `Parent team '${team.parentTid}' not found`
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
  }

  updateTeam(team: OrgChartTeam): void {
    const existing = this.teamsByTid.get(team.tid);
    if (!existing) {
      throw new NotFoundError(`Team '${team.tid}' not found for update`);
    }

    // Update the team data
    this.teamsByTid.set(team.tid, team);
    this.teamsBySlug.set(team.slug, team);
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
  }

  updateAgent(agent: OrgChartAgent): void {
    const existing = this.agentsByAid.get(agent.aid);
    if (!existing) {
      throw new NotFoundError(`Agent '${agent.aid}' not found for update`);
    }

    // If team changed, update team membership
    if (existing.teamSlug !== agent.teamSlug) {
      const oldTeamAgents = this.agentsByTeam.get(existing.teamSlug);
      if (oldTeamAgents) {
        oldTeamAgents.delete(agent.aid);
      }

      let newTeamAgents = this.agentsByTeam.get(agent.teamSlug);
      if (!newTeamAgents) {
        newTeamAgents = new Set();
        this.agentsByTeam.set(agent.teamSlug, newTeamAgents);
      }
      newTeamAgents.add(agent.aid);
    }

    // Update the agent
    this.agentsByAid.set(agent.aid, agent);
  }

  updateTeamTid(slug: string, newTid: string): void {
    const team = this.teamsBySlug.get(slug);
    if (!team) {
      throw new NotFoundError(`Team '${slug}' not found`);
    }

    const oldTid = team.tid;
    if (oldTid === newTid) return;

    // 1. Re-key teamsByTid
    this.teamsByTid.delete(oldTid);
    team.tid = newTid;
    this.teamsByTid.set(newTid, team);

    // 2. Move children set from old TID to new TID
    const children = this.childrenByTid.get(oldTid);
    if (children) {
      this.childrenByTid.delete(oldTid);
      this.childrenByTid.set(newTid, children);
    }

    // 3. Update parentTid on all child teams
    for (const childTid of children ?? []) {
      const child = this.teamsByTid.get(childTid);
      if (child) child.parentTid = newTid;
    }

    // 4. Update this team's entry in parent's children set
    if (team.parentTid) {
      const parentChildren = this.childrenByTid.get(team.parentTid);
      if (parentChildren) {
        parentChildren.delete(oldTid);
        parentChildren.add(newTid);
      }
    }
  }

  removeAgent(aid: string): void {
    const agent = this.agentsByAid.get(aid);
    if (!agent) {
      throw new NotFoundError(`Agent '${aid}' not found`);
    }

    // Clear coordinator designation if this agent was the coordinator
    const team = this.teamsBySlug.get(agent.teamSlug);
    if (team && team.coordinatorAid === aid) {
      team.coordinatorAid = undefined;
    }

    this.agentsByAid.delete(aid);

    const teamAgents = this.agentsByTeam.get(agent.teamSlug);
    if (teamAgents) {
      teamAgents.delete(aid);
    }
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

  /**
   * Returns the best dispatch target for a team.
   * If team has a coordinator, always prefers it (unless error/starting).
   * Otherwise prefers idle agents, sorts by AID for deterministic selection.
   * Throws NotFoundError if the team has no agents.
   */
  getDispatchTarget(teamSlug: string): OrgChartAgent {
    const agents = this.getAgentsByTeam(teamSlug);
    if (agents.length === 0) {
      throw new NotFoundError(`No agents found in team '${teamSlug}'`);
    }

    // Coordinator preference: always dispatch to coordinator unless it's in error/starting state
    const team = this.teamsBySlug.get(teamSlug);
    if (team?.coordinatorAid) {
      const coordinator = this.agentsByAid.get(team.coordinatorAid);
      if (coordinator && coordinator.status !== AgentStatus.Error && coordinator.status !== 'starting') {
        return coordinator;
      }
    }

    // Fall back to existing logic: sort by AID, prefer idle
    const sorted = [...agents].sort((a, b) => a.aid.localeCompare(b.aid));
    const idle = sorted.find(a => a.status === AgentStatus.Idle);
    if (idle) return idle;
    return sorted[0];
  }

  isAuthorized(sourceAid: string, targetAid: string): boolean {
    if (sourceAid === targetAid) return true;

    const source = this.agentsByAid.get(sourceAid);
    const target = this.agentsByAid.get(targetAid);
    if (!source || !target) return false;

    // 1. Same team — always authorized
    if (source.teamSlug === target.teamSlug) return true;

    // 2. main_assistant — authorized to all
    if (source.role === 'main_assistant') return true;

    // 3. Any agent — authorized to 'main' team
    if (target.teamSlug === 'main') return true;

    // 4. Otherwise — denied
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
      health: team.health,
      agents,
      children,
    };
  }
}
