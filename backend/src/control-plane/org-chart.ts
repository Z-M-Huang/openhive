import type {
  OrgChart,
  OrgChartAgent,
  OrgChartTeam,
  TopologyNode,
} from '../domain/index.js';

/**
 * In-memory org chart — tracks all agents and teams in the hierarchy.
 *
 * // INV-01: Team lead always in parent container.
 *
 * **Data structures:**
 * - `teamsByTid: Map<string, OrgChartTeam>` — constant-time TID lookup
 * - `teamsBySlug: Map<string, OrgChartTeam>` — constant-time slug lookup
 * - `agentsByAid: Map<string, OrgChartAgent>` — constant-time AID lookup
 * - `childrenByTid: Map<string, Set<string>>` — parent TID → child TIDs
 * - `agentsByTeam: Map<string, Set<string>>` — team slug → agent AIDs
 * - `leadToTeam: Map<string, string>` — leader AID → team slug (for teams the agent leads)
 *
 * **INV-01 enforcement:**
 * When {@link addTeam} is called, the leader AID must already exist as an agent
 * in the **parent** team (not in the team being added). The leader runs in the
 * parent container; the child team's container holds only its member agents.
 * {@link isAuthorized} checks that the source agent has visibility into the
 * target agent's team — an agent can see its own team, child teams (downward),
 * and can escalate to its team lead (upward one level).
 *
 * **Authorization scope:**
 * - An agent can interact with agents in its own team.
 * - A team lead can interact with agents in the team it leads and its child teams.
 * - Any agent can escalate to its own team lead (upward visibility).
 * - No cross-branch visibility: agents in sibling teams cannot interact directly.
 *
 * **Topology tree:**
 * {@link getTopology} returns a recursive tree of {@link TopologyNode} objects
 * starting from root teams (teams with no parent). The `depth` parameter limits
 * how deep the tree is traversed. Used by `inspect_topology` SDK tool.
 *
 * **Lifecycle:**
 * The org chart is rebuilt on startup from persisted team configs and live
 * container state. It is updated incrementally as teams and agents are
 * added/removed at runtime. All mutations publish `org_chart.updated` events
 * to the EventBus.
 */
export class OrgChartImpl implements OrgChart {
  // INV-01: Team lead always in parent container.

  /**
   * Register a team in the org chart.
   *
   * Adds the team to all internal indexes (by TID, by slug, parent-children).
   * The team's `leaderAid` must reference an agent that exists in the parent
   * team — not in this team's own agent list (INV-01 enforcement).
   *
   * @param team - The team node to add
   * @throws ValidationError if a team with the same TID or slug already exists
   * @throws ValidationError if the leader AID is not in the parent team (INV-01)
   */
  addTeam(_team: OrgChartTeam): void {
    throw new Error('Not implemented');
  }

  /**
   * Remove a team and its agents from the org chart.
   *
   * Removes the team from all indexes and detaches it from its parent's
   * children list. Also removes all agents that belong to this team.
   * Child teams must be removed before the parent (bottom-up teardown).
   *
   * @param tid - The TID of the team to remove
   * @throws NotFoundError if no team with this TID exists
   * @throws ValidationError if the team still has child teams
   */
  removeTeam(_tid: string): void {
    throw new Error('Not implemented');
  }

  /**
   * Look up a team by its TID. Returns undefined if not found.
   * Constant-time lookup via the `teamsByTid` map.
   */
  getTeam(_tid: string): OrgChartTeam | undefined {
    throw new Error('Not implemented');
  }

  /**
   * Look up a team by its slug. Returns undefined if not found.
   * Constant-time lookup via the `teamsBySlug` map.
   */
  getTeamBySlug(_slug: string): OrgChartTeam | undefined {
    throw new Error('Not implemented');
  }

  /**
   * List all teams in the org chart.
   * Returns a snapshot array — mutations to the returned array do not affect
   * the internal state.
   */
  listTeams(): OrgChartTeam[] {
    throw new Error('Not implemented');
  }

  /**
   * Get all direct child teams of a parent team.
   * Uses the `childrenByTid` index for constant-time lookup.
   *
   * @param tid - The parent team's TID
   * @returns Array of child teams (empty if the team has no children or doesn't exist)
   */
  getChildren(_tid: string): OrgChartTeam[] {
    throw new Error('Not implemented');
  }

  /**
   * Get the parent team of a given team.
   * Looks up the team's `parentTid` and resolves it via `teamsByTid`.
   *
   * @param tid - The child team's TID
   * @returns The parent team, or undefined if this is a root team or team not found
   */
  getParent(_tid: string): OrgChartTeam | undefined {
    throw new Error('Not implemented');
  }

  /**
   * Register an agent in the org chart.
   *
   * Adds the agent to the `agentsByAid` map and the team's agent set.
   * If the agent leads a team (`leadsTeam` is set), updates the `leadToTeam` index.
   *
   * @param agent - The agent node to add
   * @throws ValidationError if an agent with the same AID already exists
   * @throws NotFoundError if the agent's team slug does not exist in the org chart
   */
  addAgent(_agent: OrgChartAgent): void {
    throw new Error('Not implemented');
  }

  /**
   * Remove an agent from the org chart.
   *
   * Removes the agent from all indexes. If the agent leads a team, the team's
   * leader reference becomes stale — callers must handle leader reassignment
   * or team removal before removing a leader agent.
   *
   * @param aid - The AID of the agent to remove
   * @throws NotFoundError if no agent with this AID exists
   */
  removeAgent(_aid: string): void {
    throw new Error('Not implemented');
  }

  /**
   * Look up an agent by its AID. Returns undefined if not found.
   * Constant-time lookup via the `agentsByAid` map.
   */
  getAgent(_aid: string): OrgChartAgent | undefined {
    throw new Error('Not implemented');
  }

  /**
   * Get all agents belonging to a team.
   * Uses the `agentsByTeam` index for constant-time lookup.
   *
   * @param teamSlug - The team's slug
   * @returns Array of agents in the team (empty if team has no agents or doesn't exist)
   */
  getAgentsByTeam(_teamSlug: string): OrgChartAgent[] {
    throw new Error('Not implemented');
  }

  /**
   * Get the lead agent of a team.
   *
   * Resolves the team's `leaderAid` to an agent. Note that per INV-01,
   * the leader agent belongs to the **parent** team, not this team.
   *
   * @param teamSlug - The team's slug
   * @returns The lead agent, or undefined if the team or leader is not found
   */
  getLeadOf(_teamSlug: string): OrgChartAgent | undefined {
    throw new Error('Not implemented');
  }

  /**
   * Check if a source agent is authorized to interact with a target agent.
   *
   * Authorization rules (derived from the team hierarchy):
   * 1. Same team: agents in the same team can always interact.
   * 2. Downward: a team lead can interact with any agent in the team it leads,
   *    and transitively with agents in descendant teams.
   * 3. Upward (one level): any agent can interact with its own team lead
   *    (for escalation).
   * 4. Cross-branch: agents in sibling or unrelated teams cannot interact.
   *
   * @param sourceAid - The agent initiating the interaction
   * @param targetAid - The agent being interacted with
   * @returns true if the interaction is authorized
   */
  isAuthorized(_sourceAid: string, _targetAid: string): boolean {
    throw new Error('Not implemented');
  }

  /**
   * Build a recursive topology tree for inspection.
   *
   * Starts from root teams (teams with no parent) and recurses into children.
   * Each node includes the team's agents and health status.
   *
   * @param depth - Maximum depth to traverse (undefined = unlimited)
   * @returns Array of root-level topology nodes with nested children
   */
  getTopology(_depth?: number): TopologyNode[] {
    throw new Error('Not implemented');
  }
}
