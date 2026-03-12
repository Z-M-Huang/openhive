/**
 * WebSocket hook for real-time updates from the portal relay.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import type { WSEvent } from '@/types/api';

interface UsePortalWSOptions {
  onEvent?: (event: WSEvent) => void;
  autoReconnect?: boolean;
  reconnectDelay?: number;
}

interface UsePortalWSReturn {
  isConnected: boolean;
  lastEvent: WSEvent | null;
  send: (data: unknown) => void;
  reconnect: () => void;
}

export function usePortalWS(options: UsePortalWSOptions = {}): UsePortalWSReturn {
  const { onEvent, autoReconnect = true, reconnectDelay = 1000 } = options;
  const wsRef = useRef<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<WSEvent | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/portal`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setIsConnected(true);
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setIsConnected(false);
      wsRef.current = null;

      // Auto-reconnect
      if (autoReconnect) {
        reconnectTimeoutRef.current = setTimeout(connect, reconnectDelay);
      }
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      ws.close();
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      try {
        const parsed: WSEvent = JSON.parse(event.data);
        setLastEvent(parsed);
        onEvent?.(parsed);
      } catch {
        // Ignore parse errors
      }
    };
  }, [autoReconnect, reconnectDelay, onEvent]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      disconnect();
    };
  }, [connect, disconnect]);

  return {
    isConnected,
    lastEvent,
    send,
    reconnect: connect,
  };
}