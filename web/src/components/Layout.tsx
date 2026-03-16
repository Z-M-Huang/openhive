/**
 * Shared layout component with navigation.
 */

import { Link, useLocation } from 'react-router-dom';
import { LayoutDashboard, Users, Bot, Server, CheckSquare, FileText, Puzzle, Cog } from 'lucide-react';

const mainNavItems = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/teams', label: 'Teams', icon: Users },
  { path: '/agents', label: 'Agents', icon: Bot },
  { path: '/containers', label: 'Containers', icon: Server },
  { path: '/tasks', label: 'Tasks', icon: CheckSquare },
  { path: '/logs', label: 'Logs', icon: FileText },
  { path: '/integrations', label: 'Integrations', icon: Puzzle },
];

const settingsNavItem = { path: '/settings', label: 'Settings', icon: Cog };

function NavLink({ path, label, icon: Icon, isActive }: {
  path: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  isActive: boolean;
}) {
  return (
    <Link
      to={path}
      className={`flex items-center gap-2 px-4 py-2 rounded-md transition-colors ${
        isActive
          ? 'bg-gray-800 text-white'
          : 'text-gray-400 hover:text-white hover:bg-gray-700'
      }`}
    >
      <Icon className="w-5 h-5" />
      <span>{label}</span>
    </Link>
  );
}

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const location = useLocation();

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Header */}
      <header className="bg-gray-800 border-b border-gray-700">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold">OpenHive v2</h1>
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-400">Monitoring Portal</span>
            </div>
          </div>
        </div>
      </header>

      {/* Navigation */}
      <nav className="bg-gray-800 border-b border-gray-700">
        <div className="max-w-7xl mx-auto px-4 py-2">
          <div className="flex items-center gap-2">
            {mainNavItems.map((item) => (
              <NavLink
                key={item.path}
                path={item.path}
                label={item.label}
                icon={item.icon}
                isActive={location.pathname === item.path}
              />
            ))}
            <div className="ml-auto border-l border-gray-600 pl-2">
              <NavLink
                path={settingsNavItem.path}
                label={settingsNavItem.label}
                icon={settingsNavItem.icon}
                isActive={location.pathname === settingsNavItem.path}
              />
            </div>
          </div>
        </div>
      </nav>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 py-6">
        {children}
      </main>
    </div>
  );
}