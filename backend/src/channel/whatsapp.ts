/**
 * OpenHive Backend - WhatsApp Channel Adapter
 *
 * Implements ChannelAdapter for WhatsApp using @whiskeysockets/baileys v6.
 * QR code authentication via connection.update events, message handling with
 * isFromMe filtering, text extraction from conversation/extendedTextMessage,
 * exponential backoff reconnection, and config hot-reload.
 *
 * Implements exponential backoff reconnection and config hot-reload.
 */

import type { ChannelAdapter } from '../domain/interfaces.js';
import { ValidationError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WHATSAPP_PREFIX = 'whatsapp';
const WHATSAPP_MAX_LEN = 4096;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60000;
const BACKOFF_MULTIPLIER = 2;

// ---------------------------------------------------------------------------
// WhatsAppConfig
// ---------------------------------------------------------------------------

/**
 * Configuration for the WhatsApp channel adapter.
 */
export interface WhatsAppConfig {
  storePath: string;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// WhatsAppMessage — minimal shape of a baileys WAMessage needed here
// ---------------------------------------------------------------------------

/**
 * Minimal inbound message structure from baileys 'messages.upsert'.
 * We only need key.fromMe, key.remoteJid, and message content fields.
 */
export interface WhatsAppMessage {
  key: {
    fromMe?: boolean | null;
    remoteJid?: string | null;
  };
  message?: {
    conversation?: string | null;
    extendedTextMessage?: {
      text?: string | null;
    } | null;
  } | null;
}

// ---------------------------------------------------------------------------
// ConnectionUpdate — minimal shape of a baileys connection.update payload
// ---------------------------------------------------------------------------

/**
 * Minimal connection update payload from baileys 'connection.update'.
 * Carries QR code string and connection state.
 */
export interface ConnectionUpdate {
  connection?: 'open' | 'connecting' | 'close';
  lastDisconnect?: {
    error?: Error;
  };
  qr?: string;
}

// ---------------------------------------------------------------------------
// WhatsAppClientInterface — abstraction for testability
// ---------------------------------------------------------------------------

/**
 * Abstraction over the baileys WASocket methods needed by WhatsAppChannel.
 * Allows injection of a mock in tests without real network I/O.
 *
 * The `ev.on` method covers event registration for 'connection.update' and
 * 'messages.upsert'. The `sendMessage` method sends text messages. `end`
 * closes the socket.
 */
export interface WhatsAppClientInterface {
  sendMessage(jid: string, content: { text: string }): Promise<void>;
  end(): void;
  ev: {
    on(
      event: 'connection.update',
      listener: (update: ConnectionUpdate) => void,
    ): void;
    on(
      event: 'messages.upsert',
      listener: (upsert: { messages: WhatsAppMessage[]; type: string }) => void,
    ): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
  };
}

// ---------------------------------------------------------------------------
// WhatsAppClientFactory
// ---------------------------------------------------------------------------

/**
 * Factory function type for creating WhatsAppClientInterface instances.
 * Injectable for test isolation.
 */
export type WhatsAppClientFactory = (storePath: string) => Promise<WhatsAppClientInterface>;

// ---------------------------------------------------------------------------
// SleepFn
// ---------------------------------------------------------------------------

/**
 * Async sleep function. Injectable for test isolation (tests pass an
 * immediately-resolving stub so no real delays occur in unit tests).
 */
export type SleepFn = (ms: number) => Promise<void>;

const defaultSleepFn: SleepFn = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// WhatsAppLogger
// ---------------------------------------------------------------------------

/**
 * Minimal logger subset used by WhatsAppChannel.
 */
export interface WhatsAppLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// WhatsAppChannelOptions
// ---------------------------------------------------------------------------

/**
 * Optional overrides for WhatsAppChannel — primarily for test injection.
 */
export interface WhatsAppChannelOptions {
  /** Overrides the baileys socket factory. */
  clientFactory?: WhatsAppClientFactory;
  /**
   * Overrides the sleep function used in reconnectLoop().
   * Pass an immediately-resolving stub in tests to skip real delays.
   */
  sleepFn?: SleepFn;
}

// ---------------------------------------------------------------------------
// WhatsAppChannel
// ---------------------------------------------------------------------------

/**
 * WhatsApp channel adapter implementing ChannelAdapter.
 *
 * Key behaviour:
 *  - connect() creates a baileys socket, registers 'messages.upsert' and
 *    'connection.update' handlers, handles QR codes via onMetadata callback.
 *  - disconnect() sets shouldReconnect=false, closes the socket.
 *  - sendMessage() extracts phone from JID, sends text via baileys sendMessage.
 *  - handleMessage() filters isFromMe, extracts text, builds whatsapp:<phone> JID.
 *  - reconnectLoop() is triggered by 'close' events and retries with exponential
 *    backoff (backoffBase * backoffMultiplier^attempt, cap 60 s).
 *  - handleConfigChange() compares state and connect/disconnect/reconnects.
 */
export class WhatsAppChannel implements ChannelAdapter {
  // Config state
  private storePath: string;
  private enabled: boolean;

  // Dependencies
  private readonly clientFactory: WhatsAppClientFactory;
  private readonly sleepFn: SleepFn;
  private readonly logger: WhatsAppLogger;

  // Runtime state
  private client: WhatsAppClientInterface | null = null;
  private connected: boolean = false;

  // Callbacks registered by the MessageRouter
  private messageCallback: ((jid: string, content: string) => void) | null = null;
  private metadataCallback: ((jid: string, metadata: Record<string, string>) => void) | null = null;

  // Reconnection state
  private shouldReconnect: boolean = false;
  private reconnectAttempt: number = 0;

  constructor(cfg: WhatsAppConfig, logger: WhatsAppLogger, options?: WhatsAppChannelOptions) {
    this.storePath = cfg.storePath;
    this.enabled = cfg.enabled;
    this.logger = logger;
    this.clientFactory = options?.clientFactory ?? defaultClientFactory;
    this.sleepFn = options?.sleepFn ?? defaultSleepFn;
  }

  // ---------------------------------------------------------------------------
  // ChannelAdapter — connect
  // ---------------------------------------------------------------------------

  /**
   * Creates a baileys socket, registers event handlers, sets shouldReconnect=true.
   * QR codes are emitted via the onMetadata callback.
   * On 'close' connection.update, triggers reconnectLoop.
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    const client = await this.clientFactory(this.storePath);
    this.client = client;
    this.shouldReconnect = true;

    // Register 'messages.upsert' handler for inbound messages
    client.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        this.handleMessage(msg);
      }
    });

    // Register 'connection.update' handler for QR codes and disconnects
    client.ev.on('connection.update', (update: ConnectionUpdate) => {
      if (update.qr !== undefined) {
        // Emit QR code via metadata callback
        if (this.metadataCallback !== null) {
          this.metadataCallback('whatsapp:qr', { qr: update.qr });
        }
        this.logger.info('whatsapp: QR code received, awaiting scan');
      }

      if (update.connection === 'open') {
        this.connected = true;
        this.reconnectAttempt = 0;
        this.logger.info('whatsapp channel connected');
      }

      if (update.connection === 'close') {
        this.connected = false;
        this.logger.warn('whatsapp disconnected, starting reconnection loop');
        if (this.shouldReconnect) {
          void this.reconnectLoop();
        }
      }
    });

    this.connected = true;
    this.logger.info('whatsapp channel connecting', { store_path: this.storePath });
  }

  // ---------------------------------------------------------------------------
  // ChannelAdapter — disconnect
  // ---------------------------------------------------------------------------

  /**
   * Stops the reconnect loop and ends the socket connection.
   */
  async disconnect(): Promise<void> {
    this.shouldReconnect = false;

    if (!this.connected || this.client === null) {
      return;
    }

    try {
      this.client.end();
    } catch (err) {
      this.logger.warn('whatsapp disconnect: end error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.client = null;
    this.connected = false;
    this.logger.info('whatsapp channel disconnected');
  }

  // ---------------------------------------------------------------------------
  // ChannelAdapter — sendMessage
  // ---------------------------------------------------------------------------

  /**
   * Extracts phone from JID (whatsapp:<phone>), builds baileys JID, sends text.
   * Throws if content exceeds WHATSAPP_MAX_LEN or channel is not connected.
   */
  async sendMessage(jid: string, content: string): Promise<void> {
    if (content.length > WHATSAPP_MAX_LEN) {
      throw new ValidationError(
        'content',
        `message exceeds maximum length of ${WHATSAPP_MAX_LEN} characters`,
      );
    }

    if (!this.connected || this.client === null) {
      throw new ValidationError('connection', 'whatsapp channel is not connected');
    }

    const phone = extractWhatsAppPhone(jid);
    if (phone === '') {
      throw new ValidationError('jid', `invalid whatsapp JID: ${jid}`);
    }

    // baileys JID format: <phone>@s.whatsapp.net
    const recipientJID = `${phone}@s.whatsapp.net`;

    try {
      await this.client.sendMessage(recipientJID, { text: content });
    } catch (err) {
      throw new Error(
        `whatsapp send message: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // ChannelAdapter — getJIDPrefix / isConnected / onMessage / onMetadata
  // ---------------------------------------------------------------------------

  getJIDPrefix(): string {
    return WHATSAPP_PREFIX;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onMessage(callback: (jid: string, content: string) => void): void {
    this.messageCallback = callback;
  }

  onMetadata(callback: (jid: string, metadata: Record<string, string>) => void): void {
    this.metadataCallback = callback;
  }

  // ---------------------------------------------------------------------------
  // handleConfigChange
  // ---------------------------------------------------------------------------

  /**
   * Compares new config to current state and connect / disconnect / reconnect
   * as needed.
   */
  async handleConfigChange(newStorePath: string, newEnabled: boolean): Promise<void> {
    const oldEnabled = this.enabled;
    const oldStorePath = this.storePath;
    const wasConnected = this.connected;

    if (oldEnabled && !newEnabled) {
      // Was enabled, now disabled: disconnect.
      this.logger.info('whatsapp: config changed — disabling channel');
      this.enabled = false;
      await this.disconnect().catch((err: unknown) => {
        this.logger.warn('whatsapp: disconnect on disable failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } else if (!oldEnabled && newEnabled) {
      // Was disabled, now enabled: update store path and connect.
      this.logger.info('whatsapp: config changed — enabling channel');
      this.storePath = newStorePath;
      this.enabled = true;
      this.reconnectAttempt = 0;
      await this.connect().catch((err: unknown) => {
        this.logger.warn('whatsapp: connect on enable failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } else if (newEnabled && wasConnected && newStorePath !== oldStorePath) {
      // Store path changed while connected: reconnect with new store path.
      this.logger.info('whatsapp: config changed — reconnecting with new store path');
      await this.disconnect().catch((err: unknown) => {
        this.logger.warn('whatsapp: disconnect before store path update failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      this.storePath = newStorePath;
      this.enabled = true;
      this.reconnectAttempt = 0;
      await this.connect().catch((err: unknown) => {
        this.logger.warn('whatsapp: reconnect after store path update failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } else {
      // No actionable change — just update stored state.
      this.storePath = newStorePath;
      this.enabled = newEnabled;
    }
  }

  // ---------------------------------------------------------------------------
  // handleMessage (exported as public for direct testing)
  // ---------------------------------------------------------------------------

  /**
   * Filters isFromMe messages, extracts text from conversation or
   * extendedTextMessage, builds JID as "whatsapp:<phone>", calls messageCallback.
   *
   * Marked public so tests can call it directly.
   */
  handleMessage(msg: WhatsAppMessage): void {
    // Filter: own messages
    if (msg.key.fromMe === true) {
      return;
    }

    // Extract text — prefer conversation, fall back to extendedTextMessage
    let text = '';
    if (msg.message?.conversation) {
      text = msg.message.conversation;
    } else if (msg.message?.extendedTextMessage?.text) {
      text = msg.message.extendedTextMessage.text;
    }

    text = text.trim();
    if (text === '') {
      return;
    }

    // Extract phone from remoteJid (format: <phone>@s.whatsapp.net or <phone>@g.us)
    const remoteJid = msg.key.remoteJid ?? '';
    const atIndex = remoteJid.indexOf('@');
    const phone = atIndex > 0 ? remoteJid.slice(0, atIndex) : remoteJid;

    if (phone === '') {
      return;
    }

    const jid = `${WHATSAPP_PREFIX}:${phone}`;

    if (this.messageCallback !== null) {
      this.messageCallback(jid, text);
    }
  }

  // ---------------------------------------------------------------------------
  // reconnectLoop (exported as public for direct testing)
  // ---------------------------------------------------------------------------

  /**
   * Exponential backoff reconnection loop. Called when 'close' connection.update
   * events fire. Retries connect() while shouldReconnect is true. Resets
   * reconnectAttempt on success.
   *
   * Delay = backoffBase * (backoffMultiplier ^ attempt), capped at backoffMax.
   *
   * Marked public so tests can call it directly and spy on it.
   */
  async reconnectLoop(): Promise<void> {
    // Mark disconnected so state is accurate during retry waits
    this.connected = false;
    this.client = null;

    while (this.shouldReconnect) {
      const delay = Math.min(
        BACKOFF_BASE_MS * Math.pow(BACKOFF_MULTIPLIER, this.reconnectAttempt),
        BACKOFF_MAX_MS,
      );

      this.logger.info('whatsapp: reconnecting', {
        attempt: this.reconnectAttempt,
        delay_ms: delay,
      });

      await this.sleepFn(delay);

      if (!this.shouldReconnect) {
        break;
      }

      try {
        await this.connect();
        // Success — reset backoff
        this.reconnectAttempt = 0;
        this.logger.info('whatsapp: reconnected successfully');
        return;
      } catch (err) {
        this.reconnectAttempt++;
        this.logger.warn('whatsapp: reconnect attempt failed', {
          attempt: this.reconnectAttempt,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// extractWhatsAppPhone — exported pure function
// ---------------------------------------------------------------------------

/**
 * Extracts the phone number from a "whatsapp:<phone>" JID.
 * Returns empty string if the JID does not have the expected prefix.
 */
export function extractWhatsAppPhone(jid: string): string {
  const prefix = `${WHATSAPP_PREFIX}:`;
  if (jid.startsWith(prefix)) {
    return jid.slice(prefix.length);
  }
  return '';
}

// ---------------------------------------------------------------------------
// defaultClientFactory — production factory using baileys
// ---------------------------------------------------------------------------

/**
 * Production factory that creates a real baileys socket with multi-file auth state.
 * This is only called in production — tests inject their own factory.
 */
const defaultClientFactory: WhatsAppClientFactory = async (
  storePath: string,
): Promise<WhatsAppClientInterface> => {
  // Dynamic import to avoid loading baileys in test environments that mock it
  const { default: makeWASocket, useMultiFileAuthState } = await import('baileys');

  const { state, saveCreds } = await useMultiFileAuthState(storePath);

  const sock = makeWASocket({ auth: state });

  // Persist credentials on update
  sock.ev.on('creds.update', saveCreds);

  return sock as unknown as WhatsAppClientInterface;
};
