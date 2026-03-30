/**
 * Audit wrapper for AI SDK tools — timing, logging, credential scrubbing.
 *
 * Replaces PreToolUse/PostToolUse audit hooks without any dependency on
 * @anthropic-ai/claude-agent-sdk. Wraps a tool's `execute` callback with
 * pre/post logging, dynamic credential extraction, and scrub-before-truncate.
 */

import { scrubSecrets } from '../../logging/credential-scrubber.js';
import type { SecretString } from '../../secrets/secret-string.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface AuditLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
}

export interface AuditWrapperOpts {
  readonly logger: AuditLogger;
  readonly knownSecrets?: readonly SecretString[];
  readonly rawSecrets?: readonly string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract string values >= 8 chars from a `credentials` object on the
 * tool input, matching the dynamic extraction logic in the old audit hooks.
 */
function extractDynamicSecrets(input: unknown): readonly string[] {
  if (input == null || typeof input !== 'object') return [];
  const creds = (input as Record<string, unknown>).credentials;
  if (creds == null || typeof creds !== 'object' || Array.isArray(creds)) return [];
  return Object.values(creds as Record<string, unknown>)
    .filter((v): v is string => typeof v === 'string' && v.length >= 8);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Wrap a tool execute function with audit logging.
 *
 * The wrapper:
 * 1. Extracts dynamic credentials from `input.credentials` (values >= 8 chars)
 * 2. Logs `ToolCall:start` with scrubbed params
 * 3. Executes the original function
 * 4. Logs `ToolCall:end` with duration and scrubbed+truncated result
 * 5. On error, logs `ToolCall:error` with duration and re-throws
 *
 * @param name     Tool name for log entries.
 * @param execute  Original execute callback (first arg is tool input).
 * @param opts     Logger + known secrets for scrubbing.
 * @returns        Wrapped execute callback with identical signature.
 */
export function withAudit<TArgs extends unknown[], TReturn>(
  name: string,
  execute: (...args: TArgs) => Promise<TReturn>,
  opts: AuditWrapperOpts,
): (...args: TArgs) => Promise<TReturn> {
  return async (...args: TArgs): Promise<TReturn> => {
    const start = Date.now();
    const input = args[0];
    const knownSecrets = opts.knownSecrets ?? [];

    // Dynamic credential extraction (matches old audit-logger behavior)
    const dynamicSecrets = extractDynamicSecrets(input);
    const effectiveRawSecrets =
      dynamicSecrets.length > 0
        ? [...(opts.rawSecrets ?? []), ...dynamicSecrets]
        : (opts.rawSecrets ?? []);

    // Pre-log: scrubbed params
    const rawParams = JSON.stringify(input);
    const scrubbedJson = scrubSecrets(rawParams, knownSecrets, effectiveRawSecrets);
    let params: unknown;
    try {
      params = JSON.parse(scrubbedJson) as unknown;
    } catch {
      params = scrubbedJson;
    }
    opts.logger.info('ToolCall:start', { tool: name, params });

    // Execute
    let result: TReturn;
    try {
      result = await execute(...args);
    } catch (err) {
      const durationMs = Date.now() - start;
      opts.logger.info('ToolCall:error', {
        tool: name,
        durationMs,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    // Post-log: scrub BEFORE truncate to prevent partial secret leakage
    const summary = scrubSecrets(
      JSON.stringify(result),
      knownSecrets,
      effectiveRawSecrets,
    ).slice(0, 200);
    opts.logger.info('ToolCall:end', {
      tool: name,
      durationMs: Date.now() - start,
      summary,
    });

    return result;
  };
}
