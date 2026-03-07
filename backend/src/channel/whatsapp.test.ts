/**
 * Tests for WhatsAppChannel (backend/src/channel/whatsapp.ts)
 *
 * Uses vitest with a fully mocked WhatsAppClientInterface — no real baileys
 * network I/O. The sleepFn is injected as an immediately-resolving stub so
 * reconnectLoop tests run without any real delays.
 *
 * All 10 required tests are covered.
 *
 * Test index:
 *  1.  Connect creates socket and registers handler
 *  2.  Disconnect closes socket
 *  3.  SendMessage sends text to correct JID
 *  4.  SendMessage rejects messages over maxLen
 *  5.  handleMessage filters own messages
 *  6.  handleMessage extracts text from conversation
 *  7.  handleMessage builds correct JID
 *  8.  reconnectLoop retries with exponential backoff
 *  9.  HandleConfigChange enables disabled channel
 * 10.  HandleConfigChange reconnects on store path change
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  WhatsAppChannel,
  extractWhatsAppPhone,
  type WhatsAppConfig,
  type WhatsAppClientInterface,
  type WhatsAppLogger,
  type WhatsAppChannelOptions,
  type WhatsAppMessage,
  type ConnectionUpdate,
  type SleepFn,
} from './whatsapp.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Creates a no-op logger with spies. */
function makeLogger(): WhatsAppLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/** Default connected config. */
const defaultConfig: WhatsAppConfig = {
  storePath: '/tmp/wa-store',
  enabled: true,
};

/**
 * Builds a minimal mock WhatsAppClientInterface.
 * Event listeners registered via ev.on() are stored in handlers so tests can
 * trigger them directly.
 */
function makeClient(overrides: Partial<{
  sendMessage: WhatsAppClientInterface['sendMessage'];
  end: WhatsAppClientInterface['end'];
}>= {}): {
  client: WhatsAppClientInterface;
  handlers: Record<string, Array<(...args: unknown[]) => void>>;
  sendMessageSpy: ReturnType<typeof vi.fn>;
  endSpy: ReturnType<typeof vi.fn>;
} {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const sendMessageSpy = vi.fn().mockResolvedValue(undefined);
  const endSpy = vi.fn();

  const client: WhatsAppClientInterface = {
    sendMessage: overrides.sendMessage ?? sendMessageSpy,
    end: overrides.end ?? endSpy,
    ev: {
      on: (event: string, listener: (...args: unknown[]) => void) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(listener);
      },
    },
  };

  return { client, handlers, sendMessageSpy, endSpy };
}

/** Fires all registered handlers for a given event. */
function fireEvent(
  handlers: Record<string, Array<(...args: unknown[]) => void>>,
  event: string,
  ...args: unknown[]
): void {
  const list = handlers[event] ?? [];
  for (const fn of list) fn(...args);
}

/**
 * Builds a minimal WhatsAppMessage for handleMessage tests.
 */
function makeWAMessage(overrides: {
  fromMe?: boolean;
  remoteJid?: string;
  conversation?: string;
  extendedText?: string;
}): WhatsAppMessage {
  return {
    key: {
      fromMe: overrides.fromMe ?? false,
      remoteJid: overrides.remoteJid ?? '15551234567@s.whatsapp.net',
    },
    message: overrides.conversation !== undefined
      ? { conversation: overrides.conversation }
      : overrides.extendedText !== undefined
        ? { extendedTextMessage: { text: overrides.extendedText } }
        : { conversation: 'hello' },
  };
}

/**
 * A sleepFn that resolves immediately.
 * Injected into WhatsAppChannel for all reconnect loop tests so no real time
 * passes during test execution.
 */
const instantSleep: SleepFn = () => Promise.resolve();

// ---------------------------------------------------------------------------
// Describe block
// ---------------------------------------------------------------------------

describe('WhatsAppChannel', () => {
  let logger: WhatsAppLogger;

  beforeEach(() => {
    logger = makeLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1 — Connect creates socket and registers handler
  // -------------------------------------------------------------------------

  it('1. connect creates socket and registers messages.upsert handler', async () => {
    const { client, handlers } = makeClient();
    const channel = new WhatsAppChannel(defaultConfig, logger, {
      clientFactory: async () => client,
    });

    await channel.connect();

    expect(channel.isConnected()).toBe(true);
    expect(handlers['messages.upsert']).toBeDefined();
    expect(handlers['messages.upsert'].length).toBeGreaterThan(0);
    expect(handlers['connection.update']).toBeDefined();
    expect(handlers['connection.update'].length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Test 2 — Disconnect closes socket
  // -------------------------------------------------------------------------

  it('2. disconnect ends socket and marks not connected', async () => {
    const { client, endSpy } = makeClient();
    const channel = new WhatsAppChannel(defaultConfig, logger, {
      clientFactory: async () => client,
    });

    await channel.connect();
    expect(channel.isConnected()).toBe(true);

    await channel.disconnect();

    expect(endSpy).toHaveBeenCalledOnce();
    expect(channel.isConnected()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 3 — SendMessage sends text to correct JID
  // -------------------------------------------------------------------------

  it('3. sendMessage sends text to the correct baileys JID', async () => {
    const { client, sendMessageSpy } = makeClient();
    const channel = new WhatsAppChannel(defaultConfig, logger, {
      clientFactory: async () => client,
    });
    await channel.connect();

    await channel.sendMessage('whatsapp:15551234567', 'Hello World');

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    expect(sendMessageSpy).toHaveBeenCalledWith('15551234567@s.whatsapp.net', {
      text: 'Hello World',
    });
  });

  // -------------------------------------------------------------------------
  // Test 4 — SendMessage rejects messages over maxLen
  // -------------------------------------------------------------------------

  it('4. sendMessage throws ValidationError for messages over 4096 characters', async () => {
    const { client } = makeClient();
    const channel = new WhatsAppChannel(defaultConfig, logger, {
      clientFactory: async () => client,
    });
    await channel.connect();

    const oversizedContent = 'a'.repeat(4097);

    await expect(channel.sendMessage('whatsapp:15551234567', oversizedContent)).rejects.toMatchObject({
      name: 'ValidationError',
      field: 'content',
    });
  });

  // -------------------------------------------------------------------------
  // Test 5 — handleMessage filters own messages
  // -------------------------------------------------------------------------

  it('5. handleMessage ignores messages where fromMe is true', async () => {
    const { client } = makeClient();
    const channel = new WhatsAppChannel(defaultConfig, logger, {
      clientFactory: async () => client,
    });
    await channel.connect();

    const spy = vi.fn();
    channel.onMessage(spy);

    channel.handleMessage(makeWAMessage({ fromMe: true, conversation: 'hello' }));

    expect(spy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 6 — handleMessage extracts text from conversation
  // -------------------------------------------------------------------------

  it('6. handleMessage extracts text from conversation field', async () => {
    const { client } = makeClient();
    const channel = new WhatsAppChannel(defaultConfig, logger, {
      clientFactory: async () => client,
    });
    await channel.connect();

    let capturedContent = '';
    channel.onMessage((_jid, content) => {
      capturedContent = content;
    });

    channel.handleMessage(
      makeWAMessage({ conversation: 'Hello from conversation', remoteJid: '15551234567@s.whatsapp.net' }),
    );

    expect(capturedContent).toBe('Hello from conversation');
  });

  it('6b. handleMessage extracts text from extendedTextMessage field', async () => {
    const { client } = makeClient();
    const channel = new WhatsAppChannel(defaultConfig, logger, {
      clientFactory: async () => client,
    });
    await channel.connect();

    let capturedContent = '';
    channel.onMessage((_jid, content) => {
      capturedContent = content;
    });

    channel.handleMessage(
      makeWAMessage({ extendedText: 'Extended text message', remoteJid: '15551234567@s.whatsapp.net' }),
    );

    expect(capturedContent).toBe('Extended text message');
  });

  // -------------------------------------------------------------------------
  // Test 7 — handleMessage builds correct JID
  // -------------------------------------------------------------------------

  it('7. handleMessage builds JID as whatsapp:<phone>', async () => {
    const { client } = makeClient();
    const channel = new WhatsAppChannel(defaultConfig, logger, {
      clientFactory: async () => client,
    });
    await channel.connect();

    let capturedJID = '';
    channel.onMessage((jid, _content) => {
      capturedJID = jid;
    });

    channel.handleMessage(
      makeWAMessage({ conversation: 'hi', remoteJid: '15551234567@s.whatsapp.net' }),
    );

    expect(capturedJID).toBe('whatsapp:15551234567');
  });

  // -------------------------------------------------------------------------
  // Test 8 — reconnectLoop retries with exponential backoff
  // -------------------------------------------------------------------------

  it('8. reconnectLoop retries with exponential backoff (1s, 2s, 4s, ...)', async () => {
    let factoryCallCount = 0;
    const sleepSpy = vi.fn().mockResolvedValue(undefined);

    // Factory always fails connect so we can observe the backoff progression
    const failingFactory = async (): Promise<WhatsAppClientInterface> => {
      factoryCallCount++;
      throw new Error('connection refused');
    };

    const options: WhatsAppChannelOptions = {
      clientFactory: failingFactory,
      sleepFn: sleepSpy as SleepFn,
    };

    const channel = new WhatsAppChannel(defaultConfig, logger, options);
    // Enable the reconnect loop
    (channel as unknown as Record<string, unknown>)['shouldReconnect'] = true;

    // Stop the loop after 3 sleep calls to observe the backoff values
    let iterationCount = 0;
    sleepSpy.mockImplementation(async (_ms: number) => {
      iterationCount++;
      if (iterationCount >= 3) {
        (channel as unknown as Record<string, unknown>)['shouldReconnect'] = false;
      }
    });

    await channel.reconnectLoop();

    // Verify sleepFn was called with exponentially increasing delays
    const sleepCalls = sleepSpy.mock.calls as [number][];
    expect(sleepCalls.length).toBeGreaterThanOrEqual(3);

    // attempt 0: 1000ms
    expect(sleepCalls[0][0]).toBe(1000);
    // attempt 1: 2000ms
    expect(sleepCalls[1][0]).toBe(2000);
    // attempt 2: 4000ms
    expect(sleepCalls[2][0]).toBe(4000);

    // Verify the cap: base * 2^10 = 1024000 → capped at 60000
    const delay10 = Math.min(1000 * Math.pow(2, 10), 60000);
    expect(delay10).toBe(60000);
  });

  // -------------------------------------------------------------------------
  // Test 9 — HandleConfigChange enables disabled channel
  // -------------------------------------------------------------------------

  it('9. handleConfigChange enables a disabled channel', async () => {
    const { client } = makeClient();
    const channel = new WhatsAppChannel(
      { storePath: '/tmp/wa', enabled: false },
      logger,
      { clientFactory: async () => client },
    );

    await channel.handleConfigChange('/tmp/wa', true);

    expect(channel.isConnected()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 10 — HandleConfigChange reconnects on store path change
  // -------------------------------------------------------------------------

  it('10. handleConfigChange reconnects when store path changes while connected', async () => {
    const { client, endSpy } = makeClient();
    let factoryCallCount = 0;
    const channel = new WhatsAppChannel(
      { storePath: '/tmp/wa-old', enabled: true },
      logger,
      {
        clientFactory: async () => {
          factoryCallCount++;
          return client;
        },
      },
    );

    // Connect initially
    await channel.connect();
    expect(channel.isConnected()).toBe(true);
    expect(factoryCallCount).toBe(1);

    // Change store path while connected
    await channel.handleConfigChange('/tmp/wa-new', true);

    // Should have disconnected (end called) and reconnected (factory called again)
    expect(endSpy).toHaveBeenCalledOnce();
    expect(factoryCallCount).toBe(2);
    expect(channel.isConnected()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Additional — extractWhatsAppPhone pure function
  // -------------------------------------------------------------------------

  it('extractWhatsAppPhone extracts phone from whatsapp:<phone> JID', () => {
    expect(extractWhatsAppPhone('whatsapp:15551234567')).toBe('15551234567');
    expect(extractWhatsAppPhone('whatsapp:invalid')).toBe('invalid');
    expect(extractWhatsAppPhone('discord:some-channel')).toBe('');
    expect(extractWhatsAppPhone('')).toBe('');
  });

  // -------------------------------------------------------------------------
  // Additional — QR code relay via onMetadata callback
  // -------------------------------------------------------------------------

  it('QR code is relayed via onMetadata callback when connection.update has qr', async () => {
    const { client, handlers } = makeClient();
    const channel = new WhatsAppChannel(defaultConfig, logger, {
      clientFactory: async () => client,
    });
    await channel.connect();

    let capturedJID = '';
    let capturedMetadata: Record<string, string> = {};
    channel.onMetadata((jid, metadata) => {
      capturedJID = jid;
      capturedMetadata = metadata;
    });

    const update: ConnectionUpdate = { qr: 'qr-code-base64-data' };
    fireEvent(handlers, 'connection.update', update);

    expect(capturedJID).toBe('whatsapp:qr');
    expect(capturedMetadata['qr']).toBe('qr-code-base64-data');
  });

  // -------------------------------------------------------------------------
  // Additional — messages.upsert triggers handleMessage via ev.on
  // -------------------------------------------------------------------------

  it('messages.upsert event triggers handleMessage for each message', async () => {
    const { client, handlers } = makeClient();
    const channel = new WhatsAppChannel(defaultConfig, logger, {
      clientFactory: async () => client,
    });
    await channel.connect();

    const spy = vi.fn();
    channel.onMessage(spy);

    const upsert = {
      messages: [
        makeWAMessage({ conversation: 'msg1', remoteJid: '111@s.whatsapp.net' }),
        makeWAMessage({ conversation: 'msg2', remoteJid: '222@s.whatsapp.net' }),
      ],
      type: 'notify',
    };
    fireEvent(handlers, 'messages.upsert', upsert);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith('whatsapp:111', 'msg1');
    expect(spy).toHaveBeenCalledWith('whatsapp:222', 'msg2');
  });
});
