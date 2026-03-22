/**
 * Infrastructure interfaces for containers, WebSocket, event bus, and org chart.
 *
 * @module domain/interfaces/infrastructure
 */

import type {
  ContainerHealth,
  AgentStatus,
} from '../enums.js';

import type { Team } from '../domain.js';

import type {
  ContainerConfig,
  ContainerInfo,
  AgentDefinition,
  WSMessage,
  BusEvent,
  EventHandler,
  EventFilter,
  OrgChartAgent,
  OrgChartTeam,
  TopologyNode,
} from './supporting-types.js';

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
  spawnTeamContainer(teamSlug: string, workspacePath?: string): Promise<ContainerInfo>;
  stopTeamContainer(teamSlug: string, reason: string): Promise<void>;
  restartTeamContainer(teamSlug: string, reason: string): Promise<ContainerInfo>;
  getContainerByTeam(teamSlug: string): Promise<ContainerInfo | undefined>;
  listRunningContainers(): Promise<ContainerInfo[]>;
  cleanupStoppedContainers(): Promise<number>;
}

/** Workspace scaffolding and team provisioning. */
export interface ContainerProvisioner {
  scaffoldWorkspace(parentPath: string, teamSlug: string, agents?: AgentDefinition[], purpose?: string): Promise<string>;
  writeTeamConfig(workspacePath: string, team: Team): Promise<void>;
  writeAgentDefinition(workspacePath: string, agent: AgentDefinition): Promise<void>;
  addAgentToTeamYaml(workspacePath: string, agent: {
    aid: string; name: string; description: string;
    model_tier?: string; role?: string; tools?: string[]; provider?: string;
  }): Promise<void>;
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
  /** Returns the best dispatch target for a team: prefers idle agents, sorts by AID for stability. Throws NotFoundError if team has no agents. */
  getDispatchTarget(teamSlug: string): OrgChartAgent;

  /** Update a team's TID (e.g., after container restart). Re-keys all TID-based lookups. */
  updateTeamTid(slug: string, newTid: string): void;

  isAuthorized(sourceAid: string, targetAid: string): boolean;
  getTopology(depth?: number): TopologyNode[];
}
