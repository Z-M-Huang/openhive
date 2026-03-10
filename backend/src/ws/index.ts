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
  MsgTypeEscalationResponse,
  MsgTypeTaskCancel,
  MsgTypeReady,
  MsgTypeHeartbeat,
  MsgTypeTaskResult,
  MsgTypeEscalation,
  MsgTypeLogEvent,
  MsgTypeToolCall,
  MsgTypeStatusUpdate,
  MsgTypeAgentReady,
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
  PROTOCOL_VERSION,
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
  EscalationResponseMsg,
  TaskCancelMsg,
  ReadyMsg,
  AgentStatus,
  HeartbeatMsg,
  TaskResultMsg,
  EscalationMsg,
  LogEventMsg,
  ToolCallMsg,
  StatusUpdateMsg,
  AgentReadyMsg,
  OrgChartUpdateMsg,
  RootToContainerMessage,
  ContainerToRootMessage,
  WSMessage,
  WSErrorCode,
} from './messages.js';
