import { useHealth } from '../hooks/useApi';

/**
 * Dashboard page: system status overview.
 */
export function Dashboard(): React.JSX.Element {
  const { data: health, isLoading, isError } = useHealth();

  return (
    <div data-testid="dashboard-page">
      <h1 className="text-2xl font-bold mb-6">Dashboard</h1>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-medium text-muted-foreground mb-1">Status</h2>
          {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
          {isError && <p className="text-sm text-destructive">Error loading status</p>}
          {health && (
            <p className="text-lg font-semibold capitalize">{health.status}</p>
          )}
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-medium text-muted-foreground mb-1">Version</h2>
          <p className="text-lg font-semibold">{health?.version ?? '—'}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-medium text-muted-foreground mb-1">Uptime</h2>
          <p className="text-lg font-semibold">{health?.uptime ?? '—'}</p>
        </div>
      </div>
    </div>
  );
}
