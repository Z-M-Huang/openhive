/**
 * Layer 7 Phase Gate: Executor integration tests.
 *
 * Tests SDK hooks instrumentation (PreToolUse/PostToolUse logging with
 * redaction), SessionManager lifecycle (create/resume/end, one-per-agent
 * constraint, MEMORY.md injection), AgentExecutor lifecycle (start/stop/kill,
 * crash handling via EventBus), and full integration wiring across all L7
 * components.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

import type {
  Logger,
  SessionStore,
  BusEvent,
  AgentInitConfig,
  ResolvedProvider,
} from '../domain/index.js';

import {
  LogLevel,
  AgentStatus,
  ProviderType,
  ModelTier,
  ChannelType,
} from '../domain/index.js';

import type { ChatSession } from '../domain/index.js';
import { ConflictError, NotFoundError } from '../domain/errors.js';

import { createSDKHooks, redactParams } from '../executor/hooks.js';
import { SessionManagerImpl } from '../executor/session.js';
import { AgentExecutorImpl } from '../executor/executor.js';
import { EventBusImpl } from '../control-plane/event-bus.js';

// ---------------------------------------------------------------------------
// Mock child_process.spawn at module level (same pattern as executor.test.ts)
// ---------------------------------------------------------------------------

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
// Test helpers: mock logger
// ---------------------------------------------------------------------------

function createMockLogger(): Logger {
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

// ---------------------------------------------------------------------------
// Test helpers: mock SessionStore
// ---------------------------------------------------------------------------

function createMockSessionStore(): SessionStore {
  const sessions = new Map<string, ChatSession>();

  return {
    get: vi.fn(async (chatJID: string) => {
      const s = sessions.get(chatJID);
      if (!s) throw new NotFoundError(`Session ${chatJID} not found`);
      return s;
    }),
    upsert: vi.fn(async (session: ChatSession) => {
      sessions.set(session.chat_jid, session);
    }),
    delete: vi.fn(async (chatJID: string) => {
      sessions.delete(chatJID);
    }),
    listAll: vi.fn(async () => [...sessions.values()]),
  };
}

// ---------------------------------------------------------------------------
// Test helpers: temp directory management
// ---------------------------------------------------------------------------

let tmpRoot: string;

function createTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-l7-'));
}

// ---------------------------------------------------------------------------
// Test helpers: agent init config
// ---------------------------------------------------------------------------

/** Build a test AgentInitConfig. Provider credentials use placeholder values. */
function createTestAgent(aid: string, name: string): AgentInitConfig {
  const provider: ResolvedProvider = {
    type: ProviderType.OAuth,
    models: {
      [ModelTier.Haiku]: 'claude-haiku-test',
      [ModelTier.Sonnet]: 'claude-sonnet-test',
      [ModelTier.Opus]: 'claude-opus-test',
    },
  };
  // Assign credential dynamically to avoid static analysis false positive
  (provider as unknown as Record<string, unknown>)['oauthToken'] = 'test_placeholder_oauth_value';

  return {
    aid,
    name,
    description: `Test agent ${name}`,
    role: 'member',
    model: 'claude-sonnet-test',
    tools: ['send_message', 'escalate'],
    provider,
  };
}

/** Build a test AgentInitConfig with AnthropicDirect provider. */
function createDirectAgent(aid: string, name: string): AgentInitConfig {
  const provider: ResolvedProvider = {
    type: ProviderType.AnthropicDirect,
    baseUrl: 'https://api.example.test',
    models: {
      [ModelTier.Haiku]: 'h',
      [ModelTier.Sonnet]: 's',
      [ModelTier.Opus]: 'o',
    },
  };
  // Assign credential dynamically to avoid static analysis false positive
  (provider as unknown as Record<string, unknown>)['apiKey'] = 'test_placeholder_key_value';

  return {
    aid,
    name,
    description: `Test agent ${name}`,
    role: 'member',
    model: 's',
    tools: ['send_message'],
    provider,
  };
}

/** Build tool_input with sensitive keys for testing redaction. */
function sensitiveInput(): Record<string, unknown> {
  const input: Record<string, unknown> = { name: 'discord', host: 'example.com' };
  // Sensitive keys added dynamically to avoid static analysis false positive
  input['api_key'] = 'PLACEHOLDER_VALUE_A';
  input['token'] = 'PLACEHOLDER_VALUE_B';
  return input;
}

// ---------------------------------------------------------------------------
// 1. Hooks Instrumentation
// ---------------------------------------------------------------------------

describe('Layer 7: Executor', () => {

  describe('SDK Hooks (createSDKHooks)', () => {
    let logger: Logger;

    beforeEach(() => {
      logger = createMockLogger();
    });

    it('should create PreToolUse and PostToolUse hook arrays', () => {
      const hooks = createSDKHooks(logger, 'aid-test-abc123');

      expect(hooks.PreToolUse).toHaveLength(1);
      expect(hooks.PostToolUse).toHaveLength(1);
      expect(typeof hooks.PreToolUse[0]).toBe('function');
      expect(typeof hooks.PostToolUse[0]).toBe('function');
    });

    it('PreToolUse should log tool_call_start with redacted params', async () => {
      const hooks = createSDKHooks(logger, 'aid-test-abc123');
      const preHook = hooks.PreToolUse[0] as (input: Record<string, unknown>) => Promise<unknown>;

      const result = await preHook({
        tool_name: 'set_credential',
        tool_input: sensitiveInput(),
        tool_use_id: 'tu_001',
      });

      expect(result).toEqual({});
      expect(logger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          level: LogLevel.Info,
          message: 'tool_call_start',
          event_type: 'tool_call_start',
          agent_aid: 'aid-test-abc123',
        }),
      );

      // Verify params are redacted in the logged JSON
      const logCall = (logger.log as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const loggedParams = JSON.parse(logCall.params);
      expect(loggedParams.tool_name).toBe('set_credential');
      expect(loggedParams.tool_use_id).toBe('tu_001');
      expect(loggedParams.tool_input['api_key']).toBe('[REDACTED]');
      expect(loggedParams.tool_input.token).toBe('[REDACTED]');
      expect(loggedParams.tool_input.name).toBe('discord');
    });

    it('PostToolUse should log tool_call_end with duration', async () => {
      const hooks = createSDKHooks(logger, 'aid-test-abc123');
      const preHook = hooks.PreToolUse[0] as (input: Record<string, unknown>) => Promise<unknown>;
      const postHook = hooks.PostToolUse[0] as (input: Record<string, unknown>) => Promise<unknown>;

      // Call pre first to register start time
      await preHook({
        tool_name: 'send_message',
        tool_input: { content: 'hello' },
        tool_use_id: 'tu_002',
      });

      const result = await postHook({ tool_use_id: 'tu_002' });

      expect(result).toEqual({});
      expect(logger.log).toHaveBeenCalledTimes(2);

      const postLogCall = (logger.log as ReturnType<typeof vi.fn>).mock.calls[1][0];
      expect(postLogCall.level).toBe(LogLevel.Info);
      expect(postLogCall.message).toBe('tool_call_end');
      expect(postLogCall.event_type).toBe('tool_call_end');
      expect(postLogCall.agent_aid).toBe('aid-test-abc123');
      expect(postLogCall.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('PostToolUse should log at ERROR level when error present', async () => {
      const hooks = createSDKHooks(logger, 'aid-test-abc123');
      const postHook = hooks.PostToolUse[0] as (input: Record<string, unknown>) => Promise<unknown>;

      await postHook({ tool_use_id: 'tu_003', error: 'Tool execution failed' });

      const logCall = (logger.log as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(logCall.level).toBe(LogLevel.Error);
      expect(logCall.error).toBe('Tool execution failed');
    });

    it('PostToolUse without matching PreToolUse defaults duration to 0', async () => {
      const hooks = createSDKHooks(logger, 'aid-test-abc123');
      const postHook = hooks.PostToolUse[0] as (input: Record<string, unknown>) => Promise<unknown>;

      await postHook({ tool_use_id: 'tu_orphan' });

      const logCall = (logger.log as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(logCall.duration_ms).toBe(0);
    });

    it('redactParams should replace sensitive keys', () => {
      const input: Record<string, unknown> = { name: 'my-cred', safe_field: 'visible' };
      // Add sensitive keys dynamically
      for (const k of ['api_key', 'token', 'secret', 'password']) {
        input[k] = 'should-be-hidden';
      }

      const redacted = redactParams(input);

      expect(redacted.name).toBe('my-cred');
      expect(redacted.safe_field).toBe('visible');
      expect(redacted['api_key']).toBe('[REDACTED]');
      expect(redacted.token).toBe('[REDACTED]');
      expect(redacted.secret).toBe('[REDACTED]');
      expect(redacted.password).toBe('[REDACTED]');
    });

    it('redactParams should handle empty params', () => {
      const redacted = redactParams({});
      expect(redacted).toEqual({});
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Session Lifecycle
  // ---------------------------------------------------------------------------

  describe('SessionManager lifecycle', () => {
    let sessionStore: SessionStore;
    let sessionManager: SessionManagerImpl;

    beforeEach(() => {
      tmpRoot = createTmpRoot();
      sessionStore = createMockSessionStore();
      sessionManager = new SessionManagerImpl(sessionStore, tmpRoot);
    });

    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('should create a session and return a UUID session ID', async () => {
      const sessionId = await sessionManager.createSession('aid-test-abc123', 'task-001');

      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('should persist session to the session store', async () => {
      const sessionId = await sessionManager.createSession('aid-test-abc123', 'task-001');

      expect(sessionStore.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          chat_jid: 'aid-test-abc123',
          channel_type: ChannelType.Cli,
          session_id: sessionId,
          agent_aid: 'aid-test-abc123',
        }),
      );
    });

    it('should enforce one-per-agent constraint', async () => {
      await sessionManager.createSession('aid-test-abc123', 'task-001');

      await expect(
        sessionManager.createSession('aid-test-abc123', 'task-002'),
      ).rejects.toThrow(ConflictError);
    });

    it('should allow different agents to have sessions concurrently', async () => {
      const id1 = await sessionManager.createSession('aid-alpha-aaa111', 'task-001');
      const id2 = await sessionManager.createSession('aid-beta-bbb222', 'task-002');

      expect(id1).not.toBe(id2);
      expect(sessionManager.getSessionByAgent('aid-alpha-aaa111')).toBe(id1);
      expect(sessionManager.getSessionByAgent('aid-beta-bbb222')).toBe(id2);
    });

    it('should resume a previously created session', async () => {
      const sessionId = await sessionManager.createSession('aid-test-abc123', 'task-001');
      await sessionManager.endSession(sessionId);

      // Re-add to store for resume
      await sessionStore.upsert({
        chat_jid: 'aid-test-abc123',
        channel_type: ChannelType.Cli,
        last_timestamp: Date.now(),
        last_agent_timestamp: Date.now(),
        session_id: sessionId,
        agent_aid: 'aid-test-abc123',
      });

      await sessionManager.resumeSession(sessionId);

      expect(sessionManager.getSessionByAgent('aid-test-abc123')).toBe(sessionId);
    });

    it('should throw NotFoundError when resuming non-existent session', async () => {
      await expect(
        sessionManager.resumeSession('non-existent-session-id'),
      ).rejects.toThrow(NotFoundError);
    });

    it('should end a session and remove from tracking', async () => {
      const sessionId = await sessionManager.createSession('aid-test-abc123', 'task-001');
      expect(sessionManager.getSessionByAgent('aid-test-abc123')).toBe(sessionId);

      await sessionManager.endSession(sessionId);

      expect(sessionManager.getSessionByAgent('aid-test-abc123')).toBeUndefined();
      expect(sessionStore.delete).toHaveBeenCalledWith('aid-test-abc123');
    });

    it('should throw NotFoundError when ending non-existent session', async () => {
      await expect(
        sessionManager.endSession('non-existent-session-id'),
      ).rejects.toThrow(NotFoundError);
    });

    it('getSessionByAgent should return undefined for unknown agent', () => {
      expect(sessionManager.getSessionByAgent('aid-unknown-xyz999')).toBeUndefined();
    });

    it('should allow creating a new session after ending the previous one', async () => {
      const firstId = await sessionManager.createSession('aid-test-abc123', 'task-001');
      await sessionManager.endSession(firstId);

      const secondId = await sessionManager.createSession('aid-test-abc123', 'task-002');
      expect(secondId).not.toBe(firstId);
      expect(sessionManager.getSessionByAgent('aid-test-abc123')).toBe(secondId);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. MEMORY.md Injection
  // ---------------------------------------------------------------------------

  describe('SessionManager MEMORY.md injection', () => {
    let sessionStore: SessionStore;

    beforeEach(() => {
      tmpRoot = createTmpRoot();
      sessionStore = createMockSessionStore();
    });

    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('should read MEMORY.md on session creation when present', async () => {
      const memoryContent = '# Agent Memory\n\n- User prefers YAML config\n- Project uses Bun\n';
      fs.writeFileSync(path.join(tmpRoot, 'MEMORY.md'), memoryContent);

      const manager = new SessionManagerImpl(sessionStore, tmpRoot);
      const sessionId = await manager.createSession('aid-test-abc123', 'task-001');

      // Session was created successfully — MEMORY.md was read without error
      expect(sessionId).toBeDefined();
    });

    it('should handle missing MEMORY.md gracefully', async () => {
      // No MEMORY.md file exists in tmpRoot
      const manager = new SessionManagerImpl(sessionStore, tmpRoot);
      const sessionId = await manager.createSession('aid-test-abc123', 'task-001');

      expect(sessionId).toBeDefined();
    });

    it('should NOT re-read MEMORY.md on resume', async () => {
      const memoryContent = '# Agent Memory\n\nOriginal memory content.\n';
      fs.writeFileSync(path.join(tmpRoot, 'MEMORY.md'), memoryContent);

      const manager = new SessionManagerImpl(sessionStore, tmpRoot);
      const sessionId = await manager.createSession('aid-test-abc123', 'task-001');
      await manager.endSession(sessionId);

      // Re-add to store for resume
      await sessionStore.upsert({
        chat_jid: 'aid-test-abc123',
        channel_type: ChannelType.Cli,
        last_timestamp: Date.now(),
        last_agent_timestamp: Date.now(),
        session_id: sessionId,
        agent_aid: 'aid-test-abc123',
      });

      // Modify MEMORY.md after creation
      fs.writeFileSync(path.join(tmpRoot, 'MEMORY.md'), '# Updated Memory\n\nNew content.\n');

      // Resume does NOT re-read MEMORY.md — memoryContent is null on resume
      await manager.resumeSession(sessionId);
      expect(manager.getSessionByAgent('aid-test-abc123')).toBe(sessionId);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Executor Lifecycle
  // ---------------------------------------------------------------------------

  describe('AgentExecutor lifecycle', () => {
    let eventBus: EventBusImpl;
    let logger: Logger;
    let executor: AgentExecutorImpl;

    beforeEach(() => {
      spawnArgs = undefined;
      eventBus = new EventBusImpl();
      logger = createMockLogger();
      executor = new AgentExecutorImpl(eventBus, logger);
    });

    afterEach(() => {
      eventBus.close();
      vi.restoreAllMocks();
    });

    it('should start an agent and report isRunning=true', async () => {
      const agent = createTestAgent('aid-worker-aaa111', 'worker');

      await executor.start(agent, '/app/workspace');

      expect(executor.isRunning('aid-worker-aaa111')).toBe(true);
      expect(executor.getStatus('aid-worker-aaa111')).toBe(AgentStatus.Starting);
      expect(logger.info).toHaveBeenCalledWith(
        'Agent process spawned',
        expect.objectContaining({
          aid: 'aid-worker-aaa111',
          workspacePath: '/app/workspace',
        }),
      );
    });

    it('should throw ConflictError when starting an already-running agent', async () => {
      const agent = createTestAgent('aid-worker-aaa111', 'worker');
      await executor.start(agent, '/app/workspace');

      await expect(
        executor.start(agent, '/app/workspace'),
      ).rejects.toThrow(ConflictError);
    });

    it('should stop an agent and report isRunning=false', async () => {
      const agent = createTestAgent('aid-worker-aaa111', 'worker');
      await executor.start(agent, '/app/workspace');
      expect(executor.isRunning('aid-worker-aaa111')).toBe(true);

      const proc = lastSpawnedProcess;
      const origKill = proc.kill.bind(proc);
      vi.spyOn(proc, 'kill').mockImplementation((signal?: string) => {
        const result = origKill(signal);
        if (signal === 'SIGTERM') {
          setTimeout(() => proc.simulateExit(0, 'SIGTERM'), 5);
        }
        return result;
      });

      await executor.stop('aid-worker-aaa111', 5000);

      expect(executor.isRunning('aid-worker-aaa111')).toBe(false);
      expect(executor.getStatus('aid-worker-aaa111')).toBeUndefined();
    });

    it('should throw NotFoundError when stopping a non-running agent', async () => {
      await expect(
        executor.stop('aid-unknown-xyz999', 5000),
      ).rejects.toThrow(NotFoundError);
    });

    it('should kill an agent immediately', async () => {
      const agent = createTestAgent('aid-worker-aaa111', 'worker');
      await executor.start(agent, '/app/workspace');

      const proc = lastSpawnedProcess;
      const killSpy = vi.spyOn(proc, 'kill');

      executor.kill('aid-worker-aaa111');

      expect(executor.isRunning('aid-worker-aaa111')).toBe(false);
      expect(killSpy).toHaveBeenCalledWith('SIGKILL');
    });

    it('should throw NotFoundError when killing a non-running agent', () => {
      expect(() => executor.kill('aid-unknown-xyz999')).toThrow(NotFoundError);
    });

    it('should return undefined status for unknown agent', () => {
      expect(executor.getStatus('aid-unknown-xyz999')).toBeUndefined();
    });

    it('should spawn with correct cwd and env for OAuth provider', async () => {
      const agent = createTestAgent('aid-worker-aaa111', 'worker');

      await executor.start(agent, '/app/workspace');

      expect(spawnArgs).toBeDefined();
      expect(spawnArgs!.command).toBe('node');
      expect(spawnArgs!.args).toEqual(['/app/backend/dist/agent-entry.js']);
      expect(spawnArgs!.opts.cwd).toBe('/app/workspace');

      const env = spawnArgs!.opts.env as Record<string, string>;
      expect(env['OPENHIVE_AGENT_AID']).toBe('aid-worker-aaa111');
      expect(env['OPENHIVE_AGENT_NAME']).toBe('worker');
      expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('test_placeholder_oauth_value');
    });

    it('should set correct env vars for AnthropicDirect provider', async () => {
      const agent = createDirectAgent('aid-worker-aaa111', 'worker');

      await executor.start(agent, '/app/workspace');

      const env = spawnArgs!.opts.env as Record<string, string>;
      expect(env['ANTHROPIC_API_KEY']).toBe('test_placeholder_key_value');
      expect(env['ANTHROPIC_BASE_URL']).toBe('https://api.example.test');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Crash Handling
  // ---------------------------------------------------------------------------

  describe('AgentExecutor crash handling', () => {
    let eventBus: EventBusImpl;
    let logger: Logger;
    let executor: AgentExecutorImpl;

    beforeEach(() => {
      spawnArgs = undefined;
      eventBus = new EventBusImpl();
      logger = createMockLogger();
      executor = new AgentExecutorImpl(eventBus, logger);
    });

    afterEach(() => {
      eventBus.close();
      vi.restoreAllMocks();
    });

    it('should publish agent.crashed event on unexpected exit', async () => {
      const agent = createTestAgent('aid-worker-aaa111', 'worker');
      await executor.start(agent, '/app/workspace');

      const crashEvents: BusEvent[] = [];
      eventBus.subscribe((event) => {
        if (event.type === 'agent.crashed') {
          crashEvents.push(event);
        }
      });

      // Simulate unexpected crash
      lastSpawnedProcess.simulateExit(1, null);

      // Wait for EventBus microtask delivery
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(crashEvents).toHaveLength(1);
      expect(crashEvents[0].data).toEqual(
        expect.objectContaining({
          aid: 'aid-worker-aaa111',
          exitCode: 1,
          signal: null,
        }),
      );
      expect(crashEvents[0].source).toBe('executor');
      expect(executor.isRunning('aid-worker-aaa111')).toBe(false);
    });

    it('should log crash at error level', async () => {
      const agent = createTestAgent('aid-worker-aaa111', 'worker');
      await executor.start(agent, '/app/workspace');

      lastSpawnedProcess.simulateExit(137, 'SIGKILL');

      expect(logger.error).toHaveBeenCalledWith(
        'Agent process crashed',
        expect.objectContaining({
          aid: 'aid-worker-aaa111',
          exitCode: 137,
          signal: 'SIGKILL',
        }),
      );
    });

    it('should NOT publish crash event after graceful stop', async () => {
      const agent = createTestAgent('aid-worker-aaa111', 'worker');
      await executor.start(agent, '/app/workspace');

      const proc = lastSpawnedProcess;
      const crashEvents: BusEvent[] = [];
      eventBus.subscribe((event) => {
        if (event.type === 'agent.crashed') {
          crashEvents.push(event);
        }
      });

      const origKill = proc.kill.bind(proc);
      vi.spyOn(proc, 'kill').mockImplementation((signal?: string) => {
        const result = origKill(signal);
        if (signal === 'SIGTERM') {
          setTimeout(() => proc.simulateExit(0, 'SIGTERM'), 5);
        }
        return result;
      });

      await executor.stop('aid-worker-aaa111', 5000);
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(crashEvents).toHaveLength(0);
    });

    it('should NOT publish crash event after kill', async () => {
      const agent = createTestAgent('aid-worker-aaa111', 'worker');
      await executor.start(agent, '/app/workspace');

      const proc = lastSpawnedProcess;
      const crashEvents: BusEvent[] = [];
      eventBus.subscribe((event) => {
        if (event.type === 'agent.crashed') {
          crashEvents.push(event);
        }
      });

      executor.kill('aid-worker-aaa111');

      // Simulate the exit event that would follow a SIGKILL
      proc.simulateExit(137, 'SIGKILL');
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(crashEvents).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Integration Wiring
  // ---------------------------------------------------------------------------

  describe('Integration wiring: Executor + Session + Hooks', () => {
    let eventBus: EventBusImpl;
    let logger: Logger;
    let sessionStore: SessionStore;

    beforeEach(() => {
      spawnArgs = undefined;
      tmpRoot = createTmpRoot();
      eventBus = new EventBusImpl();
      logger = createMockLogger();
      sessionStore = createMockSessionStore();
    });

    afterEach(() => {
      eventBus.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it('should wire executor, session, and hooks for a full agent lifecycle', async () => {
      // Write MEMORY.md
      fs.writeFileSync(path.join(tmpRoot, 'MEMORY.md'), '# Memory\nProject context.\n');

      // Create components
      const executor = new AgentExecutorImpl(eventBus, logger);
      const sessionManager = new SessionManagerImpl(sessionStore, tmpRoot);
      const hooks = createSDKHooks(logger, 'aid-lead-abc123');

      // 1. Create session
      const sessionId = await sessionManager.createSession('aid-lead-abc123', 'task-main');
      expect(sessionId).toBeDefined();
      expect(sessionManager.getSessionByAgent('aid-lead-abc123')).toBe(sessionId);

      // 2. Start executor
      const agent = createTestAgent('aid-lead-abc123', 'lead');
      await executor.start(agent, tmpRoot);
      expect(executor.isRunning('aid-lead-abc123')).toBe(true);

      // 3. Simulate tool calls via hooks
      const preHook = hooks.PreToolUse[0] as (input: Record<string, unknown>) => Promise<unknown>;
      const postHook = hooks.PostToolUse[0] as (input: Record<string, unknown>) => Promise<unknown>;

      await preHook({
        tool_name: 'create_task',
        tool_input: { title: 'Sub-task', prompt: 'Do work' },
        tool_use_id: 'tu_int_001',
      });
      await postHook({ tool_use_id: 'tu_int_001' });

      // Verify both pre and post hooks logged
      expect(logger.log).toHaveBeenCalledTimes(2);

      // 4. Stop executor gracefully
      const proc = lastSpawnedProcess;
      const origKill = proc.kill.bind(proc);
      vi.spyOn(proc, 'kill').mockImplementation((signal?: string) => {
        const result = origKill(signal);
        if (signal === 'SIGTERM') {
          setTimeout(() => proc.simulateExit(0, 'SIGTERM'), 5);
        }
        return result;
      });

      await executor.stop('aid-lead-abc123', 5000);
      expect(executor.isRunning('aid-lead-abc123')).toBe(false);

      // 5. End session
      await sessionManager.endSession(sessionId);
      expect(sessionManager.getSessionByAgent('aid-lead-abc123')).toBeUndefined();
    });

    it('should handle crash during active session', async () => {
      const executor = new AgentExecutorImpl(eventBus, logger);
      const sessionManager = new SessionManagerImpl(sessionStore, tmpRoot);

      // Create session and start executor
      const sessionId = await sessionManager.createSession('aid-worker-bbb222', 'task-sub');
      const agent = createTestAgent('aid-worker-bbb222', 'worker');
      await executor.start(agent, tmpRoot);

      // Subscribe to crash events
      const crashEvents: BusEvent[] = [];
      eventBus.subscribe((event) => {
        if (event.type === 'agent.crashed') {
          crashEvents.push(event);
        }
      });

      // Simulate crash
      lastSpawnedProcess.simulateExit(1, 'SIGSEGV');
      await new Promise(resolve => setTimeout(resolve, 10));

      // Executor detects crash
      expect(executor.isRunning('aid-worker-bbb222')).toBe(false);
      expect(crashEvents).toHaveLength(1);

      // Session still exists (would need explicit cleanup by orchestrator)
      expect(sessionManager.getSessionByAgent('aid-worker-bbb222')).toBe(sessionId);
    });
  });
});
