/**
 * web_fetch tool — unit tests.
 *
 * Verifies the enforced execution order: SSRF validation → domain rate-limit
 * check → network fetch (ADR-41). Any deviation is a security regression.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildWebFetchTool } from './web-fetch-tool.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

type ExecuteFn = (
  input: { url: string; method?: string; headers?: Record<string, string>; body?: string; timeout_ms?: number },
  ctx: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** Extract the execute function from the built ToolSet. */
function getExecute(
  fetchSpy: ReturnType<typeof vi.fn>,
  rateLimiter?: { consume: ReturnType<typeof vi.fn> },
): ExecuteFn {
  const tools = buildWebFetchTool({ fetch: fetchSpy as never, rateLimiter: rateLimiter as never });
  const webFetch = tools.web_fetch as unknown as { execute: ExecuteFn };
  return webFetch.execute;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('web_fetch domain rate limiting (ADR-41)', () => {
  it('returns a rate-limit error without calling fetch once the bucket is exhausted', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, text: async () => 'x' });
    const rateLimiter = {
      consume: vi.fn(() => ({ ok: false as const, retry_after_ms: 500 })),
    };
    const execute = getExecute(fetchSpy, rateLimiter);
    const result = await execute({ url: 'https://api.example.com/x' }, {});

    expect(result.success).toBe(false);
    expect(result.retry_after_ms).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('enforces SSRF validation before consulting the rate limiter', async () => {
    const fetchSpy = vi.fn();
    const rateLimiter = { consume: vi.fn(() => ({ ok: true as const })) };
    const execute = getExecute(fetchSpy, rateLimiter);
    const result = await execute({ url: 'http://127.0.0.1/secret' }, {});

    expect(result.success).toBe(false);
    expect(rateLimiter.consume).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calls fetch when SSRF passes and the bucket permits', async () => {
    const mockBody = { getReader: () => ({ read: vi.fn().mockResolvedValueOnce({ done: true, value: undefined }) }) };
    const mockResponse = { ok: true, status: 200, headers: { entries: () => [] }, body: mockBody };
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse);
    const rateLimiter = { consume: vi.fn(() => ({ ok: true as const })) };
    const execute = getExecute(fetchSpy, rateLimiter);
    const result = await execute({ url: 'https://api.example.com/x' }, {});

    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('skips rate limiting entirely when no rateLimiter is provided', async () => {
    const mockBody = { getReader: () => ({ read: vi.fn().mockResolvedValueOnce({ done: true, value: undefined }) }) };
    const mockResponse = { ok: true, status: 200, headers: { entries: () => [] }, body: mockBody };
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse);
    // No rateLimiter injected — production default path
    const tools = buildWebFetchTool({ fetch: fetchSpy as never });
    const webFetch = tools.web_fetch as unknown as { execute: ExecuteFn };
    const result = await webFetch.execute({ url: 'https://api.example.com/x' }, {});

    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('passes the correct hostname to rateLimiter.consume', async () => {
    const mockBody = { getReader: () => ({ read: vi.fn().mockResolvedValueOnce({ done: true, value: undefined }) }) };
    const mockResponse = { ok: true, status: 200, headers: { entries: () => [] }, body: mockBody };
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse);
    const rateLimiter = { consume: vi.fn(() => ({ ok: true as const })) };
    const execute = getExecute(fetchSpy, rateLimiter);
    await execute({ url: 'https://api.example.com/path?q=1' }, {});

    expect(rateLimiter.consume).toHaveBeenCalledWith('api.example.com');
  });
});
