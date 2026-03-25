/**
 * canUseTool callback factory.
 *
 * Deny-by-default: only tools explicitly listed in allowedTools are permitted.
 * Two match modes: exact string match, or prefix match (entry ends with '*').
 * Bash is denied unless explicitly listed.
 */

import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';

interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Create a canUseTool callback that checks tool names against an allow-list.
 *
 * @param allowedTools  Entries like 'Read', 'mcp__org__*', 'Bash'.
 * @param logger        Logger for denied-attempt auditing.
 */
export function createCanUseTool(
  allowedTools: readonly string[],
  logger?: Logger,
): CanUseTool {
  // Pre-split into exact matches and prefix entries for O(1)/O(n) lookup.
  const exactSet = new Set<string>();
  const prefixes: string[] = [];

  for (const entry of allowedTools) {
    if (entry.endsWith('*')) {
      prefixes.push(entry.slice(0, -1));
    } else {
      exactSet.add(entry);
    }
  }

  // '*' alone means allow everything
  const allowAll = exactSet.has('*') || prefixes.some(p => p === '');

  return async (toolName: string, _input, _options): Promise<PermissionResult> => {
    if (allowAll) return { behavior: 'allow' };

    if (exactSet.has(toolName)) {
      return { behavior: 'allow' };
    }

    for (const prefix of prefixes) {
      if (toolName.startsWith(prefix)) {
        return { behavior: 'allow' };
      }
    }

    logger?.info('canUseTool denied', { tool: toolName });
    return { behavior: 'deny', message: `Tool '${toolName}' not in allowed_tools` };
  };
}
