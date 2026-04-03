/**
 * send_message tool tests.
 *
 * Migrated from phase-gates/layer-5.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setupServer, makeNode } from '../__test-helpers.js';
import type { ServerFixtures } from '../__test-helpers.js';

describe('send_message', () => {
  let f: ServerFixtures;

  beforeEach(() => {
    f = setupServer();
    f.orgTree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    f.orgTree.addTeam(makeNode({ teamId: 'child-a', name: 'child-a', parentId: 'root' }));
    f.orgTree.addTeam(makeNode({ teamId: 'child-b', name: 'child-b', parentId: 'root' }));
  });

  it('allows child to send to parent', async () => {
    const result = await f.server.invoke(
      'send_message',
      { target: 'root', message: 'status update' },
      'child-a',
    );

    expect(result).toEqual({ success: true });
    expect(f.logMessages).toHaveLength(1);
    expect(f.logMessages[0].meta!['from']).toBe('child-a');
    expect(f.logMessages[0].meta!['to']).toBe('root');
  });

  it('allows parent to send to child', async () => {
    const result = await f.server.invoke(
      'send_message',
      { target: 'child-a', message: 'instructions' },
      'root',
    );

    expect(result).toEqual({ success: true });
  });

  it('blocks unrelated teams (sibling to sibling)', async () => {
    const result = await f.server.invoke(
      'send_message',
      { target: 'child-b', message: 'hello sibling' },
      'child-a',
    );

    const typed = result as { success: boolean; error: string };
    expect(typed.success).toBe(false);
    expect(typed.error).toContain('neither parent nor child');
  });

  it('fails when target not found', async () => {
    const result = await f.server.invoke(
      'send_message',
      { target: 'ghost', message: 'hello' },
      'child-a',
    );

    const typed = result as { success: boolean; error: string };
    expect(typed.success).toBe(false);
    expect(typed.error).toContain('not found');
  });
});
