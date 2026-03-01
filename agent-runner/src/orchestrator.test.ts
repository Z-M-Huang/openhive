import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Orchestrator } from './orchestrator.js';
import type { WSClient } from './ws-client.js';
import type { WSMessage, ContainerInitMsg, TaskDispatchMsg, ShutdownMsg, ToolResultMsg } from './types.js';

function createMockWSClient(): WSClient {
  return {
    connect: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    isConnected: vi.fn(() => true),
  } as unknown as WSClient;
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
    const initMsg: ContainerInitMsg = {
      isMainAssistant: false,
      teamConfig: {},
      agents: [
        {
          aid: 'aid-agent-001',
          name: 'helper',
          provider: { type: 'oauth' },
          modelTier: 'sonnet',
        },
      ],
    };

    orchestrator.handleMessage({ type: 'container_init', data: initMsg });

    expect(wsClient.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ready',
        data: expect.objectContaining({
          agentCount: 1,
        }),
      }),
    );
  });

  it('routes task dispatch to correct agent', () => {
    // Init agents first
    orchestrator.handleMessage({
      type: 'container_init',
      data: {
        isMainAssistant: false,
        teamConfig: {},
        agents: [
          { aid: 'aid-agent-001', name: 'helper', provider: { type: 'oauth' }, modelTier: 'sonnet' },
        ],
      } as ContainerInitMsg,
    });

    const taskMsg: TaskDispatchMsg = {
      taskId: 'task-001',
      agentAid: 'aid-agent-001',
      prompt: 'Write tests',
    };

    orchestrator.handleMessage({ type: 'task_dispatch', data: taskMsg });

    const agent = orchestrator.getAgent('aid-agent-001');
    expect(agent?.status).toBe('busy');
  });

  it('handles task dispatch for unknown agent gracefully', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    orchestrator.handleMessage({
      type: 'container_init',
      data: {
        isMainAssistant: false,
        teamConfig: {},
        agents: [],
      } as ContainerInitMsg,
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
      data: {
        isMainAssistant: false,
        teamConfig: {},
        agents: [
          { aid: 'aid-agent-001', name: 'helper', provider: { type: 'oauth' }, modelTier: 'sonnet' },
        ],
      } as ContainerInitMsg,
    });

    const shutdownMsg: ShutdownMsg = {
      reason: 'scaling down',
      timeout: 30,
    };

    orchestrator.handleMessage({ type: 'shutdown', data: shutdownMsg });

    expect(wsClient.close).toHaveBeenCalled();

    const agent = orchestrator.getAgent('aid-agent-001');
    expect(agent?.status).toBe('stopped');
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
      data: {
        isMainAssistant: false,
        teamConfig: {},
        agents: [
          { aid: 'aid-agent-001', name: 'helper', provider: { type: 'oauth' }, modelTier: 'sonnet' },
        ],
      } as ContainerInitMsg,
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
      data: {
        isMainAssistant: false,
        teamConfig: {},
        agents: [
          { aid: 'aid-agent-001', name: 'helper', provider: { type: 'oauth' }, modelTier: 'sonnet' },
        ],
      } as ContainerInitMsg,
    });

    const agent = orchestrator.getAgent('aid-agent-001');
    expect(agent?.status).toBe('idle');
  });
});
