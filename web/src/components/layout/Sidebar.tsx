import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Users, CheckSquare, FileText, Settings } from 'lucide-react';
import { cn } from '../../lib/utils';

const navItems = [
  { to: '/', label: 'Dashboard', testId: 'nav-dashboard', icon: LayoutDashboard, end: true },
  { to: '/teams', label: 'Teams', testId: 'nav-teams', icon: Users },
  { to: '/tasks', label: 'Tasks', testId: 'nav-tasks', icon: CheckSquare },
  { to: '/logs', label: 'Logs', testId: 'nav-logs', icon: FileText },
  { to: '/settings', label: 'Settings', testId: 'nav-settings', icon: Settings },
] as const;

/**
 * Sidebar navigation component.
 * Uses NavLink for active route highlighting.
 */
export function Sidebar(): React.JSX.Element {
  return (
    <aside
      className="flex flex-col w-56 min-h-screen bg-card border-r border-border"
      data-testid="sidebar"
    >
      <div className="px-4 py-5 border-b border-border">
        <span className="text-lg font-semibold tracking-tight">OpenHive</span>
      </div>
      <nav className="flex-1 py-4 px-2" aria-label="Main navigation">
        <ul className="space-y-1" role="list">
          {navItems.map(({ to, label, testId, icon: Icon, ...rest }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={'end' in rest ? rest.end : undefined}
                data-testid={testId}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground',
                  )
                }
                aria-label={label}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
