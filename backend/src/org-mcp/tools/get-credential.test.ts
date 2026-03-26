/**
 * get_credential tool tests.
 *
 * Migrated from phase-gates/layer-5.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setupServer, makeTeamConfig } from '../__test-helpers.js';
import type { ServerFixtures } from '../__test-helpers.js';

describe('get_credential', () => {
  let f: ServerFixtures;

  beforeEach(() => {
    f = setupServer();
  });

  it('returns value when key exists', async () => {
    f.teamConfigs.set('ops', makeTeamConfig({
      name: 'ops',
      credentials: { subdomain: 'test-fake-credential-1234', region: 'us-east-1' },
    }));

    const result = await f.server.invoke('get_credential', { key: 'subdomain' }, 'ops') as Record<string, unknown>;
    expect(result['success']).toBe(true);
    expect(result['value']).toBe('test-fake-credential-1234');
    expect(result['note']).toBeTruthy();
  });

  it('returns error for unknown key', async () => {
    f.teamConfigs.set('ops', makeTeamConfig({
      name: 'ops',
      credentials: { subdomain: 'test-fake-credential-1234' },
    }));

    const result = await f.server.invoke('get_credential', { key: 'nonexistent' }, 'ops') as Record<string, unknown>;
    expect(result['success']).toBe(false);
    expect(result['error']).toContain('not found');
  });

  it('returns error when team config is missing', async () => {
    const result = await f.server.invoke('get_credential', { key: 'subdomain' }, 'ghost-team') as Record<string, unknown>;
    expect(result['success']).toBe(false);
    expect(result['error']).toContain('team not found');
  });

  it('logs access event', async () => {
    f.teamConfigs.set('ops', makeTeamConfig({
      name: 'ops',
      credentials: { subdomain: 'test-fake-credential-1234' },
    }));

    await f.server.invoke('get_credential', { key: 'subdomain' }, 'ops');
    expect(f.logMessages.some(l => l.msg === 'credential_access' && l.meta?.['team'] === 'ops')).toBe(true);
  });
});
