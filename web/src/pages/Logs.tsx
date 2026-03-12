/**
 * Logs page - log viewer.
 */

import { LogViewer } from '@/components/LogViewer';

export function Logs() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Logs</h1>
      <LogViewer />
    </div>
  );
}