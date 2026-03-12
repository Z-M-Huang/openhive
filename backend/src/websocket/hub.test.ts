/**
 * Tests for WSHubImpl (WebSocket hub routing layer).
 *
 * Uses mock WSConnection objects implementing the WSConnection interface.
 * Tests cover: register/unregister, INV-02/03 enforcement, write queue
 * overflow, rate limiting, broadcast, direction validation, and re-register.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WSHubImpl } from './hub.js';
import { RateLimitedError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { WSConnection, WSMessage } from '../domain/interfaces.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a mock WSConnection with vi.fn() stubs. */
function mockConnection(tid: string, alive = true): WSConnection {
  return {
    tid,
    send: vi.fn(),
    close: vi.fn(),
    onMessage: vi.fn(),
    onClose: vi.fn(),
    isAlive: vi.fn(() => alive),
  };
}

/** Creates a valid root-to-container message. */
function r2cMessage(type = 'task_dispatch'): WSMessage {
  return { type, data: { task_id: 't1', agent_aid: 'a1', prompt: 'do it', blocked_by: [] } };
}

/** Creates a valid container-to-root message. */
function c2rMessage(type = 'heartbeat'): WSMessage {
  return { type, data: { team_id: 'tid-a', agents: [] } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WSHubImpl', () => {
  let hub: WSHubImpl;

  beforeEach(() => {
    hub = new WSHubImpl();
  });

  // -----------------------------------------------------------------------
  // register / unregister
  // -----------------------------------------------------------------------

  describe('register() / unregister()', () => {
    it('stores a connection and makes it queryable', () => {
      const conn = mockConnection('tid-a');
      hub.register('tid-a', conn);

      expect(hub.getConnectedTeams()).toEqual(['tid-a']);
      expect(hub.isConnected('tid-a')).toBe(true);
    });

    it('removes a connection on unregister', () => {
      const conn = mockConnection('tid-a');
      hub.register('tid-a', conn);
      hub.unregister('tid-a');

      expect(hub.getConnectedTeams()).toEqual([]);
      expect(hub.isConnected('tid-a')).toBe(false);
    });

    it('unregister of unknown TID is a no-op', () => {
      expect(() => hub.unregister('tid-unknown')).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Re-register same TID
  // -----------------------------------------------------------------------

  describe('re-register same TID', () => {
    it('closes old connection and stores the new one', () => {
      const old = mockConnection('tid-a');
      const fresh = mockConnection('tid-a');

      hub.register('tid-a', old);
      hub.register('tid-a', fresh);

      expect(old.close).toHaveBeenCalledWith(1001, 'Replaced by new connection');
      expect(hub.getConnectedTeams()).toEqual(['tid-a']);

      // The new connection is the one used for sends
      const msg = r2cMessage();
      hub.send('tid-a', msg);
      // Drain happens via microtask, but we can verify the queue goes to fresh
      expect(old.send).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // route() — INV-02 / INV-03 enforcement
  // -----------------------------------------------------------------------

  describe('route() INV-02/INV-03 enforcement', () => {
    it('root-to-container passes', () => {
      const conn = mockConnection('tid-a');
      hub.register('tid-a', conn);

      expect(() => hub.route('root', 'tid-a', r2cMessage())).not.toThrow();
    });

    it('container-to-root passes', () => {
      // Container-to-root doesn't need a connection for root
      expect(() => hub.route('tid-a', 'root', c2rMessage())).not.toThrow();
    });

    it('container-to-container is rejected (INV-03)', () => {
      hub.register('tid-a', mockConnection('tid-a'));
      hub.register('tid-b', mockConnection('tid-b'));

      expect(() => hub.route('tid-a', 'tid-b', c2rMessage())).toThrow(ValidationError);
      expect(() => hub.route('tid-a', 'tid-b', c2rMessage())).toThrow(/INV-03/);
    });
  });

  // -----------------------------------------------------------------------
  // route() — direction validation
  // -----------------------------------------------------------------------

  describe('route() direction validation', () => {
    it('rejects container-to-root message types sent as root-to-container', () => {
      const conn = mockConnection('tid-a');
      hub.register('tid-a', conn);

      // heartbeat is container-to-root, should fail when source is root
      expect(() => hub.route('root', 'tid-a', c2rMessage('heartbeat'))).toThrow(ValidationError);
    });

    it('rejects root-to-container message types sent as container-to-root', () => {
      // task_dispatch is root-to-container, should fail when source is a container
      expect(() => hub.route('tid-a', 'root', r2cMessage('task_dispatch'))).toThrow(ValidationError);
    });
  });

  // -----------------------------------------------------------------------
  // route() — target not found
  // -----------------------------------------------------------------------

  describe('route() target not found', () => {
    it('throws NotFoundError when target TID has no connection', () => {
      expect(() => hub.route('root', 'tid-missing', r2cMessage())).toThrow(NotFoundError);
    });
  });

  // -----------------------------------------------------------------------
  // send() — basic and rate limiting
  // -----------------------------------------------------------------------

  describe('send()', () => {
    it('throws NotFoundError for unknown TID', () => {
      expect(() => hub.send('tid-missing', r2cMessage())).toThrow(NotFoundError);
    });

    it('burst of 100 messages passes', () => {
      const conn = mockConnection('tid-a');
      hub.register('tid-a', conn);

      for (let i = 0; i < 100; i++) {
        expect(() => hub.send('tid-a', r2cMessage())).not.toThrow();
      }
    });

    it('101st message is rate-limited', () => {
      const conn = mockConnection('tid-a');
      hub.register('tid-a', conn);

      for (let i = 0; i < 100; i++) {
        hub.send('tid-a', r2cMessage());
      }

      expect(() => hub.send('tid-a', r2cMessage())).toThrow(RateLimitedError);
    });
  });

  // -----------------------------------------------------------------------
  // Write queue overflow
  // -----------------------------------------------------------------------

  describe('write queue overflow', () => {
    it('closes connection with code 1008 when queue exceeds 256', () => {
      const conn = mockConnection('tid-a');
      hub.register('tid-a', conn);

      // Fill the rate limiter: we need to bypass rate limiting.
      // Use route() from root (no rate limiting) to fill the queue.
      // First 256 are fine, 257th should trigger close.
      for (let i = 0; i < 257; i++) {
        // route from root doesn't check rate limiter
        hub.route('root', 'tid-a', r2cMessage());
      }

      expect(conn.close).toHaveBeenCalledWith(1008, 'Write queue overflow');
    });
  });

  // -----------------------------------------------------------------------
  // broadcast()
  // -----------------------------------------------------------------------

  describe('broadcast()', () => {
    it('enqueues message for all connections', async () => {
      const connA = mockConnection('tid-a');
      const connB = mockConnection('tid-b');
      hub.register('tid-a', connA);
      hub.register('tid-b', connB);

      const msg = r2cMessage();
      hub.broadcast(msg);

      // Wait for microtask drain
      await new Promise<void>((r) => queueMicrotask(r));

      expect(connA.send).toHaveBeenCalledWith(msg);
      expect(connB.send).toHaveBeenCalledWith(msg);
    });
  });

  // -----------------------------------------------------------------------
  // isConnected()
  // -----------------------------------------------------------------------

  describe('isConnected()', () => {
    it('returns false for unknown TID', () => {
      expect(hub.isConnected('tid-unknown')).toBe(false);
    });

    it('returns false when connection is not alive', () => {
      const conn = mockConnection('tid-a', false);
      hub.register('tid-a', conn);
      expect(hub.isConnected('tid-a')).toBe(false);
    });

    it('returns true when connection is alive', () => {
      const conn = mockConnection('tid-a', true);
      hub.register('tid-a', conn);
      expect(hub.isConnected('tid-a')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // close()
  // -----------------------------------------------------------------------

  describe('close()', () => {
    it('closes all connections with 1001 and clears registry', async () => {
      const connA = mockConnection('tid-a');
      const connB = mockConnection('tid-b');
      hub.register('tid-a', connA);
      hub.register('tid-b', connB);

      await hub.close();

      expect(connA.close).toHaveBeenCalledWith(1001, 'Hub shutting down');
      expect(connB.close).toHaveBeenCalledWith(1001, 'Hub shutting down');
      expect(hub.getConnectedTeams()).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // unregister drains write queue
  // -----------------------------------------------------------------------

  describe('unregister() drains write queue', () => {
    it('sends buffered messages before removing connection', () => {
      const conn = mockConnection('tid-a');
      hub.register('tid-a', conn);

      // Enqueue via route (no rate limiter check)
      hub.route('root', 'tid-a', r2cMessage());

      // Before microtask drains, unregister — should drain synchronously
      hub.unregister('tid-a');

      expect(conn.send).toHaveBeenCalledTimes(1);
      expect(hub.getConnectedTeams()).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // handleUpgrade() — no-op delegation
  // -----------------------------------------------------------------------

  describe('handleUpgrade()', () => {
    it('does not throw (no-op delegation point)', () => {
      expect(() => hub.handleUpgrade({}, {}, {})).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Write queue async drain
  // -----------------------------------------------------------------------

  describe('write queue async drain', () => {
    it('drains messages via microtask', async () => {
      const conn = mockConnection('tid-a');
      hub.register('tid-a', conn);

      hub.route('root', 'tid-a', r2cMessage());
      hub.route('root', 'tid-a', r2cMessage());

      // Not yet drained
      expect(conn.send).not.toHaveBeenCalled();

      // Wait for microtask
      await new Promise<void>((r) => queueMicrotask(r));

      expect(conn.send).toHaveBeenCalledTimes(2);
    });
  });
});
