/**
 * OpenHive Backend - Domain Interfaces
 *
 * Contracts that all concrete implementations must satisfy throughout the
 * backend. Methods that perform I/O return Promise<T> and throw on error.
 *
 * Design rules:
 *   - Do NOT use Record<string, unknown> — use Record<string, JsonValue> and validate
 *     at the boundary with type guard functions.
 */

import type {
  MasterConfig,
  Provider,
  Team,
  Agent,
  ContainerConfig,
  ContainerInfo,
  AgentHeartbeatStatus,
  HeartbeatStatus,
  Task,
  Message,
  LogEntry,
  LogQueryOpts,
  ChatSession,
  Event,
  JsonValue,
  Escalation,
  EscalationStatus,
  AgentMemory,
  Trigger,
  SkillInfo,
} from './types.js';

import type { EventType, TaskStatus, ContainerState } from './enums.js';

// ---------------------------------------------------------------------------
// FastifyUpgradeHandler
// ---------------------------------------------------------------------------

/**
 * A Fastify-compatible WebSocket upgrade handler type.
 *
 * The upgrade handler is registered via @fastify/websocket. This type
 * represents the raw HTTP request object that Fastify provides during
 * the upgrade phase.
 *
 * Concrete implementations use `fastify.get(path, { websocket: true }, handler)`
 * where `connection` is a `WebSocket` and `request` is a `FastifyRequest`.
 * This opaque type avoids importing Fastify at the domain layer.
 */
export type FastifyUpgradeHandler = (socket: unknown, request: unknown) => void | Promise<void>;

// ---------------------------------------------------------------------------
// TransactionCallback
// ---------------------------------------------------------------------------

/**
 * A generic transaction callback that receives a typed transaction handle.
 *
 * We use an opaque TxHandle type so that concrete store implementations
 * can supply the real Drizzle transaction type without coupling the domain
 * layer to Drizzle.
 *
 * TxHandle is intentionally opaque at this layer — implementations cast it
 * to the concrete Drizzle transaction type internally.
 */
export type TxHandle = unknown;
export type TransactionCallback<T = void> = (tx: TxHandle) => Promise<T>;

// ---------------------------------------------------------------------------
// ConfigLoader
// ---------------------------------------------------------------------------

/**
 * Handles config file I/O and watching.
 *
 * All methods that perform I/O return Promise<T> and throw on error.
 * WatchMaster/WatchProviders/WatchTeam register callbacks for live-reload
 * and return a Promise that resolves once the watcher is established.
 */
export interface ConfigLoader {
  loadMaster(): Promise<MasterConfig>;
  saveMaster(cfg: MasterConfig): Promise<void>;
  getMaster(): MasterConfig;
  loadProviders(): Promise<Record<string, Provider>>;
  saveProviders(providers: Record<string, Provider>): Promise<void>;
  loadTeam(slug: string): Promise<Team>;
  saveTeam(slug: string, team: Team): Promise<void>;
  createTeamDir(slug: string): Promise<void>;
  deleteTeamDir(slug: string): Promise<void>;
  listTeams(): Promise<string[]>;
  watchMaster(callback: (cfg: MasterConfig) => void): Promise<void>;
  watchProviders(callback: (providers: Record<string, Provider>) => void): Promise<void>;
  watchTeam(slug: string, callback: (team: Team) => void): Promise<void>;
  stopWatching(): void;
}

// ---------------------------------------------------------------------------
// OrgChart
// ---------------------------------------------------------------------------

/**
 * Provides hierarchy query operations on the agent/team structure.
 *
 * All methods are synchronous (in-memory index queries after initial build).
 * RebuildFromConfig throws on structural inconsistency.
 */
export interface OrgChart {
  getOrgChart(): Record<string, Team>;
  getAgentByAID(aid: string): Agent;
  getTeamBySlug(slug: string): Team;
  getTeamForAgent(aid: string): Team;
  getLeadTeams(aid: string): string[];
  getSubordinates(aid: string): Agent[];
  getSupervisor(aid: string): Agent | null;
  rebuildFromConfig(master: MasterConfig, teams: Record<string, Team>): void;
}

// ---------------------------------------------------------------------------
// WSConnection
// ---------------------------------------------------------------------------

/** Represents a single WebSocket connection to a team container. */
export interface WSConnection {
  send(msg: Buffer | string): Promise<void>;
  close(): Promise<void>;
  teamID(): string;
}

// ---------------------------------------------------------------------------
// WSHub
// ---------------------------------------------------------------------------

/**
 * Manages WebSocket connections to team containers.
 *
 * The hub exposes getUpgradeHandler() which returns a FastifyUpgradeHandler —
 * a function registered as a Fastify WebSocket route handler.
 * Fastify routes are registered at startup rather than per-request.
 */
export interface WSHub {
  registerConnection(teamID: string, conn: WSConnection): void;
  unregisterConnection(teamID: string): void;
  sendToTeam(teamID: string, msg: Buffer | string): Promise<void>;
  broadcastAll(msg: Buffer | string): Promise<void>;
  generateToken(teamID: string): string;
  getUpgradeHandler(): FastifyUpgradeHandler;
  getConnectedTeams(): string[];
  setOnMessage(handler: (teamID: string, msg: Buffer) => void): void;
  setOnConnect(handler: (teamID: string) => void): void;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// ContainerRuntime
// ---------------------------------------------------------------------------

/**
 * Provides low-level Docker container operations.
 *
 * stopTimeout is in milliseconds.
 */
export interface ContainerRuntime {
  createContainer(config: ContainerConfig): Promise<string>;
  startContainer(containerID: string): Promise<void>;
  stopContainer(containerID: string, timeoutMs: number): Promise<void>;
  removeContainer(containerID: string): Promise<void>;
  inspectContainer(containerID: string): Promise<ContainerInfo>;
  listContainers(): Promise<ContainerInfo[]>;
}

// ---------------------------------------------------------------------------
// ContainerManager
// ---------------------------------------------------------------------------

/**
 * Provides higher-level container lifecycle management.
 *
 * GetStatus and GetContainerID are synchronous (in-memory lookups).
 */
export interface ContainerManager {
  ensureRunning(teamSlug: string): Promise<void>;
  provisionTeam(teamSlug: string, secrets: Record<string, string>): Promise<void>;
  removeTeam(teamSlug: string): Promise<void>;
  restartTeam(teamSlug: string): Promise<void>;
  stopTeam(teamSlug: string): Promise<void>;
  cleanup(): Promise<void>;
  getStatus(teamSlug: string): ContainerState;
  getContainerID(teamSlug: string): string;
}

// ---------------------------------------------------------------------------
// HeartbeatMonitor
// ---------------------------------------------------------------------------

/**
 * Tracks container health via heartbeat messages.
 *
 * GetStatus throws NotFoundError if the teamID has never sent a heartbeat.
 */
export interface HeartbeatMonitor {
  processHeartbeat(teamID: string, agents: AgentHeartbeatStatus[]): void;
  getStatus(teamID: string): HeartbeatStatus;
  getAllStatuses(): Record<string, HeartbeatStatus>;
  setOnUnhealthy(callback: (teamID: string) => void): void;
  startMonitoring(): void;
  stopMonitoring(): void;
  /** Clears all cached heartbeat statuses. Used during startup recovery. */
  clearAll(): void;
}

// ---------------------------------------------------------------------------
// SDKToolHandler
// ---------------------------------------------------------------------------

/**
 * Handles SDK custom tool calls forwarded from containers via WebSocket.
 *
 * All tool args and results are validated as structured JSON at the
 * WebSocket boundary.
 *
 * handleToolCall is the context-free variant (legacy compatibility).
 * handleToolCallWithContext carries team/agent context for authorization.
 */
export interface SDKToolHandler {
  handleToolCall(
    callID: string,
    toolName: string,
    args: Record<string, JsonValue>,
  ): Promise<JsonValue>;
  handleToolCallWithContext(
    teamID: string,
    callID: string,
    toolName: string,
    agentAID: string,
    args: Record<string, JsonValue>,
  ): Promise<JsonValue>;
}

/**
 * Registration side of the tool handler — accepts named handler functions.
 * Separated from SDKToolHandler so registration functions don't depend
 * on the concrete ToolHandler class.
 */
export interface ToolRegistry {
  register(name: string, fn: (args: Record<string, JsonValue>) => Promise<JsonValue>): void;
}

// ---------------------------------------------------------------------------
// ChannelAdapter
// ---------------------------------------------------------------------------

/**
 * Provides a messaging channel interface (Discord, WhatsApp, etc.).
 *
 * OnMessage and OnMetadata register callbacks synchronously.
 * Connect/Disconnect/SendMessage are async I/O operations.
 */
export interface ChannelAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(jid: string, content: string): Promise<void>;
  getJIDPrefix(): string;
  isConnected(): boolean;
  onMessage(callback: (jid: string, content: string) => void): void;
  onMetadata(callback: (jid: string, metadata: Record<string, string>) => void): void;
}

// ---------------------------------------------------------------------------
// MessageRouter
// ---------------------------------------------------------------------------

/**
 * Connects messaging channels to the orchestrator.
 *
 * GetChannels returns a map of prefix → isConnected boolean.
 */
export interface MessageRouter {
  registerChannel(adapter: ChannelAdapter): Promise<void>;
  unregisterChannel(prefix: string): Promise<void>;
  routeInbound(jid: string, content: string): Promise<void>;
  routeOutbound(jid: string, content: string): Promise<void>;
  getChannels(): Record<string, boolean>;
}

// ---------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------

/**
 * Provides publish/subscribe functionality for system events.
 *
 * Subscribe and FilteredSubscribe return a subscription ID string
 * that can be passed to Unsubscribe to remove the handler.
 * Publish is synchronous (fire-and-forget dispatch to subscribers).
 * Close shuts down all workers and drains pending events.
 */
export interface EventBus {
  publish(event: Event): void;
  subscribe(eventType: EventType, handler: (event: Event) => void): string;
  filteredSubscribe(
    eventType: EventType,
    filter: (event: Event) => boolean,
    handler: (event: Event) => void,
  ): string;
  unsubscribe(id: string): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// KeyManager
// ---------------------------------------------------------------------------

/**
 * Handles API key encryption and decryption.
 *
 * Encrypt/Decrypt throw EncryptionLockedError when the key manager is locked.
 * Unlock throws if the master key is incorrect or cannot be applied.
 * IsLocked and Lock are synchronous.
 */
export interface KeyManager {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
  isLocked(): boolean;
  unlock(masterKey: string): Promise<void>;
  lock(): void;
}

// ---------------------------------------------------------------------------
// TaskStore
// ---------------------------------------------------------------------------

/**
 * Provides persistence for tasks.
 * All methods throw on database error.
 */
export interface TaskStore {
  create(task: Task): Promise<void>;
  get(id: string): Promise<Task>;
  update(task: Task): Promise<void>;
  delete(id: string): Promise<void>;
  listByTeam(teamSlug: string): Promise<Task[]>;
  listByStatus(status: TaskStatus): Promise<Task[]>;
  getSubtree(rootID: string): Promise<Task[]>;
  /** Returns all pending tasks whose blocked_by array contains the given blocker ID. */
  getDependents(blockerID: string): Promise<Task[]>;
  /** Returns the blocked_by array for a specific task. */
  getBlockedBy(taskId: string): Promise<string[]>;
  /** Removes completedDependencyId from a task's blocked_by array. Returns true if the task is now fully unblocked. */
  unblockTask(taskId: string, completedDependencyId: string): Promise<boolean>;
  /** Retries a failed task if retry_count < max_retries. Returns true if retry was applied. */
  retryTask(taskId: string): Promise<boolean>;
  /** Validates that adding blockedByIds as dependencies would not create a cycle. Throws on cycle. */
  validateDependencies(taskId: string, blockedByIds: string[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// MessageStore
// ---------------------------------------------------------------------------

/**
 * Provides persistence for chat messages.
 * deleteBefore returns the count of deleted rows.
 */
export interface MessageStore {
  create(msg: Message): Promise<void>;
  getByChat(chatJID: string, since: Date, limit: number): Promise<Message[]>;
  getLatest(chatJID: string, n: number): Promise<Message[]>;
  deleteByChat(chatJID: string): Promise<void>;
  deleteBefore(before: Date): Promise<number>;
}

// ---------------------------------------------------------------------------
// LogStore
// ---------------------------------------------------------------------------

/**
 * Provides persistence for log entries.
 * deleteBefore returns the count of deleted rows.
 * create accepts an array (batch insert).
 */
export interface LogStore {
  create(entries: LogEntry[]): Promise<void>;
  query(opts: LogQueryOpts): Promise<LogEntry[]>;
  deleteBefore(before: Date): Promise<number>;
  count(): Promise<number>;
  getOldest(limit: number): Promise<LogEntry[]>;
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

/**
 * Provides persistence for chat sessions.
 * get throws NotFoundError when the session does not exist.
 */
export interface SessionStore {
  get(chatJID: string): Promise<ChatSession>;
  upsert(session: ChatSession): Promise<void>;
  delete(chatJID: string): Promise<void>;
  listAll(): Promise<ChatSession[]>;
}

// ---------------------------------------------------------------------------
// Transactor
// ---------------------------------------------------------------------------

/**
 * Provides database transaction support.
 *
 * The concrete implementation supplies the real Drizzle transaction object
 * as TxHandle. Callers cast TxHandle to the actual Drizzle transaction type
 * inside the callback.
 *
 * If the callback throws, the transaction is rolled back and the error
 * propagates. If the callback resolves, the transaction is committed.
 */
export interface Transactor {
  withTransaction<T = void>(fn: TransactionCallback<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// EscalationStore
// ---------------------------------------------------------------------------

/**
 * Provides persistence for escalation requests.
 * All methods throw on database error.
 */
export interface EscalationStore {
  create(escalation: Escalation): Promise<void>;
  get(id: string): Promise<Escalation>;
  update(escalation: Escalation): Promise<void>;
  listByAgent(aid: string): Promise<Escalation[]>;
  listByCorrelation(correlationId: string): Promise<Escalation[]>;
  listByStatus(status: EscalationStatus): Promise<Escalation[]>;
  listByTask(taskId: string): Promise<Escalation[]>;
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

/**
 * Provides persistence for agent memory entries.
 * All methods throw on database error.
 */
export interface MemoryStore {
  create(memory: AgentMemory): Promise<void>;
  get(id: string): Promise<AgentMemory>;
  getByAgentAndKey(agentAid: string, key: string): Promise<AgentMemory>;
  update(memory: AgentMemory): Promise<void>;
  delete(id: string): Promise<void>;
  deleteAllByAgent(agentAid: string): Promise<number>;
  listByAgent(agentAid: string): Promise<AgentMemory[]>;
  /** Search memories by keyword, agent, or team with optional limit. */
  search(query: {
    agent_aid?: string;
    team_slug?: string;
    keyword?: string;
    since?: Date;
    limit?: number;
  }): Promise<AgentMemory[]>;
  /** Soft-delete all memories for an agent (sets deleted_at). */
  softDeleteByAgent(agentAid: string): Promise<number>;
  /** Soft-delete all memories for a team (sets deleted_at). */
  softDeleteByTeam(teamSlug: string): Promise<number>;
  /** Hard-delete records soft-deleted more than olderThanDays ago. */
  purgeDeleted(olderThanDays: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// TriggerStore
// ---------------------------------------------------------------------------

/**
 * Provides persistence for automated trigger configurations.
 * All methods throw on database error.
 */
export interface TriggerStore {
  create(trigger: Trigger): Promise<void>;
  get(id: string): Promise<Trigger>;
  update(trigger: Trigger): Promise<void>;
  delete(id: string): Promise<void>;
  listByTeam(teamSlug: string): Promise<Trigger[]>;
  listEnabled(): Promise<Trigger[]>;
  listDue(now: Date): Promise<Trigger[]>;
}

// ---------------------------------------------------------------------------
// TeamProvisioner
// ---------------------------------------------------------------------------

/**
 * Handles team lifecycle operations.
 * Update values are Record<string, JsonValue> — all must be JSON-serializable.
 */
export interface TeamProvisioner {
  createTeam(slug: string, leaderAID: string): Promise<Team>;
  deleteTeam(slug: string): Promise<void>;
  getTeam(slug: string): Promise<Team>;
  listTeams(): Promise<Team[]>;
  updateTeam(slug: string, updates: Record<string, JsonValue>): Promise<Team>;
}

// ---------------------------------------------------------------------------
// TaskCoordinator
// ---------------------------------------------------------------------------

/**
 * Handles task dispatch and result tracking.
 * handleTaskResult receives both result string and errMsg string — exactly
 * one should be non-empty depending on the outcome.
 */
export interface TaskCoordinator {
  dispatchTask(task: Task): Promise<void>;
  handleTaskResult(taskID: string, result: string, errMsg: string): Promise<void>;
  cancelTask(taskID: string, cascade?: boolean): Promise<string[]>;
  getTaskStatus(taskID: string): Promise<Task>;
  createSubtasks(parentID: string, prompts: string[], teamSlug: string): Promise<Task[]>;
}

// ---------------------------------------------------------------------------
// HealthManager
// ---------------------------------------------------------------------------

/**
 * Handles container health monitoring.
 *
 * getHealthStatus throws NotFoundError if the teamSlug is unknown.
 * handleUnhealthy is async (may trigger container restart).
 * getAllStatuses is synchronous (in-memory snapshot).
 */
export interface HealthManager {
  getHealthStatus(teamSlug: string): HeartbeatStatus;
  handleUnhealthy(teamID: string): Promise<void>;
  getAllStatuses(): Record<string, HeartbeatStatus>;
}

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

/**
 * Guards tool invocations against runaway agents by enforcing per-action
 * rate limits. checkRate returns false when the limit is exceeded.
 * recordAction logs a successful invocation for future checks.
 *
 * Actions without a configured limit are allowed unconditionally.
 */
export interface RateLimiter {
  checkRate(agentAID: string, action: string): boolean;
  recordAction(agentAID: string, action: string): void;
  /** Handle provider 429 responses. Applies circuit breaker backoff for the given provider. */
  handleProviderRateLimit(providerName: string, retryAfterMs: number): void;
  /** Check if a provider is currently in backoff. Synchronous. */
  isProviderBackedOff(providerName: string): boolean;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * The composite orchestrator interface combining all sub-interfaces.
 *
 * Extends TeamProvisioner, TaskCoordinator, and HealthManager.
 * start() begins the orchestrator's background loops.
 * stop() gracefully shuts down all background loops.
 */
export interface Orchestrator extends TeamProvisioner, TaskCoordinator, HealthManager {
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// TriggerScheduler
// ---------------------------------------------------------------------------

/**
 * Manages scheduled triggers (cron, webhooks, event listeners).
 *
 * start() initializes all configured triggers on orchestrator startup.
 * stop() tears down all running triggers on shutdown.
 * addTrigger/removeTrigger support runtime modifications.
 * listActive returns current trigger state including next fire time.
 */
export interface TriggerScheduler {
  /** Start all configured triggers. Called on orchestrator startup. */
  start(triggers: Trigger[]): Promise<void>;
  /** Stop all running triggers. Called on orchestrator shutdown. */
  stop(): Promise<void>;
  /** Add a trigger at runtime (e.g., from team creation). */
  addTrigger(trigger: Trigger): Promise<void>;
  /** Remove a trigger at runtime (e.g., from team deletion). */
  removeTrigger(name: string): Promise<void>;
  /** List active triggers with their current state. */
  listActive(): TriggerStatus[];
  /** Look up an active webhook trigger by its webhook_path. Returns undefined if not found or disabled. */
  getWebhookTrigger(path: string): Trigger | undefined;
}

/**
 * Represents the runtime status of an active trigger.
 */
export interface TriggerStatus {
  name: string;
  enabled: boolean;
  last_run_at: Date | null;
  next_run_at: Date | null;
}

// ---------------------------------------------------------------------------
// ProactiveLoop
// ---------------------------------------------------------------------------

/**
 * Manages per-agent proactive check intervals. Orchestrator-driven: reads
 * PROACTIVE.md and dispatches tasks to agents on their configured interval.
 *
 * triggerNow allows manual triggering for debugging.
 * wasSkipped checks if the last scheduled check was skipped (agent busy).
 */
export interface ProactiveLoop {
  /** Start proactive loops for all agents that have proactive intervals. */
  start(agents: Agent[]): Promise<void>;
  /** Stop all proactive loops. */
  stop(): Promise<void>;
  /** Trigger an immediate proactive check for a specific agent. */
  triggerNow(agentAID: string): Promise<void>;
  /** Check if an agent's proactive check was skipped (agent busy). */
  wasSkipped(agentAID: string): boolean;
}

// ---------------------------------------------------------------------------
// WorkspaceLock
// ---------------------------------------------------------------------------

/**
 * Controls concurrent access to workspace directories. Multiple agents in the
 * same container share a filesystem — without locking, concurrent writes could
 * corrupt data. Uses async-mutex internally.
 *
 * acquire() returns a release function. The caller MUST call the release
 * function when done (use try/finally). Throws TimeoutError if the lock
 * cannot be acquired within timeoutMs.
 *
 * isLocked() is synchronous (in-memory check).
 */
export interface WorkspaceLock {
  /** Acquire an exclusive lock on a workspace subtree. Returns a release function. */
  acquire(workspacePath: string, agentAID: string, timeoutMs: number): Promise<() => void>;
  /** Check if a workspace subtree is currently locked. */
  isLocked(workspacePath: string): boolean;
}

// ---------------------------------------------------------------------------
// SkillRegistry
// ---------------------------------------------------------------------------

/**
 * Loads skills from external registries or direct URLs. install() downloads a
 * skill and copies it into the team's workspace. search() queries configured
 * registries for available skills. Skills are Markdown files with YAML
 * frontmatter — no executable code.
 */
export interface SkillRegistry {
  /** Install a skill from a registry or direct URL into a team workspace. Returns the installed skill name. */
  install(params: { name?: string; registryUrl?: string; url?: string }, workspacePath: string): Promise<string>;
  /** Search available skills across configured registries. */
  search(query: string): Promise<SkillInfo[]>;
  /** List configured registry URLs. */
  listRegistries(): string[];
}

// ---------------------------------------------------------------------------
// EscalationRouter
// ---------------------------------------------------------------------------

/**
 * Routes escalation messages through the team hierarchy. The Orchestrator
 * delegates escalation handling to this interface (composition, not inheritance).
 *
 * handleEscalation looks up the org chart to find the supervisor and routes
 * the message up. handleEscalationResponse routes the resolution back down.
 * getEscalationChain returns all escalations in a chain for debugging/logging.
 *
 * Note: Method signatures match the concrete class in orchestrator/escalation-router.ts,
 * which takes sourceTeamID as a separate parameter for routing context.
 */
export interface EscalationRouter {
  /** Route an escalation message up the team hierarchy. */
  handleEscalation(sourceTeamID: string, escalation: EscalationFields): Promise<void>;
  /** Route an escalation response down to the originating team. */
  handleEscalationResponse(response: EscalationResponseFields): Promise<void>;
  /** Retrieve the full escalation chain by correlation ID. */
  getEscalationChain(correlationId: string): Promise<Escalation[]>;
}

/**
 * Fields carried in an escalation message (domain-level abstraction).
 * Maps 1:1 to EscalationMsg in ws/messages.ts, but avoids importing the WS layer.
 */
export interface EscalationFields {
  correlation_id: string;
  task_id: string;
  agent_aid: string;
  source_team: string;
  destination_team: string;
  escalation_level: number;
  reason: string;
  context?: Record<string, JsonValue>;
}

/**
 * Fields carried in an escalation response (domain-level abstraction).
 * Maps 1:1 to EscalationResponseMsg in ws/messages.ts, but avoids importing the WS layer.
 */
export interface EscalationResponseFields {
  correlation_id: string;
  task_id: string;
  agent_aid: string;
  source_team: string;
  destination_team: string;
  resolution: string;
  context?: Record<string, JsonValue>;
}
