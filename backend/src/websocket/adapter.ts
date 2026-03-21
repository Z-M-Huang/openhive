/**
 * WebSocket connection adapter wrapping raw ws.WebSocket to implement WSConnection.
 *
 * @module websocket/adapter
 */

import type { WebSocket } from 'ws';
import type { WSConnection, WSMessage } from '../domain/interfaces.js';
import { parseMessage } from './protocol.js';

/**
 * Adapter that wraps a raw ws.WebSocket to implement the WSConnection interface.
 *
 * This allows WSHubImpl to work with WebSocket connections from the server
 * while providing the rate limiting and write queue features.
 */
export class WebSocketConnectionAdapter implements WSConnection {
  readonly tid: string;
  private readonly _ws: WebSocket;
  private _lastPong: number = Date.now();

  constructor(tid: string, ws: WebSocket) {
    this.tid = tid;
    this._ws = ws;

    // Track pong responses for isAlive()
    ws.on('pong', () => {
      this._lastPong = Date.now();
    });
  }

  send(message: WSMessage): void {
    if (this._ws.readyState === 1) {
      this._ws.send(JSON.stringify({ type: message.type, data: message.data }));
    }
  }

  close(code?: number, reason?: string): void {
    if (this._ws.readyState === 1) {
      this._ws.close(code ?? 1000, reason ?? '');
    }
  }

  onMessage(handler: (message: WSMessage) => void): void {
    this._ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const raw = data.toString();
        const parsed = parseMessage(raw);
        const msg: WSMessage = { type: parsed.type, data: parsed.data as unknown as Record<string, unknown> };
        handler(msg);
      } catch {
        // Malformed message — close with policy violation
        this._ws.close(1008, 'Invalid message');
      }
    });
  }

  onClose(handler: (code: number, reason: string) => void): void {
    this._ws.on('close', (code: number, reason: Buffer) => {
      handler(code, reason.toString());
    });
  }

  isAlive(): boolean {
    // Consider alive if we've received a pong within last 60 seconds
    // and the socket is in OPEN state
    return this._ws.readyState === 1 && (Date.now() - this._lastPong) < 60000;
  }

  /** Sends a WebSocket ping frame to the remote peer. */
  ping(): void {
    if (this._ws.readyState === 1) {
      this._ws.ping();
    }
  }

  /** Returns the timestamp (ms since epoch) when the last pong was received. */
  get lastPong(): number {
    return this._lastPong;
  }
}
