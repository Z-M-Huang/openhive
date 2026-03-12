/**
 * Dashboard page - system overview.
 */

import { SystemHealth } from '@/components/SystemHealth';
import { ContainerGrid } from '@/components/ContainerGrid';

export function Dashboard() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <SystemHealth />
      <div>
        <h2 className="text-lg font-semibold mb-4">Containers</h2>
        <ContainerGrid />
      </div>
    </div>
  );
}