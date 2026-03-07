/**
 * Tests for App — the main entry point wiring all backend components together.
 *
 * Tests cover:
 *   - Build: component creation order, graceful Docker failure, env var handling
 *   - Start/Shutdown: lifecycle guards, component lifecycle
 *   - Startup recovery: steps A.1–A.5 in correct order, try/catch isolation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Stubs — objects returned by mocked factory functions
// ---------------------------------------------------------------------------

const mockDB = { close: vi.fn() };

const mockTaskStore = {
  create: vi.fn().mockResolvedValue(undefined),
  get: vi.fn().mockResolvedValue({ task_id: 't1', jid: 'user:123', status: 'running', updated_at: new Date() }),
  update: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  listByTeam: vi.fn().mockResolvedValue([]),
  listByStatus: vi.fn().mockResolvedValue([]),
  getSubtree: vi.fn().mockResolvedValue([]),
};

const mockLogStore = {
  create: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
  deleteBefore: vi.fn().mockResolvedValue(0),
  count: vi.fn().mockResolvedValue(0),
  getOldest: vi.fn().mockResolvedValue([]),
};

const mockSessionStore = {
  get: vi.fn().mockResolvedValue(undefined),
  upsert: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  listAll: vi.fn().mockResolvedValue([]),
};

const mockMessageStore = {
  create: vi.fn().mockResolvedValue(undefined),
  getByChat: vi.fn().mockResolvedValue([]),
  getLatest: vi.fn().mockResolvedValue([]),
  deleteByChat: vi.fn().mockResolvedValue(undefined),
  deleteBefore: vi.fn().mockResolvedValue(0),
};

const mockDBLogger = {
  log: vi.fn(),
  droppedCount: vi.fn().mockReturnValue(0),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  stop: vi.fn().mockResolvedValue(undefined),
};

const makeArchiver = () => ({
  start: vi.fn(),
  stop: vi.fn().mockResolvedValue(undefined),
});

const mockConfigLoader = {
  loadMaster: vi.fn().mockResolvedValue({
    system: {
      listen_address: ':8080',
      data_dir: 'data',
      workspace_root: '.run/teams',
      log_level: 'info',
      log_archive: { enabled: false, max_entries: 1000, keep_copies: 1, archive_dir: '.run/archives/logs' },
      message_archive: { enabled: false, max_entries: 1000, keep_copies: 1, archive_dir: '.run/archives/messages' },
      max_message_length: 10000,
      default_idle_timeout: '30m',
      event_bus_workers: 4,
      portal_ws_max_connections: 10,
    },
    assistant: { name: 'asst', aid: 'aid-asst', provider: 'default', model_tier: 'sonnet', max_turns: 100, timeout_minutes: 30 },
    channels: { discord: { enabled: false }, whatsapp: { enabled: false } },
  }),
  getMaster: vi.fn().mockReturnValue({
    system: {
      listen_address: ':8080',
      data_dir: 'data',
      workspace_root: '.run/teams',
      log_level: 'info',
      log_archive: { enabled: false, max_entries: 1000, keep_copies: 1, archive_dir: '.run/archives/logs' },
      message_archive: { enabled: false, max_entries: 1000, keep_copies: 1, archive_dir: '.run/archives/messages' },
      max_message_length: 10000,
      default_idle_timeout: '30m',
      event_bus_workers: 4,
      portal_ws_max_connections: 10,
    },
    assistant: { name: 'asst', aid: 'aid-asst', provider: 'default', model_tier: 'sonnet', max_turns: 100, timeout_minutes: 30 },
    channels: { discord: { enabled: false }, whatsapp: { enabled: false } },
  }),
  saveMaster: vi.fn().mockResolvedValue(undefined),
  loadProviders: vi.fn().mockResolvedValue({}),
  saveProviders: vi.fn().mockResolvedValue(undefined),
  loadTeam: vi.fn().mockResolvedValue({}),
  saveTeam: vi.fn().mockResolvedValue(undefined),
  createTeamDir: vi.fn().mockResolvedValue(undefined),
  deleteTeamDir: vi.fn().mockResolvedValue(undefined),
  listTeams: vi.fn().mockResolvedValue([]),
  watchMaster: vi.fn().mockResolvedValue(undefined),
  watchProviders: vi.fn().mockResolvedValue(undefined),
  watchTeam: vi.fn().mockResolvedValue(undefined),
  stopWatching: vi.fn(),
  setKeyManager: vi.fn(),
  decryptChannelTokens: vi.fn().mockImplementation((channels: unknown) => Promise.resolve(channels)),
};

const mockOrgChart = {
  getOrgChart: vi.fn().mockReturnValue({}),
  getAgentByAID: vi.fn(),
  getTeamBySlug: vi.fn(),
  getTeamForAgent: vi.fn(),
  getLeadTeams: vi.fn().mockReturnValue([]),
  getSubordinates: vi.fn().mockReturnValue([]),
  getSupervisor: vi.fn().mockReturnValue(null),
  rebuildFromConfig: vi.fn(),
};

const mockEventBus = {
  publish: vi.fn(),
  subscribe: vi.fn().mockReturnValue('sub-id'),
  filteredSubscribe: vi.fn().mockReturnValue('sub-id'),
  unsubscribe: vi.fn(),
  close: vi.fn(),
};

const mockWSHub = {
  registerConnection: vi.fn(),
  unregisterConnection: vi.fn(),
  sendToTeam: vi.fn().mockResolvedValue(undefined),
  broadcastAll: vi.fn().mockResolvedValue(undefined),
  generateToken: vi.fn().mockReturnValue('tok-test'),
  getUpgradeHandler: vi.fn().mockReturnValue(vi.fn()),
  attachToServer: vi.fn(),
  getConnectedTeams: vi.fn().mockReturnValue([]),
  setOnMessage: vi.fn(),
  setOnConnect: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
};

const mockDispatcher = {
  setHeartbeatMonitor: vi.fn(),
  setToolHandler: vi.fn(),
  setTaskResultCallback: vi.fn(),
  setTaskWaiter: vi.fn(),
  handleWSMessage: vi.fn(),
  sendContainerInit: vi.fn().mockResolvedValue(undefined),
};

const mockHeartbeatMonitor = {
  processHeartbeat: vi.fn(),
  getStatus: vi.fn(),
  getAllStatuses: vi.fn().mockReturnValue({}),
  setOnUnhealthy: vi.fn(),
  startMonitoring: vi.fn(),
  stopMonitoring: vi.fn(),
  clearAll: vi.fn(),
  injectStaleStatus: vi.fn(),
};

const mockToolHandler = {
  register: vi.fn(),
  setOrgChart: vi.fn(),
  handleToolCall: vi.fn(),
  handleToolCallWithContext: vi.fn(),
};

const mockOrchestrator = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  createTeam: vi.fn().mockResolvedValue({}),
  deleteTeam: vi.fn().mockResolvedValue(undefined),
  getTeam: vi.fn().mockResolvedValue({}),
  listTeams: vi.fn().mockResolvedValue([]),
  updateTeam: vi.fn().mockResolvedValue({}),
  dispatchTask: vi.fn().mockResolvedValue(undefined),
  handleTaskResult: vi.fn().mockResolvedValue(undefined),
  cancelTask: vi.fn().mockResolvedValue(undefined),
  getTaskStatus: vi.fn().mockResolvedValue({}),
  createSubtasks: vi.fn().mockResolvedValue([]),
  getHealthStatus: vi.fn(),
  handleUnhealthy: vi.fn().mockResolvedValue(undefined),
  getAllStatuses: vi.fn().mockReturnValue({}),
};

const mockChildProc = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
};

const mockContainerManager = {
  ensureRunning: vi.fn().mockResolvedValue(undefined),
  provisionTeam: vi.fn().mockResolvedValue(undefined),
  removeTeam: vi.fn().mockResolvedValue(undefined),
  restartTeam: vi.fn().mockResolvedValue(undefined),
  stopTeam: vi.fn().mockResolvedValue(undefined),
  cleanup: vi.fn().mockResolvedValue(undefined),
  getStatus: vi.fn().mockReturnValue('running'),
  getContainerID: vi.fn().mockReturnValue('cid'),
};

const mockHttpServer = {};
const mockServer = {
  start: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  app: { server: mockHttpServer },
};

const mockPortalWS = { handleUpgrade: vi.fn() };

const mockRouter = {
  registerChannel: vi.fn().mockResolvedValue(undefined),
  unregisterChannel: vi.fn().mockResolvedValue(undefined),
  routeInbound: vi.fn().mockResolvedValue(undefined),
  routeOutbound: vi.fn().mockResolvedValue(undefined),
  getChannels: vi.fn().mockReturnValue({}),
};

const mockAPIChannel = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  getJIDPrefix: vi.fn().mockReturnValue('api:'),
  isConnected: vi.fn().mockReturnValue(false),
  onMessage: vi.fn(),
  onMetadata: vi.fn(),
  handleChat: vi.fn().mockResolvedValue(undefined),
};

const mockCLIChannel = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  getJIDPrefix: vi.fn().mockReturnValue('cli:'),
  isConnected: vi.fn().mockReturnValue(false),
  onMessage: vi.fn(),
  onMetadata: vi.fn(),
};

const mockKeyManager = {
  isLocked: vi.fn().mockReturnValue(true),
  unlock: vi.fn().mockResolvedValue(undefined),
  lock: vi.fn(),
  encrypt: vi.fn().mockResolvedValue('enc'),
  decrypt: vi.fn().mockResolvedValue('dec'),
};

// ---------------------------------------------------------------------------
// vi.mock declarations (hoisted by vitest)
// ---------------------------------------------------------------------------

// node:fs — mock existsSync so workspace scaffolding tests can control filesystem state
// without touching the real disk. Default: teamsRootDir exists (existsSync returns true).
vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

vi.mock('./store/db.js', () => ({ newDB: vi.fn(() => mockDB) }));
vi.mock('./store/task-store.js', () => ({ newTaskStore: vi.fn(() => mockTaskStore) }));
vi.mock('./store/log-store.js', () => ({ newLogStore: vi.fn(() => mockLogStore) }));
vi.mock('./store/session-store.js', () => ({ newSessionStore: vi.fn(() => mockSessionStore) }));
vi.mock('./store/message-store.js', () => ({ newMessageStore: vi.fn(() => mockMessageStore) }));
vi.mock('./logging/logger.js', () => ({ newDBLogger: vi.fn(() => mockDBLogger), DBLogger: class {} }));
vi.mock('./logging/archive.js', () => ({
  newArchiver: vi.fn(() => makeArchiver()),
  Archiver: class {},
}));
vi.mock('./config/loader.js', () => ({ newConfigLoader: vi.fn(() => mockConfigLoader), ConfigLoaderImpl: class {} }));
vi.mock('./config/orgchart.js', () => ({ newOrgChart: vi.fn(() => mockOrgChart), OrgChartService: class {} }));
vi.mock('./event/bus.js', () => ({ newEventBus: vi.fn(() => mockEventBus), InMemoryBus: class {} }));
vi.mock('./ws/hub.js', () => ({ Hub: vi.fn(() => mockWSHub) }));
vi.mock('./orchestrator/dispatch.js', () => ({ newDispatcher: vi.fn(() => mockDispatcher), Dispatcher: class {} }));
vi.mock('./orchestrator/heartbeat.js', () => ({
  newHeartbeatMonitor: vi.fn(() => mockHeartbeatMonitor),
  HeartbeatMonitorImpl: class {},
}));
vi.mock('./orchestrator/toolhandler.js', () => ({ newToolHandler: vi.fn(() => mockToolHandler), ToolHandler: class {} }));
vi.mock('./orchestrator/tools-admin.js', () => ({ registerAdminTools: vi.fn() }));
vi.mock('./orchestrator/tools-team.js', () => ({ registerTeamTools: vi.fn() }));
vi.mock('./orchestrator/tools-task.js', () => ({ registerTaskTools: vi.fn() }));
vi.mock('./orchestrator/task-waiter.js', () => ({
  TaskWaiter: vi.fn(() => ({ cancelAll: vi.fn(), notifyComplete: vi.fn() })),
}));
vi.mock('./orchestrator/orchestrator.js', () => ({
  newOrchestrator: vi.fn(() => mockOrchestrator),
  Orchestrator: class {},
  scaffoldTeamWorkspace: vi.fn().mockResolvedValue(undefined),
  copyMainAssistantWorkspace: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./orchestrator/childproc.js', () => ({
  newChildProcessManager: vi.fn(() => mockChildProc),
  ChildProcessManager: class {},
}));
vi.mock('./container/runtime.js', () => ({ newDockerRuntime: vi.fn(() => ({})) }));
vi.mock('./container/manager.js', () => ({
  newContainerManager: vi.fn(() => mockContainerManager),
  ManagerImpl: class {},
}));
vi.mock('./channel/discord.js', () => ({
  DiscordChannel: vi.fn(() => ({ disconnect: vi.fn().mockResolvedValue(undefined) })),
}));
vi.mock('./channel/whatsapp.js', () => ({
  WhatsAppChannel: vi.fn(() => ({ disconnect: vi.fn().mockResolvedValue(undefined) })),
}));
vi.mock('./channel/api.js', () => ({ APIChannel: vi.fn(() => mockAPIChannel) }));
vi.mock('./channel/cli.js', () => ({ CLIChannel: vi.fn(() => mockCLIChannel) }));
vi.mock('./channel/router.js', () => ({ Router: vi.fn(() => mockRouter) }));
vi.mock('./api/server.js', () => ({ createServer: vi.fn(() => mockServer), ServerInstance: class {} }));
vi.mock('./api/portal-ws.js', () => ({ PortalWSHandler: vi.fn(() => mockPortalWS) }));
vi.mock('./crypto/key-manager.js', () => ({ KeyManagerImpl: vi.fn(() => mockKeyManager) }));

// ---------------------------------------------------------------------------
// Static imports (after mocks are set up via hoisting)
// ---------------------------------------------------------------------------

import { App, resolveProviderConfig } from './index.js';
import { newDB } from './store/db.js';
import { newTaskStore } from './store/task-store.js';
import { newLogStore } from './store/log-store.js';
import { newDBLogger } from './logging/logger.js';
import { newArchiver } from './logging/archive.js';
import { newConfigLoader } from './config/loader.js';
import { newDispatcher } from './orchestrator/dispatch.js';
import { newHeartbeatMonitor } from './orchestrator/heartbeat.js';
import { newOrchestrator, scaffoldTeamWorkspace, copyMainAssistantWorkspace } from './orchestrator/orchestrator.js';
import { newChildProcessManager } from './orchestrator/childproc.js';
import { newDockerRuntime } from './container/runtime.js';
import { APIChannel } from './channel/api.js';
import { CLIChannel } from './channel/cli.js';
import { existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// describe('App')
// ---------------------------------------------------------------------------

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env['OPENHIVE_MASTER_KEY'];
  });

  // ── Build ──────────────────────────────────────────────────────────────────

  it('Build creates all components in correct order', async () => {
    const app = new App();
    await app.build();

    expect(vi.mocked(newDB)).toHaveBeenCalledOnce();
    expect(vi.mocked(newTaskStore)).toHaveBeenCalledOnce();
    expect(vi.mocked(newLogStore)).toHaveBeenCalledOnce();
    expect(vi.mocked(newDBLogger)).toHaveBeenCalledOnce();
    expect(vi.mocked(newDispatcher)).toHaveBeenCalledOnce();
    expect(vi.mocked(newHeartbeatMonitor)).toHaveBeenCalledOnce();
    expect(vi.mocked(newOrchestrator)).toHaveBeenCalledOnce();
  });

  it('Build handles missing Docker gracefully', async () => {
    vi.mocked(newDockerRuntime).mockImplementationOnce(() => {
      throw new Error('Docker unavailable');
    });

    const app = new App();
    // Must not throw — Docker failure is logged and ContainerManager is null.
    await expect(app.build()).resolves.not.toThrow();
  });

  it('Build unlocks key manager when OPENHIVE_MASTER_KEY is set', async () => {
    process.env['OPENHIVE_MASTER_KEY'] = 'secret-key';
    const app = new App();
    await app.build();
    expect(mockKeyManager.unlock).toHaveBeenCalledWith('secret-key');
  });

  it('Build does not call unlock when OPENHIVE_MASTER_KEY is absent', async () => {
    delete process.env['OPENHIVE_MASTER_KEY'];
    const app = new App();
    await app.build();
    expect(mockKeyManager.unlock).not.toHaveBeenCalled();
  });

  it('Build loads master config and applies specified log level', async () => {
    const app = new App();
    await app.build('debug');
    expect(vi.mocked(newDBLogger)).toHaveBeenCalledWith(expect.anything(), 'debug');
  });

  it('Build registers API and CLI channel adapters', async () => {
    const app = new App();
    await app.build();
    expect(vi.mocked(APIChannel)).toHaveBeenCalledOnce();
    expect(vi.mocked(CLIChannel)).toHaveBeenCalledOnce();
  });

  it('AC22: Build passes OPENHIVE_WORKSPACE env var and dir to ChildProcessManager pointing to main workspace', async () => {
    process.env['OPENHIVE_RUN_DIR'] = '/test/run';
    try {
      const app = new App();
      await app.build();

      // newChildProcessManager must have been called with a config containing
      // OPENHIVE_WORKSPACE in env and dir both pointing to .run/teams/main/.
      expect(vi.mocked(newChildProcessManager)).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            OPENHIVE_WORKSPACE: expect.stringContaining('teams'),
          }),
          dir: expect.stringContaining('teams'),
        }),
        expect.anything(),
      );

      // Verify the values match each other (env and dir point to same path).
      const callArg = vi.mocked(newChildProcessManager).mock.calls[0]![0] as {
        env: Record<string, string>;
        dir: string;
      };
      expect(callArg.env['OPENHIVE_WORKSPACE']).toBe(callArg.dir);
    } finally {
      delete process.env['OPENHIVE_RUN_DIR'];
    }
  });

  it('Build passes dataDir directly as teamsDir to newConfigLoader — no double teams/teams/ nesting (AC1, AC2)', async () => {
    // ConfigLoaderImpl appends 'teams/' internally; passing path.join(dataDir, 'teams')
    // would produce data/teams/teams/<slug> (double nesting).  The fix passes dataDir
    // directly so the loader resolves data/teams/<slug> correctly.
    process.env['OPENHIVE_DATA_DIR'] = '/test/data';
    try {
      const app = new App();
      await app.build();
      // Both arguments to newConfigLoader must equal the raw dataDir — not dataDir + '/teams'.
      expect(vi.mocked(newConfigLoader)).toHaveBeenCalledWith('/test/data', '/test/data');
    } finally {
      delete process.env['OPENHIVE_DATA_DIR'];
    }
  });

  // ── Start / Shutdown ───────────────────────────────────────────────────────

  it('Start starts orchestrator and child process', async () => {
    const app = new App();
    await app.build();
    await app.start();

    expect(mockOrchestrator.start).toHaveBeenCalledOnce();
    expect(mockChildProc.start).toHaveBeenCalledOnce();
  });

  it('Shutdown stops all components in reverse order', async () => {
    const order: string[] = [];
    mockChildProc.stop.mockImplementationOnce(async () => { order.push('childProc'); });
    mockOrchestrator.stop.mockImplementationOnce(async () => { order.push('orchestrator'); });

    const app = new App();
    await app.build();
    await app.start();
    await app.shutdown();

    // Child process should stop before orchestrator (reverse of start order).
    expect(order.indexOf('childProc')).toBeLessThan(order.indexOf('orchestrator'));
  });

  it('Double-start is prevented by started flag', async () => {
    const app = new App();
    await app.build();

    await app.start();
    await app.start(); // second call — no-op

    expect(mockOrchestrator.start).toHaveBeenCalledOnce();
  });

  it('Double-shutdown is prevented by shutdownOnce flag', async () => {
    const app = new App();
    await app.build();
    await app.start();

    await app.shutdown();
    await app.shutdown(); // second call — no-op

    expect(mockOrchestrator.stop).toHaveBeenCalledOnce();
  });

  it('Concurrent SIGINT + SIGTERM results in a single shutdown sequence', async () => {
    const app = new App();
    await app.build();
    await app.start();

    // Simulate concurrent shutdown calls (both SIGINT and SIGTERM arrive together).
    await Promise.all([app.shutdown(), app.shutdown()]);

    expect(mockOrchestrator.stop).toHaveBeenCalledOnce();
  });

  // ── Startup recovery ───────────────────────────────────────────────────────

  it('Startup recovery: orphan containers are cleaned up before normal operation', async () => {
    const order: string[] = [];
    mockContainerManager.cleanup.mockImplementationOnce(async () => { order.push('cleanup'); });
    mockOrchestrator.start.mockImplementationOnce(async () => { order.push('orchestrator'); });

    const app = new App();
    await app.build();
    await app.start();

    // Orphan cleanup (recovery step A.1) must run before orchestrator starts.
    expect(order.indexOf('cleanup')).toBeLessThan(order.indexOf('orchestrator'));
  });

  it('Startup recovery: stale tasks (>30min running) are marked failed with stale_timeout_recovery', async () => {
    const staleDate = new Date(Date.now() - 31 * 60 * 1000);
    const staleTask = {
      task_id: 'task-stale',
      status: 'running' as const,
      updated_at: staleDate,
      completed_at: null,
      jid: 'user:123',
    };
    mockTaskStore.listByStatus.mockResolvedValueOnce([staleTask]);

    const app = new App();
    await app.build();
    await app.start();

    expect(mockTaskStore.update).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: 'task-stale',
        status: 'failed',
        error: 'stale_timeout_recovery',
      }),
    );
  });

  it('Startup recovery: recent tasks are not marked stale', async () => {
    const recentDate = new Date(Date.now() - 5 * 60 * 1000);
    const recentTask = {
      task_id: 'task-recent',
      status: 'running' as const,
      updated_at: recentDate,
      completed_at: null,
      jid: 'user:123',
    };
    mockTaskStore.listByStatus.mockResolvedValueOnce([recentTask]);

    const app = new App();
    await app.build();
    await app.start();

    expect(mockTaskStore.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ task_id: 'task-recent', status: 'failed' }),
    );
  });

  it('Startup recovery: expired sessions (>24h inactive) are deleted', async () => {
    const staleSession = {
      chat_jid: 'user:expired',
      last_timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000),
    };
    mockSessionStore.listAll.mockResolvedValueOnce([staleSession]);

    const app = new App();
    await app.build();
    await app.start();

    expect(mockSessionStore.delete).toHaveBeenCalledWith('user:expired');
  });

  it('Startup recovery: pending messages are logged, not auto-redelivered', async () => {
    const session = { chat_jid: 'user:pending', last_timestamp: new Date() };
    // A.3 session cleanup calls listAll() first, then A.4 message drain calls it again.
    mockSessionStore.listAll.mockResolvedValueOnce([session]); // consumed by A.3
    mockSessionStore.listAll.mockResolvedValueOnce([session]); // consumed by A.4
    mockMessageStore.getByChat.mockResolvedValueOnce([
      { message_id: 'msg1', content: 'hello' },
    ]);

    const app = new App();
    await app.build();
    await app.start();

    // Messages are fetched and counted (for logging).
    expect(mockMessageStore.getByChat).toHaveBeenCalledWith(
      'user:pending',
      expect.any(Date),
      expect.any(Number),
    );
    // routeOutbound is NOT called — no auto-redelivery.
    expect(mockRouter.routeOutbound).not.toHaveBeenCalled();
  });

  it('Startup recovery: heartbeat state is reset', async () => {
    const app = new App();
    await app.build();
    await app.start();

    expect(mockHeartbeatMonitor.clearAll).toHaveBeenCalledOnce();
  });

  it('Startup recovery: steps execute in deterministic order (cleanup → stale → sessions → message_drain → heartbeats)', async () => {
    const order: string[] = [];
    mockContainerManager.cleanup.mockImplementationOnce(async () => { order.push('cleanup'); });
    mockTaskStore.listByStatus.mockImplementationOnce(async () => { order.push('stale'); return []; });
    // A.3: sessions cleanup
    mockSessionStore.listAll.mockImplementationOnce(async () => { order.push('sessions'); return []; });
    // A.4: message drain — needs a session to iterate so getByChat is called
    mockSessionStore.listAll.mockImplementationOnce(async () => [{ chat_jid: 'test-jid', last_timestamp: new Date() }]);
    mockMessageStore.getByChat.mockImplementationOnce(async () => { order.push('message_drain'); return []; });
    mockHeartbeatMonitor.clearAll.mockImplementationOnce(() => { order.push('heartbeats'); });

    const app = new App();
    await app.build();
    await app.start();

    expect(order.indexOf('cleanup')).toBeLessThan(order.indexOf('stale'));
    expect(order.indexOf('stale')).toBeLessThan(order.indexOf('sessions'));
    expect(order.indexOf('sessions')).toBeLessThan(order.indexOf('message_drain'));
    expect(order.indexOf('message_drain')).toBeLessThan(order.indexOf('heartbeats'));
  });

  it('Startup recovery: failure in one step does not prevent subsequent steps', async () => {
    // A.1 cleanup throws — other steps must still run.
    mockContainerManager.cleanup.mockRejectedValueOnce(new Error('docker error'));

    const app = new App();
    await app.build();

    await expect(app.start()).resolves.not.toThrow();

    // A.2 (stale task scan) must still have been called.
    expect(mockTaskStore.listByStatus).toHaveBeenCalled();
    // A.5 (heartbeat reset) must still have been called.
    expect(mockHeartbeatMonitor.clearAll).toHaveBeenCalled();
  });

  it('Startup recovery: summary log emitted with all recovery action counts', async () => {
    const app = new App();
    await app.build();
    await app.start();

    expect(mockDBLogger.info).toHaveBeenCalledWith(
      'startup recovery complete',
      expect.objectContaining({ component: 'app', action: 'startup_recovery' }),
    );
  });

  it('Startup recovery: skips orphan cleanup gracefully when Docker unavailable (ContainerManager nil)', async () => {
    vi.mocked(newDockerRuntime).mockImplementationOnce(() => {
      throw new Error('Docker unavailable');
    });

    const app = new App();
    await app.build();
    await app.start();

    // cleanup must NOT have been called (ContainerManager is null).
    expect(mockContainerManager.cleanup).not.toHaveBeenCalled();
    // But A.5 heartbeat reset still runs.
    expect(mockHeartbeatMonitor.clearAll).toHaveBeenCalled();
  });

  it('Start calls start() on the log archiver', async () => {
    const app = new App();
    await app.build();

    // build() calls newArchiver once (for the log archiver only — no message archiver)
    const archiverResults = vi.mocked(newArchiver).mock.results;
    expect(archiverResults.length).toBeGreaterThanOrEqual(1);

    await app.start();

    // Log archiver instance must have start() called
    expect(archiverResults[0]?.value.start).toHaveBeenCalledOnce();
  });

  it('Start calls watchMaster and watchProviders on the config loader', async () => {
    const app = new App();
    await app.build();
    await app.start();

    expect(mockConfigLoader.watchMaster).toHaveBeenCalledOnce();
    expect(mockConfigLoader.watchProviders).toHaveBeenCalledOnce();
  });

  // ── resolveAgentInitConfigs (AC3, AC4) ─────────────────────────────────────

  it('AC3: onConnect resolves agents by slug via getTeamBySlug, not by TID loop (AC3)', async () => {
    // Configure getTeamBySlug to return a team with one agent when called with 'research'.
    mockOrgChart.getTeamBySlug.mockReturnValueOnce({
      tid: 'tid-completely-different',
      slug: 'research',
      agents: [
        { aid: 'aid-worker', name: 'Worker', provider: 'default', model_tier: 'sonnet' },
      ],
    });
    // Providers return empty map (oauth default will be used).
    mockConfigLoader.loadProviders.mockResolvedValueOnce({});

    const app = new App();
    await app.build();
    await app.start();

    // Capture the onConnect callback registered during build.
    const onConnectCallback = (mockWSHub.setOnConnect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | ((teamID: string) => void)
      | undefined;
    expect(onConnectCallback).toBeDefined();

    // Invoke callback with the slug (not the TID).
    await new Promise<void>((resolve) => {
      mockDispatcher.sendContainerInit.mockImplementationOnce(async () => { resolve(); });
      onConnectCallback?.('research');
    });

    // getTeamBySlug must have been called with the slug 'research'.
    expect(mockOrgChart.getTeamBySlug).toHaveBeenCalledWith('research');
    // getOrgChart must NOT have been called (the TID loop is gone).
    expect(mockOrgChart.getOrgChart).not.toHaveBeenCalled();
  });

  it('AC4: onConnect sends container_init with non-empty agents array for a known team slug (AC4)', async () => {
    const teamAgent = { aid: 'aid-analyst', name: 'Analyst', provider: 'default', model_tier: 'haiku' as const };
    mockOrgChart.getTeamBySlug.mockReturnValueOnce({
      tid: 'tid-analytics',
      slug: 'analytics',
      agents: [teamAgent],
    });
    mockConfigLoader.loadProviders.mockResolvedValueOnce({});

    const app = new App();
    await app.build();
    await app.start();

    const onConnectCallback = (mockWSHub.setOnConnect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | ((teamID: string) => void)
      | undefined;
    expect(onConnectCallback).toBeDefined();

    await new Promise<void>((resolve) => {
      mockDispatcher.sendContainerInit.mockImplementationOnce(async (..._args: unknown[]) => { resolve(); });
      onConnectCallback?.('analytics');
    });

    // sendContainerInit must have been called with 'analytics' and a non-empty agents array.
    expect(mockDispatcher.sendContainerInit).toHaveBeenCalledWith(
      'analytics',
      false, // not the main team
      expect.arrayContaining([
        expect.objectContaining({ aid: 'aid-analyst', name: 'Analyst' }),
      ]),
      expect.anything(),
      expect.anything(),
    );
  });

  it('AC3: onConnect handles NotFoundError from getTeamBySlug gracefully (main container case)', async () => {
    // getTeamBySlug throws NotFoundError for 'main' — this is expected and agents should be [] initially,
    // then the main assistant is prepended because teamSlug === resolveMainTeamID().
    const { NotFoundError: NFError } = await import('./domain/errors.js');
    mockOrgChart.getTeamBySlug.mockImplementationOnce(() => { throw new NFError('team', 'main'); });
    mockConfigLoader.loadProviders.mockResolvedValueOnce({});

    const app = new App();
    await app.build();
    await app.start();

    const onConnectCallback = (mockWSHub.setOnConnect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | ((teamID: string) => void)
      | undefined;
    expect(onConnectCallback).toBeDefined();

    await new Promise<void>((resolve) => {
      mockDispatcher.sendContainerInit.mockImplementationOnce(async () => { resolve(); });
      onConnectCallback?.('main');
    });

    // sendContainerInit must have been called — main assistant (aid-asst) is included.
    expect(mockDispatcher.sendContainerInit).toHaveBeenCalledWith(
      'main',
      true, // isMain === true for slug 'main'
      expect.arrayContaining([
        expect.objectContaining({ aid: 'aid-asst' }),
      ]),
      expect.anything(),
      expect.anything(),
    );
  });

  // ── Workspace scaffolding at startup (AC13) ────────────────────────────────

  it('AC13: build() scaffolds main workspace when .run/teams/ does not exist (clean start)', async () => {
    // Simulate clean start: .run/teams/ directory does not exist.
    vi.mocked(existsSync).mockReturnValue(false);

    const app = new App();
    await app.build();

    // scaffoldTeamWorkspace must have been called with runDir and 'main' slug.
    expect(vi.mocked(scaffoldTeamWorkspace)).toHaveBeenCalledWith(
      expect.any(String),
      'main',
    );
    // copyMainAssistantWorkspace must have been called with force=true (clean start).
    expect(vi.mocked(copyMainAssistantWorkspace)).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('main'),
      true,
    );
    // Log messages must be emitted.
    expect(mockDBLogger.info).toHaveBeenCalledWith(
      'main workspace scaffolded',
      expect.objectContaining({ clean_start: true }),
    );
  });

  it('AC13: build() syncs static files on existing install without re-scaffolding', async () => {
    // Simulate existing install: both .run/teams/ and .run/teams/main/ exist.
    vi.mocked(existsSync).mockReturnValue(true);

    const app = new App();
    await app.build();

    // scaffoldTeamWorkspace must NOT have been called.
    expect(vi.mocked(scaffoldTeamWorkspace)).not.toHaveBeenCalled();
    // copyMainAssistantWorkspace must have been called with force=false (preserve user changes).
    expect(vi.mocked(copyMainAssistantWorkspace)).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('main'),
      false,
    );
  });

  it('AC13: build() re-scaffolds main workspace if .run/teams/ exists but main/ is missing', async () => {
    // Simulate edge case: .run/teams/ exists but .run/teams/main/ is missing.
    // existsSync is called twice: first for teamsRootDir, then for mainWorkspaceDir.
    vi.mocked(existsSync)
      .mockReturnValueOnce(true)   // teamsRootDir exists
      .mockReturnValueOnce(false); // mainWorkspaceDir does NOT exist

    const app = new App();
    await app.build();

    // scaffoldTeamWorkspace must have been called once to restore the missing main workspace.
    expect(vi.mocked(scaffoldTeamWorkspace)).toHaveBeenCalledWith(
      expect.any(String),
      'main',
    );
    // copyMainAssistantWorkspace must be called (isCleanStart=false since teamsRoot exists).
    expect(vi.mocked(copyMainAssistantWorkspace)).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('main'),
      false,
    );
  });

  it('AC13: build() logs warning and continues when scaffolding throws', async () => {
    // Simulate clean start but copyMainAssistantWorkspace fails.
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(copyMainAssistantWorkspace).mockRejectedValueOnce(new Error('disk full'));

    const app = new App();
    // Must not throw — failure is caught and logged.
    await expect(app.build()).resolves.not.toThrow();

    expect(mockDBLogger.warn).toHaveBeenCalledWith(
      'failed to scaffold main workspace',
      expect.objectContaining({ error: expect.stringContaining('disk full') }),
    );
  });
});

// ---------------------------------------------------------------------------
// resolveProviderConfig
// ---------------------------------------------------------------------------

describe('resolveProviderConfig', () => {
  it('returns default oauth config when provider is undefined', () => {
    expect(resolveProviderConfig(undefined)).toEqual({ type: 'oauth' });
  });

  it('maps oauth provider with token', () => {
    expect(resolveProviderConfig({ type: 'oauth', oauth_token: 'tok-123' })).toEqual({
      type: 'oauth',
      oauth_token: 'tok-123',
    });
  });

  it('maps anthropic_direct provider with api_key and api_url', () => {
    expect(
      resolveProviderConfig({ type: 'anthropic_direct', api_key: 'key-abc', base_url: 'https://api.example.com' }),
    ).toEqual({ type: 'anthropic_direct', api_key: 'key-abc', api_url: 'https://api.example.com' });
  });
});
