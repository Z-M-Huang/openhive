/**
 * Tests for backend/src/domain/types.ts
 *
 * Strategy:
 *   - Construct sample objects that satisfy each interface (compile-time check).
 *   - Assert that required fields are present and correctly typed at runtime.
 *   - Assert that optional fields can be omitted.
 *   - Assert that Date fields accept Date objects.
 *   - Assert that nullable Date fields accept null.
 *   - Assert that JsonValue accepts all JSON-compatible shapes.
 *   - Assert EventPayload discriminated union narrows correctly in switch.
 *
 * TypeScript strict mode is enforced; any type-level error here would cause
 * the build/test run to fail.
 */

import { describe, it, expect } from 'vitest';
import type {
  JsonValue,
  Team,
  Agent,
  Provider,
  Skill,
  SkillInfo,
  Task,
  TaskResult,
  Message,
  ChatSession,
  LogEntry,
  MCPServer,
  ContainerConfig,
  ContainerInfo,
  AgentHeartbeatStatus,
  HeartbeatStatus,
  Event,
  EventPayload,
  TaskCreatedPayload,
  TaskCompletedPayload,
  ConfigChangedPayload,
  TeamCreatedPayload,
  AgentStartedPayload,
  HeartbeatReceivedPayload,
  ContainerStateChangedPayload,
  LogEntryPayload,
  LogQueryOpts,
  MasterConfig,
  SystemConfig,
  ArchiveConfig,
  AssistantConfig,
  ChannelsConfig,
  ChannelConfig,
  Trigger,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true — a simple runtime check that lets us verify the object was
 *  constructed without throwing. The actual type safety guarantee lives at
 *  compile time (TypeScript strict mode). */
function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

// ---------------------------------------------------------------------------
// JsonValue
// ---------------------------------------------------------------------------

describe('JsonValue', () => {
  it('accepts a string', () => {
    const v: JsonValue = 'hello';
    expect(typeof v).toBe('string');
  });

  it('accepts a number', () => {
    const v: JsonValue = 42;
    expect(typeof v).toBe('number');
  });

  it('accepts a boolean', () => {
    const v: JsonValue = true;
    expect(typeof v).toBe('boolean');
  });

  it('accepts null', () => {
    const v: JsonValue = null;
    expect(v).toBeNull();
  });

  it('accepts an array of JsonValues', () => {
    const v: JsonValue = [1, 'two', null, false];
    expect(Array.isArray(v)).toBe(true);
  });

  it('accepts an object with JsonValue values', () => {
    const v: JsonValue = { key: 'value', count: 3, flag: true };
    expect(isObject(v)).toBe(true);
  });

  it('accepts a deeply nested structure', () => {
    const v: JsonValue = {
      outer: {
        inner: [1, 2, { deep: null }],
      },
    };
    expect(isObject(v)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

describe('Agent', () => {
  it('accepts all required fields', () => {
    const agent: Agent = {
      aid: 'aid-abc-123',
      name: 'CodeBot',
    };
    expect(agent.aid).toBe('aid-abc-123');
    expect(agent.name).toBe('CodeBot');
  });

  it('accepts optional fields when provided', () => {
    const agent: Agent = {
      aid: 'aid-abc-123',
      name: 'CodeBot',
      provider: 'default',
      model_tier: 'sonnet',
      skills: ['code-review', 'testing'],
      max_turns: 10,
      timeout_minutes: 30,
      leads_team: 'engineering',
    };
    expect(agent.skills).toHaveLength(2);
    expect(agent.leads_team).toBe('engineering');
  });

  it('allows optional fields to be omitted', () => {
    const agent: Agent = { aid: 'aid-xyz', name: 'Minimal' };
    expect(agent.provider).toBeUndefined();
    expect(agent.leads_team).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

describe('Team', () => {
  it('accepts a minimal team', () => {
    const team: Team = {
      tid: 'tid-001',
      slug: 'engineering',
      leader_aid: 'aid-lead-001',
    };
    expect(team.tid).toBe('tid-001');
  });

  it('accepts a fully-populated team', () => {
    const agent: Agent = { aid: 'aid-001', name: 'Dev' };
    const mcp: MCPServer = { name: 'github', command: 'uvx', args: ['mcp-server-github'] };
    const config: ContainerConfig = { max_memory: '2g', max_old_space: 1536 };

    const team: Team = {
      tid: 'tid-002',
      slug: 'engineering',
      parent_slug: 'root',
      leader_aid: 'aid-lead-001',
      children: ['tid-003'],
      agents: [agent],
      mcp_servers: [mcp],
      env_vars: { NODE_ENV: 'production' },
      container_config: config,
    };
    expect(team.children).toHaveLength(1);
    expect(team.env_vars?.['NODE_ENV']).toBe('production');
  });
});

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

describe('Provider', () => {
  it('accepts an oauth provider', () => {
    const provider: Provider = {
      name: 'default',
      type: 'oauth',
    };
    expect(provider.type).toBe('oauth');
  });

  it('accepts an anthropic_direct provider', () => {
    const provider: Provider = {
      name: 'anthropic',
      type: 'anthropic_direct',
      base_url: 'https://api.anthropic.com',
      models: { haiku: 'claude-haiku-3', sonnet: 'claude-sonnet-4-5', opus: 'claude-opus-4' },
    };
    expect(provider.models?.['haiku']).toBe('claude-haiku-3');
  });

  it('allows optional fields to be omitted', () => {
    const provider: Provider = { name: 'minimal', type: 'oauth' };
    expect(provider.base_url).toBeUndefined();
    expect(provider.models).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

describe('Skill', () => {
  it('accepts a minimal skill', () => {
    const skill: Skill = { name: 'testing' };
    expect(skill.name).toBe('testing');
  });

  it('accepts a fully-populated skill', () => {
    const skill: Skill = {
      name: 'code-review',
      description: 'Reviews code for quality and correctness',
      model_tier: 'sonnet',
      tools: ['read_file', 'list_directory'],
      system_prompt_addition: 'Focus on SOLID principles.',
    };
    expect(skill.tools).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

describe('Task', () => {
  it('accepts Date objects for time fields', () => {
    const now = new Date();
    const task: Task = {
      id: 'task-001',
      team_slug: 'engineering',
      status: 'pending',
      prompt: 'Write a function that sorts an array.',
      created_at: now,
      updated_at: now,
      completed_at: null,
    };
    expect(task.created_at).toBeInstanceOf(Date);
    expect(task.completed_at).toBeNull();
  });

  it('accepts a Date for completed_at when the task is done', () => {
    const now = new Date();
    const task: Task = {
      id: 'task-002',
      team_slug: 'engineering',
      status: 'completed',
      prompt: 'Fix the bug.',
      result: 'Bug fixed.',
      created_at: now,
      updated_at: now,
      completed_at: new Date(),
    };
    expect(task.completed_at).toBeInstanceOf(Date);
  });

  it('allows optional fields to be omitted', () => {
    const task: Task = {
      id: 'task-003',
      team_slug: 'engineering',
      status: 'running',
      prompt: 'Analyse logs.',
      created_at: new Date(),
      updated_at: new Date(),
      completed_at: null,
    };
    expect(task.parent_id).toBeUndefined();
    expect(task.agent_aid).toBeUndefined();
    expect(task.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TaskResult
// ---------------------------------------------------------------------------

describe('TaskResult', () => {
  it('accepts required fields', () => {
    const result: TaskResult = {
      task_id: 'task-001',
      status: 'completed',
      duration: 5000,
    };
    expect(result.duration).toBe(5000);
  });

  it('accepts optional fields', () => {
    const result: TaskResult = {
      task_id: 'task-001',
      status: 'completed',
      result: 'Done.',
      files_created: ['output.txt'],
      duration: 3200,
    };
    expect(result.files_created).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

describe('Message', () => {
  it('accepts a Date for timestamp', () => {
    const msg: Message = {
      id: 'msg-001',
      chat_jid: 'discord:1234',
      role: 'user',
      content: 'Hello!',
      timestamp: new Date(),
    };
    expect(msg.timestamp).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// ChatSession
// ---------------------------------------------------------------------------

describe('ChatSession', () => {
  it('accepts Date objects for timestamp fields', () => {
    const now = new Date();
    const session: ChatSession = {
      chat_jid: 'discord:abc',
      channel_type: 'discord',
      last_timestamp: now,
      last_agent_timestamp: now,
    };
    expect(session.last_timestamp).toBeInstanceOf(Date);
  });

  it('allows optional fields to be omitted', () => {
    const session: ChatSession = {
      chat_jid: 'discord:abc',
      channel_type: 'discord',
      last_timestamp: new Date(),
      last_agent_timestamp: new Date(),
    };
    expect(session.session_id).toBeUndefined();
    expect(session.agent_aid).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// LogEntry
// ---------------------------------------------------------------------------

describe('LogEntry', () => {
  it('accepts a JsonValue for params', () => {
    const entry: LogEntry = {
      id: 1,
      level: 'info',
      component: 'api',
      action: 'request',
      message: 'GET /health',
      params: { method: 'GET', path: '/health', duration_ms: 12 },
      created_at: new Date(),
    };
    expect(isObject(entry.params)).toBe(true);
  });

  it('allows params to be omitted', () => {
    const entry: LogEntry = {
      id: 2,
      level: 'error',
      component: 'container',
      action: 'start_failed',
      message: 'Container failed to start',
      created_at: new Date(),
    };
    expect(entry.params).toBeUndefined();
  });

  it('accepts a Date for created_at', () => {
    const entry: LogEntry = {
      id: 3,
      level: 'debug',
      component: 'ws',
      action: 'connect',
      message: 'New WebSocket connection',
      created_at: new Date('2026-01-01T00:00:00Z'),
    };
    expect(entry.created_at).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// MCPServer
// ---------------------------------------------------------------------------

describe('MCPServer', () => {
  it('accepts required fields', () => {
    const mcp: MCPServer = { name: 'github', command: 'uvx' };
    expect(mcp.name).toBe('github');
  });

  it('accepts optional fields', () => {
    const mcp: MCPServer = {
      name: 'github',
      command: 'uvx',
      args: ['mcp-server-github'],
      env: { GITHUB_TOKEN: '{secrets.GITHUB_TOKEN}' },
    };
    expect(mcp.args).toHaveLength(1);
    expect(mcp.env?.['GITHUB_TOKEN']).toBe('{secrets.GITHUB_TOKEN}');
  });
});

// ---------------------------------------------------------------------------
// ContainerConfig
// ---------------------------------------------------------------------------

describe('ContainerConfig', () => {
  it('accepts an empty object (all fields optional)', () => {
    const config: ContainerConfig = {};
    expect(config.max_memory).toBeUndefined();
  });

  it('accepts a fully-populated config', () => {
    const config: ContainerConfig = {
      max_memory: '4g',
      max_old_space: 3072,
      idle_timeout: '30m',
      env: { CUSTOM: 'val' },
      name: 'openhive-engineering',
      image_name: 'openhive-team:latest',
    };
    expect(config.name).toBe('openhive-engineering');
  });
});

// ---------------------------------------------------------------------------
// ContainerInfo
// ---------------------------------------------------------------------------

describe('ContainerInfo', () => {
  it('accepts a valid container info object', () => {
    const info: ContainerInfo = {
      id: 'abc123def456',
      name: 'openhive-engineering',
      state: 'running',
    };
    expect(info.state).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// AgentHeartbeatStatus
// ---------------------------------------------------------------------------

describe('AgentHeartbeatStatus', () => {
  it('accepts required fields', () => {
    const status: AgentHeartbeatStatus = {
      aid: 'aid-001',
      status: 'idle',
      detail: '',
      elapsed_seconds: 0,
      memory_mb: 128.5,
    };
    expect(status.memory_mb).toBe(128.5);
  });
});

// ---------------------------------------------------------------------------
// HeartbeatStatus
// ---------------------------------------------------------------------------

describe('HeartbeatStatus', () => {
  it('accepts a Date for last_seen', () => {
    const hb: HeartbeatStatus = {
      team_id: 'tid-001',
      agents: [],
      last_seen: new Date(),
      is_healthy: true,
    };
    expect(hb.last_seen).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// EventPayload discriminated union
// ---------------------------------------------------------------------------

describe('EventPayload — discriminated union narrowing', () => {
  /**
   * Processes an EventPayload and returns a string description.
   * Uses exhaustive narrowing via switch on 'kind'.
   */
  function describePayload(payload: EventPayload): string {
    switch (payload.kind) {
      case 'task_created':
        return `task_created: ${payload.task.id}`;
      case 'task_updated':
        return `task_updated: ${payload.task.id}`;
      case 'task_completed':
        return `task_completed: ${payload.task_id}`;
      case 'task_failed':
        return `task_failed: ${payload.task_id} — ${payload.error}`;
      case 'task_cancelled':
        return `task_cancelled: ${payload.task_id}`;
      case 'config_changed':
        return `config_changed: ${payload.path}`;
      case 'team_created':
        return `team_created: ${payload.team_id}`;
      case 'team_deleted':
        return `team_deleted: ${payload.team_id}`;
      case 'agent_started':
        return `agent_started: ${payload.aid}`;
      case 'agent_stopped':
        return `agent_stopped: ${payload.aid}`;
      case 'channel_message':
        return `channel_message: ${payload.jid}`;
      case 'heartbeat_received':
        return `heartbeat_received: ${payload.team_id}`;
      case 'container_state_changed':
        return `container_state_changed: ${payload.team_id} → ${payload.state}`;
      case 'log_entry':
        return `log_entry: ${payload.entry.message}`;
    }
  }

  it('narrows task_created correctly', () => {
    const now = new Date();
    const task: Task = {
      id: 'task-001',
      team_slug: 'eng',
      status: 'pending',
      prompt: 'Do something.',
      created_at: now,
      updated_at: now,
      completed_at: null,
    };
    const payload: TaskCreatedPayload = { kind: 'task_created', task };
    expect(describePayload(payload)).toBe('task_created: task-001');
  });

  it('narrows task_completed correctly', () => {
    const result: TaskResult = { task_id: 'task-002', status: 'completed', duration: 1000 };
    const payload: TaskCompletedPayload = { kind: 'task_completed', task_id: 'task-002', result };
    expect(describePayload(payload)).toBe('task_completed: task-002');
  });

  it('narrows config_changed correctly', () => {
    const payload: ConfigChangedPayload = { kind: 'config_changed', path: 'data/openhive.yaml' };
    expect(describePayload(payload)).toBe('config_changed: data/openhive.yaml');
  });

  it('narrows team_created correctly', () => {
    const payload: TeamCreatedPayload = { kind: 'team_created', team_id: 'tid-007' };
    expect(describePayload(payload)).toBe('team_created: tid-007');
  });

  it('narrows agent_started correctly', () => {
    const payload: AgentStartedPayload = { kind: 'agent_started', aid: 'aid-001', team_id: 'tid-001' };
    expect(describePayload(payload)).toBe('agent_started: aid-001');
  });

  it('narrows heartbeat_received correctly', () => {
    const status: HeartbeatStatus = {
      team_id: 'tid-001',
      agents: [],
      last_seen: new Date(),
      is_healthy: true,
    };
    const payload: HeartbeatReceivedPayload = {
      kind: 'heartbeat_received',
      team_id: 'tid-001',
      status,
    };
    expect(describePayload(payload)).toBe('heartbeat_received: tid-001');
  });

  it('narrows container_state_changed correctly', () => {
    const payload: ContainerStateChangedPayload = {
      kind: 'container_state_changed',
      team_id: 'tid-002',
      state: 'running',
    };
    expect(describePayload(payload)).toBe('container_state_changed: tid-002 → running');
  });

  it('narrows log_entry correctly', () => {
    const entry: LogEntry = {
      id: 99,
      level: 'warn',
      component: 'orchestrator',
      action: 'retry',
      message: 'Retrying task',
      created_at: new Date(),
    };
    const payload: LogEntryPayload = { kind: 'log_entry', entry };
    expect(describePayload(payload)).toBe('log_entry: Retrying task');
  });
});

// ---------------------------------------------------------------------------
// Event
// ---------------------------------------------------------------------------

describe('Event', () => {
  it('combines EventType with EventPayload correctly', () => {
    const event: Event = {
      type: 'team_created',
      payload: { kind: 'team_created', team_id: 'tid-001' },
    };
    expect(event.type).toBe('team_created');
    expect(event.payload.kind).toBe('team_created');
  });
});

// ---------------------------------------------------------------------------
// LogQueryOpts
// ---------------------------------------------------------------------------

describe('LogQueryOpts', () => {
  it('allows all fields to be omitted (empty query)', () => {
    const opts: LogQueryOpts = {};
    expect(opts.level).toBeUndefined();
    expect(opts.limit).toBeUndefined();
  });

  it('accepts nullable Date fields', () => {
    const opts: LogQueryOpts = {
      since: null,
      until: null,
    };
    expect(opts.since).toBeNull();
    expect(opts.until).toBeNull();
  });

  it('accepts Date values for since and until', () => {
    const opts: LogQueryOpts = {
      since: new Date('2026-01-01'),
      until: new Date('2026-12-31'),
    };
    expect(opts.since).toBeInstanceOf(Date);
    expect(opts.until).toBeInstanceOf(Date);
  });

  it('accepts a fully-specified query', () => {
    const opts: LogQueryOpts = {
      level: 'error',
      component: 'api',
      team_name: 'engineering',
      agent_name: 'CodeBot',
      task_id: 'task-001',
      since: new Date('2026-01-01'),
      until: new Date('2026-12-31'),
      limit: 100,
      offset: 50,
    };
    expect(opts.limit).toBe(100);
    expect(opts.offset).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

describe('ArchiveConfig', () => {
  it('accepts all required fields', () => {
    const cfg: ArchiveConfig = {
      enabled: true,
      max_entries: 10000,
      keep_copies: 5,
      archive_dir: '.run/archives/logs',
    };
    expect(cfg.enabled).toBe(true);
  });
});

describe('ChannelConfig', () => {
  it('accepts a minimal channel config', () => {
    const cfg: ChannelConfig = { enabled: false };
    expect(cfg.enabled).toBe(false);
    expect(cfg.token).toBeUndefined();
  });

  it('accepts a full discord config', () => {
    const cfg: ChannelConfig = {
      enabled: true,
      channel_id: '123456789',
    };
    expect(cfg.channel_id).toBe('123456789');
  });
});

describe('ChannelsConfig', () => {
  it('contains discord and whatsapp sub-configs', () => {
    const cfg: ChannelsConfig = {
      discord: { enabled: true, channel_id: '999' },
      whatsapp: { enabled: false },
    };
    expect(cfg.discord.enabled).toBe(true);
    expect(cfg.whatsapp.enabled).toBe(false);
  });
});

describe('AssistantConfig', () => {
  it('accepts required fields', () => {
    const cfg: AssistantConfig = {
      name: 'Hive',
      aid: 'aid-main-001',
      provider: 'default',
      model_tier: 'opus',
      max_turns: 50,
      timeout_minutes: 120,
    };
    expect(cfg.name).toBe('Hive');
  });

  it('accepts a minimal config with only required fields', () => {
    const cfg: AssistantConfig = {
      name: 'Hive',
      aid: 'aid-main-001',
      provider: 'default',
      model_tier: 'sonnet',
      max_turns: 10,
      timeout_minutes: 30,
    };
    expect(cfg.name).toBe('Hive');
    expect(cfg.model_tier).toBe('sonnet');
  });
});

describe('SystemConfig', () => {
  it('accepts a fully-populated system config', () => {
    const archive: ArchiveConfig = {
      enabled: true,
      max_entries: 50000,
      keep_copies: 3,
      archive_dir: '.run/archives',
    };
    const cfg: SystemConfig = {
      listen_address: ':8080',
      data_dir: 'data',
      workspace_root: '.run/workspace',
      log_level: 'info',
      log_archive: archive,
      max_message_length: 4096,
      default_idle_timeout: '30m',
      event_bus_workers: 4,
      portal_ws_max_connections: 100,
      message_archive: archive,
    };
    expect(cfg.listen_address).toBe(':8080');
    expect(cfg.event_bus_workers).toBe(4);
  });
});

describe('MasterConfig', () => {
  it('accepts a minimal master config', () => {
    const archive: ArchiveConfig = {
      enabled: false,
      max_entries: 0,
      keep_copies: 0,
      archive_dir: '',
    };
    const system: SystemConfig = {
      listen_address: ':8080',
      data_dir: 'data',
      workspace_root: '.run/workspace',
      log_level: 'info',
      log_archive: archive,
      max_message_length: 2048,
      default_idle_timeout: '15m',
      event_bus_workers: 2,
      portal_ws_max_connections: 50,
      message_archive: archive,
    };
    const assistant: AssistantConfig = {
      name: 'Hive',
      aid: 'aid-main-001',
      provider: 'default',
      model_tier: 'opus',
      max_turns: 50,
      timeout_minutes: 60,
    };
    const channels: ChannelsConfig = {
      discord: { enabled: false },
      whatsapp: { enabled: false },
    };
    const master: MasterConfig = { system, assistant, channels };
    expect(master.agents).toBeUndefined();
    expect(master.channels.discord.enabled).toBe(false);
  });

  it('accepts root-level agents', () => {
    const archive: ArchiveConfig = {
      enabled: false,
      max_entries: 0,
      keep_copies: 0,
      archive_dir: '',
    };
    const system: SystemConfig = {
      listen_address: ':8080',
      data_dir: 'data',
      workspace_root: '.run/workspace',
      log_level: 'info',
      log_archive: archive,
      max_message_length: 2048,
      default_idle_timeout: '15m',
      event_bus_workers: 2,
      portal_ws_max_connections: 50,
      message_archive: archive,
    };
    const assistant: AssistantConfig = {
      name: 'Hive',
      aid: 'aid-main-001',
      provider: 'default',
      model_tier: 'opus',
      max_turns: 50,
      timeout_minutes: 60,
    };
    const channels: ChannelsConfig = {
      discord: { enabled: false },
      whatsapp: { enabled: false },
    };
    const master: MasterConfig = {
      system,
      assistant,
      channels,
      agents: [{ aid: 'aid-lead-001', name: 'EngineeringLead', leads_team: 'engineering' }],
    };
    expect(master.agents).toHaveLength(1);
    expect(master.agents?.[0]?.leads_team).toBe('engineering');
  });
});

// ---------------------------------------------------------------------------
// SkillInfo
// ---------------------------------------------------------------------------

describe('SkillInfo', () => {
  it('accepts all required fields', () => {
    const info: SkillInfo = {
      name: 'code-review',
      description: 'Reviews code for quality issues',
      registry_url: 'https://skills.example.com',
      source_url: 'https://skills.example.com/code-review/SKILL.md',
    };
    expect(info.name).toBe('code-review');
    expect(info.source_url).toContain('SKILL.md');
  });
});

// ---------------------------------------------------------------------------
// Trigger type extensions
// ---------------------------------------------------------------------------

describe('Trigger type field', () => {
  function makeTrigger(type: Trigger['type']): Trigger {
    return {
      id: 'trg-001',
      name: 'test-trigger',
      team_slug: 'engineering',
      agent_aid: 'aid-001',
      schedule: '0 */5 * * *',
      prompt: 'Check status',
      enabled: true,
      type,
      last_run_at: null,
      next_run_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
  }

  it('accepts cron type', () => {
    const t = makeTrigger('cron');
    expect(t.type).toBe('cron');
  });

  it('accepts webhook type', () => {
    const t = makeTrigger('webhook');
    expect(t.type).toBe('webhook');
  });

  it('accepts channel_event type', () => {
    const t = makeTrigger('channel_event');
    expect(t.type).toBe('channel_event');
  });

  it('accepts task_completion type', () => {
    const t = makeTrigger('task_completion');
    expect(t.type).toBe('task_completion');
  });

  it('accepts undefined type (defaults to cron)', () => {
    const t = makeTrigger(undefined);
    expect(t.type).toBeUndefined();
  });
});
