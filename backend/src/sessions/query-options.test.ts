/**
 * UT-7: AI Session Config Assembler
 *
 * Tests: buildAiSessionConfig produces correct structure with all fields
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

import { buildAiSessionConfig } from './query-options.js';
import type { BuildAiSessionConfigInput } from './query-options.js';
import type { ProvidersOutput } from '../config/validation.js';
import type { TeamConfig } from '../domain/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Test-only placeholder. Not a real key. */
const TEST_KEY_VALUE = 'test-placeholder-key-not-real';

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

// ── UT-7: AI Session Config Assembler ─────────────────────────────────────

describe('UT-7: AI Session Config Assembler', () => {
  it('produces correct structure with all fields', () => {
    const log = captureLog();

    const input: BuildAiSessionConfigInput = {
      teamName: 'weather-team',
      teamConfig: makeTeamConfig(),
      runDir: '/run',
      dataDir: '/data',
      systemRulesDir: '/app/system-rules',
      providers: makeProviders(),
      orgMcpPort: 3001,
      ancestors: ['root-team'],
      logger: log.logger,
    };

    const config = buildAiSessionConfig(input);

    // Profile name from team config
    expect(config.profileName).toBe('default');

    // Model resolved from provider profile
    expect(config.modelId).toBe('claude-sonnet-4-20250514');

    // Context window
    expect(config.contextWindow).toBe(200_000);

    // Team name
    expect(config.teamName).toBe('weather-team');

    // maxTurns from team config
    expect(config.maxTurns).toBe(25);

    // cwd
    expect(config.cwd).toBe(join('/run', 'teams', 'weather-team'));

    // additionalDirs
    expect(config.additionalDirs).toEqual([]);

    // Allowed tools preserved from config
    expect(config.allowedTools).toEqual(['Read', 'Write', 'Edit', 'mcp__org__*']);

    // MCP servers
    expect(config.mcpServers).toEqual(['org']);

    // Governance paths
    expect(config.governancePaths.systemRulesDir).toBe('/app/system-rules');
    expect(config.governancePaths.dataDir).toBe('/data');
    expect(config.governancePaths.runDir).toBe('/run');

    // Rule cascade is a string
    expect(typeof config.ruleCascade).toBe('string');

    // Skills content is a string
    expect(typeof config.skillsContent).toBe('string');

    // Memory section is a string
    expect(typeof config.memorySection).toBe('string');

    // Known secrets (SecretString instances)
    expect(config.knownSecrets).toHaveLength(1);
    expect(config.knownSecrets[0].expose()).toBe(TEST_KEY_VALUE);

    // Org MCP port
    expect(config.orgMcpPort).toBe(3001);
  });

  it('credentials are extracted for scrubbing', () => {
    const log = captureLog();
    const credValue = 'my-long-secret-value';
    const input: BuildAiSessionConfigInput = {
      teamName: 'cred-team',
      teamConfig: makeTeamConfig({
        credentials: {
          API_KEY: credValue,
          SHORT: 'abc',
        },
      }),
      runDir: '/run',
      dataDir: '/data',
      systemRulesDir: '/app/system-rules',
      providers: makeProviders(),
      ancestors: [],
      logger: log.logger,
    };

    const config = buildAiSessionConfig(input);

    // Credential keys
    expect(config.credentialKeys).toEqual(['API_KEY', 'SHORT']);

    // Raw secret values only includes long values (>= 8 chars)
    expect(config.rawSecretValues).toEqual([credValue]);

    // Credentials map is passed through
    expect(config.credentials['API_KEY']).toBe(credValue);
    expect(config.credentials['SHORT']).toBe('abc');
  });

  it('context window uses provider profile value when set', () => {
    const log = captureLog();
    const input: BuildAiSessionConfigInput = {
      teamName: 'ctx-team',
      teamConfig: makeTeamConfig(),
      runDir: '/run',
      dataDir: '/data',
      systemRulesDir: '/app/system-rules',
      providers: makeProviders({
        profiles: {
          default: {
            type: 'api',
            api_key: TEST_KEY_VALUE,
            model: 'claude-sonnet-4-20250514',
            context_window: 128_000,
          },
        },
      }),
      ancestors: [],
      logger: log.logger,
    };

    const config = buildAiSessionConfig(input);
    expect(config.contextWindow).toBe(128_000);
  });

  it('orgMcpPort defaults to 3001 when not provided', () => {
    const log = captureLog();
    const input: BuildAiSessionConfigInput = {
      teamName: 'port-team',
      teamConfig: makeTeamConfig(),
      runDir: '/run',
      dataDir: '/data',
      systemRulesDir: '/app/system-rules',
      providers: makeProviders(),
      ancestors: [],
      logger: log.logger,
    };

    const config = buildAiSessionConfig(input);
    expect(config.orgMcpPort).toBe(3001);
  });

  it('sourceChannelId is passed through', () => {
    const log = captureLog();
    const input: BuildAiSessionConfigInput = {
      teamName: 'chan-team',
      teamConfig: makeTeamConfig(),
      runDir: '/run',
      dataDir: '/data',
      systemRulesDir: '/app/system-rules',
      providers: makeProviders(),
      ancestors: [],
      logger: log.logger,
      sourceChannelId: 'discord:1234',
    };

    const config = buildAiSessionConfig(input);
    expect(config.sourceChannelId).toBe('discord:1234');
  });
});
