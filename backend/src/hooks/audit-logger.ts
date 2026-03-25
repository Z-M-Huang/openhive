/**
 * Audit-logger hooks for PreToolUse and PostToolUse.
 *
 * Records tool invocations with timing data. Redacts values that
 * look like secrets using the credential scrubber (pattern-based +
 * known-secret matching).
 */

import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { scrubSecrets } from '../logging/credential-scrubber.js';
import type { SecretString } from '../secrets/secret-string.js';

/**
 * Factory: create an audit PreToolUse hook.
 * Records start time and logs the tool call.
 *
 * @param logger        Logger with info method.
 * @param knownSecrets  Known secret values to scrub from logged output.
 */
export function createAuditPreHook(
  logger: { info: (msg: string, meta?: Record<string, unknown>) => void },
  knownSecrets: readonly SecretString[] = [],
): { hook: HookCallback; startTimes: Map<string, number> } {
  const startTimes = new Map<string, number>();

  const hook: HookCallback = (input, toolUseId) => {
    const { tool_name, tool_input } = input as { tool_name: string; tool_input: unknown };
    const now = Date.now();
    if (toolUseId) {
      startTimes.set(toolUseId, now);
    }
    const rawParams = JSON.stringify(tool_input);
    const scrubbedJson = scrubSecrets(rawParams, knownSecrets);
    let params: unknown;
    try {
      params = JSON.parse(scrubbedJson) as unknown;
    } catch {
      params = scrubbedJson;
    }
    logger.info('PreToolUse', {
      tool: tool_name,
      params,
      toolUseId,
    });
    return Promise.resolve({});
  };

  return { hook, startTimes };
}

/**
 * Factory: create an audit PostToolUse hook.
 * Logs completion with duration. Scrubs secrets from result summary.
 *
 * @param logger        Logger with info method.
 * @param startTimes    Shared start-time map from createAuditPreHook.
 * @param knownSecrets  Known secret values to scrub from logged output.
 */
export function createAuditPostHook(
  logger: { info: (msg: string, meta?: Record<string, unknown>) => void },
  startTimes: Map<string, number>,
  knownSecrets: readonly SecretString[] = [],
): HookCallback {
  return (input, toolUseId) => {
    const { tool_name, tool_response } = input as { tool_name: string; tool_response?: unknown };
    const start = toolUseId ? startTimes.get(toolUseId) : undefined;
    const durationMs = start !== undefined ? Date.now() - start : undefined;

    if (toolUseId) {
      startTimes.delete(toolUseId);
    }

    // Scrub BEFORE truncating to prevent partial secret leakage at cutoff
    const summary = tool_response
      ? scrubSecrets(JSON.stringify(tool_response), knownSecrets).slice(0, 200)
      : undefined;

    logger.info('PostToolUse', {
      tool: tool_name,
      toolUseId,
      durationMs,
      summary,
    });

    return Promise.resolve({});
  };
}
