/**
 * escalate tool tests.
 *
 * Migrated from phase-gates/layer-5.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
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

  it('is notification-only for non-root callers and does not enqueue a parent task (ADR-43)', async () => {
    const result = await f.server.invoke(
      'escalate',
      { message: 'Need help' },
      'child',
    );

    const typed = result as { success: boolean; notification_only: boolean; correlation_id: string };
    expect(typed.success).toBe(true);
    expect(typed.notification_only).toBe(true);
    // Parent queue untouched — work handoff belongs to enqueue_parent_task.
    expect(f.taskQueue.tasks).toHaveLength(0);
    // Correlation record is still persisted for audit.
    expect(f.escalationStore.records).toHaveLength(1);
  });

  it('escalates to user via channel when caller has no parent (root team)', async () => {
    const result = await f.server.invoke(
      'escalate',
      { message: 'Help' },
      'root',
    );

    const typed = result as { success: boolean; correlation_id: string };
    expect(typed.success).toBe(true);
    expect(typed.correlation_id).toMatch(/^escalation:root:/);
    // Task queued for root team itself (user delivery)
    expect(f.taskQueue.tasks).toHaveLength(1);
    expect(f.taskQueue.tasks[0].teamId).toBe('root');
    expect(f.taskQueue.tasks[0].priority).toBe('high');
    expect(f.taskQueue.tasks[0].type).toBe('escalation');
  });

  it('threads sourceChannelId on the root-escalation queue entry', async () => {
    const result = await f.server.invoke('escalate', { message: 'need help' }, 'root', 'ws:abc123');
    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(f.taskQueue.tasks[0].sourceChannelId).toBe('ws:abc123');
  });

  it('sets sourceChannelId null when the root escalation does not supply one', async () => {
    const result = await f.server.invoke('escalate', { message: 'need help' }, 'root');
    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(f.taskQueue.tasks[0].sourceChannelId).toBeNull();
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
