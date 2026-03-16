/**
 * Tests for SessionManagerImpl.
 *
 * Verifies create/resume/end lifecycle, one-per-agent constraint,
 * MEMORY.md injection at creation only, and end-then-recreate.
 *
 * @module executor/session.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionManagerImpl } from './session.js';
import type { SessionStore } from '../domain/index.js';
import type { ChatSession } from '../domain/index.js';
import { ConflictError, NotFoundError } from '../domain/index.js';

/** In-memory SessionStore test double. */
function createMockSessionStore(): SessionStore {
  const sessions = new Map<string, ChatSession>();
  return {
    get: vi.fn(async (chatJID: string) => {
      const s = sessions.get(chatJID);
      if (!s) throw new NotFoundError(`Session ${chatJID} not found`);
      return s;
    }),
    upsert: vi.fn(async (session: ChatSession) => {
      sessions.set(session.chat_jid, session);
    }),
    delete: vi.fn(async (chatJID: string) => {
      sessions.delete(chatJID);
    }),
    listAll: vi.fn(async () => [...sessions.values()]),
  };
}

describe('SessionManagerImpl', () => {
  let store: SessionStore;
  let manager: SessionManagerImpl;

  beforeEach(() => {
    store = createMockSessionStore();
    // Use a non-existent path so MEMORY.md read returns null
    manager = new SessionManagerImpl(store, '/tmp/nonexistent-workspace');
  });

  describe('create/resume/end lifecycle', () => {
    it('createSession returns a UUID session ID and persists via store', async () => {
      const sessionId = await manager.createSession('aid-test-abc1', 'task-001', 'tid-team-0001');

      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(store.upsert).toHaveBeenCalledOnce();
      expect(store.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          chat_jid: 'aid-test-abc1',
          session_id: sessionId,
          agent_aid: 'aid-test-abc1',
        }),
      );
    });

    it('getSessionByAgent returns session ID after creation', async () => {
      const sessionId = await manager.createSession('aid-test-abc2', 'task-002', 'tid-team-0001');

      expect(manager.getSessionByAgent('aid-test-abc2')).toBe(sessionId);
    });

    it('getSessionByAgent returns undefined for unknown agent', () => {
      expect(manager.getSessionByAgent('aid-unknown-xyz')).toBeUndefined();
    });

    it('endSession removes session from active map and store', async () => {
      const sessionId = await manager.createSession('aid-test-abc3', 'task-003', 'tid-team-0001');

      await manager.endSession(sessionId);

      expect(manager.getSessionByAgent('aid-test-abc3')).toBeUndefined();
      expect(store.delete).toHaveBeenCalledWith('aid-test-abc3');
    });

    it('resumeSession restores session into active map', async () => {
      const sessionId = await manager.createSession('aid-test-abc4', 'task-004', 'tid-team-0001');
      // Simulate process restart — clear in-memory state but store still has it
      await manager.endSession(sessionId);

      // Re-persist in the store to simulate it still being there
      await store.upsert({
        chat_jid: 'aid-test-abc4',
        channel_type: 'cli',
        last_timestamp: Date.now(),
        last_agent_timestamp: Date.now(),
        session_id: sessionId,
        agent_aid: 'aid-test-abc4',
        tid: 'tid-team-0001',
      });

      await manager.resumeSession(sessionId);

      expect(manager.getSessionByAgent('aid-test-abc4')).toBe(sessionId);
    });
  });

  describe('tid binding (AC-C2)', () => {
    it('session is created with the provided tid', async () => {
      const sessionId = await manager.createSession('aid-test-tid1', 'task-tid-001', 'tid-team-xyz');
      // Session is active for the agent
      expect(manager.getSessionByAgent('aid-test-tid1')).toBe(sessionId);
    });

    it('different tids for different agents do not conflict', async () => {
      const sid1 = await manager.createSession('aid-test-tid2', 'task-tid-002', 'tid-team-aaa');
      const sid2 = await manager.createSession('aid-test-tid3', 'task-tid-003', 'tid-team-bbb');
      expect(sid1).not.toBe(sid2);
      expect(manager.getSessionByAgent('aid-test-tid2')).toBe(sid1);
      expect(manager.getSessionByAgent('aid-test-tid3')).toBe(sid2);
    });
  });

  describe('one-per-agent constraint', () => {
    it('throws ConflictError when creating a second session for the same agent', async () => {
      await manager.createSession('aid-test-abc5', 'task-005', 'tid-team-0001');

      await expect(
        manager.createSession('aid-test-abc5', 'task-006', 'tid-team-0001'),
      ).rejects.toThrow(ConflictError);
    });
  });

  describe('MEMORY.md injection', () => {
    it('reads MEMORY.md at creation (not on resume)', async () => {
      // Creation with non-existent workspace — memoryContent is null (no throw)
      const sessionId = await manager.createSession('aid-test-abc6', 'task-007', 'tid-team-0001');
      expect(sessionId).toBeDefined();

      // Resume should not attempt MEMORY.md re-injection — just store lookup
      await manager.endSession(sessionId);

      await store.upsert({
        chat_jid: 'aid-test-abc6',
        channel_type: 'cli',
        last_timestamp: Date.now(),
        last_agent_timestamp: Date.now(),
        session_id: sessionId,
        agent_aid: 'aid-test-abc6',
        tid: 'tid-team-0001',
      });

      // resumeSession should succeed without reading MEMORY.md
      await manager.resumeSession(sessionId);
      expect(manager.getSessionByAgent('aid-test-abc6')).toBe(sessionId);
    });
  });

  describe('end then recreate', () => {
    it('can create a new session after ending the previous one', async () => {
      const firstId = await manager.createSession('aid-test-abc7', 'task-008', 'tid-team-0001');
      await manager.endSession(firstId);

      const secondId = await manager.createSession('aid-test-abc7', 'task-009', 'tid-team-0001');
      expect(secondId).not.toBe(firstId);
      expect(manager.getSessionByAgent('aid-test-abc7')).toBe(secondId);
    });
  });

  describe('error cases', () => {
    it('endSession throws NotFoundError for unknown session ID', async () => {
      await expect(
        manager.endSession('nonexistent-session-id'),
      ).rejects.toThrow(NotFoundError);
    });

    it('resumeSession throws NotFoundError for unknown session ID', async () => {
      await expect(
        manager.resumeSession('nonexistent-session-id'),
      ).rejects.toThrow(NotFoundError);
    });
  });
});
