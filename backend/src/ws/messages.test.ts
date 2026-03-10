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
  MsgTypeAgentAdded,
  MsgTypeEscalationResponse,
  MsgTypeTaskCancel,
  // Message type constants — Container-to-Backend
  MsgTypeReady,
  MsgTypeHeartbeat,
  MsgTypeTaskResult,
  MsgTypeEscalation,
  MsgTypeLogEvent,
  MsgTypeToolCall,
  MsgTypeStatusUpdate,
  MsgTypeAgentReady,
  MsgTypeOrgChartUpdate,
  // WS error codes
  WSErrorNotFound,
  WSErrorValidation,
  WSErrorConflict,
  WSErrorEncryptionLocked,
  WSErrorRateLimited,
  WSErrorAccessDenied,
  WSErrorInternal,
  WSErrorDepthLimitExceeded,
  WSErrorCycleDetected,
  // Protocol version
  PROTOCOL_VERSION,
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
  EscalationResponseMsg,
  TaskCancelMsg,
  ReadyMsg,
  HeartbeatMsg,
  AgentStatus,
  TaskResultMsg,
  EscalationMsg,
  LogEventMsg,
  ToolCallMsg,
  StatusUpdateMsg,
  AgentReadyMsg,
  OrgChartUpdateMsg,
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

  it('MsgTypeAgentAdded equals "agent_added"', () => {
    expect(MsgTypeAgentAdded).toBe('agent_added');
  });

  it('MsgTypeEscalationResponse equals "escalation_response"', () => {
    expect(MsgTypeEscalationResponse).toBe('escalation_response');
  });

  it('MsgTypeTaskCancel equals "task_cancel"', () => {
    expect(MsgTypeTaskCancel).toBe('task_cancel');
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

  it('MsgTypeAgentReady equals "agent_ready"', () => {
    expect(MsgTypeAgentReady).toBe('agent_ready');
  });

  it('MsgTypeLogEvent equals "log_event"', () => {
    expect(MsgTypeLogEvent).toBe('log_event');
  });

  it('MsgTypeOrgChartUpdate equals "org_chart_update"', () => {
    expect(MsgTypeOrgChartUpdate).toBe('org_chart_update');
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

  it('WSErrorDepthLimitExceeded equals "DEPTH_LIMIT_EXCEEDED"', () => {
    expect(WSErrorDepthLimitExceeded).toBe('DEPTH_LIMIT_EXCEEDED');
  });

  it('WSErrorCycleDetected equals "CYCLE_DETECTED"', () => {
    expect(WSErrorCycleDetected).toBe('CYCLE_DETECTED');
  });

  it('all 9 WS error code constants have the expected values', () => {
    const expectedValues = [
      'NOT_FOUND',
      'VALIDATION_ERROR',
      'CONFLICT',
      'ENCRYPTION_LOCKED',
      'RATE_LIMITED',
      'ACCESS_DENIED',
      'INTERNAL_ERROR',
      'DEPTH_LIMIT_EXCEEDED',
      'CYCLE_DETECTED',
    ];
    const actualValues = [
      WSErrorNotFound,
      WSErrorValidation,
      WSErrorConflict,
      WSErrorEncryptionLocked,
      WSErrorRateLimited,
      WSErrorAccessDenied,
      WSErrorInternal,
      WSErrorDepthLimitExceeded,
      WSErrorCycleDetected,
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
      workspace_root: '/workspace',
    };
    expect(msg.is_main_assistant).toBe(true);
    expect(msg.team_config).toEqual({ slug: 'main' });
    expect(msg.agents).toEqual([]);
    expect(msg.secrets).toEqual({ KEY: 'val' });
    expect(msg.workspace_root).toBe('/workspace');
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
      blocked_by: ['task-100'],
    };
    expect(msg.task_id).toBe('task-123');
    expect(msg.agent_aid).toBe('aid-abc');
    expect(msg.prompt).toBe('Do something');
    expect(msg.session_id).toBe('sess-1');
    expect(msg.work_dir).toBe('/work/tasks/task-123');
    expect(msg.blocked_by).toEqual(['task-100']);
  });

  it('includes optional priority and max_retries fields', () => {
    const msg: TaskDispatchMsg = {
      task_id: 'task-456',
      agent_aid: 'aid-def',
      prompt: 'High priority task',
      blocked_by: [],
      priority: 5,
      max_retries: 3,
    };
    expect(msg.priority).toBe(5);
    expect(msg.max_retries).toBe(3);
  });

  it('allows priority and max_retries to be omitted (backward compat)', () => {
    const msg: TaskDispatchMsg = {
      task_id: 'task-789',
      agent_aid: 'aid-ghi',
      prompt: 'Normal task',
      blocked_by: [],
    };
    expect(msg.priority).toBeUndefined();
    expect(msg.max_retries).toBeUndefined();
  });

  it('serializes and deserializes with priority and max_retries via parseWSMessage', () => {
    const data: TaskDispatchMsg = {
      task_id: 't-dag',
      agent_aid: 'aid-dag',
      prompt: 'dag task',
      blocked_by: ['t-dep-1', 't-dep-2'],
      priority: 10,
      max_retries: 2,
    };
    const raw = JSON.stringify({ type: 'task_dispatch', data });
    const msg = parseWSMessage(raw);
    expect(msg.type).toBe('task_dispatch');
    if (msg.type === 'task_dispatch') {
      expect(msg.data.blocked_by).toEqual(['t-dep-1', 't-dep-2']);
      expect(msg.data.priority).toBe(10);
      expect(msg.data.max_retries).toBe(2);
    }
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
      correlation_id: 'esc-corr-1',
      task_id: 'task-1',
      agent_aid: 'aid-abc',
      source_team: 'tid-team-a',
      destination_team: 'tid-team-b',
      escalation_level: 1,
      reason: 'needs supervisor',
      context: { detail: 'some context' },
    };
    expect(msg.correlation_id).toBe('esc-corr-1');
    expect(msg.task_id).toBe('task-1');
    expect(msg.agent_aid).toBe('aid-abc');
    expect(msg.source_team).toBe('tid-team-a');
    expect(msg.destination_team).toBe('tid-team-b');
    expect(msg.escalation_level).toBe(1);
    expect(msg.reason).toBe('needs supervisor');
    expect(msg.context).toEqual({ detail: 'some context' });
  });
});

describe('EscalationResponseMsg interface', () => {
  it('has correct snake_case field names', () => {
    const msg: EscalationResponseMsg = {
      correlation_id: 'esc-resp-1',
      task_id: 'task-5',
      agent_aid: 'aid-lead',
      source_team: 'tid-parent',
      destination_team: 'tid-child',
      resolution: 'use approach B',
      context: { confidence: 'high' },
    };
    expect(msg.correlation_id).toBe('esc-resp-1');
    expect(msg.task_id).toBe('task-5');
    expect(msg.resolution).toBe('use approach B');
    expect(msg.context).toEqual({ confidence: 'high' });
  });
});

describe('TaskCancelMsg interface', () => {
  it('has correct snake_case field names', () => {
    const msg: TaskCancelMsg = {
      task_id: 'task-cancel-1',
      cascade: true,
      reason: 'no longer needed',
    };
    expect(msg.task_id).toBe('task-cancel-1');
    expect(msg.cascade).toBe(true);
    expect(msg.reason).toBe('no longer needed');
  });

  it('allows optional reason to be omitted', () => {
    const msg: TaskCancelMsg = { task_id: 'task-1', cascade: false };
    expect(msg.reason).toBeUndefined();
  });
});

describe('LogEventMsg interface', () => {
  it('has correct snake_case field names', () => {
    const msg: LogEventMsg = {
      level: 'info',
      source_aid: 'aid-worker-1',
      message: 'task started',
      metadata: { task_id: 'task-10' },
      timestamp: '2026-03-08T15:00:00.000Z',
    };
    expect(msg.level).toBe('info');
    expect(msg.source_aid).toBe('aid-worker-1');
    expect(msg.message).toBe('task started');
    expect(msg.metadata).toEqual({ task_id: 'task-10' });
    expect(msg.timestamp).toBe('2026-03-08T15:00:00.000Z');
  });
});

describe('OrgChartUpdateMsg interface', () => {
  it('has correct snake_case field names', () => {
    const msg: OrgChartUpdateMsg = {
      action: 'agent_added',
      team_slug: 'backend-team',
      agent_aid: 'aid-new-dev',
      agent_name: 'new-dev',
      timestamp: '2026-03-08T15:00:00.000Z',
    };
    expect(msg.action).toBe('agent_added');
    expect(msg.team_slug).toBe('backend-team');
    expect(msg.agent_aid).toBe('aid-new-dev');
    expect(msg.agent_name).toBe('new-dev');
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
      blocked_by: ['t-0'],
    };
    const raw = JSON.stringify({ type: 'task_dispatch', data });
    const msg = parseWSMessage(raw);
    expect(msg.type).toBe('task_dispatch');
    if (msg.type === 'task_dispatch') {
      expect(msg.data.task_id).toBe('t-1');
      expect(msg.data.prompt).toBe('go');
      expect(msg.data.blocked_by).toEqual(['t-0']);
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
      correlation_id: 'esc-corr-1',
      task_id: 'task-3',
      agent_aid: 'aid-3',
      source_team: 'tid-src',
      destination_team: 'tid-dest',
      escalation_level: 1,
      reason: 'stuck',
      context: { detail: 'blocked on external API' },
    };
    const raw = JSON.stringify({ type: 'escalation', data });
    const msg = parseWSMessage(raw);
    expect(msg.type).toBe('escalation');
    if (msg.type === 'escalation') {
      expect(msg.data.correlation_id).toBe('esc-corr-1');
      expect(msg.data.task_id).toBe('task-3');
      expect(msg.data.reason).toBe('stuck');
      expect(msg.data.escalation_level).toBe(1);
      expect(msg.data.context).toEqual({ detail: 'blocked on external API' });
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

  it('parses agent_added and data is AgentAddedMsg shape', () => {
    const data = {
      agent: {
        aid: 'aid-new',
        name: 'new-worker',
        provider: { type: 'oauth', oauth_token: 'tok' },
        model_tier: 'sonnet',
      },
    };
    const raw = JSON.stringify({ type: 'agent_added', data });
    const msg = parseWSMessage(raw);
    expect(msg.type).toBe('agent_added');
    if (msg.type === 'agent_added') {
      expect(msg.data.agent.aid).toBe('aid-new');
      expect(msg.data.agent.name).toBe('new-worker');
    }
  });

  it('parses escalation_response and data is EscalationResponseMsg shape', () => {
    const data: EscalationResponseMsg = {
      correlation_id: 'esc-resp-1',
      task_id: 'task-5',
      agent_aid: 'aid-lead',
      source_team: 'tid-parent',
      destination_team: 'tid-child',
      resolution: 'use approach B',
      context: { confidence: 'high' },
    };
    const raw = JSON.stringify({ type: 'escalation_response', data });
    const msg = parseWSMessage(raw);
    expect(msg.type).toBe('escalation_response');
    if (msg.type === 'escalation_response') {
      expect(msg.data.correlation_id).toBe('esc-resp-1');
      expect(msg.data.resolution).toBe('use approach B');
      expect(msg.data.context).toEqual({ confidence: 'high' });
    }
  });

  it('parses task_cancel and data is TaskCancelMsg shape', () => {
    const data: TaskCancelMsg = {
      task_id: 'task-cancel-1',
      cascade: true,
      reason: 'no longer needed',
    };
    const raw = JSON.stringify({ type: 'task_cancel', data });
    const msg = parseWSMessage(raw);
    expect(msg.type).toBe('task_cancel');
    if (msg.type === 'task_cancel') {
      expect(msg.data.task_id).toBe('task-cancel-1');
      expect(msg.data.cascade).toBe(true);
      expect(msg.data.reason).toBe('no longer needed');
    }
  });

  it('parses agent_ready and data is AgentReadyMsg shape', () => {
    const data: AgentReadyMsg = { aid: 'aid-ready-1' };
    const raw = JSON.stringify({ type: 'agent_ready', data });
    const msg = parseWSMessage(raw);
    expect(msg.type).toBe('agent_ready');
    if (msg.type === 'agent_ready') {
      expect(msg.data.aid).toBe('aid-ready-1');
    }
  });

  it('parses log_event and data is LogEventMsg shape', () => {
    const data: LogEventMsg = {
      level: 'warn',
      source_aid: 'aid-worker-2',
      message: 'high memory usage',
      metadata: { memory_mb: 512 },
      timestamp: '2026-03-08T16:00:00.000Z',
    };
    const raw = JSON.stringify({ type: 'log_event', data });
    const msg = parseWSMessage(raw);
    expect(msg.type).toBe('log_event');
    if (msg.type === 'log_event') {
      expect(msg.data.level).toBe('warn');
      expect(msg.data.source_aid).toBe('aid-worker-2');
      expect(msg.data.message).toBe('high memory usage');
      expect(msg.data.metadata).toEqual({ memory_mb: 512 });
    }
  });

  it('parses org_chart_update and data is OrgChartUpdateMsg shape', () => {
    const data: OrgChartUpdateMsg = {
      action: 'agent_removed',
      team_slug: 'backend-team',
      agent_aid: 'aid-old',
      agent_name: 'old-worker',
      timestamp: '2026-03-08T16:00:00.000Z',
    };
    const raw = JSON.stringify({ type: 'org_chart_update', data });
    const msg = parseWSMessage(raw);
    expect(msg.type).toBe('org_chart_update');
    if (msg.type === 'org_chart_update') {
      expect(msg.data.action).toBe('agent_removed');
      expect(msg.data.team_slug).toBe('backend-team');
      expect(msg.data.agent_aid).toBe('aid-old');
    }
  });
});

// ---------------------------------------------------------------------------
// PROTOCOL_VERSION constant
// ---------------------------------------------------------------------------

describe('PROTOCOL_VERSION constant', () => {
  it('equals "1.0"', () => {
    expect(PROTOCOL_VERSION).toBe('1.0');
  });

  it('is a string type', () => {
    expect(typeof PROTOCOL_VERSION).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// ContainerInitMsg with protocol_version field
// ---------------------------------------------------------------------------

describe('ContainerInitMsg with protocol_version', () => {
  it('serializes and deserializes with protocol_version field', () => {
    const msg: ContainerInitMsg = {
      is_main_assistant: true,
      team_config: { slug: 'main' },
      agents: [],
      protocol_version: '1.0',
    };
    const raw = JSON.stringify({ type: 'container_init', data: msg });
    const parsed = parseWSMessage(raw);
    expect(parsed.type).toBe('container_init');
    if (parsed.type === 'container_init') {
      expect(parsed.data.protocol_version).toBe('1.0');
      expect(parsed.data.is_main_assistant).toBe(true);
    }
  });

  it('allows protocol_version to be omitted (backward compat)', () => {
    const msg: ContainerInitMsg = {
      is_main_assistant: false,
      team_config: {},
      agents: [],
    };
    expect(msg.protocol_version).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ReadyMsg with protocol_version field
// ---------------------------------------------------------------------------

describe('ReadyMsg with protocol_version', () => {
  it('serializes and deserializes with protocol_version field', () => {
    const msg: ReadyMsg = {
      team_id: 'tid-abc',
      agent_count: 2,
      protocol_version: '1.0',
    };
    const raw = JSON.stringify({ type: 'ready', data: msg });
    const parsed = parseWSMessage(raw);
    expect(parsed.type).toBe('ready');
    if (parsed.type === 'ready') {
      expect(parsed.data.protocol_version).toBe('1.0');
      expect(parsed.data.team_id).toBe('tid-abc');
      expect(parsed.data.agent_count).toBe(2);
    }
  });

  it('allows protocol_version to be omitted (backward compat)', () => {
    const msg: ReadyMsg = { team_id: 'tid-xyz', agent_count: 1 };
    expect(msg.protocol_version).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// All 16 message types covered — completeness check
// ---------------------------------------------------------------------------

describe('All 16 message types covered', () => {
  const allTypes = [
    // Backend-to-Container (7)
    'container_init',
    'task_dispatch',
    'shutdown',
    'tool_result',
    'agent_added',
    'escalation_response',
    'task_cancel',
    // Container-to-Backend (9)
    'ready',
    'heartbeat',
    'task_result',
    'escalation',
    'log_event',
    'tool_call',
    'status_update',
    'agent_ready',
    'org_chart_update',
  ];

  it('all 16 message type constants export the expected string values', () => {
    const exported = [
      // Backend-to-Container
      MsgTypeContainerInit,
      MsgTypeTaskDispatch,
      MsgTypeShutdown,
      MsgTypeToolResult,
      MsgTypeAgentAdded,
      MsgTypeEscalationResponse,
      MsgTypeTaskCancel,
      // Container-to-Backend
      MsgTypeReady,
      MsgTypeHeartbeat,
      MsgTypeTaskResult,
      MsgTypeEscalation,
      MsgTypeLogEvent,
      MsgTypeToolCall,
      MsgTypeStatusUpdate,
      MsgTypeAgentReady,
      MsgTypeOrgChartUpdate,
    ];
    expect(exported).toEqual(allTypes);
  });

  it('parseWSMessage succeeds for all 16 known message types', () => {
    for (const type of allTypes) {
      const raw = JSON.stringify({ type, data: {} });
      // Should not throw
      const msg = parseWSMessage(raw);
      expect(msg.type).toBe(type);
    }
  });
});
