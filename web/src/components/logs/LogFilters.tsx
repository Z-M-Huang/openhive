import type { LogQueryParams } from '../../hooks/useApi';

interface LogFiltersProps {
  filters: LogQueryParams;
  onFiltersChange: (filters: LogQueryParams) => void;
  includeDebug: boolean;
  onToggleDebug: (include: boolean) => void;
}

/**
 * Filter controls for the log viewer.
 */
export function LogFilters({
  filters,
  onFiltersChange,
  includeDebug,
  onToggleDebug,
}: LogFiltersProps): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-3 mb-4" data-testid="log-filters">
      <div>
        <label className="sr-only" htmlFor="log-level-filter">Log level</label>
        <select
          id="log-level-filter"
          value={filters.level ?? ''}
          onChange={e =>
            onFiltersChange({ ...filters, level: e.target.value || undefined })
          }
          className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          data-testid="log-level-filter"
        >
          <option value="">All levels</option>
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
      </div>

      <div>
        <label className="sr-only" htmlFor="log-component-filter">Component</label>
        <input
          id="log-component-filter"
          type="text"
          placeholder="Component..."
          value={filters.component ?? ''}
          onChange={e =>
            onFiltersChange({ ...filters, component: e.target.value || undefined })
          }
          className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          data-testid="log-component-filter"
        />
      </div>

      <div>
        <label className="sr-only" htmlFor="log-team-filter">Team</label>
        <input
          id="log-team-filter"
          type="text"
          placeholder="Team..."
          value={filters.team ?? ''}
          onChange={e =>
            onFiltersChange({ ...filters, team: e.target.value || undefined })
          }
          className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          data-testid="log-team-filter"
        />
      </div>

      <label className="flex items-center gap-2 text-sm cursor-pointer" data-testid="debug-toggle-label">
        <input
          type="checkbox"
          checked={includeDebug}
          onChange={e => onToggleDebug(e.target.checked)}
          className="rounded"
          data-testid="debug-toggle"
        />
        Include debug
      </label>
    </div>
  );
}
