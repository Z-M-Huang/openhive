/**
 * MCP Server Factory — Creates an in-process MCP server exposing SDK custom tools.
 *
 * Per CLAUDE.md Critical Pattern #2: "Internal management tools are exposed to
 * the Claude Agent SDK as an MCP server process." This module bridges SDK_TOOLS
 * definitions with the Claude Agent SDK's MCP server mechanism.
 *
 * Tool call flow: SDK → MCP Server (in-process) → MCPBridge → WebSocket → Go Backend → Result
 */

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { MCPBridge } from './mcp-bridge.js';
import type { JSONValue } from './types.js';
import { SDK_TOOLS, type JSONSchemaProperty } from './sdk-tools.js';

/**
 * Convert a JSON Schema property to a Zod type for MCP tool registration.
 * Handles the subset of JSON Schema types used in SDK_TOOLS definitions.
 */
export function toZodType(prop: JSONSchemaProperty, isRequired: boolean): z.ZodTypeAny {
  let zodType: z.ZodTypeAny;

  if (prop.enum && prop.enum.length > 0) {
    zodType = z.enum(prop.enum as [string, ...string[]]);
  } else {
    switch (prop.type) {
      case 'number':
        zodType = z.number();
        break;
      case 'string':
      default:
        zodType = z.string();
        break;
    }
  }

  if (prop.description) {
    zodType = zodType.describe(prop.description);
  }

  if (!isRequired) {
    zodType = zodType.optional();
  }

  return zodType;
}

/**
 * Create an in-process MCP server that exposes SDK custom tools.
 * Each tool handler forwards calls via the MCPBridge to the Go backend.
 *
 * Returns a McpSdkServerConfigWithInstance that can be passed to the SDK's
 * query() options.mcpServers. The SDK manages the server lifecycle.
 */
export function createToolsMcpServer(bridge: MCPBridge): McpSdkServerConfigWithInstance {
  const tools: SdkMcpToolDefinition<Record<string, z.ZodTypeAny>>[] = SDK_TOOLS.map((def) => {
    const zodShape: Record<string, z.ZodTypeAny> = {};
    const required = new Set(def.parameters.required ?? []);

    for (const [key, prop] of Object.entries(def.parameters.properties)) {
      zodShape[key] = toZodType(prop, required.has(key));
    }

    return {
      name: def.name,
      description: def.description,
      inputSchema: zodShape,
      handler: async (args: Record<string, unknown>): Promise<CallToolResult> => {
        try {
          const result = await bridge.callTool(def.name, args as Record<string, JSONValue>);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result ?? { success: true }) }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          };
        }
      },
    };
  });

  return createSdkMcpServer({
    name: 'openhive-tools',
    version: '0.1.0',
    tools,
  });
}
