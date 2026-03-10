/**
 * Tests for backend/src/domain/enums.ts
 *
 * Verifies that every enum:
 *   1. Has a const array containing exactly the expected values
 *   2. validate* returns true for all valid values and false for invalid ones
 *   3. parse* returns the correctly typed value for all valid inputs
 *   4. parse* throws an Error (with descriptive message) for invalid input
 *   5. Values round-trip through parse correctly
 *   6. All string names match the wire protocol (snake_case)
 */

import { describe, it, expect } from 'vitest';
import {
  // TaskStatus
  TASK_STATUSES,
  validateTaskStatus,
  parseTaskStatus,
  // EventType
  EVENT_TYPES,
  validateEventType,
  parseEventType,
  // ProviderType
  PROVIDER_TYPES,
  validateProviderType,
  parseProviderType,
  // LogLevel
  LOG_LEVELS,
  validateLogLevel,
  parseLogLevel,
  // ContainerState
  CONTAINER_STATES,
  validateContainerState,
  parseContainerState,
  // ModelTier
  MODEL_TIERS,
  validateModelTier,
  parseModelTier,
  // AgentStatusType
  AGENT_STATUS_TYPES,
  validateAgentStatusType,
  parseAgentStatusType,
} from './enums.js';

// ---------------------------------------------------------------------------
// TaskStatus
// ---------------------------------------------------------------------------

describe('TaskStatus', () => {
  const validValues = ['pending', 'running', 'completed', 'failed', 'cancelled', 'escalated'];

  it('TASK_STATUSES contains exactly the expected values', () => {
    expect([...TASK_STATUSES]).toEqual(validValues);
  });

  it('validateTaskStatus returns true for all valid values', () => {
    for (const v of validValues) {
      expect(validateTaskStatus(v)).toBe(true);
    }
  });

  it('validateTaskStatus returns false for invalid values', () => {
    expect(validateTaskStatus('')).toBe(false);
    expect(validateTaskStatus('unknown')).toBe(false);
    expect(validateTaskStatus('PENDING')).toBe(false);
    expect(validateTaskStatus('Pending')).toBe(false);
    expect(validateTaskStatus('done')).toBe(false);
    expect(validateTaskStatus('0')).toBe(false);
  });

  it('parseTaskStatus returns correct type for all valid values', () => {
    expect(parseTaskStatus('pending')).toBe('pending');
    expect(parseTaskStatus('running')).toBe('running');
    expect(parseTaskStatus('completed')).toBe('completed');
    expect(parseTaskStatus('failed')).toBe('failed');
    expect(parseTaskStatus('cancelled')).toBe('cancelled');
    expect(parseTaskStatus('escalated')).toBe('escalated');
  });

  it('parseTaskStatus throws for invalid input', () => {
    expect(() => parseTaskStatus('')).toThrow('invalid task status: ""');
    expect(() => parseTaskStatus('unknown')).toThrow('invalid task status: "unknown"');
    expect(() => parseTaskStatus('PENDING')).toThrow('invalid task status: "PENDING"');
    expect(() => parseTaskStatus('done')).toThrow('invalid task status: "done"');
  });

  it('all TaskStatus values round-trip through parse', () => {
    for (const v of validValues) {
      expect(parseTaskStatus(parseTaskStatus(v))).toBe(v);
    }
  });

  it('TaskStatus values use lowercase snake_case matching wire format', () => {
    for (const v of validValues) {
      expect(v).toMatch(/^[a-z_]+$/);
    }
  });
});

// ---------------------------------------------------------------------------
// EventType
// ---------------------------------------------------------------------------

describe('EventType', () => {
  const validValues = [
    'task_created',
    'task_updated',
    'task_completed',
    'task_failed',
    'config_changed',
    'team_created',
    'team_deleted',
    'agent_started',
    'agent_stopped',
    'channel_message',
    'heartbeat_received',
    'container_state_changed',
    'log_entry',
    'task_cancelled',
  ];

  it('EVENT_TYPES contains exactly the expected values', () => {
    expect([...EVENT_TYPES]).toEqual(validValues);
  });

  it('EVENT_TYPES has exactly 14 values', () => {
    expect(EVENT_TYPES.length).toBe(14);
  });

  it('validateEventType returns true for all valid values', () => {
    for (const v of validValues) {
      expect(validateEventType(v)).toBe(true);
    }
  });

  it('validateEventType returns false for invalid values', () => {
    expect(validateEventType('')).toBe(false);
    expect(validateEventType('task_created_extra')).toBe(false);
    expect(validateEventType('TASK_CREATED')).toBe(false);
    expect(validateEventType('taskCreated')).toBe(false);
    expect(validateEventType('0')).toBe(false);
    expect(validateEventType('unknown_event')).toBe(false);
  });

  it('parseEventType returns correct type for all valid values', () => {
    for (const v of validValues) {
      expect(parseEventType(v)).toBe(v);
    }
  });

  it('parseEventType throws for invalid input', () => {
    expect(() => parseEventType('')).toThrow('invalid event type: ""');
    expect(() => parseEventType('unknown_event')).toThrow('invalid event type: "unknown_event"');
    expect(() => parseEventType('taskCreated')).toThrow('invalid event type: "taskCreated"');
  });

  it('all EventType values round-trip through parse', () => {
    for (const v of validValues) {
      expect(parseEventType(parseEventType(v))).toBe(v);
    }
  });

  it('EventType JSON serialization uses string names not integers', () => {
    const event: string = parseEventType('log_entry');
    const json = JSON.stringify({ type: event });
    expect(json).toBe('{"type":"log_entry"}');
    expect(json).not.toContain('12'); // not the iota integer
  });

  it('EventType values use lowercase snake_case matching wire format', () => {
    for (const v of validValues) {
      expect(v).toMatch(/^[a-z_]+$/);
    }
  });
});

// ---------------------------------------------------------------------------
// ProviderType
// ---------------------------------------------------------------------------

describe('ProviderType', () => {
  const validValues = ['oauth', 'anthropic_direct'];

  it('PROVIDER_TYPES contains exactly the expected values', () => {
    expect([...PROVIDER_TYPES]).toEqual(validValues);
  });

  it('validateProviderType returns true for all valid values', () => {
    for (const v of validValues) {
      expect(validateProviderType(v)).toBe(true);
    }
  });

  it('validateProviderType returns false for invalid values', () => {
    expect(validateProviderType('')).toBe(false);
    expect(validateProviderType('openai')).toBe(false);
    expect(validateProviderType('OAuth')).toBe(false);
    expect(validateProviderType('ANTHROPIC_DIRECT')).toBe(false);
    expect(validateProviderType('anthropic')).toBe(false);
  });

  it('parseProviderType returns correct type for all valid values', () => {
    expect(parseProviderType('oauth')).toBe('oauth');
    expect(parseProviderType('anthropic_direct')).toBe('anthropic_direct');
  });

  it('parseProviderType throws for invalid input', () => {
    expect(() => parseProviderType('')).toThrow('invalid provider type: ""');
    expect(() => parseProviderType('openai')).toThrow('invalid provider type: "openai"');
    expect(() => parseProviderType('OAuth')).toThrow('invalid provider type: "OAuth"');
  });

  it('all ProviderType values round-trip through parse', () => {
    for (const v of validValues) {
      expect(parseProviderType(parseProviderType(v))).toBe(v);
    }
  });
});

// ---------------------------------------------------------------------------
// LogLevel
// ---------------------------------------------------------------------------

describe('LogLevel', () => {
  const validValues = ['debug', 'info', 'warn', 'error'];

  it('LOG_LEVELS contains exactly the expected values', () => {
    expect([...LOG_LEVELS]).toEqual(validValues);
  });

  it('validateLogLevel returns true for all valid values', () => {
    for (const v of validValues) {
      expect(validateLogLevel(v)).toBe(true);
    }
  });

  it('validateLogLevel returns false for invalid values', () => {
    expect(validateLogLevel('')).toBe(false);
    expect(validateLogLevel('DEBUG')).toBe(false);
    expect(validateLogLevel('warning')).toBe(false);
    expect(validateLogLevel('fatal')).toBe(false);
    expect(validateLogLevel('verbose')).toBe(false);
    expect(validateLogLevel('trace')).toBe(false);
  });

  it('parseLogLevel returns correct type for all valid values', () => {
    expect(parseLogLevel('debug')).toBe('debug');
    expect(parseLogLevel('info')).toBe('info');
    expect(parseLogLevel('warn')).toBe('warn');
    expect(parseLogLevel('error')).toBe('error');
  });

  it('parseLogLevel throws for invalid input', () => {
    expect(() => parseLogLevel('')).toThrow('invalid log level: ""');
    expect(() => parseLogLevel('DEBUG')).toThrow('invalid log level: "DEBUG"');
    expect(() => parseLogLevel('warning')).toThrow('invalid log level: "warning"');
    expect(() => parseLogLevel('fatal')).toThrow('invalid log level: "fatal"');
  });

  it('all LogLevel values round-trip through parse', () => {
    for (const v of validValues) {
      expect(parseLogLevel(parseLogLevel(v))).toBe(v);
    }
  });

  it('LogLevel ordering is debug < info < warn < error', () => {
    expect(LOG_LEVELS[0]).toBe('debug');
    expect(LOG_LEVELS[1]).toBe('info');
    expect(LOG_LEVELS[2]).toBe('warn');
    expect(LOG_LEVELS[3]).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// ContainerState
// ---------------------------------------------------------------------------

describe('ContainerState', () => {
  const validValues = ['creating', 'created', 'starting', 'running', 'stopping', 'stopped', 'removing', 'removed', 'failed'];

  it('CONTAINER_STATES contains exactly the expected values', () => {
    expect([...CONTAINER_STATES]).toEqual(validValues);
  });

  it('CONTAINER_STATES has exactly 9 values', () => {
    expect(CONTAINER_STATES.length).toBe(9);
  });

  it('validateContainerState returns true for all valid values', () => {
    for (const v of validValues) {
      expect(validateContainerState(v)).toBe(true);
    }
  });

  it('validateContainerState returns false for invalid values', () => {
    expect(validateContainerState('')).toBe(false);
    expect(validateContainerState('idle')).toBe(false);
    expect(validateContainerState('RUNNING')).toBe(false);
    expect(validateContainerState('exited')).toBe(false);
    expect(validateContainerState('paused')).toBe(false);
    expect(validateContainerState('error')).toBe(false);
  });

  it('parseContainerState returns correct type for all valid values', () => {
    expect(parseContainerState('creating')).toBe('creating');
    expect(parseContainerState('created')).toBe('created');
    expect(parseContainerState('starting')).toBe('starting');
    expect(parseContainerState('running')).toBe('running');
    expect(parseContainerState('stopping')).toBe('stopping');
    expect(parseContainerState('stopped')).toBe('stopped');
    expect(parseContainerState('removing')).toBe('removing');
    expect(parseContainerState('removed')).toBe('removed');
    expect(parseContainerState('failed')).toBe('failed');
  });

  it('parseContainerState throws for invalid input', () => {
    expect(() => parseContainerState('')).toThrow('invalid container state: ""');
    expect(() => parseContainerState('idle')).toThrow('invalid container state: "idle"');
    expect(() => parseContainerState('RUNNING')).toThrow('invalid container state: "RUNNING"');
    expect(() => parseContainerState('exited')).toThrow('invalid container state: "exited"');
    expect(() => parseContainerState('error')).toThrow('invalid container state: "error"');
  });

  it('all ContainerState values round-trip through parse', () => {
    for (const v of validValues) {
      expect(parseContainerState(parseContainerState(v))).toBe(v);
    }
  });
});

// ---------------------------------------------------------------------------
// ModelTier
// ---------------------------------------------------------------------------

describe('ModelTier', () => {
  const validValues = ['haiku', 'sonnet', 'opus'];

  it('MODEL_TIERS contains exactly the expected values', () => {
    expect([...MODEL_TIERS]).toEqual(validValues);
  });

  it('validateModelTier returns true for all valid values', () => {
    for (const v of validValues) {
      expect(validateModelTier(v)).toBe(true);
    }
  });

  it('validateModelTier returns false for invalid values', () => {
    expect(validateModelTier('')).toBe(false);
    expect(validateModelTier('HAIKU')).toBe(false);
    expect(validateModelTier('claude-haiku')).toBe(false);
    expect(validateModelTier('gpt4')).toBe(false);
    expect(validateModelTier('medium')).toBe(false);
  });

  it('parseModelTier returns correct type for all valid values', () => {
    expect(parseModelTier('haiku')).toBe('haiku');
    expect(parseModelTier('sonnet')).toBe('sonnet');
    expect(parseModelTier('opus')).toBe('opus');
  });

  it('parseModelTier throws for invalid input', () => {
    expect(() => parseModelTier('')).toThrow('invalid model tier: ""');
    expect(() => parseModelTier('HAIKU')).toThrow('invalid model tier: "HAIKU"');
    expect(() => parseModelTier('claude-haiku')).toThrow('invalid model tier: "claude-haiku"');
    expect(() => parseModelTier('gpt4')).toThrow('invalid model tier: "gpt4"');
  });

  it('all ModelTier values round-trip through parse', () => {
    for (const v of validValues) {
      expect(parseModelTier(parseModelTier(v))).toBe(v);
    }
  });

  it('ModelTier ordering is haiku < sonnet < opus', () => {
    expect(MODEL_TIERS[0]).toBe('haiku');
    expect(MODEL_TIERS[1]).toBe('sonnet');
    expect(MODEL_TIERS[2]).toBe('opus');
  });
});

// ---------------------------------------------------------------------------
// AgentStatusType
// ---------------------------------------------------------------------------

describe('AgentStatusType', () => {
  const validValues = ['idle', 'busy', 'starting', 'stopped', 'error'];

  it('AGENT_STATUS_TYPES contains exactly the expected values', () => {
    expect([...AGENT_STATUS_TYPES]).toEqual(validValues);
  });

  it('AGENT_STATUS_TYPES has exactly 5 values', () => {
    expect(AGENT_STATUS_TYPES.length).toBe(5);
  });

  it('validateAgentStatusType returns true for all valid values', () => {
    for (const v of validValues) {
      expect(validateAgentStatusType(v)).toBe(true);
    }
  });

  it('validateAgentStatusType returns false for invalid values', () => {
    expect(validateAgentStatusType('')).toBe(false);
    expect(validateAgentStatusType('IDLE')).toBe(false);
    expect(validateAgentStatusType('running')).toBe(false);
    expect(validateAgentStatusType('active')).toBe(false);
    expect(validateAgentStatusType('paused')).toBe(false);
  });

  it('parseAgentStatusType returns correct type for all valid values', () => {
    expect(parseAgentStatusType('idle')).toBe('idle');
    expect(parseAgentStatusType('busy')).toBe('busy');
    expect(parseAgentStatusType('starting')).toBe('starting');
    expect(parseAgentStatusType('stopped')).toBe('stopped');
    expect(parseAgentStatusType('error')).toBe('error');
  });

  it('parseAgentStatusType throws for invalid input', () => {
    expect(() => parseAgentStatusType('')).toThrow('invalid agent status type: ""');
    expect(() => parseAgentStatusType('running')).toThrow('invalid agent status type: "running"');
    expect(() => parseAgentStatusType('IDLE')).toThrow('invalid agent status type: "IDLE"');
    expect(() => parseAgentStatusType('active')).toThrow('invalid agent status type: "active"');
  });

  it('all AgentStatusType values round-trip through parse', () => {
    for (const v of validValues) {
      expect(parseAgentStatusType(parseAgentStatusType(v))).toBe(v);
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-enum: all 7 enum types fully covered
// ---------------------------------------------------------------------------

describe('All 7 enum types coverage check', () => {
  it('all enum types export const arrays with at least one value', () => {
    expect(TASK_STATUSES.length).toBeGreaterThan(0);
    expect(EVENT_TYPES.length).toBeGreaterThan(0);
    expect(PROVIDER_TYPES.length).toBeGreaterThan(0);
    expect(LOG_LEVELS.length).toBeGreaterThan(0);
    expect(CONTAINER_STATES.length).toBeGreaterThan(0);
    expect(MODEL_TIERS.length).toBeGreaterThan(0);
    expect(AGENT_STATUS_TYPES.length).toBeGreaterThan(0);
  });

  it('all parse functions throw Error for numeric string inputs (not integers)', () => {
    expect(() => parseTaskStatus('0')).toThrow();
    expect(() => parseEventType('0')).toThrow();
    expect(() => parseProviderType('0')).toThrow();
    expect(() => parseLogLevel('0')).toThrow();
    expect(() => parseContainerState('0')).toThrow();
    expect(() => parseModelTier('0')).toThrow();
    expect(() => parseAgentStatusType('0')).toThrow();
  });

  it('all validate functions are strict (no type coercion)', () => {
    // 'error' is valid for AgentStatusType but NOT for ContainerState (renamed to 'failed')
    expect(validateContainerState('error')).toBe(false);
    expect(validateAgentStatusType('error')).toBe(true);
    // 'failed' is valid for ContainerState but NOT for AgentStatusType
    expect(validateContainerState('failed')).toBe(true);
    expect(validateAgentStatusType('failed')).toBe(false);
    // 'running' is valid for ContainerState but NOT for AgentStatusType
    expect(validateContainerState('running')).toBe(true);
    expect(validateAgentStatusType('running')).toBe(false);
  });
});
