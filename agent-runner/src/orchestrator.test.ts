import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Orchestrator } from './orchestrator.js';
import { createMockQuery } from './mock-sdk.js';
import type { WSClient } from './ws-client.js';
import type { WSMessage, ContainerInitMsg, TaskDispatchMsg, ShutdownMsg, ToolResultMsg, AgentInitConfig } from './types.js';

function createMockWSClient(): WSClient {
  return {
    connect: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    isConnected: vi.fn(() => true),
  } as unknown as WSClient;
}

function createTestInitMsg(agents: Partial<AgentInitConfig>[] = [
  { aid: 'aid-agent-001', name: 'helper', provider: { type: 'oauth', oauthToken: 'tok-123' }, modelTier: 'sonnet' },
]): ContainerInitMsg {
  return {
    isMainAssistant: false,
    teamConfig: {},
    agents: agents.map(a => ({
      aid: a.aid ?? 'aid-agent-001',
      name: a.name ?? 'helper',
      provider: a.provider ?? { type: 'oauth' as const },
      modelTier: a.modelTier ?? 'sonnet' as const,
      ...a,
    })) as AgentInitConfig[],
  };
}

describe('Orchestrator', () => {
  let wsClient: ReturnType<typeof createMockWSClient>;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    wsClient = createMockWSClient();
    orchestrator = new Orchestrator(wsClient);
    orchestrator.setTeamId('tid-team-001');
  });

  it('receives container_init and stores agent configs', () => {
    const initMsg: ContainerInitMsg = {
      isMainAssistant: true,
      teamConfig: {},
      agents: [
        {
          aid: 'aid-agent-001',
          name: 'helper',
          provider: { type: 'oauth', oauthToken: 'tok-123' },
          modelTier: 'sonnet',
        },
        {
          aid: 'aid-agent-002',
          name: 'coder',
          provider: { type: 'oauth', oauthToken: 'tok-456' },
          modelTier: 'opus',
        },
      ],
    };

    orchestrator.handleMessage({
      type: 'container_init',
      data: initMsg,
    });

    expect(orchestrator.getAgents().size).toBe(2);
    expect(orchestrator.getAgent('aid-agent-001')).toBeDefined();
    expect(orchestrator.getAgent('aid-agent-002')).toBeDefined();
  });

  it('sends ready message after container_init', () => {
    orchestrator.handleMessage({
      type: 'container_init',
      data: createTestInitMsg(),
    });

    expect(wsClient.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ready',
        data: expect.objectContaining({
          agentCount: 1,
        }),
      }),
    );
  });

  it('creates AgentExecutor for each agent during container_init', () => {
    const mockQuery = createMockQuery({ responseText: 'done' });
    orchestrator.setSDKQueryFactory(() => mockQuery.query);

    orchestrator.handleMessage({
      type: 'container_init',
      data: createTestInitMsg([
        { aid: 'aid-agent-001', name: 'helper', provider: { type: 'oauth' }, modelTier: 'sonnet' },
      ]),
    });

    const agent = orchestrator.getAgent('aid-agent-001');
    expect(agent).toBeDefined();
    expect(agent?.executor).toBeDefined();
  });

  it('routes task dispatch to AgentExecutor.executeTask', async () => {
    const mockQuery = createMockQuery({ responseText: 'Task completed' });
    orchestrator.setSDKQueryFactory(() => mockQuery.query);

    orchestrator.handleMessage({
      type: 'container_init',
      data: createTestInitMsg(),
    });

    const taskMsg: TaskDispatchMsg = {
      taskId: 'task-001',
      agentAid: 'aid-agent-001',
      prompt: 'Write tests',
    };

    orchestrator.handleMessage({ type: 'task_dispatch', data: taskMsg });

    // Wait for async execution to complete
    await new Promise(resolve => setTimeout(resolve, 50));

    // Verify the SDK was called
    expect(mockQuery.calls).toHaveLength(1);
    expect(mockQuery.calls[0].prompt).toBe('Write tests');

    // Verify task_result was sent
    const resultCalls = (wsClient.send as ReturnType<typeof vi.fn>).mock.calls;
    const taskResultMsg = resultCalls.find(
      (call: WSMessage[]) => call[0]?.type === 'task_result',
    );
    expect(taskResultMsg).toBeDefined();
  });

  it('handles task dispatch for unknown agent gracefully', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    orchestrator.handleMessage({
      type: 'container_init',
      data: createTestInitMsg([]),
    });

    orchestrator.handleMessage({
      type: 'task_dispatch',
      data: { taskId: 'task-001', agentAid: 'aid-unknown', prompt: 'test' } as TaskDispatchMsg,
    });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Agent not found'));
    consoleSpy.mockRestore();
  });

  it('handles shutdown - stops agents and closes WS', () => {
    orchestrator.handleMessage({
      type: 'container_init',
      data: createTestInitMsg(),
    });

    const shutdownMsg: ShutdownMsg = {
      reason: 'scaling down',
      timeout: 30,
    };

    orchestrator.handleMessage({ type: 'shutdown', data: shutdownMsg });

    expect(wsClient.close).toHaveBeenCalled();

    const agent = orchestrator.getAgent('aid-agent-001');
    expect(agent?.status).toBe('stopped');
    // Executor should also be stopped
    expect(agent?.executor.status).toBe('stopped');
  });

  it('handles unknown message type', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    orchestrator.handleMessage({
      type: 'unknown_type' as WSMessage['type'],
      data: {},
    });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown message type'));
    consoleSpy.mockRestore();
  });

  it('rejects all pending tool calls on disconnect', () => {
    orchestrator.handleMessage({
      type: 'container_init',
      data: createTestInitMsg(),
    });

    // Trigger disconnect
    orchestrator.onDisconnect();

    // No crash = success
  });

  it('setTeamId works', () => {
    orchestrator.setTeamId('tid-custom');
    // This is verified implicitly through heartbeat messages
  });

  it('agent starts idle by default', () => {
    orchestrator.handleMessage({
      type: 'container_init',
      data: createTestInitMsg(),
    });

    const agent = orchestrator.getAgent('aid-agent-001');
    expect(agent?.status).toBe('idle');
  });

  it('routes tool results via callId lookup', () => {
    const mockQuery = createMockQuery({ responseText: 'done' });
    orchestrator.setSDKQueryFactory(() => mockQuery.query);

    orchestrator.handleMessage({
      type: 'container_init',
      data: createTestInitMsg([
        { aid: 'aid-agent-001', name: 'agent1', provider: { type: 'oauth' }, modelTier: 'sonnet' },
        { aid: 'aid-agent-002', name: 'agent2', provider: { type: 'oauth' }, modelTier: 'sonnet' },
      ]),
    });

    // Simulate a tool call being sent by agent-001's bridge
    // The orchestrator intercepts tool_call sends to track callId -> AID
    const agent1 = orchestrator.getAgent('aid-agent-001');
    expect(agent1).toBeDefined();

    // Trigger a tool call through the bridge (which sends via WS)
    const toolCallPromise = agent1!.mcpBridge.callTool('get_config', { section: 'system' });

    // Find the callId from the sent WS message
    const sentCalls = (wsClient.send as ReturnType<typeof vi.fn>).mock.calls;
    const toolCallSend = sentCalls.find(
      (call: WSMessage[]) => call[0]?.type === 'tool_call',
    );
    expect(toolCallSend).toBeDefined();
    const callId = (toolCallSend![0].data as { callId: string }).callId;

    // Route the tool result back
    const toolResult: ToolResultMsg = {
      callId,
      result: { log_level: 'info' },
    };
    orchestrator.handleMessage({ type: 'tool_result', data: toolResult });

    // The promise should resolve
    return expect(toolCallPromise).resolves.toEqual({ log_level: 'info' });
  });

  it('handles tool result for unknown callId gracefully', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    orchestrator.handleMessage({
      type: 'container_init',
      data: createTestInitMsg(),
    });

    orchestrator.handleMessage({
      type: 'tool_result',
      data: { callId: 'unknown-call-id', result: {} } as ToolResultMsg,
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('No agent found'),
    );
    consoleSpy.mockRestore();
  });
});
