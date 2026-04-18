/**
 * Skill Repository Tool — unit tests.
 *
 * Tests buildSkillRepoTools: success filtering, network error fallback,
 * timeout fallback, and SSRF rejection via validateBrowserUrl.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildSkillRepoTools } from './skill-repo-tool.js';
import { validateBrowserUrl } from './url-validator.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract the execute function from the built tool. */
function getExecute() {
  const tools = buildSkillRepoTools();
  const t = tools.search_skill_repository as unknown as { execute: (input: Record<string, unknown>) => Promise<unknown> };
  return t.execute;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('buildSkillRepoTools', () => {
  it('filters results by minScore and includes trust signals', async () => {
    const mockResponse = {
      results: [
        { name: 'email-triage', description: 'Email triage skill', matchScore: 0.85, installCount: 120, sourceReputation: 'verified' },
        { name: 'low-match', description: 'Low score skill', matchScore: 0.3, installCount: 5, sourceReputation: 'unverified' },
      ],
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(mockResponse)),
    }));

    const execute = getExecute();
    const result = await execute({ query: 'email triage' }) as Record<string, unknown>;

    expect(result.fallback).toBe(false);
    const results = result.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('email-triage');
    expect(results[0].matchScore).toBe(0.85);
    expect(results[0].installCount).toBe(120);
    expect(results[0].sourceReputation).toBe('verified');
  });

  it('returns fallback on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const execute = getExecute();
    const result = await execute({ query: 'anything' }) as Record<string, unknown>;

    expect(result.fallback).toBe(true);
    expect(result.results).toEqual([]);
    expect(result.reason).toBe('Service unavailable');
  });

  it('returns fallback on timeout (AbortError)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('The operation was aborted', 'AbortError')));

    const execute = getExecute();
    const result = await execute({ query: 'slow query' }) as Record<string, unknown>;

    expect(result.fallback).toBe(true);
    expect(result.results).toEqual([]);
    expect(result.reason).toBe('Service unavailable');
  });

  it('validateBrowserUrl rejects non-HTTPS private URLs', () => {
    const result = validateBrowserUrl('http://127.0.0.1:8080/v1/search');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('private');

    const fileResult = validateBrowserUrl('file:///etc/passwd');
    expect(fileResult.allowed).toBe(false);
  });
});
