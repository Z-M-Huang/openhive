/**
 * Layer 4 Phase Gate: WebSocket integration tests.
 *
 * Tests TokenManager lifecycle, WSServer upgrade flow, WSHub routing
 * (INV-02/INV-03), write queue overflow, rate limiting, per-message-type
 * Zod validation, and end-to-end wiring of WSServer + WSHub + TokenManager.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WSConnection, WSMessage } from '../domain/interfaces.js';
import { TokenManagerImpl } from '../websocket/token-manager.js';
import { WSServer, validateMessagePayload } from '../websocket/server.js';
import { WSHubImpl } from '../websocket/hub.js';
import { ValidationError, NotFoundError, RateLimitedError } from '../domain/errors.js';
import { validateDirection } from '../websocket/protocol.js';

// ---------------------------------------------------------------------------
// Test helpers: mock WSConnection
// ---------------------------------------------------------------------------

function createMockConnection(tid: string, alive = true): WSConnection {
  return {
    tid,
    send: vi.fn(),
    close: vi.fn(),
    onMessage: vi.fn(),
    onClose: vi.fn(),
    isAlive: vi.fn().mockReturnValue(alive),
  };
}

// ---------------------------------------------------------------------------
// Test helpers: mock HTTP socket
// ---------------------------------------------------------------------------

function createMockSocket(): { write: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> } {
  return {
    write: vi.fn(),
    destroy: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// 1. TokenManager lifecycle
// ---------------------------------------------------------------------------

describe('Layer 4: WebSocket', () => {
  describe('TokenManager lifecycle', () => {
    let tokenManager: TokenManagerImpl;

    beforeEach(() => {
      tokenManager = new TokenManagerImpl({ ttlMs: 300_000 });
    });

    afterEach(() => {
      tokenManager.stopCleanup();
    });

    it('should generate a 64-character hex token', () => {
      const token = tokenManager.generate('tid-team-abc123');
      expect(token).toHaveLength(64);
      expect(token).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should validate a token with the correct TID', () => {
      const tid = 'tid-team-abc123';
      const token = tokenManager.generate(tid);
      expect(tokenManager.validate(token, tid)).toBe(true);
    });

    it('should reject a token on second validation (single-use)', () => {
      const tid = 'tid-team-abc123';
      const token = tokenManager.generate(tid);

      expect(tokenManager.validate(token, tid)).toBe(true);
      expect(tokenManager.validate(token, tid)).toBe(false);
    });

    it('should reject a token with wrong TID', () => {
      const token = tokenManager.generate('tid-team-abc123');
      expect(tokenManager.validate(token, 'tid-wrong-999999')).toBe(false);
    });

    it('should reject an expired token', () => {
      const manager = new TokenManagerImpl({ ttlMs: 1 });
      const token = manager.generate('tid-team-abc123');

      // Force expiry by manipulating time
      vi.useFakeTimers();
      vi.advanceTimersByTime(10);
      expect(manager.validate(token, 'tid-team-abc123')).toBe(false);
      vi.useRealTimers();
    });

    it('should revoke a specific token', () => {
      const token = tokenManager.generate('tid-team-abc123');
      tokenManager.revoke(token);
      expect(tokenManager.validate(token, 'tid-team-abc123')).toBe(false);
    });

    it('should revoke all tokens', () => {
      const t1 = tokenManager.generate('tid-team-abc123');
      const t2 = tokenManager.generate('tid-team-def456');
      tokenManager.revokeAll();
      expect(tokenManager.validate(t1, 'tid-team-abc123')).toBe(false);
      expect(tokenManager.validate(t2, 'tid-team-def456')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. WSServer upgrade flow
  // ---------------------------------------------------------------------------

  describe('WSServer upgrade flow', () => {
    let tokenManager: TokenManagerImpl;
    let server: WSServer;
    const callbacks = {
      onMessage: vi.fn(),
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
    };

    beforeEach(() => {
      tokenManager = new TokenManagerImpl();
      callbacks.onMessage = vi.fn();
      callbacks.onConnect = vi.fn();
      callbacks.onDisconnect = vi.fn();
      server = new WSServer(tokenManager, callbacks);
    });

    afterEach(async () => {
      tokenManager.stopCleanup();
      await server.close();
    });

    it('should reject upgrade with invalid token (401)', () => {
      server.start();
      const socket = createMockSocket();

      const request = {
        url: '/ws/container?token=invalid-token&team=tid-team-abc123',
      };

      server.handleUpgrade(request, socket, Buffer.alloc(0));

      expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 401 Unauthorized\r\n\r\n');
      expect(socket.destroy).toHaveBeenCalled();
    });

    it('should reject upgrade with missing token (400)', () => {
      server.start();
      const socket = createMockSocket();

      const request = { url: '/ws/container?team=tid-team-abc123' };
      server.handleUpgrade(request, socket, Buffer.alloc(0));

      expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 400 Bad Request\r\n\r\n');
      expect(socket.destroy).toHaveBeenCalled();
    });

    it('should reject upgrade with wrong path (404)', () => {
      server.start();
      const socket = createMockSocket();

      const request = { url: '/wrong/path?token=abc&team=tid-team-abc123' };
      server.handleUpgrade(request, socket, Buffer.alloc(0));

      expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 404 Not Found\r\n\r\n');
      expect(socket.destroy).toHaveBeenCalled();
    });

    it('should reject upgrade when server not started (503)', () => {
      // Don't call server.start()
      const socket = createMockSocket();

      const token = tokenManager.generate('tid-team-abc123');
      const request = { url: `/ws/container?token=${token}&team=tid-team-abc123` };

      server.handleUpgrade(request, socket, Buffer.alloc(0));

      expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      expect(socket.destroy).toHaveBeenCalled();
    });

    it('should consume token on valid upgrade attempt (token is single-use)', () => {
      // The WSServer.handleUpgrade validates the token via TokenManager before
      // delegating to ws.WebSocketServer.handleUpgrade. We verify the single-use
      // property by checking that after the first validation (which happens inside
      // handleUpgrade), the TokenManager no longer accepts the same token.
      //
      // We can't do a full mock WS upgrade in a unit test because ws expects
      // a real socket with .on(). Instead, we verify directly through TokenManager
      // that the token is consumed.
      const tid = 'tid-team-abc123';
      const token = tokenManager.generate(tid);

      // Validate once (simulating what handleUpgrade does internally)
      expect(tokenManager.validate(token, tid)).toBe(true);

      // Now a second handleUpgrade with the same token should fail — the token
      // has already been consumed by the first validation.
      server.start();
      const socket = createMockSocket();
      server.handleUpgrade({ url: `/ws/container?token=${token}&team=${tid}` }, socket, Buffer.alloc(0));

      expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 401 Unauthorized\r\n\r\n');
      expect(socket.destroy).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Hub routing — INV-02 / INV-03
  // ---------------------------------------------------------------------------

  describe('Hub routing (INV-02/INV-03)', () => {
    let hub: WSHubImpl;
    let rootConn: WSConnection;
    let teamAConn: WSConnection;
    let teamBConn: WSConnection;

    beforeEach(() => {
      hub = new WSHubImpl();
      rootConn = createMockConnection('root');
      teamAConn = createMockConnection('tid-team-a-111111');
      teamBConn = createMockConnection('tid-team-b-222222');

      hub.register('root', rootConn);
      hub.register('tid-team-a-111111', teamAConn);
      hub.register('tid-team-b-222222', teamBConn);
    });

    afterEach(async () => {
      await hub.close();
    });

    it('should route message from root to team-A (root_to_container)', () => {
      const msg: WSMessage = {
        type: 'container_init',
        data: {
          protocol_version: '1.0',
          is_main_assistant: false,
          team_config: {},
          agents: [],
        },
      };

      // Root -> team-A: valid direction
      hub.route('root', 'tid-team-a-111111', msg);

      // Message is enqueued and will be drained via microtask.
      // The connection's send() will be called after drain.
    });

    it('should route message from team-A to root (container_to_root)', () => {
      const msg: WSMessage = {
        type: 'ready',
        data: {
          team_id: 'tid-team-a-111111',
          agent_count: 2,
          protocol_version: '1.0',
        },
      };

      // team-A -> root: valid direction. Root handles internally (no enqueue).
      expect(() => hub.route('tid-team-a-111111', 'root', msg)).not.toThrow();
    });

    it('should reject direct container-to-container routing (INV-03)', () => {
      const msg: WSMessage = {
        type: 'ready',
        data: {
          team_id: 'tid-team-a-111111',
          agent_count: 2,
          protocol_version: '1.0',
        },
      };

      expect(() => hub.route('tid-team-a-111111', 'tid-team-b-222222', msg)).toThrow(
        ValidationError,
      );
      expect(() => hub.route('tid-team-a-111111', 'tid-team-b-222222', msg)).toThrow(
        /INV-03 violation/,
      );
    });

    it('should reject wrong direction message type', () => {
      // Sending a container-to-root message from root
      const msg: WSMessage = {
        type: 'ready',
        data: {
          team_id: 'tid-team-a-111111',
          agent_count: 2,
          protocol_version: '1.0',
        },
      };

      expect(() => hub.route('root', 'tid-team-a-111111', msg)).toThrow(ValidationError);
    });

    it('should throw NotFoundError for unknown target TID', () => {
      const msg: WSMessage = {
        type: 'container_init',
        data: {
          protocol_version: '1.0',
          is_main_assistant: false,
          team_config: {},
          agents: [],
        },
      };

      expect(() => hub.route('root', 'tid-unknown-999999', msg)).toThrow(NotFoundError);
    });

    it('should report connected teams', () => {
      const teams = hub.getConnectedTeams();
      expect(teams).toContain('root');
      expect(teams).toContain('tid-team-a-111111');
      expect(teams).toContain('tid-team-b-222222');
      expect(teams).toHaveLength(3);
    });

    it('should unregister connection and report not connected', () => {
      hub.unregister('tid-team-a-111111');
      expect(hub.isConnected('tid-team-a-111111')).toBe(false);
      expect(hub.getConnectedTeams()).not.toContain('tid-team-a-111111');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Write queue overflow
  // ---------------------------------------------------------------------------

  describe('Write queue overflow', () => {
    it('should close connection when write queue exceeds 256 messages', async () => {
      const hub = new WSHubImpl();
      const conn = createMockConnection('tid-overflow-aaa111');
      hub.register('tid-overflow-aaa111', conn);

      const msg: WSMessage = {
        type: 'container_init',
        data: {
          protocol_version: '1.0',
          is_main_assistant: false,
          team_config: {},
          agents: [],
        },
      };

      // Send 257 messages rapidly — exceeds the 256 write queue cap
      for (let i = 0; i < 257; i++) {
        hub.route('root', 'tid-overflow-aaa111', msg);
      }

      // Connection should be closed with code 1008 (policy violation)
      expect(conn.close).toHaveBeenCalledWith(1008, 'Write queue overflow');

      await hub.close();
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Rate limiter
  // ---------------------------------------------------------------------------

  describe('Rate limiter', () => {
    it('should allow 100 messages then throttle on 101st via send()', async () => {
      const hub = new WSHubImpl();
      const conn = createMockConnection('tid-rate-bbb222');
      hub.register('tid-rate-bbb222', conn);

      const msg: WSMessage = {
        type: 'container_init',
        data: {
          protocol_version: '1.0',
          is_main_assistant: false,
          team_config: {},
          agents: [],
        },
      };

      // send() uses the rate limiter. First 100 should pass.
      for (let i = 0; i < 100; i++) {
        hub.send('tid-rate-bbb222', msg);
      }

      // 101st should be rate-limited
      expect(() => hub.send('tid-rate-bbb222', msg)).toThrow(RateLimitedError);

      await hub.close();
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Per-message-type Zod validation
  // ---------------------------------------------------------------------------

  describe('Per-message-type Zod validation', () => {
    it('should reject container_init with missing required agents field', () => {
      const msg: WSMessage = {
        type: 'container_init',
        data: {
          protocol_version: '1.0',
          is_main_assistant: false,
          team_config: {},
          // Missing 'agents' field
        },
      };

      expect(() => validateMessagePayload(msg)).toThrow(ValidationError);
      expect(() => validateMessagePayload(msg)).toThrow(/Invalid container_init payload/);
    });

    it('should accept valid container_init payload', () => {
      const msg: WSMessage = {
        type: 'container_init',
        data: {
          protocol_version: '1.0',
          is_main_assistant: false,
          team_config: {},
          agents: [],
        },
      };

      expect(() => validateMessagePayload(msg)).not.toThrow();
    });

    it('should reject unknown message type', () => {
      const msg: WSMessage = {
        type: 'unknown_type',
        data: {},
      };

      expect(() => validateMessagePayload(msg)).toThrow(ValidationError);
      expect(() => validateMessagePayload(msg)).toThrow(/No schema for message type/);
    });

    it('should reject task_dispatch with missing required fields', () => {
      const msg: WSMessage = {
        type: 'task_dispatch',
        data: {
          task_id: 'task-123',
          // Missing agent_aid, prompt, blocked_by
        },
      };

      expect(() => validateMessagePayload(msg)).toThrow(ValidationError);
    });

    it('should accept valid ready message', () => {
      const msg: WSMessage = {
        type: 'ready',
        data: {
          team_id: 'tid-team-abc123',
          agent_count: 3,
          protocol_version: '1.0',
        },
      };

      expect(() => validateMessagePayload(msg)).not.toThrow();
    });

    it('should reject heartbeat with invalid agents array content', () => {
      const msg: WSMessage = {
        type: 'heartbeat',
        data: {
          team_id: 'tid-team-abc123',
          agents: [{ invalid: 'data' }], // Missing required fields
        },
      };

      expect(() => validateMessagePayload(msg)).toThrow(ValidationError);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Direction validation (protocol layer)
  // ---------------------------------------------------------------------------

  describe('Direction validation', () => {
    it('should validate root-to-container message types', () => {
      expect(validateDirection('container_init', 'root_to_container')).toBe(true);
      expect(validateDirection('task_dispatch', 'root_to_container')).toBe(true);
      expect(validateDirection('shutdown', 'root_to_container')).toBe(true);
      expect(validateDirection('agent_message', 'root_to_container')).toBe(true);
    });

    it('should validate container-to-root message types', () => {
      expect(validateDirection('ready', 'container_to_root')).toBe(true);
      expect(validateDirection('heartbeat', 'container_to_root')).toBe(true);
      expect(validateDirection('task_result', 'container_to_root')).toBe(true);
    });

    it('should reject root-to-container types sent in container-to-root direction', () => {
      expect(validateDirection('container_init', 'container_to_root')).toBe(false);
      expect(validateDirection('shutdown', 'container_to_root')).toBe(false);
      expect(validateDirection('agent_message', 'container_to_root')).toBe(false);
    });

    it('should reject container-to-root types sent in root-to-container direction', () => {
      expect(validateDirection('ready', 'root_to_container')).toBe(false);
      expect(validateDirection('heartbeat', 'root_to_container')).toBe(false);
    });

    it('should throw on unknown message type', () => {
      expect(() => validateDirection('bogus_type', 'root_to_container')).toThrow(
        /Unknown message type/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Integration wiring: WSHub + TokenManager
  // ---------------------------------------------------------------------------

  describe('Integration wiring (WSHub + TokenManager end-to-end)', () => {
    it('should generate token, register connection, and route message through hub', async () => {
      const tokenManager = new TokenManagerImpl();
      const hub = new WSHubImpl();

      // Step 1: Generate a token for a team
      const tid = 'tid-wired-ccc333';
      const token = tokenManager.generate(tid);
      expect(token).toHaveLength(64);

      // Step 2: Validate token (simulating the upgrade handshake)
      expect(tokenManager.validate(token, tid)).toBe(true);

      // Step 3: Register the connection in the hub (simulating post-upgrade)
      const conn = createMockConnection(tid);
      hub.register(tid, conn);
      expect(hub.isConnected(tid)).toBe(true);

      // Step 4: Route a message from root to the team
      const msg: WSMessage = {
        type: 'container_init',
        data: {
          protocol_version: '1.0',
          is_main_assistant: false,
          team_config: {},
          agents: [],
        },
      };
      hub.route('root', tid, msg);

      // Allow microtask drain to flush write queue
      await new Promise<void>((resolve) => queueMicrotask(resolve));

      // Verify the message was sent to the connection
      expect(conn.send).toHaveBeenCalledWith(msg);

      // Step 5: Token is consumed — second validation fails
      expect(tokenManager.validate(token, tid)).toBe(false);

      tokenManager.stopCleanup();
      await hub.close();
    });

    it('should route container-to-root message and handle internally', async () => {
      const hub = new WSHubImpl();

      // Register root and a team
      const rootConn = createMockConnection('root');
      const teamConn = createMockConnection('tid-e2e-ddd444');
      hub.register('root', rootConn);
      hub.register('tid-e2e-ddd444', teamConn);

      // Route a container-to-root message
      const msg: WSMessage = {
        type: 'ready',
        data: {
          team_id: 'tid-e2e-ddd444',
          agent_count: 2,
          protocol_version: '1.0',
        },
      };

      // Container-to-root: root processes internally, so no send() on root connection
      expect(() => hub.route('tid-e2e-ddd444', 'root', msg)).not.toThrow();

      await hub.close();
    });

    it('should broadcast to all connected containers', async () => {
      const hub = new WSHubImpl();
      const conn1 = createMockConnection('tid-bc-eee555');
      const conn2 = createMockConnection('tid-bc-fff666');
      hub.register('tid-bc-eee555', conn1);
      hub.register('tid-bc-fff666', conn2);

      const msg: WSMessage = {
        type: 'shutdown',
        data: { reason: 'test', timeout: 30 },
      };

      hub.broadcast(msg);

      // Allow microtask drain
      await new Promise<void>((resolve) => queueMicrotask(resolve));

      expect(conn1.send).toHaveBeenCalledWith(msg);
      expect(conn2.send).toHaveBeenCalledWith(msg);

      await hub.close();
    });
  });
});
