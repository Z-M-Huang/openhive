/**
 * Plugin lifecycle audit tests (AC-29).
 *
 * Verifies: schema has deprecated/removed columns, PluginToolStore.deprecate()
 * and markRemoved() persist audit fields, upsert() round-trips lifecycle state,
 * and status transitions reflect in the returned metadata.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, createTables } from './database.js';
import type { DatabaseInstance } from './database.js';
import { PluginToolStore } from './stores/plugin-tool-store.js';
import type { PluginToolMeta } from '../domain/interfaces.js';

function baseMeta(overrides: Partial<PluginToolMeta> = {}): PluginToolMeta {
  const now = new Date().toISOString();
  return {
    teamName: 'alpha',
    toolName: 'demo_tool',
    status: 'active',
    sourcePath: '/plugins/alpha/demo_tool.ts',
    sourceHash: 'sha256:aaa',
    verification: { typescript: { valid: true, errors: [] } },
    verifiedAt: now,
    createdAt: now,
    updatedAt: now,
    deprecatedAt: null,
    deprecatedReason: null,
    deprecatedBy: null,
    removedAt: null,
    removedBy: null,
    ...overrides,
  };
}

describe('PluginToolStore — lifecycle audit (AC-29)', () => {
  let instance: DatabaseInstance;
  let store: PluginToolStore;

  beforeEach(() => {
    instance = createDatabase(':memory:');
    createTables(instance.raw);
    store = new PluginToolStore(instance.db);
  });

  afterEach(() => {
    instance.raw.close();
  });

  // -- schema columns present ---------------------------------------------

  it('plugin_tools table exposes the 5 lifecycle audit columns', () => {
    const cols = instance.raw.prepare("PRAGMA table_info(plugin_tools)").all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain('deprecated_at');
    expect(names).toContain('deprecated_reason');
    expect(names).toContain('deprecated_by');
    expect(names).toContain('removed_at');
    expect(names).toContain('removed_by');
  });

  // -- upsert round-trip --------------------------------------------------

  it('upsert persists null lifecycle fields by default', () => {
    store.upsert(baseMeta());
    const meta = store.get('alpha', 'demo_tool');
    expect(meta).toBeDefined();
    expect(meta?.deprecatedAt).toBeNull();
    expect(meta?.deprecatedReason).toBeNull();
    expect(meta?.deprecatedBy).toBeNull();
    expect(meta?.removedAt).toBeNull();
    expect(meta?.removedBy).toBeNull();
  });

  it('upsert round-trips explicit lifecycle values', () => {
    const audit = {
      deprecatedAt: '2026-04-14T00:00:00.000Z',
      deprecatedReason: 'replaced by demo_tool_v2',
      deprecatedBy: 'admin@example.com',
      removedAt: '2026-04-20T00:00:00.000Z',
      removedBy: 'admin@example.com',
    };
    store.upsert(baseMeta({ status: 'removed', ...audit }));
    const meta = store.get('alpha', 'demo_tool');
    expect(meta?.status).toBe('removed');
    expect(meta?.deprecatedAt).toBe(audit.deprecatedAt);
    expect(meta?.deprecatedReason).toBe(audit.deprecatedReason);
    expect(meta?.deprecatedBy).toBe(audit.deprecatedBy);
    expect(meta?.removedAt).toBe(audit.removedAt);
    expect(meta?.removedBy).toBe(audit.removedBy);
  });

  // -- deprecate() method -------------------------------------------------

  it('deprecate() transitions status and fills audit fields', () => {
    store.upsert(baseMeta());
    store.deprecate('alpha', 'demo_tool', 'obsolete API shape', 'planner@alpha');

    const meta = store.get('alpha', 'demo_tool');
    expect(meta?.status).toBe('deprecated');
    expect(meta?.deprecatedAt).toBeTruthy();
    expect(typeof meta?.deprecatedAt).toBe('string');
    expect(meta?.deprecatedReason).toBe('obsolete API shape');
    expect(meta?.deprecatedBy).toBe('planner@alpha');
    expect(meta?.removedAt).toBeNull();
    expect(meta?.removedBy).toBeNull();
  });

  it('deprecate() is a no-op for a missing tool (does not insert rows)', () => {
    store.deprecate('alpha', 'nonexistent', 'whatever', 'someone');
    expect(store.get('alpha', 'nonexistent')).toBeUndefined();
  });

  // -- markRemoved() method -----------------------------------------------

  it('markRemoved() transitions status and fills removal audit fields', () => {
    store.upsert(baseMeta());
    store.deprecate('alpha', 'demo_tool', 'old', 'planner@alpha');
    store.markRemoved('alpha', 'demo_tool', 'ops@alpha');

    const meta = store.get('alpha', 'demo_tool');
    expect(meta?.status).toBe('removed');
    expect(meta?.removedAt).toBeTruthy();
    expect(meta?.removedBy).toBe('ops@alpha');
    // deprecation history preserved
    expect(meta?.deprecatedReason).toBe('old');
    expect(meta?.deprecatedBy).toBe('planner@alpha');
  });

  // -- status query listings include lifecycle data -----------------------

  it('getByTeam returns lifecycle audit columns for all rows', () => {
    store.upsert(baseMeta({ toolName: 'tool_a' }));
    store.upsert(baseMeta({ toolName: 'tool_b' }));
    store.deprecate('alpha', 'tool_b', 'retired', 'admin');

    const rows = store.getByTeam('alpha').sort((a, b) => a.toolName.localeCompare(b.toolName));
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('active');
    expect(rows[0].deprecatedReason).toBeNull();
    expect(rows[1].status).toBe('deprecated');
    expect(rows[1].deprecatedReason).toBe('retired');
  });
});
