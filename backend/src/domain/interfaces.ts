/**
 * Service interfaces for OpenHive.
 *
 * All cross-module boundaries use interfaces from this file (C11, interface-first design).
 * Methods throw on error unless otherwise noted. All types reference domain.ts and enums.ts.
 */

import type {
  Task,
  Team,
  Message,
  LogEntry,
  ChatSession,
  TaskEvent,
  ToolCall,
  Decision,
  MemoryEntry,
  Integration,
  Credential,
  Provider,
} from './domain.js';

import type {
  TaskStatus,
  LogLevel,
  ChannelType,
  ContainerHealth,
  AgentStatus,
  AgentRole,
  ProviderType,
  ModelTier,
  EscalationReason,
  IntegrationStatus,
} from './enums.js';

import type { MasterConfig } from '../config/defaults.js';

// ---------------------------------------------------------------------------
// Supporting Types (used by interfaces below)
// ---------------------------------------------------------------------------

/** Options for querying log entries. */
export interface LogQueryOpts {
  level?: LogLevel;
  eventType?: string;
  component?: string;
  teamSlug?: string;
  taskId?: string;
  agentAid?: string;
  requestId?: string;
  correlationId?: string;
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
}

/** Query parameters for searching agent memories. */
export interface MemoryQuery {
  agentAid?: string;
  teamSlug?: string;
  query?: string;
  limit?: number;
  since?: Date;
}

/** Configuration for creating a Docker container. */
export interface ContainerConfig {
  teamSlug: string;
  tid: string;
  image: string;
  workspacePath: string;
  /** Host-side workspace path for Docker bind mounts. Falls back to workspacePath if not set. */
  hostWorkspacePath?: string;
  env: Record<string, string>;
  networkMode: string;
  memoryLimit?: string;
  cpuLimit?: number;
}

/** Runtime information about a Docker container. */
export interface ContainerInfo {
  id: string;
  name: string;
  state: string;
  teamSlug: string;
  tid: string;
  health: ContainerHealth;
  createdAt: number;
}

/** Resolved provider credentials for an agent. */
export interface ResolvedProvider {
  type: ProviderType;
  apiKey?: string;
  baseUrl?: string;
  oauthToken?: string;
  models: Record<ModelTier, string>;
}

/** Agent initialization config sent in container_init. */
export interface AgentInitConfig {
  aid: string;
  name: string;
  description: string;
  role: string;
  model: string;
  /** Model tier alias ('haiku' | 'sonnet' | 'opus') for SDK query resolution. */
  modelTier?: string;
  tools: string[];
  provider: ResolvedProvider;
  systemPrompt?: string;
  /** External MCP servers from team.yaml mcp_servers config. */
  mcpServers?: MCPServerConfig[];
}

/** MCP server configuration for a team container. */
export interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Event payload for the EventBus. */
export interface BusEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
  source?: string;
}

/** Subscription callback for the EventBus. */
export type EventHandler = (event: BusEvent) => void;

/** Filter predicate for filtered subscriptions. */
export type EventFilter = (event: BusEvent) => boolean;

/** Agent node in the org chart. */
export interface OrgChartAgent {
  aid: string;
  name: string;
  teamSlug: string;
  role: string;
  status: AgentStatus;
  leadsTeam?: string;
  /**
   * Model tier this agent was created with ('haiku' | 'sonnet' | 'opus').
   * Optional because: (1) agents created before this field existed won't have it,
   * and (2) the main assistant model comes from provider config, not per-agent config.
   * OrgChart stores runtime state only; this is captured at agent registration time
   * from the create_agent tool's `model` parameter.
   */
  modelTier?: string;
}

/** Team node in the org chart. */
export interface OrgChartTeam {
  tid: string;
  slug: string;
  leaderAid: string;
  parentTid: string;
  depth: number;
  containerId: string;
  health: ContainerHealth;
  agentAids: string[];
  workspacePath: string;
}

/** Channel message delivered to the message router. */
export interface InboundMessage {
  id: string;
  chatJid: string;
  channelType: ChannelType;
  content: string;
  timestamp: number;
}

/** Outbound message sent through a channel adapter. */
export interface OutboundMessage {
  chatJid: string;
  content: string;
}

/** Message handler callback for channel adapters. */
export type MessageHandler = (msg: InboundMessage) => Promise<void>;

/** Skill definition loaded from SKILL.md files. */
export interface SkillDefinition {
  name: string;
  description: string;
  argumentHint?: string;
  allowedTools?: string[];
  model?: ModelTier;
  context?: 'fork';
  agent?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  body: string;
}

/** Agent definition loaded from agent .md files. */
export interface AgentDefinition {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  content: string;
}

/**
 * WebSocket message on the wire.
 *
 * This is the structural supertype used in interface signatures (WSHub, WSConnection).
 * The concrete discriminated union lives in `websocket/protocol.ts` as
 * `RootToContainerMessage | ContainerToRootMessage` — that type is assignable to this
 * interface without introducing a circular dependency.
 */
export interface WSMessage {
  type: string;
  data: Record<string, unknown>;
}

/** Topology tree returned by inspect_topology. */
export interface TopologyNode {
  tid: string;
  slug: string;
  leaderAid: string;
  health: ContainerHealth;
  agents: OrgChartAgent[];
  children: TopologyNode[];
}

// ---------------------------------------------------------------------------
// Store Interfaces (Database-Schema.md)
// ---------------------------------------------------------------------------

/** Task persistence. Throws on database error. */
export interface TaskStore {
  create(task: Task): Promise<void>;
  get(id: string): Promise<Task>;
  update(task: Task): Promise<void>;
  delete(id: string): Promise<void>;
  listByTeam(teamSlug: string): Promise<Task[]>;
  listByStatus(status: TaskStatus): Promise<Task[]>;
  getSubtree(rootID: string): Promise<Task[]>;
  getBlockedBy(taskId: string): Promise<string[]>;
  unblockTask(taskId: string, completedDependencyId: string): Promise<boolean>;
  retryTask(taskId: string): Promise<boolean>;
  validateDependencies(taskId: string, blockedByIds: string[]): Promise<void>;
  /** Get recent user-originated root tasks for conversation history injection. */
  getRecentUserTasks(agentAid: string, limit: number): Promise<Task[]>;
}

/** Chat message persistence. Throws on database error. */
export interface MessageStore {
  create(msg: Message): Promise<void>;
  getByChat(chatJID: string, since: Date, limit: number): Promise<Message[]>;
  getLatest(chatJID: string, n: number): Promise<Message[]>;
  deleteByChat(chatJID: string): Promise<void>;
  deleteBefore(before: Date): Promise<number>;
}

/** Structured log persistence. create() accepts an array for batch insert. */
export interface LogStore {
  create(entries: LogEntry[]): Promise<void>;
  /** Insert log entries and return their IDs. Non-breaking extension for FK relationships. */
  createWithIds(entries: LogEntry[]): Promise<number[]>;
  query(opts: LogQueryOpts): Promise<LogEntry[]>;
  deleteBefore(before: Date): Promise<number>;
  deleteByLevelBefore(level: number, before: Date): Promise<number>;
  count(): Promise<number>;
  getOldest(limit: number): Promise<LogEntry[]>;
}

/** Task lifecycle event persistence. */
export interface TaskEventStore {
  create(event: TaskEvent): Promise<void>;
  getByTask(taskId: string): Promise<TaskEvent[]>;
  getByLogEntry(logEntryId: number): Promise<TaskEvent | null>;
}

/** Tool invocation record persistence. */
export interface ToolCallStore {
  create(call: ToolCall): Promise<void>;
  getByTask(taskId: string): Promise<ToolCall[]>;
  getByAgent(agentAid: string, since: Date): Promise<ToolCall[]>;
  getByToolName(toolName: string, since: Date): Promise<ToolCall[]>;
}

/** LLM decision record persistence. */
export interface DecisionStore {
  create(decision: Decision): Promise<void>;
  getByTask(taskId: string): Promise<Decision[]>;
  getByAgent(agentAid: string, since: Date): Promise<Decision[]>;
  getByType(type: string, since: Date): Promise<Decision[]>;
}

/** Chat session persistence. get() throws NotFoundError when not found. */
export interface SessionStore {
  get(chatJID: string): Promise<ChatSession>;
  upsert(session: ChatSession): Promise<void>;
  delete(chatJID: string): Promise<void>;
  listAll(): Promise<ChatSession[]>;
}

/** Integration configuration persistence. */
export interface IntegrationStore {
  create(integration: Integration): Promise<void>;
  get(id: string): Promise<Integration>;
  update(integration: Integration): Promise<void>;
  delete(id: string): Promise<void>;
  listByTeam(teamId: string): Promise<Integration[]>;
  /** Update integration status. For terminal states (failed, rolled_back), pass errorMessage to record the cause (AC-G8). */
  updateStatus(id: string, status: IntegrationStatus, errorMessage?: string): Promise<void>;
}

/** Encrypted credential persistence (per-team). */
export interface CredentialStore {
  create(credential: Credential): Promise<void>;
  get(id: string): Promise<Credential>;
  update(credential: Credential): Promise<void>;
  delete(id: string): Promise<void>;
  listByTeam(teamId: string): Promise<Credential[]>;
}

/** Agent memory persistence with soft-delete and hybrid search. */
export interface MemoryStore {
  /** Save a memory entry. Returns the autoincrement id for chunk FK linkage. */
  save(entry: MemoryEntry): Promise<number>;
  search(query: MemoryQuery): Promise<MemoryEntry[]>;
  getByAgent(agentAID: string): Promise<MemoryEntry[]>;
  deleteBefore(date: Date): Promise<number>;
  softDeleteByAgent(agentAID: string): Promise<number>;
  softDeleteByTeam(teamSlug: string): Promise<number>;
  purgeDeleted(olderThanDays: number): Promise<number>;
  /** BM25 keyword search via FTS5. Falls back to LIKE if FTS5 unavailable. */
  searchBM25(query: string, agentAid: string, limit?: number): Promise<MemoryEntry[]>;
  /** Hybrid search: BM25 + vector with temporal decay and MMR. */
  searchHybrid(query: string, agentAid: string, queryEmbedding?: Float32Array, limit?: number): Promise<MemoryEntry[]>;
  /** Save embedding chunks for a memory entry. */
  saveChunks(memoryId: number, chunks: Array<{ content: string; embedding: Float32Array; embeddingModel: string }>): Promise<void>;
  /** Get embedding chunks for a memory entry. */
  getChunks(memoryId: number): Promise<MemoryChunk[]>;
  /** Delete chunks for a memory entry. */
  deleteChunks(memoryId: number): Promise<void>;
}

/** Embedding chunk stored alongside a memory entry. */
export interface MemoryChunk {
  id: number;
  memory_id: number;
  chunk_index: number;
  content: string;
  embedding: Float32Array;
  embedding_model: string;
  created_at: number;
}

/** Embedding service for vector search. */
export interface EmbeddingService {
  /** Compute embedding vector for text. */
  embed(text: string): Promise<Float32Array>;
  /** Model identifier for this service (stored per chunk for consistency). */
  readonly modelId: string;
}

/** Transaction wrapper. If the callback throws, the transaction rolls back. */
export type TxHandle = unknown;
export type TransactionCallback<T = void> = (tx: TxHandle) => T | Promise<T>;

export interface Transactor {
  withTransaction<T = void>(fn: TransactionCallback<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Container Interfaces
// ---------------------------------------------------------------------------

/** Low-level Docker container operations (dockerode wrapper). */
export interface ContainerRuntime {
  createContainer(config: ContainerConfig): Promise<string>;
  startContainer(containerID: string): Promise<void>;
  stopContainer(containerID: string, timeoutMs: number): Promise<void>;
  removeContainer(containerID: string): Promise<void>;
  inspectContainer(containerID: string): Promise<ContainerInfo>;
  listContainers(): Promise<ContainerInfo[]>;
}

/** High-level container lifecycle coordination. */
export interface ContainerManager {
  spawnTeamContainer(teamSlug: string): Promise<ContainerInfo>;
  stopTeamContainer(teamSlug: string, reason: string): Promise<void>;
  restartTeamContainer(teamSlug: string, reason: string): Promise<void>;
  getContainerByTeam(teamSlug: string): Promise<ContainerInfo | undefined>;
  listRunningContainers(): Promise<ContainerInfo[]>;
  cleanupStoppedContainers(): Promise<number>;
}

/** Workspace scaffolding and team provisioning. */
export interface ContainerProvisioner {
  scaffoldWorkspace(parentPath: string, teamSlug: string, agents?: AgentDefinition[]): Promise<string>;
  writeTeamConfig(workspacePath: string, team: Team): Promise<void>;
  writeAgentDefinition(workspacePath: string, agent: AgentDefinition): Promise<void>;
  writeSettings(workspacePath: string, allowedTools: string[]): Promise<void>;
  deleteWorkspace(workspacePath: string): Promise<void>;
  archiveWorkspace(workspacePath: string, archivePath: string): Promise<void>;
}

/** Container health monitoring and recovery. */
export interface HealthMonitor {
  recordHeartbeat(tid: string, agents: Array<{ aid: string; status: AgentStatus; detail: string }>): void;
  getHealth(tid: string): ContainerHealth;
  getAgentHealth(aid: string): AgentStatus | undefined;
  getAllHealth(): Map<string, ContainerHealth>;
  getStuckAgents(timeoutMs: number): string[];
  /**
   * Check all container heartbeat timeouts and emit health.state_changed events.
   * Called by the orchestrator's consolidated 30s timer (AC-CROSS-4).
   */
  checkTimeouts(): void;
  start(): void;
  stop(): void;
}

// ---------------------------------------------------------------------------
// WebSocket Interfaces
// ---------------------------------------------------------------------------

/** WebSocket hub managing all container connections (root-only). */
export interface WSHub {
  handleUpgrade(request: unknown, socket: unknown, head: unknown): void;
  send(tid: string, message: WSMessage): void;
  broadcast(message: WSMessage): void;
  isConnected(tid: string): boolean;
  /** Mark a team as having completed the ready handshake. */
  setReady(tid: string): void;
  /** Check if a team has completed the ready handshake. */
  isReady(tid: string): boolean;
  getConnectedTeams(): string[];
  close(): Promise<void>;
}

/** Individual WebSocket connection to a container. */
export interface WSConnection {
  readonly tid: string;
  send(message: WSMessage): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (message: WSMessage) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  isAlive(): boolean;
}

/** One-time WebSocket auth token management. */
export interface TokenManager {
  generate(tid: string): string;
  validate(token: string, tid: string): boolean;
  revoke(token: string): void;
  revokeAll(): void;
  startCleanup(intervalMs: number): void;
  stopCleanup(): void;
  /** Generate a long-lived session token for reconnect (distinct from one-time tokens). */
  generateSession(tid: string): string;
  /** Validate a session token for the given TID. Returns true if valid and not revoked. */
  validateSession(token: string, tid: string): boolean;
  /**
   * Revoke all session tokens AND one-time tokens bound to the given TID.
   * Called during container restart/stop to invalidate stale auth before issuing new tokens.
   * Idempotent: safe to call even if no tokens exist for the TID.
   */
  revokeSessionsForTid(tid: string): void;
  /**
   * Revoke a single session token by value.
   * No-op if the token does not exist.
   */
  revokeSession(token: string): void;
}

// ---------------------------------------------------------------------------
// Event Bus
// ---------------------------------------------------------------------------

/** In-memory pub/sub event bus for internal system events. */
export interface EventBus {
  publish(event: BusEvent): void;
  subscribe(handler: EventHandler): string;
  filteredSubscribe(filter: EventFilter, handler: EventHandler): string;
  unsubscribe(subscriptionId: string): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Org Chart
// ---------------------------------------------------------------------------

/** In-memory org chart tracking all agents and teams. */
export interface OrgChart {
  addTeam(team: OrgChartTeam): void;
  updateTeam(team: OrgChartTeam): void;
  removeTeam(tid: string): void;
  getTeam(tid: string): OrgChartTeam | undefined;
  getTeamBySlug(slug: string): OrgChartTeam | undefined;
  listTeams(): OrgChartTeam[];
  getChildren(tid: string): OrgChartTeam[];
  getParent(tid: string): OrgChartTeam | undefined;

  addAgent(agent: OrgChartAgent): void;
  updateAgent(agent: OrgChartAgent): void;
  removeAgent(aid: string): void;
  getAgent(aid: string): OrgChartAgent | undefined;
  getAgentsByTeam(teamSlug: string): OrgChartAgent[];
  getLeadOf(teamSlug: string): OrgChartAgent | undefined;

  isAuthorized(sourceAid: string, targetAid: string): boolean;
  getTopology(depth?: number): TopologyNode[];
}

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
  addCronTrigger(name: string, schedule: string, targetTeam: string, prompt: string): void;
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
  getStatus(agentAid: string): AgentStatus | undefined;
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
  loadTeam(workspacePath: string): Promise<Team>;
  saveTeam(workspacePath: string, team: Team): Promise<void>;
  createTeamDir(slug: string): Promise<void>;
  deleteTeamDir(slug: string): Promise<void>;
  listTeams(): Promise<string[]>;
  watchMaster(callback: (cfg: MasterConfig) => void): void;
  watchProviders(callback: (providers: Record<string, Provider>) => void): void;
  watchTeam(workspacePath: string, callback: (team: Team) => void): void;
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
