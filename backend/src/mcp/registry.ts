/**
 * MCP registry -- tool registration, discovery, and role-based access control.
 *
 * Implements the {@link MCPRegistry} interface for registering built-in tools
 * and exposing them to agents via the in-process MCP server (`openhive-tools`).
 *
 * ## Tool Catalog
 *
 * The registry manages ~23 built-in management tools across 10 categories:
 *
 * | Category            | Count | Tools                                                        |
 * |---------------------|-------|--------------------------------------------------------------|
 * | **Container**       | 3     | `spawn_container`, `stop_container`, `list_containers`       |
 * | **Team**            | 2     | `create_team`, `create_agent`                                |
 * | **Task**            | 3     | `create_task`, `dispatch_subtask`, `update_task_status`      |
 * | **Messaging**       | 1     | `send_message`                                               |
 * | **Orchestration**   | 1     | `escalate`                                                   |
 * | **Memory**          | 2     | `save_memory`, `recall_memory`                               |
 * | **Integration**     | 3     | `create_integration`, `test_integration`, `activate_integration` |
 * | **Secret Mgmt**     | 2     | `get_credential`, `set_credential`                           |
 * | **Query**           | 4     | `get_team`, `get_task`, `get_health`, `inspect_topology`     |
 * | **Event**           | 2     | `register_webhook`, `register_trigger`                       |
 *
 * ## Role-Based Access Matrix (MCP-Tools.md "Tool Scope by Role")
 *
 * Not all tools are available to every agent. Access depends on the agent's
 * role in the hierarchy. The matrix below defines which tools each role can invoke:
 *
 * | Tool                    | main_assistant | team_lead | member |
 * |-------------------------|:-:|:-:|:-:|
 * | `spawn_container`       | Yes | --  | --  |
 * | `stop_container`        | Yes | --  | --  |
 * | `list_containers`       | Yes | --  | --  |
 * | `create_team`           | Yes | Yes | --  |
 * | `create_agent`          | Yes | Yes | --  |
 * | `create_task`           | Yes | Yes | --  |
 * | `dispatch_subtask`      | Yes | Yes | --  |
 * | `update_task_status`    | Yes | Yes | Yes |
 * | `send_message`          | Yes | Yes | Yes |
 * | `escalate`              | Yes | Yes | Yes |
 * | `save_memory`           | Yes | Yes | Yes |
 * | `recall_memory`         | Yes | Yes | Yes |
 * | `create_integration`    | Yes | Yes | --  |
 * | `test_integration`      | Yes | Yes | --  |
 * | `activate_integration`  | Yes | Yes | --  |
 * | `get_credential`        | Yes | Yes | Yes |
 * | `set_credential`        | Yes | Yes | --  |
 * | `get_team`              | Yes | Yes | --  |
 * | `get_task`              | Yes | Yes | Yes |
 * | `get_health`            | Yes | Yes | --  |
 * | `inspect_topology`      | Yes | Yes | --  |
 * | `register_webhook`      | Yes | Yes | --  |
 * | `register_trigger`      | Yes | Yes | --  |
 *
 * **Summary:**
 * - **main_assistant:** Full access to all 23 tools.
 * - **team_lead:** Team-scoped access (20 tools). Cannot manage containers directly.
 * - **member:** Minimal access (7 tools). Can update tasks, send messages, escalate,
 *   manage own memory, read credentials, and query own tasks.
 *
 * ## Enforcement
 *
 * Tool access is enforced at two levels:
 * 1. **SDK-level:** `.claude/settings.json` with `allowedTools` list per role
 * 2. **Hub-level:** Root WS hub checks `isAllowed()` before executing any tool call
 *
 * Permission violations return a structured `ACCESS_DENIED` error, allowing the
 * agent to adjust or escalate.
 *
 * @module mcp/registry
 */

import type { MCPRegistry } from '../domain/index.js';
import type { AgentRole } from '../domain/index.js';
import { ConflictError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Role-Based Access Control Matrix
// ---------------------------------------------------------------------------

/**
 * Tools accessible by the `main_assistant` role.
 * Full access to all 23 built-in tools.
 */
const MAIN_ASSISTANT_TOOLS: ReadonlySet<string> = new Set([
  'spawn_container',
  'stop_container',
  'list_containers',
  'create_team',
  'create_agent',
  'create_task',
  'dispatch_subtask',
  'update_task_status',
  'send_message',
  'escalate',
  'save_memory',
  'recall_memory',
  'create_integration',
  'test_integration',
  'activate_integration',
  'get_credential',
  'set_credential',
  'get_team',
  'get_task',
  'get_health',
  'inspect_topology',
  'register_webhook',
  'register_trigger',
  'search_skill',
  'install_skill',
]);

/**
 * Tools accessible by the `team_lead` role.
 * Team-scoped access. Cannot manage containers directly.
 */
const TEAM_LEAD_TOOLS: ReadonlySet<string> = new Set([
  'create_team',
  'create_agent',
  'create_task',
  'dispatch_subtask',
  'update_task_status',
  'send_message',
  'escalate',
  'save_memory',
  'recall_memory',
  'create_integration',
  'test_integration',
  'activate_integration',
  'get_credential',
  'set_credential',
  'get_team',
  'get_task',
  'get_health',
  'inspect_topology',
  'register_webhook',
  'register_trigger',
  'search_skill',
  'install_skill',
]);

/**
 * Tools accessible by the `member` role.
 * Minimal access (7 tools). Can update task status, send messages, escalate,
 * manage own memory, read credentials, and query own tasks.
 */
const MEMBER_TOOLS: ReadonlySet<string> = new Set([
  'update_task_status',
  'send_message',
  'escalate',
  'save_memory',
  'recall_memory',
  'get_credential',
  'get_task',
]);

/**
 * Maps each {@link AgentRole} value to its set of allowed tool names.
 */
const ROLE_TOOL_MATRIX: Readonly<Record<AgentRole, ReadonlySet<string>>> = {
  main_assistant: MAIN_ASSISTANT_TOOLS,
  team_lead: TEAM_LEAD_TOOLS,
  member: MEMBER_TOOLS,
};

// ---------------------------------------------------------------------------
// Tool Entry Type
// ---------------------------------------------------------------------------

/** Internal representation of a registered tool. Exported for test doubles. */
export interface ToolEntry {
  name: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, agentAid: string) => Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// MCPRegistryImpl
// ---------------------------------------------------------------------------

/**
 * MCP registry implementation.
 *
 * Manages tool registration and discovery for the in-process MCP server
 * (`openhive-tools`). Each tool is registered with a name, JSON schema
 * describing its parameters, and an async handler function.
 *
 * Implements the {@link MCPRegistry} interface plus two additional methods
 * for role-based access control:
 *
 * - {@link getToolsForRole} -- Returns the list of tools available to a role
 * - {@link isAllowed} -- Checks if a specific tool is allowed for a role
 *
 * ## Internal State
 *
 * ```
 * Map<tool_name, ToolEntry { name, schema, handler }>
 * ```
 *
 * - Keyed by tool name (string, snake_case)
 * - Each entry holds the tool name, its JSON schema, and the async handler
 * - `registerTool()` adds entries; `unregisterTool()` removes them
 * - `getTool()` looks up a single entry; `listTools()` returns all entries
 * - Duplicate registration throws an error (tool names must be unique)
 */
export class MCPRegistryImpl implements MCPRegistry {
  private readonly tools = new Map<string, ToolEntry>();

  /**
   * Registers a tool with the MCP registry.
   *
   * Adds a tool entry to the internal map. The tool becomes discoverable
   * via `listTools()` and invocable via `getTool()`.
   *
   * Throws if a tool with the same name is already registered (tool names
   * must be globally unique within a registry instance).
   *
   * @param _name - Unique tool name in snake_case (e.g., 'create_team')
   * @param _schema - JSON Schema describing the tool's input parameters.
   *   Must follow the MCP tool schema format with `type`, `properties`,
   *   and `required` fields.
   * @param _handler - Async function that executes the tool logic.
   *   Receives the validated arguments and the calling agent's AID.
   *   Returns the tool result as a key-value record.
   *
   * @throws Error if a tool with `_name` is already registered
   *
   * @example
   * ```ts
   * registry.registerTool(
   *   'create_team',
   *   {
   *     type: 'object',
   *     properties: {
   *       slug: { type: 'string', description: 'Team slug (directory name)' },
   *       leader_aid: { type: 'string', description: 'AID of the team lead agent' },
   *       purpose: { type: 'string', description: 'Team purpose/scope' },
   *     },
   *     required: ['slug', 'leader_aid', 'purpose'],
   *   },
   *   async (args, agentAid) => {
   *     // Tool implementation
   *     return { slug: args.slug, status: 'created' };
   *   },
   * );
   * ```
   */
  registerTool(
    name: string,
    schema: Record<string, unknown>,
    handler: (args: Record<string, unknown>, agentAid: string) => Promise<Record<string, unknown>>,
  ): void {
    if (this.tools.has(name)) {
      throw new ConflictError(`Tool '${name}' is already registered`);
    }
    this.tools.set(name, { name, schema, handler });
  }

  /**
   * Removes a tool from the registry.
   *
   * After unregistration, the tool is no longer discoverable via `listTools()`
   * and cannot be invoked via `getTool()`. If the tool name is not found,
   * this method is a no-op (idempotent removal).
   *
   * @param _name - Name of the tool to remove
   */
  unregisterTool(name: string): void {
    this.tools.delete(name);
  }

  /**
   * Looks up a registered tool by name.
   *
   * Returns the tool's schema and handler if found, or `undefined` if no
   * tool is registered with the given name. This is the primary lookup
   * method used by the MCP server when an agent invokes a tool.
   *
   * @param _name - Name of the tool to look up
   * @returns Tool entry with schema and handler, or `undefined` if not found
   */
  getTool(
    name: string,
  ): { schema: Record<string, unknown>; handler: (args: Record<string, unknown>, agentAid: string) => Promise<Record<string, unknown>> } | undefined {
    const entry = this.tools.get(name);
    if (!entry) {
      return undefined;
    }
    return { schema: entry.schema, handler: entry.handler };
  }

  /**
   * Lists all registered tools with their schemas.
   *
   * Returns an array of tool entries containing the name and JSON schema
   * for each registered tool. Handlers are not included in the response
   * (this is a discovery/catalog endpoint, not an invocation endpoint).
   *
   * Used by the MCP server to populate the tool catalog when the SDK
   * queries available tools.
   *
   * @returns Array of registered tools with name and schema
   */
  listTools(): Array<{ name: string; schema: Record<string, unknown> }> {
    return Array.from(this.tools.values()).map(e => ({ name: e.name, schema: e.schema }));
  }

  /**
   * Returns the list of tools available to a given agent role.
   *
   * Filters the registered tools against the role-based access matrix
   * (from MCP-Tools.md "Tool Scope by Role" table). Only returns tools
   * that are both registered in the registry AND allowed for the role.
   *
   * This is used by the orchestrator to generate the `allowedTools` list
   * for `.claude/settings.json` when setting up an agent's workspace.
   *
   * @param _role - Agent role to query (main_assistant, team_lead, member)
   * @returns Array of tool entries (name + schema) available to the role
   *
   * @example
   * ```ts
   * // Get all tools available to a team lead
   * const tools = registry.getToolsForRole('team_lead');
   * // Returns 20 tools (all except container management tools)
   *
   * // Get minimal tools for a member
   * const memberTools = registry.getToolsForRole('member');
   * // Returns 7 tools (update_task_status, send_message, escalate, etc.)
   * ```
   */
  getToolsForRole(
    role: AgentRole,
  ): Array<{ name: string; schema: Record<string, unknown> }> {
    const roleTools = ROLE_TOOL_MATRIX[role];
    if (!roleTools) {
      return [];
    }
    // Return intersection of registered tools AND role-allowed tools
    return this.listTools().filter(t => roleTools.has(t.name));
  }

  /**
   * Checks whether a specific tool is allowed for a given agent role.
   *
   * Performs a lookup against the role-based access matrix. Returns `true`
   * if the tool is in the role's allowed set, `false` otherwise.
   *
   * This is used by the root WS hub's SDKToolHandler to authorize tool
   * calls before execution. If `isAllowed()` returns `false`, the hub
   * returns an `ACCESS_DENIED` error to the calling agent.
   *
   * @param _toolName - Name of the tool to check
   * @param _role - Agent role to check against
   * @returns `true` if the tool is allowed for the role, `false` otherwise
   *
   * @example
   * ```ts
   * registry.isAllowed('spawn_container', 'main_assistant'); // → true
   * registry.isAllowed('spawn_container', 'team_lead');      // → false
   * registry.isAllowed('spawn_container', 'member');         // → false
   * registry.isAllowed('update_task_status', 'member');      // → true
   * ```
   */
  isAllowed(toolName: string, role: AgentRole): boolean {
    return ROLE_TOOL_MATRIX[role]?.has(toolName) ?? false;
  }
}

// Re-export role-based tool sets for testing and external use
export { MAIN_ASSISTANT_TOOLS, TEAM_LEAD_TOOLS, MEMBER_TOOLS, ROLE_TOOL_MATRIX };
