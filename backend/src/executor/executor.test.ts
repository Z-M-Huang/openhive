import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentExecutorImpl } from './executor.js';
import type { AgentInitConfig, EventBus, Logger, BusEvent } from '../domain/index.js';
import { AgentStatus, ProviderType, ModelTier } from '../domain/index.js';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Mock child_process.spawn
// ---------------------------------------------------------------------------

/** Fake ChildProcess with controllable exit behavior. */
class FakeChildProcess extends EventEmitter {
  pid = 12345;
  killed = false;
  lastSignal: string | undefined;
  stdout = new EventEmitter();
  stderr = new EventEmitter();

  kill(signal?: string): boolean {
    this.killed = true;
    this.lastSignal = signal;
    return true;
  }

  /** Simulate the process exiting. */
  simulateExit(code: number | null, signal: string | null): void {
    this.emit('exit', code, signal);
  }
}

let lastSpawnedProcess: FakeChildProcess;
let spawnArgs: { command: string; args: string[]; opts: Record<string, unknown> } | undefined;

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], opts: Record<string, unknown>) => {
    spawnArgs = { command, args, opts };
    lastSpawnedProcess = new FakeChildProcess();
    return lastSpawnedProcess;
  },
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return {
    log: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    audit: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function makeEventBus(): EventBus & { published: BusEvent[] } {
  const published: BusEvent[] = [];
  return {
    published,
    publish: vi.fn((event: BusEvent) => published.push(event)),
    subscribe: vi.fn().mockReturnValue('sub-id'),
    filteredSubscribe: vi.fn().mockReturnValue('sub-id'),
    unsubscribe: vi.fn(),
    close: vi.fn(),
  };
}

const TEST_OAUTH_VALUE = 'test_placeholder_oauth_value';
const TEST_KEY_VALUE = 'test_placeholder_key_value';

function makeAgent(overrides: Partial<AgentInitConfig> = {}): AgentInitConfig {
  return {
    aid: 'aid-test-abc123',
    name: 'test-agent',
    description: 'A test agent',
    role: 'member',
    model: 'claude-sonnet-4-20250514',
    tools: ['send_message', 'escalate'],
    provider: {
      type: ProviderType.OAuth,
      oauthToken: TEST_OAUTH_VALUE,
      models: {
        [ModelTier.Haiku]: 'claude-haiku-4-5-20251001',
        [ModelTier.Sonnet]: 'claude-sonnet-4-20250514',
        [ModelTier.Opus]: 'claude-opus-4-20250514',
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentExecutorImpl', () => {
  let executor: AgentExecutorImpl;
  let logger: Logger;
  let eventBus: ReturnType<typeof makeEventBus>;

  beforeEach(() => {
    spawnArgs = undefined;
    logger = makeLogger();
    eventBus = makeEventBus();
    executor = new AgentExecutorImpl(eventBus, logger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // start()
  // -----------------------------------------------------------------------

  describe('start()', () => {
    it('spawns a child process with correct cwd and env', async () => {
      const agent = makeAgent();
      await executor.start(agent, '/app/workspace');

      expect(spawnArgs).toBeDefined();
      expect(spawnArgs!.command).toBe('node');
      expect(spawnArgs!.args).toEqual(['dist/agent-entry.js']);
      expect(spawnArgs!.opts.cwd).toBe('/app/workspace');
      expect(spawnArgs!.opts.stdio).toBe('pipe');

      const env = spawnArgs!.opts.env as Record<string, string>;
      expect(env['OPENHIVE_AGENT_AID']).toBe('aid-test-abc123');
      expect(env['OPENHIVE_AGENT_NAME']).toBe('test-agent');
      expect(env['OPENHIVE_AGENT_MODEL']).toBe('claude-sonnet-4-20250514');
    });

    it('maps OAuth provider to CLAUDE_CODE_OAUTH_TOKEN env var', async () => {
      const agent = makeAgent();
      await executor.start(agent, '/app/workspace');

      const env = spawnArgs!.opts.env as Record<string, string>;
      expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe(TEST_OAUTH_VALUE);
      expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
      expect(env['ANTHROPIC_BASE_URL']).toBeUndefined();
    });

    it('maps anthropic_direct provider to ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL', async () => {
      const agent = makeAgent({
        provider: {
          type: ProviderType.AnthropicDirect,
          apiKey: TEST_KEY_VALUE,
          baseUrl: 'https://api.example.test',
          models: {
            [ModelTier.Haiku]: 'h',
            [ModelTier.Sonnet]: 's',
            [ModelTier.Opus]: 'o',
          },
        },
      });
      await executor.start(agent, '/app/workspace');

      const env = spawnArgs!.opts.env as Record<string, string>;
      expect(env['ANTHROPIC_API_KEY']).toBe(TEST_KEY_VALUE);
      expect(env['ANTHROPIC_BASE_URL']).toBe('https://api.example.test');
      expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
    });

    it('throws ConflictError if agent is already running', async () => {
      const agent = makeAgent();
      await executor.start(agent, '/app/workspace');

      await expect(executor.start(agent, '/app/workspace')).rejects.toThrow(
        'Agent aid-test-abc123 is already running',
      );
    });

    it('sets initial status to Starting', async () => {
      const agent = makeAgent();
      await executor.start(agent, '/app/workspace');

      expect(executor.getStatus(agent.aid)).toBe(AgentStatus.Starting);
    });
  });

  // -----------------------------------------------------------------------
  // Unexpected exit (agent.crashed)
  // -----------------------------------------------------------------------

  describe('unexpected exit', () => {
    it('publishes agent.crashed event on unexpected exit', async () => {
      const agent = makeAgent();
      await executor.start(agent, '/app/workspace');
      const proc = lastSpawnedProcess;

      proc.simulateExit(1, null);
      await Promise.resolve();

      expect(eventBus.published).toHaveLength(1);
      expect(eventBus.published[0]!.type).toBe('agent.crashed');
      expect(eventBus.published[0]!.data).toEqual(
        expect.objectContaining({ aid: 'aid-test-abc123', exitCode: 1 }),
      );
    });

    it('removes agent from tracking after crash', async () => {
      const agent = makeAgent();
      await executor.start(agent, '/app/workspace');
      const proc = lastSpawnedProcess;

      proc.simulateExit(1, null);
      await Promise.resolve();

      expect(executor.isRunning(agent.aid)).toBe(false);
      expect(executor.getStatus(agent.aid)).toBeUndefined();
    });

    it('logs error on crash', async () => {
      const agent = makeAgent();
      await executor.start(agent, '/app/workspace');
      const proc = lastSpawnedProcess;

      proc.simulateExit(null, 'SIGSEGV');
      await Promise.resolve();

      expect(logger.error).toHaveBeenCalledWith(
        'Agent process crashed',
        expect.objectContaining({ aid: 'aid-test-abc123', signal: 'SIGSEGV' }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // stop()
  // -----------------------------------------------------------------------

  describe('stop()', () => {
    it('sends SIGTERM to the agent process', async () => {
      const agent = makeAgent();
      await executor.start(agent, '/app/workspace');
      const proc = lastSpawnedProcess;

      const killSpy = vi.spyOn(proc, 'kill').mockImplementation((signal) => {
        if (signal === 'SIGTERM') {
          setTimeout(() => proc.simulateExit(0, 'SIGTERM'), 5);
        }
        return true;
      });

      await executor.stop(agent.aid, 5000);

      expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    });

    it('sends SIGKILL after timeout if process does not exit', async () => {
      vi.useFakeTimers();
      const agent = makeAgent();
      await executor.start(agent, '/app/workspace');
      const proc = lastSpawnedProcess;

      const killSpy = vi.spyOn(proc, 'kill').mockImplementation((signal) => {
        if (signal === 'SIGKILL') {
          proc.simulateExit(null, 'SIGKILL');
        }
        return true;
      });

      const stopPromise = executor.stop(agent.aid, 1000);

      await vi.advanceTimersByTimeAsync(1000);

      await stopPromise;

      expect(killSpy).toHaveBeenCalledWith('SIGTERM');
      expect(killSpy).toHaveBeenCalledWith('SIGKILL');

      vi.useRealTimers();
    });

    it('throws NotFoundError if agent is not running', async () => {
      await expect(executor.stop('aid-nonexistent-abc')).rejects.toThrow(
        'Agent aid-nonexistent-abc is not running',
      );
    });

    it('removes agent from tracking', async () => {
      const agent = makeAgent();
      await executor.start(agent, '/app/workspace');
      const proc = lastSpawnedProcess;

      vi.spyOn(proc, 'kill').mockImplementation((signal) => {
        if (signal === 'SIGTERM') {
          setTimeout(() => proc.simulateExit(0, 'SIGTERM'), 1);
        }
        return true;
      });

      await executor.stop(agent.aid, 5000);

      expect(executor.isRunning(agent.aid)).toBe(false);
    });

    it('does not publish agent.crashed on graceful stop', async () => {
      const agent = makeAgent();
      await executor.start(agent, '/app/workspace');
      const proc = lastSpawnedProcess;

      vi.spyOn(proc, 'kill').mockImplementation((signal) => {
        if (signal === 'SIGTERM') {
          setTimeout(() => proc.simulateExit(0, 'SIGTERM'), 1);
        }
        return true;
      });

      await executor.stop(agent.aid, 5000);

      expect(eventBus.published).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // kill()
  // -----------------------------------------------------------------------

  describe('kill()', () => {
    it('sends SIGKILL immediately', async () => {
      const agent = makeAgent();
      await executor.start(agent, '/app/workspace');
      const proc = lastSpawnedProcess;
      const killSpy = vi.spyOn(proc, 'kill');

      executor.kill(agent.aid);

      expect(killSpy).toHaveBeenCalledWith('SIGKILL');
    });

    it('throws NotFoundError if agent is not running', () => {
      expect(() => executor.kill('aid-nonexistent-abc')).toThrow(
        'Agent aid-nonexistent-abc is not running',
      );
    });

    it('removes agent from tracking', async () => {
      const agent = makeAgent();
      await executor.start(agent, '/app/workspace');

      executor.kill(agent.aid);

      expect(executor.isRunning(agent.aid)).toBe(false);
      expect(executor.getStatus(agent.aid)).toBeUndefined();
    });

    it('does not publish agent.crashed on kill', async () => {
      const agent = makeAgent();
      await executor.start(agent, '/app/workspace');

      executor.kill(agent.aid);
      await Promise.resolve();
      await Promise.resolve();

      expect(eventBus.published).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // isRunning() / getStatus()
  // -----------------------------------------------------------------------

  describe('isRunning()', () => {
    it('returns true for running agent', async () => {
      const agent = makeAgent();
      await executor.start(agent, '/app/workspace');

      expect(executor.isRunning(agent.aid)).toBe(true);
    });

    it('returns false for unknown agent', () => {
      expect(executor.isRunning('aid-unknown-abc')).toBe(false);
    });
  });

  describe('getStatus()', () => {
    it('returns Starting for newly spawned agent', async () => {
      const agent = makeAgent();
      await executor.start(agent, '/app/workspace');

      expect(executor.getStatus(agent.aid)).toBe(AgentStatus.Starting);
    });

    it('returns undefined for unknown agent', () => {
      expect(executor.getStatus('aid-unknown-abc')).toBeUndefined();
    });
  });
});
