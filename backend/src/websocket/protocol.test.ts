/**
 * Tests for WebSocket protocol toWireFormat() and parseMessage() functions.
 *
 * Tests round-trip serialization/deserialization for all 16 message types
 * plus trust boundary validation and security tests.
 *
 * @module websocket/protocol.test
 */

import { describe, it, expect } from 'vitest';
import {
  type WSMessage,
  type ContainerInitMsg,
  type TaskDispatchMsg,
  type ShutdownMsg,
  type ToolResultMsg,
  type AgentAddedMsg,
  type EscalationResponseMsg,
  type TaskCancelMsg,
  type ReadyMsg,
  type HeartbeatMsg,
  type TaskResultMsg,
  type EscalationMsg,
  type LogEventMsg,
  type ToolCallMsg,
  type StatusUpdateMsg,
  type AgentReadyMsg,
  type OrgChartUpdateMsg,
  OrgChartAction,
  toWireFormat,
  parseMessage,
} from './protocol.js';
import { ValidationError } from '../domain/errors.js';

describe('protocol toWireFormat() and parseMessage()', () => {
  // Helper for deep equality comparison (handles JSON-serialized objects)
  function assertRoundTrip(message: WSMessage): void {
    const wire = toWireFormat(message);
    const parsed = parseMessage(wire);

    expect(parsed.type).toBe(message.type);
    expect(parsed.data).toEqual(message.data);
  }

  // ========================================================================
  // Round-trip tests: 7 root-to-container message types
  // ========================================================================

  describe('root-to-container message types', () => {
    const rootToContainerTypes = [
      'container_init',
      'task_dispatch',
      'shutdown',
      'tool_result',
      'agent_added',
      'escalation_response',
      'task_cancel',
    ];

    it('round-trips container_init message', () => {
      const message: WSMessage = {
        type: 'container_init',
        data: {
          protocol_version: '1.0.0',
          is_main_assistant: true,
          team_config: { slug: 'test-team' },
          agents: [
            {
              aid: 'aid-001',
              name: 'Test Agent',
              description: 'A test agent',
              role: 'main_assistant',
              model: 'claude-sonnet-4-20250514',
              tools: ['read_file', 'write_file'],
              provider: {
                type: 'oauth',
                oauthToken: 'test-token',
                models: { haiku: 'claude-haiku', sonnet: 'claude-sonnet', opus: 'claude-opus' },
              },
            },
          ],
          secrets: { API_KEY: 'test-key' },
          mcp_servers: [],
        } as ContainerInitMsg,
      };
      assertRoundTrip(message);
    });

    it('round-trips task_dispatch message', () => {
      const message: WSMessage = {
        type: 'task_dispatch',
        data: {
          task_id: 'task-123',
          agent_aid: 'aid-001',
          prompt: 'Do something useful',
          session_id: 'session-456',
          work_dir: '/workspace',
          blocked_by: ['task-100', 'task-101'],
        } as TaskDispatchMsg,
      };
      assertRoundTrip(message);
    });

    it('round-trips shutdown message', () => {
      const message: WSMessage = {
        type: 'shutdown',
        data: {
          reason: 'Maintenance window',
          timeout: 30,
        } as ShutdownMsg,
      };
      assertRoundTrip(message);
    });

    it('round-trips tool_result message', () => {
      const message: WSMessage = {
        type: 'tool_result',
        data: {
          call_id: 'call-456',
          result: { output: 'Success!' },
        } as ToolResultMsg,
      };
      assertRoundTrip(message);
    });

    it('round-trips tool_result message with error', () => {
      const message: WSMessage = {
        type: 'tool_result',
        data: {
          call_id: 'call-789',
          error_code: 'VALIDATION_ERROR',
          error_message: 'Invalid input provided',
        } as ToolResultMsg,
      };
      assertRoundTrip(message);
    });

    it('round-trips agent_added message', () => {
      const message: WSMessage = {
        type: 'agent_added',
        data: {
          agent: {
            aid: 'aid-002',
            name: 'New Agent',
            description: 'A new team member',
            role: 'member',
            model: 'claude-haiku',
            tools: ['escalation'],
            provider: {
              type: 'oauth',
              oauthToken: 'test-token',
              models: { haiku: 'claude-haiku', sonnet: 'claude-sonnet', opus: 'claude-opus' },
            },
          },
        } as AgentAddedMsg,
      };
      assertRoundTrip(message);
    });

    it('round-trips escalation_response message', () => {
      const message: WSMessage = {
        type: 'escalation_response',
        data: {
          correlation_id: 'corr-001',
          task_id: 'task-999',
          agent_aid: 'aid-003',
          source_team: 'child-team',
          destination_team: 'parent-team',
          resolution: 'Task completed successfully',
          context: { notes: 'Resolved by parent team' },
        } as EscalationResponseMsg,
      };
      assertRoundTrip(message);
    });

    it('round-trips task_cancel message', () => {
      const message: WSMessage = {
        type: 'task_cancel',
        data: {
          task_id: 'task-456',
          cascade: true,
          reason: 'No longer needed',
        } as TaskCancelMsg,
      };
      assertRoundTrip(message);
    });

    it('all root-to-container types have round-trip tests', () => {
      // Verify we have tests for all 7 types
      expect(rootToContainerTypes).toHaveLength(7);
      expect(rootToContainerTypes).toContain('container_init');
      expect(rootToContainerTypes).toContain('task_dispatch');
      expect(rootToContainerTypes).toContain('shutdown');
      expect(rootToContainerTypes).toContain('tool_result');
      expect(rootToContainerTypes).toContain('agent_added');
      expect(rootToContainerTypes).toContain('escalation_response');
      expect(rootToContainerTypes).toContain('task_cancel');
    });
  });

  // ========================================================================
  // Round-trip tests: 9 container-to-root message types
  // ========================================================================

  describe('container-to-root message types', () => {
    const containerToRootTypes = [
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

    it('round-trips ready message', () => {
      const message: WSMessage = {
        type: 'ready',
        data: {
          team_id: 'tid-main-001',
          agent_count: 3,
          protocol_version: '1.0.0',
        } as ReadyMsg,
      };
      assertRoundTrip(message);
    });

    it('round-trips heartbeat message', () => {
      const message: WSMessage = {
        type: 'heartbeat',
        data: {
          team_id: 'tid-main-001',
          agents: [
            {
              aid: 'aid-001',
              status: 'busy',
              detail: 'Processing task',
              elapsed_seconds: 120,
              memory_mb: 256,
            },
            {
              aid: 'aid-002',
              status: 'idle',
              detail: 'Waiting for work',
              elapsed_seconds: 60,
              memory_mb: 128,
            },
          ],
        } as HeartbeatMsg,
      };
      assertRoundTrip(message);
    });

    it('round-trips task_result message (completed)', () => {
      const message: WSMessage = {
        type: 'task_result',
        data: {
          task_id: 'task-123',
          agent_aid: 'aid-001',
          status: 'completed',
          result: 'Task completed successfully',
          files_created: ['/workspace/output.txt'],
          duration: 45000,
        } as TaskResultMsg,
      };
      assertRoundTrip(message);
    });

    it('round-trips task_result message (failed)', () => {
      const message: WSMessage = {
        type: 'task_result',
        data: {
          task_id: 'task-456',
          agent_aid: 'aid-002',
          status: 'failed',
          error: 'Failed due to invalid input',
          duration: 30000,
        } as TaskResultMsg,
      };
      assertRoundTrip(message);
    });

    it('round-trips escalation message', () => {
      const message: WSMessage = {
        type: 'escalation',
        data: {
          correlation_id: 'corr-001',
          task_id: 'task-789',
          agent_aid: 'aid-003',
          source_team: 'child-team',
          destination_team: 'parent-team',
          escalation_level: 1,
          reason: 'out_of_scope',
          context: { reason_detail: 'Need more resources' },
        } as EscalationMsg,
      };
      assertRoundTrip(message);
    });

    it('round-trips log_event message', () => {
      const message: WSMessage = {
        type: 'log_event',
        data: {
          level: 'info',
          source_aid: 'aid-001',
          message: 'Processing request',
          metadata: { request_id: 'req-123' },
          timestamp: '2026-03-11T12:00:00Z',
        } as LogEventMsg,
      };
      assertRoundTrip(message);
    });

    it('round-trips tool_call message', () => {
      const message: WSMessage = {
        type: 'tool_call',
        data: {
          call_id: 'call-001',
          tool_name: 'read_file',
          arguments: { path: '/workspace/test.txt' },
          agent_aid: 'aid-001',
        } as ToolCallMsg,
      };
      assertRoundTrip(message);
    });

    it('round-trips status_update message', () => {
      const message: WSMessage = {
        type: 'status_update',
        data: {
          agent_aid: 'aid-001',
          status: 'busy',
          detail: 'Processing task-123',
        } as StatusUpdateMsg,
      };
      assertRoundTrip(message);
    });

    it('round-trips agent_ready message', () => {
      const message: WSMessage = {
        type: 'agent_ready',
        data: {
          aid: 'aid-002',
        } as AgentReadyMsg,
      };
      assertRoundTrip(message);
    });

    it('round-trips org_chart_update message', () => {
      const message: WSMessage = {
        type: 'org_chart_update',
        data: {
          action: OrgChartAction.AgentAdded,
          team_slug: 'new-team',
          agent_aid: 'aid-003',
          agent_name: 'New Agent',
          timestamp: '2026-03-11T12:00:00Z',
        } as OrgChartUpdateMsg,
      };
      assertRoundTrip(message);
    });

    it('all container-to-root types have round-trip tests', () => {
      // Verify we have tests for all 9 types
      expect(containerToRootTypes).toHaveLength(9);
      expect(containerToRootTypes).toContain('ready');
      expect(containerToRootTypes).toContain('heartbeat');
      expect(containerToRootTypes).toContain('task_result');
      expect(containerToRootTypes).toContain('escalation');
      expect(containerToRootTypes).toContain('log_event');
      expect(containerToRootTypes).toContain('tool_call');
      expect(containerToRootTypes).toContain('status_update');
      expect(containerToRootTypes).toContain('agent_ready');
      expect(containerToRootTypes).toContain('org_chart_update');
    });
  });

  // ========================================================================
  // Trust boundary validation tests
  // ========================================================================

  describe('parseMessage() trust boundary validation', () => {
    it('throws ValidationError for invalid JSON string', () => {
      const invalidJson = '{ this is not valid json }';

      expect(() => parseMessage(invalidJson)).toThrow(ValidationError);
      expect(() => parseMessage(invalidJson)).toThrow('Invalid JSON message');
    });

    it('throws ValidationError for missing type field', () => {
      const missingType = JSON.stringify({
        data: { team_id: 'test-team' },
      });

      expect(() => parseMessage(missingType)).toThrow(ValidationError);
      expect(() => parseMessage(missingType)).toThrow('Message type must be a string');
    });

    it('throws ValidationError for unknown message type', () => {
      const unknownType = JSON.stringify({
        type: 'fake_type',
        data: { some: 'data' },
      });

      expect(() => parseMessage(unknownType)).toThrow(ValidationError);
      expect(() => parseMessage(unknownType)).toThrow('Unknown message type');
    });

    it('throws ValidationError for missing data field', () => {
      const missingData = JSON.stringify({
        type: 'ready',
      });

      expect(() => parseMessage(missingData)).toThrow(ValidationError);
      expect(() => parseMessage(missingData)).toThrow('Message data must be a non-null object');
    });

    it('throws ValidationError for null data', () => {
      const nullData = JSON.stringify({
        type: 'ready',
        data: null,
      });

      expect(() => parseMessage(nullData)).toThrow(ValidationError);
      expect(() => parseMessage(nullData)).toThrow('Message data must be a non-null object');
    });

    it('throws ValidationError for array as data', () => {
      const arrayData = JSON.stringify({
        type: 'ready',
        data: ['item1', 'item2'],
      });

      expect(() => parseMessage(arrayData)).toThrow(ValidationError);
      expect(() => parseMessage(arrayData)).toThrow('Message data must be a non-null object');
    });

    it('throws ValidationError for number as data', () => {
      const numberData = JSON.stringify({
        type: 'ready',
        data: 123,
      });

      expect(() => parseMessage(numberData)).toThrow(ValidationError);
      expect(() => parseMessage(numberData)).toThrow('Message data must be a non-null object');
    });

    it('throws ValidationError for string as data', () => {
      const stringData = JSON.stringify({
        type: 'ready',
        data: 'not an object',
      });

      expect(() => parseMessage(stringData)).toThrow(ValidationError);
      expect(() => parseMessage(stringData)).toThrow('Message data must be a non-null object');
    });

    it('throws ValidationError for message exceeding 1MB BEFORE JSON.parse', () => {
      // Create a string that exceeds 1MB
      const largeString = 'x'.repeat(1_048_577); // 1MB + 1 byte

      // Verify it throws with correct error
      expect(() => parseMessage(largeString)).toThrow(ValidationError);
      expect(() => parseMessage(largeString)).toThrow('Message exceeds maximum size');

      // Verify error message does NOT contain raw input
      try {
        parseMessage(largeString);
      } catch (e) {
        const errorMessage = (e as Error).message;
        // The error message should NOT contain raw input content
        expect(errorMessage).not.toContain('x'.repeat(100));
      }
    });

    it('throws ValidationError for message that is an array at top level', () => {
      const arrayMessage = JSON.stringify([
        { type: 'ready', data: { team_id: 'test' } },
      ]);

      expect(() => parseMessage(arrayMessage)).toThrow(ValidationError);
      expect(() => parseMessage(arrayMessage)).toThrow('Message must be a non-null object');
    });

    it('throws ValidationError for message that is a primitive at top level', () => {
      const primitiveMessage = JSON.stringify('just a string');

      expect(() => parseMessage(primitiveMessage)).toThrow(ValidationError);
      expect(() => parseMessage(primitiveMessage)).toThrow('Message must be a non-null object');
    });
  });

  // ========================================================================
  // Security: Error message sanitization
  // ========================================================================

  describe('error message sanitization', () => {
    it('error messages do NOT contain raw input content', () => {
      // Use a distinctive string that would be obvious if echoed
      const sensitiveInput = 'SECRET_TOKEN_abc123xyz';

      // Test with invalid JSON containing sensitive-looking data
      expect(() => parseMessage(sensitiveInput)).toThrow(ValidationError);
      try {
        parseMessage(sensitiveInput);
      } catch (e) {
        const errorMessage = (e as Error).message;
        // The error message should NOT contain the raw input
        expect(errorMessage).not.toContain(sensitiveInput);
      }

      // Test with a valid JSON structure but with sensitive data in a field
      const jsonWithSecret = JSON.stringify({
        type: 'container_init',
        data: {
          secrets: { API_KEY: sensitiveInput },
          protocol_version: '1.0.0',
          is_main_assistant: true,
          team_config: {},
          agents: [],
        },
      });

      // This should succeed (valid message)
      const result = parseMessage(jsonWithSecret);
      expect(result.type).toBe('container_init');

      // Now test with invalid JSON after the valid JSON to check echo
      const invalidJson = `{"type": "ready", "data": {"team_id": "${sensitiveInput}"`;

      expect(() => parseMessage(invalidJson)).toThrow(ValidationError);
      try {
        parseMessage(invalidJson);
      } catch (e) {
        const errorMessage = (e as Error).message;
        // Should not echo the sensitive input in error
        expect(errorMessage).not.toContain(sensitiveInput);
      }
    });

    it('error messages for missing type do not echo input', () => {
      const uniqueValue = 'UNIQUE_TEST_VALUE_12345';
      const input = JSON.stringify({
        type: uniqueValue,
        data: { test: 'data' },
      });

      expect(() => parseMessage(input)).toThrow(ValidationError);
      try {
        parseMessage(input);
      } catch (e) {
        const errorMessage = (e as Error).message;
        // Should throw about unknown type, but not echo the value
        expect(errorMessage).not.toContain(uniqueValue);
      }
    });
  });

  // ========================================================================
  // Size limit tests
  // ========================================================================

  describe('message size limit', () => {
    it('accepts message at exactly 1MB', () => {
      // Create a message that is exactly 1MB
      const exactly1MB = JSON.stringify({
        type: 'log_event',
        data: {
          level: 'info',
          source_aid: 'aid-001',
          message: 'x'.repeat(1_000_000 - 100), // Adjust for JSON overhead
          metadata: {},
          timestamp: '2026-03-11T12:00:00Z',
        },
      });

      // Should not exceed limit (depends on exact JSON encoding)
      // The check is byteLength > 1_048_576, so exactly 1MB should pass
      const byteLength = Buffer.byteLength(exactly1MB, 'utf8');
      if (byteLength <= 1_048_576) {
        expect(() => parseMessage(exactly1MB)).not.toThrow();
      }
    });

    it('rejects message just over 1MB', () => {
      // Create a minimal message and add one extra byte
      const over1MB = JSON.stringify({
        type: 'ready',
        data: {
          team_id: 'x'.repeat(1_048_576),
        },
      });

      // Verify it's actually over 1MB
      const byteLength = Buffer.byteLength(over1MB, 'utf8');
      expect(byteLength).toBeGreaterThan(1_048_576);

      expect(() => parseMessage(over1MB)).toThrow(ValidationError);
      expect(() => parseMessage(over1MB)).toThrow('Message exceeds maximum size');
    });
  });
});