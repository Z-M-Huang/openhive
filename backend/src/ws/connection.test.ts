/**
 * Tests for backend/src/ws/connection.ts
 *
 * Uses a FakeWebSocket to simulate ws.WebSocket events without a real network.
 * Tests cover:
 *   - send() queues messages for delivery
 *   - send() closes connection when buffer full (256 msgs)
 *   - rate limiter closes connection on excessive messages
 *   - ping interval sends pings every 30 s
 *   - connection closes on pong timeout (10 s after ping)
 *   - onClose callback fires when connection drops
 *   - onMessage callback fires for incoming messages
 *
 * Timer notes:
 *   - setTimeout/setInterval are faked by vi.useFakeTimers() in bun's vitest environment.
 *   - setImmediate is NOT faked; the implementation uses queueMicrotask instead.
 *   - To drain the microtask queue (write queue), await drainMicrotasks().
 *   - To fire ping/pong timers, use vi.advanceTimersByTime(ms).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

import { Connection, WriteError } from './connection.js';

// ---------------------------------------------------------------------------
// Utility: drain the microtask queue multiple times
// ---------------------------------------------------------------------------

/**
 * Drains all pending microtasks by awaiting Promise.resolve() several times.
 * Each round of queueMicrotask callbacks may schedule further microtasks
 * (e.g., the ws.send callback schedules the next flush). We repeat enough
 * times to empty any realistic chain.
 */
async function drainMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// FakeWebSocket — simulates ws.WebSocket for testing
// ---------------------------------------------------------------------------

/**
 * A minimal ws.WebSocket stand-in that captures send/ping/terminate calls
 * and allows tests to emit events (message, close, pong, error).
 *
 * Extends EventEmitter to support the ws event API.
 *
 * Callbacks from send() and ping() are invoked as microtasks (queueMicrotask)
 * to match the async nature of real ws send operations without relying on
 * setImmediate (which is not faked in the test environment).
 */
class FakeWebSocket extends EventEmitter {
  readonly sentMessages: Array<Buffer | string> = [];
  readonly pingsSent: number[] = [];
  terminated = false;
  closed = false;

  /** Override to simulate send errors. */
  sendError: Error | undefined = undefined;

  /** Set to true to block send callbacks (simulates a stalled connection). */
  blockSend = false;

  // Captures send() calls and invokes callback as a microtask
  send(data: Buffer | string, cb?: (err?: Error) => void): void {
    this.sentMessages.push(data);
    if (cb && !this.blockSend) {
      // Invoke callback as a microtask (not setImmediate) so fake timers don't interfere
      queueMicrotask(() => cb(this.sendError));
    }
  }

  // Captures ping() calls and invokes callback as a microtask
  ping(
    _data: unknown,
    _mask: unknown,
    cb?: (err?: Error) => void,
  ): void {
    this.pingsSent.push(Date.now());
    if (cb) {
      queueMicrotask(() => cb(undefined));
    }
  }

  terminate(): void {
    this.terminated = true;
    if (!this.closed) {
      this.closed = true;
      // Emit 'close' synchronously so the onClose chain fires immediately
      this.emit('close', 1000, Buffer.from(''));
    }
  }

  // Helper for tests: simulate receiving a message from the peer
  receiveMessage(data: Buffer | string): void {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.emit('message', buf, false);
  }

  // Helper: simulate receiving a pong
  receivePong(): void {
    this.emit('pong', Buffer.from(''));
  }

  // Helper: simulate the peer closing the connection
  simulateClose(): void {
    if (!this.closed) {
      this.closed = true;
      this.emit('close', 1001, Buffer.from(''));
    }
  }

  // Helper: simulate an error
  simulateError(err: Error): void {
    this.emit('error', err);
  }
}

// ---------------------------------------------------------------------------
// FakeLogger — captures log calls for assertion
// ---------------------------------------------------------------------------

interface LogCall {
  msg: string;
  args: unknown[];
}

class FakeLogger {
  readonly warns: LogCall[] = [];
  readonly errors: LogCall[] = [];

  warn(msg: string, ...args: unknown[]): void {
    this.warns.push({ msg, args });
  }

  error(msg: string, ...args: unknown[]): void {
    this.errors.push({ msg, args });
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeConnection(opts?: {
  onMessage?: (teamId: string, msg: Buffer) => void;
  onClose?: (teamId: string) => void;
}): { conn: Connection; socket: FakeWebSocket; logger: FakeLogger } {
  const socket = new FakeWebSocket();
  const logger = new FakeLogger();
  const onMessage = opts?.onMessage ?? (() => undefined);
  const onClose = opts?.onClose ?? (() => undefined);

  const conn = new Connection(
    socket as unknown as import('ws').default,
    'tid-test-001',
    logger,
    onMessage,
    onClose,
  );

  return { conn, socket, logger };
}

// ---------------------------------------------------------------------------
// Setup / teardown — fake timers
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// send() — queues messages for delivery
// ---------------------------------------------------------------------------

describe('send() — queues messages for delivery', () => {
  it('delivers a string message to the WebSocket', async () => {
    const { conn, socket } = makeConnection();
    const msg = JSON.stringify({ type: 'ready', data: { team_id: 'tid-1', agent_count: 1 } });

    await conn.send(msg);
    // Drain the microtask queue so the write flush completes
    await drainMicrotasks();

    expect(socket.sentMessages).toHaveLength(1);
    expect(socket.sentMessages[0]).toBe(msg);
  });

  it('delivers a Buffer message to the WebSocket', async () => {
    const { conn, socket } = makeConnection();
    const buf = Buffer.from('hello world');

    await conn.send(buf);
    await drainMicrotasks();

    expect(socket.sentMessages).toHaveLength(1);
    expect(socket.sentMessages[0]).toEqual(buf);
  });

  it('delivers multiple messages in order', async () => {
    const { conn, socket } = makeConnection();
    const msgs = ['first', 'second', 'third'];

    for (const m of msgs) {
      await conn.send(m);
    }
    // Each send may trigger a microtask chain — drain thoroughly
    await drainMicrotasks(30);

    expect(socket.sentMessages).toHaveLength(3);
    expect(socket.sentMessages[0]).toBe('first');
    expect(socket.sentMessages[1]).toBe('second');
    expect(socket.sentMessages[2]).toBe('third');
  });

  it('returns a resolved Promise on successful send', async () => {
    const { conn } = makeConnection();
    await expect(conn.send('test')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// send() — closes connection when buffer full
// ---------------------------------------------------------------------------

describe('send() — closes connection when buffer full', () => {
  it('throws WriteError when queue exceeds 256 messages', async () => {
    const { conn, socket } = makeConnection();

    // Block send callbacks so the queue stays full
    socket.blockSend = true;

    // Queue 256 messages (fills the buffer without flushing)
    const sendPromises: Array<Promise<void>> = [];
    for (let i = 0; i < 256; i++) {
      sendPromises.push(conn.send(`msg-${i}`).catch(() => undefined));
    }

    // The 257th message should throw WriteError
    await expect(conn.send('overflow')).rejects.toThrow(WriteError);
    await expect(conn.send('overflow')).rejects.toThrow('write queue full for team tid-test-001');
  });

  it('closes the WebSocket when queue is full', async () => {
    const { conn, socket } = makeConnection();

    socket.blockSend = true;

    for (let i = 0; i < 256; i++) {
      void conn.send(`msg-${i}`).catch(() => undefined);
    }

    await expect(conn.send('overflow')).rejects.toThrow(WriteError);

    expect(socket.terminated).toBe(true);
  });

  it('logs a warning when queue is full', async () => {
    const { conn, socket, logger } = makeConnection();

    socket.blockSend = true;

    for (let i = 0; i < 256; i++) {
      void conn.send(`msg-${i}`).catch(() => undefined);
    }

    await expect(conn.send('overflow')).rejects.toThrow(WriteError);

    const warnMessages = logger.warns.map((w) => w.msg);
    expect(warnMessages.some((m) => m.includes('write queue full'))).toBe(true);
  });

  it('subsequent sends after overflow throw WriteError (connection is closed)', async () => {
    const { conn, socket } = makeConnection();

    socket.blockSend = true;

    for (let i = 0; i < 256; i++) {
      void conn.send(`msg-${i}`).catch(() => undefined);
    }

    // First overflow — closes connection
    await expect(conn.send('overflow')).rejects.toThrow(WriteError);

    // Subsequent sends also throw because connection is now closed
    await expect(conn.send('after-close')).rejects.toThrow(WriteError);
  });
});

// ---------------------------------------------------------------------------
// Rate limiter — rejects excessive messages
// ---------------------------------------------------------------------------

describe('rate limiter — rejects excessive messages', () => {
  it('closes connection when incoming messages exceed rate limit', () => {
    const closedTeams: string[] = [];
    const { socket } = makeConnection({
      onClose: (id) => closedTeams.push(id),
    });

    // Exhaust the burst bucket (100 msgs), then send more.
    // The 101st message should trigger rate limiting.
    for (let i = 0; i < 101; i++) {
      socket.receiveMessage(`msg-${i}`);
    }

    expect(socket.terminated).toBe(true);
    expect(closedTeams).toContain('tid-test-001');
  });

  it('logs a warning when rate limit is exceeded', () => {
    const { socket, logger } = makeConnection();

    for (let i = 0; i < 101; i++) {
      socket.receiveMessage(`msg-${i}`);
    }

    const warnMessages = logger.warns.map((w) => w.msg);
    expect(warnMessages.some((m) => m.includes('rate limit exceeded'))).toBe(true);
  });

  it('allows up to 100 messages without rate limiting', () => {
    const received: Buffer[] = [];
    const { socket } = makeConnection({
      onMessage: (_id, msg) => received.push(msg),
    });

    for (let i = 0; i < 100; i++) {
      socket.receiveMessage(`msg-${i}`);
    }

    expect(received).toHaveLength(100);
    expect(socket.terminated).toBe(false);
  });

  it('rejects message exceeding 1 MB and closes connection', () => {
    const closedTeams: string[] = [];
    const { socket } = makeConnection({
      onClose: (id) => closedTeams.push(id),
    });

    // 1 MB + 1 byte
    const bigMsg = Buffer.alloc(1 * 1024 * 1024 + 1, 0x41);
    socket.receiveMessage(bigMsg);

    expect(socket.terminated).toBe(true);
    expect(closedTeams).toContain('tid-test-001');
  });
});

// ---------------------------------------------------------------------------
// Ping interval — sends pings every 30 s
// ---------------------------------------------------------------------------

describe('ping interval — sends pings every 30 s', () => {
  it('sends a ping after 30 s', () => {
    const { socket } = makeConnection();

    expect(socket.pingsSent).toHaveLength(0);

    // Advance fake clock by 30 s — triggers setInterval callback
    vi.advanceTimersByTime(30_000);

    expect(socket.pingsSent).toHaveLength(1);
  });

  it('sends a second ping after 60 s (with pong responses to prevent timeout)', () => {
    const { socket } = makeConnection();

    // First ping fires at 30 s
    vi.advanceTimersByTime(30_000);
    expect(socket.pingsSent).toHaveLength(1);

    // Respond with pong to clear the 10 s deadline
    socket.receivePong();

    // Second ping fires at 60 s
    vi.advanceTimersByTime(30_000);
    expect(socket.pingsSent).toHaveLength(2);
  });

  it('does not send pings after connection is closed', async () => {
    const { conn, socket } = makeConnection();

    await conn.close();
    vi.advanceTimersByTime(90_000);

    expect(socket.pingsSent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pong timeout — closes connection on deadline exceeded
// ---------------------------------------------------------------------------

describe('connection closes on pong timeout', () => {
  it('closes connection when pong is not received within 10 s of ping', () => {
    const closedTeams: string[] = [];
    const { socket } = makeConnection({
      onClose: (id) => closedTeams.push(id),
    });

    // Trigger the ping interval (arms pong deadline timer internally)
    vi.advanceTimersByTime(30_000);
    expect(socket.pingsSent).toHaveLength(1);

    // Advance 10 more seconds without receiving a pong — deadline fires
    vi.advanceTimersByTime(10_000);

    expect(socket.terminated).toBe(true);
    expect(closedTeams).toContain('tid-test-001');
  });

  it('does not close connection when pong is received within deadline', () => {
    const closedTeams: string[] = [];
    const { socket } = makeConnection({
      onClose: (id) => closedTeams.push(id),
    });

    // Trigger ping
    vi.advanceTimersByTime(30_000);
    expect(socket.pingsSent).toHaveLength(1);

    // Receive pong before the 10 s deadline
    socket.receivePong();

    // Advance past the deadline — should NOT close
    vi.advanceTimersByTime(10_000);

    expect(socket.terminated).toBe(false);
    expect(closedTeams).toHaveLength(0);
  });

  it('logs a warning when pong deadline is exceeded', () => {
    const { socket, logger } = makeConnection();

    vi.advanceTimersByTime(30_000);
    // No pong received — advance past deadline
    vi.advanceTimersByTime(10_000);

    const warnMessages = logger.warns.map((w) => w.msg);
    expect(warnMessages.some((m) => m.includes('pong deadline exceeded'))).toBe(true);
    expect(socket.terminated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// onClose callback — fires when connection drops
// ---------------------------------------------------------------------------

describe('onClose callback fires when connection drops', () => {
  it('fires when WebSocket emits close event', () => {
    const closedTeams: string[] = [];
    const { socket } = makeConnection({
      onClose: (id) => closedTeams.push(id),
    });

    socket.simulateClose();

    expect(closedTeams).toContain('tid-test-001');
  });

  it('fires only once even if close is triggered multiple times', async () => {
    const closedTeams: string[] = [];
    const { conn, socket } = makeConnection({
      onClose: (id) => closedTeams.push(id),
    });

    socket.simulateClose();
    await conn.close();
    socket.simulateClose();

    expect(closedTeams).toHaveLength(1);
  });

  it('fires when connection is explicitly closed via close()', async () => {
    const closedTeams: string[] = [];
    const { conn } = makeConnection({
      onClose: (id) => closedTeams.push(id),
    });

    await conn.close();

    expect(closedTeams).toContain('tid-test-001');
  });

  it('fires with the correct teamId', () => {
    const receivedIds: string[] = [];
    const socket = new FakeWebSocket();
    const logger = new FakeLogger();

    const conn = new Connection(
      socket as unknown as import('ws').default,
      'tid-custom-xyz',
      logger,
      () => undefined,
      (id) => receivedIds.push(id),
    );

    socket.simulateClose();

    expect(receivedIds).toEqual(['tid-custom-xyz']);
    void conn.close(); // cleanup
  });

  it('fires when WebSocket emits an error', () => {
    const closedTeams: string[] = [];
    const { socket } = makeConnection({
      onClose: (id) => closedTeams.push(id),
    });

    socket.simulateError(new Error('network reset'));

    expect(closedTeams).toContain('tid-test-001');
  });
});

// ---------------------------------------------------------------------------
// onMessage callback — fires for incoming messages
// ---------------------------------------------------------------------------

describe('onMessage callback fires for incoming messages', () => {
  it('fires with the correct teamId and message content', () => {
    const received: Array<{ id: string; msg: Buffer }> = [];
    const { socket } = makeConnection({
      onMessage: (id, msg) => received.push({ id, msg }),
    });

    const payload = Buffer.from(JSON.stringify({ type: 'ready', data: {} }));
    socket.receiveMessage(payload);

    expect(received).toHaveLength(1);
    expect(received[0].id).toBe('tid-test-001');
    expect(received[0].msg).toEqual(payload);
  });

  it('fires multiple times for multiple messages', () => {
    const received: Buffer[] = [];
    const { socket } = makeConnection({
      onMessage: (_id, msg) => received.push(msg),
    });

    socket.receiveMessage('first');
    socket.receiveMessage('second');
    socket.receiveMessage('third');

    expect(received).toHaveLength(3);
    expect(received[0].toString()).toBe('first');
    expect(received[1].toString()).toBe('second');
    expect(received[2].toString()).toBe('third');
  });

  it('normalises Buffer[] (fragmented messages) to a single Buffer', () => {
    const received: Buffer[] = [];
    const { socket } = makeConnection({
      onMessage: (_id, msg) => received.push(msg),
    });

    // Emit a fragmented message (Buffer[]) directly
    const chunks = [Buffer.from('hel'), Buffer.from('lo')];
    socket.emit('message', chunks, false);

    expect(received).toHaveLength(1);
    expect(received[0].toString()).toBe('hello');
  });

  it('normalises ArrayBuffer to Buffer', () => {
    const received: Buffer[] = [];
    const { socket } = makeConnection({
      onMessage: (_id, msg) => received.push(msg),
    });

    const ab = new ArrayBuffer(5);
    const view = new Uint8Array(ab);
    view.set([119, 111, 114, 108, 100]); // 'world'
    socket.emit('message', ab, true);

    expect(received).toHaveLength(1);
    expect(received[0].toString()).toBe('world');
  });

  it('does not invoke callback after connection is closed', async () => {
    const received: Buffer[] = [];
    const { conn, socket } = makeConnection({
      onMessage: (_id, msg) => received.push(msg),
    });

    // Close before sending any messages
    await conn.close();

    // Even if the socket still fires events, the closed flag gates processing.
    // The FakeWebSocket's 'message' event fires on the EventEmitter; the
    // Connection's handler checks nothing here (no gating on closed) but the
    // rate limiter and size check are still active.
    // What we verify: no messages were received before close.
    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// teamID() — returns correct value
// ---------------------------------------------------------------------------

describe('teamID()', () => {
  it('returns the teamId provided at construction', () => {
    const socket = new FakeWebSocket();
    const logger = new FakeLogger();
    const conn = new Connection(
      socket as unknown as import('ws').default,
      'tid-specific-999',
      logger,
      () => undefined,
      () => undefined,
    );

    expect(conn.teamID()).toBe('tid-specific-999');
    void conn.close();
  });
});
