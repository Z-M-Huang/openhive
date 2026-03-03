import { Outlet } from 'react-router-dom';
import { useState } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { useWebSocket, type WSConnectionState } from '../../hooks/useWebSocket';
import { queryClient } from '../../lib/queryClient';
import type { WSMessage } from '../../hooks/useWebSocket';

/**
 * Root layout: sidebar (left) + header + page content (right).
 * Manages the single WebSocket connection for the portal.
 */
export function Layout(): React.JSX.Element {
  const [connectionState, setConnectionState] = useState<WSConnectionState>('connecting');

  const handleMessage = (msg: WSMessage): void => {
    // Invalidate relevant queries based on event type
    const type = msg.type as string;
    if (type === 'task_updated' || type === 'task_created' || type === 'task_completed' || type === 'task_failed') {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    } else if (type === 'heartbeat_received' || type === 'container_state_changed') {
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
    } else if (type === 'log_entry') {
      void queryClient.invalidateQueries({ queryKey: ['logs'] });
    }
  };

  useWebSocket({
    onMessage: handleMessage,
    onStateChange: setConnectionState,
  });

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0">
        <Header connectionState={connectionState} />
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
