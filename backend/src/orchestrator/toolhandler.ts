/**
 * OpenHive Backend - SDK Tool Handler
 *
 * Dispatches SDK tool calls to registered handler functions.
 * All teams have access to all registered tools (scope enforced by
 * workspace directories, not tool whitelists).
 * Validates agent ownership via OrgChart when set.
 */

import type { SDKToolHandler, ToolRegistry, OrgChart } from '../domain/interfaces.js';
import type { JsonValue } from '../domain/types.js';
import { AccessDeniedError, NotFoundError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/**
 * Minimal structured logger interface required by ToolHandler.
 * Compatible with pino or any standard structured logger.
 */
export interface ToolHandlerLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// ToolFunc type
// ---------------------------------------------------------------------------

/**
 * A function that handles a single named tool call.
 *
 * Receives structured args and returns a structured JSON result.
 * Should throw a domain error on failure.
 */
/** Context passed to tool handlers from the calling container/team. */
export interface ToolCallContext {
  /** Team slug of the calling container (e.g. 'main', 'weather'). */
  teamSlug: string;
  /** AID of the calling agent (may be empty). */
  agentAid: string;
}

export type ToolFunc = (args: Record<string, JsonValue>, context?: ToolCallContext) => Promise<JsonValue>;

// ---------------------------------------------------------------------------
// ToolHandler
// ---------------------------------------------------------------------------

/**
 * Implements SDKToolHandler — dispatches SDK tool calls to registered
 * handler functions with per-team authorization and optional agent
 * ownership validation via OrgChart.
 */
export class ToolHandler implements SDKToolHandler, ToolRegistry {
  private readonly handlers: Map<string, ToolFunc>;
  private readonly logger: ToolHandlerLogger;
  private orgChart: OrgChart | null;

  constructor(logger: ToolHandlerLogger) {
    this.handlers = new Map();
    this.logger = logger;
    this.orgChart = null;
  }

  // -------------------------------------------------------------------------
  // setOrgChart
  // -------------------------------------------------------------------------

  /**
   * Sets the OrgChart used to validate agent ownership.
   * Must be called before agent ownership checks take effect.
   */
  setOrgChart(orgChart: OrgChart): void {
    this.orgChart = orgChart;
  }

  // -------------------------------------------------------------------------
  // register
  // -------------------------------------------------------------------------

  /**
   * Registers a handler function for a named tool.
   * Overwrites any previously registered handler for the same name.
   */
  register(name: string, fn: ToolFunc): void {
    this.handlers.set(name, fn);
  }

  // -------------------------------------------------------------------------
  // handleToolCall
  // -------------------------------------------------------------------------

  /**
   * Dispatches a tool call with the main team context.
   * Context-free variant for legacy compatibility (main assistant calls).
   */
  async handleToolCall(
    callID: string,
    toolName: string,
    args: Record<string, JsonValue>,
  ): Promise<JsonValue> {
    return this.handleToolCallWithContext('main', callID, toolName, '', args);
  }

  // -------------------------------------------------------------------------
  // handleToolCallWithContext
  // -------------------------------------------------------------------------

  /**
   * Dispatches a tool call with full authorization context.
   *
   * Authorization rules:
   *   1. Empty teamID → AccessDeniedError (unauthenticated call).
   *   2. If orgChart is set and agentAID is non-empty:
   *      a. Agent must be known to the org chart.
   *      b. Agent must belong to the calling team.
   *   3. Tool name must be registered → otherwise NotFoundError.
   *
   * All teams have access to all tools — scope is enforced by workspace
   * directories, not tool whitelists. This enables the recursive design
   * where any team can create sub-teams.
   *
   * @throws AccessDeniedError  If authorization fails (rules 1–2).
   * @throws NotFoundError      If the tool name is not registered (rule 3).
   */
  async handleToolCallWithContext(
    teamID: string,
    callID: string,
    toolName: string,
    agentAID: string,
    args: Record<string, JsonValue>,
  ): Promise<JsonValue> {
    // Rule 1: empty teamID is always rejected.
    if (teamID === '') {
      this.logger.warn('tool call rejected: empty teamID', {
        call_id: callID,
        tool_name: toolName,
      });
      throw new AccessDeniedError(
        'tool',
        'teamID is required; unauthenticated tool calls are not permitted',
      );
    }

    this.logger.info('handling tool call', {
      call_id: callID,
      tool_name: toolName,
      team_id: teamID,
      agent_aid: agentAID,
      args: JSON.stringify(args),
    });

    // Rule 2: validate agent ownership via OrgChart.
    if (this.orgChart !== null && agentAID !== '') {
      // 2a. Agent must be known to the org chart.
      try {
        this.orgChart.getAgentByAID(agentAID);
      } catch {
        this.logger.warn('tool call from unknown agent', {
          call_id: callID,
          agent_aid: agentAID,
          team_id: teamID,
        });
        throw new AccessDeniedError(
          'agent',
          `agent ${agentAID} is not known to the orchestrator`,
        );
      }

      // 2b. For non-main teams: agent must belong to the calling team.
      // The main container hosts agents from multiple teams (assistant + leaders).
      if (teamID !== 'main') {
        let agentTeamSlug = '';
        try {
          const agentTeam = this.orgChart.getTeamForAgent(agentAID);
          agentTeamSlug = agentTeam.slug;
        } catch {
          // getTeamForAgent threw — agent is orphaned or unknown in team map.
        }

        if (agentTeamSlug !== teamID) {
          this.logger.warn('tool call from agent not belonging to calling team', {
            call_id: callID,
            agent_aid: agentAID,
            team_id: teamID,
            agent_team: agentTeamSlug,
          });
          throw new AccessDeniedError(
            'agent',
            `agent ${agentAID} does not belong to team ${teamID}`,
          );
        }
      }
    }

    // Rule 4: tool must be registered.
    const fn = this.handlers.get(toolName);
    if (fn === undefined) {
      throw new NotFoundError('tool', toolName);
    }

    // Invoke the handler with calling context.
    const context: ToolCallContext = { teamSlug: teamID, agentAid: agentAID };
    let result: JsonValue;
    try {
      result = await fn(args, context);
    } catch (err) {
      this.logger.error('tool call failed', {
        call_id: callID,
        tool_name: toolName,
        team_id: teamID,
        agent_aid: agentAID,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    this.logger.info('tool call completed', {
      call_id: callID,
      tool_name: toolName,
      team_id: teamID,
      agent_aid: agentAID,
    });

    return result;
  }

  // -------------------------------------------------------------------------
  // registeredTools
  // -------------------------------------------------------------------------

  /**
   * Returns the list of registered tool names.
   * Order is not guaranteed.
   */
  registeredTools(): string[] {
    return Array.from(this.handlers.keys());
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Creates a new ToolHandler with the given logger.
 * OrgChart must be set separately via setOrgChart() before ownership
 * validation takes effect.
 */
export function newToolHandler(logger: ToolHandlerLogger): ToolHandler {
  return new ToolHandler(logger);
}
