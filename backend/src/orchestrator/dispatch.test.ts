/**
 * Tests for Dispatcher.
 *
 * Tests cover:
 *   - createAndDispatch: creates task and sends WS message
 *   - handleResult: updates task status to completed
 *   - handleResult: updates task status to failed
 *   - handleWSMessage: routes task_result correctly
 *   - handleWSMessage: routes heartbeat to monitor
 *   - handleWSMessage: routes tool_call to handler and returns result
 *   - handleWSMessage: rejects backend-to-container message types
 *   - sendContainerInit: sends correct message format
 *
 * Helpers flush microtasks after async method chains that are fire-and-forget.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Dispatcher, newDispatcher } from './dispatch.js';
import type { DispatcherLogger } from './dispatch.js';
import type { TaskStore, WSHub, HeartbeatMonitor, SDKToolHandler } from '../domain/interfaces.js';
import type { Task } from '../domain/types.js';
import type { TaskResultMsg, AgentInitConfig } from '../ws/messages.js';
import type { JsonValue } from '../domain/types.js';
import {
  MsgTypeContainerInit,
  MsgTypeTaskDispatch,
  MsgTypeShutdown,
  MsgTypeToolResult,
  MsgTypeReady,
  MsgTypeHeartbeat,
  MsgTypeTaskResult,
  MsgTypeEscalation,
  MsgTypeToolCall,
  MsgTypeStatusUpdate,
} from '../ws/messages.js';
import { NotFoundError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flushes microtasks — needed after fire-and-forget promise chains. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

/** Creates a silent no-op logger for tests. */
function makeLogger(): DispatcherLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

/** Creates a spy logger that records calls. */
function makeSpyLogger(): DispatcherLogger & {
  calls: Record<string, Array<[string, Record<string, unknown> | undefined]>>;
} {
  const calls: Record<string, Array<[string, Record<string, unknown> | undefined]>> = {
    debug: [],
    info: [],
    warn: [],
    error: [],
  };
  return {
    calls,
    debug(msg: string, data?: Record<string, unknown>) {
      calls['debug']!.push([msg, data]);
    },
    info(msg: string, data?: Record<string, unknown>) {
      calls['info']!.push([msg, data]);
    },
    warn(msg: string, data?: Record<string, unknown>) {
      calls['warn']!.push([msg, data]);
    },
    error(msg: string, data?: Record<string, unknown>) {
      calls['error']!.push([msg, data]);
    },
  };
}

/** Creates a minimal mock TaskStore. */
function makeTaskStore(overrides?: Partial<TaskStore>): TaskStore {
  const tasks = new Map<string, Task>();
  return {
    async create(task: Task) {
      tasks.set(task.id, { ...task });
    },
    async get(id: string): Promise<Task> {
      const t = tasks.get(id);
      if (t === undefined) {
        throw new NotFoundError('task', id);
      }
      return { ...t };
    },
    async update(task: Task) {
      if (!tasks.has(task.id)) {
        throw new NotFoundError('task', task.id);
      }
      tasks.set(task.id, { ...task });
    },
    async delete(id: string) {
      tasks.delete(id);
    },
    async listByTeam(_teamSlug: string): Promise<Task[]> {
      return [];
    },
    async listByStatus(_status: Task['status']): Promise<Task[]> {
      return [];
    },
    async getSubtree(_rootID: string): Promise<Task[]> {
      return [];
    },
    ...overrides,
  };
}

/** Creates a mock WSHub that captures sent messages. */
function makeWSHub(overrides?: Partial<WSHub>): WSHub & { sent: Array<{ teamID: string; msg: string }> } {
  const sent: Array<{ teamID: string; msg: string }> = [];
  return {
    sent,
    registerConnection: () => undefined,
    unregisterConnection: () => undefined,
    async sendToTeam(teamID: string, msg: Buffer | string) {
      sent.push({ teamID, msg: typeof msg === 'string' ? msg : msg.toString('utf8') });
    },
    async broadcastAll(_msg: Buffer | string) {
      // no-op
    },
    generateToken: () => 'tok',
    getUpgradeHandler: () => () => undefined,
    getConnectedTeams: () => [],
    setOnMessage: () => undefined,
    setOnConnect: () => undefined,
    ...overrides,
  };
}

/** Creates a minimal mock HeartbeatMonitor. */
function makeHeartbeatMonitor(): HeartbeatMonitor & { received: Array<{ teamID: string; agentCount: number }> } {
  const received: Array<{ teamID: string; agentCount: number }> = [];
  return {
    received,
    processHeartbeat(teamID: string, agents: unknown[]) {
      received.push({ teamID, agentCount: agents.length });
    },
    getStatus: () => {
      throw new NotFoundError('heartbeat_status', 'unknown');
    },
    getAllStatuses: () => ({}),
    setOnUnhealthy: () => undefined,
    startMonitoring: () => undefined,
    stopMonitoring: () => undefined,
  };
}

/** Creates a minimal mock SDKToolHandler. */
function makeToolHandler(
  resultOrError: JsonValue | Error,
): SDKToolHandler & { calls: Array<{ teamID: string; callID: string; toolName: string; agentAID: string; args: Record<string, JsonValue> }> } {
  const calls: Array<{ teamID: string; callID: string; toolName: string; agentAID: string; args: Record<string, JsonValue> }> = [];
  return {
    calls,
    async handleToolCall(_callID: string, _toolName: string, _args: Record<string, JsonValue>): Promise<JsonValue> {
      if (resultOrError instanceof Error) throw resultOrError;
      return resultOrError;
    },
    async handleToolCallWithContext(
      teamID: string,
      callID: string,
      toolName: string,
      agentAID: string,
      args: Record<string, JsonValue>,
    ): Promise<JsonValue> {
      calls.push({ teamID, callID, toolName, agentAID, args });
      if (resultOrError instanceof Error) throw resultOrError;
      return resultOrError;
    },
  };
}

/** Encodes a raw WS message envelope as JSON bytes. */
function encodeWire(type: string, data: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify({ type, data }), 'utf8');
}

// ---------------------------------------------------------------------------
// createAndDispatch — creates task and sends WS message
// ---------------------------------------------------------------------------

describe('createAndDispatch', () => {
  it('creates task in store and sends task_dispatch WS message', async () => {
    const taskStore = makeTaskStore();
    const wsHub = makeWSHub();
    const dispatcher = newDispatcher(taskStore, wsHub, makeLogger());

    const createSpy = vi.spyOn(taskStore, 'create');
    const task = await dispatcher.createAndDispatch('team-a', 'aid-001', 'Do something', '');

    // Task persisted
    expect(createSpy).toHaveBeenCalledOnce();
    expect(task.team_slug).toBe('team-a');
    expect(task.agent_aid).toBe('aid-001');
    expect(task.prompt).toBe('Do something');
    expect(task.parent_id).toBeUndefined();

    // WS message sent
    expect(wsHub.sent).toHaveLength(1);
    const sent = wsHub.sent[0]!;
    expect(sent.teamID).toBe('team-a');
    const envelope = JSON.parse(sent.msg) as { type: string; data: { task_id: string; agent_aid: string; prompt: string } };
    expect(envelope.type).toBe(MsgTypeTaskDispatch);
    expect(envelope.data.task_id).toBe(task.id);
    expect(envelope.data.agent_aid).toBe('aid-001');
    expect(envelope.data.prompt).toBe('Do something');

    // Status updated to running
    expect(task.status).toBe('running');
  });

  it('sets parent_id when parentID is non-empty', async () => {
    const taskStore = makeTaskStore();
    const wsHub = makeWSHub();
    const dispatcher = newDispatcher(taskStore, wsHub, makeLogger());

    const task = await dispatcher.createAndDispatch('team-b', 'aid-002', 'Sub task', 'parent-task-id');

    expect(task.parent_id).toBe('parent-task-id');
  });

  it('returns pending task when WS send fails', async () => {
    const taskStore = makeTaskStore();
    const wsHub = makeWSHub({
      async sendToTeam(_teamID: string, _msg: Buffer | string) {
        throw new Error('container not connected');
      },
    });
    const dispatcher = newDispatcher(taskStore, wsHub, makeLogger());

    const task = await dispatcher.createAndDispatch('team-c', 'aid-003', 'prompt', '');

    // Task still created in store
    const stored = await taskStore.get(task.id);
    expect(stored.id).toBe(task.id);
    // Status stays pending (WS failed, no update call)
    expect(task.status).toBe('pending');
  });

  it('generates a unique ID for each task', async () => {
    const taskStore = makeTaskStore();
    const wsHub = makeWSHub();
    const dispatcher = newDispatcher(taskStore, wsHub, makeLogger());

    const t1 = await dispatcher.createAndDispatch('team-a', 'aid-001', 'p1', '');
    const t2 = await dispatcher.createAndDispatch('team-a', 'aid-001', 'p2', '');

    expect(t1.id).not.toBe(t2.id);
  });
});

// ---------------------------------------------------------------------------
// handleResult — updates task status to completed
// ---------------------------------------------------------------------------

describe('handleResult — completed', () => {
  it('updates task status to completed with result', async () => {
    const taskStore = makeTaskStore();
    const wsHub = makeWSHub();
    const dispatcher = newDispatcher(taskStore, wsHub, makeLogger());

    // Pre-create task
    const created = await dispatcher.createAndDispatch('team-a', 'aid-001', 'prompt', '');

    const resultMsg: TaskResultMsg = {
      task_id: created.id,
      agent_aid: 'aid-001',
      status: 'completed',
      result: 'done',
      duration: 1_000_000_000,
    };

    await dispatcher.handleResult(resultMsg);

    const updated = await taskStore.get(created.id);
    expect(updated.status).toBe('completed');
    expect(updated.result).toBe('done');
    expect(updated.completed_at).toBeInstanceOf(Date);
    expect(updated.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// handleResult — updates task status to failed
// ---------------------------------------------------------------------------

describe('handleResult — failed', () => {
  it('updates task status to failed with error', async () => {
    const taskStore = makeTaskStore();
    const wsHub = makeWSHub();
    const dispatcher = newDispatcher(taskStore, wsHub, makeLogger());

    const created = await dispatcher.createAndDispatch('team-a', 'aid-001', 'prompt', '');

    const resultMsg: TaskResultMsg = {
      task_id: created.id,
      agent_aid: 'aid-001',
      status: 'failed',
      error: 'something went wrong',
      duration: 500_000_000,
    };

    await dispatcher.handleResult(resultMsg);

    const updated = await taskStore.get(created.id);
    expect(updated.status).toBe('failed');
    expect(updated.error).toBe('something went wrong');
    expect(updated.completed_at).toBeInstanceOf(Date);
    expect(updated.result).toBeUndefined();
  });

  it('throws on unexpected status value', async () => {
    const taskStore = makeTaskStore();
    const wsHub = makeWSHub();
    const dispatcher = newDispatcher(taskStore, wsHub, makeLogger());

    const created = await dispatcher.createAndDispatch('team-a', 'aid-001', 'prompt', '');

    const resultMsg: TaskResultMsg = {
      task_id: created.id,
      agent_aid: 'aid-001',
      status: 'running', // invalid final status
      duration: 0,
    };

    await expect(dispatcher.handleResult(resultMsg)).rejects.toThrow(
      'unexpected task result status: running',
    );
  });

  it('throws NotFoundError when task does not exist', async () => {
    const taskStore = makeTaskStore();
    const wsHub = makeWSHub();
    const dispatcher = newDispatcher(taskStore, wsHub, makeLogger());

    const resultMsg: TaskResultMsg = {
      task_id: 'nonexistent-task',
      agent_aid: 'aid-001',
      status: 'completed',
      result: 'ok',
      duration: 0,
    };

    await expect(dispatcher.handleResult(resultMsg)).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// handleWSMessage — routes task_result correctly
// ---------------------------------------------------------------------------

describe('handleWSMessage — task_result routing', () => {
  it('calls handleResult and taskResultCallback on task_result', async () => {
    const taskStore = makeTaskStore();
    const wsHub = makeWSHub();
    const dispatcher = newDispatcher(taskStore, wsHub, makeLogger());

    const created = await dispatcher.createAndDispatch('team-a', 'aid-001', 'prompt', '');

    const callbackResults: TaskResultMsg[] = [];
    dispatcher.setTaskResultCallback((r) => {
      callbackResults.push(r);
    });

    const rawMsg = encodeWire(MsgTypeTaskResult, {
      task_id: created.id,
      agent_aid: 'aid-001',
      status: 'completed',
      result: 'great result',
      duration: 123,
    });

    dispatcher.handleWSMessage('team-a', rawMsg);
    await flushMicrotasks();

    // Callback should have been invoked
    expect(callbackResults).toHaveLength(1);
    expect(callbackResults[0]!.task_id).toBe(created.id);
    expect(callbackResults[0]!.status).toBe('completed');

    // Task in store should be completed
    const stored = await taskStore.get(created.id);
    expect(stored.status).toBe('completed');
    expect(stored.result).toBe('great result');
  });

  it('logs error and does not crash when task is not found', async () => {
    const taskStore = makeTaskStore();
    const wsHub = makeWSHub();
    const logger = makeSpyLogger();
    const dispatcher = newDispatcher(taskStore, wsHub, logger);

    const rawMsg = encodeWire(MsgTypeTaskResult, {
      task_id: 'missing-task-id',
      agent_aid: 'aid-001',
      status: 'completed',
      result: 'r',
      duration: 0,
    });

    dispatcher.handleWSMessage('team-x', rawMsg);
    await flushMicrotasks();

    const errorCalls = logger.calls['error']!;
    expect(errorCalls.length).toBeGreaterThan(0);
    const foundError = errorCalls.some(([msg]) => msg === 'failed to handle task result');
    expect(foundError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleWSMessage — routes heartbeat to monitor
// ---------------------------------------------------------------------------

describe('handleWSMessage — heartbeat routing', () => {
  it('forwards heartbeat to the heartbeat monitor', async () => {
    const taskStore = makeTaskStore();
    const wsHub = makeWSHub();
    const dispatcher = newDispatcher(taskStore, wsHub, makeLogger());
    const monitor = makeHeartbeatMonitor();
    dispatcher.setHeartbeatMonitor(monitor);

    const rawMsg = encodeWire(MsgTypeHeartbeat, {
      team_id: 'tid-001',
      agents: [
        { aid: 'aid-001', status: 'idle', elapsed_seconds: 10, memory_mb: 50 },
        { aid: 'aid-002', status: 'busy', elapsed_seconds: 30, memory_mb: 100 },
      ],
    });

    dispatcher.handleWSMessage('tid-001', rawMsg);
    await flushMicrotasks();

    expect(monitor.received).toHaveLength(1);
    expect(monitor.received[0]!.teamID).toBe('tid-001');
    expect(monitor.received[0]!.agentCount).toBe(2);
  });

  it('logs warning when heartbeat monitor is not configured', async () => {
    const taskStore = makeTaskStore();
    const wsHub = makeWSHub();
    const logger = makeSpyLogger();
    const dispatcher = newDispatcher(taskStore, wsHub, logger);
    // No heartbeat monitor set

    const rawMsg = encodeWire(MsgTypeHeartbeat, {
      team_id: 'tid-002',
      agents: [],
    });

    dispatcher.handleWSMessage('tid-002', rawMsg);
    await flushMicrotasks();

    const warnCalls = logger.calls['warn']!;
    const hasWarning = warnCalls.some(([msg]) =>
      msg === 'heartbeat received but no heartbeat monitor configured',
    );
    expect(hasWarning).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleWSMessage — routes tool_call to handler and returns result
// ---------------------------------------------------------------------------

describe('handleWSMessage — tool_call routing', () => {
  it('invokes tool handler and sends tool_result back via WS', async () => {
    const taskStore = makeTaskStore();
    const wsHub = makeWSHub();
    const dispatcher = newDispatcher(taskStore, wsHub, makeLogger());
    const toolResult: JsonValue = { output: 'hello from tool' };
    const handler = makeToolHandler(toolResult);
    dispatcher.setToolHandler(handler);

    const rawMsg = encodeWire(MsgTypeToolCall, {
      call_id: 'call-abc',
      tool_name: 'my_tool',
      arguments: { key: 'value' },
      agent_aid: 'aid-001',
    });

    // Clear existing sent messages (from previous tests, if any)
    wsHub.sent.length = 0;

    dispatcher.handleWSMessage('tid-001', rawMsg);
    await flushMicrotasks();

    // Tool handler invoked
    expect(handler.calls).toHaveLength(1);
    expect(handler.calls[0]!.callID).toBe('call-abc');
    expect(handler.calls[0]!.toolName).toBe('my_tool');
    expect(handler.calls[0]!.agentAID).toBe('aid-001');
    expect(handler.calls[0]!.args).toEqual({ key: 'value' });

    // tool_result sent back
    expect(wsHub.sent).toHaveLength(1);
    const sent = wsHub.sent[0]!;
    expect(sent.teamID).toBe('tid-001');
    const envelope = JSON.parse(sent.msg) as { type: string; data: { call_id: string; result: JsonValue } };
    expect(envelope.type).toBe(MsgTypeToolResult);
    expect(envelope.data.call_id).toBe('call-abc');
    expect(envelope.data.result).toEqual({ output: 'hello from tool' });
  });

  it('sends error tool_result when tool handler throws', async () => {
    const taskStore = makeTaskStore();
    const wsHub = makeWSHub();
    const dispatcher = newDispatcher(taskStore, wsHub, makeLogger());
    const handler = makeToolHandler(new Error('tool exploded'));
    dispatcher.setToolHandler(handler);

    wsHub.sent.length = 0;

    const rawMsg = encodeWire(MsgTypeToolCall, {
      call_id: 'call-err',
      tool_name: 'bad_tool',
      arguments: {},
      agent_aid: 'aid-002',
    });

    dispatcher.handleWSMessage('tid-001', rawMsg);
    await flushMicrotasks();

    // An error tool_result should have been sent
    expect(wsHub.sent).toHaveLength(1);
    const envelope = JSON.parse(wsHub.sent[0]!.msg) as {
      type: string;
      data: { call_id: string; error_code: string; error_message: string };
    };
    expect(envelope.type).toBe(MsgTypeToolResult);
    expect(envelope.data.call_id).toBe('call-err');
    expect(envelope.data.error_code).toBeTruthy();
    expect(envelope.data.error_message).toBeTruthy();
  });

  it('sends VALIDATION_ERROR when tool arguments are not a JSON object', async () => {
    const taskStore = makeTaskStore();
    const wsHub = makeWSHub();
    const dispatcher = newDispatcher(taskStore, wsHub, makeLogger());
    const handler = makeToolHandler('not called');
    dispatcher.setToolHandler(handler);

    wsHub.sent.length = 0;

    // arguments is an array, not an object
    const rawMsg = encodeWire(MsgTypeToolCall, {
      call_id: 'call-badargs',
      tool_name: 'my_tool',
      arguments: ['not', 'an', 'object'],
      agent_aid: 'aid-001',
    });

    dispatcher.handleWSMessage('tid-001', rawMsg);
    await flushMicrotasks();

    expect(handler.calls).toHaveLength(0); // handler NOT invoked

    expect(wsHub.sent).toHaveLength(1);
    const envelope = JSON.parse(wsHub.sent[0]!.msg) as {
      type: string;
      data: { call_id: string; error_code: string };
    };
    expect(envelope.type).toBe(MsgTypeToolResult);
    expect(envelope.data.call_id).toBe('call-badargs');
    expect(envelope.data.error_code).toBe('VALIDATION_ERROR');
  });

  it('logs error when no tool handler is configured', async () => {
    const taskStore = makeTaskStore();
    const wsHub = makeWSHub();
    const logger = makeSpyLogger();
    const dispatcher = newDispatcher(taskStore, wsHub, logger);
    // No tool handler set

    wsHub.sent.length = 0;

    const rawMsg = encodeWire(MsgTypeToolCall, {
      call_id: 'call-no-handler',
      tool_name: 'my_tool',
      arguments: {},
      agent_aid: 'aid-001',
    });

    dispatcher.handleWSMessage('tid-001', rawMsg);
    await flushMicrotasks();

    const errorCalls = logger.calls['error']!;
    const hasError = errorCalls.some(([msg]) =>
      msg === 'tool call received but no tool handler configured',
    );
    expect(hasError).toBe(true);
    // No message sent
    expect(wsHub.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleWSMessage — rejects backend-to-container message types
// ---------------------------------------------------------------------------

describe('handleWSMessage — direction validation', () => {
  it.each([
    MsgTypeContainerInit,
    MsgTypeTaskDispatch,
    MsgTypeShutdown,
    MsgTypeToolResult,
  ] as const)('rejects %s (backend-to-container type)', async (msgType) => {
    const taskStore = makeTaskStore();
    const wsHub = makeWSHub();
    const logger = makeSpyLogger();
    const dispatcher = newDispatcher(taskStore, wsHub, logger);

    // Build a minimal valid-shape message for each type
    let data: Record<string, unknown> = {};
    if (msgType === MsgTypeContainerInit) {
      data = { is_main_assistant: false, team_config: {}, agents: [] };
    } else if (msgType === MsgTypeTaskDispatch) {
      data = { task_id: 'tid', agent_aid: 'aid', prompt: 'p' };
    } else if (msgType === MsgTypeShutdown) {
      data = { reason: 'stop', timeout: 5 };
    } else if (msgType === MsgTypeToolResult) {
      data = { call_id: 'cid' };
    }

    const rawMsg = encodeWire(msgType, data);
    dispatcher.handleWSMessage('tid-001', rawMsg);
    await flushMicrotasks();

    const errorCalls = logger.calls['error']!;
    const hasRejection = errorCalls.some(([msg]) =>
      msg === 'rejected message with invalid direction',
    );
    expect(hasRejection).toBe(true);
  });

  it('logs parse error for malformed JSON', async () => {
    const taskStore = makeTaskStore();
    const wsHub = makeWSHub();
    const logger = makeSpyLogger();
    const dispatcher = newDispatcher(taskStore, wsHub, logger);

    dispatcher.handleWSMessage('tid-001', Buffer.from('not json', 'utf8'));
    await flushMicrotasks();

    const errorCalls = logger.calls['error']!;
    const hasError = errorCalls.some(([msg]) => msg === 'failed to parse WS message');
    expect(hasError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleWSMessage — ready, escalation, status_update (log-only paths)
// ---------------------------------------------------------------------------

describe('handleWSMessage — log-only message types', () => {
  it('logs info for ready message', async () => {
    const taskStore = makeTaskStore();
    const wsHub = makeWSHub();
    const logger = makeSpyLogger();
    const dispatcher = newDispatcher(taskStore, wsHub, logger);

    const rawMsg = encodeWire(MsgTypeReady, {
      team_id: 'tid-ready',
      agent_count: 3,
    });

    dispatcher.handleWSMessage('tid-ready', rawMsg);
    await flushMicrotasks();

    const infoCalls = logger.calls['info']!;
    const hasReady = infoCalls.some(([msg]) => msg === 'container ready');
    expect(hasReady).toBe(true);
  });

  it('logs warn for escalation message', async () => {
    const taskStore = makeTaskStore();
    const wsHub = makeWSHub();
    const logger = makeSpyLogger();
    const dispatcher = newDispatcher(taskStore, wsHub, logger);

    const rawMsg = encodeWire(MsgTypeEscalation, {
      task_id: 'task-esc',
      agent_aid: 'aid-001',
      reason: 'cannot proceed',
    });

    dispatcher.handleWSMessage('tid-001', rawMsg);
    await flushMicrotasks();

    const warnCalls = logger.calls['warn']!;
    const hasEscalation = warnCalls.some(([msg]) => msg === 'escalation received');
    expect(hasEscalation).toBe(true);
  });

  it('logs info for status_update message', async () => {
    const taskStore = makeTaskStore();
    const wsHub = makeWSHub();
    const logger = makeSpyLogger();
    const dispatcher = newDispatcher(taskStore, wsHub, logger);

    const rawMsg = encodeWire(MsgTypeStatusUpdate, {
      agent_aid: 'aid-001',
      status: 'busy',
    });

    dispatcher.handleWSMessage('tid-001', rawMsg);
    await flushMicrotasks();

    const infoCalls = logger.calls['info']!;
    const hasUpdate = infoCalls.some(([msg]) => msg === 'status update received');
    expect(hasUpdate).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sendContainerInit — sends correct message format
// ---------------------------------------------------------------------------

describe('sendContainerInit', () => {
  it('sends container_init message with correct shape', async () => {
    const taskStore = makeTaskStore();
    const wsHub = makeWSHub();
    const dispatcher = newDispatcher(taskStore, wsHub, makeLogger());

    wsHub.sent.length = 0;

    const agents: AgentInitConfig[] = [
      {
        aid: 'aid-001',
        name: 'Main Agent',
        provider: { type: 'oauth', oauth_token: 'tok-123' },
        model_tier: 'sonnet',
      },
    ];
    const secrets: Record<string, string> = { GITHUB_TOKEN: 'ghp_abc' };

    await dispatcher.sendContainerInit('tid-main', true, agents, secrets, '/workspace/main');

    expect(wsHub.sent).toHaveLength(1);
    const sent = wsHub.sent[0]!;
    expect(sent.teamID).toBe('tid-main');

    const envelope = JSON.parse(sent.msg) as {
      type: string;
      data: {
        is_main_assistant: boolean;
        team_config: JsonValue;
        agents: AgentInitConfig[];
        secrets: Record<string, string>;
        workspace_root: string;
      };
    };

    expect(envelope.type).toBe(MsgTypeContainerInit);
    expect(envelope.data.is_main_assistant).toBe(true);
    expect(envelope.data.agents).toHaveLength(1);
    expect(envelope.data.agents[0]!.aid).toBe('aid-001');
    expect(envelope.data.secrets).toEqual({ GITHUB_TOKEN: 'ghp_abc' });
    expect(envelope.data.workspace_root).toBe('/workspace/main');
  });

  it('propagates WS send error', async () => {
    const taskStore = makeTaskStore();
    const wsHub = makeWSHub({
      async sendToTeam(_teamID: string, _msg: Buffer | string) {
        throw new Error('not connected');
      },
    });
    const dispatcher = newDispatcher(taskStore, wsHub, makeLogger());

    await expect(
      dispatcher.sendContainerInit('tid-dead', false, [], {}, '/ws'),
    ).rejects.toThrow('not connected');
  });
});

// ---------------------------------------------------------------------------
// newDispatcher factory
// ---------------------------------------------------------------------------

describe('newDispatcher', () => {
  it('creates a Dispatcher instance', () => {
    const taskStore = makeTaskStore();
    const wsHub = makeWSHub();
    const dispatcher = newDispatcher(taskStore, wsHub, makeLogger());

    expect(dispatcher).toBeInstanceOf(Dispatcher);
    expect(typeof dispatcher.createAndDispatch).toBe('function');
    expect(typeof dispatcher.handleResult).toBe('function');
    expect(typeof dispatcher.handleWSMessage).toBe('function');
    expect(typeof dispatcher.sendContainerInit).toBe('function');
  });
});
