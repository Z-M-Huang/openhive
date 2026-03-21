/**
 * SDKToolHandler — authorization, validation, error mapping, logging.
 *
 * @module mcp/tools/sdk-tool-handler
 */

import { WSErrorCode, LogLevel } from '../../domain/index.js';
import type { AgentRole } from '../../domain/index.js';
import { DomainError, NotFoundError, AccessDeniedError, mapDomainErrorToWSError } from '../../domain/errors.js';
import { TOOL_SCHEMAS } from './schemas.js';
import type { ToolContext, ToolHandler, SDKToolHandlerResult } from './types.js';

/**
 * Tools that require hierarchy-based authorization and their target field.
 * The handler extracts the target from args and checks OrgChart.isAuthorized().
 */
const HIERARCHY_AUTH_TOOLS: Record<string, string> = {
  create_task: 'agent_aid',
  dispatch_subtask: 'agent_aid',
  send_message: 'target_aid',
  escalate: 'target_aid',
};

/**
 * Wraps tool handlers with authorization, Zod validation, error mapping,
 * and audit logging. This is the root-side handler for incoming tool_call
 * WebSocket messages.
 */
export class SDKToolHandler {
  private readonly handlers: Map<string, ToolHandler>;
  private readonly ctx: ToolContext;

  constructor(ctx: ToolContext, handlers: Map<string, ToolHandler>) {
    this.ctx = ctx;
    this.handlers = handlers;
  }

  /**
   * Handle a tool call from an agent.
   *
   * 1. Validate authorization (OrgChart + MCPRegistry RBAC)
   * 2. Validate args via per-tool Zod schema
   * 3. Execute handler
   * 4. Map domain errors to WS error codes
   * 5. Log to ToolCallStore
   * 6. Return result or error
   */
  async handle(
    toolName: string,
    args: Record<string, unknown>,
    agentAid: string,
    callId: string,
  ): Promise<SDKToolHandlerResult> {
    const startTime = Date.now();
    const agent = this.ctx.orgChart.getAgent(agentAid);
    const teamSlug = agent?.teamSlug ?? '';
    const role = (agent?.role ?? 'member') as AgentRole;

    try {
      // 1. Authorization: Two-tier model (AC-L6-04)
      if (!this.ctx.mcpRegistry.isAllowed(toolName, role)) {
        throw new AccessDeniedError(
          `Agent '${agentAid}' (role: ${role}) is not authorized to call '${toolName}'`
        );
      }

      // Central hierarchy authorization for tools with explicit targets
      const targetField = HIERARCHY_AUTH_TOOLS[toolName];
      if (targetField && args[targetField] && typeof args[targetField] === 'string') {
        const targetAid = args[targetField] as string;
        if (!this.ctx.orgChart.isAuthorized(agentAid, targetAid)) {
          throw new AccessDeniedError(
            `Agent '${agentAid}' is not authorized to perform '${toolName}' on '${targetAid}'`
          );
        }
      }

      // 2. Check handler exists
      const handler = this.handlers.get(toolName);
      if (!handler) {
        throw new NotFoundError(`Tool '${toolName}' not found`);
      }

      // 3. Validate args
      const schema = TOOL_SCHEMAS[toolName];
      if (schema) {
        schema.parse(args);
      }

      // 4. Execute handler
      const result = await handler(args, agentAid, teamSlug);

      // 5. Log success
      await this.logToolCall(callId, toolName, agentAid, teamSlug, args, JSON.stringify(result), '', Date.now() - startTime);

      return { success: true, result };
    } catch (err: unknown) {
      const errorCode = err instanceof DomainError
        ? mapDomainErrorToWSError(err)
        : WSErrorCode.InternalError;

      const errorMessage = err instanceof Error ? err.message : String(err);

      await this.logToolCall(callId, toolName, agentAid, teamSlug, args, '', errorMessage, Date.now() - startTime);

      return { success: false, error_code: errorCode, error_message: errorMessage };
    }
  }

  /** Convenience: get the underlying handlers map. */
  getHandlers(): Map<string, ToolHandler> {
    return this.handlers;
  }

  private async logToolCall(
    callId: string,
    toolName: string,
    agentAid: string,
    teamSlug: string,
    params: Record<string, unknown>,
    resultSummary: string,
    error: string,
    durationMs: number,
  ): Promise<void> {
    try {
      const logEntry = {
        id: 0,
        level: error ? LogLevel.Error : LogLevel.Info,
        event_type: 'tool_call',
        component: 'sdk_tool_handler',
        action: toolName,
        message: error ? 'tool_call_failed' : 'tool_call',
        params: JSON.stringify(params),
        team_slug: teamSlug,
        task_id: '',
        agent_aid: agentAid,
        request_id: '',
        correlation_id: callId,
        error: error,
        duration_ms: durationMs,
        created_at: Date.now(),
      };
      const [logEntryId] = await this.ctx.logStore.createWithIds([logEntry]);

      await this.ctx.toolCallStore.create({
        id: 0,
        log_entry_id: logEntryId,
        tool_use_id: callId,
        tool_name: toolName,
        agent_aid: agentAid,
        team_slug: teamSlug,
        task_id: '',
        params: JSON.stringify(params),
        result_summary: resultSummary.slice(0, 1000),
        error,
        duration_ms: durationMs,
        created_at: Date.now(),
      });
    } catch {
      this.ctx.logger.warn('Failed to log tool call', { call_id: callId, tool_name: toolName });
    }
  }
}
