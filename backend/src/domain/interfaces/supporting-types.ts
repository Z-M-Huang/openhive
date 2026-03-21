/**
 * Supporting types used by service interfaces.
 *
 * @module domain/interfaces/supporting-types
 */

import type {
  ChannelType,
  ContainerHealth,
  AgentStatus,
  AgentRole,
  ProviderType,
  ModelTier,
} from '../enums.js';

// ---------------------------------------------------------------------------
// Supporting Types (used by interfaces below)
// ---------------------------------------------------------------------------

/** Options for querying log entries. */
export interface LogQueryOpts {
  level?: import('../enums.js').LogLevel;
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
  role: AgentRole;
  status: AgentStatus;
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
  leaderAid?: string;
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
  aid?: string;
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
  health: ContainerHealth;
  agents: OrgChartAgent[];
  children: TopologyNode[];
}
