/**
 * MCP Bridge tests.
 *
 * resolveActiveTools: fully tested with pure logic.
 * connectMcpServers: tested for configuration correctness using a
 * mock of createMCPClient (actual connectivity is an integration concern).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { resolveActiveTools } from './mcp-bridge.js';

// ── resolveActiveTools ───────────────────────────────────────────────────────

describe('resolveActiveTools', () => {
  const allTools = [
    'Read',
    'Write',
    'Edit',
    'Bash',
    'mcp__org__spawn_team',
    'mcp__org__get_credential',
    'mcp__org__list_teams',
    'mcp__analytics__query',
  ];

  it('returns all tool names when allowed_tools includes "*"', () => {
    const result = resolveActiveTools(allTools, ['*']);
    expect(result).toEqual(allTools);
  });

  it('returns all tool names when "*" is among other entries', () => {
    const result = resolveActiveTools(allTools, ['Read', '*', 'Bash']);
    expect(result).toEqual(allTools);
  });

  it('filters by exact match', () => {
    const result = resolveActiveTools(allTools, ['Read', 'Bash']);
    expect(result).toEqual(['Read', 'Bash']);
  });

  it('filters by glob prefix (e.g., mcp__org__*)', () => {
    const result = resolveActiveTools(allTools, ['mcp__org__*']);
    expect(result).toEqual([
      'mcp__org__spawn_team',
      'mcp__org__get_credential',
      'mcp__org__list_teams',
    ]);
  });

  it('supports mixed exact + glob entries', () => {
    const result = resolveActiveTools(allTools, [
      'Read',
      'Write',
      'mcp__org__*',
    ]);
    expect(result).toEqual([
      'Read',
      'Write',
      'mcp__org__spawn_team',
      'mcp__org__get_credential',
      'mcp__org__list_teams',
    ]);
  });

  it('excludes non-matching tools', () => {
    const result = resolveActiveTools(allTools, ['Glob', 'Grep']);
    expect(result).toEqual([]);
  });

  it('returns empty array when allowedTools is empty', () => {
    const result = resolveActiveTools(allTools, []);
    expect(result).toEqual([]);
  });

  it('returns empty array when allToolNames is empty', () => {
    const result = resolveActiveTools([], ['Read', 'mcp__org__*']);
    expect(result).toEqual([]);
  });

  it('glob prefix does not match partial names incorrectly', () => {
    // 'mcp__*' should match everything starting with 'mcp__'
    const result = resolveActiveTools(allTools, ['mcp__*']);
    expect(result).toEqual([
      'mcp__org__spawn_team',
      'mcp__org__get_credential',
      'mcp__org__list_teams',
      'mcp__analytics__query',
    ]);
  });

  it('does not duplicate tools matched by both exact and glob', () => {
    const result = resolveActiveTools(allTools, [
      'mcp__org__spawn_team',
      'mcp__org__*',
    ]);
    // Each tool appears exactly once — filter + Set-based exact keeps order
    expect(result).toEqual([
      'mcp__org__spawn_team',
      'mcp__org__get_credential',
      'mcp__org__list_teams',
    ]);
  });
});

// ── connectMcpServers (configuration logic) ──────────────────────────────────

// We mock createMCPClient at the module level to verify that connectMcpServers
// passes the correct transport config without needing a real MCP server.
vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: vi.fn(),
}));

describe('connectMcpServers', () => {
  let mockCreateMCPClient: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetAllMocks();
    const mod = await import('@ai-sdk/mcp');
    mockCreateMCPClient = mod.createMCPClient as ReturnType<typeof vi.fn>;
  });

  // Import dynamically so the mock is in effect
  async function importBridge() {
    // Clear module cache to pick up fresh mock
    return import('./mcp-bridge.js');
  }

  it('connects to org server with correct transport config', async () => {
    const mockClient = {
      tools: vi.fn().mockResolvedValue({
        spawn_team: { description: 'Spawn a team', execute: vi.fn() },
        list_teams: { description: 'List teams', execute: vi.fn() },
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockCreateMCPClient.mockResolvedValue(mockClient);

    const { connectMcpServers } = await importBridge();
    const result = await connectMcpServers({
      configMcpServers: ['org'],
      orgMcpPort: 3001,
      teamName: 'weather-team',
    });

    // Verify transport config
    expect(mockCreateMCPClient).toHaveBeenCalledOnce();
    expect(mockCreateMCPClient).toHaveBeenCalledWith({
      transport: {
        type: 'http',
        url: 'http://127.0.0.1:3001/mcp',
        headers: { 'X-Caller-Id': 'weather-team' },
      },
    });

    // Tools are namespaced
    expect(Object.keys(result.tools)).toEqual([
      'mcp__org__spawn_team',
      'mcp__org__list_teams',
    ]);

    // Cleanup calls close on client
    await result.cleanup();
    expect(mockClient.close).toHaveBeenCalledOnce();
  });

  it('passes X-Source-Channel header when sourceChannelId provided', async () => {
    const mockClient = {
      tools: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockCreateMCPClient.mockResolvedValue(mockClient);

    const { connectMcpServers } = await importBridge();
    await connectMcpServers({
      configMcpServers: ['org'],
      orgMcpPort: 3001,
      teamName: 'ops-team',
      sourceChannelId: 'discord-123',
    });

    expect(mockCreateMCPClient).toHaveBeenCalledWith({
      transport: {
        type: 'http',
        url: 'http://127.0.0.1:3001/mcp',
        headers: {
          'X-Caller-Id': 'ops-team',
          'X-Source-Channel': 'discord-123',
        },
      },
    });
  });

  it('skips unknown server names without crashing', async () => {
    const { connectMcpServers } = await importBridge();
    const result = await connectMcpServers({
      configMcpServers: ['nonexistent', 'ghost'],
      orgMcpPort: 3001,
      teamName: 'test-team',
    });

    expect(mockCreateMCPClient).not.toHaveBeenCalled();
    expect(Object.keys(result.tools)).toEqual([]);
  });

  it('returns empty tools when no servers configured', async () => {
    const { connectMcpServers } = await importBridge();
    const result = await connectMcpServers({
      configMcpServers: [],
      orgMcpPort: 3001,
      teamName: 'test-team',
    });

    expect(Object.keys(result.tools)).toEqual([]);
  });

  it('cleanup tolerates errors from client.close()', async () => {
    const mockClient = {
      tools: vi.fn().mockResolvedValue({ tool_a: { execute: vi.fn() } }),
      close: vi.fn().mockRejectedValue(new Error('connection already closed')),
    };
    mockCreateMCPClient.mockResolvedValue(mockClient);

    const { connectMcpServers } = await importBridge();
    const result = await connectMcpServers({
      configMcpServers: ['org'],
      orgMcpPort: 3001,
      teamName: 'test-team',
    });

    // Should not throw
    await expect(result.cleanup()).resolves.toBeUndefined();
  });

  it('uses custom port from opts.orgMcpPort', async () => {
    const mockClient = {
      tools: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockCreateMCPClient.mockResolvedValue(mockClient);

    const { connectMcpServers } = await importBridge();
    await connectMcpServers({
      configMcpServers: ['org'],
      orgMcpPort: 9999,
      teamName: 'custom-port-team',
    });

    expect(mockCreateMCPClient).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: expect.objectContaining({
          url: 'http://127.0.0.1:9999/mcp',
        }),
      }),
    );
  });
});
