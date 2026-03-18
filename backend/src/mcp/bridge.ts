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

import crypto from 'node:crypto';
import type { MCPBridge, Logger } from '../domain/index.js';
import { InternalError } from '../domain/index.js';

/** Fields that should be redacted from tool call logs. */
const SENSITIVE_FIELDS: ReadonlySet<string> = new Set([
  'api_key',
  'token',
  'secret',
  'password',
]);

/** Shape of a pending tool call entry. */
interface PendingCall {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  toolName: string;
  agentAid: string;
  startTime: number;
}

/** WebSocket send function signature. */
export type WSSendFn = (message: Record<string, unknown>) => void;

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
  'search_skill',
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
  'install_skill',
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
  private readonly pendingCalls = new Map<string, PendingCall>();
  private readonly send: WSSendFn;
  private readonly logger: Logger | undefined;

  constructor(send: WSSendFn, logger?: Logger) {
    this.send = send;
    this.logger = logger;
  }

  /**
   * Sends a tool call over WebSocket and awaits the correlated result.
   */
  callTool(
    toolName: string,
    args: Record<string, unknown>,
    agentAid: string,
  ): Promise<Record<string, unknown>> {
    const callId = crypto.randomUUID();
    const timeoutMs = this.getTimeoutForTool(toolName);

    // Redact sensitive fields for logging
    const safeArgs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      safeArgs[key] = SENSITIVE_FIELDS.has(key) ? '[REDACTED]' : value;
    }

    this.logger?.debug('Tool call initiated', {
      call_id: callId,
      tool_name: toolName,
      agent_aid: agentAid,
      timeout_ms: timeoutMs,
      args: safeArgs,
    });

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(callId);
        const elapsed = Date.now() - startTime;
        this.logger?.warn('Tool call timed out', {
          call_id: callId,
          tool_name: toolName,
          agent_aid: agentAid,
          elapsed_ms: elapsed,
          timeout_ms: timeoutMs,
        });
        reject(new InternalError(`Tool call timed out: ${toolName} (call_id=${callId}, elapsed=${elapsed}ms)`));
      }, timeoutMs);

      const startTime = Date.now();

      this.pendingCalls.set(callId, {
        resolve,
        reject,
        timer,
        toolName,
        agentAid,
        startTime,
      });

      this.send({
        type: 'tool_call',
        data: {
          call_id: callId,
          tool_name: toolName,
          arguments: args,
          agent_aid: agentAid,
        },
      });
    });
  }

  /**
   * Handles a successful tool result from root.
   */
  handleResult(callId: string, result: Record<string, unknown>): void {
    const entry = this.pendingCalls.get(callId);
    if (!entry) {
      this.logger?.warn('Received result for unknown call_id', { call_id: callId });
      return;
    }

    clearTimeout(entry.timer);
    this.pendingCalls.delete(callId);

    this.logger?.debug('Tool call resolved', {
      call_id: callId,
      tool_name: entry.toolName,
      elapsed_ms: Date.now() - entry.startTime,
    });

    entry.resolve(result);
  }

  /**
   * Handles a tool error from root.
   */
  handleError(callId: string, errorCode: string, errorMessage: string): void {
    const entry = this.pendingCalls.get(callId);
    if (!entry) {
      this.logger?.warn('Received error for unknown call_id', { call_id: callId, error_code: errorCode });
      return;
    }

    clearTimeout(entry.timer);
    this.pendingCalls.delete(callId);

    this.logger?.debug('Tool call rejected', {
      call_id: callId,
      tool_name: entry.toolName,
      error_code: errorCode,
      error_message: errorMessage,
      elapsed_ms: Date.now() - entry.startTime,
    });

    entry.reject(new InternalError(errorMessage));
  }

  /** Returns the number of in-flight tool calls. */
  getPendingCalls(): number {
    return this.pendingCalls.size;
  }

  /** Rejects all pending calls and clears timers. Used during shutdown. */
  cancelAll(reason: string): void {
    for (const [callId, entry] of this.pendingCalls) {
      clearTimeout(entry.timer);
      this.logger?.warn('Tool call cancelled', {
        call_id: callId,
        tool_name: entry.toolName,
        reason,
      });
      entry.reject(new InternalError(reason));
    }
    this.pendingCalls.clear();
  }

  /**
   * Returns the timeout duration for a given tool based on its tier.
   *
   * - Query (10s, CON-09): read-only lookups
   * - Mutating (60s, CON-10): state-modifying operations
   * - Blocking (5 min, CON-11): external operations with unpredictable latency
   *
   * Unknown tools default to the mutating tier (60s).
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
