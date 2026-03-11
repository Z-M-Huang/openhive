/**
 * SDK hooks -- PreToolUse and PostToolUse logging hooks for Claude Agent SDK.
 *
 * Provides automatic tool call logging without manual instrumentation in each
 * tool handler. When registered at SDK session init, these hooks fire on every
 * tool invocation and emit structured log entries.
 *
 * ## Hook Pattern (from Control-Plane.md)
 *
 * The Claude Agent SDK exposes two hook points for tool call instrumentation:
 *
 * - **PreToolUse** -- fires before a tool is executed. Logs the tool call
 *   start event with `tool_name`, `params` (redacted for sensitive fields),
 *   `agent_aid`, and `tool_use_id`.
 *
 * - **PostToolUse** -- fires after a tool completes. Logs the tool call end
 *   event with `tool_use_id`, `duration_ms`, and `error` (if the tool failed).
 *
 * ```typescript
 * // Registered once per agent session at SDK init
 * const hooks = {
 *   PreToolUse: [new HookMatcher({ hooks: [async (input, toolUseId, ctx) => {
 *     logger.log({
 *       level: LogLevel.INFO,
 *       event_type: "tool_call_start",
 *       tool_name: input.tool_name,
 *       params: input.tool_input,  // redacted before storage
 *       agent_aid: containerConfig.agentAid,
 *       tool_use_id: toolUseId,
 *     });
 *     return {};
 *   }]})],
 *   PostToolUse: [new HookMatcher({ hooks: [async (output, toolUseId, ctx) => {
 *     logger.log({
 *       level: output.error ? LogLevel.ERROR : LogLevel.INFO,
 *       event_type: "tool_call_end",
 *       tool_use_id: toolUseId,
 *       duration_ms: output.duration_ms,
 *       error: output.error || null,
 *     });
 *     return {};
 *   }]})]
 * };
 * ```
 *
 * ## Structured Log Entries
 *
 * Each hook emits a structured log entry with these fields:
 *
 * | Field          | Source       | Description                                      |
 * |----------------|-------------|--------------------------------------------------|
 * | `tool_name`    | PreToolUse  | Name of the MCP tool being invoked               |
 * | `params`       | PreToolUse  | Tool input parameters (redacted for secrets)      |
 * | `agent_aid`    | Both        | Agent ID of the caller (from container config)    |
 * | `tool_use_id`  | Both        | SDK-assigned unique ID linking pre/post entries    |
 * | `duration_ms`  | PostToolUse | Wall-clock execution time of the tool call        |
 * | `error`        | PostToolUse | Error message if the tool call failed, else null  |
 *
 * The `params` field is redacted before storage to prevent credential leakage.
 * Fields containing known sensitive keys (e.g., `api_key`, `token`, `secret`,
 * `password`) are replaced with `"[REDACTED]"`.
 *
 * @module executor/hooks
 */

import type { Logger } from '../domain/index.js';

/**
 * Return type of {@link createSDKHooks}. Contains PreToolUse and PostToolUse
 * hook arrays ready to be passed to the Claude Agent SDK session initializer.
 *
 * The hook arrays follow the SDK's expected shape: each array contains
 * matcher objects that filter which tools trigger the hook and a list of
 * async hook functions.
 */
export interface SDKHooks {
  /** Hooks that fire before each tool invocation. */
  PreToolUse: unknown[];
  /** Hooks that fire after each tool invocation completes. */
  PostToolUse: unknown[];
}

/**
 * Creates PreToolUse and PostToolUse SDK hooks for automatic tool call logging.
 *
 * Call this once per agent session during SDK initialization. The returned hook
 * arrays should be spread into the SDK's session config to enable automatic
 * logging of every tool invocation.
 *
 * The hooks use the provided {@link Logger} instance to emit structured log
 * entries at `LogLevel.INFO` (for starts and successful completions) or
 * `LogLevel.ERROR` (for failed tool calls). Parameters are redacted before
 * logging to prevent credential leakage.
 *
 * @param _logger - Logger instance for emitting structured tool call log entries
 * @param _agentAid - Agent ID to include in every log entry for attribution
 * @returns An {@link SDKHooks} object with `PreToolUse` and `PostToolUse` arrays
 *
 * @example
 * ```typescript
 * const hooks = createSDKHooks(logger, 'aid-weather-alpha');
 * // Pass to SDK session:
 * // session.init({ ...config, hooks });
 * ```
 */
export function createSDKHooks(_logger: Logger, _agentAid: string): SDKHooks {
  throw new Error('Not implemented');
}
