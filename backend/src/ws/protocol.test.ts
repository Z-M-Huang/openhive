/**
 * Tests for backend/src/ws/protocol.ts
 *
 * Verifies:
 *   1. parseMessage correctly parses all 10 message types
 *   2. parseMessage rejects messages with missing required fields
 *   3. parseMessage rejects unknown message types
 *   4. validateDirection rejects container sending backend-to-container types
 *   5. mapDomainErrorToWSError maps each error type correctly
 *   6. sanitizeErrorMessage strips file paths and stack traces
 *   7. encodeMessage produces valid JSON envelope
 */

import { describe, it, expect } from 'vitest';

import {
  parseMessage,
  validateDirection,
  mapDomainErrorToWSError,
  sanitizeErrorMessage,
  encodeMessage,
} from './protocol.js';

import {
  NotFoundError,
  ValidationError,
  ConflictError,
  EncryptionLockedError,
  RateLimitedError,
  AccessDeniedError,
} from '../domain/errors.js';

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
  MsgTypeAgentAdded,
  MsgTypeAgentReady,
  MsgTypeEscalationResponse,
  MsgTypeTaskCancel,
  MsgTypeLogEvent,
  MsgTypeOrgChartUpdate,
  WSErrorNotFound,
  WSErrorValidation,
  WSErrorConflict,
  WSErrorEncryptionLocked,
  WSErrorRateLimited,
  WSErrorAccessDenied,
  WSErrorInternal,
  WSErrorDepthLimitExceeded,
  WSErrorCycleDetected,
} from './messages.js';

import type {
  ContainerInitMsg,
  TaskDispatchMsg,
  ShutdownMsg,
  ToolResultMsg,
  EscalationResponseMsg,
  TaskCancelMsg,
  ReadyMsg,
  HeartbeatMsg,
  TaskResultMsg,
  EscalationMsg,
  LogEventMsg,
  ToolCallMsg,
  StatusUpdateMsg,
  AgentReadyMsg,
  OrgChartUpdateMsg,
} from './messages.js';

// ---------------------------------------------------------------------------
// parseMessage — valid cases (all 10 message types)
// ---------------------------------------------------------------------------

describe('parseMessage — correctly parses all 10 message types', () => {
  it('parses container_init', () => {
    const data: ContainerInitMsg = {
      is_main_assistant: false,
      team_config: { slug: 'backend' },
      agents: [],
    };
    const raw = JSON.stringify({ type: MsgTypeContainerInit, data });
    const [msgType, payload] = parseMessage(raw);
    expect(msgType).toBe('container_init');
    const msg = payload as ContainerInitMsg;
    expect(msg.is_main_assistant).toBe(false);
    expect(msg.team_config).toEqual({ slug: 'backend' });
  });

  it('parses task_dispatch', () => {
    const data: TaskDispatchMsg = {
      task_id: 'task-1',
      agent_aid: 'aid-abc',
      prompt: 'Do work',
    };
    const raw = JSON.stringify({ type: MsgTypeTaskDispatch, data });
    const [msgType, payload] = parseMessage(raw);
    expect(msgType).toBe('task_dispatch');
    const msg = payload as TaskDispatchMsg;
    expect(msg.task_id).toBe('task-1');
    expect(msg.agent_aid).toBe('aid-abc');
    expect(msg.prompt).toBe('Do work');
  });

  it('parses shutdown', () => {
    const data: ShutdownMsg = { reason: 'graceful', timeout: 30 };
    const raw = JSON.stringify({ type: MsgTypeShutdown, data });
    const [msgType, payload] = parseMessage(raw);
    expect(msgType).toBe('shutdown');
    const msg = payload as ShutdownMsg;
    expect(msg.reason).toBe('graceful');
    expect(msg.timeout).toBe(30);
  });

  it('parses tool_result', () => {
    const data: ToolResultMsg = { call_id: 'call-1', result: { ok: true } };
    const raw = JSON.stringify({ type: MsgTypeToolResult, data });
    const [msgType, payload] = parseMessage(raw);
    expect(msgType).toBe('tool_result');
    const msg = payload as ToolResultMsg;
    expect(msg.call_id).toBe('call-1');
  });

  it('parses ready', () => {
    const data: ReadyMsg = { team_id: 'tid-xyz', agent_count: 3 };
    const raw = JSON.stringify({ type: MsgTypeReady, data });
    const [msgType, payload] = parseMessage(raw);
    expect(msgType).toBe('ready');
    const msg = payload as ReadyMsg;
    expect(msg.team_id).toBe('tid-xyz');
    expect(msg.agent_count).toBe(3);
  });

  it('parses heartbeat', () => {
    const data: HeartbeatMsg = {
      team_id: 'tid-1',
      agents: [{ aid: 'a1', status: 'idle', elapsed_seconds: 5, memory_mb: 32 }],
    };
    const raw = JSON.stringify({ type: MsgTypeHeartbeat, data });
    const [msgType, payload] = parseMessage(raw);
    expect(msgType).toBe('heartbeat');
    const msg = payload as HeartbeatMsg;
    expect(msg.team_id).toBe('tid-1');
    expect(msg.agents).toHaveLength(1);
  });

  it('parses task_result', () => {
    const data: TaskResultMsg = {
      task_id: 'task-9',
      agent_aid: 'aid-9',
      status: 'completed',
      duration: 1000000,
    };
    const raw = JSON.stringify({ type: MsgTypeTaskResult, data });
    const [msgType, payload] = parseMessage(raw);
    expect(msgType).toBe('task_result');
    const msg = payload as TaskResultMsg;
    expect(msg.task_id).toBe('task-9');
    expect(msg.status).toBe('completed');
  });

  it('parses escalation', () => {
    const data: EscalationMsg = {
      correlation_id: 'esc-corr-1',
      task_id: 'task-3',
      agent_aid: 'aid-3',
      source_team: 'tid-team-a',
      destination_team: 'tid-team-b',
      escalation_level: 1,
      reason: 'stuck',
      context: { detail: 'some context' },
    };
    const raw = JSON.stringify({ type: MsgTypeEscalation, data });
    const [msgType, payload] = parseMessage(raw);
    expect(msgType).toBe('escalation');
    const msg = payload as EscalationMsg;
    expect(msg.correlation_id).toBe('esc-corr-1');
    expect(msg.task_id).toBe('task-3');
    expect(msg.reason).toBe('stuck');
  });

  it('parses tool_call', () => {
    const data: ToolCallMsg = {
      call_id: 'call-99',
      tool_name: 'create_team',
      arguments: { name: 'backend' },
      agent_aid: 'aid-main',
    };
    const raw = JSON.stringify({ type: MsgTypeToolCall, data });
    const [msgType, payload] = parseMessage(raw);
    expect(msgType).toBe('tool_call');
    const msg = payload as ToolCallMsg;
    expect(msg.call_id).toBe('call-99');
    expect(msg.tool_name).toBe('create_team');
  });

  it('parses status_update', () => {
    const data: StatusUpdateMsg = { agent_aid: 'aid-7', status: 'busy' };
    const raw = JSON.stringify({ type: MsgTypeStatusUpdate, data });
    const [msgType, payload] = parseMessage(raw);
    expect(msgType).toBe('status_update');
    const msg = payload as StatusUpdateMsg;
    expect(msg.agent_aid).toBe('aid-7');
    expect(msg.status).toBe('busy');
  });

  it('parses agent_ready', () => {
    const data: AgentReadyMsg = { aid: 'aid-new-001' };
    const raw = JSON.stringify({ type: MsgTypeAgentReady, data });
    const [msgType, payload] = parseMessage(raw);
    expect(msgType).toBe('agent_ready');
    const msg = payload as AgentReadyMsg;
    expect(msg.aid).toBe('aid-new-001');
  });

  it('parses escalation_response', () => {
    const data: EscalationResponseMsg = {
      correlation_id: 'esc-resp-1',
      task_id: 'task-5',
      agent_aid: 'aid-lead',
      source_team: 'tid-parent',
      destination_team: 'tid-child',
      resolution: 'use approach B',
      context: { confidence: 'high' },
    };
    const raw = JSON.stringify({ type: MsgTypeEscalationResponse, data });
    const [msgType, payload] = parseMessage(raw);
    expect(msgType).toBe('escalation_response');
    const msg = payload as EscalationResponseMsg;
    expect(msg.correlation_id).toBe('esc-resp-1');
    expect(msg.task_id).toBe('task-5');
    expect(msg.resolution).toBe('use approach B');
  });

  it('parses task_cancel', () => {
    const data: TaskCancelMsg = {
      task_id: 'task-cancel-1',
      cascade: true,
      reason: 'no longer needed',
    };
    const raw = JSON.stringify({ type: MsgTypeTaskCancel, data });
    const [msgType, payload] = parseMessage(raw);
    expect(msgType).toBe('task_cancel');
    const msg = payload as TaskCancelMsg;
    expect(msg.task_id).toBe('task-cancel-1');
    expect(msg.cascade).toBe(true);
    expect(msg.reason).toBe('no longer needed');
  });

  it('parses log_event', () => {
    const data: LogEventMsg = {
      level: 'info',
      source_aid: 'aid-worker-1',
      message: 'task started',
      metadata: { task_id: 'task-10' },
      timestamp: '2026-03-08T15:00:00.000Z',
    };
    const raw = JSON.stringify({ type: MsgTypeLogEvent, data });
    const [msgType, payload] = parseMessage(raw);
    expect(msgType).toBe('log_event');
    const msg = payload as LogEventMsg;
    expect(msg.source_aid).toBe('aid-worker-1');
    expect(msg.message).toBe('task started');
    expect(msg.level).toBe('info');
  });

  it('parses org_chart_update', () => {
    const data: OrgChartUpdateMsg = {
      action: 'agent_added',
      team_slug: 'backend-team',
      agent_aid: 'aid-new-dev',
      agent_name: 'new-dev',
      timestamp: '2026-03-08T15:00:00.000Z',
    };
    const raw = JSON.stringify({ type: MsgTypeOrgChartUpdate, data });
    const [msgType, payload] = parseMessage(raw);
    expect(msgType).toBe('org_chart_update');
    const msg = payload as OrgChartUpdateMsg;
    expect(msg.action).toBe('agent_added');
    expect(msg.team_slug).toBe('backend-team');
    expect(msg.agent_aid).toBe('aid-new-dev');
  });

  it('accepts Buffer input as well as string input', () => {
    const data: ReadyMsg = { team_id: 'tid-buf', agent_count: 1 };
    const raw = JSON.stringify({ type: MsgTypeReady, data });
    const buf = Buffer.from(raw, 'utf8');
    const [msgType, payload] = parseMessage(buf);
    expect(msgType).toBe('ready');
    const msg = payload as ReadyMsg;
    expect(msg.team_id).toBe('tid-buf');
  });
});

// ---------------------------------------------------------------------------
// parseMessage — missing required fields
// ---------------------------------------------------------------------------

describe('parseMessage — rejects messages with missing required fields', () => {
  it('rejects task_dispatch with missing task_id', () => {
    const raw = JSON.stringify({ type: 'task_dispatch', data: { agent_aid: 'aid-1', prompt: 'go' } });
    expect(() => parseMessage(raw)).toThrow(ValidationError);
    expect(() => parseMessage(raw)).toThrow('task_id is required');
  });

  it('rejects task_dispatch with missing agent_aid', () => {
    const raw = JSON.stringify({ type: 'task_dispatch', data: { task_id: 't-1', prompt: 'go' } });
    expect(() => parseMessage(raw)).toThrow(ValidationError);
    expect(() => parseMessage(raw)).toThrow('agent_aid is required');
  });

  it('rejects tool_result with missing call_id', () => {
    const raw = JSON.stringify({ type: 'tool_result', data: { result: {} } });
    expect(() => parseMessage(raw)).toThrow(ValidationError);
    expect(() => parseMessage(raw)).toThrow('call_id is required');
  });

  it('rejects ready with missing team_id', () => {
    const raw = JSON.stringify({ type: 'ready', data: { agent_count: 1 } });
    expect(() => parseMessage(raw)).toThrow(ValidationError);
    expect(() => parseMessage(raw)).toThrow('team_id is required');
  });

  it('rejects task_result with missing task_id', () => {
    const raw = JSON.stringify({ type: 'task_result', data: { agent_aid: 'aid-1', status: 'done', duration: 100 } });
    expect(() => parseMessage(raw)).toThrow(ValidationError);
    expect(() => parseMessage(raw)).toThrow('task_id is required');
  });

  it('rejects escalation with missing correlation_id', () => {
    const raw = JSON.stringify({ type: 'escalation', data: { task_id: 'task-1', agent_aid: 'aid-1', reason: 'stuck' } });
    expect(() => parseMessage(raw)).toThrow(ValidationError);
    expect(() => parseMessage(raw)).toThrow('correlation_id is required');
  });

  it('rejects escalation with missing task_id', () => {
    const raw = JSON.stringify({ type: 'escalation', data: { correlation_id: 'c-1', agent_aid: 'aid-1', reason: 'stuck' } });
    expect(() => parseMessage(raw)).toThrow(ValidationError);
    expect(() => parseMessage(raw)).toThrow('task_id is required');
  });

  it('rejects tool_call with missing call_id', () => {
    const raw = JSON.stringify({ type: 'tool_call', data: { tool_name: 'create_team', arguments: {}, agent_aid: 'aid-1' } });
    expect(() => parseMessage(raw)).toThrow(ValidationError);
    expect(() => parseMessage(raw)).toThrow('call_id is required');
  });

  it('rejects tool_call with missing tool_name', () => {
    const raw = JSON.stringify({ type: 'tool_call', data: { call_id: 'c-1', arguments: {}, agent_aid: 'aid-1' } });
    expect(() => parseMessage(raw)).toThrow(ValidationError);
    expect(() => parseMessage(raw)).toThrow('tool_name is required');
  });

  it('rejects status_update with missing agent_aid', () => {
    const raw = JSON.stringify({ type: 'status_update', data: { status: 'busy' } });
    expect(() => parseMessage(raw)).toThrow(ValidationError);
    expect(() => parseMessage(raw)).toThrow('agent_aid is required');
  });

  it('rejects agent_ready with missing aid', () => {
    const raw = JSON.stringify({ type: 'agent_ready', data: {} });
    expect(() => parseMessage(raw)).toThrow(ValidationError);
    expect(() => parseMessage(raw)).toThrow('aid is required');
  });

  it('rejects escalation_response with missing correlation_id', () => {
    const raw = JSON.stringify({ type: 'escalation_response', data: { task_id: 'task-1' } });
    expect(() => parseMessage(raw)).toThrow(ValidationError);
    expect(() => parseMessage(raw)).toThrow('correlation_id is required');
  });

  it('rejects escalation_response with missing task_id', () => {
    const raw = JSON.stringify({ type: 'escalation_response', data: { correlation_id: 'c-1' } });
    expect(() => parseMessage(raw)).toThrow(ValidationError);
    expect(() => parseMessage(raw)).toThrow('task_id is required');
  });

  it('rejects task_cancel with missing task_id', () => {
    const raw = JSON.stringify({ type: 'task_cancel', data: { cascade: true } });
    expect(() => parseMessage(raw)).toThrow(ValidationError);
    expect(() => parseMessage(raw)).toThrow('task_id is required');
  });

  it('rejects log_event with missing source_aid', () => {
    const raw = JSON.stringify({ type: 'log_event', data: { message: 'hi', level: 'info' } });
    expect(() => parseMessage(raw)).toThrow(ValidationError);
    expect(() => parseMessage(raw)).toThrow('source_aid is required');
  });

  it('rejects log_event with missing message', () => {
    const raw = JSON.stringify({ type: 'log_event', data: { source_aid: 'aid-1', level: 'info' } });
    expect(() => parseMessage(raw)).toThrow(ValidationError);
    expect(() => parseMessage(raw)).toThrow('message is required');
  });

  it('rejects org_chart_update with missing action', () => {
    const raw = JSON.stringify({ type: 'org_chart_update', data: { team_slug: 'team-a', agent_aid: 'aid-1' } });
    expect(() => parseMessage(raw)).toThrow(ValidationError);
    expect(() => parseMessage(raw)).toThrow('action is required');
  });

  it('rejects org_chart_update with missing team_slug', () => {
    const raw = JSON.stringify({ type: 'org_chart_update', data: { action: 'agent_added', agent_aid: 'aid-1' } });
    expect(() => parseMessage(raw)).toThrow(ValidationError);
    expect(() => parseMessage(raw)).toThrow('team_slug is required');
  });

  it('rejects org_chart_update with missing agent_aid', () => {
    const raw = JSON.stringify({ type: 'org_chart_update', data: { action: 'agent_added', team_slug: 'team-a' } });
    expect(() => parseMessage(raw)).toThrow(ValidationError);
    expect(() => parseMessage(raw)).toThrow('agent_aid is required');
  });
});

// ---------------------------------------------------------------------------
// parseMessage — unknown message types
// ---------------------------------------------------------------------------

describe('parseMessage — rejects unknown message types', () => {
  it('throws on unknown type string', () => {
    const raw = JSON.stringify({ type: 'unknown_type', data: {} });
    expect(() => parseMessage(raw)).toThrow('unknown message type: unknown_type');
  });

  it('throws on empty type string', () => {
    const raw = JSON.stringify({ type: '', data: {} });
    expect(() => parseMessage(raw)).toThrow(ValidationError);
    expect(() => parseMessage(raw)).toThrow('message type is required');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseMessage('not json')).toThrow('invalid message envelope: not valid JSON');
  });

  it('throws on JSON array (not an object)', () => {
    expect(() => parseMessage('[1,2,3]')).toThrow(ValidationError);
  });

  it('throws on JSON string primitive (not an object)', () => {
    expect(() => parseMessage('"hello"')).toThrow(ValidationError);
  });

  it('throws on UPPER_CASE type (wrong casing)', () => {
    const raw = JSON.stringify({ type: 'READY', data: {} });
    expect(() => parseMessage(raw)).toThrow('unknown message type: READY');
  });

  it('throws on camelCase type', () => {
    const raw = JSON.stringify({ type: 'containerInit', data: {} });
    expect(() => parseMessage(raw)).toThrow('unknown message type: containerInit');
  });
});

// ---------------------------------------------------------------------------
// validateDirection
// ---------------------------------------------------------------------------

describe('validateDirection — enforces message direction', () => {
  // Container sending container-to-backend types is valid
  it('allows container to send ready', () => {
    expect(() => validateDirection(MsgTypeReady, true)).not.toThrow();
  });

  it('allows container to send heartbeat', () => {
    expect(() => validateDirection(MsgTypeHeartbeat, true)).not.toThrow();
  });

  it('allows container to send task_result', () => {
    expect(() => validateDirection(MsgTypeTaskResult, true)).not.toThrow();
  });

  it('allows container to send escalation', () => {
    expect(() => validateDirection(MsgTypeEscalation, true)).not.toThrow();
  });

  it('allows container to send tool_call', () => {
    expect(() => validateDirection(MsgTypeToolCall, true)).not.toThrow();
  });

  it('allows container to send status_update', () => {
    expect(() => validateDirection(MsgTypeStatusUpdate, true)).not.toThrow();
  });

  it('allows container to send agent_ready', () => {
    expect(() => validateDirection(MsgTypeAgentReady, true)).not.toThrow();
  });

  it('allows container to send log_event', () => {
    expect(() => validateDirection(MsgTypeLogEvent, true)).not.toThrow();
  });

  it('allows container to send org_chart_update', () => {
    expect(() => validateDirection(MsgTypeOrgChartUpdate, true)).not.toThrow();
  });

  // Backend sending backend-to-container types is valid
  it('allows backend to send container_init', () => {
    expect(() => validateDirection(MsgTypeContainerInit, false)).not.toThrow();
  });

  it('allows backend to send task_dispatch', () => {
    expect(() => validateDirection(MsgTypeTaskDispatch, false)).not.toThrow();
  });

  it('allows backend to send shutdown', () => {
    expect(() => validateDirection(MsgTypeShutdown, false)).not.toThrow();
  });

  it('allows backend to send tool_result', () => {
    expect(() => validateDirection(MsgTypeToolResult, false)).not.toThrow();
  });

  it('allows backend to send agent_added', () => {
    expect(() => validateDirection(MsgTypeAgentAdded, false)).not.toThrow();
  });

  it('allows backend to send escalation_response', () => {
    expect(() => validateDirection(MsgTypeEscalationResponse, false)).not.toThrow();
  });

  it('allows backend to send task_cancel', () => {
    expect(() => validateDirection(MsgTypeTaskCancel, false)).not.toThrow();
  });

  // Container sending backend-to-container types is forbidden
  it('rejects container sending container_init', () => {
    expect(() => validateDirection(MsgTypeContainerInit, true)).toThrow(
      `container cannot send message type "container_init" (backend-to-container only)`,
    );
  });

  it('rejects container sending task_dispatch', () => {
    expect(() => validateDirection(MsgTypeTaskDispatch, true)).toThrow(
      `container cannot send message type "task_dispatch" (backend-to-container only)`,
    );
  });

  it('rejects container sending shutdown', () => {
    expect(() => validateDirection(MsgTypeShutdown, true)).toThrow(
      `container cannot send message type "shutdown" (backend-to-container only)`,
    );
  });

  it('rejects container sending tool_result', () => {
    expect(() => validateDirection(MsgTypeToolResult, true)).toThrow(
      `container cannot send message type "tool_result" (backend-to-container only)`,
    );
  });

  // Backend sending container-to-backend types is forbidden
  it('rejects backend sending ready', () => {
    expect(() => validateDirection(MsgTypeReady, false)).toThrow(
      `backend cannot send message type "ready" (container-to-backend only)`,
    );
  });

  it('rejects backend sending heartbeat', () => {
    expect(() => validateDirection(MsgTypeHeartbeat, false)).toThrow(
      `backend cannot send message type "heartbeat" (container-to-backend only)`,
    );
  });

  // Unknown types from container
  it('rejects container sending unknown type', () => {
    expect(() => validateDirection('unknown_type', true)).toThrow(
      'unknown container-to-backend message type: unknown_type',
    );
  });

  // Unknown types from backend
  it('rejects backend sending unknown type', () => {
    expect(() => validateDirection('unknown_type', false)).toThrow(
      'unknown backend-to-container message type: unknown_type',
    );
  });
});

// ---------------------------------------------------------------------------
// mapDomainErrorToWSError
// ---------------------------------------------------------------------------

describe('mapDomainErrorToWSError — maps each domain error type correctly', () => {
  it('maps NotFoundError to NOT_FOUND with generic message', () => {
    const err = new NotFoundError('team', 'tid-abc');
    const [code, msg] = mapDomainErrorToWSError(err);
    expect(code).toBe(WSErrorNotFound);
    expect(msg).toBe('the requested resource was not found');
  });

  it('maps ValidationError to VALIDATION_ERROR with the error message preserved', () => {
    const err = new ValidationError('task_id', 'task_id is required');
    const [code, msg] = mapDomainErrorToWSError(err);
    expect(code).toBe(WSErrorValidation);
    // ValidationError message is preserved for user-facing detail
    expect(msg).toBe(err.message);
    expect(msg).toContain('task_id is required');
  });

  it('maps ConflictError to CONFLICT with generic message', () => {
    const err = new ConflictError('team', 'already exists');
    const [code, msg] = mapDomainErrorToWSError(err);
    expect(code).toBe(WSErrorConflict);
    expect(msg).toBe('a resource conflict occurred');
  });

  it('maps EncryptionLockedError to ENCRYPTION_LOCKED with generic message', () => {
    const err = new EncryptionLockedError();
    const [code, msg] = mapDomainErrorToWSError(err);
    expect(code).toBe(WSErrorEncryptionLocked);
    expect(msg).toBe('encryption is locked');
  });

  it('maps RateLimitedError to RATE_LIMITED with generic message', () => {
    const err = new RateLimitedError(30);
    const [code, msg] = mapDomainErrorToWSError(err);
    expect(code).toBe(WSErrorRateLimited);
    expect(msg).toBe('rate limit exceeded');
  });

  it('maps AccessDeniedError to ACCESS_DENIED with generic message', () => {
    const err = new AccessDeniedError('team', 'not allowed');
    const [code, msg] = mapDomainErrorToWSError(err);
    expect(code).toBe(WSErrorAccessDenied);
    expect(msg).toBe('access denied');
  });

  it('maps unknown Error to INTERNAL_ERROR with sanitized message', () => {
    const err = new Error('something broke in /usr/local/src/app.ts');
    const [code, msg] = mapDomainErrorToWSError(err);
    expect(code).toBe(WSErrorInternal);
    // Path should be sanitized
    expect(msg).not.toContain('/usr/local/src/app.ts');
    expect(msg).toContain('[path]');
  });
});

// ---------------------------------------------------------------------------
// sanitizeErrorMessage
// ---------------------------------------------------------------------------

describe('sanitizeErrorMessage — strips file paths and stack traces', () => {
  it('strips a Unix file path from the message', () => {
    const err = new Error('error in /usr/local/src/server.ts');
    const result = sanitizeErrorMessage(err);
    expect(result).not.toContain('/usr/local/src/server.ts');
    expect(result).toContain('[path]');
  });

  it('strips a nested Unix path', () => {
    const err = new Error('failed to read /home/node/.config/claude/settings.json');
    const result = sanitizeErrorMessage(err);
    expect(result).not.toContain('/home/node');
    expect(result).toContain('[path]');
  });

  it('strips goroutine stack trace markers', () => {
    const err = new Error('goroutine 42 [running]');
    const result = sanitizeErrorMessage(err);
    expect(result).not.toContain('goroutine 42 [running]');
  });

  it('returns "an internal error occurred" when message is whitespace-only after stripping', () => {
    // Construct a message that becomes whitespace-only after stripping.
    // goroutine patterns are stripped without replacement (unlike paths which get [path]).
    // Using a goroutine-only message to produce empty/whitespace output.
    const err = new Error('goroutine 1 [running]');
    const result = sanitizeErrorMessage(err);
    expect(result).toBe('an internal error occurred');
  });

  it('replaces a path-only message with [path] (not empty fallback)', () => {
    // Paths are replaced with "[path]" — the result is non-empty so no fallback.
    const err = new Error('/some/path/only');
    const result = sanitizeErrorMessage(err);
    expect(result).toBe('[path]');
  });

  it('preserves non-path, non-stack-trace messages unchanged', () => {
    const err = new Error('connection timeout after 30 seconds');
    const result = sanitizeErrorMessage(err);
    expect(result).toBe('connection timeout after 30 seconds');
  });

  it('strips multiple paths in one message', () => {
    const err = new Error('copy from /src/file.txt to /dst/file.txt failed');
    const result = sanitizeErrorMessage(err);
    expect(result).not.toContain('/src/file.txt');
    expect(result).not.toContain('/dst/file.txt');
    expect(result).toContain('[path]');
  });
});

// ---------------------------------------------------------------------------
// encodeMessage
// ---------------------------------------------------------------------------

describe('encodeMessage — produces valid JSON envelope', () => {
  it('wraps task_dispatch payload in an envelope', () => {
    const payload: TaskDispatchMsg = {
      task_id: 'task-1',
      agent_aid: 'aid-abc',
      prompt: 'Do something',
    };
    const result = encodeMessage(MsgTypeTaskDispatch, payload);
    const parsed = JSON.parse(result) as { type: string; data: TaskDispatchMsg };
    expect(parsed.type).toBe('task_dispatch');
    expect(parsed.data.task_id).toBe('task-1');
    expect(parsed.data.agent_aid).toBe('aid-abc');
    expect(parsed.data.prompt).toBe('Do something');
  });

  it('wraps container_init payload in an envelope', () => {
    const payload: ContainerInitMsg = {
      is_main_assistant: true,
      team_config: { slug: 'main' },
      agents: [],
    };
    const result = encodeMessage(MsgTypeContainerInit, payload);
    const parsed = JSON.parse(result) as { type: string; data: ContainerInitMsg };
    expect(parsed.type).toBe('container_init');
    expect(parsed.data.is_main_assistant).toBe(true);
  });

  it('wraps ready payload in an envelope', () => {
    const payload: ReadyMsg = { team_id: 'tid-xyz', agent_count: 2 };
    const result = encodeMessage(MsgTypeReady, payload);
    const parsed = JSON.parse(result) as { type: string; data: ReadyMsg };
    expect(parsed.type).toBe('ready');
    expect(parsed.data.team_id).toBe('tid-xyz');
    expect(parsed.data.agent_count).toBe(2);
  });

  it('produces valid JSON that round-trips through JSON.parse', () => {
    const payload: ShutdownMsg = { reason: 'done', timeout: 10 };
    const result = encodeMessage(MsgTypeShutdown, payload);
    // Should not throw
    const parsed = JSON.parse(result) as { type: string; data: ShutdownMsg };
    expect(parsed.type).toBe('shutdown');
    expect(typeof result).toBe('string');
  });

  it('envelope always has "type" and "data" fields', () => {
    const payload: HeartbeatMsg = {
      team_id: 'tid-1',
      agents: [],
    };
    const result = encodeMessage(MsgTypeHeartbeat, payload);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(Object.keys(parsed)).toContain('type');
    expect(Object.keys(parsed)).toContain('data');
  });
});
