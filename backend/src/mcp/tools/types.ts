/**
 * Type definitions for MCP tool handlers.
 *
 * @module mcp/tools/types
 */

import type {
  OrgChart,
  TaskStore,
  MessageStore,
  LogStore,
  MemoryStore,
  IntegrationStore,
  CredentialStore,
  ToolCallStore,
  ContainerManager,
  ContainerProvisioner,
  KeyManager,
  WSHub,
  EventBus,
  TriggerScheduler,
  MCPRegistry,
  HealthMonitor,
  Logger,
  WorkspaceLock,
  EmbeddingService,
  ResolvedProvider,
} from '../../domain/index.js';

/** Pending memory write for retry on reconnection (AC-L6-07). */
export interface PendingMemoryWrite {
  id: number;
  agent_aid: string;
  team_slug: string;
  content: string;
  memory_type: 'curated' | 'daily';
  created_at: number;
  deleted_at: number | null;
  retries: number;
  lastError: string;
}

/** Dependency bag injected into every tool handler via the factory. */
export interface ToolContext {
  orgChart: OrgChart;
  taskStore: TaskStore;
  messageStore: MessageStore;
  logStore: LogStore;
  memoryStore: MemoryStore;
  integrationStore: IntegrationStore;
  credentialStore: CredentialStore;
  toolCallStore: ToolCallStore;
  containerManager: ContainerManager;
  provisioner: ContainerProvisioner;
  keyManager: KeyManager;
  wsHub: WSHub;
  eventBus: EventBus;
  triggerScheduler: TriggerScheduler;
  mcpRegistry: MCPRegistry;
  healthMonitor: HealthMonitor;
  logger: Logger;
  /** Memory file writer for dual-write (AC-L6-06). Writes to workspace memory file. */
  memoryFileWriter?: (agentAid: string, teamSlug: string, entry: {
    id: number;
    content: string;
    memory_type: 'curated' | 'daily';
    created_at: number;
  }) => Promise<void>;
  /** Pending memory writes queue for retry on reconnection (AC-L6-07). */
  pendingMemoryWrites?: PendingMemoryWrite[];
  /** Embedding service for vector search. Optional — BM25-only when absent. */
  embeddingService?: EmbeddingService;
  /**
   * Advisory workspace-level lock for concurrent workspace operations (AC-D2, AC-D3).
   * Optional — only wired in root mode. Handlers that modify the workspace
   * (create_team, create_agent, stop_container) acquire/release this lock.
   */
  workspaceLock?: WorkspaceLock;
  /** Configured skill registry URLs for search_skill/install_skill tools. */
  skillRegistries?: string[];
  /** Provider resolver for agent_added WS messages. Optional — only wired in root mode. */
  resolveProviderPreset?: (presetName: string) => ResolvedProvider;
  /** Frozen configurable limits (CON-01, CON-02, CON-03). Object.freeze() applied at construction site (orchestrator.ts). */
  limits: Readonly<{
    max_depth: number;
    max_teams: number;
    max_agents_per_team: number;
    max_concurrent_tasks: number;
  }>;
}

/** Generic tool handler signature. */
export type ToolHandler = (
  args: Record<string, unknown>,
  agentAid: string,
  teamSlug: string,
) => Promise<Record<string, unknown>>;

/** Result from SDKToolHandler.handle(). */
export interface SDKToolHandlerResult {
  success: boolean;
  result?: Record<string, unknown>;
  error_code?: string;
  error_message?: string;
}
