/**
 * Tests for backend/src/ws/hub.ts
 *
 * Tests cover:
 *   - Hub manages connection lifecycle (register/unregister)
 *   - HandleUpgrade rejects missing token — connection fails, hub stays empty
 *   - HandleUpgrade rejects invalid/expired token — connection fails, hub stays empty
 *   - HandleUpgrade rejects requests with disallowed Origin header
 *   - HandleUpgrade accepts requests with no Origin header (container-to-container)
 *   - HandleUpgrade accepts requests with Origin in allowedOrigins set
 *   - HandleUpgrade creates and registers connection on valid token
 *   - HandleUpgrade only handles /ws/container path, ignores other upgrade requests
 *   - Token is consumed after successful upgrade (one-time use verified)
 *   - SendToTeam delivers message to correct connection
 *   - SendToTeam throws NotFoundError for unknown team
 *   - BroadcastAll sends to all connected teams
 *   - Close closes all connections and wss
 *   - onConnect callback fires after successful upgrade
 *   - Non-container upgrade requests are passed through (not intercepted)
 *
 * Note: bun replaces the ws library's WebSocket client with its own
 * implementation which does not support the 'unexpected-response' event.
 * Rejection tests therefore verify the connection fails (error event fires)
 * and that the hub has zero connections — not the exact HTTP status code.
 *
 * The ws npm library's WebSocketServer is used for the hub internals (server-side),
 * which is unaffected by bun's WebSocket override.
 *
 * Fake connections (FakeWSConnection) are used for pure unit tests of registry
 * logic that do not need a real network connection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import WS, { WebSocketServer } from 'ws';

import { Hub } from './hub.js';
import { NotFoundError } from '../domain/errors.js';
import type { WSConnection } from '../domain/interfaces.js';

// ---------------------------------------------------------------------------
// FakeLogger
// ---------------------------------------------------------------------------

interface LogCall {
  msg: string;
  args: unknown[];
}

class FakeLogger {
  readonly debugs: LogCall[] = [];
  readonly infos: LogCall[] = [];
  readonly warns: LogCall[] = [];
  readonly errors: LogCall[] = [];

  debug(msg: string, ...args: unknown[]): void {
    this.debugs.push({ msg, args });
  }

  info(msg: string, ...args: unknown[]): void {
    this.infos.push({ msg, args });
  }

  warn(msg: string, ...args: unknown[]): void {
    this.warns.push({ msg, args });
  }

  error(msg: string, ...args: unknown[]): void {
    this.errors.push({ msg, args });
  }
}

// ---------------------------------------------------------------------------
// FakeWSConnection
// ---------------------------------------------------------------------------

class FakeWSConnection extends EventEmitter implements WSConnection {
  readonly _teamId: string;
  closed = false;
  readonly sentMessages: Array<Buffer | string> = [];

  constructor(teamId: string) {
    super();
    this._teamId = teamId;
  }

  teamID(): string {
    return this._teamId;
  }

  async send(msg: Buffer | string): Promise<void> {
    if (this.closed) throw new Error('connection is closed');
    this.sentMessages.push(msg);
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.emit('closed');
    }
  }
}

// ---------------------------------------------------------------------------
// Server helpers
// ---------------------------------------------------------------------------

interface HubServer {
  hub: Hub;
  logger: FakeLogger;
  serverUrl: string;
  cleanup: () => Promise<void>;
}

function makeHubWithServer(opts?: { allowedOrigins?: Set<string> }): HubServer {
  const logger = new FakeLogger();
  const hub = new Hub({ logger, allowedOrigins: opts?.allowedOrigins });

  const server = createServer();
  hub.attachToServer(server);
  server.listen(0);
  const port = (server.address() as AddressInfo).port;

  const cleanup = async (): Promise<void> => {
    await hub.close();
    // Force-close all lingering TCP connections before server.close()
    if (typeof (server as { closeAllConnections?: () => void }).closeAllConnections === 'function') {
      (server as { closeAllConnections: () => void }).closeAllConnections();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { hub, logger, serverUrl: `ws://127.0.0.1:${port}`, cleanup };
}

/**
 * Opens a WS connection and resolves when open.
 * `headers` are passed to the ws library client constructor.
 * Always attaches a no-op error handler to prevent unhandled error events
 * in bun's WebSocket implementation.
 */
function connectWS(url: string, headers?: Record<string, string>): Promise<WS> {
  return new Promise<WS>((resolve, reject) => {
    const ws = new WS(url, { headers });
    // IMPORTANT: Always attach error handler first to prevent unhandled error in bun
    ws.on('error', () => { /* suppress bun's ErrorEvent propagation */ });
    ws.once('open', () => resolve(ws));
    ws.once('close', (code: number) => {
      if (code !== 1000) {
        reject(new Error(`WebSocket closed with code ${code} before opening`));
      }
    });
  });
}

/**
 * Attempts a WS connection and expects it to FAIL (server rejects it).
 * Resolves when the close event fires with a non-1000 code (abnormal closure).
 * Rejects on unexpected open.
 *
 * Note: bun's WebSocket does not emit 'unexpected-response' and throws
 * ErrorEvent as an unhandled exception if we rely on the 'error' event alone.
 * We use the 'close' event (code 1006 for abnormal closure) instead, and
 * attach a no-op 'error' handler to suppress the unhandled propagation.
 */
function expectConnectionFails(url: string, headers?: Record<string, string>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ws = new WS(url, { headers });
    // IMPORTANT: Suppress error event first — prevents bun's uncaught ErrorEvent
    ws.on('error', () => { /* suppress unhandled error in bun */ });
    ws.once('open', () => {
      ws.close();
      reject(new Error('Expected connection to fail but it opened'));
    });
    ws.once('close', (code: number) => {
      // 1006 = abnormal closure (server rejected or destroyed connection)
      if (code === 1000) {
        reject(new Error('Expected abnormal close but got 1000 (normal)'));
      } else {
        resolve(); // Connection was rejected as expected
      }
    });
    // Timeout safety
    setTimeout(() => reject(new Error('expectConnectionFails timeout')), 3000);
  });
}

/**
 * Waits until the hub has `count` connected teams.
 */
async function waitForConnections(hub: Hub, count: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (hub.getConnectedTeams().length === count) return;
    await new Promise<void>((r) => setTimeout(r, 10));
  }
  throw new Error(`Timeout: expected ${count} connections, got ${hub.getConnectedTeams().length}`);
}

// ---------------------------------------------------------------------------
// Tests: Hub registry (unit — no network)
// ---------------------------------------------------------------------------

describe('Hub connection registry', () => {
  let hub: Hub;
  let logger: FakeLogger;

  beforeEach(() => {
    logger = new FakeLogger();
    hub = new Hub({ logger });
  });

  afterEach(async () => {
    await hub.close();
  });

  it('starts with an empty connections map', () => {
    expect(hub.getConnectedTeams()).toHaveLength(0);
  });

  it('registerConnection adds a connection for a team', () => {
    hub.registerConnection('tid-team-001', new FakeWSConnection('tid-team-001'));
    expect(hub.getConnectedTeams()).toContain('tid-team-001');
  });

  it('unregisterConnection removes the connection', () => {
    hub.registerConnection('tid-team-001', new FakeWSConnection('tid-team-001'));
    hub.unregisterConnection('tid-team-001');
    expect(hub.getConnectedTeams()).not.toContain('tid-team-001');
  });

  it('registerConnection closes existing connection before replacing', async () => {
    const conn1 = new FakeWSConnection('tid-team-001');
    hub.registerConnection('tid-team-001', conn1);

    const conn2 = new FakeWSConnection('tid-team-001');
    hub.registerConnection('tid-team-001', conn2);

    await new Promise<void>((r) => setTimeout(r, 10));

    expect(conn1.closed).toBe(true);
    expect(hub.getConnectedTeams()).toHaveLength(1);
  });

  it('getConnectedTeams returns all registered team IDs', () => {
    hub.registerConnection('tid-team-001', new FakeWSConnection('tid-team-001'));
    hub.registerConnection('tid-team-002', new FakeWSConnection('tid-team-002'));
    hub.registerConnection('tid-team-003', new FakeWSConnection('tid-team-003'));

    const teams = hub.getConnectedTeams();
    expect(teams).toHaveLength(3);
    expect(teams).toContain('tid-team-001');
    expect(teams).toContain('tid-team-002');
    expect(teams).toContain('tid-team-003');
  });
});

// ---------------------------------------------------------------------------
// Tests: generateToken
// ---------------------------------------------------------------------------

describe('Hub.generateToken', () => {
  let hub: Hub;

  beforeEach(() => { hub = new Hub({ logger: new FakeLogger() }); });
  afterEach(async () => { await hub.close(); });

  it('returns a 64-character hex string', () => {
    const token = hub.generateToken('tid-team-001');
    expect(token).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(token)).toBe(true);
  });

  it('returns unique tokens on each call', () => {
    expect(hub.generateToken('tid-team-001')).not.toBe(hub.generateToken('tid-team-001'));
  });
});

// ---------------------------------------------------------------------------
// Tests: sendToTeam
// ---------------------------------------------------------------------------

describe('Hub.sendToTeam', () => {
  let hub: Hub;

  beforeEach(() => { hub = new Hub({ logger: new FakeLogger() }); });
  afterEach(async () => { await hub.close(); });

  it('delivers a message to the correct connection', async () => {
    const conn = new FakeWSConnection('tid-team-001');
    hub.registerConnection('tid-team-001', conn);

    const msg = Buffer.from('{"type":"task_dispatch"}');
    await hub.sendToTeam('tid-team-001', msg);

    expect(conn.sentMessages).toHaveLength(1);
    expect(conn.sentMessages[0]).toEqual(msg);
  });

  it('delivers a string message', async () => {
    const conn = new FakeWSConnection('tid-team-001');
    hub.registerConnection('tid-team-001', conn);
    await hub.sendToTeam('tid-team-001', 'hello');
    expect(conn.sentMessages[0]).toBe('hello');
  });

  it('throws NotFoundError for unknown team', async () => {
    await expect(hub.sendToTeam('tid-nonexistent', Buffer.from('msg'))).rejects.toThrow(NotFoundError);
  });

  it('NotFoundError has correct resource and id fields', async () => {
    try {
      await hub.sendToTeam('tid-nonexistent', Buffer.from('msg'));
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      const nfe = err as NotFoundError;
      expect(nfe.resource).toBe('ws_connection');
      expect(nfe.id).toBe('tid-nonexistent');
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: broadcastAll
// ---------------------------------------------------------------------------

describe('Hub.broadcastAll', () => {
  let hub: Hub;
  let logger: FakeLogger;

  beforeEach(() => {
    logger = new FakeLogger();
    hub = new Hub({ logger });
  });

  afterEach(async () => { await hub.close(); });

  it('sends to all connected teams', async () => {
    const conn1 = new FakeWSConnection('tid-team-001');
    const conn2 = new FakeWSConnection('tid-team-002');
    hub.registerConnection('tid-team-001', conn1);
    hub.registerConnection('tid-team-002', conn2);

    await hub.broadcastAll(Buffer.from('broadcast'));

    expect(conn1.sentMessages).toHaveLength(1);
    expect(conn2.sentMessages).toHaveLength(1);
  });

  it('does not throw when a team send fails, logs warning', async () => {
    const conn1 = new FakeWSConnection('tid-team-001');
    const conn2 = new FakeWSConnection('tid-team-002');
    conn2.closed = true; // causes send() to throw

    hub.registerConnection('tid-team-001', conn1);
    hub.registerConnection('tid-team-002', conn2);

    await expect(hub.broadcastAll(Buffer.from('msg'))).resolves.toBeUndefined();
    expect(conn1.sentMessages).toHaveLength(1);
    expect(logger.warns.some((w) => w.msg.includes('broadcast send failed'))).toBe(true);
  });

  it('is a no-op when no connections exist', async () => {
    await expect(hub.broadcastAll(Buffer.from('msg'))).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: callbacks setters
// ---------------------------------------------------------------------------

describe('Hub callbacks', () => {
  let hub: Hub;

  beforeEach(() => { hub = new Hub({ logger: new FakeLogger() }); });
  afterEach(async () => { await hub.close(); });

  it('setOnMessage accepts a callback without throwing', () => {
    expect(() => hub.setOnMessage((_id, _msg) => undefined)).not.toThrow();
  });

  it('setOnConnect accepts a callback without throwing', () => {
    expect(() => hub.setOnConnect((_id) => undefined)).not.toThrow();
  });

  it('getUpgradeHandler returns a function', () => {
    expect(typeof hub.getUpgradeHandler()).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Tests: close()
// ---------------------------------------------------------------------------

describe('Hub.close', () => {
  it('closes all connections and clears registry', async () => {
    const hub = new Hub({ logger: new FakeLogger() });
    const conn1 = new FakeWSConnection('tid-team-001');
    const conn2 = new FakeWSConnection('tid-team-002');
    hub.registerConnection('tid-team-001', conn1);
    hub.registerConnection('tid-team-002', conn2);

    await hub.close();

    expect(conn1.closed).toBe(true);
    expect(conn2.closed).toBe(true);
    expect(hub.getConnectedTeams()).toHaveLength(0);
  });

  it('is idempotent — second close does not throw', async () => {
    const hub = new Hub({ logger: new FakeLogger() });
    await hub.close();
    await expect(hub.close()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: HandleUpgrade — rejection scenarios
// ---------------------------------------------------------------------------

describe('Hub upgrade — rejection (connection fails, hub stays empty)', () => {
  it('rejects missing token — connection error fires', async () => {
    const { hub, serverUrl, cleanup } = makeHubWithServer();

    await expectConnectionFails(`${serverUrl}/ws/container`);
    // Hub should have no connections
    expect(hub.getConnectedTeams()).toHaveLength(0);

    await cleanup();
  }, 8000);

  it('rejects invalid/unknown token — connection error fires', async () => {
    const { hub, serverUrl, cleanup } = makeHubWithServer();

    await expectConnectionFails(`${serverUrl}/ws/container?token=invalid-token-value`);
    expect(hub.getConnectedTeams()).toHaveLength(0);

    await cleanup();
  }, 8000);

  it('rejects expired/consumed token — connection error fires', async () => {
    const { hub, serverUrl, cleanup } = makeHubWithServer();

    const token = hub.generateToken('tid-team-001');
    const url = `${serverUrl}/ws/container?token=${token}`;

    // First connection succeeds — consumes the token
    const ws = await connectWS(url);
    await waitForConnections(hub, 1);
    ws.terminate();

    await new Promise<void>((r) => setTimeout(r, 50));

    // Second attempt with the same (now-consumed) token must fail
    await expectConnectionFails(url);

    await cleanup();
  }, 8000);

  it('rejects disallowed Origin header — connection error fires', async () => {
    const { hub, serverUrl, cleanup } = makeHubWithServer({
      allowedOrigins: new Set(['https://allowed.example.com']),
    });

    const token = hub.generateToken('tid-team-001');
    const url = `${serverUrl}/ws/container?token=${token}`;

    await expectConnectionFails(url, { Origin: 'https://evil.example.com' });
    expect(hub.getConnectedTeams()).toHaveLength(0);

    await cleanup();
  }, 8000);
});

// ---------------------------------------------------------------------------
// Tests: HandleUpgrade — success scenarios
// ---------------------------------------------------------------------------

describe('Hub upgrade — success', () => {
  it('accepts valid token and registers connection', async () => {
    const { hub, serverUrl, cleanup } = makeHubWithServer();

    const token = hub.generateToken('tid-team-001');
    const ws = await connectWS(`${serverUrl}/ws/container?token=${token}`);
    await waitForConnections(hub, 1);

    expect(hub.getConnectedTeams()).toContain('tid-team-001');
    ws.terminate();
    await cleanup();
  }, 8000);

  it('accepts requests with no Origin header (container-to-container)', async () => {
    const { hub, serverUrl, cleanup } = makeHubWithServer({
      allowedOrigins: new Set(['https://allowed.example.com']),
    });

    const token = hub.generateToken('tid-team-001');
    // No Origin header — ws library doesn't send one by default
    const ws = await connectWS(`${serverUrl}/ws/container?token=${token}`);
    await waitForConnections(hub, 1);

    expect(hub.getConnectedTeams()).toContain('tid-team-001');
    ws.terminate();
    await cleanup();
  }, 8000);

  it('accepts requests with Origin in allowedOrigins', async () => {
    const { hub, serverUrl, cleanup } = makeHubWithServer({
      allowedOrigins: new Set(['https://allowed.example.com']),
    });

    const token = hub.generateToken('tid-team-001');
    const ws = await connectWS(
      `${serverUrl}/ws/container?token=${token}`,
      { Origin: 'https://allowed.example.com' },
    );
    await waitForConnections(hub, 1);

    expect(hub.getConnectedTeams()).toContain('tid-team-001');
    ws.terminate();
    await cleanup();
  }, 8000);

  it('accepts any Origin when allowedOrigins is empty (default)', async () => {
    const { hub, serverUrl, cleanup } = makeHubWithServer();

    const token = hub.generateToken('tid-team-001');
    const ws = await connectWS(
      `${serverUrl}/ws/container?token=${token}`,
      { Origin: 'https://any-origin.example.com' },
    );
    await waitForConnections(hub, 1);

    expect(hub.getConnectedTeams()).toContain('tid-team-001');
    ws.terminate();
    await cleanup();
  }, 8000);

  it('token is consumed after successful upgrade (one-time use)', async () => {
    const { hub, serverUrl, cleanup } = makeHubWithServer();

    const token = hub.generateToken('tid-team-001');
    const url = `${serverUrl}/ws/container?token=${token}`;

    // First connection
    const ws1 = await connectWS(url);
    await waitForConnections(hub, 1);
    ws1.terminate();

    await new Promise<void>((r) => setTimeout(r, 50));

    // Second attempt — same token must fail
    await expectConnectionFails(url);

    await cleanup();
  }, 8000);

  it('onConnect callback fires after successful upgrade', async () => {
    const { hub, serverUrl, cleanup } = makeHubWithServer();

    const connected: string[] = [];
    hub.setOnConnect((teamID) => connected.push(teamID));

    const token = hub.generateToken('tid-team-001');
    const ws = await connectWS(`${serverUrl}/ws/container?token=${token}`);
    await waitForConnections(hub, 1);

    expect(connected).toContain('tid-team-001');
    ws.terminate();
    await cleanup();
  }, 8000);
});

// ---------------------------------------------------------------------------
// Tests: Path routing
// ---------------------------------------------------------------------------

describe('Hub path routing', () => {
  it('ignores upgrade requests for other paths (passes through to other handlers)', async () => {
    const logger = new FakeLogger();
    const hub = new Hub({ logger });

    const server = createServer();
    hub.attachToServer(server);

    // Secondary WS server for /ws/other — registered AFTER hub's listener
    const otherWss = new WebSocketServer({ noServer: true });
    let otherConnected = false;
    otherWss.on('connection', () => { otherConnected = true; });

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '', 'http://localhost');
      if (url.pathname === '/ws/other') {
        otherWss.handleUpgrade(request, socket, head, (ws) => {
          otherWss.emit('connection', ws, request);
        });
      }
    });

    server.listen(0);
    const port = (server.address() as AddressInfo).port;

    // Connect to /ws/other — hub should NOT intercept it
    const ws = await connectWS(`ws://127.0.0.1:${port}/ws/other`);
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(otherConnected).toBe(true);
    expect(hub.getConnectedTeams()).toHaveLength(0); // hub has no connections

    ws.terminate();
    await hub.close();
    otherWss.close();
    if (typeof (server as { closeAllConnections?: () => void }).closeAllConnections === 'function') {
      (server as { closeAllConnections: () => void }).closeAllConnections();
    }
    await new Promise<void>((r) => server.close(() => r()));
  }, 10000);

  it('handles /ws/container while leaving other paths for downstream handlers', async () => {
    const logger = new FakeLogger();
    const hub = new Hub({ logger });

    const server = createServer();
    hub.attachToServer(server);

    // /ws/portal handler (downstream)
    const portalWss = new WebSocketServer({ noServer: true });
    let portalConnected = false;
    portalWss.on('connection', () => { portalConnected = true; });

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '', 'http://localhost');
      if (url.pathname === '/ws/portal') {
        portalWss.handleUpgrade(request, socket, head, (ws) => {
          portalWss.emit('connection', ws, request);
        });
      }
    });

    server.listen(0);
    const port = (server.address() as AddressInfo).port;
    const serverUrl = `ws://127.0.0.1:${port}`;

    // /ws/portal should work (not intercepted by hub)
    const ws1 = await connectWS(`${serverUrl}/ws/portal`);
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(portalConnected).toBe(true);
    expect(hub.getConnectedTeams()).toHaveLength(0);

    // /ws/container with valid token should work too
    const token = hub.generateToken('tid-team-001');
    const ws2 = await connectWS(`${serverUrl}/ws/container?token=${token}`);
    await waitForConnections(hub, 1);
    expect(hub.getConnectedTeams()).toContain('tid-team-001');

    ws1.terminate();
    ws2.terminate();
    await hub.close();
    portalWss.close();
    if (typeof (server as { closeAllConnections?: () => void }).closeAllConnections === 'function') {
      (server as { closeAllConnections: () => void }).closeAllConnections();
    }
    await new Promise<void>((r) => server.close(() => r()));
  }, 10000);
});

// ---------------------------------------------------------------------------
// Tests: onMessage callback
// ---------------------------------------------------------------------------

describe('Hub onMessage callback', () => {
  it('fires when a container sends a message', async () => {
    const { hub, serverUrl, cleanup } = makeHubWithServer();

    const receivedMessages: Array<{ teamID: string; msg: Buffer }> = [];
    hub.setOnMessage((teamID, msg) => receivedMessages.push({ teamID, msg }));

    const token = hub.generateToken('tid-team-001');
    const ws = await connectWS(`${serverUrl}/ws/container?token=${token}`);
    await waitForConnections(hub, 1);

    const payload = JSON.stringify({ type: 'ready', data: { team_id: 'tid-team-001', agent_count: 1 } });
    ws.send(payload);

    await new Promise<void>((r) => setTimeout(r, 100));

    expect(receivedMessages).toHaveLength(1);
    expect(receivedMessages[0].teamID).toBe('tid-team-001');
    expect(receivedMessages[0].msg.toString()).toBe(payload);

    ws.terminate();
    await cleanup();
  }, 8000);
});

// ---------------------------------------------------------------------------
// Tests: Full upgrade flow
// ---------------------------------------------------------------------------

describe('Hub upgrade — full integration', () => {
  it('registers multiple teams from sequential connections', async () => {
    const { hub, serverUrl, cleanup } = makeHubWithServer();

    const wsClients: WS[] = [];
    for (const teamID of ['tid-team-001', 'tid-team-002']) {
      const token = hub.generateToken(teamID);
      const ws = await connectWS(`${serverUrl}/ws/container?token=${token}`);
      wsClients.push(ws);
    }

    await waitForConnections(hub, 2);

    const teams = hub.getConnectedTeams();
    expect(teams).toHaveLength(2);
    expect(teams).toContain('tid-team-001');
    expect(teams).toContain('tid-team-002');

    for (const ws of wsClients) ws.terminate();
    await cleanup();
  }, 10000);

  it('unregisters team when client disconnects', async () => {
    const { hub, serverUrl, cleanup } = makeHubWithServer();

    const token = hub.generateToken('tid-team-001');
    const ws = await connectWS(`${serverUrl}/ws/container?token=${token}`);
    await waitForConnections(hub, 1);

    ws.terminate();

    // Wait for the disconnect to propagate
    const start = Date.now();
    while (hub.getConnectedTeams().length > 0 && Date.now() - start < 2000) {
      await new Promise<void>((r) => setTimeout(r, 10));
    }

    expect(hub.getConnectedTeams()).toHaveLength(0);
    await cleanup();
  }, 8000);

  it('sends messages to specific teams via sendToTeam', async () => {
    const { hub, serverUrl, cleanup } = makeHubWithServer();

    const token = hub.generateToken('tid-team-001');
    const ws = await connectWS(`${serverUrl}/ws/container?token=${token}`);
    await waitForConnections(hub, 1);

    const received: string[] = [];
    ws.on('message', (data: Buffer) => received.push(data.toString()));

    const msg = '{"type":"task_dispatch","data":{}}';
    await hub.sendToTeam('tid-team-001', msg);

    await new Promise<void>((r) => setTimeout(r, 100));

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(msg);

    ws.terminate();
    await cleanup();
  }, 8000);

  it('broadcasts to all connected teams', async () => {
    const { hub, serverUrl, cleanup } = makeHubWithServer();

    const wsClients: WS[] = [];
    const received: string[][] = [[], []];

    for (let i = 0; i < 2; i++) {
      const teamID = `tid-team-00${i + 1}`;
      const token = hub.generateToken(teamID);
      const ws = await connectWS(`${serverUrl}/ws/container?token=${token}`);
      const idx = i;
      ws.on('message', (data: Buffer) => received[idx].push(data.toString()));
      wsClients.push(ws);
    }

    await waitForConnections(hub, 2);

    const msg = '{"type":"shutdown","data":{"reason":"test","timeout":0}}';
    await hub.broadcastAll(msg);

    await new Promise<void>((r) => setTimeout(r, 100));

    expect(received[0]).toHaveLength(1);
    expect(received[1]).toHaveLength(1);
    expect(received[0][0]).toBe(msg);
    expect(received[1][0]).toBe(msg);

    for (const ws of wsClients) ws.terminate();
    await cleanup();
  }, 10000);
});
