import { useState } from 'react';
import type { LogEntry } from '../../hooks/useApi';
import { cn } from '../../lib/utils';

const levelColors: Record<string, string> = {
  debug: 'text-gray-500 bg-gray-100 dark:bg-gray-800',
  info: 'text-blue-600 bg-blue-50 dark:bg-blue-900/30',
  warn: 'text-yellow-600 bg-yellow-50 dark:bg-yellow-900/30',
  error: 'text-red-600 bg-red-50 dark:bg-red-900/30',
};

interface LogRowProps {
  entry: LogEntry;
  style?: React.CSSProperties;
}

/**
 * A single log row with expandable params.
 * Params are rendered as JSON in a pre block to prevent XSS.
 */
export function LogRow({ entry, style }: LogRowProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);

  const levelColor = levelColors[entry.level] ?? levelColors.info;
  const timestamp = new Date(entry.timestamp).toLocaleTimeString();

  const paramsJson = entry.params
    ? JSON.stringify(entry.params, null, 2)
    : null;

  return (
    <div
      style={style}
      className="border-b border-border hover:bg-accent/30 transition-colors"
      data-testid="log-row"
    >
      <button
        type="button"
        className="w-full text-left px-4 py-2 flex items-center gap-3"
        onClick={() => setExpanded(prev => !prev)}
        aria-expanded={expanded}
      >
        <span className="text-xs text-muted-foreground w-20 shrink-0 font-mono">
          {timestamp}
        </span>
        <span
          className={cn(
            'text-xs font-medium rounded px-1.5 py-0.5 w-12 text-center shrink-0',
            levelColor,
          )}
          data-testid="log-level"
        >
          {entry.level}
        </span>
        <span className="text-xs text-muted-foreground w-24 shrink-0 truncate">
          {entry.component}
        </span>
        <span className="text-sm truncate flex-1">{entry.message}</span>
        {entry.team_name && (
          <span className="text-xs text-muted-foreground shrink-0">{entry.team_name}</span>
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-3 pl-20" data-testid="log-detail">
          {entry.action && (
            <p className="text-xs text-muted-foreground mb-1">
              <span className="font-medium">Action:</span> {entry.action}
            </p>
          )}
          {entry.task_id && (
            <p className="text-xs text-muted-foreground mb-1">
              <span className="font-medium">Task:</span> {entry.task_id}
            </p>
          )}
          {entry.agent_aid && (
            <p className="text-xs text-muted-foreground mb-1">
              <span className="font-medium">Agent:</span> {entry.agent_aid}
            </p>
          )}
          {paramsJson && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Params:</p>
              {/* Pre block prevents HTML injection — params are JSON-serialized, never raw HTML */}
              <pre
                className="text-xs bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap break-all"
                data-testid="log-params"
              >
                {paramsJson}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
