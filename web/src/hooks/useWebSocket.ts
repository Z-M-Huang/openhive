import { useEffect, useRef, useCallback, useState } from 'react';
import { queryClient } from '../lib/queryClient';

export type WSConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface WSMessage {
  type: string;
  payload: unknown;
}

interface UseWebSocketOptions {
  /** Query params to append to the WS URL (e.g. team filter) */
  params?: Record<string, string>;
  /** Called when a message is received */
  onMessage?: (msg: WSMessage) => void;
  /** Called when connection state changes */
  onStateChange?: (state: WSConnectionState) => void;
}

const WS_URL = '/api/v1/ws';
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

/**
 * WebSocket hook for the portal event stream.
 * Connects to /api/v1/ws, auto-reconnects with exponential backoff,
 * and invalidates TanStack Query caches on reconnect.
 */
export function useWebSocket(options: UseWebSocketOptions = {}): WSConnectionState {
  const { params, onMessage, onStateChange } = options;
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffRef = useRef(INITIAL_BACKOFF_MS);
  const mountedRef = useRef(true);
  const [connectionState, setConnectionState] = useState<WSConnectionState>('connecting');

  const updateState = useCallback((state: WSConnectionState) => {
    setConnectionState(state);
    onStateChange?.(state);
  }, [onStateChange]);

  const buildURL = useCallback((): string => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const query = params
      ? '?' + new URLSearchParams(params).toString()
      : '';
    return `${protocol}//${host}${WS_URL}${query}`;
  }, [params]);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    const url = buildURL();
    const ws = new WebSocket(url);
    wsRef.current = ws;
    updateState('connecting');

    ws.onopen = () => {
      if (!mountedRef.current) {
        ws.close();
        return;
      }
      backoffRef.current = INITIAL_BACKOFF_MS;
      updateState('connected');
      // Invalidate all queries on reconnect to refresh stale data
      void queryClient.invalidateQueries();
    };

    ws.onmessage = (event: MessageEvent) => {
      if (!mountedRef.current) return;
      try {
        const msg = JSON.parse(event.data as string) as WSMessage;
        onMessage?.(msg);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onerror = () => {
      updateState('error');
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      updateState('disconnected');
      // Exponential backoff reconnect
      const delay = backoffRef.current;
      backoffRef.current = Math.min(delay * 2, MAX_BACKOFF_MS);
      reconnectTimerRef.current = setTimeout(connect, delay);
    };
  }, [buildURL, onMessage, updateState]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  return connectionState;
}
