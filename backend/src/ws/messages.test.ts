/**
 * Tests for backend/src/ws/messages.ts
 *
 * Verifies:
 *   1. All message type constants have the expected values
 *   2. All message interfaces compile with correct field names (structural tests)
 *   3. WS error codes have the expected values
 *   4. parseWSMessage correctly narrows type for each message variant
 *   5. parseWSMessage throws on invalid JSON
 *   6. parseWSMessage throws on unrecognised message type
 */

import { describe, it, expect } from 'vitest';
import {
  // Message type constants — Backend-to-Container
  MsgTypeContainerInit,
  MsgTypeTaskDispatch,
  MsgTypeShutdown,
  MsgTypeToolResult,
  // Message type constants — Container-to-Backend
  MsgTypeReady,
  MsgTypeHeartbeat,
  MsgTypeTaskResult,
  MsgTypeEscalation,
  MsgTypeToolCall,
  MsgTypeStatusUpdate,
  // WS error codes
  WSErrorNotFound,
  WSErrorValidation,
  WSErrorConflict,
  WSErrorEncryptionLocked,
  WSErrorRateLimited,
  WSErrorAccessDenied,
  WSErrorInternal,
  // Parser
  parseWSMessage,
} from './messages.js';

import type {
  ContainerInitMsg,
  AgentInitConfig,
  ProviderConfig,
  MCPServerConfig,
  TaskDispatchMsg,
  ShutdownMsg,
  ToolResultMsg,
  ReadyMsg,
  HeartbeatMsg,
  AgentStatus,
  TaskResultMsg,
  EscalationMsg,
  ToolCallMsg,
  StatusUpdateMsg,
  WSMessage,
} from './messages.js';

// ---------------------------------------------------------------------------
// Message type constants — Backend-to-Container
// ---------------------------------------------------------------------------

describe('Backend-to-Container message type constants', () => {
  it('MsgTypeContainerInit equals "container_init"', () => {
    expect(MsgTypeContainerInit).toBe('container_init');
  });

  it('MsgTypeTaskDispatch equals "task_dispatch"', () => {
    expect(MsgTypeTaskDispatch).toBe('task_dispatch');
  });

  it('MsgTypeShutdown equals "shutdown"', () => {
    expect(MsgTypeShutdown).toBe('shutdown');
  });

  it('MsgTypeToolResult equals "tool_result"', () => {
    expect(MsgTypeToolResult).toBe('tool_result');
  });
});

// ---------------------------------------------------------------------------
// Message type constants — Container-to-Backend
// ---------------------------------------------------------------------------

describe('Container-to-Backend message type constants', () => {
  it('MsgTypeReady equals "ready"', () => {
    expect(MsgTypeReady).toBe('ready');
  });

  it('MsgTypeHeartbeat equals "heartbeat"', () => {
    expect(MsgTypeHeartbeat).toBe('heartbeat');
  });

  it('MsgTypeTaskResult equals "task_result"', () => {
    expect(MsgTypeTaskResult).toBe('task_result');
  });

  it('MsgTypeEscalation equals "escalation"', () => {
    expect(MsgTypeEscalation).toBe('escalation');
  });

  it('MsgTypeToolCall equals "tool_call"', () => {
    expect(MsgTypeToolCall).toBe('tool_call');
  });

  it('MsgTypeStatusUpdate equals "status_update"', () => {
    expect(MsgTypeStatusUpdate).toBe('status_update');
  });
});

// ---------------------------------------------------------------------------
// WS error code constants
// ---------------------------------------------------------------------------

describe('WS error code constants', () => {
  it('WSErrorNotFound equals "NOT_FOUND"', () => {
    expect(WSErrorNotFound).toBe('NOT_FOUND');
  });

  it('WSErrorValidation equals "VALIDATION_ERROR"', () => {
    expect(WSErrorValidation).toBe('VALIDATION_ERROR');
  });

  it('WSErrorConflict equals "CONFLICT"', () => {
    expect(WSErrorConflict).toBe('CONFLICT');
  });

  it('WSErrorEncryptionLocked equals "ENCRYPTION_LOCKED"', () => {
    expect(WSErrorEncryptionLocked).toBe('ENCRYPTION_LOCKED');
  });

  it('WSErrorRateLimited equals "RATE_LIMITED"', () => {
    expect(WSErrorRateLimited).toBe('RATE_LIMITED');
  });

  it('WSErrorAccessDenied equals "ACCESS_DENIED"', () => {
    expect(WSErrorAccessDenied).toBe('ACCESS_DENIED');
  });

  it('WSErrorInternal equals "INTERNAL_ERROR"', () => {
    expect(WSErrorInternal).toBe('INTERNAL_ERROR');
  });

  it('all 7 WS error code constants have the expected values', () => {
    const expectedValues = [
      'NOT_FOUND',
      'VALIDATION_ERROR',
      'CONFLICT',
      'ENCRYPTION_LOCKED',
      'RATE_LIMITED',
      'ACCESS_DENIED',
      'INTERNAL_ERROR',
    ];
    const actualValues = [
      WSErrorNotFound,
      WSErrorValidation,
      WSErrorConflict,
      WSErrorEncryptionLocked,
      WSErrorRateLimited,
      WSErrorAccessDenied,
      WSErrorInternal,
    ];
    expect(actualValues).toEqual(expectedValues);
  });
});

// ---------------------------------------------------------------------------
// Message interface structural tests (snake_case field names)
// ---------------------------------------------------------------------------

describe('ProviderConfig interface', () => {
  it('has correct snake_case field names', () => {
    const msg: ProviderConfig = {
      type: 'oauth',
      api_key: 'key',
      api_url: 'https://example.com',
      oauth_token: 'tok',
    };
    expect(msg.type).toBe('oauth');
    expect(msg.api_key).toBe('key');
    expect(msg.api_url).toBe('https://example.com');
    expect(msg.oauth_token).toBe('tok');
  });

  it('allows optional fields to be omitted', () => {
    const minimal: ProviderConfig = { type: 'oauth' };
    expect(minimal.type).toBe('oauth');
    expect(minimal.api_key).toBeUndefined();
  });
});

describe('MCPServerConfig interface', () => {
  it('has correct snake_case field names', () => {
    const msg: MCPServerConfig = {
      name: 'github',
      command: 'npx',
      args: ['mcp-github'],
      env: { TOKEN: 'abc' },
    };
    expect(msg.name).toBe('github');
    expect(msg.command).toBe('npx');
    expect(msg.args).toEqual(['mcp-github']);
    expect(msg.env).toEqual({ TOKEN: 'abc' });
  });
});

describe('AgentInitConfig interface', () => {
  it('has correct snake_case field names', () => {
    const provider: ProviderConfig = { type: 'oauth', oauth_token: 'tok' };
    const msg: AgentInitConfig = {
      aid: 'aid-abc-123',
      name: 'main-assistant',
      provider,
      model_tier: 'sonnet',
      skills: ['coding'],
    };
    expect(msg.aid).toBe('aid-abc-123');
    expect(msg.name).toBe('main-assistant');
    expect(msg.provider).toBe(provider);
    expect(msg.model_tier).toBe('sonnet');
    expect(msg.skills).toEqual(['coding']);
  });
});

describe('ContainerInitMsg interface', () => {
  it('has correct snake_case field names', () => {
    const msg: ContainerInitMsg = {
      is_main_assistant: true,
      team_config: { slug: 'main' },
      agents: [],
      secrets: { KEY: 'val' },
      mcp_servers: [],
      workspace_root: '/teams/main',
    };
    expect(msg.is_main_assistant).toBe(true);
    expect(msg.team_config).toEqual({ slug: 'main' });
    expect(msg.agents).toEqual([]);
    expect(msg.secrets).toEqual({ KEY: 'val' });
    expect(msg.workspace_root).toBe('/teams/main');
  });
});

describe('TaskDispatchMsg interface', () => {
  it('has correct snake_case field names', () => {
    const msg: TaskDispatchMsg = {
      task_id: 'task-123',
      agent_aid: 'aid-abc',
      prompt: 'Do something',
      session_id: 'sess-1',
      work_dir: '/work/tasks/task-123',
    };
    expect(msg.task_id).toBe('task-123');
    expect(msg.agent_aid).toBe('aid-abc');
    expect(msg.prompt).toBe('Do something');
    expect(msg.session_id).toBe('sess-1');
    expect(msg.work_dir).toBe('/work/tasks/task-123');
  });
});

describe('ShutdownMsg interface', () => {
  it('has correct field names', () => {
    const msg: ShutdownMsg = { reason: 'graceful', timeout: 30 };
    expect(msg.reason).toBe('graceful');
    expect(msg.timeout).toBe(30);
  });
});

describe('ToolResultMsg interface', () => {
  it('has correct snake_case field names (success path)', () => {
    const msg: ToolResultMsg = {
      call_id: 'call-1',
      result: { ok: true },
    };
    expect(msg.call_id).toBe('call-1');
    expect(msg.result).toEqual({ ok: true });
  });

  it('has correct snake_case field names (error path)', () => {
    const msg: ToolResultMsg = {
      call_id: 'call-2',
      error_code: WSErrorNotFound,
      error_message: 'team not found: main',
    };
    expect(msg.error_code).toBe('NOT_FOUND');
    expect(msg.error_message).toBe('team not found: main');
  });
});

describe('ReadyMsg interface', () => {
  it('has correct snake_case field names', () => {
    const msg: ReadyMsg = { team_id: 'tid-abc', agent_count: 3 };
    expect(msg.team_id).toBe('tid-abc');
    expect(msg.agent_count).toBe(3);
  });
});

describe('AgentStatus interface', () => {
  it('has correct snake_case field names', () => {
    const msg: AgentStatus = {
      aid: 'aid-abc',
      status: 'idle',
      detail: 'waiting',
      elapsed_seconds: 12.5,
      memory_mb: 64.0,
    };
    expect(msg.aid).toBe('aid-abc');
    expect(msg.status).toBe('idle');
    expect(msg.detail).toBe('waiting');
    expect(msg.elapsed_seconds).toBe(12.5);
    expect(msg.memory_mb).toBe(64.0);
  });
});

describe('HeartbeatMsg interface', () => {
  it('has correct snake_case field names', () => {
    const msg: HeartbeatMsg = {
      team_id: 'tid-xyz',
      agents: [{ aid: 'aid-1', status: 'busy', elapsed_seconds: 5, memory_mb: 32 }],
    };
    expect(msg.team_id).toBe('tid-xyz');
    expect(msg.agents).toHaveLength(1);
    expect(msg.agents[0].aid).toBe('aid-1');
  });
});

describe('TaskResultMsg interface', () => {
  it('has correct snake_case field names', () => {
    const msg: TaskResultMsg = {
      task_id: 'task-1',
      agent_aid: 'aid-abc',
      status: 'completed',
      result: 'done',
      files_created: ['/out/file.txt'],
      duration: 5000000000, // 5s in nanoseconds
    };
    expect(msg.task_id).toBe('task-1');
    expect(msg.agent_aid).toBe('aid-abc');
    expect(msg.status).toBe('completed');
    expect(msg.result).toBe('done');
    expect(msg.files_created).toEqual(['/out/file.txt']);
    expect(msg.duration).toBe(5000000000);
  });
});

describe('EscalationMsg interface', () => {
  it('has correct snake_case field names', () => {
    const msg: EscalationMsg = {
      task_id: 'task-1',
      agent_aid: 'aid-abc',
      reason: 'needs supervisor',
      context: 'some context',
    };
    expect(msg.task_id).toBe('task-1');
    expect(msg.agent_aid).toBe('aid-abc');
    expect(msg.reason).toBe('needs supervisor');
    expect(msg.context).toBe('some context');
  });
});

describe('ToolCallMsg interface', () => {
  it('has correct snake_case field names', () => {
    const msg: ToolCallMsg = {
      call_id: 'call-99',
      tool_name: 'create_team',
      arguments: { name: 'backend' },
      agent_aid: 'aid-main',
    };
    expect(msg.call_id).toBe('call-99');
    expect(msg.tool_name).toBe('create_team');
    expect(msg.arguments).toEqual({ name: 'backend' });
    expect(msg.agent_aid).toBe('aid-main');
  });
});

describe('StatusUpdateMsg interface', () => {
  it('has correct snake_case field names', () => {
    const msg: StatusUpdateMsg = {
      agent_aid: 'aid-abc',
      status: 'busy',
      detail: 'processing task',
    };
    expect(msg.agent_aid).toBe('aid-abc');
    expect(msg.status).toBe('busy');
    expect(msg.detail).toBe('processing task');
  });
});

// ---------------------------------------------------------------------------
// parseWSMessage — invalid JSON
// ---------------------------------------------------------------------------

describe('parseWSMessage — invalid JSON', () => {
  it('throws on non-JSON string', () => {
    expect(() => parseWSMessage('not json')).toThrow(
      'invalid WebSocket message: not valid JSON',
    );
  });

  it('throws on empty string', () => {
    expect(() => parseWSMessage('')).toThrow(
      'invalid WebSocket message: not valid JSON',
    );
  });

  it('throws on truncated JSON', () => {
    expect(() => parseWSMessage('{"type":"ready"')).toThrow(
      'invalid WebSocket message: not valid JSON',
    );
  });
});

// ---------------------------------------------------------------------------
// parseWSMessage — invalid envelope shape
// ---------------------------------------------------------------------------

describe('parseWSMessage — invalid envelope shape', () => {
  it('throws when envelope is a plain string JSON value', () => {
    expect(() => parseWSMessage('"hello"')).toThrow('invalid WebSocket message');
  });

  it('throws when envelope is a JSON array', () => {
    expect(() => parseWSMessage('[1, 2, 3]')).toThrow('invalid WebSocket message');
  });

  it('throws when envelope is a number', () => {
    expect(() => parseWSMessage('42')).toThrow('invalid WebSocket message');
  });

  it('throws when type field is missing', () => {
    expect(() => parseWSMessage('{"data":{}}')).toThrow('invalid WebSocket message');
  });

  it('throws when type field is not a string', () => {
    expect(() => parseWSMessage('{"type":42,"data":{}}')).toThrow(
      'invalid WebSocket message',
    );
  });
});

// ---------------------------------------------------------------------------
// parseWSMessage — unrecognised message type
// ---------------------------------------------------------------------------

describe('parseWSMessage — unrecognised message type', () => {
  it('throws on unknown message type', () => {
    const raw = JSON.stringify({ type: 'unknown_type', data: {} });
    expect(() => parseWSMessage(raw)).toThrow(
      'invalid WebSocket message: unrecognised message type "unknown_type"',
    );
  });

  it('throws on empty type string', () => {
    const raw = JSON.stringify({ type: '', data: {} });
    expect(() => parseWSMessage(raw)).toThrow(
      'invalid WebSocket message: unrecognised message type ""',
    );
  });

  it('throws on type with wrong casing', () => {
    const raw = JSON.stringify({ type: 'READY', data: {} });
    expect(() => parseWSMessage(raw)).toThrow(
      'invalid WebSocket message: unrecognised message type "READY"',
    );
  });

  it('throws on camelCase type', () => {
    const raw = JSON.stringify({ type: 'containerInit', data: {} });
    expect(() => parseWSMessage(raw)).toThrow(
      'invalid WebSocket message: unrecognised message type "containerInit"',
    );
  });
});

// ---------------------------------------------------------------------------
// parseWSMessage — correct type narrowing for all 10 message variants
// ---------------------------------------------------------------------------

describe('parseWSMessage — correct type narrowing', () => {
  it('parses container_init and data is ContainerInitMsg shape', () => {
    const data: ContainerInitMsg = {
      is_main_assistant: false,
      team_config: { slug: 'backend' },
      agents: [],
    };
    const raw = JSON.stringify({ type: 'container_init', data });
    const msg: WSMessage = parseWSMessage(raw);
    expect(msg.type).toBe('container_init');
    if (msg.type === 'container_init') {
      expect(msg.data.is_main_assistant).toBe(false);
      expect(msg.data.team_config).toEqual({ slug: 'backend' });
    }
  });

  it('parses task_dispatch and data is TaskDispatchMsg shape', () => {
    const data: TaskDispatchMsg = {
      task_id: 't-1',
      agent_aid: 'aid-1',
      prompt: 'go',
    };
    const raw = JSON.stringify({ type: 'task_dispatch', data });
    const msg = parseWSMessage(raw);
    expect(msg.type).toBe('task_dispatch');
    if (msg.type === 'task_dispatch') {
      expect(msg.data.task_id).toBe('t-1');
      expect(msg.data.prompt).toBe('go');
    }
  });

  it('parses shutdown and data is ShutdownMsg shape', () => {
    const data: ShutdownMsg = { reason: 'done', timeout: 10 };
    const raw = JSON.stringify({ type: 'shutdown', data });
    const msg = parseWSMessage(raw);
    expect(msg.type).toBe('shutdown');
    if (msg.type === 'shutdown') {
      expect(msg.data.reason).toBe('done');
      expect(msg.data.timeout).toBe(10);
    }
  });

  it('parses tool_result and data is ToolResultMsg shape', () => {
    const data: ToolResultMsg = { call_id: 'c-1', result: { ok: true } };
    const raw = JSON.stringify({ type: 'tool_result', data });
    const msg = parseWSMessage(raw);
    expect(msg.type).toBe('tool_result');
    if (msg.type === 'tool_result') {
      expect(msg.data.call_id).toBe('c-1');
    }
  });

  it('parses ready and data is ReadyMsg shape', () => {
    const data: ReadyMsg = { team_id: 'tid-1', agent_count: 2 };
    const raw = JSON.stringify({ type: 'ready', data });
    const msg = parseWSMessage(raw);
    expect(msg.type).toBe('ready');
    if (msg.type === 'ready') {
      expect(msg.data.team_id).toBe('tid-1');
      expect(msg.data.agent_count).toBe(2);
    }
  });

  it('parses heartbeat and data is HeartbeatMsg shape', () => {
    const data: HeartbeatMsg = {
      team_id: 'tid-2',
      agents: [{ aid: 'a1', status: 'idle', elapsed_seconds: 1, memory_mb: 10 }],
    };
    const raw = JSON.stringify({ type: 'heartbeat', data });
    const msg = parseWSMessage(raw);
    expect(msg.type).toBe('heartbeat');
    if (msg.type === 'heartbeat') {
      expect(msg.data.team_id).toBe('tid-2');
      expect(msg.data.agents).toHaveLength(1);
    }
  });

  it('parses task_result and data is TaskResultMsg shape', () => {
    const data: TaskResultMsg = {
      task_id: 'task-9',
      agent_aid: 'aid-9',
      status: 'completed',
      duration: 1000000,
    };
    const raw = JSON.stringify({ type: 'task_result', data });
    const msg = parseWSMessage(raw);
    expect(msg.type).toBe('task_result');
    if (msg.type === 'task_result') {
      expect(msg.data.task_id).toBe('task-9');
      expect(msg.data.status).toBe('completed');
    }
  });

  it('parses escalation and data is EscalationMsg shape', () => {
    const data: EscalationMsg = {
      task_id: 'task-3',
      agent_aid: 'aid-3',
      reason: 'stuck',
    };
    const raw = JSON.stringify({ type: 'escalation', data });
    const msg = parseWSMessage(raw);
    expect(msg.type).toBe('escalation');
    if (msg.type === 'escalation') {
      expect(msg.data.reason).toBe('stuck');
    }
  });

  it('parses tool_call and data is ToolCallMsg shape', () => {
    const data: ToolCallMsg = {
      call_id: 'call-5',
      tool_name: 'get_config',
      arguments: { key: 'val' },
      agent_aid: 'aid-5',
    };
    const raw = JSON.stringify({ type: 'tool_call', data });
    const msg = parseWSMessage(raw);
    expect(msg.type).toBe('tool_call');
    if (msg.type === 'tool_call') {
      expect(msg.data.tool_name).toBe('get_config');
      expect(msg.data.arguments).toEqual({ key: 'val' });
    }
  });

  it('parses status_update and data is StatusUpdateMsg shape', () => {
    const data: StatusUpdateMsg = {
      agent_aid: 'aid-7',
      status: 'busy',
    };
    const raw = JSON.stringify({ type: 'status_update', data });
    const msg = parseWSMessage(raw);
    expect(msg.type).toBe('status_update');
    if (msg.type === 'status_update') {
      expect(msg.data.agent_aid).toBe('aid-7');
      expect(msg.data.status).toBe('busy');
    }
  });
});

// ---------------------------------------------------------------------------
// All 10 message types covered — completeness check
// ---------------------------------------------------------------------------

describe('All 10 message types covered', () => {
  const allTypes = [
    'container_init',
    'task_dispatch',
    'shutdown',
    'tool_result',
    'ready',
    'heartbeat',
    'task_result',
    'escalation',
    'tool_call',
    'status_update',
  ];

  it('all 10 message type constants export the expected string values', () => {
    const exported = [
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
    ];
    expect(exported).toEqual(allTypes);
  });

  it('parseWSMessage succeeds for all 10 known message types', () => {
    for (const type of allTypes) {
      const raw = JSON.stringify({ type, data: {} });
      // Should not throw
      const msg = parseWSMessage(raw);
      expect(msg.type).toBe(type);
    }
  });
});
