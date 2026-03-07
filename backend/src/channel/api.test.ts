/**
 * Tests for APIChannel (backend/src/channel/api.ts)
 *
 * All tests use an injected short timeout (50 ms) to keep the suite fast.
 * The timeout test relies on this injected duration rather than fake timers,
 * which avoids compatibility issues across test runners.
 *
 * Test index:
 *  1. HandleChat dispatches message and returns response
 *  2. HandleChat times out after 5 minutes (injected short timeout)
 *  3. HandleChat rejects when not connected
 *  4. HandleChat rejects empty content
 *  5. SendMessage resolves pending request
 *  6. SendMessage ignores unknown JID
 *  7. Disconnect rejects all pending requests
 */

import { describe, it, expect, vi } from 'vitest';

import { APIChannel } from './api.js';
import type { APIFastifyRequest, APIFastifyReply, APILogger } from './api.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a no-op logger with vitest spies. */
function makeLogger(): APILogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/**
 * Builds a minimal mock APIFastifyReply.
 * Captures the status code and payload sent to the client.
 */
function makeReply(): {
  reply: APIFastifyReply;
  sentStatus: () => number | null;
  sentBody: () => unknown;
} {
  let status: number | null = null;
  let body: unknown = undefined;

  const reply: APIFastifyReply = {
    code(statusCode: number): APIFastifyReply {
      status = statusCode;
      return reply;
    },
    send(payload: unknown): void {
      body = payload;
    },
  };

  return {
    reply,
    sentStatus: () => status,
    sentBody: () => body,
  };
}

/**
 * Builds a minimal APIFastifyRequest with the given body.
 */
function makeRequest(body: unknown): APIFastifyRequest {
  return {
    body,
    headers: {},
  };
}

/**
 * Creates a connected APIChannel with a short timeout (50 ms) for tests.
 * Registers a messageCallback spy and connects the channel.
 */
async function makeConnectedChannel(options?: { timeoutMs?: number }): Promise<{
  channel: APIChannel;
  messageCallback: ReturnType<typeof vi.fn>;
  logger: APILogger;
}> {
  const logger = makeLogger();
  const channel = new APIChannel(logger, { timeoutMs: options?.timeoutMs ?? 50 });
  const messageCallback = vi.fn();
  channel.onMessage(messageCallback);
  await channel.connect();
  return { channel, messageCallback, logger };
}

// ---------------------------------------------------------------------------
// Test 1: HandleChat dispatches message and returns response
// ---------------------------------------------------------------------------

describe('HandleChat dispatches message and returns response', () => {
  it('calls the onMessage callback and resolves with the agent response', async () => {
    const { channel, messageCallback } = await makeConnectedChannel();
    const { reply, sentStatus, sentBody } = makeReply();
    const request = makeRequest({ content: 'hello world' });

    // Trigger handleChat — it fires async, does NOT block
    channel.handleChat(request, reply);

    // The onMessage callback must have been called synchronously
    expect(messageCallback).toHaveBeenCalledOnce();
    const [jid, content] = messageCallback.mock.calls[0] as [string, string];
    expect(jid).toMatch(/^api:\d+$/);
    expect(content).toBe('hello world');

    // Simulate agent sending back a response via sendMessage
    await channel.sendMessage(jid, 'the answer is 42');

    // Give the microtask queue a tick to settle the Promise.race resolution
    await Promise.resolve();

    expect(sentStatus()).toBe(200);
    const body = sentBody() as { data: { response: string } };
    expect(body.data.response).toBe('the answer is 42');
  });
});

// ---------------------------------------------------------------------------
// Test 2: HandleChat times out after 5 minutes (injected short timeout)
// ---------------------------------------------------------------------------

describe('HandleChat times out after 5 minutes', () => {
  it('returns 408 when no response arrives within timeoutMs', async () => {
    // Inject a 30 ms timeout so the test does not wait 5 real minutes.
    // The timeout mechanism under test is identical regardless of the duration.
    const logger = makeLogger();
    const channel = new APIChannel(logger, { timeoutMs: 30 });
    channel.onMessage(vi.fn()); // dispatch but never call sendMessage
    await channel.connect();

    const { reply, sentStatus, sentBody } = makeReply();
    const request = makeRequest({ content: 'hello' });

    channel.handleChat(request, reply);

    // Wait longer than the injected 30 ms timeout
    await new Promise<void>(resolve => setTimeout(resolve, 80));

    expect(sentStatus()).toBe(408);
    const body = sentBody() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('TIMEOUT');
  });
});

// ---------------------------------------------------------------------------
// Test 3: HandleChat rejects when not connected
// ---------------------------------------------------------------------------

describe('HandleChat rejects when not connected', () => {
  it('returns 503 CHANNEL_UNAVAILABLE immediately when not connected', () => {
    const channel = new APIChannel(null);
    const { reply, sentStatus, sentBody } = makeReply();
    const request = makeRequest({ content: 'hello' });

    // channel.connect() NOT called — still disconnected
    channel.handleChat(request, reply);

    expect(sentStatus()).toBe(503);
    const body = sentBody() as { error: { code: string } };
    expect(body.error.code).toBe('CHANNEL_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------
// Test 4: HandleChat rejects empty content
// ---------------------------------------------------------------------------

describe('HandleChat rejects empty content', () => {
  it('returns 400 INVALID_REQUEST for empty content string', async () => {
    const { channel } = await makeConnectedChannel();
    const { reply, sentStatus, sentBody } = makeReply();
    const request = makeRequest({ content: '' });

    channel.handleChat(request, reply);

    expect(sentStatus()).toBe(400);
    const body = sentBody() as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_REQUEST');
  });

  it('returns 400 INVALID_REQUEST for whitespace-only content', async () => {
    const { channel } = await makeConnectedChannel();
    const { reply, sentStatus, sentBody } = makeReply();
    const request = makeRequest({ content: '   ' });

    channel.handleChat(request, reply);

    expect(sentStatus()).toBe(400);
    const body = sentBody() as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_REQUEST');
  });

  it('returns 400 INVALID_REQUEST when body is missing content field', async () => {
    const { channel } = await makeConnectedChannel();
    const { reply, sentStatus, sentBody } = makeReply();
    const request = makeRequest({ other: 'field' });

    channel.handleChat(request, reply);

    expect(sentStatus()).toBe(400);
    const body = sentBody() as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_REQUEST');
  });

  it('returns 400 INVALID_REQUEST when body is null', async () => {
    const { channel } = await makeConnectedChannel();
    const { reply, sentStatus, sentBody } = makeReply();
    const request = makeRequest(null);

    channel.handleChat(request, reply);

    expect(sentStatus()).toBe(400);
    const body = sentBody() as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_REQUEST');
  });
});

// ---------------------------------------------------------------------------
// Test 5: SendMessage resolves pending request
// ---------------------------------------------------------------------------

describe('SendMessage resolves pending request', () => {
  it('resolves the pending handleChat with the provided content', async () => {
    const { channel, messageCallback } = await makeConnectedChannel();
    const { reply, sentStatus, sentBody } = makeReply();
    const request = makeRequest({ content: 'ping' });

    channel.handleChat(request, reply);

    // Capture the JID that was dispatched
    expect(messageCallback).toHaveBeenCalledOnce();
    const [jid] = messageCallback.mock.calls[0] as [string, string];

    // Deliver agent response
    await channel.sendMessage(jid, 'pong');
    await Promise.resolve();

    expect(sentStatus()).toBe(200);
    const body = sentBody() as { data: { response: string } };
    expect(body.data.response).toBe('pong');
  });

  it('removes the JID from pending after resolution', async () => {
    const { channel, messageCallback } = await makeConnectedChannel();
    const { reply } = makeReply();
    const request = makeRequest({ content: 'hello' });

    channel.handleChat(request, reply);

    const [jid] = messageCallback.mock.calls[0] as [string, string];

    // Resolve once
    await channel.sendMessage(jid, 'response');
    await Promise.resolve();

    // Second sendMessage call for same JID should be a no-op (pending cleared)
    // This should not throw
    await expect(channel.sendMessage(jid, 'late response')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 6: SendMessage ignores unknown JID
// ---------------------------------------------------------------------------

describe('SendMessage ignores unknown JID', () => {
  it('does not throw when called with a JID that has no pending request', async () => {
    const channel = new APIChannel(null);
    await channel.connect();

    // No pending entry for this JID — should resolve silently
    await expect(
      channel.sendMessage('api:99999', 'some response'),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 7: Disconnect rejects all pending requests
// ---------------------------------------------------------------------------

describe('Disconnect rejects all pending requests', () => {
  it('rejects all in-flight handleChat calls with a 503 CHANNEL_DISCONNECTED', async () => {
    const { channel } = await makeConnectedChannel({ timeoutMs: 10_000 });

    // Start two concurrent requests — neither will receive an agent response
    const { reply: reply1, sentStatus: status1, sentBody: body1 } = makeReply();
    const { reply: reply2, sentStatus: status2, sentBody: body2 } = makeReply();

    channel.handleChat(makeRequest({ content: 'request 1' }), reply1);
    channel.handleChat(makeRequest({ content: 'request 2' }), reply2);

    // Disconnect before any agent response
    await channel.disconnect();

    // Give microtasks a tick to settle the rejection
    await Promise.resolve();
    await Promise.resolve();

    expect(status1()).toBe(503);
    const err1 = body1() as { error: { code: string } };
    expect(err1.error.code).toBe('CHANNEL_DISCONNECTED');

    expect(status2()).toBe(503);
    const err2 = body2() as { error: { code: string } };
    expect(err2.error.code).toBe('CHANNEL_DISCONNECTED');
  });

  it('sets connected=false so subsequent handleChat calls return 503 immediately', async () => {
    const { channel } = await makeConnectedChannel();
    await channel.disconnect();

    const { reply, sentStatus, sentBody } = makeReply();
    channel.handleChat(makeRequest({ content: 'hello' }), reply);

    expect(sentStatus()).toBe(503);
    const body = sentBody() as { error: { code: string } };
    expect(body.error.code).toBe('CHANNEL_UNAVAILABLE');
  });
});
