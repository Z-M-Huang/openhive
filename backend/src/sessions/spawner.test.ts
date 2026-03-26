/**
 * Session Spawner + E2E-6/E2E-11 Simulation
 *
 * Tests:
 * - Session spawner collects messages, handles progress updates
 * - E2E simulation: full session flow with mocked query
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { spawnSession } from './spawner.js';
import { buildQueryOptions } from './query-options.js';
import { TeamRegistry } from './team-registry.js';
import { ConfigError } from '../domain/errors.js';
import type { ProvidersOutput } from '../config/validation.js';
import type { TeamConfig } from '../domain/types.js';
import type { QueryFn, SdkMessage, ProgressUpdate } from './spawner.js';
import type { BuildQueryOptionsInput } from './query-options.js';

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

  it('calls onProgress with assistant_text for first assistant message', async () => {
    const updates: ProgressUpdate[] = [];
    const messages: SdkMessage[] = [
      { type: 'assistant', content: undefined } as SdkMessage,
      { type: 'text', content: 'Done' },
    ];
    // Inject SDK-shape assistant message with msg.message.content[]
    (messages[0] as unknown as Record<string, unknown>)['message'] = {
      content: [{ type: 'text', text: 'Got it, working on it...' }],
    };

    const queryFn: QueryFn = async function* () {
      for (const msg of messages) yield msg;
    };

    await spawnSession('test', {}, queryFn, (u) => updates.push(u));

    expect(updates).toHaveLength(1);
    expect(updates[0]!.kind).toBe('assistant_text');
    expect(updates[0]!.content).toBe('Got it, working on it...');
  });

  it('emits tool_active for tool_progress messages', async () => {
    const updates: ProgressUpdate[] = [];
    const messages: SdkMessage[] = [
      { type: 'tool_progress' } as SdkMessage,
    ];
    (messages[0] as unknown as Record<string, unknown>)['tool_name'] = 'Read';
    (messages[0] as unknown as Record<string, unknown>)['elapsed_time_seconds'] = 5;

    const queryFn: QueryFn = async function* () {
      for (const msg of messages) yield msg;
    };

    await spawnSession('test', {}, queryFn, (u) => updates.push(u));

    expect(updates).toHaveLength(1);
    expect(updates[0]!.kind).toBe('tool_active');
    expect(updates[0]!.content).toBe('Working with Read (5s)');
  });

  it('emits tool_summary for tool_use_summary messages', async () => {
    const updates: ProgressUpdate[] = [];
    const messages: SdkMessage[] = [
      { type: 'tool_use_summary' } as SdkMessage,
    ];
    (messages[0] as unknown as Record<string, unknown>)['summary'] = 'Read 3 files';

    const queryFn: QueryFn = async function* () {
      for (const msg of messages) yield msg;
    };

    await spawnSession('test', {}, queryFn, (u) => updates.push(u));

    expect(updates).toHaveLength(1);
    expect(updates[0]!.kind).toBe('tool_summary');
    expect(updates[0]!.content).toBe('Read 3 files');
  });

  it('only emits assistant_text for the first assistant message', async () => {
    const updates: ProgressUpdate[] = [];
    const msg1: SdkMessage = { type: 'assistant', content: undefined };
    (msg1 as unknown as Record<string, unknown>)['message'] = { content: [{ type: 'text', text: 'First' }] };
    const msg2: SdkMessage = { type: 'assistant', content: undefined };
    (msg2 as unknown as Record<string, unknown>)['message'] = { content: [{ type: 'text', text: 'Second' }] };

    const queryFn: QueryFn = async function* () {
      yield msg1;
      yield msg2;
    };

    await spawnSession('test', {}, queryFn, (u) => updates.push(u));

    const assistantUpdates = updates.filter(u => u.kind === 'assistant_text');
    expect(assistantUpdates).toHaveLength(1);
    expect(assistantUpdates[0]!.content).toBe('First');
  });

  it('does not call onProgress when callback not provided', async () => {
    const messages: SdkMessage[] = [
      { type: 'assistant', content: undefined } as SdkMessage,
    ];
    (messages[0] as unknown as Record<string, unknown>)['message'] = {
      content: [{ type: 'text', text: 'test' }],
    };

    const queryFn: QueryFn = async function* () {
      for (const msg of messages) yield msg;
    };

    // No callback — should not throw
    const result = await spawnSession('test', {}, queryFn);
    expect(result.messages).toHaveLength(1);
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
      orgMcpPort: 3001,
      availableMcpServers: {},
      ancestors: [],
      logger: log.logger,
    };

    const queryOpts = buildQueryOptions(input);

    // 2. Create session manager and register session
    const manager = new TeamRegistry({ idleTimeoutMs: 10_000 });
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
    expect((await queryOpts.canUseTool('Read', {}, canUseToolOpts)).behavior).toBe('allow');
    expect((await queryOpts.canUseTool('Bash', {}, canUseToolOpts)).behavior).toBe('deny');
    expect((await queryOpts.canUseTool('mcp__org__escalate', {}, canUseToolOpts)).behavior).toBe('allow');

    // 6. Verify stderr scrubber works (returns void — just verify no throw)
    queryOpts.stderr('Error: ' + TEST_KEY_VALUE + ' leaked');

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
      orgMcpPort: 3001,
      availableMcpServers: {},
      ancestors: [],
      logger: log.logger,
    };

    expect(() => buildQueryOptions(input)).toThrow(ConfigError);
  });
});
