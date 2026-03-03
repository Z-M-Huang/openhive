import { Wifi, WifiOff, AlertCircle } from 'lucide-react';
import { ThemeToggle } from '../ui/ThemeToggle';
import type { WSConnectionState } from '../../hooks/useWebSocket';
import { cn } from '../../lib/utils';

interface HeaderProps {
  connectionState: WSConnectionState;
}

const connectionIndicatorConfig: Record<
  WSConnectionState,
  { icon: typeof Wifi; color: string; label: string }
> = {
  connected: { icon: Wifi, color: 'text-green-500', label: 'Connected' },
  connecting: { icon: Wifi, color: 'text-yellow-500', label: 'Connecting...' },
  disconnected: { icon: WifiOff, color: 'text-gray-400', label: 'Disconnected' },
  error: { icon: AlertCircle, color: 'text-destructive', label: 'Connection error' },
};

/**
 * App header with connection status indicator and theme toggle.
 */
export function Header({ connectionState }: HeaderProps): React.JSX.Element {
  const { icon: Icon, color, label } = connectionIndicatorConfig[connectionState];

  return (
    <header className="flex items-center justify-between h-12 px-4 border-b border-border bg-card">
      <div className="flex-1" />
      <div className="flex items-center gap-2">
        <span
          className={cn('flex items-center gap-1 text-xs', color)}
          aria-label={`WebSocket: ${label}`}
          data-testid="connection-indicator"
        >
          <Icon className="h-3.5 w-3.5" aria-hidden />
          <span className="hidden sm:inline">{label}</span>
        </span>
        <ThemeToggle />
      </div>
    </header>
  );
}
