/**
 * SDK runner — bridges OpenHive tool handlers to the Claude Agent SDK.
 *
 * Uses the SDK's programmatic API (`query()` + `createSdkMcpServer()`) to run
 * agents with OpenHive's 27 built-in MCP tools injected as an in-process server.
 *
 * ## How It Works
 *
 * 1. `createOpenHiveMcpServer()` wraps each OpenHive ToolHandler as an
 *    `SdkMcpToolDefinition` and registers them in a `createSdkMcpServer()`.
 * 2. `runAgentQuery()` calls the SDK's `query()` with the MCP server injected,
 *    streaming messages back to the caller via an async generator.
 * 3. The SDK internally spawns a CLI subprocess — crash isolation is maintained.
 *
 * For **root-local agents**, tool handlers execute directly against local stores.
 * For **non-root agents**, tool handlers bridge via WebSocket to root.
 *
 * @module executor/sdk-runner
 */

import { z } from 'zod';
import type { ToolHandler } from '../mcp/tools/index.js';
import { TOOL_SCHEMAS } from '../mcp/tools/index.js';

// ---------------------------------------------------------------------------
// Tool descriptions (one-line summaries for the MCP server catalog)
// ---------------------------------------------------------------------------

/** Human-readable description for each of the 27 tools. */
export const TOOL_DESCRIPTIONS: Record<string, string> = {
  spawn_container: 'Create and start a new Docker container for a team',
  stop_container: 'Stop a running team container gracefully',
  list_containers: 'List all running containers with health status',
  create_team: 'Create a new team with workspace scaffolding and container',
  create_agent: 'Create a new agent within a team',
  create_task: 'Create a task and assign it to an agent for execution',
  dispatch_subtask: 'Create a subtask linked to a parent task',
  update_task_status: 'Update the status of a task (complete, fail, cancel)',
  send_message: 'Send a message to another agent or reply to a channel',
  escalate: 'Escalate a task to the supervisor for guidance',
  save_memory: 'Save a memory entry for the calling agent',
  recall_memory: 'Search agent memories by keyword',
  create_integration: 'Create a new declarative integration configuration',
  test_integration: 'Test an integration configuration for connectivity',
  activate_integration: 'Activate a tested integration for use by agents',
  get_credential: 'Retrieve an encrypted credential by key',
  set_credential: 'Store an encrypted credential',
  get_team: 'Get detailed information about a team',
  get_task: 'Get the current status and result of a task',
  get_health: 'Get system or team health information',
  inspect_topology: 'Inspect the full team/agent hierarchy',
  register_webhook: 'Register an HTTP webhook endpoint for external events',
  register_trigger: 'Register a cron trigger to schedule recurring tasks',
  search_skill: 'Search configured skill registries for skills by keyword',
  install_skill: 'Install a skill from a configured registry into the team workspace',
  invoke_integration: 'Invoke an active integration endpoint with parameters',
  browse_web: 'Browse a web page with JavaScript rendering, screenshots, form filling, and link extraction',
};

// ---------------------------------------------------------------------------
// Zod shape extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the Zod shape from a ZodObject for use as SdkMcpToolDefinition inputSchema.
 * The SDK's `tool()` helper expects a ZodRawShape (the `.shape` of a ZodObject),
 * not a ZodObject instance.
 */
function extractZodShape(schema: z.ZodTypeAny): z.ZodRawShape {
  if (schema instanceof z.ZodObject) {
    return schema.shape as z.ZodRawShape;
  }
  // Fallback: empty shape for tools with no params
  return {};
}

// ---------------------------------------------------------------------------
// MCP server creation
// ---------------------------------------------------------------------------

/** Options for creating the OpenHive MCP server. */
export interface CreateOpenHiveMcpOptions {
  /** Map of tool name → handler function. */
  handlers: Map<string, ToolHandler>;
  /** Agent AID passed to every tool call for authorization. */
  agentAid: string;
  /** Team slug passed to every tool call for scoping. */
  teamSlug: string;
  /** Optional filter: only include these tool names. If undefined, include all. */
  allowedTools?: string[];
}

/**
 * Creates an MCP server config with OpenHive tools registered.
 *
 * Returns a `McpSdkServerConfigWithInstance` that can be passed to
 * the SDK's `query()` options under `mcpServers['openhive-tools']`.
 *
 * @example
 * ```ts
 * const mcpServer = await createOpenHiveMcpServer({
 *   handlers: createToolHandlers(toolContext),
 *   agentAid: 'aid-main-001',
 *   teamSlug: 'main',
 * });
 * const q = query({
 *   prompt: 'Hello',
 *   options: { mcpServers: { 'openhive-tools': mcpServer } },
 * });
 * ```
 */
export async function createOpenHiveMcpServer(
  opts: CreateOpenHiveMcpOptions,
): Promise<unknown> {
  // Dynamic import to avoid loading SDK at module evaluation time
  const sdk = await import('@anthropic-ai/claude-agent-sdk');

  const toolDefs: unknown[] = [];

  for (const [name, handler] of opts.handlers) {
    // Skip tools not in the allowed list (if filter provided)
    if (opts.allowedTools && !opts.allowedTools.includes(name)) {
      continue;
    }

    const schema = TOOL_SCHEMAS[name];
    if (!schema) continue;

    const description = TOOL_DESCRIPTIONS[name] ?? name;
    const shape = extractZodShape(schema);

    // Use the SDK's `tool()` helper to create a properly typed definition
    const toolDef = sdk.tool(
      name,
      description,
      shape,
      async (args: Record<string, unknown>) => {
        const result = await handler(args, opts.agentAid, opts.teamSlug);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    );

    toolDefs.push(toolDef);
  }

  return sdk.createSdkMcpServer({
    name: 'openhive-tools',
    version: '1.0.0',
    tools: toolDefs as Parameters<typeof sdk.createSdkMcpServer>[0]['tools'],
  });
}

// ---------------------------------------------------------------------------
// Agent query execution
// ---------------------------------------------------------------------------

/** Options for running a single agent query. */
export interface RunAgentQueryOptions {
  /** The prompt/task to send to the agent. */
  prompt: string;
  /** MCP server config from createOpenHiveMcpServer(). */
  mcpServer: unknown;
  /** Claude model ID or tier alias (e.g., 'sonnet'). */
  model: string;
  /** Working directory for the agent. */
  cwd: string;
  /** Environment variables for the SDK subprocess. Defaults to process.env. */
  env?: Record<string, string>;
  /** System prompt for the agent. */
  systemPrompt?: string;
  /** Session ID to resume a previous conversation. */
  sessionId?: string;
  /**
   * Continue the most recent conversation in the current directory.
  /** Maximum conversation turns (default: 200). */
  maxTurns?: number;
  /** Abort controller for cancellation. */
  abortController?: AbortController;
  /** SDK hooks (PreToolUse/PostToolUse) for tool call logging and auditing. */
  hooks?: Record<string, Array<{ hooks: Array<(input: Record<string, unknown>) => Promise<Record<string, unknown>>> }>>;
  /** External MCP servers from team config to inject alongside openhive-tools. */
  externalMcpServers?: Array<{ name: string; command: string; args: string[]; env: Record<string, string> }>;
  /** Callback for partial/streaming messages (for real-time portal updates). */
  onPartialMessage?: (text: string) => void;
}

/** Result from a completed agent query. */
export interface AgentQueryResult {
  /** The final text output from the agent. */
  output: string;
  /** Session ID for resuming this conversation. */
  sessionId?: string;
  /** Whether the query completed successfully. */
  success: boolean;
  /** Error message if the query failed. */
  error?: string;
}

/**
 * Runs a single agent query using the SDK's programmatic API.
 *
 * The agent runs in a subprocess managed by the SDK. Tool calls are
 * handled by the injected MCP server (openhive-tools).
 *
 * @returns Promise resolving to the agent's output and session ID.
 */
export async function runAgentQuery(opts: RunAgentQueryOptions): Promise<AgentQueryResult> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');

  const mcpServers: Record<string, unknown> = {
    'openhive-tools': opts.mcpServer,
    // Inject external MCP servers from team config (Phase 3)
    ...Object.fromEntries(
      (opts.externalMcpServers ?? []).map(s => [s.name, {
        command: s.command,
        args: s.args,
        env: s.env,
      }])
    ),
  };

  let output = '';
  let sessionId: string | undefined;

  try {
    const q = sdk.query({
      prompt: opts.prompt,
      options: {
        model: opts.model,
        cwd: opts.cwd,
        systemPrompt: opts.systemPrompt,
        sessionId: opts.sessionId,
        // Note: Do NOT use `continue: true` — it resumes the last session on disk,
        // which may be from a different conversation. Use sessionId for explicit resumption.
        maxTurns: opts.maxTurns ?? 200,
        permissionMode: 'bypassPermissions',
        mcpServers: mcpServers as Record<string, import('@anthropic-ai/claude-agent-sdk').McpServerConfig>,
        abortController: opts.abortController,
        includePartialMessages: true,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.hooks ? { hooks: opts.hooks } : {}),
      },
    });

    // Stream messages from the agent
    for await (const msg of q) {
      // Capture session ID from init messages
      if ('session_id' in msg && typeof msg.session_id === 'string') {
        sessionId = msg.session_id;
      }

      // Capture assistant text output
      if (msg.type === 'assistant' && 'message' in msg) {
        const message = msg.message as { content?: Array<{ type: string; text?: string }> };
        if (message.content) {
          for (const block of message.content) {
            if (block.type === 'text' && block.text) {
              output += block.text;
            }
          }
        }
      }

      // Forward partial/streaming messages for real-time portal updates
      if ((msg.type as string) === 'partial' && opts.onPartialMessage) {
        const partial = msg as unknown as { text?: string };
        if (partial.text) {
          opts.onPartialMessage(partial.text);
        }
      }

      // Capture result messages
      if (msg.type === 'result') {
        const result = msg as { result?: string; session_id?: string };
        if (result.result) {
          output = result.result;
        }
        if (result.session_id) {
          sessionId = result.session_id;
        }
      }
    }

    return { output, sessionId, success: true };
  } catch (err) {
    return {
      output: '',
      sessionId,
      success: false,
      error: String(err),
    };
  }
}
