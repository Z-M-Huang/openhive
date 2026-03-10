/**
 * SDK custom tool definitions and timeout categorization.
 *
 * Tools are registered with the Claude Agent SDK for internal management
 * operations. Tool calls are intercepted by the MCP bridge and forwarded
 * via WebSocket to the backend.
 */

/** JSON Schema property definition for tool parameters */
export interface JSONSchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  items?: { type: string };
}

/** JSON Schema object definition for tool parameters */
export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

/** Timeout categories for tool operations */
export const MUTATING_TIMEOUT_MS = 60_000;
export const QUERY_TIMEOUT_MS = 10_000;
export const LONG_RUNNING_TIMEOUT_MS = 300_000;

/** Tools that block until a long-running operation completes (5m timeout) */
const LONG_RUNNING_TOOLS: ReadonlySet<string> = new Set([
  'dispatch_task_and_wait',
]);

/** Tools that perform mutating/container operations (60s timeout) */
const MUTATING_TOOLS = new Set([
  'create_team',
  'create_agent',
  'delete_team',
  'delete_agent',
  'update_team',
  'dispatch_task',
  'dispatch_subtask',
  'update_config',
  'enable_channel',
  'disable_channel',
  'escalate',
  'cancel_task',
  'create_skill',
  'save_memory',
]);

/** Tools that perform read/query operations (10s timeout) */
const QUERY_TOOLS = new Set([
  'get_config',
  'list_channels',
  'get_system_status',
  'list_teams',
  'get_team',
  'get_member_status',
  'consolidate_results',
  'get_task_status',
  'list_tasks',
  'load_skill',
  'recall_memory',
]);

/**
 * Returns the timeout in milliseconds for a given tool name.
 * Mutating operations get 60s, query operations get 10s.
 */
export function getToolTimeout(toolName: string): number {
  if (LONG_RUNNING_TOOLS.has(toolName)) {
    return LONG_RUNNING_TIMEOUT_MS;
  }
  if (MUTATING_TOOLS.has(toolName)) {
    return MUTATING_TIMEOUT_MS;
  }
  if (QUERY_TOOLS.has(toolName)) {
    return QUERY_TIMEOUT_MS;
  }
  // Default to mutating timeout for unknown tools (safer)
  return MUTATING_TIMEOUT_MS;
}

/**
 * Checks if a tool is a mutating operation.
 */
export function isMutatingTool(toolName: string): boolean {
  return MUTATING_TOOLS.has(toolName);
}

/** SDK custom tool schemas */
export const SDK_TOOLS: ToolDefinition[] = [
  // --- Admin tools ---
  {
    name: 'get_config',
    description: 'Get the current system configuration',
    parameters: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'Config section to retrieve (system, assistant, channels)' },
      },
    },
  },
  {
    name: 'update_config',
    description: 'Update a configuration value',
    parameters: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'Config section' },
        field: { type: 'string', description: 'Field name' },
        value: { description: 'New value' },
      },
      required: ['section', 'field', 'value'],
    },
  },
  {
    name: 'get_system_status',
    description: 'Get the current system status including connected teams and agents',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_channels',
    description: 'List all messaging channels and their status',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'enable_channel',
    description: 'Enable a messaging channel',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel name (discord, whatsapp)' },
      },
      required: ['channel'],
    },
  },
  {
    name: 'disable_channel',
    description: 'Disable a messaging channel',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel name (discord, whatsapp)' },
      },
      required: ['channel'],
    },
  },

  // --- Team management tools ---
  {
    name: 'create_team',
    description: 'Create a new team (step 2 after create_agent). The leader agent must already exist. Example: slug="weather", leader_aid="aid-weatherbot-abc12345".',
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Team slug (lowercase, hyphens only, e.g. "weather-team")' },
        leader_aid: { type: 'string', description: 'AID of the team leader returned by create_agent (e.g. "aid-weatherbot-abc12345")' },
        parent_slug: { type: 'string', description: 'Parent team slug for hierarchy (optional)' },
      },
      required: ['slug', 'leader_aid'],
    },
  },
  {
    name: 'create_agent',
    description: 'Create a new agent in a team. All three required parameters (name, description, team_slug) MUST be provided. Example: name="WeatherBot", description="Fetches weather data for any location", team_slug="master".',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent display name (e.g. "WeatherBot")' },
        description: { type: 'string', description: 'A 1-2 sentence summary of the agent role (e.g. "Fetches current weather conditions for any location worldwide"). MUST be non-empty.' },
        team_slug: { type: 'string', description: 'Team slug to add agent to. Use "master" for top-level agents.' },
        provider: { type: 'string', description: 'Provider preset name (optional, omit to use default)' },
        model_tier: { type: 'string', description: 'Model tier: haiku, sonnet, or opus (optional, defaults to sonnet)' },
      },
      required: ['name', 'description', 'team_slug'],
    },
  },
  {
    name: 'delete_team',
    description: 'Delete a team and its configuration (cascades to team directory removal)',
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Team slug to delete' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'delete_agent',
    description: 'Delete an agent from a team (fails if agent leads a team)',
    parameters: {
      type: 'object',
      properties: {
        aid: { type: 'string', description: 'Agent AID to delete' },
        team_slug: { type: 'string', description: 'Team slug where agent resides (use "master" for top-level)' },
      },
      required: ['aid', 'team_slug'],
    },
  },
  {
    name: 'list_teams',
    description: 'List all teams in the org chart',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_team',
    description: 'Get configuration for a specific team',
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Team slug' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'update_team',
    description: 'Update a team configuration field (whitelisted fields only: env_vars, container_config)',
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Team slug' },
        field: { type: 'string', description: 'Field name to update (env_vars, container_config)' },
        value: { description: 'New value for the field' },
      },
      required: ['slug', 'field', 'value'],
    },
  },

  // --- Task management tools ---
  {
    name: 'dispatch_task',
    description: 'Dispatch a task to an agent (top-level task creation)',
    parameters: {
      type: 'object',
      properties: {
        agent_aid: { type: 'string', description: 'Target agent AID' },
        prompt: { type: 'string', description: 'Task prompt' },
        task_id: { type: 'string', description: 'Task identifier (optional, auto-generated if omitted)' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Task IDs that must complete before this task can start (optional, default [])' },
        priority: { type: 'number', description: 'Task priority — higher values are more urgent (optional, default 0)' },
        max_retries: { type: 'number', description: 'Maximum retry attempts on failure (optional, default 0 = no retry)' },
      },
      required: ['agent_aid', 'prompt'],
    },
  },
  {
    name: 'dispatch_task_and_wait',
    description: 'Dispatch a task to an agent and block until it completes, fails, or times out. Preferred over dispatch_task for synchronous workflows.',
    parameters: {
      type: 'object',
      properties: {
        agent_aid: { type: 'string', description: 'Target agent AID' },
        prompt: { type: 'string', description: 'Task prompt' },
        timeout_seconds: { type: 'number', description: 'Maximum seconds to wait (default 300, max 600)' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Task IDs that must complete before this task can start (optional, default [])' },
        priority: { type: 'number', description: 'Task priority — higher values are more urgent (optional, default 0)' },
        max_retries: { type: 'number', description: 'Maximum retry attempts on failure (optional, default 0 = no retry)' },
      },
      required: ['agent_aid', 'prompt'],
    },
  },
  {
    name: 'dispatch_subtask',
    description: 'Dispatch a subtask to an agent, linked to a parent task',
    parameters: {
      type: 'object',
      properties: {
        agent_aid: { type: 'string', description: 'Target agent AID' },
        prompt: { type: 'string', description: 'Subtask prompt' },
        parent_task_id: { type: 'string', description: 'Parent task ID to link this subtask to' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Task IDs that must complete before this subtask can start (optional, default [])' },
        priority: { type: 'number', description: 'Task priority — higher values are more urgent (optional, default 0)' },
        max_retries: { type: 'number', description: 'Maximum retry attempts on failure (optional, default 0 = no retry)' },
      },
      required: ['agent_aid', 'prompt'],
    },
  },
  {
    name: 'get_task_status',
    description: 'Get the current status of a task',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to query' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'cancel_task',
    description: 'Cancel a pending or running task',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to cancel' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List tasks filtered by team or status',
    parameters: {
      type: 'object',
      properties: {
        team_slug: { type: 'string', description: 'Filter tasks by team slug (optional)' },
        status: { type: 'string', description: 'Filter tasks by status: pending, running, completed, failed, cancelled (optional)' },
        limit: { type: 'number', description: 'Maximum number of tasks to return (optional)' },
      },
    },
  },

  // --- Status and coordination tools ---
  {
    name: 'get_member_status',
    description: 'Get the status of an agent or team member',
    parameters: {
      type: 'object',
      properties: {
        agent_aid: { type: 'string', description: 'Agent AID to query (mutually exclusive with team_slug)' },
        team_slug: { type: 'string', description: 'Team slug to query all members (mutually exclusive with agent_aid)' },
      },
    },
  },
  {
    name: 'escalate',
    description: 'Escalate a task to a supervisor when the current agent cannot complete it',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to escalate' },
        reason: { type: 'string', description: 'Reason for escalation' },
        context: { type: 'string', description: 'Additional context for the supervisor (optional)' },
      },
      required: ['task_id', 'reason'],
    },
  },
  {
    name: 'consolidate_results',
    description: 'Retrieve results for multiple tasks by ID',
    parameters: {
      type: 'object',
      properties: {
        task_ids: { type: 'array', items: { type: 'string' }, description: 'Array of task IDs to retrieve results for' },
      },
      required: ['task_ids'],
    },
  },

  // --- Skill management tools ---
  {
    name: 'create_skill',
    description: 'Create a new skill definition file in the workspace for a team or the root assistant',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name (lowercase, hyphens allowed, no path separators)' },
        body: { type: 'string', description: 'Skill body / system prompt addition written to SKILL.md' },
        team_slug: { type: 'string', description: 'Team slug whose workspace to write the skill into (use "master" for root assistant)' },
        description: { type: 'string', description: 'Human-readable description of what the skill does (optional)' },
        argument_hint: { type: 'string', description: 'Hint text for the argument the skill expects (optional)' },
        allowed_tools: { type: 'array', description: 'List of tool names the skill is allowed to invoke (optional)' },
      },
      required: ['name', 'body', 'team_slug'],
    },
  },
  {
    name: 'load_skill',
    description: 'Load a skill definition by name, returning its description and body content',
    parameters: {
      type: 'object',
      properties: {
        skill_name: { type: 'string', description: 'Name of the skill to load' },
        team_slug: { type: 'string', description: 'Team slug whose workspace contains the skill (use "master" for root assistant)' },
      },
      required: ['skill_name', 'team_slug'],
    },
  },

  // --- Memory tools ---
  {
    name: 'save_memory',
    description: 'Save a memory entry for the calling agent. If a memory with the same key already exists, it is updated (upsert).',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key (e.g. "user_preferences", "learned_patterns")' },
        content: { type: 'string', description: 'Memory content to save' },
        memory_type: { type: 'string', description: 'Memory type: "curated" or "daily" (default "curated")', enum: ['curated', 'daily'] },
      },
      required: ['key', 'content'],
    },
  },
  {
    name: 'recall_memory',
    description: 'Search the agent\'s memories by keyword query. Returns matching memory entries sorted by most recently updated.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (keyword-based substring match)' },
        limit: { type: 'number', description: 'Maximum number of results to return (default 100)' },
      },
      required: ['query'],
    },
  },
];
