/**
 * MCP bridge -- SDK-to-WebSocket tool call correlation and timeout management.
 *
 * Implements the {@link MCPBridge} interface for bridging in-process MCP server
 * tool calls to the WebSocket protocol. When an agent invokes a built-in tool
 * via the in-process MCP server (`openhive-tools`), the bridge sends the call
 * over WebSocket to root's SDKToolHandler and awaits the correlated result.
 *
 * ## SDK <-> WebSocket Correlation
 *
 * Each tool call is assigned a unique `call_id` (UUID). The bridge maintains a
 * pending promise map keyed by `call_id`. When `callTool()` is invoked:
 *
 * 1. Generate a unique `call_id`
 * 2. Create a Promise and store its resolve/reject in the pending map
 * 3. Send a `tool_call` WebSocket message: `{ call_id, tool_name, args, agent_aid }`
 * 4. Start a timeout timer based on the tool's timeout tier
 * 5. When `handleResult()` or `handleError()` is called with the matching `call_id`,
 *    resolve or reject the pending promise and clear the timeout
 *
 * ## Pending Promise Map
 *
 * ```
 * Map<call_id, { resolve, reject, timer, toolName, agentAid, startTime }>
 * ```
 *
 * - Keyed by `call_id` (string, UUID format)
 * - Each entry holds the Promise resolve/reject callbacks, a timeout timer handle,
 *   the tool name (for logging), agent AID, and the start timestamp (for metrics)
 * - Entries are removed on resolution, rejection, or timeout
 * - `getPendingCalls()` returns the current size of this map
 *
 * ## Timeout Tiers (CON-09 / CON-10 / CON-11)
 *
 * Tools are assigned to timeout tiers based on their operational characteristics.
 * See MCP-Tools.md and Design-Rules CON-09, CON-10, CON-11.
 *
 * | Tier         | Timeout | Tools                                                                                                             |
 * |--------------|---------|-------------------------------------------------------------------------------------------------------------------|
 * | **Query**    | 10s     | `get_team`, `get_task`, `get_health`, `inspect_topology`, `recall_memory`, `get_credential`, `list_containers`    |
 * | **Mutating** | 60s     | `create_team`, `create_agent`, `create_task`, `dispatch_subtask`, `update_task_status`, `send_message`,           |
 * |              |         | `escalate`, `save_memory`, `set_credential`, `register_webhook`                                                   |
 * | **Blocking** | 5 min   | `spawn_container`, `stop_container`, `create_integration`, `test_integration`, `activate_integration`             |
 *
 * - **Query (10s, CON-09):** Read-only lookups. Should complete in milliseconds.
 *   If a query tool exceeds 10 seconds, it indicates a systemic issue (DB lock,
 *   WebSocket congestion). The timeout rejects the promise with a TIMEOUT error.
 *
 * - **Mutating (60s, CON-10):** State-modifying operations that write to the database,
 *   update the org chart, or send messages. Bounded time but may involve multiple
 *   steps (e.g., create_team scaffolds workspace + writes config + updates org chart).
 *
 * - **Blocking (5 min / 300s, CON-11):** External operations with unpredictable
 *   latency. `spawn_container` pulls Docker images and waits for WebSocket
 *   connection. `test_integration` validates external API connectivity.
 *   `stop_container` sends SIGTERM, waits for graceful shutdown, then SIGKILL.
 *
 * When a timeout fires:
 * 1. Remove the entry from the pending map
 * 2. Reject the promise with a structured TIMEOUT error including the tool name,
 *    call_id, and elapsed time
 * 3. Log the timeout event at warn level
 *
 * ## Tool Call Flow
 *
 * ```
 * Agent (SDK) → In-Process MCP → MCPBridge.callTool()
 *   → WebSocket → Root WS Hub → SDKToolHandler
 *   → SDKToolHandler executes tool logic
 *   → Root WS Hub → WebSocket → MCPBridge.handleResult() / handleError()
 *   → Resolves pending promise → MCP returns result to SDK → Agent
 * ```
 *
 * @module mcp/bridge
 */

import type { MCPBridge } from '../domain/index.js';

/**
 * Timeout duration in milliseconds for each tier.
 *
 * - QUERY: 10 seconds (CON-09)
 * - MUTATING: 60 seconds (CON-10)
 * - BLOCKING: 300 seconds / 5 minutes (CON-11)
 */
const TIMEOUT_QUERY_MS = 10_000;
const TIMEOUT_MUTATING_MS = 60_000;
const TIMEOUT_BLOCKING_MS = 300_000;

/**
 * Query-tier tools (10s timeout, CON-09).
 * Read-only lookups that should complete quickly.
 */
const QUERY_TOOLS: ReadonlySet<string> = new Set([
  'get_team',
  'get_task',
  'get_health',
  'inspect_topology',
  'recall_memory',
  'get_credential',
  'list_containers',
]);

/**
 * Blocking-tier tools (5 min timeout, CON-11).
 * External operations with unpredictable latency (Docker, API tests).
 */
const BLOCKING_TOOLS: ReadonlySet<string> = new Set([
  'spawn_container',
  'stop_container',
  'create_integration',
  'test_integration',
  'activate_integration',
]);

/**
 * Mutating-tier tools (60s timeout, CON-10).
 * All tools not in QUERY_TOOLS or BLOCKING_TOOLS default to mutating tier.
 *
 * Explicit list for documentation purposes:
 * - create_team
 * - create_agent
 * - create_task
 * - dispatch_subtask
 * - update_task_status
 * - send_message
 * - escalate
 * - save_memory
 * - set_credential
 * - register_webhook
 */
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'create_team',
  'create_agent',
  'create_task',
  'dispatch_subtask',
  'update_task_status',
  'send_message',
  'escalate',
  'save_memory',
  'set_credential',
  'register_webhook',
]);

/**
 * MCP bridge implementation.
 *
 * Bridges in-process MCP server tool calls to the WebSocket protocol,
 * correlating requests and responses via unique call_id values.
 *
 * Implements the {@link MCPBridge} interface with:
 * - `callTool()` — Sends a tool call over WebSocket and returns a Promise
 *   that resolves when the correlated result arrives (or rejects on timeout/error)
 * - `handleResult()` — Called by the WebSocket message handler when a
 *   `tool_result` message arrives with a matching call_id. Resolves the
 *   pending promise.
 * - `handleError()` — Called by the WebSocket message handler when a
 *   `tool_result` message arrives with an error. Rejects the pending promise.
 * - `getPendingCalls()` — Returns the number of in-flight tool calls
 *   (pending map size)
 *
 * **Internal helper (not on interface):**
 * - `getTimeoutForTool(toolName)` — Returns the timeout duration in milliseconds
 *   for a given tool based on its tier assignment. Query = 10s, Mutating = 60s,
 *   Blocking = 5 min. Unknown tools default to the mutating tier (60s).
 */
export class MCPBridgeImpl implements MCPBridge {
  /**
   * Sends a tool call over WebSocket and awaits the correlated result.
   *
   * Creates a unique call_id, stores a pending promise entry, sends the
   * `tool_call` message via WebSocket, and starts a timeout timer based
   * on the tool's timeout tier.
   *
   * The returned promise resolves when `handleResult()` is called with
   * the matching call_id, or rejects when:
   * - `handleError()` is called with the matching call_id
   * - The timeout timer fires (rejects with TIMEOUT error)
   *
   * @param _toolName - Name of the tool to invoke (e.g., 'create_team')
   * @param _args - Tool arguments as key-value pairs
   * @param _agentAid - AID of the agent making the call (for authorization)
   * @returns Promise resolving to the tool's result payload
   *
   * @example
   * ```ts
   * const result = await bridge.callTool('create_team', {
   *   slug: 'research-team',
   *   leader_aid: 'aid-abc-123',
   *   purpose: 'Research and analysis',
   * }, 'aid-abc-123');
   * ```
   */
  callTool(
    _toolName: string,
    _args: Record<string, unknown>,
    _agentAid: string,
  ): Promise<Record<string, unknown>> {
    throw new Error('Not implemented');
  }

  /**
   * Handles a successful tool result from root.
   *
   * Called by the WebSocket message handler when a `tool_result` message
   * arrives with a matching `call_id`. Looks up the pending promise entry,
   * clears the timeout timer, removes the entry from the map, and resolves
   * the promise with the result payload.
   *
   * If the call_id is not found in the pending map (already timed out or
   * duplicate result), this method is a no-op and logs a warning.
   *
   * @param _callId - The call_id correlating this result to the original request
   * @param _result - The tool's result payload from SDKToolHandler
   */
  handleResult(
    _callId: string,
    _result: Record<string, unknown>,
  ): void {
    throw new Error('Not implemented');
  }

  /**
   * Handles a tool error from root.
   *
   * Called by the WebSocket message handler when a `tool_result` message
   * arrives with an error payload for the given call_id. Looks up the
   * pending promise entry, clears the timeout timer, removes the entry
   * from the map, and rejects the promise with a structured error.
   *
   * If the call_id is not found in the pending map (already timed out or
   * duplicate), this method is a no-op and logs a warning.
   *
   * @param _callId - The call_id correlating this error to the original request
   * @param _errorCode - Structured error code (e.g., 'ACCESS_DENIED', 'NOT_FOUND')
   * @param _errorMessage - Human-readable error description
   */
  handleError(
    _callId: string,
    _errorCode: string,
    _errorMessage: string,
  ): void {
    throw new Error('Not implemented');
  }

  /**
   * Returns the number of in-flight tool calls.
   *
   * Returns the current size of the pending promise map. Useful for
   * diagnostics, health checks, and graceful shutdown (wait until
   * pending calls drain to zero before disconnecting).
   *
   * @returns Number of tool calls awaiting responses
   */
  getPendingCalls(): number {
    throw new Error('Not implemented');
  }

  /**
   * Returns the timeout duration for a given tool based on its tier.
   *
   * Timeout tiers (from MCP-Tools.md, Design-Rules CON-09/10/11):
   *
   * - **Query (10s):** get_team, get_task, get_health, inspect_topology,
   *   recall_memory, get_credential, list_containers
   * - **Mutating (60s):** create_team, create_agent, create_task,
   *   dispatch_subtask, update_task_status, send_message, escalate,
   *   save_memory, set_credential, register_webhook
   * - **Blocking (5 min):** spawn_container, stop_container,
   *   create_integration, test_integration, activate_integration
   *
   * Unknown tools default to the mutating tier (60s) as a safe middle ground.
   *
   * @param toolName - Name of the tool to look up
   * @returns Timeout duration in milliseconds
   *
   * @example
   * ```ts
   * getTimeoutForTool('get_team')       // → 10_000  (10s, query tier)
   * getTimeoutForTool('create_team')    // → 60_000  (60s, mutating tier)
   * getTimeoutForTool('spawn_container') // → 300_000 (5min, blocking tier)
   * getTimeoutForTool('unknown_tool')   // → 60_000  (60s, default to mutating)
   * ```
   */
  getTimeoutForTool(toolName: string): number {
    if (QUERY_TOOLS.has(toolName)) {
      return TIMEOUT_QUERY_MS;
    }
    if (BLOCKING_TOOLS.has(toolName)) {
      return TIMEOUT_BLOCKING_MS;
    }
    // Default to mutating tier for known mutating tools and unknown tools
    return TIMEOUT_MUTATING_MS;
  }
}

// Re-export tier constants for testing and external use
export { TIMEOUT_QUERY_MS, TIMEOUT_MUTATING_MS, TIMEOUT_BLOCKING_MS };
export { QUERY_TOOLS, BLOCKING_TOOLS, MUTATING_TOOLS };
