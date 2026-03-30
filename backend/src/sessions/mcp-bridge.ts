/**
 * MCP bridge — connects to MCP servers using @ai-sdk/mcp createMCPClient.
 * Replaces the old mcp-builder.ts that just built config objects for the Claude SDK.
 *
 * Defense layer: teams can only connect to explicitly listed servers.
 * Unknown server names are silently skipped (no crash).
 */

import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';

// ── Types ────────────────────────────────────────────────────────────────────

/** Tool type returned by MCPClient.tools() — Record<string, Tool-with-execute>. */
type McpTools = Awaited<ReturnType<MCPClient['tools']>>;

export interface McpBridgeResult {
  /** Discovered MCP tools, namespaced as mcp__{server}__{toolName}. */
  readonly tools: McpTools;
  /** Cleanup function — closes all MCP client connections. */
  readonly cleanup: () => Promise<void>;
}

export interface ConnectMcpServersOpts {
  /** Server names listed in team.yaml mcp_servers. */
  readonly configMcpServers: readonly string[];
  /** Port where the org-MCP HTTP server listens (default 3001). */
  readonly orgMcpPort: number;
  /** Team name, sent as X-Caller-Id header. */
  readonly teamName: string;
  /** Source channel ID for notification routing. */
  readonly sourceChannelId?: string;
}

// ── connectMcpServers ────────────────────────────────────────────────────────

/**
 * Connect to MCP servers listed in team config and discover their tools.
 *
 * Each server's tools are namespaced as `mcp__{serverName}__{toolName}`
 * to avoid collisions across servers and with built-in tools.
 *
 * Currently supports the 'org' server (Streamable HTTP transport on localhost).
 * Unknown server names are silently skipped — no crash.
 */
export async function connectMcpServers(
  opts: ConnectMcpServersOpts,
): Promise<McpBridgeResult> {
  const clients: MCPClient[] = [];
  const allTools: McpTools = {};

  for (const serverName of opts.configMcpServers) {
    if (serverName === 'org') {
      const headers: Record<string, string> = {
        'X-Caller-Id': opts.teamName,
      };
      if (opts.sourceChannelId) {
        headers['X-Source-Channel'] = opts.sourceChannelId;
      }

      const client = await createMCPClient({
        transport: {
          type: 'http',
          url: `http://127.0.0.1:${opts.orgMcpPort}/mcp`,
          headers,
        },
      });
      clients.push(client);

      const tools = await client.tools();
      for (const [toolName, tool] of Object.entries(tools)) {
        allTools[`mcp__${serverName}__${toolName}`] = tool;
      }
    }
    // Unknown server names: skip silently (don't crash).
    // Future: add support for additional MCP servers beyond 'org'.
  }

  return {
    tools: allTools,
    cleanup: async () => {
      for (const client of clients) {
        try {
          await client.close();
        } catch {
          // Ignore cleanup errors — the process may be shutting down.
        }
      }
    },
  };
}

// ── resolveActiveTools ───────────────────────────────────────────────────────

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
