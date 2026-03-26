/**
 * UT-9: MCP Builder
 *
 * Tests: MCP builder includes only listed servers, skips unknown
 */

import { describe, it, expect } from 'vitest';

import { buildMcpServers } from './mcp-builder.js';

// ── UT-9: MCP Builder ─────────────────────────────────────────────────────

describe('UT-9: MCP Builder', () => {
  const available = {
    org: { url: 'http://org:3000' },
    analytics: { url: 'http://analytics:3001' },
    secrets: { url: 'http://secrets:3002' },
  };

  it('includes only listed servers', () => {
    const result = buildMcpServers(['org', 'analytics'], available);
    expect(Object.keys(result)).toEqual(['org', 'analytics']);
    expect(result['org']).toEqual({ url: 'http://org:3000' });
    expect(result['analytics']).toEqual({ url: 'http://analytics:3001' });
  });

  it('excludes unlisted servers', () => {
    const result = buildMcpServers(['org'], available);
    expect(Object.keys(result)).toEqual(['org']);
    expect(result['analytics']).toBeUndefined();
    expect(result['secrets']).toBeUndefined();
  });

  it('skips unknown servers without crashing', () => {
    const result = buildMcpServers(['org', 'nonexistent'], available);
    expect(Object.keys(result)).toEqual(['org']);
  });

  it('returns empty object when no servers configured', () => {
    const result = buildMcpServers([], available);
    expect(result).toEqual({});
  });

  it('returns empty object when all servers unknown', () => {
    const result = buildMcpServers(['ghost1', 'ghost2'], available);
    expect(result).toEqual({});
  });
});
