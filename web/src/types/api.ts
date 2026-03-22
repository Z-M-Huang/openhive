/**
 * TypeScript types for the OpenHive API.
 */

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  containers: number;
  connectedTeams: string[];
  dbStatus: string;
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export interface TeamSummary {
  tid: string;
  slug: string;
  coordinatorAid: string;
  health: string;
  agentCount: number;
  depth: number;
  parentSlug?: string;
}

export interface TeamDetail {
  tid: string;
  slug: string;
  coordinatorAid: string;
  health: string;
  depth: number;
  containerId: string;
  workspacePath: string;
  agents: AgentSummary[];
  childTeams: string[];
}

export interface AgentSummary {
  aid: string;
  name: string;
  role: string;
  status: string;
}

export interface TeamsListResponse {
  teams: TeamSummary[];
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export interface Task {
  id: string;
  parent_id: string;
  team_slug: string;
  agent_aid: string;
  title: string;
  status: 'pending' | 'active' | 'completed' | 'failed' | 'escalated' | 'cancelled';
  prompt: string;
  result: string;
  error: string;
  blocked_by: string[] | null;
  priority: number;
  retry_count: number;
  max_retries: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface TasksListResponse {
  tasks: Task[];
  total: number;
  offset: number;
  limit: number;
}

export interface TaskEvent {
  id: number;
  log_entry_id: number;
  task_id: string;
  from_status: string;
  to_status: string;
  agent_aid: string;
  reason: string;
  created_at: number;
}

export interface TaskEventsResponse {
  events: TaskEvent[];
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export interface LogEntry {
  id: number;
  level: number;
  event_type: string;
  component: string;
  action: string;
  message: string;
  params: string;
  team_slug: string;
  task_id: string;
  agent_aid: string;
  request_id: string;
  correlation_id: string;
  error: string;
  duration_ms: number;
  created_at: number;
}

export interface LogsResponse {
  entries: LogEntry[];
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export interface WebhookRegistration {
  id: string;
  path: string;
  teamSlug: string;
  createdAt: number;
}

export interface WebhooksResponse {
  webhooks: WebhookRegistration[];
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export interface AgentItem {
  aid: string;
  name: string;
  teamSlug: string;
  role: string;
  status: string;
  leadsTeam: boolean;
  /** Null for agents without a stored model tier (e.g. main assistant). */
  modelTier: string | null;
}

export interface AgentsListResponse {
  agents: AgentItem[];
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

export interface ContainerItem {
  slug: string;
  health: string;
  agentCount: number;
  uptime: number;
  restartCount: number;
  activeTaskCount: number;
  childTeams: string[];
}

export interface ContainersListResponse {
  containers: ContainerItem[];
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

export interface IntegrationItem {
  id: string;
  name: string;
  teamSlug: string;
  config_path: string;
  status: 'proposed' | 'validated' | 'tested' | 'approved' | 'active' | 'failed' | 'rolled_back';
  /** Error details for failed or rolled_back integrations (AC-G8). Empty string when not applicable. */
  error_message: string;
  created_at: number;
}

export interface IntegrationsListResponse {
  integrations: IntegrationItem[];
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface SettingsFieldValue {
  value: unknown;
  source: 'env' | 'yaml' | 'default';
  isSecret?: boolean;
}

export type SettingsResponse = Record<string, unknown>;

export type SettingsUpdatePayload = Record<string, unknown>;

// ---------------------------------------------------------------------------
// WebSocket Events
// ---------------------------------------------------------------------------

export interface WSEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
}