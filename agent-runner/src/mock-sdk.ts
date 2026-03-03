/**
 * Mock SDK for testing the AgentExecutor.
 *
 * Simulates the @anthropic-ai/claude-code query() API:
 * - Returns an async iterable of messages
 * - Supports configurable responses, delays, errors, and tool call simulation
 *
 * This module is NOT imported by production code. Only tests use it.
 */

import type { SDKQueryOptions } from './agent-executor.js';

/** Mock-specific message types (more detailed than SDKStreamMessage for test assertions) */
export interface SDKSystemInitMessage {
  type: 'system';
  subtype: 'init';
  session_id: string;
}

export interface SDKAssistantMessage {
  type: 'assistant';
  uuid: string;
  message: {
    role: 'assistant';
    content: Array<{ type: 'text'; text: string }>;
  };
}

export interface SDKResultMessage {
  type: 'result';
  subtype: 'success' | 'error';
  result?: string;
  error?: string;
  session_id: string;
}

export type SDKMessage = SDKSystemInitMessage | SDKAssistantMessage | SDKResultMessage;

/** Configuration for the mock SDK behavior */
export interface MockSDKConfig {
  /** Response text to return */
  responseText?: string;
  /** Session ID to return in init message */
  sessionId?: string;
  /** Delay in ms before yielding result */
  delayMs?: number;
  /** Error to throw during query */
  error?: Error;
  /** Whether to simulate a tool call before result */
  simulateToolCall?: boolean;
}

/**
 * Records the last query() call for test assertions.
 */
export interface MockSDKCallRecord {
  prompt: string;
  options: SDKQueryOptions;
}

/**
 * Creates a mock query function that simulates the SDK behavior.
 * Returns the mock function and a record of the last call.
 */
export function createMockQuery(config: MockSDKConfig = {}): {
  query: (params: { prompt: string; options: SDKQueryOptions }) => AsyncIterable<SDKMessage>;
  calls: MockSDKCallRecord[];
} {
  const calls: MockSDKCallRecord[] = [];

  async function* mockQuery(params: {
    prompt: string;
    options: SDKQueryOptions;
  }): AsyncIterable<SDKMessage> {
    calls.push({ prompt: params.prompt, options: params.options });

    if (config.error) {
      throw config.error;
    }

    if (config.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, config.delayMs));
    }

    const sessionId = config.sessionId ?? `session-${Date.now()}`;

    // Emit system init
    yield {
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
    };

    // Emit assistant message
    yield {
      type: 'assistant',
      uuid: `asst-${Date.now()}`,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: config.responseText ?? 'Mock response' }],
      },
    };

    // Emit result
    yield {
      type: 'result',
      subtype: 'success',
      result: config.responseText ?? 'Mock response',
      session_id: sessionId,
    };
  }

  return { query: mockQuery, calls };
}
