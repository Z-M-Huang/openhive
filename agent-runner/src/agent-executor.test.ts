import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { AgentExecutor } from './agent-executor.js';
import { createMockQuery } from './mock-sdk.js';
import { MCPBridge } from './mcp-bridge.js';
import type { WSMessage, TaskDispatchMsg, TaskResultMsg, AgentInitConfig } from './types.js';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
}));

function createTestConfig(overrides: Partial<AgentInitConfig> = {}): AgentInitConfig {
  return {
    aid: 'aid-test-001',
    name: 'test-agent',
    provider: { type: 'oauth', oauthToken: 'tok-123' },
    modelTier: 'sonnet',
    ...overrides,
  };
}

function createTestExecutor(
  overrides: {
    config?: Partial<AgentInitConfig>;
    responseText?: string;
    error?: Error;
    delayMs?: number;
    idleTimeoutMinutes?: number;
  } = {},
): {
  executor: AgentExecutor;
  sentMessages: WSMessage[];
  mockQuery: ReturnType<typeof createMockQuery>;
  mcpBridge: MCPBridge;
} {
  const sentMessages: WSMessage[] = [];
  const mockQuery = createMockQuery({
    responseText: overrides.responseText ?? 'Task completed',
    error: overrides.error,
    delayMs: overrides.delayMs,
    sessionId: 'session-test-001',
  });
  const mcpBridge = new MCPBridge('aid-test-001', (msg) => sentMessages.push(msg));

  const executor = new AgentExecutor({
    config: createTestConfig(overrides.config),
    mcpBridge,
    sendMessage: (msg) => sentMessages.push(msg),
    queryFn: mockQuery.query,
    workspaceRoot: '/workspace',
    idleTimeoutMinutes: overrides.idleTimeoutMinutes,
  });

  return { executor, sentMessages, mockQuery, mcpBridge };
}

describe('AgentExecutor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Environment Variables', () => {
    it('includes process.env as base (preserves PATH, HOME, etc.)', () => {
      const { executor } = createTestExecutor();
      const env = executor.buildEnv();
      expect(env.PATH).toBe(process.env.PATH);
    });

    it('strips inherited secrets before overlaying provider credentials', () => {
      const secretKeys = AgentExecutor.getSecretEnvVars();
      const saved = new Map<string, string | undefined>();
      for (const key of secretKeys) {
        saved.set(key, process.env[key]);
        process.env[key] = `inherited-${key.toLowerCase()}`;
      }

      try {
        // Use a direct provider agent — only ANTHROPIC_API_KEY should be set
        const { executor } = createTestExecutor({
          config: { provider: { type: 'anthropic_direct', apiKey: 'sk-test' } },
        });
        const env = executor.buildEnv();
        // Agent's own key should be set
        expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
        // Other inherited secrets must be stripped
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      } finally {
        for (const [key, val] of saved) {
          if (val !== undefined) process.env[key] = val;
          else delete process.env[key];
        }
      }
    });

    it('sets CLAUDE_CODE_OAUTH_TOKEN for oauth provider', () => {
      const { executor } = createTestExecutor({
        config: { provider: { type: 'oauth', oauthToken: 'tok-abc' } },
      });

      const env = executor.buildEnv();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-abc');
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('sets ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL for direct provider', () => {
      const { executor } = createTestExecutor({
        config: {
          provider: {
            type: 'anthropic_direct',
            apiKey: 'sk-test',
            apiUrl: 'https://api.example.com',
          },
        },
      });

      const env = executor.buildEnv();
      expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
      expect(env.ANTHROPIC_BASE_URL).toBe('https://api.example.com');
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it('sets model tier env var for sonnet', () => {
      const { executor } = createTestExecutor({
        config: { modelTier: 'sonnet' },
      });

      const env = executor.buildEnv();
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('sonnet');
    });

    it('sets model tier env var for opus', () => {
      const { executor } = createTestExecutor({
        config: { modelTier: 'opus' },
      });

      const env = executor.buildEnv();
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('opus');
    });

    it('sets model tier env var for haiku', () => {
      const { executor } = createTestExecutor({
        config: { modelTier: 'haiku' },
      });

      const env = executor.buildEnv();
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('haiku');
    });

    it('strips Claude Code session vars to prevent nested-session errors', () => {
      const sessionVars = ['CLAUDECODE', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'];
      const saved = new Map<string, string | undefined>();
      for (const key of sessionVars) {
        saved.set(key, process.env[key]);
        process.env[key] = 'test-value';
      }

      try {
        const { executor } = createTestExecutor();
        const env = executor.buildEnv();
        for (const key of sessionVars) {
          expect(env[key]).toBeUndefined();
        }
      } finally {
        for (const [key, val] of saved) {
          if (val !== undefined) process.env[key] = val;
          else delete process.env[key];
        }
      }
    });
  });

  describe('Task Execution', () => {
    it('creates workspace directory before calling SDK', async () => {
      const { executor } = createTestExecutor();
      executor.start();

      await executor.executeTask({
        taskId: 'task-mkdir',
        agentAid: 'aid-test-001',
        prompt: 'Do work',
      });

      expect(mkdirSync).toHaveBeenCalledWith(
        '/workspace',
        { recursive: true },
      );
    });

    it('calls SDK query with fixed workspace cwd and prompt', async () => {
      const { executor, mockQuery } = createTestExecutor();
      executor.start();

      const task: TaskDispatchMsg = {
        taskId: 'task-001',
        agentAid: 'aid-test-001',
        prompt: 'Write tests',
      };

      await executor.executeTask(task);

      expect(mockQuery.calls).toHaveLength(1);
      expect(mockQuery.calls[0].options.cwd).toBe('/workspace');
      expect(mockQuery.calls[0].prompt).toBe('Write tests');
    });

    it('sets permissionMode to bypassPermissions', async () => {
      const { executor, mockQuery } = createTestExecutor();
      executor.start();

      const task: TaskDispatchMsg = {
        taskId: 'task-002',
        agentAid: 'aid-test-001',
        prompt: 'Do work',
      };

      await executor.executeTask(task);

      expect(mockQuery.calls[0].options.permissionMode).toBe('bypassPermissions');
      expect(mockQuery.calls[0].options.allowDangerouslySkipPermissions).toBe(true);
    });

    it('sends task result message on success', async () => {
      const { executor, sentMessages } = createTestExecutor({
        responseText: 'All tests pass',
      });
      executor.start();

      const task: TaskDispatchMsg = {
        taskId: 'task-003',
        agentAid: 'aid-test-001',
        prompt: 'Run tests',
      };

      await executor.executeTask(task);

      const resultMsg = sentMessages.find((m) => m.type === 'task_result');
      expect(resultMsg).toBeDefined();

      const data = resultMsg!.data as TaskResultMsg;
      expect(data.taskId).toBe('task-003');
      expect(data.agentAid).toBe('aid-test-001');
      expect(data.status).toBe('completed');
      expect(data.result).toBe('All tests pass');
      expect(data.duration).toBeGreaterThanOrEqual(0);
    });

    it('sends task result with error on SDK failure', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { executor, sentMessages } = createTestExecutor({
        error: new Error('SDK crashed'),
      });
      executor.start();

      const task: TaskDispatchMsg = {
        taskId: 'task-004',
        agentAid: 'aid-test-001',
        prompt: 'Fail task',
      };

      await executor.executeTask(task);

      const resultMsg = sentMessages.find((m) => m.type === 'task_result');
      expect(resultMsg).toBeDefined();

      const data = resultMsg!.data as TaskResultMsg;
      expect(data.status).toBe('failed');
      expect(data.error).toBe('SDK crashed');

      consoleSpy.mockRestore();
    });

    it('transitions status to busy during task and idle after', async () => {
      const { executor } = createTestExecutor();
      executor.start();

      expect(executor.status).toBe('idle');

      const task: TaskDispatchMsg = {
        taskId: 'task-005',
        agentAid: 'aid-test-001',
        prompt: 'Work',
      };

      const taskPromise = executor.executeTask(task);

      // Status should be idle after completion (async resolves immediately in test)
      await taskPromise;
      expect(executor.status).toBe('idle');
    });

    it('transitions status to error on SDK failure', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { executor } = createTestExecutor({
        error: new Error('boom'),
      });
      executor.start();

      await executor.executeTask({
        taskId: 'task-006',
        agentAid: 'aid-test-001',
        prompt: 'Fail',
      });

      expect(executor.status).toBe('error');
      consoleSpy.mockRestore();
    });

    it('uses session resume when session ID is available', async () => {
      const { executor, mockQuery } = createTestExecutor();
      executor.start();

      // First task establishes a session
      await executor.executeTask({
        taskId: 'task-007a',
        agentAid: 'aid-test-001',
        prompt: 'First task',
      });

      expect(executor.currentSessionId).toBe('session-test-001');

      // Second task should resume the session
      await executor.executeTask({
        taskId: 'task-007b',
        agentAid: 'aid-test-001',
        prompt: 'Second task',
      });

      expect(mockQuery.calls[1].options.resume).toBe('session-test-001');
    });

    it('uses task-provided sessionId if available', async () => {
      const { executor, mockQuery } = createTestExecutor();
      executor.start();

      await executor.executeTask({
        taskId: 'task-008',
        agentAid: 'aid-test-001',
        prompt: 'Resume task',
        sessionId: 'session-external-001',
      });

      expect(mockQuery.calls[0].options.resume).toBe('session-external-001');
    });

    it('starts agent automatically if not running', async () => {
      const { executor } = createTestExecutor();

      // Don't call start() explicitly
      expect(executor.status).toBe('idle');

      await executor.executeTask({
        taskId: 'task-009',
        agentAid: 'aid-test-001',
        prompt: 'Auto-start',
      });

      // Should have started and completed
      expect(executor.status).toBe('idle');
    });

    it('uses same fixed workspace cwd across all tasks', async () => {
      const { executor, mockQuery } = createTestExecutor();
      executor.start();

      await executor.executeTask({
        taskId: 'task-first',
        agentAid: 'aid-test-001',
        prompt: 'First',
      });

      await executor.executeTask({
        taskId: 'task-second',
        agentAid: 'aid-test-001',
        prompt: 'Second',
      });

      // Both tasks use the same workspace root — session state is cwd-relative
      expect(mockQuery.calls[0].options.cwd).toBe('/workspace');
      expect(mockQuery.calls[1].options.cwd).toBe('/workspace');
    });
  });

  describe('On-Demand Lifecycle', () => {
    it('starts on first task dispatch', async () => {
      const { executor } = createTestExecutor();

      await executor.executeTask({
        taskId: 'task-010',
        agentAid: 'aid-test-001',
        prompt: 'Start me',
      });

      expect(executor.status).toBe('idle');
    });

    it('idle timeout stops agent after configured period', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { executor } = createTestExecutor({
        idleTimeoutMinutes: 5,
      });

      executor.start();
      expect(executor.status).toBe('idle');

      // Advance past the 5 minute timeout
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      expect(executor.status).toBe('stopped');
      consoleSpy.mockRestore();
    });

    it('idle timeout resets on new task', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { executor } = createTestExecutor({
        idleTimeoutMinutes: 5,
      });

      executor.start();

      // Advance 4 minutes (not quite at timeout)
      vi.advanceTimersByTime(4 * 60 * 1000);
      expect(executor.status).toBe('idle');

      // Execute a task (resets the timer)
      await executor.executeTask({
        taskId: 'task-011',
        agentAid: 'aid-test-001',
        prompt: 'Reset timer',
      });

      // Advance 4 more minutes (should NOT have timed out since timer was reset)
      vi.advanceTimersByTime(4 * 60 * 1000);
      expect(executor.status).toBe('idle');

      // Advance past full timeout from last task
      vi.advanceTimersByTime(2 * 60 * 1000);
      expect(executor.status).toBe('stopped');
      consoleSpy.mockRestore();
    });

    it('stop clears idle timer', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { executor } = createTestExecutor({
        idleTimeoutMinutes: 5,
      });

      executor.start();
      executor.stop();

      expect(executor.status).toBe('stopped');

      // Advancing time should not cause issues
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(executor.status).toBe('stopped');
      consoleSpy.mockRestore();
    });
  });

  describe('Bash Sanitization', () => {
    it('returns secret env var names for sanitization', () => {
      const secrets = AgentExecutor.getSecretEnvVars();
      expect(secrets).toContain('ANTHROPIC_API_KEY');
      expect(secrets).toContain('CLAUDE_CODE_OAUTH_TOKEN');
      expect(secrets).toHaveLength(2);
    });
  });

  describe('Memory Tracking', () => {
    it('reports memory usage in MB', () => {
      const { executor } = createTestExecutor();
      const memMB = executor.getMemoryMB();
      expect(memMB).toBeGreaterThan(0);
      expect(typeof memMB).toBe('number');
    });
  });
});
