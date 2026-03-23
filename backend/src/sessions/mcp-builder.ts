/**
 * MCP server builder — filters available MCP servers to only those
 * listed in the team's configuration.
 *
 * Defense layer 1: teams can only access explicitly listed servers.
 * Unknown servers are silently skipped (no crash).
 */

/**
 * Build the mcpServers object for SDK query() options.
 *
 * @param configMcpServers   Server names listed in team.yaml mcp_servers.
 * @param availableServers   All MCP servers available in the environment.
 * @returns Filtered subset of availableServers matching configMcpServers.
 */
export function buildMcpServers(
  configMcpServers: readonly string[],
  availableServers: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const name of configMcpServers) {
    if (name in availableServers) {
      result[name] = availableServers[name];
    }
    // Unknown server: skip silently (don't crash)
  }

  return result;
}
