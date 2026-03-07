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
  cancelTask(taskID: string): Promise<void>;
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
// GoOrchestrator
// ---------------------------------------------------------------------------

/**
 * The composite orchestrator interface combining all sub-interfaces.
 *
 * Extends TeamProvisioner, TaskCoordinator, and HealthManager.
 * start() begins the orchestrator's background loops.
 * stop() gracefully shuts down all background loops.
 */
export interface GoOrchestrator extends TeamProvisioner, TaskCoordinator, HealthManager {
  start(): Promise<void>;
  stop(): Promise<void>;
}
