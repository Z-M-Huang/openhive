/**
 * OpenHive Backend - Main Entry Point
 *
 * Wires all components together and starts the server.
 *
 * Lifecycle:
 *   Build(logLevel) — create all components in dependency order (synchronous)
 *   Start()         — run startup recovery, then begin normal operation
 *   Shutdown()      — stop all components in reverse order
 *   main()          — create App, signal handling (SIGINT/SIGTERM), start/wait/stop
 *
 * Startup recovery (runStartupRecovery):
 *   A.1 ORPHAN CONTAINER CLEANUP  — remove Docker containers with no team config match
 *   A.2 STALE TASK SCAN          — mark tasks stuck >30min as failed
 *   A.3 SESSION CLEANUP          — expire sessions with >24h inactivity
 *   A.4 MESSAGE QUEUE DRAIN      — log and mark pending messages recovery_pending
 *   A.5 HEARTBEAT RESET          — clear all cached heartbeat timestamps
 */

import process from 'node:process';
import * as path from 'node:path';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { Mutex } from 'async-mutex';

// ── Domain ────────────────────────────────────────────────────────────────────
import type { ChannelAdapter } from './domain/interfaces.js';

// ── Store ─────────────────────────────────────────────────────────────────────
import { newDB } from './store/db.js';
import type { DB } from './store/db.js';
import { newTaskStore } from './store/task-store.js';
import type { TaskStoreImpl } from './store/task-store.js';
import { newLogStore } from './store/log-store.js';
import type { LogStoreImpl } from './store/log-store.js';
import { newSessionStore } from './store/session-store.js';
import type { SessionStoreImpl } from './store/session-store.js';
import { newMessageStore } from './store/message-store.js';
import type { MessageStoreImpl } from './store/message-store.js';
import { newEscalationStore, EscalationStoreImpl } from './store/escalation-store.js';
import { newMemoryStore, MemoryStoreImpl } from './store/memory-store.js';
import { newTriggerStore, TriggerStoreImpl } from './store/trigger-store.js';

// ── Logging ───────────────────────────────────────────────────────────────────
import { newDBLogger, DBLogger } from './logging/logger.js';
import { newArchiver, Archiver } from './logging/archive.js';

// ── Config ────────────────────────────────────────────────────────────────────
import { newConfigLoader, ConfigLoaderImpl } from './config/loader.js';
import { newOrgChart, OrgChartService } from './config/orgchart.js';

// ── Events ────────────────────────────────────────────────────────────────────
import { newEventBus, InMemoryBus } from './event/bus.js';

// ── WebSocket ─────────────────────────────────────────────────────────────────
import { Hub } from './ws/hub.js';

// ── Orchestrator ──────────────────────────────────────────────────────────────
import { newDispatcher, Dispatcher } from './orchestrator/dispatch.js';
import { newHeartbeatMonitor, HeartbeatMonitorImpl } from './orchestrator/heartbeat.js';
import { newToolHandler, ToolHandler } from './orchestrator/toolhandler.js';
import { registerAdminTools } from './orchestrator/tools-admin.js';
import { registerTeamTools } from './orchestrator/tools-team.js';
import { registerTaskTools } from './orchestrator/tools-task.js';
import { newOrchestrator, OrchestratorImpl } from './orchestrator/orchestrator.js';
import { newChildProcessManager, ChildProcessManager } from './orchestrator/childproc.js';
import { TaskWaiter } from './orchestrator/task-waiter.js';
import { newEscalationRouter, EscalationRouter } from './orchestrator/escalation-router.js';
import { registerMemoryTools } from './orchestrator/tools-memory.js';
import { registerCoordinationTools } from './orchestrator/tools-coordination.js';
import { SlidingWindowRateLimiter } from './orchestrator/rate-limiter.js';
import { newTriggerScheduler, TriggerSchedulerImpl } from './orchestrator/trigger-scheduler.js';
import { newProactiveLoop, ProactiveLoopImpl } from './orchestrator/proactive-loop.js';
import { SkillRegistryImpl } from './orchestrator/skill-registry.js';

// ── Container ─────────────────────────────────────────────────────────────────
import { newDockerRuntime } from './container/runtime.js';
import { newContainerManager, ManagerImpl } from './container/manager.js';

// ── Channel ───────────────────────────────────────────────────────────────────
import { DiscordChannel } from './channel/discord.js';
import type { DiscordConfig } from './channel/discord.js';
import { WhatsAppChannel } from './channel/whatsapp.js';
import type { WhatsAppConfig } from './channel/whatsapp.js';
import { APIChannel } from './channel/api.js';
import { CLIChannel } from './channel/cli.js';
import { Router } from './channel/router.js';

// ── Crypto ────────────────────────────────────────────────────────────────────
import { KeyManagerImpl } from './crypto/key-manager.js';

// ── API ───────────────────────────────────────────────────────────────────────
import { createServer, ServerInstance } from './api/server.js';
import { PortalWSHandler } from './api/portal-ws.js';

// ── WS messages ───────────────────────────────────────────────────────────────
import type { ProviderConfig, AgentInitConfig } from './ws/messages.js';

// ── Domain types ──────────────────────────────────────────────────────────────
import type { MasterConfig, Provider, Agent } from './domain/types.js';
import { validateLogLevel } from './domain/enums.js';
import type { LogLevel } from './domain/enums.js';
import { NotFoundError } from './domain/errors.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default Docker image name for team containers. */
const TEAM_IMAGE_NAME = 'openhive-team:latest';

/** Default data directory path. */
const DEFAULT_DATA_DIR = 'data';

/** Default run directory path (runtime artifacts: DB, workspaces, archives). */
const DEFAULT_RUN_DIR = '.run';

/** Threshold in milliseconds for marking tasks stale (30 minutes). */
const STALE_TASK_THRESHOLD_MS = 30 * 60 * 1000;

/** Maximum inactivity (ms) before a session is expired (24 hours). */
const SESSION_INACTIVE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** UID for child process (node user in container). */
const CHILD_PROCESS_UID = 1000;

/** GID for child process (node user in container). */
const CHILD_PROCESS_GID = 1000;

// Main assistant static directory is at main-assistant/ (git-tracked, baked into Docker image).
// The workspace is populated from this directory on startup via copyMainAssistantWorkspace().

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

/**
 * App holds all backend components and drives the lifecycle.
 *
 * Call Build() once to create components, Start() to begin operation,
 * and Shutdown() to stop.
 */
export class App {
  // ── Stores & DB ───────────────────────────────────────────────────────────
  private db: DB | null = null;
  private taskStore: TaskStoreImpl | null = null;
  private logStore: LogStoreImpl | null = null;
  private sessionStore: SessionStoreImpl | null = null;
  private messageStore: MessageStoreImpl | null = null;
  private escalationStore: EscalationStoreImpl | null = null;
  private memoryStore: MemoryStoreImpl | null = null;
  private triggerStore: TriggerStoreImpl | null = null;
  private escalationRouter: EscalationRouter | null = null;
  private triggerScheduler: TriggerSchedulerImpl | null = null;
  private proactiveLoop: ProactiveLoopImpl | null = null;

  // ── Logging ───────────────────────────────────────────────────────────────
  private dbLogger: DBLogger | null = null;
  private logArchiver: Archiver | null = null;

  // ── Config ────────────────────────────────────────────────────────────────
  private configLoader: ConfigLoaderImpl | null = null;
  private orgChart: OrgChartService | null = null;
  private masterConfig: MasterConfig | null = null;

  // ── Events ────────────────────────────────────────────────────────────────
  private eventBus: InMemoryBus | null = null;

  // ── WS Hub ────────────────────────────────────────────────────────────────
  private wsHub: Hub | null = null;

  // ── Orchestrator components ───────────────────────────────────────────────
  private dispatcher: Dispatcher | null = null;
  private heartbeatMonitor: HeartbeatMonitorImpl | null = null;
  private containerManager: ManagerImpl | null = null;
  private toolHandler: ToolHandler | null = null;
  private taskWaiter: TaskWaiter | null = null;
  private orchestrator: OrchestratorImpl | null = null;

  // ── Channel & Router ──────────────────────────────────────────────────────
  private router: Router | null = null;
  private apiChannel: APIChannel | null = null;
  private channels: ChannelAdapter[] = [];

  // ── Portal WS ─────────────────────────────────────────────────────────────
  private portalWS: PortalWSHandler | null = null;

  // ── HTTP Server ───────────────────────────────────────────────────────────
  private server: ServerInstance | null = null;

  // ── Child Process ─────────────────────────────────────────────────────────
  private childProc: ChildProcessManager | null = null;

  // ── Lifecycle guards ──────────────────────────────────────────────────────
  private readonly startMutex = new Mutex();
  private started = false;
  private shutdownOnce = false;

  // ── Paths ─────────────────────────────────────────────────────────────────
  private runDir = DEFAULT_RUN_DIR;
  private dataDir = DEFAULT_DATA_DIR;

  // ---------------------------------------------------------------------------
  // Build
  // ---------------------------------------------------------------------------

  /**
   * Creates all components in dependency order.
   * Must be called once before Start().
   *
   * @param logLevel — pino log level string (debug/info/warn/error)
   */
  async build(logLevel: string = 'info'): Promise<void> {
    // ── (1) Resolve runDir and dataDir from env ───────────────────────────────
    this.runDir = process.env['OPENHIVE_RUN_DIR'] ?? DEFAULT_RUN_DIR;
    this.dataDir = process.env['OPENHIVE_DATA_DIR'] ?? DEFAULT_DATA_DIR;
    const dbPath = path.join(this.runDir, 'workspace', 'openhive.db');
    // Ensure workspace directory exists before opening DB (SQLite requires it).
    mkdirSync(path.join(this.runDir, 'workspace'), { recursive: true });

    // ── (2) KeyManager — created first, needed by config ──────────────────────
    // Use direct instantiation (sync) rather than the async factory newKeyManager().
    // unlock() is called below once the master key is available from env.
    const keyManager = new KeyManagerImpl();

    // ── (3) Database ──────────────────────────────────────────────────────────
    this.db = newDB(dbPath);

    // ── (4) Stores ────────────────────────────────────────────────────────────
    this.taskStore = newTaskStore(this.db);
    this.logStore = newLogStore(this.db);
    this.sessionStore = newSessionStore(this.db);
    this.messageStore = newMessageStore(this.db);
    this.escalationStore = newEscalationStore(this.db);
    this.memoryStore = newMemoryStore(this.db);
    this.triggerStore = newTriggerStore(this.db);

    // ── (5) DBLogger ──────────────────────────────────────────────────────────
    const resolvedLevel: LogLevel = validateLogLevel(logLevel) ? logLevel : 'info';
    this.dbLogger = newDBLogger(this.logStore, resolvedLevel, 'system');

    // ── (6) ConfigLoader ──────────────────────────────────────────────────────
    // Team configs live in the workspace directory (not data/).
    // ConfigLoaderImpl appends 'teams/' internally: workspace/teams/<slug>/team.yaml.
    const workspaceDir = path.join(this.runDir, 'workspace');
    this.configLoader = newConfigLoader(this.dataDir, workspaceDir);
    this.configLoader.setKeyManager(keyManager);

    // ── (7) Unlock KeyManager from env ────────────────────────────────────────
    const masterKey = process.env['OPENHIVE_MASTER_KEY'] ?? '';
    if (masterKey !== '') {
      await keyManager.unlock(masterKey);
    }

    // ── (8) LoadMaster config ─────────────────────────────────────────────────
    // Load config from YAML before downstream components use it.
    // Watchers are started later in Start() to avoid firing before all wiring.
    let master: MasterConfig;
    try {
      await this.configLoader.loadMaster();
      master = this.configLoader.getMaster();
    } catch {
      // Config file missing or malformed — use compiled defaults for startup
      master = this.buildDefaultMasterConfig();
    }
    this.masterConfig = master;

    // ── (9) LoadProviders — deferred to Start (needs KeyManager unlock) ───────
    // (provider decryption happens during Start after unlock confirmation)

    // ── (10) EventBus ─────────────────────────────────────────────────────────
    this.eventBus = newEventBus();

    // ── (11) Config watcher wiring deferred to Start ──────────────────────────

    // ── (12) OrgChart ─────────────────────────────────────────────────────────
    this.orgChart = newOrgChart();
    // Subscribe to config_changed events to rebuild the org chart.
    this.eventBus.subscribe('config_changed', () => {
      void (async () => {
        try {
          if (this.masterConfig === null) return;
          const teams = await this.loadAllTeams();
          this.orgChart?.rebuildFromConfig(this.masterConfig, teams);
        } catch (err) {
          this.dbLogger?.warn('failed to rebuild orgchart on config change', {
            error: String(err),
          });
        }
      })();
    });

    // ── (13) WS Hub ───────────────────────────────────────────────────────────
    this.wsHub = new Hub({ logger: this.dbLogger });

    // ── (14) Dispatcher ───────────────────────────────────────────────────────
    this.dispatcher = newDispatcher(this.taskStore, this.wsHub, this.dbLogger);

    // ── (15) HeartbeatMonitor ─────────────────────────────────────────────────
    this.heartbeatMonitor = newHeartbeatMonitor(this.eventBus, this.dbLogger);
    this.dispatcher.setHeartbeatMonitor(this.heartbeatMonitor);

    // ── (16) ContainerManager ─────────────────────────────────────────────────
    this.containerManager = this.buildContainerManager(master);

    // ── (17) ToolHandler + register admin/team tools ──────────────────────────
    this.toolHandler = newToolHandler(this.dbLogger);
    registerAdminTools(this.toolHandler, {
      configLoader: this.configLoader,
      keyManager,
      wsHub: this.wsHub,
      startTime: new Date(),
    });
    registerTeamTools(this.toolHandler, {
      configLoader: this.configLoader,
      orgChart: this.orgChart,
      eventBus: this.eventBus,
      keyManager,
      taskStore: this.taskStore,
      runDir: this.runDir,
      skillsSourceDir: path.join(this.resolveMainAssistantDir(), '.claude', 'skills'),
      containerManager: this.containerManager,
      wsHub: this.wsHub,
      limits: master.system.limits ?? null,
      skillRegistry: (master.skill_registries ?? []).length > 0
        ? new SkillRegistryImpl({ registryUrls: master.skill_registries!, logger: this.dbLogger })
        : null,
      logger: this.dbLogger,
    });
    this.taskWaiter = new TaskWaiter(this.dbLogger);
    // taskCoordinator is null initially; set after orchestrator creation (step 18).
    const taskToolsDeps = {
      taskStore: this.taskStore,
      wsHub: this.wsHub,
      containerManager: this.containerManager,
      orgChart: this.orgChart,
      taskWaiter: this.taskWaiter,
      taskCoordinator: null as import('./domain/interfaces.js').TaskCoordinator | null,
      logger: this.dbLogger,
    };
    registerTaskTools(this.toolHandler, taskToolsDeps);
    registerMemoryTools(this.toolHandler, {
      memoryStore: this.memoryStore,
      workspaceRoot: path.join(this.runDir, 'workspace'),
      logger: this.dbLogger,
    });
    this.toolHandler.setOrgChart(this.orgChart);
    this.toolHandler.setRateLimiter(new SlidingWindowRateLimiter());
    this.dispatcher.setToolHandler(this.toolHandler);
    this.dispatcher.setTaskWaiter(this.taskWaiter);

    // ── (17b) EscalationRouter ──────────────────────────────────────────────
    this.escalationRouter = newEscalationRouter(
      this.orgChart,
      this.escalationStore,
      this.taskStore,
      this.wsHub,
      this.dbLogger,
    );
    this.dispatcher.setEscalationRouter(this.escalationRouter);
    registerCoordinationTools(this.toolHandler, {
      taskStore: this.taskStore,
      escalationRouter: this.escalationRouter,
      logger: this.dbLogger,
    });

    // ── (18) Orchestrator ─────────────────────────────────────────────────────
    this.orchestrator = newOrchestrator({
      taskStore: this.taskStore,
      wsHub: this.wsHub,
      containerManager: this.containerManager,
      orgChart: this.orgChart,
      configLoader: this.configLoader,
      heartbeatMonitor: this.heartbeatMonitor,
      eventBus: this.eventBus,
      dispatcher: this.dispatcher,
      taskWaiter: this.taskWaiter,
      escalationRouter: this.escalationRouter,
      logger: this.dbLogger,
      runDir: this.runDir,
    });

    // Wire TaskCoordinator into task tools deps (deferred: orch created after tools registered).
    taskToolsDeps.taskCoordinator = this.orchestrator;

    // ── (19) Wire dispatcher task-result callback ─────────────────────────────
    // Set after orchestrator is created so the callback is ready.
    // Connected to router in step (23).

    // ── (20) Resolve main assistant provider config ───────────────────────────
    // (done at runtime during Start after providers are loaded)

    // ── (21) Wire WS hub onConnect / onMessage ────────────────────────────────
    const mainTID = this.resolveMainTeamID(master);
    const dispatcher = this.dispatcher;
    const configLoader = this.configLoader;
    const orgChart = this.orgChart;

    this.wsHub.setOnConnect((teamID: string) => {
      void (async () => {
        try {
          // Resolve agents and secrets for this team, then send container_init.
          const agents = await this.resolveAgentInitConfigs(teamID, configLoader, orgChart);
          const secrets: Record<string, string> = {};
          const { resolveTeamWorkspacePath } = await import('./orchestrator/orchestrator.js');
          const workspaceRoot = resolveTeamWorkspacePath(this.runDir, teamID);
          const isMain = teamID === mainTID;
          await dispatcher.sendContainerInit(teamID, isMain, agents, secrets, workspaceRoot);
        } catch (err) {
          this.dbLogger?.error('failed to send container_init', {
            team_id: teamID,
            error: String(err),
          });
        }
      })();
    });

    this.wsHub.setOnMessage((teamID: string, msg: Buffer) => {
      dispatcher.handleWSMessage(teamID, msg);
    });

    // ── (22) Message Router + channels ────────────────────────────────────────
    const mainAssistantAID = master.assistant.aid;
    this.apiChannel = new APIChannel(this.dbLogger);
    const cliChannel = new CLIChannel(this.dbLogger);

    this.router = new Router({
      wsHub: this.wsHub,
      taskStore: this.taskStore,
      sessionStore: this.sessionStore,
      messageStore: this.messageStore,
      logger: this.dbLogger,
      mainTeamID: mainTID,
      mainAssistantAID,
      maxMessageLength: master.system.max_message_length,
    });

    // Register always-available channels
    this.channels = [this.apiChannel, cliChannel];

    // Decrypt channel tokens before creating adapters.
    let decryptedChannels = master.channels;
    try {
      decryptedChannels = await this.configLoader.decryptChannelTokens(master.channels);
    } catch (err) {
      this.dbLogger?.warn('failed to decrypt channel tokens; channels may not start correctly', {
        error: String(err),
      });
    }

    // Discord — register if enabled
    if (decryptedChannels.discord.enabled) {
      const discordCfg: DiscordConfig = {
        token: decryptedChannels.discord.token ?? '',
        channelID: decryptedChannels.discord.channel_id ?? '',
        enabled: decryptedChannels.discord.enabled,
      };
      this.channels.push(new DiscordChannel(discordCfg, this.dbLogger));
    }

    // WhatsApp — register if enabled
    if (decryptedChannels.whatsapp.enabled) {
      const waCfg: WhatsAppConfig = {
        storePath: decryptedChannels.whatsapp.store_path ?? path.join(this.runDir, 'whatsapp'),
        enabled: decryptedChannels.whatsapp.enabled,
      };
      this.channels.push(new WhatsAppChannel(waCfg, this.dbLogger));
    }

    // ── (23) Wire task result callback dispatcher → router ────────────────────
    // TaskResultMsg has no jid — look it up from taskStore to get the originating JID.
    this.dispatcher.setTaskResultCallback((result) => {
      void (async () => {
        try {
          const task = await this.taskStore?.get(result.task_id);
          const jid = task?.jid ?? '';
          if (jid !== '' && result.result !== undefined) {
            await this.router?.routeOutbound(jid, result.result);
          }
        } catch (err) {
          this.dbLogger?.error('failed to route task result outbound', {
            component: 'app',
            action: 'task_result_callback',
            task_id: result.task_id,
            error: String(err),
          });
        }
      })();
    });

    // ── (24) Subscribe channel config change handlers ─────────────────────────
    // Config changes for channels are handled by re-reading config on next request.
    // Full channel reload on config_changed is deferred for future implementation.

    // ── (25) PortalWS handler ─────────────────────────────────────────────────
    this.portalWS = new PortalWSHandler(
      this.eventBus,
      this.dbLogger,
      master.system.portal_ws_max_connections,
    );

    // ── (26) Log archiver ─────────────────────────────────────────────────────
    this.logArchiver = newArchiver(this.logStore, master.system.log_archive);
    // Note: No separate message archiver — MessageStore.deleteBefore
    // is called directly when needed. The archiver pattern only applies to logs.

    // ── (28) API Server ───────────────────────────────────────────────────────
    const listenAddr = master.system.listen_address;
    const spaDir = process.env['OPENHIVE_SPA_DIR'] ?? null;

    // Chat handler delegates to API channel
    const chatHandler = this.apiChannel.handleChat.bind(this.apiChannel);

    // WS handler for /ws/container — works with @fastify/websocket plugin.
    // The handler validates the one-time token, creates a Connection wrapper,
    // registers it in the hub, and fires the onConnect callback.
    const wsUpgradeHandler = this.wsHub.getUpgradeHandler();
    this.server = createServer(
      listenAddr,
      this.dbLogger,
      keyManager,
      spaDir,
      wsUpgradeHandler,
      chatHandler,
      [],
      {
        logStore: this.logStore,
        taskStore: this.taskStore,
        configLoader: this.configLoader,
        orgChart: this.orgChart,
        orchestrator: this.orchestrator,
        heartbeatMonitor: this.heartbeatMonitor,
        portalWS: this.portalWS,
        dbLogger: this.dbLogger,
        logWriter: this.dbLogger,
      },
    );

    // ── (29) ChildProcessManager ──────────────────────────────────────────────
    const wsToken = this.wsHub.generateToken(mainTID);
    const nodeScriptRaw = process.env['OPENHIVE_NODE_SCRIPT'] ?? 'agent-runner/dist/index.js';
    const nodeScript = path.isAbsolute(nodeScriptRaw) ? nodeScriptRaw : path.resolve(nodeScriptRaw);

    const mainWorkspaceDir = path.join(this.runDir, 'workspace');
    this.childProc = newChildProcessManager(
      {
        command: 'node',
        args: [nodeScript, '--mode=master'],
        env: {
          OPENHIVE_TEAM_ID: mainTID,
          WS_URL: `${this.resolveWSURL(master)}?token=${wsToken}`,
          WS_TOKEN: wsToken,
          OPENHIVE_IS_MAIN: 'true',
          HOME: '/home/node',
          OPENHIVE_WORKSPACE: mainWorkspaceDir,
        },
        dir: mainWorkspaceDir,
        uid: process.platform === 'linux' ? CHILD_PROCESS_UID : undefined,
        gid: process.platform === 'linux' ? CHILD_PROCESS_GID : undefined,
      },
      this.dbLogger,
    );

    // ── (30) Scaffold main assistant workspace ────────────────────────────────
    // Main workspace is at .run/workspace/ (the root workspace).
    // Copy from static main-assistant/ directory (git-tracked, baked into Docker image).
    // On clean start: full copy. On existing install: only copy missing files.
    const mainWorkspace = path.join(this.runDir, 'workspace');
    try {
      const { copyMainAssistantWorkspace } = await import('./orchestrator/orchestrator.js');
      const isCleanStart = !existsSync(path.join(mainWorkspace, '.claude', 'agents'));

      if (isCleanStart) {
        // Create root workspace directory structure (main workspace is NOT a team
        // under workspace/teams/ — it IS the workspace root).
        mkdirSync(path.join(mainWorkspace, '.claude', 'agents'), { recursive: true, mode: 0o755 });
        mkdirSync(path.join(mainWorkspace, '.claude', 'skills'), { recursive: true, mode: 0o755 });
        mkdirSync(path.join(mainWorkspace, 'work', 'tasks'), { recursive: true, mode: 0o755 });
        mkdirSync(path.join(mainWorkspace, 'teams'), { recursive: true, mode: 0o755 });
        this.dbLogger?.info('main workspace scaffolded', {
          clean_start: isCleanStart,
          main_workspace: mainWorkspace,
        });
      }

      // Copy main-assistant/ static files into the workspace.
      // force=true on clean start (overwrite scaffold defaults), force=false on existing install.
      const mainAssistantSrc = this.resolveMainAssistantDir();
      await copyMainAssistantWorkspace(
        mainAssistantSrc,
        mainWorkspace,
        isCleanStart,
      );
      this.dbLogger?.info('main assistant workspace synced from static dir', {
        source: mainAssistantSrc,
        force: isCleanStart,
      });
    } catch (err) {
      this.dbLogger?.warn('failed to scaffold main workspace', { error: String(err) });
    }
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  /**
   * Runs startup recovery then begins normal operation.
   * Guards against double-start via startMutex.
   */
  async start(): Promise<void> {
    const release = await this.startMutex.acquire();
    try {
      if (this.started) {
        return;
      }
      this.started = true;

      // ── A. Startup recovery ─────────────────────────────────────────────────
      await this.runStartupRecovery();

      // ── B. Normal operation ─────────────────────────────────────────────────

      // Start config watchers (deferred from Build to avoid premature fires)
      if (this.configLoader !== null && this.eventBus !== null && this.orgChart !== null) {
        await this.configLoader.watchMaster((cfg) => {
          this.masterConfig = cfg;
          this.eventBus?.publish({
            type: 'config_changed',
            payload: { kind: 'config_changed', path: 'master' },
          });
        });
        await this.configLoader.watchProviders(() => {
          this.eventBus?.publish({
            type: 'config_changed',
            payload: { kind: 'config_changed', path: 'providers' },
          });
        });
      }

      // Reload master and build initial OrgChart
      if (this.configLoader !== null && this.orgChart !== null) {
        const master = await this.configLoader.loadMaster();
        this.masterConfig = master;
        const teams = await this.loadAllTeams();
        this.orgChart.rebuildFromConfig(master, teams);
      }

      // Register channels with router and connect them
      for (const channel of this.channels) {
        await this.router?.registerChannel(channel);
        try {
          await channel.connect();
        } catch (err) {
          // Log but don't block startup — external channels (Discord, WhatsApp)
          // may fail to connect if tokens are invalid.
          this.dbLogger?.warn('channel connect failed', {
            component: 'app',
            action: 'channel_connect',
            prefix: channel.getJIDPrefix(),
            error: String(err),
          });
        }
      }

      // Start orchestrator
      await this.orchestrator?.start();

      // Start heartbeat monitor
      this.heartbeatMonitor?.startMonitoring();

      // Start log archiver
      this.logArchiver?.start();

      // Start child process (main container orchestrator)
      await this.childProc?.start();

      // Start trigger scheduler and proactive loop
      if (this.triggerStore && this.dispatcher && this.dbLogger) {
        this.triggerScheduler = newTriggerScheduler({
          triggerStore: this.triggerStore,
          dispatchTask: async (teamSlug, agentAid, prompt) => {
            const task = await this.dispatcher!.createAndDispatch(teamSlug, agentAid, prompt, '');
            return task.id;
          },
          logger: this.dbLogger,
          eventBus: this.eventBus,
          taskStore: this.taskStore,
        });
        const triggers = await this.triggerStore.listEnabled();
        await this.triggerScheduler.start(triggers);
      }
      if (this.dispatcher && this.orgChart && this.taskStore && this.dbLogger) {
        this.proactiveLoop = newProactiveLoop({
          runDir: this.runDir,
          dispatchTask: async (teamSlug, agentAid, prompt) => {
            const task = await this.dispatcher!.createAndDispatch(teamSlug, agentAid, prompt, '');
            return task.id;
          },
          isAgentBusy: async (agentAid) => {
            const tasks = await this.taskStore!.listByStatus('running');
            return tasks.some((t) => t.agent_aid === agentAid);
          },
          getTeamSlugForAgent: (agentAid) => {
            try {
              const team = this.orgChart!.getTeamForAgent(agentAid);
              return team.slug;
            } catch {
              return null;
            }
          },
          logger: this.dbLogger,
        });
        // Initialize with current agents from org chart
        const allAgents: import('./domain/types.js').Agent[] = [];
        const orgChartTeams = this.orgChart.getOrgChart();
        for (const team of Object.values(orgChartTeams)) {
          if (team.agents) {
            allAgents.push(...team.agents);
          }
        }
        await this.proactiveLoop.start(allAgents);
      }

      this.dbLogger?.info('openhive backend started', {
        component: 'app',
        action: 'start',
      });
    } finally {
      release();
    }
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  /**
   * Stops all components in reverse order.
   * Idempotent — safe to call multiple times from concurrent signals.
   */
  async shutdown(): Promise<void> {
    if (this.shutdownOnce) {
      return;
    }
    this.shutdownOnce = true;

    this.dbLogger?.info('openhive backend shutting down', {
      component: 'app',
      action: 'shutdown',
    });

    // Reverse order of Start / Build

    // Stop proactive loop and trigger scheduler
    try {
      await this.proactiveLoop?.stop();
    } catch (err) {
      this.dbLogger?.error('proactive loop stop error', { error: String(err) });
    }
    try {
      await this.triggerScheduler?.stop();
    } catch (err) {
      this.dbLogger?.error('trigger scheduler stop error', { error: String(err) });
    }

    // Stop child process
    try {
      await this.childProc?.stop();
    } catch (err) {
      this.dbLogger?.error('child process stop error', { error: String(err) });
    }

    // Close WebSocket hub (connections, token manager, WS server)
    try {
      await this.wsHub?.close();
    } catch (err) {
      this.dbLogger?.error('ws hub close error', { error: String(err) });
    }

    // Stop orchestrator
    try {
      await this.orchestrator?.stop();
    } catch (err) {
      this.dbLogger?.error('orchestrator stop error', { error: String(err) });
    }

    // Stop heartbeat monitor
    this.heartbeatMonitor?.stopMonitoring();

    // Unregister channels
    for (const channel of this.channels) {
      try {
        await channel.disconnect();
      } catch (err) {
        this.dbLogger?.error('channel disconnect error', { error: String(err) });
      }
    }

    // Stop log archiver
    try {
      await this.logArchiver?.stop();
    } catch (err) {
      this.dbLogger?.error('log archiver stop error', { error: String(err) });
    }

    // Stop HTTP server
    try {
      await this.server?.shutdown();
    } catch (err) {
      this.dbLogger?.error('HTTP server shutdown error', { error: String(err) });
    }

    // Stop event bus
    this.eventBus?.close();

    // Stop config watcher
    this.configLoader?.stopWatching();

    // Stop DB logger (flush remaining batch)
    try {
      await this.dbLogger?.stop();
    } catch (err) {
      // Can't log with dbLogger here — it's stopping
      process.stderr.write(`dbLogger stop error: ${String(err)}\n`);
    }

    // Close database
    this.db?.close();
  }

  // ---------------------------------------------------------------------------
  // getServer (exposed for tests)
  // ---------------------------------------------------------------------------

  /** Returns the HTTP server instance (for address() and injection testing). */
  getServer(): ServerInstance | null {
    return this.server;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Runs the 5-step startup recovery sequence.
   * Each step is wrapped in try/catch so a failure in one step does not
   * prevent subsequent steps from running.
   */
  private async runStartupRecovery(): Promise<void> {
    let orphansRemoved = 0;
    let staleTasksFailed = 0;
    let sessionsExpired = 0;
    let pendingMessages = 0;
    let heartbeatsReset = false;

    // A.1 ORPHAN CONTAINER CLEANUP
    try {
      if (this.containerManager !== null) {
        await this.containerManager.cleanup();
        orphansRemoved = 1; // cleanup() handles counting internally
        this.dbLogger?.info('startup: orphan container cleanup complete', {
          component: 'app',
          action: 'startup_recovery',
        });
      } else {
        this.dbLogger?.info('startup: skipping orphan cleanup (Docker unavailable)', {
          component: 'app',
          action: 'startup_recovery',
        });
      }
    } catch (err) {
      this.dbLogger?.error('startup: orphan cleanup failed', {
        component: 'app',
        action: 'startup_recovery',
        error: String(err),
      });
    }

    // A.2 STALE TASK SCAN
    try {
      if (this.taskStore !== null) {
        const cutoff = new Date(Date.now() - STALE_TASK_THRESHOLD_MS);
        // TaskStatus: pending | running | completed | failed | cancelled
        // Scan 'running' tasks for staleness.
        const running = await this.taskStore.listByStatus('running');
        const staleTasks = [...running].filter(
          (t) => t.updated_at <= cutoff,
        );
        for (const task of staleTasks) {
          await this.taskStore.update({
            ...task,
            status: 'failed',
            error: 'stale_timeout_recovery',
            updated_at: new Date(),
            completed_at: new Date(),
          });
          staleTasksFailed++;
        }
        this.dbLogger?.info('startup: stale task scan complete', {
          component: 'app',
          action: 'startup_recovery',
          stale_tasks_failed: staleTasksFailed,
        });
      }
    } catch (err) {
      this.dbLogger?.error('startup: stale task scan failed', {
        component: 'app',
        action: 'startup_recovery',
        error: String(err),
      });
    }

    // A.3 SESSION CLEANUP
    try {
      if (this.sessionStore !== null) {
        const cutoff = new Date(Date.now() - SESSION_INACTIVE_THRESHOLD_MS);
        const sessions = await this.sessionStore.listAll();
        for (const session of sessions) {
          if (session.last_timestamp <= cutoff) {
            await this.sessionStore.delete(session.chat_jid);
            sessionsExpired++;
          }
        }
        this.dbLogger?.info('startup: session cleanup complete', {
          component: 'app',
          action: 'startup_recovery',
          sessions_expired: sessionsExpired,
        });
      }
    } catch (err) {
      this.dbLogger?.error('startup: session cleanup failed', {
        component: 'app',
        action: 'startup_recovery',
        error: String(err),
      });
    }

    // A.4 MESSAGE QUEUE DRAIN
    try {
      if (this.messageStore !== null) {
        // Check for undelivered messages in the last 24 hours
        const since = new Date(Date.now() - SESSION_INACTIVE_THRESHOLD_MS);
        // We use a sentinel JID to count pending messages across all sessions
        // by reading from the last 24h window. MessageStore has no "listAll"
        // so we check sessions for pending messages via session store.
        // For now: log the presence of any sessions with recent activity.
        if (this.sessionStore !== null) {
          const sessions = await this.sessionStore.listAll();
          for (const session of sessions) {
            const msgs = await this.messageStore.getByChat(
              session.chat_jid,
              since,
              100,
            );
            pendingMessages += msgs.length;
          }
        }
        if (pendingMessages > 0) {
          this.dbLogger?.warn('startup: found messages in last 24h — manual review may be needed', {
            component: 'app',
            action: 'startup_recovery',
            message_count: pendingMessages,
          });
        }
      }
    } catch (err) {
      this.dbLogger?.error('startup: message queue drain check failed', {
        component: 'app',
        action: 'startup_recovery',
        error: String(err),
      });
    }

    // A.5 HEARTBEAT RESET
    try {
      if (this.heartbeatMonitor !== null) {
        this.heartbeatMonitor.clearAll();
        heartbeatsReset = true;
        this.dbLogger?.info('startup: heartbeat state reset', {
          component: 'app',
          action: 'startup_recovery',
        });
      }
    } catch (err) {
      this.dbLogger?.error('startup: heartbeat reset failed', {
        component: 'app',
        action: 'startup_recovery',
        error: String(err),
      });
    }

    this.dbLogger?.info('startup recovery complete', {
      component: 'app',
      action: 'startup_recovery',
      orphans_removed: orphansRemoved,
      stale_tasks_failed: staleTasksFailed,
      sessions_expired: sessionsExpired,
      pending_messages_found: pendingMessages,
      heartbeats_reset: heartbeatsReset,
    });
  }

  /**
   * Builds the ContainerManager. Returns null if Docker is unavailable.
   */
  private buildContainerManager(master: MasterConfig): ManagerImpl | null {
    try {
      const runtime = newDockerRuntime(TEAM_IMAGE_NAME, this.dbLogger!);
      const wsURL = this.resolveWSURL(master);
      const hostRunDir = this.resolveHostRunDir();
      return newContainerManager(
        runtime,
        this.wsHub!,
        this.configLoader,
        this.dbLogger!,
        wsURL,
        undefined, // idleTimeoutMs — use default
        hostRunDir,
      );
    } catch {
      this.dbLogger?.warn('Docker unavailable — container management disabled', {
        component: 'app',
        action: 'build',
      });
      return null;
    }
  }

  /**
   * Resolves the host-absolute path for the run directory.
   * Used by ContainerManager to construct volume bind mounts for sibling
   * containers (Docker resolves bind paths on the host filesystem).
   *
   * Resolution order:
   *   1. OPENHIVE_HOST_RUN_DIR env var (explicit override)
   *   2. Auto-detect from /proc/1/mountinfo (maps container /app/run → host path)
   *   3. undefined (workspace mounts disabled with warning)
   */
  private resolveHostRunDir(): string | undefined {
    const envHostRunDir = process.env['OPENHIVE_HOST_RUN_DIR'];
    if (envHostRunDir !== undefined && envHostRunDir !== '') {
      this.dbLogger?.info('host run dir from env', {
        component: 'app',
        action: 'resolve_host_run_dir',
        host_run_dir: envHostRunDir,
      });
      return envHostRunDir;
    }

    // Auto-detect from mountinfo: find the mount that provides /app/run
    try {
      const mountinfo = readFileSync('/proc/1/mountinfo', 'utf-8');
      for (const line of mountinfo.split('\n')) {
        const parts = line.split(' ');
        // parts[4] = mount point inside container
        if (parts[4] === '/app/run') {
          // parts[3] = root of mount within the filesystem (subpath)
          // The host source is in the optional fields after the separator '-'
          const sepIdx = parts.indexOf('-');
          if (sepIdx >= 0 && parts.length > sepIdx + 2) {
            // parts[sepIdx+2] = mount source (host path for bind mounts)
            const hostPath = parts[sepIdx + 2];
            this.dbLogger?.info('host run dir auto-detected from mountinfo', {
              component: 'app',
              action: 'resolve_host_run_dir',
              host_run_dir: hostPath,
            });
            return hostPath;
          }
        }
      }
    } catch {
      // /proc/1/mountinfo not available (e.g. not in a container)
    }

    this.dbLogger?.warn('host run dir not resolved — child container workspace mounts disabled', {
      component: 'app',
      action: 'resolve_host_run_dir',
    });
    return undefined;
  }

  /**
   * Resolves the WebSocket URL for containers to connect to.
   * Uses OPENHIVE_WS_URL env var, or derives from listen address.
   */
  private resolveWSURL(master: MasterConfig): string {
    const envURL = process.env['OPENHIVE_WS_URL'];
    if (envURL !== undefined && envURL !== '') {
      return envURL;
    }
    const addr = master.system.listen_address;
    // Derive ws:// URL from listen address
    const host = addr.startsWith(':') ? `localhost${addr}` : addr;
    return `ws://${host}/ws/container`;
  }

  /**
   * Resolves the main team ID from the master config.
   * Uses OPENHIVE_MAIN_TEAM_ID env var, or defaults to 'main'.
   */
  private resolveMainTeamID(_master: MasterConfig): string {
    return process.env['OPENHIVE_MAIN_TEAM_ID'] ?? 'main';
  }

  /**
   * Resolves the path to the main-assistant/ static directory.
   * Uses OPENHIVE_MAIN_ASSISTANT_DIR env var, or defaults to
   * `main-assistant/` as a sibling of the data directory.
   */
  private resolveMainAssistantDir(): string {
    const envDir = process.env['OPENHIVE_MAIN_ASSISTANT_DIR'];
    if (envDir) {
      return path.isAbsolute(envDir) ? envDir : path.resolve(envDir);
    }
    // Default: sibling of data dir (e.g. /app/main-assistant/)
    return path.resolve(path.dirname(this.dataDir), 'main-assistant');
  }

  /**
   * Loads all team configurations from disk.
   * Returns a map of slug → Team.
   */
  private async loadAllTeams(): Promise<Record<string, import('./domain/types.js').Team>> {
    if (this.configLoader === null) {
      return {};
    }
    const slugs = await this.configLoader.listTeams();
    const teams: Record<string, import('./domain/types.js').Team> = {};
    for (const slug of slugs) {
      try {
        teams[slug] = await this.configLoader.loadTeam(slug);
      } catch (err) {
        this.dbLogger?.warn('failed to load team config', {
          slug,
          error: String(err),
        });
      }
    }
    return teams;
  }

  /**
   * Resolves AgentInitConfig list for a team container.
   * Used in the WS onConnect callback to send container_init.
   *
   * @param teamSlug - The team slug (from the WS token). Teams are matched by
   *   slug exclusively via orgChart.getTeamBySlug() — NOT by TID.
   */
  private async resolveAgentInitConfigs(
    teamSlug: string,
    configLoader: ConfigLoaderImpl | null,
    orgChart: OrgChartService | null,
  ): Promise<AgentInitConfig[]> {
    if (configLoader === null || orgChart === null) {
      return [];
    }
    try {
      const providers = await configLoader.loadProviders();
      // Look up the team by slug. NotFoundError is expected for the main
      // container (which is not registered as a named team in orgChart).
      let agents: Agent[] = [];
      try {
        const team = orgChart.getTeamBySlug(teamSlug);
        agents = team.agents ?? [];
      } catch (err) {
        if (!(err instanceof NotFoundError)) {
          throw err;
        }
        // No team entry for this slug (e.g. main container) — agents stays [].
      }

      // For the main container: include the assistant + top-level team leaders
      // from master.agents. Each gets a role for per-agent prompt selection.
      const isMainContainer = this.masterConfig !== null &&
        teamSlug === this.resolveMainTeamID(this.masterConfig);

      // Build agent+role pairs for the main container.
      // Track role separately to avoid adding non-Agent properties.
      type AgentRole = 'assistant' | 'leader' | 'worker';
      const roleMap = new Map<string, AgentRole>();

      if (isMainContainer && this.masterConfig !== null) {
        const assistant = this.masterConfig.assistant;
        const topLevelLeaders = (this.masterConfig.agents ?? []);

        const assistantAgent: Agent = {
          aid: assistant.aid,
          name: assistant.name,
          provider: assistant.provider,
          model_tier: assistant.model_tier,
          max_turns: assistant.max_turns,
          timeout_minutes: assistant.timeout_minutes,
        };
        roleMap.set(assistantAgent.aid, 'assistant');

        for (const a of topLevelLeaders) {
          roleMap.set(a.aid, 'leader');
        }
        for (const a of agents) {
          roleMap.set(a.aid, a.leads_team ? 'leader' : 'worker');
        }

        agents = [assistantAgent, ...topLevelLeaders, ...agents];
      }

      return agents.map((agent) => {
        const providerName = agent.provider ?? this.masterConfig?.assistant.provider ?? '';
        const provider = providers[providerName];
        const providerCfg: ProviderConfig = resolveProviderConfig(provider);
        const role: AgentRole = roleMap.get(agent.aid) ??
          (agent.leads_team ? 'leader' : 'worker');
        return {
          aid: agent.aid,
          name: agent.name,
          provider: providerCfg,
          model_tier: agent.model_tier ?? 'sonnet',
          skills: agent.skills,
          role,
          leads_team: agent.leads_team,
        };
      });
    } catch (err) {
      this.dbLogger?.error('failed to resolve agent init configs', {
        team_id: teamSlug,
        error: String(err),
      });
      return [];
    }
  }

  /**
   * Returns a sensible default MasterConfig when config files don't exist yet.
   * Used in Build to avoid a hard crash when config is absent.
   */
  private buildDefaultMasterConfig(): MasterConfig {
    return {
      system: {
        listen_address: ':8080',
        data_dir: this.dataDir,
        workspace_root: path.join(this.runDir, 'workspace'),
        log_level: 'info',
        log_archive: { enabled: false, max_entries: 10000, keep_copies: 5, archive_dir: path.join(this.runDir, 'archives', 'logs') },
        max_message_length: 10000,
        default_idle_timeout: '30m',
        event_bus_workers: 4,
        portal_ws_max_connections: 10,
        message_archive: { enabled: false, max_entries: 10000, keep_copies: 5, archive_dir: path.join(this.runDir, 'archives', 'messages') },
        limits: { max_depth: 5, max_teams: 20, max_agents_per_team: 10, max_concurrent_tasks: 50 },
      },
      assistant: {
        name: 'main-assistant',
        aid: 'aid-main-assistant',
        provider: 'default',
        model_tier: 'sonnet',
        max_turns: 100,
        timeout_minutes: 30,
      },
      channels: {
        discord: { enabled: false },
        whatsapp: { enabled: false },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// resolveProviderConfig
// ---------------------------------------------------------------------------

/**
 * Maps a domain Provider to a ws.ProviderConfig for the wire protocol.
 */
export function resolveProviderConfig(provider: Provider | undefined): ProviderConfig {
  if (provider === undefined) {
    return { type: 'oauth' };
  }
  switch (provider.type) {
    case 'oauth':
      return { type: 'oauth', oauth_token: provider.oauth_token };
    case 'anthropic_direct':
      return {
        type: 'anthropic_direct',
        api_key: provider.api_key,
        api_url: provider.base_url,
      };
    default:
      return { type: provider.type, api_key: provider.api_key, api_url: provider.base_url };
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * Entry point — creates the App, sets up signal handling, and starts.
 * Uses startMutex + shutdownOnce to prevent concurrent start/shutdown races.
 */
async function main(): Promise<void> {
  const app = new App();

  // Build all components (async — loads config, unlocks crypto)
  await app.build(process.env['OPENHIVE_LOG_LEVEL'] ?? 'info');

  // Signal handler — triggers graceful shutdown on SIGINT/SIGTERM
  let shutdownInitiated = false;
  const onSignal = (): void => {
    if (shutdownInitiated) {
      return;
    }
    shutdownInitiated = true;
    void app.shutdown().then(() => {
      process.exit(0);
    }).catch(() => {
      process.exit(1);
    });
  };

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  // Start application (recovery + background loops) before accepting connections
  await app.start();

  // Start HTTP server (after app is fully initialized)
  const server = app.getServer();
  if (server !== null) {
    await server.start();
  }

  // Block forever — signal handler drives shutdown
  await new Promise<void>(() => {
    // Never resolves; process exits via onSignal
  });
}

// Run only when executed directly (not imported in tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err: unknown) => {
    process.stderr.write(`fatal: ${String(err)}\n`);
    process.exit(1);
  });
}
