/**
 * Layer 6 Phase Gate -- Sessions
 *
 * Tests:
 * - UT-8:  canUseTool blocks/allows exact, prefix, Bash default deny
 * - UT-9:  MCP builder includes only listed servers, skips unknown
 * - UT-18: Provider resolver maps api/oauth profiles, throws on missing
 * - UT-7:  Context builder + query options assembler
 * - Session manager: tracks active, stop removes, idle timeout
 * - E2E-6/E2E-11 simulation: full flow with mocked query
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';

import { createCanUseTool } from '../sessions/can-use-tool.js';
import { buildMcpServers } from '../sessions/mcp-builder.js';
import { resolveProvider } from '../sessions/provider-resolver.js';
import { buildSessionContext } from '../sessions/context-builder.js';
import { buildQueryOptions } from '../sessions/query-options.js';
import { spawnSession } from '../sessions/spawner.js';
import { SessionManager } from '../sessions/manager.js';
import { ConfigError } from '../domain/errors.js';
import type { ProvidersOutput } from '../config/validation.js';
import type { TeamConfig } from '../domain/types.js';
import type { QueryFn, SdkMessage } from '../sessions/spawner.js';
import type { BuildQueryOptionsInput } from '../sessions/query-options.js';

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
    scope: { accepts: ['weather'], rejects: ['admin'] },
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

// ── UT-8: canUseTool ──────────────────────────────────────────────────────

describe('UT-8: canUseTool', () => {
  it('allows exact match', () => {
    const check = createCanUseTool(['Read', 'Write']);
    expect(check('Read').allowed).toBe(true);
    expect(check('Write').allowed).toBe(true);
  });

  it('denies unlisted tools', () => {
    const check = createCanUseTool(['Read']);
    expect(check('Edit').allowed).toBe(false);
    expect(check('Grep').allowed).toBe(false);
  });

  it('allows prefix match with star', () => {
    const check = createCanUseTool(['mcp__org__*']);
    expect(check('mcp__org__escalate').allowed).toBe(true);
    expect(check('mcp__org__spawn_team').allowed).toBe(true);
    expect(check('mcp__other__tool').allowed).toBe(false);
  });

  it('denies Bash by default', () => {
    const check = createCanUseTool(['Read', 'Write', 'Edit']);
    expect(check('Bash').allowed).toBe(false);
  });

  it('allows Bash if explicitly listed', () => {
    const check = createCanUseTool(['Read', 'Bash']);
    expect(check('Bash').allowed).toBe(true);
  });

  it('logs denied attempts', () => {
    const log = captureLog();
    const check = createCanUseTool(['Read'], log.logger);
    check('Bash');
    expect(log.messages).toHaveLength(1);
    expect(log.messages[0].msg).toContain('denied');
    expect(log.messages[0].meta).toEqual({ tool: 'Bash' });
  });

  it('handles empty allowedTools (deny all)', () => {
    const check = createCanUseTool([]);
    expect(check('Read').allowed).toBe(false);
    expect(check('Bash').allowed).toBe(false);
  });

  it('mixed exact and prefix entries', () => {
    const check = createCanUseTool(['Read', 'mcp__org__*', 'Bash']);
    expect(check('Read').allowed).toBe(true);
    expect(check('Bash').allowed).toBe(true);
    expect(check('mcp__org__escalate').allowed).toBe(true);
    expect(check('Write').allowed).toBe(false);
  });
});

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

// ── UT-18: Provider Resolver ──────────────────────────────────────────────

describe('UT-18: Provider Resolver', () => {
  it('maps api profile correctly', () => {
    const providers = makeProviders();
    const resolved = resolveProvider('default', providers);

    expect(resolved.model).toBe('claude-sonnet-4-20250514');
    expect(resolved.env).toEqual({ ANTHROPIC_API_KEY: TEST_KEY_VALUE });
  });

  it('includes ANTHROPIC_BASE_URL when api_url is set', () => {
    const providers = makeProviders({
      profiles: {
        custom: {
          type: 'api',
          api_key: TEST_KEY_VALUE,
          model: 'claude-haiku-2',
          api_url: 'https://custom.api.example.com',
        },
      },
    });
    const resolved = resolveProvider('custom', providers);

    expect(resolved.env['ANTHROPIC_BASE_URL']).toBe('https://custom.api.example.com');
    expect(resolved.env['ANTHROPIC_API_KEY']).toBe(TEST_KEY_VALUE);
    expect(resolved.model).toBe('claude-haiku-2');
  });

  it('maps oauth profile correctly', () => {
    const original = process.env['MY_OAUTH_TOKEN'];
    try {
      process.env['MY_OAUTH_TOKEN'] = 'oauth-test-placeholder';
      const providers = makeProviders();
      const resolved = resolveProvider('oauth', providers);

      expect(resolved.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test-placeholder' });
    } finally {
      if (original === undefined) {
        delete process.env['MY_OAUTH_TOKEN'];
      } else {
        process.env['MY_OAUTH_TOKEN'] = original;
      }
    }
  });

  it('throws ConfigError on missing profile', () => {
    const providers = makeProviders();

    expect(() => resolveProvider('nonexistent', providers)).toThrow(ConfigError);
    expect(() => resolveProvider('nonexistent', providers)).toThrow('not found');
  });

  it('throws ConfigError when oauth env var not set', () => {
    const original = process.env['MY_OAUTH_TOKEN'];
    try {
      delete process.env['MY_OAUTH_TOKEN'];
      const providers = makeProviders();

      expect(() => resolveProvider('oauth', providers)).toThrow(ConfigError);
      expect(() => resolveProvider('oauth', providers)).toThrow('not set');
    } finally {
      if (original !== undefined) {
        process.env['MY_OAUTH_TOKEN'] = original;
      }
    }
  });
});

// ── UT-7: Context Builder ─────────────────────────────────────────────────

describe('UT-7: Context Builder', () => {
  it('produces correct cwd', () => {
    const ctx = buildSessionContext('weather-team', '/run');
    expect(ctx.cwd).toBe(join('/run', 'teams', 'weather-team', 'workspace'));
  });

  it('produces correct additionalDirectories', () => {
    const ctx = buildSessionContext('weather-team', '/run');
    const expected = [
      join('/run', 'teams', 'weather-team', 'memory'),
      join('/run', 'teams', 'weather-team', 'org-rules'),
      join('/run', 'teams', 'weather-team', 'team-rules'),
      join('/run', 'teams', 'weather-team', 'skills'),
      join('/run', 'teams', 'weather-team', 'subagents'),
    ];
    expect(ctx.additionalDirectories).toEqual(expected);
  });
});

// ── UT-7: Query Options Assembler ─────────────────────────────────────────

describe('UT-7: Query Options Assembler', () => {
  it('produces correct structure with all fields', () => {
    const log = captureLog();

    const input: BuildQueryOptionsInput = {
      teamName: 'weather-team',
      teamConfig: makeTeamConfig(),
      runDir: '/run',
      dataDir: '/data',
      systemRulesDir: '/app/system-rules',
      providers: makeProviders(),
      orgMcpServer: { sdkServer: { url: 'http://org:3000' } },
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

    // MCP servers (org from orgMcpServer, not analytics since not in mcp_servers)
    expect(opts.mcpServers['org']).toEqual({ url: 'http://org:3000' });
    expect(opts.mcpServers['analytics']).toBeUndefined();

    // canUseTool
    expect(opts.canUseTool('Read').allowed).toBe(true);
    expect(opts.canUseTool('Bash').allowed).toBe(false);
    expect(opts.canUseTool('mcp__org__escalate').allowed).toBe(true);

    // Hooks
    expect(opts.hooks.PreToolUse.length).toBeGreaterThan(0);
    expect(opts.hooks.PostToolUse.length).toBeGreaterThan(0);

    // stderr scrubber
    expect(typeof opts.stderr).toBe('function');
    const scrubbed = opts.stderr('leaked ' + TEST_KEY_VALUE + ' here');
    expect(scrubbed).not.toContain(TEST_KEY_VALUE);

    // env (provider env only — no merged secrets)
    expect(opts.env['ANTHROPIC_API_KEY']).toBe(TEST_KEY_VALUE);

    // cwd
    expect(opts.cwd).toBe(join('/run', 'teams', 'weather-team', 'workspace'));

    // additionalDirectories
    expect(opts.additionalDirectories.length).toBe(5);
  });
});

// ── Session Manager ───────────────────────────────────────────────────────

describe('Session Manager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new SessionManager({ idleTimeoutMs: 5000 });
  });

  afterEach(() => {
    manager.stopAll();
    vi.useRealTimers();
  });

  it('spawn tracks active session', () => {
    manager.spawn('team-a');
    expect(manager.isActive('team-a')).toBe(true);
    expect(manager.getActive()).toEqual(['team-a']);
  });

  it('stop removes session', () => {
    manager.spawn('team-a');
    manager.stop('team-a');
    expect(manager.isActive('team-a')).toBe(false);
    expect(manager.getActive()).toEqual([]);
  });

  it('stop on non-existent team is a no-op', () => {
    expect(() => manager.stop('ghost')).not.toThrow();
  });

  it('spawn returns abort controller', () => {
    const ac = manager.spawn('team-a');
    expect(ac).toBeInstanceOf(AbortController);
    expect(ac.signal.aborted).toBe(false);
  });

  it('stop aborts the controller', () => {
    const ac = manager.spawn('team-a');
    manager.stop('team-a');
    expect(ac.signal.aborted).toBe(true);
  });

  it('idle timeout triggers stop', () => {
    const ac = manager.spawn('team-a');
    expect(manager.isActive('team-a')).toBe(true);

    vi.advanceTimersByTime(5000);

    expect(manager.isActive('team-a')).toBe(false);
    expect(ac.signal.aborted).toBe(true);
  });

  it('touch resets idle timeout', () => {
    manager.spawn('team-a');

    vi.advanceTimersByTime(3000);
    manager.touch('team-a');
    vi.advanceTimersByTime(3000);

    // Should still be active (3s + touch + 3s < 5s from touch)
    expect(manager.isActive('team-a')).toBe(true);

    vi.advanceTimersByTime(2000);

    // Now 5s since touch, should be timed out
    expect(manager.isActive('team-a')).toBe(false);
  });

  it('getStatus returns active with uptime', () => {
    manager.spawn('team-a');
    vi.advanceTimersByTime(1000);

    const status = manager.getStatus('team-a');
    expect(status.active).toBe(true);
    expect(status.uptimeMs).toBe(1000);
  });

  it('getStatus returns inactive for unknown team', () => {
    const status = manager.getStatus('ghost');
    expect(status.active).toBe(false);
    expect(status.uptimeMs).toBe(0);
  });

  it('spawn replaces existing session for same team', () => {
    const ac1 = manager.spawn('team-a');
    const ac2 = manager.spawn('team-a');

    expect(ac1.signal.aborted).toBe(true);
    expect(ac2.signal.aborted).toBe(false);
    expect(manager.getActive()).toEqual(['team-a']);
  });

  it('stopAll clears everything', () => {
    manager.spawn('team-a');
    manager.spawn('team-b');
    manager.stopAll();

    expect(manager.getActive()).toEqual([]);
    expect(manager.isActive('team-a')).toBe(false);
    expect(manager.isActive('team-b')).toBe(false);
  });

  it('uses default 30min timeout when not configured', () => {
    const defaultManager = new SessionManager();
    defaultManager.spawn('team-x');

    vi.advanceTimersByTime(29 * 60 * 1000);
    expect(defaultManager.isActive('team-x')).toBe(true);

    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(defaultManager.isActive('team-x')).toBe(false);

    defaultManager.stopAll();
  });
});

// ── Session Spawner ───────────────────────────────────────────────────────

describe('Session Spawner', () => {
  it('collects all messages from query iterator', async () => {
    const messages: SdkMessage[] = [
      { type: 'text', content: 'Hello' },
      { type: 'tool_use', content: { tool: 'Read' } },
      { type: 'text', content: 'Done' },
    ];

    const queryFn: QueryFn = async function* () {
      for (const msg of messages) {
        yield msg;
      }
    };

    const opts: Record<string, unknown> = { maxTurns: 10 };
    const result = await spawnSession('do something', opts, queryFn);

    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toEqual({ type: 'text', content: 'Hello' });
    expect(result.messages[2]).toEqual({ type: 'text', content: 'Done' });
  });

  it('handles empty iterator', async () => {
    const queryFn: QueryFn = async function* () {
      // yields nothing
    };

    const opts: Record<string, unknown> = { maxTurns: 10 };
    const result = await spawnSession('empty', opts, queryFn);

    expect(result.messages).toHaveLength(0);
  });
});

// ── E2E-6/E2E-11 Simulation: Full Flow ───────────────────────────────────

describe('E2E-6/E2E-11: Full session flow simulation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('assembles options, spawns session, tracks in manager', async () => {
    vi.useFakeTimers();
    const log = captureLog();

    // 1. Build query options
    const input: BuildQueryOptionsInput = {
      teamName: 'weather-team',
      teamConfig: makeTeamConfig(),
      runDir: '/run',
      dataDir: '/data',
      systemRulesDir: '/app/system-rules',
      providers: makeProviders(),
      orgMcpServer: { sdkServer: { url: 'http://org:3000' } },
      availableMcpServers: {},
      ancestors: [],
      logger: log.logger,
    };

    const queryOpts = buildQueryOptions(input);

    // 2. Create session manager and register session
    const manager = new SessionManager({ idleTimeoutMs: 10_000 });
    const ac = manager.spawn('weather-team');
    expect(manager.isActive('weather-team')).toBe(true);

    // 3. Mock query function that returns messages
    const mockMessages: SdkMessage[] = [
      { type: 'text', content: 'Checking weather...' },
      { type: 'tool_use', content: { tool: 'mcp__org__escalate' } },
      { type: 'text', content: 'Weather report complete' },
    ];

    const queryFn: QueryFn = async function* () {
      for (const msg of mockMessages) {
        yield msg;
      }
    };

    // 4. Spawn the session (simulated SDK call)
    const result = await spawnSession('get weather for NYC', queryOpts, queryFn);

    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].type).toBe('text');

    // 5. Verify canUseTool works with assembled options
    expect(queryOpts.canUseTool('Read').allowed).toBe(true);
    expect(queryOpts.canUseTool('Bash').allowed).toBe(false);
    expect(queryOpts.canUseTool('mcp__org__escalate').allowed).toBe(true);

    // 6. Verify stderr scrubber works
    const scrubbed = queryOpts.stderr('Error: ' + TEST_KEY_VALUE + ' leaked');
    expect(scrubbed).not.toContain(TEST_KEY_VALUE);

    // 7. Stop session and verify cleanup
    manager.stop('weather-team');
    expect(manager.isActive('weather-team')).toBe(false);
    expect(ac.signal.aborted).toBe(true);

    manager.stopAll();
  });

  it('provider error prevents session from starting', () => {
    const log = captureLog();

    const input: BuildQueryOptionsInput = {
      teamName: 'broken-team',
      teamConfig: makeTeamConfig({ provider_profile: 'nonexistent' }),
      runDir: '/run',
      dataDir: '/data',
      systemRulesDir: '/app/system-rules',
      providers: makeProviders(),
      orgMcpServer: {},
      availableMcpServers: {},
      ancestors: [],
      logger: log.logger,
    };

    expect(() => buildQueryOptions(input)).toThrow(ConfigError);
  });
});

// ── Skill and Subagent Loader ────────────────────────────────────────────

import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { loadSkillsContent, loadSubagents } from '../sessions/skill-loader.js';
import { buildMemorySection } from '../sessions/memory-loader.js';
import { MemoryStore } from '../storage/stores/memory-store.js';

describe('Skill and Subagent Loader', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openhive-l6-skills-'));
    mkdirSync(join(dir, 'teams', 'test-team', 'skills'), { recursive: true });
    mkdirSync(join(dir, 'teams', 'test-team', 'subagents'), { recursive: true });
  });

  it('returns empty string when skills/ is empty', () => {
    expect(loadSkillsContent(dir, 'test-team')).toBe('');
  });

  it('returns concatenated content with header when skills/ has .md files', () => {
    writeFileSync(join(dir, 'teams', 'test-team', 'skills', 'deploy.md'), '# Deploy\nStep 1');
    writeFileSync(join(dir, 'teams', 'test-team', 'skills', 'review.md'), '# Review\nStep A');
    const result = loadSkillsContent(dir, 'test-team');
    expect(result).toContain('--- Skills ---');
    expect(result).toContain('# Deploy');
    expect(result).toContain('# Review');
  });

  it('returns empty array when subagents/ is empty', () => {
    expect(loadSubagents(dir, 'test-team')).toHaveLength(0);
  });

  it('parses subagent .md format', () => {
    const content = '# Agent: Devops\n## Role\nHandles deployments\n## Skills\n- deploy — run deploys\n- rollback — undo deploys\n';
    writeFileSync(join(dir, 'teams', 'test-team', 'subagents', 'devops.md'), content);
    const agents = loadSubagents(dir, 'test-team');
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('Devops');
    expect(agents[0].description).toBe('Handles deployments');
    expect(agents[0].skills).toEqual(['deploy', 'rollback']);
  });
});

// ── Memory Loader ────────────────────────────────────────────────────────

describe('Memory Loader', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openhive-l6-mem-'));
    // MemoryStore baseDir = .run/teams/, so files go to {baseDir}/{team}/memory/{file}
    store = new MemoryStore(dir);
    // Create the memory directory for the test team
    mkdirSync(join(dir, 'test-team', 'memory'), { recursive: true });
  });

  it('returns empty string when no MEMORY.md exists', () => {
    expect(buildMemorySection(store, 'test-team')).toBe('');
  });

  it('injects MEMORY.md content with header', () => {
    store.writeFile('test-team', 'MEMORY.md', '# Memory Index\nTeam context here');
    const result = buildMemorySection(store, 'test-team');
    expect(result).toContain('--- Team Memory ---');
    expect(result).toContain('# Memory Index');
  });

  it('does NOT inject other memory files (no fallbacks)', () => {
    store.writeFile('test-team', 'context.md', 'This should NOT appear');
    store.writeFile('test-team', 'decisions.md', 'This too');
    const result = buildMemorySection(store, 'test-team');
    expect(result).toBe(''); // Only MEMORY.md is injected
  });

  it('handles corrupt/unreadable MEMORY.md gracefully', () => {
    const badStore = {
      readFile: () => { throw new Error('permission denied'); },
      writeFile: store.writeFile.bind(store),
      listFiles: store.listFiles.bind(store),
    };
    const result = buildMemorySection(badStore, 'test-team');
    expect(result).toBe('');
  });

  it('skips empty/whitespace MEMORY.md', () => {
    store.writeFile('test-team', 'MEMORY.md', '   ');
    const result = buildMemorySection(store, 'test-team');
    expect(result).toBe('');
  });
});
