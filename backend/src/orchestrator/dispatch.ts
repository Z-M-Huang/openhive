/**
 * OpenHive Backend - Dispatcher
 *
 * Handles task creation/dispatch via WebSocket, processes incoming WS messages
 * (task results, heartbeats, tool calls, escalations, ready, status updates),
 * and routes messages to appropriate handlers.
 *
 * Key design choices:
 *   - uuid() via crypto.randomUUID().
 *   - toolHandler.handleToolCallWithContext expects Record<string, JsonValue>;
 *     the arguments field from the wire is JsonValue, so we validate the shape
 *     with a type guard and send a VALIDATION_ERROR tool_result if it fails.
 *   - taskResultCallback is async (matches the TS interface).
 */

import type { TaskStore, WSHub, HeartbeatMonitor, SDKToolHandler } from '../domain/interfaces.js';
import type { TaskWaiter } from './task-waiter.js';
import type { EscalationRouter } from './escalation-router.js';
import type { Task } from '../domain/types.js';
import type { JsonValue } from '../domain/types.js';
import type {
  TaskResultMsg,
  AgentInitConfig,
  ToolResultMsg,
  EscalationMsg,
} from '../ws/messages.js';
import {
  MsgTypeTaskDispatch,
  MsgTypeContainerInit,
  MsgTypeToolResult,
  MsgTypeReady,
  MsgTypeHeartbeat,
  MsgTypeTaskResult,
  MsgTypeEscalation,
  MsgTypeToolCall,
  MsgTypeStatusUpdate,
  MsgTypeAgentReady,
  MsgTypeLogEvent,
  MsgTypeOrgChartUpdate,
  WSErrorValidation,
  PROTOCOL_VERSION,
} from '../ws/messages.js';
import { parseMessage, validateDirection, mapDomainErrorToWSError, encodeMessage } from '../ws/protocol.js';
import { convertAgentStatuses } from './heartbeat.js';

// ---------------------------------------------------------------------------
// Logger interface — minimal structured logger compatible with pino or stubs
// ---------------------------------------------------------------------------

/**
 * Minimal structured logger interface required by Dispatcher.
 * Compatible with pino or any standard structured logger.
 */
export interface DispatcherLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Type guard — narrows JsonValue to Record<string, JsonValue>
// ---------------------------------------------------------------------------

/**
 * Type guard that checks whether a JsonValue is a plain object (record).
 * Used to validate ToolCallMsg arguments before passing to the tool handler.
 */
function isJsonRecord(value: JsonValue): value is Record<string, JsonValue> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Handles task creation and dispatch to team containers via WebSocket, and
 * processes incoming WebSocket messages from containers.
 */
export class Dispatcher {
  private readonly taskStore: TaskStore;
  private readonly wsHub: WSHub;
  private readonly logger: DispatcherLogger;

  private toolHandler: SDKToolHandler | null = null;
  private taskResultCallback: ((result: TaskResultMsg) => void) | null = null;
  private heartbeatMonitor: HeartbeatMonitor | null = null;
  private taskWaiter: TaskWaiter | null = null;
  private escalationRouter: EscalationRouter | null = null;
  private onTaskCompleted: ((taskId: string) => Promise<void>) | null = null;
  private onTaskRetryNeeded: ((taskId: string) => Promise<void>) | null = null;
  private onTaskTerminalFailed: ((taskId: string) => Promise<void>) | null = null;

  constructor(taskStore: TaskStore, wsHub: WSHub, logger: DispatcherLogger) {
    this.taskStore = taskStore;
    this.wsHub = wsHub;
    this.logger = logger;
  }

  // -------------------------------------------------------------------------
  // setToolHandler
  // -------------------------------------------------------------------------

  /**
   * Sets the handler for SDK tool calls received from containers.
   */
  setToolHandler(handler: SDKToolHandler): void {
    this.toolHandler = handler;
  }

  // -------------------------------------------------------------------------
  // setTaskResultCallback
  // -------------------------------------------------------------------------

  /**
   * Sets a callback invoked after a task result is processed.
   * Used to route results to the message router for outbound delivery.
   */
  setTaskResultCallback(cb: (result: TaskResultMsg) => void): void {
    this.taskResultCallback = cb;
  }

  // -------------------------------------------------------------------------
  // setHeartbeatMonitor
  // -------------------------------------------------------------------------

  /**
   * Sets the heartbeat monitor for processing container health data.
   */
  setHeartbeatMonitor(monitor: HeartbeatMonitor): void {
    this.heartbeatMonitor = monitor;
  }

  // -------------------------------------------------------------------------
  // setTaskWaiter
  // -------------------------------------------------------------------------

  /**
   * Sets the TaskWaiter for dispatch_task_and_wait blocking semantics.
   * When set, handleResult() will notify waiters on terminal transitions.
   */
  setTaskWaiter(waiter: TaskWaiter): void {
    this.taskWaiter = waiter;
  }

  // -------------------------------------------------------------------------
  // setEscalationRouter
  // -------------------------------------------------------------------------

  /**
   * Sets the escalation router for handling escalation and
   * escalation_response messages.
   */
  setEscalationRouter(router: EscalationRouter): void {
    this.escalationRouter = router;
  }

  // -------------------------------------------------------------------------
  // setOnTaskCompleted
  // -------------------------------------------------------------------------

  /**
   * Sets a callback invoked when a task completes successfully.
   * Used by the orchestrator to auto-unblock dependent tasks.
   * Only fires for 'completed' status, not 'failed' or 'cancelled'.
   */
  setOnTaskCompleted(callback: (taskId: string) => Promise<void>): void {
    this.onTaskCompleted = callback;
  }

  // -------------------------------------------------------------------------
  // setOnTaskRetryNeeded
  // -------------------------------------------------------------------------

  /**
   * Sets a callback invoked when a failed task is eligible for retry
   * (retry_count < max_retries). The Dispatcher resets the task to 'pending'
   * and increments retry_count before firing the callback.
   * Used by the orchestrator to re-dispatch the task.
   */
  setOnTaskRetryNeeded(callback: (taskId: string) => Promise<void>): void {
    this.onTaskRetryNeeded = callback;
  }

  // -------------------------------------------------------------------------
  // setOnTaskTerminalFailed
  // -------------------------------------------------------------------------

  /**
   * Sets a callback invoked when a task reaches a terminal failed state
   * (retry exhausted → 'failed') or is already 'cancelled'.
   * Used by the orchestrator to auto-escalate permanently blocked dependents.
   */
  setOnTaskTerminalFailed(callback: (taskId: string) => Promise<void>): void {
    this.onTaskTerminalFailed = callback;
  }

  // -------------------------------------------------------------------------
  // createAndDispatch
  // -------------------------------------------------------------------------

  /**
   * Creates a task in the database and dispatches it to the target team's
   * container via WebSocket.
   *
   * If the WS send fails (container not connected), the task is still persisted
   * and can be retried when the container reconnects. Status remains 'pending'
   * in that case.
   *
   *
   * @param teamSlug  - Slug of the target team.
   * @param agentAID  - AID of the agent that should execute the task.
   * @param prompt    - Task prompt / instruction text.
   * @param parentID  - Optional parent task ID (empty string = root task).
   * @returns The newly created Task domain object.
   */
  async createAndDispatch(
    teamSlug: string,
    agentAID: string,
    prompt: string,
    parentID: string,
  ): Promise<Task> {
    const now = new Date();
    const task: Task = {
      id: crypto.randomUUID(),
      parent_id: parentID !== '' ? parentID : undefined,
      team_slug: teamSlug,
      agent_aid: agentAID,
      status: 'pending',
      prompt,
      blocked_by: [],
      priority: 0,
      retry_count: 0,
      max_retries: 0,
      created_at: now,
      updated_at: now,
      completed_at: null,
    };

    await this.taskStore.create(task);

    // Build the task dispatch message
    const dispatchMsg = {
      task_id: task.id,
      agent_aid: agentAID,
      prompt,
      blocked_by: task.blocked_by,
    };

    const encoded = encodeMessage(MsgTypeTaskDispatch, dispatchMsg);

    // Send to team container — task was already persisted, so WS failure is
    // non-fatal: the container can be retried when it reconnects.
    try {
      await this.wsHub.sendToTeam(teamSlug, encoded);
    } catch (err) {
      this.logger.warn('failed to dispatch task to container', {
        task_id: task.id,
        team: teamSlug,
        error: err instanceof Error ? err.message : String(err),
      });
      // Return task as-is (status=pending); WS delivery failed.
      return task;
    }

    // Update task status to running
    const updated: Task = {
      ...task,
      status: 'running',
      updated_at: new Date(),
    };

    try {
      await this.taskStore.update(updated);
    } catch (err) {
      this.logger.error('failed to update task status', {
        task_id: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.logger.info('task dispatched', {
      task_id: task.id,
      team: teamSlug,
      agent: agentAID,
    });

    return updated;
  }

  // -------------------------------------------------------------------------
  // handleResult
  // -------------------------------------------------------------------------

  /**
   * Processes a task result received from a container.
   * Updates the task's status, result/error, and completedAt in the database.
   *
   *
   * @throws ValidationError  If result.status is neither 'completed' nor 'failed'.
   * @throws Error            If the task is not found in the database.
   */
  async handleResult(result: TaskResultMsg): Promise<void> {
    const task = await this.taskStore.get(result.task_id);

    // Race guard: skip if task was already cancelled (e.g., cancel cascade).
    if (task.status === 'cancelled') {
      this.logger.warn('task result received for already-cancelled task, skipping', {
        task_id: result.task_id,
        result_status: result.status,
      });

      // Fire onTaskTerminalFailed for the cancelled task so the orchestrator
      // can check whether dependents are permanently blocked.
      if (this.onTaskTerminalFailed !== null) {
        try {
          await this.onTaskTerminalFailed(result.task_id);
        } catch (err) {
          this.logger.error('onTaskTerminalFailed callback failed', {
            task_id: result.task_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return;
    }

    const now = new Date();
    let updated: Task;

    if (result.status === 'completed') {
      updated = {
        ...task,
        status: 'completed',
        result: result.result,
        updated_at: now,
        completed_at: now,
      };
    } else if (result.status === 'failed') {
      // Check retry eligibility before marking as failed.
      if (task.retry_count < task.max_retries) {
        const retried: Task = {
          ...task,
          retry_count: task.retry_count + 1,
          status: 'pending',
          updated_at: now,
        };
        await this.taskStore.update(retried);

        // Fire onTaskRetryNeeded callback. Failures are logged but do NOT
        // crash the Dispatcher — the task remains in 'pending' status so it
        // can be retried on a future cycle.
        if (this.onTaskRetryNeeded !== null) {
          try {
            await this.onTaskRetryNeeded(result.task_id);
          } catch (err) {
            this.logger.error('onTaskRetryNeeded callback failed', {
              task_id: result.task_id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        this.logger.info('task scheduled for retry', {
          task_id: result.task_id,
          retry_count: retried.retry_count,
          max_retries: task.max_retries,
        });
        return;
      }

      updated = {
        ...task,
        status: 'failed',
        error: result.error,
        updated_at: now,
        completed_at: now,
      };
    } else {
      throw new Error(`unexpected task result status: ${result.status}`);
    }

    await this.taskStore.update(updated);

    // Fire onTaskCompleted callback for completed tasks only.
    // This triggers auto-unblock of dependent tasks in the orchestrator.
    // Callback errors are logged but do NOT crash the Dispatcher or prevent
    // the completion result from being processed.
    if (result.status === 'completed' && this.onTaskCompleted !== null) {
      try {
        await this.onTaskCompleted(result.task_id);
      } catch (err) {
        this.logger.error('onTaskCompleted callback failed', {
          task_id: result.task_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Fire onTaskTerminalFailed callback for terminal failed tasks
    // (retry exhausted). This triggers auto-escalation of permanently
    // blocked dependents in the orchestrator.
    if (result.status === 'failed' && this.onTaskTerminalFailed !== null) {
      try {
        await this.onTaskTerminalFailed(result.task_id);
      } catch (err) {
        this.logger.error('onTaskTerminalFailed callback failed', {
          task_id: result.task_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Notify TaskWaiter so dispatch_task_and_wait unblocks.
    if (this.taskWaiter !== null) {
      this.taskWaiter.notifyComplete(
        result.task_id,
        result.status,
        result.result,
        result.error,
      );
    }

    this.logger.info('task result processed', {
      task_id: result.task_id,
      status: result.status,
      duration: result.duration,
    });
  }

  // -------------------------------------------------------------------------
  // handleWSMessage
  // -------------------------------------------------------------------------

  /**
   * Processes an incoming WebSocket message from a container.
   * Routes task_result, heartbeat, tool_call, escalation, ready, and
   * status_update messages to the appropriate internal handlers.
   *
   * Enforces direction validation: rejects backend-to-container message types
   * that a container should never send.
   *
   *
   * @param teamID - The team ID that sent the message.
   * @param data   - Raw message bytes from the WebSocket.
   */
  handleWSMessage(teamID: string, data: Buffer): void {
    let msgType: string;
    let payload: ReturnType<typeof parseMessage>[1];

    try {
      [msgType, payload] = parseMessage(data);
    } catch (err) {
      this.logger.error('failed to parse WS message', {
        team_id: teamID,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Enforce direction: containers must only send container-to-backend types.
    try {
      validateDirection(msgType, true);
    } catch (err) {
      this.logger.error('rejected message with invalid direction', {
        team_id: teamID,
        type: msgType,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    this.logger.debug('ws message dispatching', { team_id: teamID, type: msgType });

    switch (msgType) {
      case MsgTypeTaskResult: {
        const result = payload as TaskResultMsg;
        this.handleResult(result).then(() => {
          if (this.taskResultCallback !== null) {
            this.taskResultCallback(result);
          }
        }).catch((err: unknown) => {
          this.logger.error('failed to handle task result', {
            task_id: result.task_id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        break;
      }

      case MsgTypeReady: {
        const ready = payload as { team_id: string; agent_count: number; protocol_version?: string };
        if (ready.protocol_version && ready.protocol_version !== PROTOCOL_VERSION) {
          this.logger.warn('protocol version mismatch', {
            team_id: ready.team_id,
            expected: PROTOCOL_VERSION,
            received: ready.protocol_version,
          });
        }
        this.logger.info('container ready', {
          team_id: ready.team_id,
          agent_count: ready.agent_count,
        });
        break;
      }

      case MsgTypeHeartbeat: {
        const hb = payload as { team_id: string; agents: Array<{ aid: string; status: string; detail?: string; elapsed_seconds: number; memory_mb: number }> };
        this.logger.debug('heartbeat received', {
          team_id: teamID,
          agent_count: hb.agents.length,
        });
        if (this.heartbeatMonitor !== null) {
          const agents = convertAgentStatuses(hb.agents);
          this.heartbeatMonitor.processHeartbeat(teamID, agents);
        } else {
          this.logger.warn('heartbeat received but no heartbeat monitor configured', {
            team_id: teamID,
          });
        }
        break;
      }

      case MsgTypeToolCall: {
        const toolCall = payload as {
          call_id: string;
          tool_name: string;
          arguments: JsonValue;
          agent_aid: string;
        };

        if (this.toolHandler === null) {
          this.logger.error('tool call received but no tool handler configured', {
            team_id: teamID,
            call_id: toolCall.call_id,
            tool_name: toolCall.tool_name,
          });
          return;
        }

        // arguments must be a plain JSON object for the tool handler interface
        if (!isJsonRecord(toolCall.arguments)) {
          this.logger.error('tool call arguments are not a JSON object', {
            team_id: teamID,
            call_id: toolCall.call_id,
            tool_name: toolCall.tool_name,
          });
          const errResult: ToolResultMsg = {
            call_id: toolCall.call_id,
            error_code: WSErrorValidation,
            error_message: 'tool call arguments must be a JSON object',
          };
          const encoded = encodeMessage(MsgTypeToolResult, errResult);
          this.wsHub.sendToTeam(teamID, encoded).catch((sendErr: unknown) => {
            this.logger.error('failed to send tool_result', {
              team_id: teamID,
              call_id: toolCall.call_id,
              error: sendErr instanceof Error ? sendErr.message : String(sendErr),
            });
          });
          return;
        }

        const handler = this.toolHandler;
        handler
          .handleToolCallWithContext(
            teamID,
            toolCall.call_id,
            toolCall.tool_name,
            toolCall.agent_aid,
            toolCall.arguments,
          )
          .then((result) => {
            const resultMsg: ToolResultMsg = {
              call_id: toolCall.call_id,
              result,
            };
            const encoded = encodeMessage(MsgTypeToolResult, resultMsg);
            return this.wsHub.sendToTeam(teamID, encoded);
          })
          .catch((err: unknown) => {
            const toolErr = err instanceof Error ? err : new Error(String(err));
            this.logger.error('tool call failed', {
              team_id: teamID,
              call_id: toolCall.call_id,
              tool_name: toolCall.tool_name,
              error: toolErr.message,
            });
            const [errCode, errMessage] = mapDomainErrorToWSError(toolErr);
            const errResult: ToolResultMsg = {
              call_id: toolCall.call_id,
              error_code: errCode,
              error_message: errMessage,
            };
            const encoded = encodeMessage(MsgTypeToolResult, errResult);
            return this.wsHub.sendToTeam(teamID, encoded).catch((sendErr: unknown) => {
              this.logger.error('failed to send tool_result', {
                team_id: teamID,
                call_id: toolCall.call_id,
                error: sendErr instanceof Error ? sendErr.message : String(sendErr),
              });
            });
          });
        break;
      }

      case MsgTypeEscalation: {
        const escalation = payload as EscalationMsg;
        if (this.escalationRouter !== null) {
          this.escalationRouter.handleEscalation(teamID, escalation).catch((err: unknown) => {
            this.logger.error('failed to handle escalation', {
              task_id: escalation.task_id,
              correlation_id: escalation.correlation_id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        } else {
          this.logger.warn('escalation received but no escalation router configured', {
            task_id: escalation.task_id,
            agent: escalation.agent_aid,
            reason: escalation.reason,
          });
        }
        break;
      }

      case MsgTypeStatusUpdate: {
        this.logger.info('status update received', { team_id: teamID });
        break;
      }

      case MsgTypeAgentReady: {
        const agentReady = payload as { aid: string };
        this.logger.info('agent ready', {
          team_id: teamID,
          aid: agentReady.aid,
        });
        break;
      }

      case MsgTypeLogEvent: {
        const logEvent = payload as {
          level: string;
          source_aid: string;
          message: string;
          metadata: Record<string, unknown>;
          timestamp: string;
        };
        this.logger.info('container log event', {
          team_id: teamID,
          level: logEvent.level,
          source_aid: logEvent.source_aid,
          message: logEvent.message,
        });
        break;
      }

      case MsgTypeOrgChartUpdate: {
        const orgUpdate = payload as {
          action: string;
          team_slug: string;
          agent_aid: string;
          agent_name: string;
        };
        this.logger.info('org chart update', {
          team_id: teamID,
          action: orgUpdate.action,
          team_slug: orgUpdate.team_slug,
          agent_aid: orgUpdate.agent_aid,
          agent_name: orgUpdate.agent_name,
        });
        break;
      }

      default: {
        this.logger.warn('unhandled message type', { type: msgType, team_id: teamID });
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // sendContainerInit
  // -------------------------------------------------------------------------

  /**
   * Sends a container_init message to a team container.
   * Used to initialise newly connected containers with their agent configs,
   * secrets, and workspace root.
   *
   *
   * @param teamID        - The team ID to send to.
   * @param isMain        - Whether this is the main assistant container.
   * @param agents        - List of agent init configs for this container.
   * @param secrets       - Map of secret name to value.
   * @param workspaceRoot - The workspace root path for this container.
   */
  async sendContainerInit(
    teamID: string,
    isMain: boolean,
    agents: AgentInitConfig[],
    secrets: Record<string, string>,
    workspaceRoot: string,
  ): Promise<void> {
    const initMsg = {
      is_main_assistant: isMain,
      team_config: {} as JsonValue,
      agents,
      secrets,
      workspace_root: workspaceRoot,
      protocol_version: PROTOCOL_VERSION,
    };

    const encoded = encodeMessage(MsgTypeContainerInit, initMsg);
    await this.wsHub.sendToTeam(teamID, encoded);
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Creates a new Dispatcher with the given dependencies.
 *
 * Optional dependencies (toolHandler, taskResultCallback, heartbeatMonitor)
 * must be set via the setter methods after construction.
 */
export function newDispatcher(
  taskStore: TaskStore,
  wsHub: WSHub,
  logger: DispatcherLogger,
): Dispatcher {
  return new Dispatcher(taskStore, wsHub, logger);
}
