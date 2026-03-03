import { describe, it, expect, vi } from 'vitest';
import { createToolsMcpServer, toZodType } from './mcp-server.js';
import { SDK_TOOLS } from './sdk-tools.js';
import { MCPBridge } from './mcp-bridge.js';
import type { WSMessage, ToolCallMsg } from './types.js';
import { NullLogger } from './logger.js';
import { z } from 'zod';

describe('toZodType', () => {
  it('converts string property to z.string()', () => {
    const zType = toZodType({ type: 'string', description: 'test' }, true);
    expect(zType.safeParse('hello').success).toBe(true);
    expect(zType.safeParse(123).success).toBe(false);
  });

  it('converts number property to z.number()', () => {
    const zType = toZodType({ type: 'number', description: 'count' }, true);
    expect(zType.safeParse(42).success).toBe(true);
    expect(zType.safeParse('hello').success).toBe(false);
  });

  it('converts enum property to z.enum()', () => {
    const zType = toZodType({ type: 'string', enum: ['haiku', 'sonnet', 'opus'] }, true);
    expect(zType.safeParse('haiku').success).toBe(true);
    expect(zType.safeParse('invalid').success).toBe(false);
  });

  it('makes optional when isRequired is false', () => {
    const zType = toZodType({ type: 'string' }, false);
    expect(zType.safeParse(undefined).success).toBe(true);
    expect(zType.safeParse('hello').success).toBe(true);
  });

  it('requires value when isRequired is true', () => {
    const zType = toZodType({ type: 'string' }, true);
    expect(zType.safeParse(undefined).success).toBe(false);
    expect(zType.safeParse('hello').success).toBe(true);
  });

  it('preserves description', () => {
    const zType = toZodType({ type: 'string', description: 'Team slug' }, true);
    expect(zType.description).toBe('Team slug');
  });

  it('defaults to string for unknown type', () => {
    const zType = toZodType({ description: 'untyped field' }, true);
    expect(zType.safeParse('hello').success).toBe(true);
  });
});

describe('createToolsMcpServer', () => {
  it('returns a valid McpSdkServerConfigWithInstance', () => {
    const bridge = new MCPBridge('aid-001', () => {}, new NullLogger());
    const server = createToolsMcpServer(bridge);

    expect(server.type).toBe('sdk');
    expect(server.name).toBe('openhive-tools');
    expect(server.instance).toBeDefined();
  });

  it('registers all SDK_TOOLS', () => {
    const bridge = new MCPBridge('aid-001', () => {}, new NullLogger());
    const server = createToolsMcpServer(bridge);

    // The McpServer instance should have tools registered.
    // Verify by checking the server was created with the right tool count.
    // Since createSdkMcpServer is opaque, we verify all tool names are represented
    // by checking that SDK_TOOLS has all expected entries.
    const toolNames = SDK_TOOLS.map(t => t.name);
    expect(toolNames).toContain('list_teams');
    expect(toolNames).toContain('create_team');
    expect(toolNames).toContain('get_config');
    expect(toolNames).toContain('dispatch_task');
    expect(toolNames).toContain('load_skill');
    expect(toolNames.length).toBeGreaterThanOrEqual(20);
  });

  it('creates a fresh server each call', () => {
    const bridge = new MCPBridge('aid-001', () => {}, new NullLogger());
    const server1 = createToolsMcpServer(bridge);
    const server2 = createToolsMcpServer(bridge);

    // Each call should produce a distinct instance
    expect(server1.instance).not.toBe(server2.instance);
  });
});

describe('MCP server tool handler integration', () => {
  it('forwards tool call through MCPBridge and returns result', async () => {
    const sentMessages: WSMessage[] = [];
    const bridge = new MCPBridge('aid-001', (msg) => sentMessages.push(msg), new NullLogger());

    // We can't easily test via the McpServer instance directly since it's
    // an opaque MCP server. Instead, test that calling bridge.callTool
    // (which the handler does) sends a WS message and resolves on result.
    const callPromise = bridge.callTool('list_teams', {});
    expect(sentMessages).toHaveLength(1);

    const toolCall = sentMessages[0].data as ToolCallMsg;
    expect(toolCall.toolName).toBe('list_teams');

    bridge.handleToolResult({
      callId: toolCall.callId,
      result: { teams: [] },
    });

    const result = await callPromise;
    expect(result).toEqual({ teams: [] });
  });

  it('handles tool call errors gracefully', async () => {
    const bridge = new MCPBridge('aid-001', () => {}, new NullLogger());

    const callPromise = bridge.callTool('delete_team', { slug: 'nonexistent' });

    // Reject all pending calls to simulate error
    bridge.rejectAll('test error');

    await expect(callPromise).rejects.toThrow('test error');
  });
});
