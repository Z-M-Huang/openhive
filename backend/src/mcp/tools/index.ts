/**
 * MCP tools index — stub handler functions for all 22 built-in management tools.
 *
 * Each function represents a tool exposed to agents via the in-process MCP server
 * (`openhive-tools`). Tool calls are forwarded over WebSocket to root's SDKToolHandler,
 * which invokes the corresponding handler function.
 *
 * ## Tool Catalog (10 categories, 22 tools)
 *
 * | Category       | Count | Tools                                                            |
 * |----------------|-------|------------------------------------------------------------------|
 * | Container      | 3     | spawn_container, stop_container, list_containers                 |
 * | Team           | 2     | create_team, create_agent                                        |
 * | Task           | 3     | create_task, dispatch_subtask, update_task_status                |
 * | Messaging      | 1     | send_message                                                     |
 * | Orchestration  | 1     | escalate                                                         |
 * | Memory         | 2     | save_memory, recall_memory                                       |
 * | Integration    | 3     | create_integration, test_integration, activate_integration       |
 * | Secret Mgmt    | 2     | get_credential, set_credential                                   |
 * | Query          | 4     | get_team, get_task, get_health, inspect_topology                 |
 * | Event          | 1     | register_webhook                                                 |
 *
 * ## Timeout Tiers (MCP-Tools.md / Design-Rules CON-09..11)
 *
 * | Tier       | Timeout | Tools                                                                              |
 * |------------|---------|------------------------------------------------------------------------------------|
 * | Query      | 10s     | get_team, get_task, get_health, inspect_topology, recall_memory,                   |
 * |            |         | get_credential, list_containers                                                    |
 * | Mutating   | 60s     | create_team, create_agent, create_task, dispatch_subtask, update_task_status,       |
 * |            |         | send_message, escalate, save_memory, set_credential, register_webhook              |
 * | Blocking   | 5 min   | spawn_container, stop_container, create_integration, test_integration,              |
 * |            |         | activate_integration                                                               |
 *
 * @see {@link file://../../../.wiki/MCP-Tools.md} for the full tool catalog
 * @see {@link file://../../../.wiki/WebSocket-Protocol.md} for wire protocol
 * @module mcp/tools
 */

import type {
  TaskStatus,
  EscalationReason,
  MemoryType,
  ContainerHealth,
  AgentStatus,
  IntegrationStatus,
} from '../../domain/index.js';

// ---------------------------------------------------------------------------
// Tool Parameter Types
// ---------------------------------------------------------------------------

/** Parameters for {@link spawnContainer}. */
export interface SpawnContainerParams {
  /** Team slug identifying the team whose container to spawn. */
  team_slug: string;
  /** Docker image name (optional, defaults to `openhive:latest`). */
  image?: string;
  /** Additional environment variables to inject. */
  env?: Record<string, string>;
}

/** Result of {@link spawnContainer}. */
export interface SpawnContainerResult {
  /** Docker container ID. */
  container_id: string;
  /** Whether the container connected via WebSocket. */
  connected: boolean;
}

/** Parameters for {@link stopContainer}. */
export interface StopContainerParams {
  /** Team slug identifying the team whose container to stop. */
  team_slug: string;
}

/** Result of {@link stopContainer}. */
export interface StopContainerResult {
  /** Confirmation message. */
  message: string;
  /** Final container status. */
  final_status: string;
}

/** Result of {@link listContainers}. */
export interface ListContainersResult {
  /** Array of running containers with health info. */
  containers: Array<{
    container_id: string;
    team_slug: string;
    health: ContainerHealth;
    created_at: number;
  }>;
}

/** Parameters for {@link createTeam}. */
export interface CreateTeamParams {
  /** Team slug (lowercase alphanumeric with hyphens). */
  slug: string;
  /** AID of the team leader (must already exist in parent team). */
  leader_aid: string;
  /** Team purpose/description. */
  purpose: string;
}

/** Result of {@link createTeam}. */
export interface CreateTeamResult {
  /** Created team slug. */
  slug: string;
  /** Leader agent AID. */
  leader_aid: string;
  /** Creation status. */
  status: string;
}

/** Parameters for {@link createAgent}. */
export interface CreateAgentParams {
  /** Agent name (slug format). */
  name: string;
  /** Agent role description. */
  description: string;
  /** Team slug to add the agent to. */
  team_slug: string;
  /** Model tier or specific model name. */
  model?: string;
  /** Skills to assign to the agent. */
  skills?: string[];
}

/** Result of {@link createAgent}. */
export interface CreateAgentResult {
  /** Generated agent AID. */
  aid: string;
}

/** Parameters for {@link createTask}. */
export interface CreateTaskParams {
  /** Target agent AID to execute the task. */
  agent_aid: string;
  /** Task prompt/instructions. */
  prompt: string;
  /** Task priority (lower = higher priority). */
  priority?: number;
  /** Task IDs that must complete before this task can start. */
  blocked_by?: string[];
  /** Maximum retry count on failure. */
  max_retries?: number;
}

/** Result of {@link createTask}. */
export interface CreateTaskResult {
  /** Generated task ID. */
  task_id: string;
}

/** Parameters for {@link dispatchSubtask}. */
export interface DispatchSubtaskParams {
  /** Target agent AID to execute the subtask. */
  agent_aid: string;
  /** Subtask prompt/instructions. */
  prompt: string;
  /** Parent task ID to link this subtask under. */
  parent_task_id: string;
  /** Task IDs that must complete before this subtask can start. */
  blocked_by?: string[];
  /** Subtask priority. */
  priority?: number;
}

/** Result of {@link dispatchSubtask}. */
export interface DispatchSubtaskResult {
  /** Generated subtask ID. */
  task_id: string;
}

/** Parameters for {@link updateTaskStatus}. */
export interface UpdateTaskStatusParams {
  /** Task ID to update. */
  task_id: string;
  /** New task status. */
  status: TaskStatus;
  /** Task result text (on completion). */
  result?: string;
  /** Error message (on failure). */
  error?: string;
}

/** Result of {@link updateTaskStatus}. */
export interface UpdateTaskStatusResult {
  /** Updated task status. */
  status: TaskStatus;
}

/** Parameters for {@link sendMessage}. */
export interface SendMessageParams {
  /** Target agent AID to receive the message. */
  target_aid: string;
  /** Message content. */
  content: string;
  /** Optional correlation ID for tracking message threads. */
  correlation_id?: string;
}

/** Result of {@link sendMessage}. */
export interface SendMessageResult {
  /** Whether the message was delivered. */
  delivered: boolean;
}

/** Parameters for {@link escalate}. */
export interface EscalateParams {
  /** Task ID to escalate. */
  task_id: string;
  /** Reason for escalation. */
  reason: EscalationReason;
  /** Additional context for the supervisor. */
  context: Record<string, unknown>;
}

/** Result of {@link escalate}. */
export interface EscalateResult {
  /** Confirmation message. */
  message: string;
  /** Correlation ID for tracking the escalation chain. */
  correlation_id: string;
}

/** Parameters for {@link saveMemory}. */
export interface SaveMemoryParams {
  /** Memory content text. */
  content: string;
  /** Memory type: curated (persistent) or daily (auto-expires). */
  memory_type: MemoryType;
}

/** Result of {@link saveMemory}. */
export interface SaveMemoryResult {
  /** Generated memory entry ID. */
  memory_id: number;
  /** Save status. */
  status: string;
}

/** Parameters for {@link recallMemory}. */
export interface RecallMemoryParams {
  /** Keyword search query. */
  query: string;
  /** Maximum number of results to return. */
  limit?: number;
  /** Only return memories created after this ISO 8601 timestamp. */
  since?: string;
}

/** Result of {@link recallMemory}. */
export interface RecallMemoryResult {
  /** Matching memory entries. */
  memories: Array<{
    id: number;
    content: string;
    memory_type: MemoryType;
    created_at: number;
  }>;
}

/** Parameters for {@link createIntegration}. */
export interface CreateIntegrationParams {
  /** Integration name. */
  name: string;
  /** Integration type. */
  type: string;
  /** Integration configuration. */
  config: Record<string, unknown>;
}

/** Result of {@link createIntegration}. */
export interface CreateIntegrationResult {
  /** Generated integration ID. */
  integration_id: string;
  /** Path to the integration config file. */
  config_path: string;
}

/** Parameters for {@link testIntegration}. */
export interface TestIntegrationParams {
  /** Integration ID to test. */
  integration_id: string;
}

/** Result of {@link testIntegration}. */
export interface TestIntegrationResult {
  /** Whether the test passed. */
  success: boolean;
  /** Errors encountered during testing. */
  errors: string[];
}

/** Parameters for {@link activateIntegration}. */
export interface ActivateIntegrationParams {
  /** Integration ID to activate. */
  integration_id: string;
}

/** Result of {@link activateIntegration}. */
export interface ActivateIntegrationResult {
  /** Activation status. */
  status: IntegrationStatus;
}

/** Parameters for {@link getCredential}. */
export interface GetCredentialParams {
  /** Credential key name. */
  key: string;
}

/** Result of {@link getCredential}. */
export interface GetCredentialResult {
  /** Decrypted credential value. */
  value: string;
}

/** Parameters for {@link setCredential}. */
export interface SetCredentialParams {
  /** Credential key name. */
  key: string;
  /** Credential value (will be encrypted at rest with AES-256-GCM). */
  value: string;
  /** Credential scope (defaults to calling agent's team). */
  scope?: string;
}

/** Result of {@link setCredential}. */
export interface SetCredentialResult {
  /** Confirmation message. */
  message: string;
}

/** Parameters for {@link getTeam}. */
export interface GetTeamParams {
  /** Team slug to query. */
  slug: string;
}

/** Result of {@link getTeam}. */
export interface GetTeamResult {
  /** Team slug. */
  slug: string;
  /** Team TID. */
  tid: string;
  /** Leader agent AID. */
  leader_aid: string;
  /** List of agent AIDs in this team. */
  agent_aids: string[];
  /** Team health status. */
  health: string;
}

/** Parameters for {@link getTask}. */
export interface GetTaskParams {
  /** Task ID to query. */
  task_id: string;
  /** Optional status filter. */
  status?: TaskStatus;
}

/** Result of {@link getTask}. */
export interface GetTaskResult {
  /** Task ID. */
  task_id: string;
  /** Current task status. */
  status: TaskStatus;
  /** Assigned agent AID. */
  agent_aid: string;
  /** Task prompt. */
  prompt: string;
  /** Task result (if completed). */
  result: string;
  /** Error message (if failed). */
  error: string;
  /** Creation timestamp. */
  created_at: number;
  /** Completion timestamp. */
  completed_at: number | null;
}

/** Parameters for {@link getHealth}. */
export interface GetHealthParams {
  /** Optional scope: team slug or agent AID. If omitted, returns system-wide health. */
  scope?: string;
}

/** Result of {@link getHealth}. */
export interface GetHealthResult {
  /** Health report entries. */
  entries: Array<{
    id: string;
    type: 'agent' | 'container';
    status: AgentStatus | ContainerHealth;
    detail: string;
  }>;
}

/** Parameters for {@link inspectTopology}. */
export interface InspectTopologyParams {
  /** Maximum depth to traverse in the org chart tree. */
  depth?: number;
}

/** Result of {@link inspectTopology}. */
export interface InspectTopologyResult {
  /** Org chart tree nodes. */
  tree: Array<{
    tid: string;
    slug: string;
    leader_aid: string;
    health: ContainerHealth;
    agents: Array<{
      aid: string;
      name: string;
      status: AgentStatus;
    }>;
    children: InspectTopologyResult['tree'];
  }>;
}

/** Parameters for {@link registerWebhook}. */
export interface RegisterWebhookParams {
  /** URL path suffix for the webhook endpoint (creates `/api/v1/hooks/<path>`). */
  path: string;
  /** Target team slug to route webhook events to. */
  target_team: string;
  /** Optional event type filter. */
  event_type?: string;
}

/** Result of {@link registerWebhook}. */
export interface RegisterWebhookResult {
  /** Full webhook URL. */
  webhook_url: string;
  /** Registration ID for managing this webhook. */
  registration_id: string;
}

// ---------------------------------------------------------------------------
// Container Tools (3)
// ---------------------------------------------------------------------------

/**
 * Spawn a Docker container for a team.
 *
 * Creates and starts a new container, waits until it connects via WebSocket.
 * Blocking operation (5 min timeout tier).
 *
 * @param params - Container spawn parameters
 * @returns Container ID and connection status
 * @throws Error - Not yet implemented
 */
export async function spawnContainer(params: SpawnContainerParams): Promise<SpawnContainerResult> {
  void params;
  throw new Error('Not implemented');
}

/**
 * Stop a running team container gracefully.
 *
 * Sends SIGTERM, waits for graceful shutdown, then SIGKILL if unresponsive.
 * Blocking operation (5 min timeout tier).
 *
 * @param params - Container stop parameters
 * @returns Confirmation and final status
 * @throws Error - Not yet implemented
 */
export async function stopContainer(params: StopContainerParams): Promise<StopContainerResult> {
  void params;
  throw new Error('Not implemented');
}

/**
 * List all running containers with their team associations and health status.
 *
 * Query operation (10s timeout tier).
 *
 * @returns Container list with health info
 * @throws Error - Not yet implemented
 */
export async function listContainers(): Promise<ListContainersResult> {
  throw new Error('Not implemented');
}

// ---------------------------------------------------------------------------
// Team Tools (2)
// ---------------------------------------------------------------------------

/**
 * Create a new team with workspace scaffolding.
 *
 * Provisions the workspace directory, writes team.yaml, and updates the org chart.
 * Two-step creation pattern: `create_agent` first (lead), then `create_team`.
 * Mutating operation (60s timeout tier).
 *
 * @param params - Team creation parameters
 * @returns Team slug, leader AID, and status
 * @throws Error - Not yet implemented
 */
export async function createTeam(params: CreateTeamParams): Promise<CreateTeamResult> {
  void params;
  throw new Error('Not implemented');
}

/**
 * Create a new agent within an existing team.
 *
 * Writes agent definition file and registers in the org chart.
 * Mutating operation (60s timeout tier).
 *
 * @param params - Agent creation parameters
 * @returns Generated agent AID
 * @throws Error - Not yet implemented
 */
export async function createAgent(params: CreateAgentParams): Promise<CreateAgentResult> {
  void params;
  throw new Error('Not implemented');
}

// ---------------------------------------------------------------------------
// Task Tools (3)
// ---------------------------------------------------------------------------

/**
 * Create a top-level task and assign it to an agent.
 *
 * Mutating operation (60s timeout tier).
 *
 * @param params - Task creation parameters
 * @returns Generated task ID
 * @throws Error - Not yet implemented
 */
export async function createTask(params: CreateTaskParams): Promise<CreateTaskResult> {
  void params;
  throw new Error('Not implemented');
}

/**
 * Create a subtask linked to a parent task.
 *
 * Inherits the parent's escalation chain. Mutating operation (60s timeout tier).
 *
 * @param params - Subtask dispatch parameters
 * @returns Generated subtask ID
 * @throws Error - Not yet implemented
 */
export async function dispatchSubtask(params: DispatchSubtaskParams): Promise<DispatchSubtaskResult> {
  void params;
  throw new Error('Not implemented');
}

/**
 * Update a task's status (completed, failed, cancelled).
 *
 * Includes result or error payload. Mutating operation (60s timeout tier).
 *
 * @param params - Task status update parameters
 * @returns Updated task status
 * @throws Error - Not yet implemented
 */
export async function updateTaskStatus(params: UpdateTaskStatusParams): Promise<UpdateTaskStatusResult> {
  void params;
  throw new Error('Not implemented');
}

// ---------------------------------------------------------------------------
// Messaging Tool (1)
// ---------------------------------------------------------------------------

/**
 * Send a message to another agent or team lead.
 *
 * Routed through the WebSocket hub. Mutating operation (60s timeout tier).
 *
 * @param params - Message parameters
 * @returns Delivery confirmation
 * @throws Error - Not yet implemented
 */
export async function sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
  void params;
  throw new Error('Not implemented');
}

// ---------------------------------------------------------------------------
// Orchestration Tool (1)
// ---------------------------------------------------------------------------

/**
 * Escalate a task to the agent's supervisor.
 *
 * Pauses the current task and routes the escalation up the chain of command.
 * Mutating operation (60s timeout tier).
 *
 * @param params - Escalation parameters
 * @returns Escalation confirmation and correlation ID
 * @throws Error - Not yet implemented
 */
export async function escalate(params: EscalateParams): Promise<EscalateResult> {
  void params;
  throw new Error('Not implemented');
}

// ---------------------------------------------------------------------------
// Memory Tools (2)
// ---------------------------------------------------------------------------

/**
 * Save a memory entry for the calling agent.
 *
 * Writes to both workspace file and SQLite index.
 * Mutating operation (60s timeout tier).
 *
 * @param params - Memory save parameters
 * @returns Memory ID and status
 * @throws Error - Not yet implemented
 */
export async function saveMemory(params: SaveMemoryParams): Promise<SaveMemoryResult> {
  void params;
  throw new Error('Not implemented');
}

/**
 * Search agent memories by keyword query.
 *
 * Searches workspace files and SQLite index.
 * Query operation (10s timeout tier).
 *
 * @param params - Memory recall parameters
 * @returns Matching memory entries
 * @throws Error - Not yet implemented
 */
export async function recallMemory(params: RecallMemoryParams): Promise<RecallMemoryResult> {
  void params;
  throw new Error('Not implemented');
}

// ---------------------------------------------------------------------------
// Integration Tools (3)
// ---------------------------------------------------------------------------

/**
 * Create a new integration configuration.
 *
 * Scaffolds the integration directory with config template.
 * Blocking operation (5 min timeout tier).
 *
 * @param params - Integration creation parameters
 * @returns Integration ID and config path
 * @throws Error - Not yet implemented
 */
export async function createIntegration(params: CreateIntegrationParams): Promise<CreateIntegrationResult> {
  void params;
  throw new Error('Not implemented');
}

/**
 * Test an integration configuration against its target service.
 *
 * Validates credentials and connectivity.
 * Blocking operation (5 min timeout tier).
 *
 * @param params - Integration test parameters
 * @returns Test result and errors
 * @throws Error - Not yet implemented
 */
export async function testIntegration(params: TestIntegrationParams): Promise<TestIntegrationResult> {
  void params;
  throw new Error('Not implemented');
}

/**
 * Activate a tested integration, making it available to agents.
 *
 * Blocking operation (5 min timeout tier).
 *
 * @param params - Integration activation parameters
 * @returns Activation status
 * @throws Error - Not yet implemented
 */
export async function activateIntegration(params: ActivateIntegrationParams): Promise<ActivateIntegrationResult> {
  void params;
  throw new Error('Not implemented');
}

// ---------------------------------------------------------------------------
// Secret Management Tools (2)
// ---------------------------------------------------------------------------

/**
 * Retrieve a credential by key.
 *
 * Scoped to the calling agent's team. Decrypted at read time (AES-256-GCM).
 * Query operation (10s timeout tier).
 *
 * @param params - Credential retrieval parameters
 * @returns Decrypted credential value
 * @throws Error - Not yet implemented
 */
export async function getCredential(params: GetCredentialParams): Promise<GetCredentialResult> {
  void params;
  throw new Error('Not implemented');
}

/**
 * Store or update a credential.
 *
 * Encrypted at rest with AES-256-GCM. Scoped to the calling agent's team.
 * Mutating operation (60s timeout tier).
 *
 * @param params - Credential storage parameters
 * @returns Confirmation
 * @throws Error - Not yet implemented
 */
export async function setCredential(params: SetCredentialParams): Promise<SetCredentialResult> {
  void params;
  throw new Error('Not implemented');
}

// ---------------------------------------------------------------------------
// Query Tools (4)
// ---------------------------------------------------------------------------

/**
 * Get configuration and status for a specific team.
 *
 * Query operation (10s timeout tier).
 *
 * @param params - Team query parameters
 * @returns Team config, agent list, and status
 * @throws Error - Not yet implemented
 */
export async function getTeam(params: GetTeamParams): Promise<GetTeamResult> {
  void params;
  throw new Error('Not implemented');
}

/**
 * Get the current status, result, and metadata for a task.
 *
 * Supports filtering by status. Query operation (10s timeout tier).
 *
 * @param params - Task query parameters
 * @returns Task detail object
 * @throws Error - Not yet implemented
 */
export async function getTask(params: GetTaskParams): Promise<GetTaskResult> {
  void params;
  throw new Error('Not implemented');
}

/**
 * Get health status for agents and containers.
 *
 * Includes heartbeat recency, task load, and memory usage.
 * Query operation (10s timeout tier).
 *
 * @param params - Health query parameters
 * @returns Health report
 * @throws Error - Not yet implemented
 */
export async function getHealth(params: GetHealthParams): Promise<GetHealthResult> {
  void params;
  throw new Error('Not implemented');
}

/**
 * Get the full org chart tree.
 *
 * Returns teams, agents, parent-child relationships, and container mappings.
 * Query operation (10s timeout tier).
 *
 * @param params - Topology inspection parameters
 * @returns Topology tree
 * @throws Error - Not yet implemented
 */
export async function inspectTopology(params: InspectTopologyParams): Promise<InspectTopologyResult> {
  void params;
  throw new Error('Not implemented');
}

// ---------------------------------------------------------------------------
// Event Tool (1)
// ---------------------------------------------------------------------------

/**
 * Register a webhook endpoint for external event triggers.
 *
 * Creates a route at `/api/v1/hooks/<path>`. Mutating operation (60s timeout tier).
 *
 * @param params - Webhook registration parameters
 * @returns Webhook URL and registration ID
 * @throws Error - Not yet implemented
 */
export async function registerWebhook(params: RegisterWebhookParams): Promise<RegisterWebhookResult> {
  void params;
  throw new Error('Not implemented');
}

// ---------------------------------------------------------------------------
// Tool Name Lookup
// ---------------------------------------------------------------------------

/** Generic tool handler signature matching the MCPRegistry handler type. */
export type ToolHandler = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * Wraps a typed tool handler into the generic {@link ToolHandler} signature.
 * The wrapper delegates to the typed function, which will validate params
 * at runtime once implemented. During the stub phase, all handlers throw.
 */
function wrap<P, R>(fn: (params: P) => Promise<R>): ToolHandler {
  return (params: Record<string, unknown>) => fn(params as P) as Promise<Record<string, unknown>>;
}

/**
 * Maps tool names (as used on the wire protocol) to their handler functions.
 * Used by the SDKToolHandler for routing incoming tool calls.
 */
export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  spawn_container: wrap(spawnContainer),
  stop_container: wrap(stopContainer),
  list_containers: wrap(() => listContainers()),
  create_team: wrap(createTeam),
  create_agent: wrap(createAgent),
  create_task: wrap(createTask),
  dispatch_subtask: wrap(dispatchSubtask),
  update_task_status: wrap(updateTaskStatus),
  send_message: wrap(sendMessage),
  escalate: wrap(escalate),
  save_memory: wrap(saveMemory),
  recall_memory: wrap(recallMemory),
  create_integration: wrap(createIntegration),
  test_integration: wrap(testIntegration),
  activate_integration: wrap(activateIntegration),
  get_credential: wrap(getCredential),
  set_credential: wrap(setCredential),
  get_team: wrap(getTeam),
  get_task: wrap(getTask),
  get_health: wrap(getHealth),
  inspect_topology: wrap(inspectTopology),
  register_webhook: wrap(registerWebhook),
};

/** All tool names as a readonly array, matching the wire protocol names. */
export const TOOL_NAMES = Object.keys(TOOL_HANDLERS) as ReadonlyArray<string>;

/** Total number of built-in tools. */
export const TOOL_COUNT = 22;
