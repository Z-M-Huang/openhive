import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWebSocket } from './useWebSocket';

// Mock WebSocket
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ type: 'close' } as CloseEvent);
  }

  send(_data: string): void {
    // no-op in tests
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({ type: 'open' } as Event);
  }

  simulateMessage(data: string): void {
    this.onmessage?.({ data, type: 'message' } as MessageEvent);
  }

  simulateError(): void {
    this.onerror?.({ type: 'error' } as Event);
  }

  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ type: 'close' } as CloseEvent);
  }
}

// Mock queryClient to avoid needing a provider
vi.mock('../lib/queryClient', () => ({
  queryClient: {
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('useWebSocket', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.useFakeTimers();

    // Stub window.location
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:5173' },
      writable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('starts in connecting state', () => {
    const { result } = renderHook(() => useWebSocket());
    expect(result.current).toBe('connecting');
  });

  it('connects to /api/v1/ws', () => {
    renderHook(() => useWebSocket());
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toContain('/api/v1/ws');
  });

  it('uses ws: protocol for http: pages', () => {
    renderHook(() => useWebSocket());
    expect(MockWebSocket.instances[0].url).toMatch(/^ws:/);
  });

  it('uses wss: protocol for https: pages', () => {
    Object.defineProperty(window, 'location', {
      value: { protocol: 'https:', host: 'example.com' },
      writable: true,
    });
    renderHook(() => useWebSocket());
    expect(MockWebSocket.instances[0].url).toMatch(/^wss:/);
  });

  it('transitions to connected state on open', () => {
    const { result } = renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.instances[0].simulateOpen();
    });

    expect(result.current).toBe('connected');
  });

  it('calls onStateChange callback on state transitions', () => {
    const onStateChange = vi.fn();
    renderHook(() => useWebSocket({ onStateChange }));

    act(() => {
      MockWebSocket.instances[0].simulateOpen();
    });

    expect(onStateChange).toHaveBeenCalledWith('connected');
  });

  it('calls onMessage callback when a message arrives', () => {
    const onMessage = vi.fn();
    renderHook(() => useWebSocket({ onMessage }));

    act(() => {
      MockWebSocket.instances[0].simulateOpen();
      MockWebSocket.instances[0].simulateMessage(JSON.stringify({ type: 'task_updated', payload: { id: '1' } }));
    });

    expect(onMessage).toHaveBeenCalledWith({ type: 'task_updated', payload: { id: '1' } });
  });

  it('ignores malformed JSON messages', () => {
    const onMessage = vi.fn();
    renderHook(() => useWebSocket({ onMessage }));

    act(() => {
      MockWebSocket.instances[0].simulateOpen();
      MockWebSocket.instances[0].simulateMessage('not-json{{{');
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('transitions to error state on socket error', () => {
    const { result } = renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.instances[0].simulateError();
    });

    expect(result.current).toBe('error');
  });

  it('transitions to disconnected state on close', () => {
    const { result } = renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.instances[0].simulateOpen();
      MockWebSocket.instances[0].simulateClose();
    });

    expect(result.current).toBe('disconnected');
  });

  it('reconnects after disconnect with backoff delay', () => {
    renderHook(() => useWebSocket());

    act(() => {
      MockWebSocket.instances[0].simulateOpen();
      MockWebSocket.instances[0].simulateClose();
    });

    // Before timeout: only 1 WebSocket created
    expect(MockWebSocket.instances).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1001); // Initial backoff is 1000ms
    });

    // After timeout: new connection attempt
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('appends query params to WebSocket URL', () => {
    renderHook(() => useWebSocket({ params: { team: 'alpha' } }));
    expect(MockWebSocket.instances[0].url).toContain('team=alpha');
  });

  it('closes WebSocket on unmount', () => {
    const { unmount } = renderHook(() => useWebSocket());
    const ws = MockWebSocket.instances[0];

    unmount();

    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });
});
