/**
 * OpenHive Backend - WebSocket module barrel export
 *
 * Re-exports all public symbols from the ws module.
 */

export { Hub } from './hub.js';
export type { HubLogger, HubOptions } from './hub.js';

export { Connection, WriteError } from './connection.js';
export type { Logger as ConnectionLogger } from './connection.js';

export { TokenManager } from './token.js';

export { parseMessage, validateDirection, mapDomainErrorToWSError, sanitizeErrorMessage, encodeMessage } from './protocol.js';

export {
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
  parseWSMessage,
} from './messages.js';

export type {
  AgentRole,
  ProviderConfig,
  MCPServerConfig,
  AgentInitConfig,
  ContainerInitMsg,
  TaskDispatchMsg,
  ShutdownMsg,
  ToolResultMsg,
  AgentAddedMsg,
  ReadyMsg,
  AgentStatus,
  HeartbeatMsg,
  TaskResultMsg,
  EscalationMsg,
  ToolCallMsg,
  StatusUpdateMsg,
  AgentReadyMsg,
  GoToContainerMessage,
  ContainerToGoMessage,
  WSMessage,
  WSErrorCode,
} from './messages.js';
