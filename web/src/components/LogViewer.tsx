/**
 * Log viewer component with SSE auto-streaming.
 *
 * AC-G11: Auto-connects on page load, batches incoming events, caps buffer at
 * 1000 entries, auto-scrolls to bottom (with pin toggle), shows connection
 * status indicator, and applies client-side level/component filters.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Filter, AlertCircle, Info, AlertTriangle, Bug, Wifi, WifiOff, Pin, PinOff } from 'lucide-react';
import type { LogEntry } from '@/types/api';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BUFFER_SIZE = 1000;
const BATCH_FLUSH_INTERVAL_MS = 100;
const SSE_URL = '/api/logs/stream';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function LevelIcon({ level }: { level: number }) {
  if (level >= 50) return <AlertCircle className="w-4 h-4 text-red-400" />;
  if (level >= 40) return <AlertTriangle className="w-4 h-4 text-orange-400" />;
  if (level >= 30) return <Info className="w-4 h-4 text-yellow-400" />;
  return <Bug className="w-4 h-4 text-gray-400" />;
}

function LevelBadge({ level }: { level: number }) {
  const labels: Record<number, string> = {
    0: 'trace',
    10: 'debug',
    20: 'info',
    30: 'warn',
    40: 'error',
    50: 'audit',
  };

  const colors: Record<number, string> = {
    0: 'text-gray-400',
    10: 'text-gray-400',
    20: 'text-blue-400',
    30: 'text-yellow-400',
    40: 'text-orange-400',
    50: 'text-red-400',
  };

  const label = labels[level] ?? 'unknown';
  const color = colors[level] ?? 'text-gray-400';

  return (
    <span className={`flex items-center gap-1 ${color}`}>
      <LevelIcon level={level} />
      {label}
    </span>
  );
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function LogViewer() {
  // Filter state (client-side)
  const [levelFilter, setLevelFilter] = useState<number | undefined>(undefined);
  const [componentFilter, setComponentFilter] = useState('');

  // SSE connection state
  const [connected, setConnected] = useState(false);

  // In-memory log buffer (capped at MAX_BUFFER_SIZE)
  const [entries, setEntries] = useState<LogEntry[]>([]);

  // Pending batch from SSE (accumulated between flushes)
  const pendingRef = useRef<LogEntry[]>([]);

  // Auto-scroll (pin to bottom)
  const [pinned, setPinned] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // Keep pinnedRef in sync with state
  useEffect(() => {
    pinnedRef.current = pinned;
    if (pinned) {
      setNewCount(0);
      scrollToBottom();
    }
  }, [pinned]);

  function scrollToBottom() {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }

  // ---------------------------------------------------------------------------
  // SSE connection (auto-connect on mount)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const es = new EventSource(SSE_URL);

    es.onopen = () => {
      setConnected(true);
    };

    es.onmessage = (ev: MessageEvent) => {
      try {
        const entry = JSON.parse(ev.data as string) as LogEntry;
        pendingRef.current.push(entry);
      } catch {
        // Malformed event — skip silently
      }
    };

    es.onerror = () => {
      setConnected(false);
      // EventSource reconnects automatically
    };

    return () => {
      es.close();
      setConnected(false);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Batch flush every 100ms
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const timer = setInterval(() => {
      const batch = pendingRef.current;
      if (batch.length === 0) return;
      pendingRef.current = [];

      setEntries((prev) => {
        const combined = [...prev, ...batch];
        // Cap at MAX_BUFFER_SIZE — evict from front (oldest first)
        const capped =
          combined.length > MAX_BUFFER_SIZE
            ? combined.slice(combined.length - MAX_BUFFER_SIZE)
            : combined;
        return capped;
      });

      if (!pinnedRef.current) {
        setNewCount((c) => c + batch.length);
      }
    }, BATCH_FLUSH_INTERVAL_MS);

    return () => clearInterval(timer);
  }, []);

  // ---------------------------------------------------------------------------
  // Auto-scroll when pinned and entries change
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (pinnedRef.current) {
      scrollToBottom();
    }
  }, [entries]);

  // ---------------------------------------------------------------------------
  // Scroll event handler to detect manual scroll-up (unpin)
  // ---------------------------------------------------------------------------

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    if (atBottom && !pinnedRef.current) {
      setPinned(true);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Client-side filtering
  // ---------------------------------------------------------------------------

  const filteredEntries = entries.filter((entry) => {
    if (levelFilter !== undefined && entry.level < levelFilter) return false;
    if (componentFilter && !entry.component?.toLowerCase().includes(componentFilter.toLowerCase()))
      return false;
    return true;
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden" data-testid="log-viewer">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <h2 className="font-semibold">Logs ({filteredEntries.length})</h2>
        <div className="flex items-center gap-3">
          {/* Connection status */}
          <span
            className={`flex items-center gap-1 text-sm ${connected ? 'text-green-400' : 'text-red-400'}`}
            data-testid="sse-status"
            title={connected ? 'SSE connected' : 'SSE disconnected'}
          >
            {connected ? (
              <>
                <Wifi className="w-4 h-4" />
                <span>Live</span>
              </>
            ) : (
              <>
                <WifiOff className="w-4 h-4" />
                <span>Offline</span>
              </>
            )}
          </span>

          {/* Pin-to-bottom toggle */}
          <button
            onClick={() => setPinned((p) => !p)}
            className={`p-2 transition-colors ${pinned ? 'text-blue-400 hover:text-blue-300' : 'text-gray-400 hover:text-white'}`}
            title={pinned ? 'Unpin from bottom' : 'Pin to bottom'}
            data-testid="pin-toggle"
          >
            {pinned ? <Pin className="w-4 h-4" /> : <PinOff className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4 px-4 py-3 border-b border-gray-700 bg-gray-750">
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-gray-400" />
          <span className="text-sm text-gray-400">Filters:</span>
        </div>
        <select
          value={levelFilter ?? ''}
          onChange={(e) =>
            setLevelFilter(e.target.value ? parseInt(e.target.value, 10) : undefined)
          }
          className="bg-gray-700 text-white px-3 py-1 rounded text-sm"
          data-testid="level-filter"
        >
          <option value="">All Levels</option>
          <option value="50">Audit</option>
          <option value="40">Error+</option>
          <option value="30">Warn+</option>
          <option value="20">Info+</option>
          <option value="10">Debug+</option>
          <option value="0">Trace+</option>
        </select>
        <input
          type="text"
          placeholder="Component..."
          value={componentFilter}
          onChange={(e) => setComponentFilter(e.target.value)}
          className="bg-gray-700 text-white px-3 py-1 rounded text-sm w-32"
          data-testid="component-filter"
        />
      </div>

      {/* Log entries */}
      <div className="relative">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="divide-y divide-gray-700 max-h-[600px] overflow-y-auto"
          data-testid="log-scroll"
        >
          {filteredEntries.length === 0 ? (
            <div className="p-6">
              <p className="text-gray-400">No log entries found</p>
            </div>
          ) : (
            filteredEntries.map((entry) => (
              <div key={entry.id} className="px-4 py-3 hover:bg-gray-750">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <LevelBadge level={entry.level} />
                    <span className="text-sm text-gray-300 truncate">{entry.component}</span>
                  </div>
                  <span className="text-xs text-gray-500 whitespace-nowrap">
                    {formatDate(entry.created_at)}
                  </span>
                </div>
                <p className="mt-1 text-sm text-gray-200 break-all">{entry.message}</p>
                {entry.error && (
                  <p className="mt-1 text-xs text-red-400 break-all">{entry.error}</p>
                )}
                <div className="mt-1 flex flex-wrap gap-2 text-xs text-gray-500">
                  {entry.team_slug && <span>team: {entry.team_slug}</span>}
                  {entry.task_id && <span>task: {entry.task_id}</span>}
                  {entry.agent_aid && <span>agent: {entry.agent_aid}</span>}
                  {entry.event_type && <span>event: {entry.event_type}</span>}
                </div>
              </div>
            ))
          )}
        </div>

        {/* "N new entries" badge shown when unpinned and new entries have arrived */}
        {!pinned && newCount > 0 && (
          <button
            onClick={() => {
              setPinned(true);
              scrollToBottom();
            }}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-1 rounded-full shadow-lg transition-colors"
            data-testid="new-entries-badge"
          >
            {newCount} new {newCount === 1 ? 'entry' : 'entries'}
          </button>
        )}
      </div>
    </div>
  );
}
