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

import type { Logger, ToolCallStore, LogStore } from '../domain/index.js';
import { LogLevel } from '../domain/index.js';

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

/** Keys whose values are redacted before logging. */
const SENSITIVE_KEYS = new Set(['api_key', 'token', 'secret', 'password']);

/**
 * Returns a shallow copy of `params` with sensitive values replaced by
 * `'[REDACTED]'`. Only top-level keys are checked (case-insensitive).
 */
export function redactParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : value;
  }
  return out;
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
 * @param logger - Logger instance for emitting structured tool call log entries
 * @param agentAid - Agent ID to include in every log entry for attribution
 * @returns An {@link SDKHooks} object with `PreToolUse` and `PostToolUse` arrays
 *
 * @example
 * ```typescript
 * const hooks = createSDKHooks(logger, 'aid-weather-alpha');
 * // Pass to SDK session:
 * // session.init({ ...config, hooks });
 * ```
 */
/** Options for tool_calls table logging in createSDKHooks. */
export interface SDKHookOptions {
  toolCallStore?: ToolCallStore;
  logStore?: LogStore;
  teamSlug?: string;
}

export function createSDKHooks(logger: Logger, agentAid: string, options?: SDKHookOptions): SDKHooks {
  // Track start time + tool name from preToolUse so postToolUse can log to tool_calls
  const startTimes = new Map<string, { start: number; toolName: string }>();

  const preToolUse = async (input: {
    tool_name: string;
    tool_input: Record<string, unknown>;
    tool_use_id: string;
  }): Promise<Record<string, never>> => {
    startTimes.set(input.tool_use_id, { start: Date.now(), toolName: input.tool_name });
    const redacted = redactParams(input.tool_input);
    logger.log({
      level: LogLevel.Info,
      message: 'tool_call_start',
      event_type: 'tool_call_start',
      agent_aid: agentAid,
      params: JSON.stringify({
        tool_name: input.tool_name,
        tool_use_id: input.tool_use_id,
        tool_input: redacted,
      }),
    });
    return {};
  };

  const postToolUse = async (input: {
    tool_use_id: string;
    error?: string;
  }): Promise<Record<string, never>> => {
    const info = startTimes.get(input.tool_use_id);
    const durationMs = info ? Date.now() - info.start : 0;
    const toolName = info?.toolName ?? 'unknown';
    startTimes.delete(input.tool_use_id);

    logger.log({
      level: input.error ? LogLevel.Error : LogLevel.Info,
      message: 'tool_call_end',
      event_type: 'tool_call_end',
      agent_aid: agentAid,
      duration_ms: durationMs,
      error: input.error ?? '',
      params: JSON.stringify({ tool_use_id: input.tool_use_id, tool_name: toolName }),
    });

    // Best-effort write to tool_calls table (main assistant tool calls)
    if (options?.toolCallStore && options?.logStore) {
      try {
        const [logEntryId] = await options.logStore.createWithIds([{
          id: 0,
          level: LogLevel.Info,
          event_type: 'tool_call',
          component: 'executor',
          action: toolName,
          message: 'tool_call',
          params: JSON.stringify({ tool_name: toolName }),
          team_slug: options.teamSlug ?? '',
          task_id: '',
          agent_aid: agentAid,
          request_id: '',
          correlation_id: input.tool_use_id,
          error: input.error ?? '',
          duration_ms: durationMs,
          created_at: Date.now(),
        }]);
        await options.toolCallStore.create({
          id: 0,
          log_entry_id: logEntryId,
          tool_use_id: input.tool_use_id,
          tool_name: toolName,
          agent_aid: agentAid,
          team_slug: options.teamSlug ?? '',
          task_id: '',
          params: JSON.stringify({ tool_name: toolName }),
          result_summary: '',
          error: input.error ?? '',
          duration_ms: durationMs,
          created_at: Date.now(),
        });
      } catch {
        // Best-effort — don't break tool execution
      }
    }

    return {};
  };

  return {
    PreToolUse: [preToolUse],
    PostToolUse: [postToolUse],
  };
}
