/**
 * WebSocket client for connecting to the Go backend.
 * Handles connection, reconnection with exponential backoff, and message routing.
 */

import WebSocket from 'ws';
import type { WSMessage } from './types.js';
import { parseMessage, toWireFormat } from './types.js';

export interface WSClientOptions {
  url: string;
  onMessage: (msg: WSMessage) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  maxReconnectAttempts?: number;
  initialBackoffMs?: number;
}

export class WSClient {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly onMessage: (msg: WSMessage) => void;
  private readonly onConnect?: () => void;
  private readonly onDisconnect?: () => void;
  private readonly maxReconnectAttempts: number;
  private readonly initialBackoffMs: number;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(options: WSClientOptions) {
    this.url = options.url;
    this.onMessage = options.onMessage;
    this.onConnect = options.onConnect;
    this.onDisconnect = options.onDisconnect;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
    this.initialBackoffMs = options.initialBackoffMs ?? 1000;
  }

  connect(): void {
    if (this.closed) return;

    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.onConnect?.();
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = parseMessage(data.toString());
        this.onMessage(msg);
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    });

    this.ws.on('close', () => {
      this.onDisconnect?.();
      this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      console.error('WebSocket error:', err.message);
    });
  }

  send(msg: WSMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    this.ws.send(JSON.stringify(toWireFormat(msg)));
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached');
      return;
    }

    const backoff = this.initialBackoffMs * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, backoff);
  }
}
