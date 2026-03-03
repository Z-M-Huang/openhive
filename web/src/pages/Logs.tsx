import { useState, useCallback, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useLogs } from '../hooks/useApi';
import type { LogEntry, LogQueryParams } from '../hooks/useApi';
import { LogRow } from '../components/logs/LogRow';
import { LogFilters } from '../components/logs/LogFilters';
import { useWebSocket } from '../hooks/useWebSocket';
import type { WSMessage } from '../hooks/useWebSocket';

/**
 * Log viewer page with filters, virtual scrolling, and real-time updates via WebSocket.
 */
export function Logs(): React.JSX.Element {
  const [filters, setFilters] = useState<LogQueryParams>({ limit: 200 });
  const [includeDebug, setIncludeDebug] = useState(false);
  const [liveEntries, setLiveEntries] = useState<LogEntry[]>([]);

  const queryFilters = includeDebug
    ? filters
    : { ...filters, level: filters.level || undefined };

  const { data: apiLogs, isLoading, isError } = useLogs(queryFilters);

  // Handle real-time log entries from WebSocket
  const handleWSMessage = useCallback((msg: WSMessage): void => {
    if (msg.type !== 'log_entry') return;
    const entry = msg.payload as LogEntry;
    if (!includeDebug && entry.level === 'debug') return;
    // Check component/team filters
    if (filters.component && entry.component !== filters.component) return;
    if (filters.team && entry.team_name !== filters.team) return;
    setLiveEntries(prev => [entry, ...prev.slice(0, 199)]);
  }, [includeDebug, filters]);

  useWebSocket({ onMessage: handleWSMessage });

  // Merge live entries with API entries, deduplicating by id
  const allEntries: LogEntry[] = (() => {
    const apiArr = Array.isArray(apiLogs) ? apiLogs : [];
    const seen = new Set(apiArr.map(e => e.id));
    const newLive = liveEntries.filter(e => !seen.has(e.id));
    return [...newLive, ...apiArr];
  })();

  // Virtual scrolling
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: allEntries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 10,
  });

  return (
    <div data-testid="logs-page" className="flex flex-col h-full">
      <h1 className="text-2xl font-bold mb-4">Logs</h1>

      <LogFilters
        filters={filters}
        onFiltersChange={setFilters}
        includeDebug={includeDebug}
        onToggleDebug={setIncludeDebug}
      />

      {isLoading && (
        <p className="text-sm text-muted-foreground">Loading logs...</p>
      )}
      {isError && (
        <p className="text-sm text-destructive">Error loading logs</p>
      )}

      {!isLoading && !isError && (
        <div className="text-xs text-muted-foreground mb-2">
          {allEntries.length} entries
          {liveEntries.length > 0 && (
            <span className="ml-2 text-green-600">
              ({liveEntries.length} live)
            </span>
          )}
        </div>
      )}

      <div
        ref={parentRef}
        className="flex-1 overflow-auto rounded-lg border border-border bg-card"
        data-testid="log-table"
        style={{ minHeight: 0 }}
      >
        {allEntries.length === 0 && !isLoading ? (
          <p className="p-4 text-sm text-muted-foreground">No log entries.</p>
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map(virtualItem => {
              const entry = allEntries[virtualItem.index];
              return (
                <div
                  key={virtualItem.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${virtualItem.size}px`,
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <LogRow entry={entry} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
