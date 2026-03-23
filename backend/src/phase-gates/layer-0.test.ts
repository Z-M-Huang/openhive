/**
 * Layer 0 Phase Gate — Stub scaffold
 *
 * Verifies that:
 * 1. TypeScript compiles (domain types can be imported)
 * 2. Domain types have the correct shape
 * 3. Errors extend OpenHiveError
 * 4. Interfaces are defined
 * 5. Dockerfile exists
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  TaskPriority,
  TeamStatus,
  TaskStatus,
  type TeamConfig,
  type TriggerConfig,
  type ProviderProfile,
  type EscalationCorrelation,
  type LogEntry,
  type OrgTreeNode,
  type TaskEntry,
} from '../domain/types.js';

import type {
  ISessionSpawner,
  ISessionManager,
  IChannelAdapter,
  IOrgStore,
  ITaskQueueStore,
  ITriggerStore,
  ILogStore,
  IEscalationStore,
  IMemoryStore,
} from '../domain/interfaces.js';

import {
  OpenHiveError,
  ConfigError,
  ValidationError,
  ScopeRejectionError,
  WorkspaceBoundaryError,
  SecretLeakError,
} from '../domain/errors.js';

// ── 1. TypeScript compiles (imports above succeed) ─────────────────────────

describe('Layer 0: TypeScript compilation', () => {
  it('imports domain types without error', () => {
    // If we reach this point, the import worked
    expect(TaskPriority.Normal).toBe('normal');
    expect(TeamStatus.Active).toBe('active');
    expect(TaskStatus.Pending).toBe('pending');
  });
});

// ── 2. Domain types have correct shape ─────────────────────────────────────

describe('Layer 0: Domain type shapes', () => {
  it('TeamConfig has required fields', () => {
    const team: TeamConfig = {
      name: 'test-team',
      parent: null,
      description: 'A test team',
      scope: { accepts: ['*'], rejects: [] },
      allowed_tools: [],
      mcp_servers: [],
      provider_profile: 'default-sonnet',
      maxTurns: 10,
    };

    expect(team.name).toBe('test-team');
    expect(team.parent).toBeNull();
    expect(team.scope.accepts).toEqual(['*']);
    expect(team.maxTurns).toBe(10);
  });

  it('TriggerConfig has required fields', () => {
    const trigger: TriggerConfig = {
      name: 'daily-check',
      type: 'schedule',
      config: { cron: '0 9 * * *' },
      team: 'main',
      task: 'health check',
    };

    expect(trigger.type).toBe('schedule');
    expect(trigger.skill).toBeUndefined();
  });

  it('ProviderProfile has required fields', () => {
    const provider: ProviderProfile = {
      name: 'default-sonnet',
      type: 'api',
      model: 'claude-sonnet-4-20250514',
    };

    expect(provider.type).toBe('api');
    expect(provider.oauth_token_env).toBeUndefined();
  });

  it('EscalationCorrelation has required fields', () => {
    const esc: EscalationCorrelation = {
      correlationId: 'esc-001',
      sourceTeam: 'team-a',
      targetTeam: 'main',
      taskId: null,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    expect(esc.correlationId).toBe('esc-001');
  });

  it('TaskEntry has required fields', () => {
    const entry: TaskEntry = {
      id: 'task-001',
      teamId: 'tid-test-abc123',
      task: 'do something',
      priority: TaskPriority.Normal,
      status: TaskStatus.Pending,
      createdAt: new Date().toISOString(),
      correlationId: null,
    };

    expect(entry.id).toBe('task-001');
  });

  it('LogEntry has required fields', () => {
    const entry: LogEntry = {
      id: 'log-001',
      level: 'info',
      message: 'Test log',
      timestamp: Date.now(),
      source: 'test',
    };

    expect(entry.level).toBe('info');
    expect(entry.metadata).toBeUndefined();
  });

  it('OrgTreeNode has required fields', () => {
    const node: OrgTreeNode = {
      teamId: 'tid-test-abc123',
      name: 'test',
      parentId: null,
      status: TeamStatus.Active,
      agents: ['aid-agent1-def456'],
      children: [],
    };

    expect(node.children).toEqual([]);
  });

  it('TaskPriority enum has all values', () => {
    expect(TaskPriority.Critical).toBe('critical');
    expect(TaskPriority.High).toBe('high');
    expect(TaskPriority.Normal).toBe('normal');
    expect(TaskPriority.Low).toBe('low');
  });

  it('TeamStatus enum has all values', () => {
    expect(TeamStatus.Active).toBe('active');
    expect(TeamStatus.Idle).toBe('idle');
    expect(TeamStatus.Shutdown).toBe('shutdown');
  });

  it('TaskStatus enum has all values', () => {
    expect(TaskStatus.Pending).toBe('pending');
    expect(TaskStatus.Running).toBe('running');
    expect(TaskStatus.Completed).toBe('completed');
    expect(TaskStatus.Failed).toBe('failed');
  });
});

// ── 3. Errors extend OpenHiveError ─────────────────────────────────────────

describe('Layer 0: Error hierarchy', () => {
  const errorClasses = [
    { Cls: ConfigError, name: 'ConfigError' },
    { Cls: ValidationError, name: 'ValidationError' },
    { Cls: ScopeRejectionError, name: 'ScopeRejectionError' },
    { Cls: WorkspaceBoundaryError, name: 'WorkspaceBoundaryError' },
    { Cls: SecretLeakError, name: 'SecretLeakError' },
  ];

  for (const { Cls, name } of errorClasses) {
    it(`${name} extends OpenHiveError`, () => {
      const err = new Cls('test');
      expect(err).toBeInstanceOf(OpenHiveError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(name);
      expect(err.message).toBe('test');
    });
  }
});

// ── 4. Interfaces are defined ──────────────────────────────────────────────

describe('Layer 0: Interfaces exist', () => {
  it('all store interfaces are importable', () => {
    // TypeScript compile-time check: if these types didn't exist,
    // the import above would fail and this test file wouldn't compile.
    // We verify at runtime by creating a minimal conforming object.

    const orgStore: IOrgStore = {
      addTeam: () => {},
      removeTeam: () => {},
      getTeam: () => undefined,
      getChildren: () => [],
      getAncestors: () => [],
      getAll: () => [],
    };

    expect(orgStore.getTeam).toBeDefined();
  });

  it('IChannelAdapter shape is correct', () => {
    const adapter: IChannelAdapter = {
      connect: async () => {},
      disconnect: async () => {},
      onMessage: () => {},
      sendResponse: async () => {},
    };

    expect(adapter.connect).toBeDefined();
    expect(adapter.disconnect).toBeDefined();
    expect(adapter.onMessage).toBeDefined();
    expect(adapter.sendResponse).toBeDefined();
  });

  it('ISessionSpawner and ISessionManager shapes are correct', () => {
    const spawner: ISessionSpawner = {
      spawn: async () => 'session-id',
    };
    const manager: ISessionManager = {
      getSession: async () => null,
      terminateSession: async () => {},
    };

    expect(spawner.spawn).toBeDefined();
    expect(manager.getSession).toBeDefined();
  });

  it('IMemoryStore shape is correct', () => {
    const store: IMemoryStore = {
      readFile: () => undefined,
      writeFile: () => {},
      listFiles: () => [],
    };

    expect(store.readFile).toBeDefined();
    expect(store.writeFile).toBeDefined();
  });

  it('ITaskQueueStore shape is correct', () => {
    const store: ITaskQueueStore = {
      enqueue: () => 'task-id',
      dequeue: () => undefined,
      peek: () => undefined,
      getByTeam: () => [],
      updateStatus: () => {},
      getPending: () => [],
      getByStatus: () => [],
    };

    expect(store.enqueue).toBeDefined();
    expect(store.dequeue).toBeDefined();
  });

  it('ITriggerStore shape is correct', () => {
    const store: ITriggerStore = {
      checkDedup: () => false,
      recordEvent: () => {},
      cleanExpired: () => 0,
    };

    expect(store.checkDedup).toBeDefined();
  });

  it('ILogStore shape is correct', () => {
    const store: ILogStore = {
      append: () => {},
      query: () => [],
    };

    expect(store.append).toBeDefined();
    expect(store.query).toBeDefined();
  });

  it('IEscalationStore shape is correct', () => {
    const store: IEscalationStore = {
      create: () => {},
      updateStatus: () => {},
      getByCorrelationId: () => undefined,
    };

    expect(store.create).toBeDefined();
    expect(store.getByCorrelationId).toBeDefined();
  });
});

// ── 5. Dockerfile exists ───────────────────────────────────────────────────

describe('Layer 0: Infrastructure files', () => {
  it('Dockerfile exists', () => {
    const dockerfilePath = resolve(
      import.meta.dirname,
      '../../../deployments/Dockerfile',
    );
    expect(existsSync(dockerfilePath)).toBe(true);
  });
});
