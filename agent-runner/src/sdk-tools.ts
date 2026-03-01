/**
 * SDK custom tool definitions and timeout categorization.
 *
 * Tools are registered with the Claude Agent SDK for internal management
 * operations. Tool calls are intercepted by the MCP bridge and forwarded
 * via WebSocket to the Go backend.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Timeout categories for tool operations */
export const MUTATING_TIMEOUT_MS = 60_000;
export const QUERY_TIMEOUT_MS = 10_000;

/** Tools that perform mutating/container operations (60s timeout) */
const MUTATING_TOOLS = new Set([
  'create_team',
  'dispatch_task',
  'update_config',
  'enable_channel',
  'disable_channel',
]);

/** Tools that perform read/query operations (10s timeout) */
const QUERY_TOOLS = new Set([
  'get_config',
  'list_channels',
  'get_system_status',
]);

/**
 * Returns the timeout in milliseconds for a given tool name.
 * Mutating operations get 60s, query operations get 10s.
 */
export function getToolTimeout(toolName: string): number {
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
  {
    name: 'create_team',
    description: 'Create a new team of agents',
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Team slug (lowercase, hyphens)' },
        leader_aid: { type: 'string', description: 'AID of the team leader' },
      },
      required: ['slug', 'leader_aid'],
    },
  },
  {
    name: 'dispatch_task',
    description: 'Dispatch a task to an agent',
    parameters: {
      type: 'object',
      properties: {
        agent_aid: { type: 'string', description: 'Target agent AID' },
        prompt: { type: 'string', description: 'Task prompt' },
        task_id: { type: 'string', description: 'Task identifier' },
      },
      required: ['agent_aid', 'prompt'],
    },
  },
];
