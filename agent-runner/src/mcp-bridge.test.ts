import { describe, it, expect, vi } from 'vitest';
import { MCPBridge } from './mcp-bridge.js';
import type { WSMessage, ToolResultMsg, ToolCallMsg } from './types.js';
import { NullLogger } from './logger.js';

describe('MCPBridge', () => {
  it('sends tool call via WebSocket', async () => {
    const sentMessages: WSMessage[] = [];
    const bridge = new MCPBridge('aid-001', (msg) => sentMessages.push(msg), new NullLogger());

    // Start the tool call (it will be pending)
    const promise = bridge.callTool('get_config', { section: 'system' });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].type).toBe('tool_call');

    // Resolve it
    const toolCall = sentMessages[0].data as ToolCallMsg;
    const result: ToolResultMsg = {
      callId: toolCall.callId,
      result: { listen_address: '127.0.0.1:8080' },
    };
    bridge.handleToolResult(result);

    const response = await promise;
    expect(response).toEqual({ listen_address: '127.0.0.1:8080' });
  });

  it('rejects on error result', async () => {
    const bridge = new MCPBridge('aid-001', () => {}, new NullLogger());

    const promise = bridge.callTool('create_team', { slug: 'bad-team' });

    // Get the call_id from the pending count
    expect(bridge.pendingCount()).toBe(1);

    // Send error result - we need the call_id
    const sentMessages: WSMessage[] = [];
    const bridge2 = new MCPBridge('aid-001', (msg) => sentMessages.push(msg), new NullLogger());
    const promise2 = bridge2.callTool('get_config', {});

    const toolCall = sentMessages[0].data as ToolCallMsg;
    bridge2.handleToolResult({
      callId: toolCall.callId,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: 'slug is invalid',
    });

    await expect(promise2).rejects.toThrow('VALIDATION_ERROR');

    // Clean up first bridge
    bridge.rejectAll('cleanup');
    await expect(promise).rejects.toThrow('cleanup');
  });

  it('rejects on timeout', async () => {
    vi.useFakeTimers();

    const bridge = new MCPBridge('aid-001', () => {}, new NullLogger());
    const promise = bridge.callTool('get_config', {});

    // Fast-forward past query timeout (10s)
    vi.advanceTimersByTime(11_000);

    await expect(promise).rejects.toThrow('timed out');
    expect(bridge.pendingCount()).toBe(0);

    vi.useRealTimers();
  });

  it('rejects all pending on disconnect', async () => {
    const bridge = new MCPBridge('aid-001', () => {}, new NullLogger());
    const p1 = bridge.callTool('get_config', {}).catch((e: Error) => e);
    const p2 = bridge.callTool('list_channels', {}).catch((e: Error) => e);

    expect(bridge.pendingCount()).toBe(2);

    bridge.rejectAll('WebSocket disconnected');

    const err1 = await p1;
    const err2 = await p2;
    expect(err1).toBeInstanceOf(Error);
    expect((err1 as Error).message).toContain('WebSocket disconnected');
    expect(err2).toBeInstanceOf(Error);
    expect((err2 as Error).message).toContain('WebSocket disconnected');
    expect(bridge.pendingCount()).toBe(0);
  });

  it('ignores unknown call_id', () => {
    const bridge = new MCPBridge('aid-001', () => {}, new NullLogger());

    // Should not throw -- warn is logged via NullLogger (no-op)
    expect(() => {
      bridge.handleToolResult({
        callId: 'unknown-id',
        result: {},
      });
    }).not.toThrow();
  });

  it('reports pending count correctly', async () => {
    const bridge = new MCPBridge('aid-001', () => {}, new NullLogger());
    expect(bridge.pendingCount()).toBe(0);

    const p1 = bridge.callTool('get_config', {}).catch(() => {});
    expect(bridge.pendingCount()).toBe(1);

    const p2 = bridge.callTool('list_channels', {}).catch(() => {});
    expect(bridge.pendingCount()).toBe(2);

    bridge.rejectAll('cleanup');
    expect(bridge.pendingCount()).toBe(0);

    await p1;
    await p2;
  });

  it('handles multiple concurrent tool calls independently', async () => {
    const sentMessages: WSMessage[] = [];
    const bridge = new MCPBridge('aid-001', (msg) => sentMessages.push(msg), new NullLogger());

    const p1 = bridge.callTool('get_config', {});
    const p2 = bridge.callTool('list_channels', {});

    expect(sentMessages).toHaveLength(2);

    const call1 = sentMessages[0].data as ToolCallMsg;
    const call2 = sentMessages[1].data as ToolCallMsg;

    // Resolve in reverse order
    bridge.handleToolResult({ callId: call2.callId, result: { channels: [] } });
    bridge.handleToolResult({ callId: call1.callId, result: { config: {} } });

    const result1 = await p1;
    const result2 = await p2;

    expect(result1).toEqual({ config: {} });
    expect(result2).toEqual({ channels: [] });
  });
});
