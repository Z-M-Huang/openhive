/**
 * OpenHive Backend - WebSocket Protocol
 *
 * Provides:
 *   - parseMessage()           — parse JSON envelope + validate required fields
 *   - validateDirection()      — enforce backend-to-container / container-to-backend type sets
 *   - mapDomainErrorToWSError() — map domain errors to WS error codes
 *   - sanitizeErrorMessage()   — strip file paths and stack traces from error messages
 *   - encodeMessage()          — wrap typed payload in a WSMessage JSON envelope
 */

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
  MsgTypeAgentAdded,
  MsgTypeReady,
  MsgTypeHeartbeat,
  MsgTypeTaskResult,
  MsgTypeEscalation,
  MsgTypeToolCall,
  MsgTypeStatusUpdate,
  MsgTypeAgentReady,
  WSErrorNotFound,
  WSErrorValidation,
  WSErrorConflict,
  WSErrorEncryptionLocked,
  WSErrorRateLimited,
  WSErrorAccessDenied,
  WSErrorInternal,
} from './messages.js';

import type {
  ContainerInitMsg,
  TaskDispatchMsg,
  ShutdownMsg,
  ToolResultMsg,
  ReadyMsg,
  HeartbeatMsg,
  TaskResultMsg,
  EscalationMsg,
  ToolCallMsg,
  StatusUpdateMsg,
  WSMessage,
  WSErrorCode,
} from './messages.js';

// ---------------------------------------------------------------------------
// Direction sets — backend-to-container / container-to-backend
// ---------------------------------------------------------------------------

/** Message types that the backend sends to containers (backend-to-container only). */
const backendToContainerTypes = new Set<string>([
  MsgTypeContainerInit,
  MsgTypeTaskDispatch,
  MsgTypeShutdown,
  MsgTypeToolResult,
  MsgTypeAgentAdded,
]);

/** Message types that containers send to the backend (container-to-backend only). */
const containerToBackendTypes = new Set<string>([
  MsgTypeReady,
  MsgTypeHeartbeat,
  MsgTypeTaskResult,
  MsgTypeEscalation,
  MsgTypeToolCall,
  MsgTypeStatusUpdate,
  MsgTypeAgentReady,
]);

// ---------------------------------------------------------------------------
// Regex patterns for sanitizeErrorMessage
// ---------------------------------------------------------------------------

/** Matches Unix-style file system paths (e.g. /usr/local/bin/node). */
const pathPattern = /(?:\/[a-zA-Z0-9_./-]+)+/g;

/** Matches goroutine stack traces (e.g. "goroutine 1 [running]"). */
const stackPattern = /goroutine \d+ \[.*?\]/g;

// ---------------------------------------------------------------------------
// Raw envelope — internal shape from JSON.parse()
// ---------------------------------------------------------------------------

/**
 * Raw shape of a WebSocket envelope as it arrives from JSON.parse().
 * `data` is typed as the most permissive JSON object shape before narrowing.
 */
interface RawEnvelope {
  type: string;
  data: Record<string, unknown>;
}

/**
 * Type guard for the raw envelope.
 * Accepts `unknown` so the predicate can safely narrow to RawEnvelope.
 */
function isRawEnvelope(value: unknown): value is RawEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['type'] === 'string' &&
    typeof obj['data'] === 'object' &&
    obj['data'] !== null &&
    !Array.isArray(obj['data'])
  );
}

// ---------------------------------------------------------------------------
// Field accessor helpers — type-safe extraction from Record<string, unknown>
// ---------------------------------------------------------------------------

function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const val = obj[key];
  return typeof val === 'string' ? val : undefined;
}

// ---------------------------------------------------------------------------
// parseMessage
// ---------------------------------------------------------------------------

/**
 * Parses a raw WebSocket message into its typed payload.
 *
 * Returns a [msgType, typedPayload] tuple.
 * Throws ValidationError for missing required fields.
 * Throws Error for invalid JSON, invalid envelope, or unknown message type.
 *
 * @param data - Raw message data as a Buffer or JSON string.
 * @returns Tuple of [message type string, typed payload object].
 */
export function parseMessage(data: Buffer | string): [string, WSMessage['data']] {
  const raw = typeof data === 'string' ? data : data.toString('utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('invalid message envelope: not valid JSON');
  }

  if (!isRawEnvelope(parsed)) {
    throw new ValidationError('type', 'message type is required');
  }

  const { type, data: msgData } = parsed;

  if (type === '') {
    throw new ValidationError('type', 'message type is required');
  }

  switch (type) {
    case MsgTypeContainerInit: {
      // ContainerInitMsg — no required fields beyond shape (is_main_assistant + team_config + agents)
      const payload = msgData as unknown as ContainerInitMsg;
      return [type, payload];
    }

    case MsgTypeTaskDispatch: {
      const taskId = getString(msgData, 'task_id');
      if (!taskId) {
        throw new ValidationError('task_id', 'task_id is required');
      }
      const agentAid = getString(msgData, 'agent_aid');
      if (!agentAid) {
        throw new ValidationError('agent_aid', 'agent_aid is required');
      }
      const payload = msgData as unknown as TaskDispatchMsg;
      return [type, payload];
    }

    case MsgTypeShutdown: {
      const payload = msgData as unknown as ShutdownMsg;
      return [type, payload];
    }

    case MsgTypeToolResult: {
      const callId = getString(msgData, 'call_id');
      if (!callId) {
        throw new ValidationError('call_id', 'call_id is required');
      }
      const payload = msgData as unknown as ToolResultMsg;
      return [type, payload];
    }

    case MsgTypeReady: {
      const teamId = getString(msgData, 'team_id');
      if (!teamId) {
        throw new ValidationError('team_id', 'team_id is required');
      }
      const payload = msgData as unknown as ReadyMsg;
      return [type, payload];
    }

    case MsgTypeHeartbeat: {
      const payload = msgData as unknown as HeartbeatMsg;
      return [type, payload];
    }

    case MsgTypeTaskResult: {
      const taskId = getString(msgData, 'task_id');
      if (!taskId) {
        throw new ValidationError('task_id', 'task_id is required');
      }
      const payload = msgData as unknown as TaskResultMsg;
      return [type, payload];
    }

    case MsgTypeEscalation: {
      const taskId = getString(msgData, 'task_id');
      if (!taskId) {
        throw new ValidationError('task_id', 'task_id is required');
      }
      const payload = msgData as unknown as EscalationMsg;
      return [type, payload];
    }

    case MsgTypeToolCall: {
      const callId = getString(msgData, 'call_id');
      if (!callId) {
        throw new ValidationError('call_id', 'call_id is required');
      }
      const toolName = getString(msgData, 'tool_name');
      if (!toolName) {
        throw new ValidationError('tool_name', 'tool_name is required');
      }
      const payload = msgData as unknown as ToolCallMsg;
      return [type, payload];
    }

    case MsgTypeStatusUpdate: {
      const agentAid = getString(msgData, 'agent_aid');
      if (!agentAid) {
        throw new ValidationError('agent_aid', 'agent_aid is required');
      }
      const payload = msgData as unknown as StatusUpdateMsg;
      return [type, payload];
    }

    default:
      throw new Error(`unknown message type: ${type}`);
  }
}

// ---------------------------------------------------------------------------
// validateDirection
// ---------------------------------------------------------------------------

/**
 * Enforces direction constraints between the backend and containers.
 * Containers cannot send backend-to-container types, and vice versa.
 *
 * @param msgType       - The message type string.
 * @param isFromContainer - True if the message was sent by a container.
 * @throws Error if the message type violates direction constraints.
 */
export function validateDirection(msgType: string, isFromContainer: boolean): void {
  if (isFromContainer) {
    if (backendToContainerTypes.has(msgType)) {
      throw new Error(
        `container cannot send message type "${msgType}" (backend-to-container only)`,
      );
    }
    if (!containerToBackendTypes.has(msgType)) {
      throw new Error(`unknown container-to-backend message type: ${msgType}`);
    }
  } else {
    if (containerToBackendTypes.has(msgType)) {
      throw new Error(
        `backend cannot send message type "${msgType}" (container-to-backend only)`,
      );
    }
    if (!backendToContainerTypes.has(msgType)) {
      throw new Error(`unknown backend-to-container message type: ${msgType}`);
    }
  }
}

// ---------------------------------------------------------------------------
// mapDomainErrorToWSError
// ---------------------------------------------------------------------------

/**
 * Maps domain errors to WS error codes and sanitized user-facing messages.
 * Known domain error types return stable generic messages; ValidationError
 * keeps user-facing detail by design.
 *
 * @param err - The error to map.
 * @returns Tuple of [WSErrorCode, message string].
 */
export function mapDomainErrorToWSError(err: Error): [WSErrorCode, string] {
  if (err instanceof NotFoundError) {
    return [WSErrorNotFound, 'the requested resource was not found'];
  }
  if (err instanceof ValidationError) {
    return [WSErrorValidation, err.message];
  }
  if (err instanceof ConflictError) {
    return [WSErrorConflict, 'a resource conflict occurred'];
  }
  if (err instanceof EncryptionLockedError) {
    return [WSErrorEncryptionLocked, 'encryption is locked'];
  }
  if (err instanceof RateLimitedError) {
    return [WSErrorRateLimited, 'rate limit exceeded'];
  }
  if (err instanceof AccessDeniedError) {
    return [WSErrorAccessDenied, 'access denied'];
  }
  return [WSErrorInternal, sanitizeErrorMessage(err)];
}

// ---------------------------------------------------------------------------
// sanitizeErrorMessage
// ---------------------------------------------------------------------------

/**
 * Strips file paths, stack traces, and internal details from error
 * messages, returning only a safe user-facing string.
 *
 * @param err - The error whose message will be sanitized.
 * @returns A sanitized error message string.
 */
export function sanitizeErrorMessage(err: Error): string {
  let msg = err.message;
  msg = msg.replace(pathPattern, '[path]');
  msg = msg.replace(stackPattern, '');
  if (msg.trim() === '') {
    return 'an internal error occurred';
  }
  return msg;
}

// ---------------------------------------------------------------------------
// encodeMessage
// ---------------------------------------------------------------------------

/**
 * Wraps a typed payload into a JSON-encoded WSMessage envelope.
 *
 * @param msgType - The message type string (e.g. "task_dispatch").
 * @param payload - The typed payload object.
 * @returns JSON string of the envelope.
 * @throws Error if the payload cannot be serialized.
 */
export function encodeMessage(msgType: string, payload: WSMessage['data']): string {
  let dataStr: string;
  try {
    dataStr = JSON.stringify(payload);
  } catch (err) {
    throw new Error(
      `failed to marshal payload: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Parse back to get the raw data object, then wrap in envelope and stringify.
  const envelope = {
    type: msgType,
    data: JSON.parse(dataStr) as WSMessage['data'],
  };

  return JSON.stringify(envelope);
}
