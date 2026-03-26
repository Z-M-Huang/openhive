/**
 * UT-7: Query Options Assembler
 *
 * Tests: Query options assembler produces correct structure with all fields
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

import { buildQueryOptions } from './query-options.js';
import type { BuildQueryOptionsInput } from './query-options.js';
import type { ProvidersOutput } from '../config/validation.js';
import type { TeamConfig } from '../domain/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Test-only placeholder. Not a real key. */
const TEST_KEY_VALUE = 'test-placeholder-key-not-real';

const canUseToolOpts = { signal: new AbortController().signal, toolUseID: 'test-tu' };

function makeProviders(overrides?: Partial<ProvidersOutput>): ProvidersOutput {
  return {
    profiles: {
      default: {
        type: 'api',
        api_key: TEST_KEY_VALUE,
        model: 'claude-sonnet-4-20250514',
      },
      oauth: {
        type: 'oauth',
        oauth_token_env: 'MY_OAUTH_TOKEN',
      },
    },
    ...overrides,
  };
}

function makeTeamConfig(overrides?: Partial<TeamConfig>): TeamConfig {
  return {
    name: 'test-team',
    parent: null,
    description: 'A test team',
    allowed_tools: ['Read', 'Write', 'Edit', 'mcp__org__*'],
    mcp_servers: ['org'],
    provider_profile: 'default',
    maxTurns: 25,
    ...overrides,
  };
}

function captureLog(): { messages: Array<{ msg: string; meta?: Record<string, unknown> }>; logger: { info: (msg: string, meta?: Record<string, unknown>) => void } } {
  const messages: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  return {
    messages,
    logger: { info: (msg: string, meta?: Record<string, unknown>) => { messages.push({ msg, meta }); } },
  };
}

// ── UT-7: Query Options Assembler ─────────────────────────────────────────

describe('UT-7: Query Options Assembler', () => {
  it('produces correct structure with all fields', async () => {
    const log = captureLog();

    const input: BuildQueryOptionsInput = {
      teamName: 'weather-team',
      teamConfig: makeTeamConfig(),
      runDir: '/run',
      dataDir: '/data',
      systemRulesDir: '/app/system-rules',
      providers: makeProviders(),
      orgMcpPort: 3001,
      availableMcpServers: { analytics: { url: 'http://analytics:3001' } },
      ancestors: ['root-team'],
      logger: log.logger,
    };

    const opts = buildQueryOptions(input);

    // System prompt
    expect(opts.systemPrompt.type).toBe('preset');
    expect(opts.systemPrompt.preset).toBe('claude_code');
    expect(typeof opts.systemPrompt.append).toBe('string');

    // Tools
    expect(opts.tools).toEqual({ type: 'preset', preset: 'claude_code' });

    // Model from provider
    expect(opts.model).toBe('claude-sonnet-4-20250514');

    // Permissions
    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts.allowDangerouslySkipPermissions).toBe(true);

    // maxTurns
    expect(opts.maxTurns).toBe(25);

    // MCP servers (org via HTTP config on localhost:3001)
    expect(opts.mcpServers['org']).toEqual({ type: 'http', url: 'http://127.0.0.1:3001/mcp', headers: { 'X-Caller-Id': 'weather-team' } });
    expect(opts.mcpServers['analytics']).toBeUndefined();

    // canUseTool
    expect((await opts.canUseTool('Read', {}, canUseToolOpts)).behavior).toBe('allow');
    expect((await opts.canUseTool('Bash', {}, canUseToolOpts)).behavior).toBe('deny');
    expect((await opts.canUseTool('mcp__org__escalate', {}, canUseToolOpts)).behavior).toBe('allow');

    // Hooks
    expect(opts.hooks.PreToolUse.length).toBeGreaterThan(0);
    expect(opts.hooks.PostToolUse.length).toBeGreaterThan(0);

    // stderr scrubber (returns void — just verify it doesn't throw)
    expect(typeof opts.stderr).toBe('function');
    opts.stderr('leaked ' + TEST_KEY_VALUE + ' here');

    // env (provider env only — no merged secrets)
    expect(opts.env['ANTHROPIC_API_KEY']).toBe(TEST_KEY_VALUE);

    // cwd
    expect(opts.cwd).toBe(join('/run', 'teams', 'weather-team'));

    // additionalDirectories
    expect(opts.additionalDirectories).toEqual([]);
  });
});
