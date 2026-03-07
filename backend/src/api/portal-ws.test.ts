/**
 * Tests for portal-ws.ts — GET /api/v1/portal/ws.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EventBus } from '../domain/interfaces.js';
import type { Event } from '../domain/types.js';
import type { LogLevel } from '../domain/enums.js';
import {
  PortalWSHandler,
  buildPortalFilter,
  checkPortalOrigin,
  type PortalSocket,
  type PortalWSFilter,
} from './portal-ws.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Build a log_entry Event for filter tests. */
function makeLogEvent(opts: { level?: LogLevel; team_name?: string }): Event {
  const { level = 'info', team_name } = opts;
  return {
    type: 'log_entry',
    payload: {
      kind: 'log_entry',
      entry: {
        id: 1,
        level,
        component: 'test',
        action: 'test',
        message: 'test msg',
        team_name,
        created_at: new Date(),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeMockEventBus(): EventBus & {
  filteredSubscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  let subIdCounter = 0;
  return {
    publish: vi.fn(),
    subscribe: vi.fn().mockReturnValue('sub-0'),
    filteredSubscribe: vi.fn().mockImplementation(() => `sub-${++subIdCounter}`),
    unsubscribe: vi.fn(),
    close: vi.fn(),
  } as unknown as EventBus & {
    filteredSubscribe: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
  };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeMockSocket(): {
  socket: PortalSocket;
  sends: string[];
  isClosed: boolean;
  triggerClose: () => void;
  triggerError: (err: Error) => void;
} {
  let closeListener: (() => void) | undefined;
  let errorListener: ((err: Error) => void) | undefined;
  const sends: string[] = [];
  let isClosed = false;

  const socket = {
    send(data: string) {
      sends.push(data);
    },
    close() {
      isClosed = true;
    },
    on(event: string, listener: ((...args: unknown[]) => void)) {
      if (event === 'close') closeListener = listener as () => void;
      else if (event === 'error') errorListener = listener as (err: Error) => void;
    },
  } as unknown as PortalSocket;

  return {
    socket,
    sends,
    get isClosed() {
      return isClosed;
    },
    triggerClose: () => {
      closeListener?.();
    },
    triggerError: (err: Error) => {
      errorListener?.(err);
    },
  };
}

// ---------------------------------------------------------------------------
// PortalWSHandler tests
// ---------------------------------------------------------------------------

describe('PortalWSHandler', () => {
  let eventBus: ReturnType<typeof makeMockEventBus>;
  let logger: ReturnType<typeof makeLogger>;
  let handler: PortalWSHandler;

  // Use maxConnections=2 so the "max connections" test can fill it with just 2 sockets.
  beforeEach(() => {
    eventBus = makeMockEventBus();
    logger = makeLogger();
    handler = new PortalWSHandler(eventBus, logger, 2);
  });

  it('handleUpgrade accepts localhost origin', () => {
    const { socket, isClosed: _ } = makeMockSocket();
    handler.handleUpgrade(socket, { headers: { origin: 'http://localhost:3000' }, url: '/' });
    expect(handler.activeConnections()).toBe(1);
    // socket should NOT have been closed
    const m = makeMockSocket();
    handler.handleUpgrade(m.socket, { headers: { origin: 'http://localhost' }, url: '/' });
    expect(m.isClosed).toBe(false);
  });

  it('handleUpgrade rejects non-localhost origin', () => {
    const m = makeMockSocket();
    handler.handleUpgrade(m.socket, {
      headers: { origin: 'http://example.com' },
      url: '/',
    });
    expect(m.isClosed).toBe(true);
    expect(handler.activeConnections()).toBe(0);
    expect(eventBus.filteredSubscribe).not.toHaveBeenCalled();
  });

  it('handleUpgrade rejects when at max connections', () => {
    const m1 = makeMockSocket();
    const m2 = makeMockSocket();
    const m3 = makeMockSocket();
    handler.handleUpgrade(m1.socket, { headers: { origin: 'http://localhost' }, url: '/' });
    handler.handleUpgrade(m2.socket, { headers: { origin: 'http://localhost' }, url: '/' });
    expect(handler.activeConnections()).toBe(2);

    // Third connection should be rejected
    handler.handleUpgrade(m3.socket, { headers: { origin: 'http://localhost' }, url: '/' });
    expect(m3.isClosed).toBe(true);
    expect(handler.activeConnections()).toBe(2);
  });

  it('handleUpgrade subscribes to event bus', () => {
    const { socket } = makeMockSocket();
    handler.handleUpgrade(socket, { headers: { origin: 'http://localhost' }, url: '/' });

    expect(eventBus.filteredSubscribe).toHaveBeenCalledTimes(4);
    expect(eventBus.filteredSubscribe).toHaveBeenCalledWith(
      'log_entry',
      expect.any(Function),
      expect.any(Function),
    );
    expect(eventBus.filteredSubscribe).toHaveBeenCalledWith(
      'task_updated',
      expect.any(Function),
      expect.any(Function),
    );
    expect(eventBus.filteredSubscribe).toHaveBeenCalledWith(
      'heartbeat_received',
      expect.any(Function),
      expect.any(Function),
    );
    expect(eventBus.filteredSubscribe).toHaveBeenCalledWith(
      'container_state_changed',
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('client disconnect unsubscribes from event bus', () => {
    const { socket, triggerClose } = makeMockSocket();
    handler.handleUpgrade(socket, { headers: { origin: 'http://localhost' }, url: '/' });

    // Collect the sub IDs returned by filteredSubscribe
    const subIds = (eventBus.filteredSubscribe.mock.results as { value: string }[]).map(
      (r) => r.value,
    );
    expect(subIds).toHaveLength(4);

    triggerClose();

    for (const id of subIds) {
      expect(eventBus.unsubscribe).toHaveBeenCalledWith(id);
    }
    expect(handler.activeConnections()).toBe(0);
  });

  it('activeConnections returns correct count', () => {
    expect(handler.activeConnections()).toBe(0);

    const m1 = makeMockSocket();
    handler.handleUpgrade(m1.socket, { headers: { origin: 'http://localhost' }, url: '/' });
    expect(handler.activeConnections()).toBe(1);

    const m2 = makeMockSocket();
    handler.handleUpgrade(m2.socket, { headers: { origin: 'http://localhost' }, url: '/' });
    expect(handler.activeConnections()).toBe(2);

    m1.triggerClose();
    expect(handler.activeConnections()).toBe(1);

    m2.triggerClose();
    expect(handler.activeConnections()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildPortalFilter tests
// ---------------------------------------------------------------------------

describe('buildPortalFilter', () => {
  it('Event filtering by team slug works', () => {
    const filter: PortalWSFilter = { teamSlug: 'my-team', minLevel: 'debug', excludeDebug: false };
    const filterFn = buildPortalFilter(filter);

    expect(filterFn(makeLogEvent({ level: 'info', team_name: 'my-team' }))).toBe(true);
    expect(filterFn(makeLogEvent({ level: 'info', team_name: 'other-team' }))).toBe(false);
    // No team_name: filtered out when team filter is active
    expect(filterFn(makeLogEvent({ level: 'info' }))).toBe(false);
  });

  it('Event filtering by log level works', () => {
    const filter: PortalWSFilter = { teamSlug: '', minLevel: 'warn', excludeDebug: false };
    const filterFn = buildPortalFilter(filter);

    expect(filterFn(makeLogEvent({ level: 'debug' }))).toBe(false);
    expect(filterFn(makeLogEvent({ level: 'info' }))).toBe(false);
    expect(filterFn(makeLogEvent({ level: 'warn' }))).toBe(true);
    expect(filterFn(makeLogEvent({ level: 'error' }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkPortalOrigin tests
// ---------------------------------------------------------------------------

describe('checkPortalOrigin', () => {
  it('checkPortalOrigin validates correctly', () => {
    // Empty origin = direct connection → always allowed
    expect(checkPortalOrigin('')).toBe(true);

    // Localhost variants
    expect(checkPortalOrigin('http://localhost:3000')).toBe(true);
    expect(checkPortalOrigin('http://localhost')).toBe(true);
    expect(checkPortalOrigin('http://127.0.0.1:8080')).toBe(true);
    expect(checkPortalOrigin('http://127.0.0.1')).toBe(true);
    expect(checkPortalOrigin('https://localhost:443')).toBe(true);

    // External origins → rejected
    expect(checkPortalOrigin('http://example.com')).toBe(false);
    expect(checkPortalOrigin('https://evil.com')).toBe(false);
    expect(checkPortalOrigin('http://localhost.evil.com')).toBe(false);
    expect(checkPortalOrigin('http://notlocalhost:3000')).toBe(false);
  });
});
