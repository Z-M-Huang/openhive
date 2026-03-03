/**
 * MCP Bridge - Intercepts SDK custom tool calls and forwards them via WebSocket.
 *
 * Each tool call gets a unique call_id. The bridge maintains a pending promises map
 * to correlate responses with requests. Timeouts are differentiated per tool type.
 */

import { randomUUID } from 'node:crypto';
import type { WSMessage, ToolCallMsg, ToolResultMsg, JSONValue } from './types.js';
import { MSG_TYPE_TOOL_CALL, MSG_TYPE_TOOL_RESULT } from './types.js';
import { getToolTimeout } from './sdk-tools.js';
import type { Logger } from './logger.js';

interface PendingCall {
  resolve: (result: JSONValue | undefined) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class MCPBridge {
  private pending = new Map<string, PendingCall>();
  private readonly sendMessage: (msg: WSMessage) => void;
  private readonly agentAID: string;
  private readonly logger: Logger;

  constructor(agentAID: string, sendMessage: (msg: WSMessage) => void, logger: Logger) {
    this.agentAID = agentAID;
    this.sendMessage = sendMessage;
    this.logger = logger;
  }

  /**
   * Forward a tool call to the Go backend via WebSocket.
   * Returns a promise that resolves with the tool result.
   */
  async callTool(toolName: string, args: Record<string, JSONValue>): Promise<JSONValue | undefined> {
    const callId = randomUUID();
    const timeout = getToolTimeout(toolName);

    return new Promise<JSONValue | undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        reject(new Error(`Tool call ${toolName} timed out after ${timeout}ms`));
      }, timeout);

      this.pending.set(callId, { resolve, reject, timer });

      const toolCallMsg: ToolCallMsg = {
        callId,
        toolName,
        arguments: args,
        agentAid: this.agentAID,
      };

      this.sendMessage({
        type: MSG_TYPE_TOOL_CALL,
        data: toolCallMsg,
      });
    });
  }

  /**
   * Handle a tool result message from the Go backend.
   */
  handleToolResult(msg: ToolResultMsg): void {
    const pending = this.pending.get(msg.callId);
    if (!pending) {
      this.logger.warn('Received tool result for unknown call_id', { callId: msg.callId });
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(msg.callId);

    if (msg.errorCode) {
      pending.reject(new Error(`${msg.errorCode}: ${msg.errorMessage ?? 'Unknown error'}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  /**
   * Reject all pending promises. Called on WebSocket disconnect.
   */
  rejectAll(reason: string): void {
    for (const [callId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(callId);
    }
  }

  /**
   * Check if a message is a tool result.
   */
  isToolResult(msg: WSMessage): msg is WSMessage & { data: ToolResultMsg } {
    return msg.type === MSG_TYPE_TOOL_RESULT;
  }

  /**
   * Get the number of pending tool calls.
   */
  pendingCount(): number {
    return this.pending.size;
  }
}
