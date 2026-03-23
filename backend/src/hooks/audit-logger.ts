/**
 * Audit-logger hooks for PreToolUse and PostToolUse.
 *
 * Records tool invocations with timing data. Redacts values that
 * look like secrets using the credential scrubber (pattern-based +
 * known-secret matching).
 */

import { scrubSecrets } from '../logging/credential-scrubber.js';
import type { SecretString } from '../secrets/secret-string.js';
import type { PreToolUseHook } from './workspace-boundary.js';

export type PostToolUseHook = (
  input: { tool_name: string; tool_input: Record<string, unknown> },
  toolUseId: string | undefined,
  context: { session_id?: string; [key: string]: unknown },
  result?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

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
): { hook: PreToolUseHook; startTimes: Map<string, number> } {
  const startTimes = new Map<string, number>();

  const hook: PreToolUseHook = (input, toolUseId) => {
    const now = Date.now();
    if (toolUseId) {
      startTimes.set(toolUseId, now);
    }
    const rawParams = JSON.stringify(input.tool_input);
    const scrubbedJson = scrubSecrets(rawParams, knownSecrets);
    let params: unknown;
    try {
      params = JSON.parse(scrubbedJson) as unknown;
    } catch {
      params = scrubbedJson;
    }
    logger.info('PreToolUse', {
      tool: input.tool_name,
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
): PostToolUseHook {
  return (input, toolUseId, _context, result) => {
    const start = toolUseId ? startTimes.get(toolUseId) : undefined;
    const durationMs = start !== undefined ? Date.now() - start : undefined;

    if (toolUseId) {
      startTimes.delete(toolUseId);
    }

    // Scrub BEFORE truncating to prevent partial secret leakage at cutoff
    const summary = result
      ? scrubSecrets(JSON.stringify(result), knownSecrets).slice(0, 200)
      : undefined;

    logger.info('PostToolUse', {
      tool: input.tool_name,
      toolUseId,
      durationMs,
      summary,
    });

    return Promise.resolve({});
  };
}
