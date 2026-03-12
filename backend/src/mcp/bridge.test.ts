/**
 * Tests for MCPBridgeImpl — WS<->MCP tool call correlation and timeout management.
 *
 * @module mcp/bridge.test
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  MCPBridgeImpl,
  TIMEOUT_QUERY_MS,
  TIMEOUT_MUTATING_MS,
  TIMEOUT_BLOCKING_MS,
  type WSSendFn,
} from './bridge.js';
import { InternalError } from '../domain/errors.js';

describe('MCPBridgeImpl', () => {
  let bridge: MCPBridgeImpl;
  let sendFn: ReturnType<typeof vi.fn<WSSendFn>>;

  beforeEach(() => {
    vi.useFakeTimers();
    sendFn = vi.fn<WSSendFn>();
    bridge = new MCPBridgeImpl(sendFn);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('callTool + handleResult', () => {
    it('resolves when handleResult is called with matching call_id', async () => {
      const promise = bridge.callTool('get_team', { slug: 'test' }, 'aid-test-1234');

      expect(sendFn).toHaveBeenCalledOnce();
      const sent = sendFn.mock.calls[0][0] as Record<string, unknown>;
      expect(sent.type).toBe('tool_call');

      const data = sent.data as Record<string, unknown>;
      expect(data.tool_name).toBe('get_team');
      expect(data.arguments).toEqual({ slug: 'test' });
      expect(data.agent_aid).toBe('aid-test-1234');
      expect(typeof data.call_id).toBe('string');

      const callId = data.call_id as string;
      const expectedResult = { name: 'test-team', status: 'active' };

      bridge.handleResult(callId, expectedResult);

      const result = await promise;
      expect(result).toEqual(expectedResult);
      expect(bridge.getPendingCalls()).toBe(0);
    });
  });

  describe('callTool + handleError', () => {
    it('rejects with InternalError when handleError is called', async () => {
      const promise = bridge.callTool('create_team', { slug: 'bad' }, 'aid-test-1234');

      const sent = sendFn.mock.calls[0][0] as Record<string, unknown>;
      const data = sent.data as Record<string, unknown>;
      const callId = data.call_id as string;

      bridge.handleError(callId, 'ACCESS_DENIED', 'Not authorized');

      await expect(promise).rejects.toThrow(InternalError);
      await expect(promise).rejects.toThrow('Not authorized');
      expect(bridge.getPendingCalls()).toBe(0);
    });
  });

  describe('timeout', () => {
    it('rejects after query tool timeout elapses', async () => {
      const promise = bridge.callTool('get_team', { slug: 'slow' }, 'aid-test-1234');

      expect(bridge.getPendingCalls()).toBe(1);

      vi.advanceTimersByTime(TIMEOUT_QUERY_MS);

      await expect(promise).rejects.toThrow(InternalError);
      await expect(promise).rejects.toThrow('Tool call timed out');
      expect(bridge.getPendingCalls()).toBe(0);
    });

    it('uses mutating timeout for mutating tools', async () => {
      const promise = bridge.callTool('create_team', { slug: 'x' }, 'aid-test-1234');

      // Should NOT time out at query threshold
      vi.advanceTimersByTime(TIMEOUT_QUERY_MS);
      expect(bridge.getPendingCalls()).toBe(1);

      // Should time out at mutating threshold
      vi.advanceTimersByTime(TIMEOUT_MUTATING_MS - TIMEOUT_QUERY_MS);

      await expect(promise).rejects.toThrow('Tool call timed out');
      expect(bridge.getPendingCalls()).toBe(0);
    });

    it('uses blocking timeout for blocking tools', async () => {
      const promise = bridge.callTool('spawn_container', { image: 'openhive' }, 'aid-test-1234');

      // Should NOT time out at mutating threshold
      vi.advanceTimersByTime(TIMEOUT_MUTATING_MS);
      expect(bridge.getPendingCalls()).toBe(1);

      // Should time out at blocking threshold
      vi.advanceTimersByTime(TIMEOUT_BLOCKING_MS - TIMEOUT_MUTATING_MS);

      await expect(promise).rejects.toThrow('Tool call timed out');
      expect(bridge.getPendingCalls()).toBe(0);
    });
  });

  describe('getPendingCalls', () => {
    it('tracks the number of pending calls', async () => {
      expect(bridge.getPendingCalls()).toBe(0);

      bridge.callTool('get_team', {}, 'aid-a-1');
      expect(bridge.getPendingCalls()).toBe(1);

      bridge.callTool('get_task', {}, 'aid-b-2');
      expect(bridge.getPendingCalls()).toBe(2);

      // Resolve one
      const sent = sendFn.mock.calls[0][0] as Record<string, unknown>;
      const data = sent.data as Record<string, unknown>;
      bridge.handleResult(data.call_id as string, { ok: true });

      expect(bridge.getPendingCalls()).toBe(1);
    });
  });

  describe('unknown callId', () => {
    it('handleResult is a no-op for unknown call_id', () => {
      expect(() => bridge.handleResult('nonexistent-id', { data: 1 })).not.toThrow();
      expect(bridge.getPendingCalls()).toBe(0);
    });

    it('handleError is a no-op for unknown call_id', () => {
      expect(() => bridge.handleError('nonexistent-id', 'ERR', 'msg')).not.toThrow();
      expect(bridge.getPendingCalls()).toBe(0);
    });
  });

  describe('cancelAll', () => {
    it('rejects all pending calls with the given reason', async () => {
      const p1 = bridge.callTool('get_team', {}, 'aid-a-1');
      const p2 = bridge.callTool('create_team', {}, 'aid-b-2');
      const p3 = bridge.callTool('spawn_container', {}, 'aid-c-3');

      expect(bridge.getPendingCalls()).toBe(3);

      bridge.cancelAll('Shutting down');

      expect(bridge.getPendingCalls()).toBe(0);

      await expect(p1).rejects.toThrow(InternalError);
      await expect(p1).rejects.toThrow('Shutting down');
      await expect(p2).rejects.toThrow('Shutting down');
      await expect(p3).rejects.toThrow('Shutting down');
    });
  });

  describe('sensitive field redaction in logs', () => {
    it('redacts sensitive fields in logged args but sends originals over WS', () => {
      const loggerDebug = vi.fn();
      const logger = {
        trace: vi.fn(), debug: loggerDebug, info: vi.fn(),
        warn: vi.fn(), error: vi.fn(), audit: vi.fn(),
        log: vi.fn(), flush: vi.fn(), stop: vi.fn(),
      };

      const bridgeWithLogger = new MCPBridgeImpl(sendFn, logger);

      const sensitiveArgs = {
        name: 'discord',
        api_key: 'val_a',
        secret: 'val_b',
        normal_field: 'visible',
      };

      bridgeWithLogger.callTool('set_credential', sensitiveArgs, 'aid-test-1234');

      // The WS message should contain original (unredacted) args
      const sent = sendFn.mock.calls[0][0] as Record<string, unknown>;
      const data = sent.data as Record<string, unknown>;
      const wsArgs = data.arguments as Record<string, unknown>;
      expect(wsArgs.api_key).toBe('val_a');
      expect(wsArgs.secret).toBe('val_b');
      expect(wsArgs.normal_field).toBe('visible');

      // The logger should have been called with redacted args
      expect(loggerDebug).toHaveBeenCalled();
      const logCall = loggerDebug.mock.calls[0];
      const logParams = logCall[1] as Record<string, unknown>;
      const loggedArgs = logParams.args as Record<string, unknown>;
      expect(loggedArgs.api_key).toBe('[REDACTED]');
      expect(loggedArgs.secret).toBe('[REDACTED]');
      expect(loggedArgs.normal_field).toBe('visible');
    });
  });

  describe('getTimeoutForTool', () => {
    it('returns query timeout for query tools', () => {
      expect(bridge.getTimeoutForTool('get_team')).toBe(TIMEOUT_QUERY_MS);
      expect(bridge.getTimeoutForTool('list_containers')).toBe(TIMEOUT_QUERY_MS);
    });

    it('returns blocking timeout for blocking tools', () => {
      expect(bridge.getTimeoutForTool('spawn_container')).toBe(TIMEOUT_BLOCKING_MS);
    });

    it('returns mutating timeout for mutating tools', () => {
      expect(bridge.getTimeoutForTool('create_team')).toBe(TIMEOUT_MUTATING_MS);
    });

    it('returns mutating timeout for unknown tools', () => {
      expect(bridge.getTimeoutForTool('unknown_tool')).toBe(TIMEOUT_MUTATING_MS);
    });
  });
});
