/**
 * canUseTool callback factory.
 *
 * Deny-by-default: only tools explicitly listed in allowedTools are permitted.
 * Two match modes: exact string match, or prefix match (entry ends with '*').
 * Bash is denied unless explicitly listed.
 */

interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
}

export interface CanUseToolResult {
  readonly allowed: boolean;
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
): (toolName: string) => CanUseToolResult {
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

  return (toolName: string): CanUseToolResult => {
    if (allowAll) return { allowed: true };

    if (exactSet.has(toolName)) {
      return { allowed: true };
    }

    for (const prefix of prefixes) {
      if (toolName.startsWith(prefix)) {
        return { allowed: true };
      }
    }

    logger?.info('canUseTool denied', { tool: toolName });
    return { allowed: false };
  };
}
