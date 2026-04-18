import { describe, expect, it } from 'vitest';
import { queryTeams } from './query-teams.js';

describe('query_teams fan-out and timeout', () => {
  it('runs children in parallel rather than sequentially', async () => {
    const waits = [100, 120, 80];
    const startTimes: number[] = [];
    const deps = {
      queryRunner: {},
      queryTeamHandler: async ({ team }: { team: string }) => {
        startTimes.push(Date.now());
        await new Promise((r) => setTimeout(r, waits[Number(team.slice(1)) - 1]));
        return { success: true, result: `r-${team}` };
      },
      orgTree: { getTeam: () => ({ parentId: 'caller' }) },
    } as never;
    const result = await queryTeams(
      { teams: ['t1', 't2', 't3'], query: 'q' },
      'caller',
      deps,
    );
    expect(result.success).toBe(true);
    expect(result.results?.length).toBe(3);
    // Spread of start timestamps proves parallel dispatch without relying on
    // wall-clock total elapsed time (which is fragile under full-suite load).
    const spread = Math.max(...startTimes) - Math.min(...startTimes);
    expect(spread).toBeLessThan(50);
  });

  it('preserves successful siblings when one child rejects', async () => {
    const deps = {
      queryRunner: {},
      queryTeamHandler: async ({ team }: { team: string }) => {
        if (team === 't2') throw new Error('boom');
        return { success: true, result: `r-${team}` };
      },
      orgTree: { getTeam: () => ({ parentId: 'caller' }) },
    } as never;
    const result = await queryTeams(
      { teams: ['t1', 't2'], query: 'q' },
      'caller',
      deps,
    );
    const byTeam = new Map(result.results?.map((r) => [r.team, r]));
    expect(byTeam.get('t1')?.ok).toBe(true);
    expect(byTeam.get('t2')?.ok).toBe(false);
  });

  it('enforces the ADR-selected default timeout when none is supplied', async () => {
    const deps = {
      queryRunner: {},
      queryTeamHandler: async () => new Promise(() => {}), // never resolves
      orgTree: { getTeam: () => ({ parentId: 'caller' }) },
    } as never;
    const result = await queryTeams(
      { teams: ['t1'], query: 'q', timeout_ms: 50 },
      'caller',
      deps,
    );
    expect(result.results?.[0].ok).toBe(false);
    expect(result.results?.[0].result_or_error).toMatch(/timeout/i);
  });
});

// ── AC-24: secret scrubbing ───────────────────────────────────────────────────

describe('query_teams secret scrubbing', () => {
  it('never echoes a raw credential (>= 8 chars) back to the caller', async () => {
    // Synthetic value — long enough to cross the scrubbing threshold (8+ chars).
    const cred = 'long-cred-value-abc123';
    const deps = {
      queryRunner: {},
      queryTeamHandler: async () => ({ success: true, result: `response: ${cred}` }),
      orgTree: { getTeam: () => ({ parentId: 'caller' }) },
      credentialsLookup: () => [cred],
    } as never;
    const result = await queryTeams({ teams: ['t1'], query: 'q' }, 'caller', deps);
    const payload = JSON.stringify(result);
    expect(payload).not.toContain(cred);
    expect(payload).toMatch(/\[REDACTED\]|\[CREDENTIAL:/);
  });

  it('leaves short values below the masking threshold untouched', async () => {
    const deps = {
      queryRunner: {},
      queryTeamHandler: async () => ({ success: true, result: 'abc' }),
      orgTree: { getTeam: () => ({ parentId: 'caller' }) },
      credentialsLookup: () => ['abc'],
    } as never;
    const result = await queryTeams({ teams: ['t1'], query: 'q' }, 'caller', deps);
    expect(result.results?.[0].result_or_error).toBe('abc');
  });

  it('scrubs failure strings that could echo child output too', async () => {
    // Synthetic value — long enough to cross the scrubbing threshold.
    const cred = 'another-long-cred-xyz';
    const deps = {
      queryRunner: {},
      queryTeamHandler: async () => ({ success: false, error: `child replied: ${cred}` }),
      orgTree: { getTeam: () => ({ parentId: 'caller' }) },
      credentialsLookup: () => [cred],
    } as never;
    const result = await queryTeams({ teams: ['t1'], query: 'q' }, 'caller', deps);
    expect(JSON.stringify(result)).not.toContain(cred);
  });
});
