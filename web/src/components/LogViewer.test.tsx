/**
 * Tests for the LogViewer component (AC-G11).
 *
 * Covers:
 * - SSE auto-connect on mount (EventSource created immediately)
 * - Connected / disconnected visual indicator
 * - Real-time entry rendering after SSE messages
 * - Batch rendering via 100ms flush interval
 * - In-memory buffer capped at 1000 entries (oldest evicted)
 * - Auto-scroll pinned to bottom by default
 * - Pin / unpin toggle
 * - "N new entries" badge when unpinned
 * - Client-side level filter
 * - Client-side component filter
 * - Empty state when no entries
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { LogViewer } from './LogViewer';
import type { LogEntry } from '@/types/api';

// ---------------------------------------------------------------------------
// EventSource mock
// ---------------------------------------------------------------------------

interface MockEventSourceInstance {
  url: string;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  close: ReturnType<typeof vi.fn>;
  /** Helpers used by tests to simulate server events */
  _simulateOpen: () => void;
  _simulateMessage: (data: unknown) => void;
  _simulateError: () => void;
}

let latestESInstance: MockEventSourceInstance | null = null;

class MockEventSource implements MockEventSourceInstance {
  url: string;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    latestESInstance = this;
  }

  _simulateOpen() {
    this.onopen?.(new Event('open'));
  }

  _simulateMessage(data: unknown) {
    const ev = new MessageEvent('message', { data: JSON.stringify(data) });
    this.onmessage?.(ev);
  }

  _simulateError() {
    this.onerror?.(new Event('error'));
  }
}

// ---------------------------------------------------------------------------
// Timer mock
// ---------------------------------------------------------------------------

// We use vi.useFakeTimers() per test so we can advance time explicitly.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: Math.floor(Math.random() * 100000),
    level: 20,
    event_type: 'info',
    component: 'orchestrator',
    action: 'start',
    message: 'Test log message',
    params: '',
    team_slug: '',
    task_id: '',
    agent_aid: '',
    request_id: '',
    correlation_id: '',
    error: '',
    duration_ms: 0,
    created_at: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  latestESInstance = null;
  vi.stubGlobal('EventSource', MockEventSource);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LogViewer', () => {
  // ---- SSE connection ----

  describe('SSE connection', () => {
    it('creates an EventSource pointing to /api/logs/stream on mount', () => {
      render(<LogViewer />);
      expect(latestESInstance).not.toBeNull();
      expect(latestESInstance!.url).toBe('/api/logs/stream');
    });

    it('shows "Offline" indicator before SSE connects', () => {
      render(<LogViewer />);
      expect(screen.getByTestId('sse-status').textContent).toContain('Offline');
    });

    it('shows "Live" indicator after SSE opens', () => {
      render(<LogViewer />);
      act(() => {
        latestESInstance!._simulateOpen();
      });
      expect(screen.getByTestId('sse-status').textContent).toContain('Live');
    });

    it('shows "Offline" indicator after SSE error', () => {
      render(<LogViewer />);
      act(() => {
        latestESInstance!._simulateOpen();
        latestESInstance!._simulateError();
      });
      expect(screen.getByTestId('sse-status').textContent).toContain('Offline');
    });

    it('closes the EventSource on unmount', () => {
      const { unmount } = render(<LogViewer />);
      const es = latestESInstance!;
      unmount();
      expect(es.close).toHaveBeenCalledTimes(1);
    });
  });

  // ---- Batch rendering ----

  describe('batch rendering', () => {
    it('shows empty state before any entries arrive', () => {
      render(<LogViewer />);
      expect(screen.getByText('No log entries found')).not.toBeNull();
    });

    it('renders entries after the 100ms batch flush', () => {
      render(<LogViewer />);
      act(() => {
        latestESInstance!._simulateMessage(makeEntry({ message: 'Hello from SSE' }));
      });

      // Nothing yet — batch not flushed
      expect(screen.queryByText('Hello from SSE')).toBeNull();

      // Advance 100ms to trigger flush
      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(screen.getByText('Hello from SSE')).not.toBeNull();
    });

    it('accumulates multiple SSE messages in a single flush', () => {
      render(<LogViewer />);
      act(() => {
        latestESInstance!._simulateMessage(makeEntry({ message: 'Entry A' }));
        latestESInstance!._simulateMessage(makeEntry({ message: 'Entry B' }));
        latestESInstance!._simulateMessage(makeEntry({ message: 'Entry C' }));
      });

      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(screen.getByText('Entry A')).not.toBeNull();
      expect(screen.getByText('Entry B')).not.toBeNull();
      expect(screen.getByText('Entry C')).not.toBeNull();
    });

    it('skips malformed SSE data silently', () => {
      render(<LogViewer />);
      act(() => {
        // Simulate raw (non-JSON) message
        const ev = new MessageEvent('message', { data: 'not-json' });
        latestESInstance!.onmessage?.(ev);
      });

      act(() => {
        vi.advanceTimersByTime(100);
      });

      // No crash, still empty
      expect(screen.getByText('No log entries found')).not.toBeNull();
    });
  });

  // ---- Buffer cap ----

  describe('buffer cap (1000 entries)', () => {
    it('evicts oldest entries when buffer exceeds 1000', () => {
      render(<LogViewer />);

      // Send 1001 entries; the first one should be evicted
      act(() => {
        // Entry that should be evicted
        latestESInstance!._simulateMessage(
          makeEntry({ id: 999999, message: 'Oldest entry' })
        );
        // Fill up to 1001 total
        for (let i = 0; i < 1000; i++) {
          latestESInstance!._simulateMessage(makeEntry({ id: i, message: `Entry ${i}` }));
        }
      });

      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(screen.queryByText('Oldest entry')).toBeNull();
    });

    it('retains at most 1000 entries after multiple flushes', () => {
      render(<LogViewer />);

      // First flush: 600 entries
      act(() => {
        for (let i = 0; i < 600; i++) {
          latestESInstance!._simulateMessage(makeEntry({ id: i }));
        }
      });
      act(() => { vi.advanceTimersByTime(100); });

      // Second flush: 600 more entries (total 1200, should be capped at 1000)
      act(() => {
        for (let i = 600; i < 1200; i++) {
          latestESInstance!._simulateMessage(makeEntry({ id: i }));
        }
      });
      act(() => { vi.advanceTimersByTime(100); });

      // Header shows the capped count (1000, not 1200)
      expect(screen.getByText('Logs (1000)')).not.toBeNull();
    });
  });

  // ---- Pin to bottom ----

  describe('pin to bottom', () => {
    it('renders the pin toggle button', () => {
      render(<LogViewer />);
      expect(screen.getByTestId('pin-toggle')).not.toBeNull();
    });

    it('shows pin icon (pinned state) by default', () => {
      render(<LogViewer />);
      const btn = screen.getByTestId('pin-toggle');
      expect(btn.title).toBe('Unpin from bottom');
    });

    it('toggles to unpin state after clicking', () => {
      render(<LogViewer />);
      fireEvent.click(screen.getByTestId('pin-toggle'));
      expect(screen.getByTestId('pin-toggle').title).toBe('Pin to bottom');
    });

    it('toggles back to pinned state after clicking again', () => {
      render(<LogViewer />);
      fireEvent.click(screen.getByTestId('pin-toggle'));
      fireEvent.click(screen.getByTestId('pin-toggle'));
      expect(screen.getByTestId('pin-toggle').title).toBe('Unpin from bottom');
    });
  });

  // ---- New entries badge ----

  describe('"N new entries" badge', () => {
    it('does not show badge when pinned (default)', () => {
      render(<LogViewer />);
      act(() => {
        latestESInstance!._simulateMessage(makeEntry({ message: 'New entry' }));
      });
      act(() => { vi.advanceTimersByTime(100); });

      expect(screen.queryByTestId('new-entries-badge')).toBeNull();
    });

    it('shows badge with count when unpinned and entries arrive', () => {
      render(<LogViewer />);

      // Unpin
      fireEvent.click(screen.getByTestId('pin-toggle'));

      act(() => {
        latestESInstance!._simulateMessage(makeEntry({ message: 'Entry 1' }));
        latestESInstance!._simulateMessage(makeEntry({ message: 'Entry 2' }));
      });
      act(() => { vi.advanceTimersByTime(100); });

      const badge = screen.getByTestId('new-entries-badge');
      expect(badge.textContent).toContain('2');
    });

    it('clicking the badge re-pins and clears the count', () => {
      render(<LogViewer />);

      // Unpin
      fireEvent.click(screen.getByTestId('pin-toggle'));

      act(() => {
        latestESInstance!._simulateMessage(makeEntry());
      });
      act(() => { vi.advanceTimersByTime(100); });

      expect(screen.getByTestId('new-entries-badge')).not.toBeNull();

      fireEvent.click(screen.getByTestId('new-entries-badge'));

      expect(screen.queryByTestId('new-entries-badge')).toBeNull();
      expect(screen.getByTestId('pin-toggle').title).toBe('Unpin from bottom');
    });
  });

  // ---- Client-side filters ----

  describe('client-side filters', () => {
    it('renders the level filter select', () => {
      render(<LogViewer />);
      expect(screen.getByTestId('level-filter')).not.toBeNull();
    });

    it('renders the component filter input', () => {
      render(<LogViewer />);
      expect(screen.getByTestId('component-filter')).not.toBeNull();
    });

    it('hides entries whose level is below the selected filter', () => {
      render(<LogViewer />);

      act(() => {
        latestESInstance!._simulateMessage(
          makeEntry({ id: 1, level: 10, message: 'Debug message', component: 'x' })
        );
        latestESInstance!._simulateMessage(
          makeEntry({ id: 2, level: 40, message: 'Error message', component: 'x' })
        );
      });
      act(() => { vi.advanceTimersByTime(100); });

      // Both visible with no filter
      expect(screen.getByText('Debug message')).not.toBeNull();
      expect(screen.getByText('Error message')).not.toBeNull();

      // Apply level >= 40 filter
      fireEvent.change(screen.getByTestId('level-filter'), { target: { value: '40' } });

      expect(screen.queryByText('Debug message')).toBeNull();
      expect(screen.getByText('Error message')).not.toBeNull();
    });

    it('hides entries whose component does not match the filter', () => {
      render(<LogViewer />);

      act(() => {
        latestESInstance!._simulateMessage(
          makeEntry({ id: 1, message: 'Orchestrator log', component: 'orchestrator' })
        );
        latestESInstance!._simulateMessage(
          makeEntry({ id: 2, message: 'WebSocket log', component: 'websocket' })
        );
      });
      act(() => { vi.advanceTimersByTime(100); });

      // Apply component filter
      fireEvent.change(screen.getByTestId('component-filter'), {
        target: { value: 'orch' },
      });

      expect(screen.getByText('Orchestrator log')).not.toBeNull();
      expect(screen.queryByText('WebSocket log')).toBeNull();
    });

    it('component filter is case-insensitive', () => {
      render(<LogViewer />);

      act(() => {
        latestESInstance!._simulateMessage(
          makeEntry({ id: 1, message: 'Uppercase match', component: 'Orchestrator' })
        );
      });
      act(() => { vi.advanceTimersByTime(100); });

      fireEvent.change(screen.getByTestId('component-filter'), {
        target: { value: 'orchestrator' },
      });

      expect(screen.getByText('Uppercase match')).not.toBeNull();
    });
  });

  // ---- Log entry display ----

  describe('log entry display', () => {
    it('renders level badge for each entry', () => {
      render(<LogViewer />);

      act(() => {
        latestESInstance!._simulateMessage(
          makeEntry({ id: 1, level: 40, message: 'An error' })
        );
      });
      act(() => { vi.advanceTimersByTime(100); });

      expect(screen.getByText('error')).not.toBeNull();
    });

    it('renders entry message', () => {
      render(<LogViewer />);

      act(() => {
        latestESInstance!._simulateMessage(makeEntry({ message: 'Important log' }));
      });
      act(() => { vi.advanceTimersByTime(100); });

      expect(screen.getByText('Important log')).not.toBeNull();
    });

    it('renders error field when present', () => {
      render(<LogViewer />);

      act(() => {
        latestESInstance!._simulateMessage(
          makeEntry({ message: 'Crash', error: 'TypeError: foo is not a function' })
        );
      });
      act(() => { vi.advanceTimersByTime(100); });

      expect(screen.getByText('TypeError: foo is not a function')).not.toBeNull();
    });

    it('renders team_slug, task_id, agent_aid, event_type when present', () => {
      render(<LogViewer />);

      act(() => {
        latestESInstance!._simulateMessage(
          makeEntry({
            id: 42,
            message: 'Multi-field entry',
            team_slug: 'my-team',
            task_id: 'task-abc',
            agent_aid: 'aid-bot-xyz1',
            event_type: 'task.completed',
          })
        );
      });
      act(() => { vi.advanceTimersByTime(100); });

      expect(screen.getByText('team: my-team')).not.toBeNull();
      expect(screen.getByText('task: task-abc')).not.toBeNull();
      expect(screen.getByText('agent: aid-bot-xyz1')).not.toBeNull();
      expect(screen.getByText('event: task.completed')).not.toBeNull();
    });
  });

  // ---- Header ----

  describe('header', () => {
    it('shows count of filtered entries in header', () => {
      render(<LogViewer />);

      act(() => {
        latestESInstance!._simulateMessage(makeEntry({ id: 1, level: 10, component: 'a' }));
        latestESInstance!._simulateMessage(makeEntry({ id: 2, level: 40, component: 'b' }));
      });
      act(() => { vi.advanceTimersByTime(100); });

      expect(screen.getByText('Logs (2)')).not.toBeNull();

      // Apply filter to reduce count
      fireEvent.change(screen.getByTestId('level-filter'), { target: { value: '40' } });

      expect(screen.getByText('Logs (1)')).not.toBeNull();
    });
  });
});
