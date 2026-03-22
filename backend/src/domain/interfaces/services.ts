/**
 * Service interfaces for orchestration, routing, execution, and more.
 *
 * @module domain/interfaces/services
 */

import type {
  Task,
  LogEntry,
  Provider,
  Credential,
} from '../domain.js';

import type {
  TaskStatus,
  ChannelType,
  AgentRole,
  EscalationReason,
  LogLevel,
} from '../enums.js';

import type { MasterConfig } from '../../config/defaults.js';

import type {
  InboundMessage,
  OutboundMessage,
  MessageHandler,
  SkillDefinition,
  AgentInitConfig,
} from './supporting-types.js';

// ---------------------------------------------------------------------------
// Orchestrator and Router
// ---------------------------------------------------------------------------

/** Central orchestration logic. */
export interface Orchestrator {
  handleToolCall(agentAid: string, toolName: string, args: Record<string, unknown>, callId: string): Promise<Record<string, unknown>>;
  dispatchTask(task: Task): Promise<void>;
  handleTaskResult(taskId: string, agentAid: string, status: TaskStatus, result?: string, error?: string): Promise<void>;
  handleEscalation(agentAid: string, taskId: string, reason: EscalationReason, context: Record<string, unknown>): Promise<string>;
  handleEscalationResponse(correlationId: string, resolution: string, context: Record<string, unknown>): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Two-tier message routing (known routes + LLM fallback). */
export interface Router {
  route(message: InboundMessage): Promise<string>;
  addKnownRoute(pattern: string, teamSlug: string): void;
  removeKnownRoute(pattern: string): void;
  listKnownRoutes(): Array<{ pattern: string; teamSlug: string }>;
}

// ---------------------------------------------------------------------------
// MCP Bridge and Registry
// ---------------------------------------------------------------------------

/** Bridges in-process MCP server tool calls to the WebSocket protocol. */
export interface MCPBridge {
  callTool(toolName: string, args: Record<string, unknown>, agentAid: string): Promise<Record<string, unknown>>;
  handleResult(callId: string, result: Record<string, unknown>): void;
  handleError(callId: string, errorCode: string, errorMessage: string): void;
  getPendingCalls(): number;
}

/** Tool registration and discovery for the in-process MCP server. */
export interface MCPRegistry {
  registerTool(name: string, schema: Record<string, unknown>, handler: (args: Record<string, unknown>, agentAid: string) => Promise<Record<string, unknown>>): void;
  unregisterTool(name: string): void;
  getTool(name: string): { schema: Record<string, unknown>; handler: (args: Record<string, unknown>, agentAid: string) => Promise<Record<string, unknown>> } | undefined;
  listTools(): Array<{ name: string; schema: Record<string, unknown> }>;
  getToolsForRole(role: AgentRole): Array<{ name: string; schema: Record<string, unknown> }>;
  isAllowed(toolName: string, role: AgentRole): boolean;
}

// ---------------------------------------------------------------------------
// Channel Interfaces
// ---------------------------------------------------------------------------

/** Messaging channel adapter (Discord, WhatsApp, etc.). */
export interface ChannelAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(msg: OutboundMessage): Promise<void>;
  onMessage(handler: MessageHandler): void;
  /** Start showing a processing indicator (typing, spinner, etc.). Optional. */
  startProcessing?(chatJid: string): void;
  /** Stop showing the processing indicator. Optional. */
  stopProcessing?(chatJid: string): void;
}

/** Maps inbound channel messages to teams/agents via two-tier routing. */
export interface MessageRouter {
  routeMessage(msg: InboundMessage): Promise<void>;
  registerChannel(channelType: ChannelType, adapter: ChannelAdapter): void;
  unregisterChannel(channelType: ChannelType): void;
  /** Send a response back to the originating channel via chatJid. */
  sendResponse(chatJid: string, content: string): Promise<void>;
  /** Get the adapter for a channel type. */
  getAdapter(channelType: ChannelType): ChannelAdapter | undefined;
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

/** AES-256-GCM encryption key management. */
export interface KeyManager {
  unlock(masterKey: string): Promise<void>;
  lock(): Promise<void>;
  /** Rotate to a new master key. If credentialStore provided, migrates existing encrypted data. */
  rekey(newMasterKey: string, credentialStore?: {
    listByTeam: (teamSlug: string) => Promise<Credential[]>;
    get: (id: string) => Promise<Credential>;
    update: (credential: Credential) => Promise<void>;
  }, teamSlugs?: string[]): Promise<number>;
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
  isUnlocked(): boolean;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/** Central logger that fans out to sinks. */
export interface Logger {
  log(entry: Partial<LogEntry> & { level: LogLevel; message: string }): void;
  trace(message: string, params?: Record<string, unknown>): void;
  debug(message: string, params?: Record<string, unknown>): void;
  info(message: string, params?: Record<string, unknown>): void;
  warn(message: string, params?: Record<string, unknown>): void;
  error(message: string, params?: Record<string, unknown>): void;
  audit(message: string, params?: Record<string, unknown>): void;
  flush(): Promise<void>;
  stop(): Promise<void>;
}

/** Pluggable log output backend. */
export interface LogSink {
  write(entries: LogEntry[]): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** Loads skill definitions from SKILL.md files. */
export interface SkillLoader {
  loadSkill(workspacePath: string, skillName: string): Promise<SkillDefinition>;
  loadAllSkills(workspacePath: string): Promise<SkillDefinition[]>;
  loadCommonSkills(): Promise<SkillDefinition[]>;
}

/** Registry for available skills, supports team overrides of common skills. */
export interface SkillRegistry {
  register(teamSlug: string, skill: SkillDefinition): void;
  unregister(teamSlug: string, skillName: string): void;
  get(teamSlug: string, skillName: string): SkillDefinition | undefined;
  listForTeam(teamSlug: string): SkillDefinition[];
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/** Manages cron, webhook, channel_event, and task_completion triggers. */
export interface TriggerScheduler {
  loadTriggers(): Promise<void>;
  addCronTrigger(name: string, schedule: string, targetTeam: string, prompt: string, agent?: string, replyTo?: string): void;
  removeTrigger(name: string): void;
  listTriggers(): Array<{ name: string; type: string; schedule?: string; targetTeam: string }>;
  start(): void;
  stop(): void;
}

// ---------------------------------------------------------------------------
// Workspace Locking
// ---------------------------------------------------------------------------

/** Advisory workspace-level locks for concurrent access control. */
export interface WorkspaceLock {
  acquire(workspacePath: string): Promise<void>;
  release(workspacePath: string): void;
  isLocked(workspacePath: string): boolean;
}

// ---------------------------------------------------------------------------
// Dispatch Tracker
// ---------------------------------------------------------------------------

/**
 * Tracks in-flight task dispatches so state can be replayed after a container restart.
 * Dispatches are acknowledged when the container confirms receipt (task_result or status_update).
 * Unacknowledged dispatches after the 60s grace period are eligible for re-dispatch.
 */
export interface DispatchTracker {
  /** Record that a task was dispatched to a container. */
  trackDispatch(taskId: string, tid: string, agentAid: string): void;
  /** Mark a dispatched task as acknowledged (container confirmed receipt). */
  acknowledgeDispatch(taskId: string): void;
  /** Return task IDs dispatched to the given TID that have not yet been acknowledged. */
  getUnacknowledged(tid: string): string[];
  /** Return task IDs dispatched by the given agent AID that have not yet been acknowledged. */
  getUnacknowledgedByAgent(agentAid: string): string[];
  /** Transfer dispatch ownership from old TID to new TID (container restart). */
  transferOwnership(oldTid: string, newTid: string): number;
  /** Check if a task is currently tracked (dispatched but not yet acknowledged). */
  isTracked(taskId: string): boolean;
  /** Start the tracker (sets up any internal timers). */
  start(): void;
  /** Stop the tracker and clear any internal timers. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Plugin Manager
// ---------------------------------------------------------------------------

/**
 * Manages LogSink plugins loaded from workspace/plugins/sinks/ via dynamic import().
 * Supports hot-reload via chokidar with content-hash deduplication.
 * All plugin calls are wrapped in try/catch error boundaries.
 */
export interface PluginManager {
  /** Discover and load all plugin files from the configured plugin directory. */
  loadAll(): Promise<void>;
  /** Begin watching the plugin directory for additions, changes, and removals. */
  startWatching(): void;
  /** Stop watching the plugin directory. */
  stopWatching(): void;
  /** Return all currently loaded LogSink instances. */
  getLoadedSinks(): LogSink[];
  /** Force reload a specific plugin file by its absolute path. */
  reloadPlugin(pluginPath: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/** Manages Claude Agent SDK process lifecycle for a single agent. */
export interface AgentExecutor {
  start(agent: AgentInitConfig, workspacePath: string, taskId?: string): Promise<void>;
  stop(agentAid: string, timeoutMs: number): Promise<void>;
  kill(agentAid: string): void;
  isRunning(agentAid: string): boolean;
  getStatus(agentAid: string): import('../enums.js').AgentStatus | undefined;
  /**
   * Dispatches a task to a running agent by sending a prompt.
   * Uses the SDK programmatic API to run a query with the prompt.
   * Returns the agent's text output and updated session ID.
   */
  dispatchTask(agentAid: string, prompt: string, taskId: string): Promise<{ output: string; sessionId?: string }>;
}

/** Manages SDK sessions with resume support. */
export interface SessionManager {
  createSession(agentAid: string, taskId: string, tid: string): Promise<string>;
  resumeSession(sessionId: string): Promise<void>;
  endSession(sessionId: string): Promise<void>;
  getSessionByAgent(agentAid: string): string | undefined;
  /**
   * Populate the in-memory session map from the SessionStore.
   * Must be called at startup before any getSessionByAgent() calls so that
   * sessions persisted before a root restart are visible in memory.
   */
  preloadFromStore(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Loads and persists configuration files (openhive.yaml, providers.yaml, team.yaml). */
export interface ConfigLoader {
  loadMaster(): Promise<MasterConfig>;
  saveMaster(config: MasterConfig): Promise<void>;
  getMaster(): MasterConfig;
  loadProviders(): Promise<Record<string, Provider>>;
  saveProviders(providers: Record<string, Provider>): Promise<void>;
  loadTeam(workspacePath: string): Promise<import('../domain.js').Team>;
  saveTeam(workspacePath: string, team: import('../domain.js').Team): Promise<void>;
  createTeamDir(slug: string): Promise<void>;
  deleteTeamDir(slug: string): Promise<void>;
  listTeams(): Promise<string[]>;
  watchMaster(callback: (cfg: MasterConfig) => void): void;
  watchProviders(callback: (providers: Record<string, Provider>) => void): void;
  watchTeam(workspacePath: string, callback: (team: import('../domain.js').Team) => void): void;
  stopWatching(): void;
  /**
   * Return the resolved config annotated with provenance.
   *
   * Each leaf field in the config is described by:
   *   - `value`    — the resolved value (same as getMaster()[key])
   *   - `source`   — where the value came from: 'default' | 'yaml' | 'env'
   *   - `isSecret` — true if the value should be redacted in display (e.g. API keys)
   *
   * The returned Record mirrors the shape of MasterConfig but with a flat key-path
   * structure (e.g. `"limits.max_depth"`) so callers can display a diff-friendly table.
   * Allows RouteContext to depend on this interface (not ConfigLoaderImpl), preserving
   * the abstraction boundary required by step 16 (admin settings API).
   */
  getConfigWithSources(): Promise<Record<string, { value: unknown; source: 'default' | 'yaml' | 'env'; isSecret?: boolean }>>;
}
