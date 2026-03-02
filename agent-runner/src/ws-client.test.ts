import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import { WSClient } from './ws-client.js';
import type { WSMessage } from './types.js';

let wss: WebSocketServer;
let port: number;

function waitFor(conditionFn: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = (): void => {
      if (conditionFn()) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error('waitFor timed out'));
      } else {
        setTimeout(check, 10);
      }
    };
    check();
  });
}

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    wss = new WebSocketServer({ port: 0 });
    const address = wss.address();
    if (typeof address === 'object' && address !== null) {
      port = address.port;
    }
    resolve();
  });
}

beforeEach(async () => {
  await startServer();
});

afterEach(() => {
  wss?.close();
});

describe('WSClient', () => {
  it('connects to server', async () => {
    const onConnect = vi.fn();
    const client = new WSClient({
      url: `ws://localhost:${port}`,
      onMessage: () => {},
      onConnect,
    });

    client.connect();

    await waitFor(() => onConnect.mock.calls.length > 0);
    expect(client.isConnected()).toBe(true);
    client.close();
  });

  it('receives messages from server (snake_case wire → camelCase internal)', async () => {
    const messages: WSMessage[] = [];
    const client = new WSClient({
      url: `ws://localhost:${port}`,
      onMessage: (msg) => messages.push(msg),
    });

    wss.on('connection', (ws) => {
      // Go sends snake_case on the wire
      ws.send(JSON.stringify({ type: 'ready', data: { team_id: 'tid-001', agent_count: 2 } }));
    });

    client.connect();

    await waitFor(() => messages.length > 0);
    expect(messages[0].type).toBe('ready');
    // TypeScript receives camelCase
    const data = messages[0].data as { teamId: string; agentCount: number };
    expect(data.teamId).toBe('tid-001');
    expect(data.agentCount).toBe(2);
    client.close();
  });

  it('sends messages to server (camelCase internal → snake_case wire)', async () => {
    const serverMessages: string[] = [];
    const onConnect = vi.fn();

    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        serverMessages.push(data.toString());
      });
    });

    const client = new WSClient({
      url: `ws://localhost:${port}`,
      onMessage: () => {},
      onConnect,
    });

    client.connect();
    await waitFor(() => onConnect.mock.calls.length > 0);

    // TypeScript sends camelCase
    const msg: WSMessage = { type: 'heartbeat', data: { teamId: 'tid-001', agents: [] } };
    client.send(msg);

    await waitFor(() => serverMessages.length > 0);

    // Wire format should be snake_case
    const parsed = JSON.parse(serverMessages[0]) as Record<string, unknown>;
    expect(parsed.type).toBe('heartbeat');
    const data = parsed.data as Record<string, unknown>;
    expect(data.team_id).toBe('tid-001');
    expect(data.agents).toEqual([]);
    client.close();
  });

  it('throws when sending while disconnected', () => {
    const client = new WSClient({
      url: `ws://localhost:${port}`,
      onMessage: () => {},
    });

    expect(() => client.send({ type: 'heartbeat', data: {} })).toThrow('not connected');
  });

  it('calls onDisconnect when server closes', async () => {
    const onDisconnect = vi.fn();
    const onConnect = vi.fn();
    const client = new WSClient({
      url: `ws://localhost:${port}`,
      onMessage: () => {},
      onConnect,
      onDisconnect,
      maxReconnectAttempts: 0,
    });

    client.connect();
    await waitFor(() => onConnect.mock.calls.length > 0);

    // Close all individual server-side connections to trigger client close events
    for (const ws of wss.clients) {
      ws.close();
    }

    await waitFor(() => onDisconnect.mock.calls.length > 0);
    client.close();
  });

  it('handles invalid JSON from server', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onConnect = vi.fn();

    wss.on('connection', (ws) => {
      ws.send('not json at all');
    });

    const client = new WSClient({
      url: `ws://localhost:${port}`,
      onMessage: () => {},
      onConnect,
    });

    client.connect();
    await waitFor(() => onConnect.mock.calls.length > 0);

    // Wait a bit for the error handler
    await new Promise((r) => setTimeout(r, 100));

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
    client.close();
  });

  it('isConnected returns false after close', async () => {
    const onConnect = vi.fn();
    const client = new WSClient({
      url: `ws://localhost:${port}`,
      onMessage: () => {},
      onConnect,
    });

    client.connect();
    await waitFor(() => onConnect.mock.calls.length > 0);

    client.close();
    expect(client.isConnected()).toBe(false);
  });
});
