/**
 * Active tool resolution — determines which tools a team is allowed to use.
 *
 * Extracted from mcp-bridge.ts for reuse without MCP transport dependency.
 */

/**
 * Resolve which tools are active based on allowed_tools config.
 *
 * Supports:
 * - '*' wildcard: allows all tools
 * - Exact names: 'Read', 'mcp__org__spawn_team'
 * - Glob prefixes: 'mcp__org__*' matches any tool starting with 'mcp__org__'
 *
 * Returns the subset of allToolNames that match allowed_tools.
 */
export function resolveActiveTools(
  allToolNames: string[],
  allowedTools: readonly string[],
): string[] {
  if (allowedTools.includes('*')) return [...allToolNames];

  const exactSet = new Set(allowedTools.filter((t) => !t.endsWith('*')));
  const prefixes = allowedTools
    .filter((t) => t.endsWith('*'))
    .map((t) => t.slice(0, -1));

  return allToolNames.filter(
    (name) =>
      exactSet.has(name) || prefixes.some((p) => name.startsWith(p)),
  );
}
