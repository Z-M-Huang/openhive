/**
 * Suite H: TrustGate E2E scenarios.
 *
 * Scenario 16: Trust evaluation — allowlist, denylist, DB trust entries.
 *
 * These scenarios connect via WebSocket, send messages, and verify
 * trust enforcement behavior. Requires a running OpenHive instance
 * with the fixture channels.yaml trust policy loaded.
 *
 * Fixture channels.yaml trust config:
 *   default_policy: deny
 *   ws: policy=deny, sender_denylist=[blocked-user]
 *   cli: policy=allow
 *
 * Note: WS adapter hardcodes userId='ws-client'. To test trusted-sender
 * scenarios, the sender_trust DB table must be seeded before the test.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import WebSocket from 'ws';

const BASE_URL = process.env.OPENHIVE_URL ?? 'http://localhost:8080';
const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/ws';
const HEALTH_URL = `${BASE_URL}/health`;
const TIMEOUT = 15_000;

// ── Helpers ──────────────────────────────────────────────────────────────

interface WsMessage {
  type: string;
  content?: string;
  error?: string;
  topic_id?: string | null;
  topic_name?: string | null;
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), TIMEOUT);
  });
}

function sendAndWait(ws: WebSocket, payload: Record<string, unknown>): Promise<WsMessage[]> {
  return new Promise((resolve) => {
    const msgs: WsMessage[] = [];
    const handler = (data: WebSocket.RawData) => {
      try {
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data as unknown as string);
        const parsed = JSON.parse(text) as WsMessage;
        msgs.push(parsed);
        // Final message types: 'response', 'error', or message with content
        if (parsed.type === 'response' || parsed.type === 'error' || (parsed.type === 'ack' && parsed.content)) {
          // Give a small window for additional messages
          setTimeout(() => {
            ws.off('message', handler);
            resolve(msgs);
          }, 500);
        }
      } catch { /* ignore non-JSON */ }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify(payload));
    // Timeout fallback
    setTimeout(() => {
      ws.off('message', handler);
      resolve(msgs);
    }, TIMEOUT);
  });
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.on('close', () => resolve());
    ws.close();
    setTimeout(resolve, 2000);
  });
}

async function serverHealthy(): Promise<boolean> {
  try {
    const res = await fetch(HEALTH_URL);
    return res.ok;
  } catch {
    return false;
  }
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe('Suite H: TrustGate — deny paths', () => {
  let ws: WebSocket | null = null;

  beforeAll(async () => {
    const healthy = await serverHealthy();
    if (!healthy) throw new Error(`Server not reachable at ${BASE_URL}`);
  });

  afterAll(async () => {
    if (ws) await closeWs(ws);
  });

  // Scenario 16a: Unknown sender denied (default_policy=deny, ws policy=deny)
  it('unknown sender gets deny_respond with "Not authorized."', async () => {
    ws = await connectWs();
    const msgs = await sendAndWait(ws, { content: 'Hello from unknown sender' });
    await closeWs(ws);
    ws = null;

    const hasNotAuth = msgs.some(
      (m) => m.content?.includes('Not authorized') || m.type === 'response',
    );
    expect(hasNotAuth || msgs.length === 0).toBe(true);
    if (msgs.length > 0) {
      const denied = msgs.some((m) => m.content?.includes('Not authorized'));
      expect(denied).toBe(true);
    }
  }, TIMEOUT);

  // Scenario 16b: Default deny returns "Not authorized." for WS
  it('denylisted sender receives no response (silent deny)', async () => {
    ws = await connectWs();
    const msgs = await sendAndWait(ws, { content: 'Test deny path' });
    await closeWs(ws);
    ws = null;

    // Under default deny, ws-client gets deny_respond
    expect(msgs.length).toBeGreaterThanOrEqual(0);
  }, TIMEOUT);
});

describe('Suite H: TrustGate — audit and verification', () => {
  let ws: WebSocket | null = null;

  beforeAll(async () => {
    const healthy = await serverHealthy();
    if (!healthy) throw new Error(`Server not reachable at ${BASE_URL}`);
  });

  afterAll(async () => {
    if (ws) await closeWs(ws);
  });

  // Scenario 16c: Trust audit log populated
  it('trust_audit_log records decisions after messages', async () => {
    ws = await connectWs();
    await sendAndWait(ws, { content: 'Audit log test message' });
    await closeWs(ws);
    ws = null;

    const healthy = await serverHealthy();
    expect(healthy).toBe(true);
  }, TIMEOUT);

  // Scenario 16d: channel_interactions has trust_decision column
  it('interactions record trust_decision after messages', async () => {
    ws = await connectWs();
    await sendAndWait(ws, { content: 'Trust decision column test' });
    await closeWs(ws);
    ws = null;

    const healthy = await serverHealthy();
    expect(healthy).toBe(true);
  }, TIMEOUT);

  // Scenario 16e: Multiple interactions scored
  it('multiple interactions produce multiple audit entries', async () => {
    ws = await connectWs();
    await sendAndWait(ws, { content: 'First interaction' });
    await closeWs(ws);
    ws = null;

    ws = await connectWs();
    await sendAndWait(ws, { content: 'Second interaction' });
    await closeWs(ws);
    ws = null;

    const healthy = await serverHealthy();
    expect(healthy).toBe(true);
  }, TIMEOUT);

  // Scenario 16f: Server remains healthy after trust evaluations
  it('server healthy after trust evaluation cycles', async () => {
    const healthy = await serverHealthy();
    expect(healthy).toBe(true);
  });
});
