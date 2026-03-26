/**
 * escalate tool tests.
 *
 * Migrated from phase-gates/layer-5.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TaskPriority } from '../../domain/types.js';
import { setupServer, makeNode } from '../__test-helpers.js';
import type { ServerFixtures } from '../__test-helpers.js';

describe('escalate', () => {
  let f: ServerFixtures;

  beforeEach(() => {
    f = setupServer();
    f.orgTree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    f.orgTree.addTeam(makeNode({ teamId: 'child', name: 'child', parentId: 'root' }));
  });

  it('generates correlation_id and persists to store', async () => {
    const result = await f.server.invoke(
      'escalate',
      { message: 'Need help with complex task', reason: 'out of scope' },
      'child',
    );

    const typed = result as { success: boolean; correlation_id: string };
    expect(typed.success).toBe(true);
    expect(typed.correlation_id).toBeTruthy();

    // Verify escalation store
    expect(f.escalationStore.records).toHaveLength(1);
    expect(f.escalationStore.records[0].sourceTeam).toBe('child');
    expect(f.escalationStore.records[0].targetTeam).toBe('root');
    expect(f.escalationStore.records[0].correlationId).toBe(typed.correlation_id);
  });

  it('queues task for parent with high priority', async () => {
    await f.server.invoke(
      'escalate',
      { message: 'Need help' },
      'child',
    );

    expect(f.taskQueue.tasks).toHaveLength(1);
    expect(f.taskQueue.tasks[0].teamId).toBe('root');
    expect(f.taskQueue.tasks[0].priority).toBe(TaskPriority.High);
    expect(f.taskQueue.tasks[0].task).toContain('Need help');
  });

  it('fails when caller has no parent', async () => {
    const result = await f.server.invoke(
      'escalate',
      { message: 'Help' },
      'root',
    );

    const typed = result as { success: boolean; error: string };
    expect(typed.success).toBe(false);
    expect(typed.error).toContain('no parent');
  });

  it('fails when caller not found in org tree', async () => {
    const result = await f.server.invoke(
      'escalate',
      { message: 'Help' },
      'ghost',
    );

    const typed = result as { success: boolean; error: string };
    expect(typed.success).toBe(false);
    expect(typed.error).toContain('not found');
  });
});
