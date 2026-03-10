/**
 * OpenHive Backend - API Server Tests
 *
 * Tests for createServer: middleware wiring, route registration,
 * graceful shutdown, and SPA fallback.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createServer } from './server.js';
import type { ServerDeps } from './server.js';
import type { MiddlewareLogger } from './middleware.js';
import type { KeyManager, ConfigLoader, OrgChart, Orchestrator, TaskStore, LogStore, TriggerScheduler, TaskCoordinator } from '../domain/interfaces.js';
import type { Trigger } from '../domain/types.js';
import type { MasterConfig } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopLogger: MiddlewareLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const mockConfig = {
  system: {
    listen_address: ':8080',
    data_dir: '/data',
    workspace_root: '/workspace',
    log_level: 'info',
  },
  channels: {
    discord: { enabled: false },
    whatsapp: { enabled: false },
  },
} as unknown as MasterConfig;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockKm: KeyManager = {
  isLocked: vi.fn().mockReturnValue(false),
  unlock: vi.fn().mockResolvedValue(undefined),
  encrypt: vi.fn().mockResolvedValue('encrypted'),
  decrypt: vi.fn().mockResolvedValue('decrypted'),
  lock: vi.fn(),
};

const mockConfigLoader: ConfigLoader = {
  loadMaster: vi.fn().mockResolvedValue(mockConfig),
  saveMaster: vi.fn().mockResolvedValue(undefined),
  getMaster: vi.fn().mockReturnValue(mockConfig),
  loadProviders: vi.fn().mockResolvedValue({}),
  saveProviders: vi.fn().mockResolvedValue(undefined),
  loadTeam: vi.fn().mockRejectedValue(new Error('not found')),
  saveTeam: vi.fn().mockResolvedValue(undefined),
  createTeamDir: vi.fn().mockResolvedValue(undefined),
  deleteTeamDir: vi.fn().mockResolvedValue(undefined),
  listTeams: vi.fn().mockResolvedValue([]),
  watchMaster: vi.fn().mockResolvedValue(undefined),
  watchProviders: vi.fn().mockResolvedValue(undefined),
  watchTeam: vi.fn().mockResolvedValue(undefined),
  stopWatching: vi.fn(),
};

const mockOrgChart: OrgChart = {
  getOrgChart: vi.fn().mockReturnValue({}),
  getAgentByAID: vi.fn().mockImplementation(() => { throw new Error('not found'); }),
  getTeamBySlug: vi.fn().mockImplementation(() => { throw new Error('not found'); }),
  getTeamForAgent: vi.fn().mockImplementation(() => { throw new Error('not found'); }),
  getLeadTeams: vi.fn().mockReturnValue([]),
  getSubordinates: vi.fn().mockReturnValue([]),
  getSupervisor: vi.fn().mockReturnValue(null),
  rebuildFromConfig: vi.fn(),
};

const mockOrch: Orchestrator = {
  createTeam: vi.fn().mockResolvedValue({ slug: 'test', tid: 'tid-1', leader_aid: 'aid-1', agents: [] }),
  deleteTeam: vi.fn().mockResolvedValue(undefined),
  getTeam: vi.fn().mockRejectedValue(new Error('not found')),
  listTeams: vi.fn().mockResolvedValue([]),
  updateTeam: vi.fn().mockResolvedValue({}),
  dispatchTask: vi.fn().mockResolvedValue(undefined),
  handleTaskResult: vi.fn().mockResolvedValue(undefined),
  cancelTask: vi.fn().mockResolvedValue(undefined),
  getTaskStatus: vi.fn().mockRejectedValue(new Error('not found')),
  createSubtasks: vi.fn().mockResolvedValue([]),
  getHealthStatus: vi.fn().mockImplementation(() => { throw new Error('not found'); }),
  handleUnhealthy: vi.fn().mockResolvedValue(undefined),
  getAllStatuses: vi.fn().mockReturnValue({}),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
};

const mockTaskStore: TaskStore = {
  create: vi.fn().mockResolvedValue(undefined),
  get: vi.fn().mockRejectedValue(new Error('not found')),
  update: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  listByTeam: vi.fn().mockResolvedValue([]),
  listByStatus: vi.fn().mockResolvedValue([]),
  getSubtree: vi.fn().mockResolvedValue([]),
  getDependents: vi.fn().mockResolvedValue([]),
  getBlockedBy: vi.fn().mockResolvedValue([]),
  unblockTask: vi.fn().mockResolvedValue(true),
  retryTask: vi.fn().mockResolvedValue(false),
  validateDependencies: vi.fn().mockResolvedValue(undefined),
};

const mockLogStore: LogStore = {
  create: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
  deleteBefore: vi.fn().mockResolvedValue(0),
  count: vi.fn().mockResolvedValue(0),
  getOldest: vi.fn().mockResolvedValue([]),
};

// ---------------------------------------------------------------------------
// Tests 1–7: shared server instance
// ---------------------------------------------------------------------------

describe('createServer', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const deps: ServerDeps = {
      configLoader: mockConfigLoader,
      orgChart: mockOrgChart,
      orchestrator: mockOrch,
      taskStore: mockTaskStore,
      logStore: mockLogStore,
    };
    const instance = createServer(':0', noopLogger, mockKm, null, null, null, [], deps);
    app = instance.app;
    await app.ready();
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  it('registers all middleware', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-response-time']).toBeDefined();
  });

  it('registers health endpoint', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: { status: string } };
    expect(body.data.status).toBe('ok');
  });

  it('registers auth/unlock endpoint', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/unlock',
      payload: { master_key: 'test-key' },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: { status: string } };
    expect(body.data.status).toBe('unlocked');
  });

  it('registers config endpoints when configLoader provided', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/config' });
    expect(res.statusCode).toBe(200);
  });

  it('registers team endpoints when orgChart provided', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/teams' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('registers task endpoints when taskStore provided', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tasks' });
    expect(res.statusCode).toBe(200);
  });

  it('registers log endpoint when logStore provided', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('handles graceful shutdown', async () => {
    const instance = createServer(':0', noopLogger, mockKm, null, null, null, []);
    await instance.start();
    expect(instance.app.server.listening).toBe(true);
    await instance.shutdown();
    expect(instance.app.server.listening).toBe(false);
  });

  it('serves SPA when spaDir provided', async () => {
    const spaDir = mkdtempSync(join(tmpdir(), 'server-spa-'));
    writeFileSync(join(spaDir, 'index.html'), '<html>SPA</html>');
    try {
      const spaInstance = createServer(':0', noopLogger, mockKm, spaDir, null, null, []);
      await spaInstance.app.ready();

      // Verify server initializes cleanly with spaDir configured.
      // Full SPA behavior (static files, client-side routing fallback, API 404) is tested in spa.test.ts.

      await spaInstance.shutdown();
    } finally {
      rmSync(spaDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Webhook trigger endpoint
// ---------------------------------------------------------------------------

describe('webhook trigger endpoint', () => {
  let hookApp: FastifyInstance;
  let mockTriggerScheduler: TriggerScheduler;
  let mockTaskCoordinator: TaskCoordinator;

  const webhookTrigger: Trigger = {
    id: 'trig-webhook-1',
    name: 'deploy-hook',
    team_slug: 'deploy-team',
    agent_aid: 'aid-deployer-001',
    schedule: '',
    prompt: 'run deploy script',
    enabled: true,
    type: 'webhook',
    webhook_path: 'deploy',
    last_run_at: null,
    next_run_at: null,
    created_at: new Date(1_000_000),
    updated_at: new Date(1_000_000),
  };

  beforeAll(async () => {
    mockTriggerScheduler = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      addTrigger: vi.fn().mockResolvedValue(undefined),
      removeTrigger: vi.fn().mockResolvedValue(undefined),
      listActive: vi.fn().mockReturnValue([]),
      getWebhookTrigger: vi.fn().mockImplementation((path: string) => {
        if (path === 'deploy') return webhookTrigger;
        return undefined;
      }),
    };

    mockTaskCoordinator = {
      dispatchTask: vi.fn().mockResolvedValue(undefined),
      handleTaskResult: vi.fn().mockResolvedValue(undefined),
      cancelTask: vi.fn().mockResolvedValue([]),
      getTaskStatus: vi.fn().mockRejectedValue(new Error('not found')),
      createSubtasks: vi.fn().mockResolvedValue([]),
    };

    const deps: ServerDeps = {
      triggerScheduler: mockTriggerScheduler,
      taskCoordinator: mockTaskCoordinator,
    };
    const instance = createServer(':0', noopLogger, mockKm, null, null, null, [], deps);
    hookApp = instance.app;
    await hookApp.ready();
  }, 30000);

  afterAll(async () => {
    await hookApp.close();
  });

  it('fires webhook trigger and returns 200 with trigger_id and task_id', async () => {
    const res = await hookApp.inject({
      method: 'POST',
      url: '/api/v1/hooks/deploy',
      payload: { ignored: 'data' },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { trigger_id: string; task_id: string };
    expect(body.trigger_id).toBe('trig-webhook-1');
    expect(body.task_id).toBeDefined();
    expect(body.task_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    // Verify dispatchTask was called with the trigger's pre-configured prompt (CSC-12)
    expect(mockTaskCoordinator.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'run deploy script',
        team_slug: 'deploy-team',
        agent_aid: 'aid-deployer-001',
        status: 'pending',
      }),
    );
  });

  it('returns 404 for unknown webhook path', async () => {
    const res = await hookApp.inject({
      method: 'POST',
      url: '/api/v1/hooks/nonexistent',
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('webhook not found');
  });
});
