/**
 * Agent Executor - Wraps the Claude Agent SDK for per-agent execution.
 *
 * One AgentExecutor instance per agent. Manages:
 * - Per-agent environment variables (OAuth/direct provider, model tiers)
 * - On-demand lifecycle with idle timeout
 * - Session resume across tasks
 * - Working directory per task
 * - Bash sanitization hook to strip secrets from subprocess environments
 */

import { mkdirSync } from 'node:fs';
import type {
  AgentInitConfig,
  AgentStatusType,
  TaskDispatchMsg,
  TaskResultMsg,
} from './types.js';
import { MSG_TYPE_TASK_RESULT } from './types.js';
import type { MCPBridge } from './mcp-bridge.js';
import type { WSMessage } from './types.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { createToolsMcpServer } from './mcp-server.js';
import type { LogFields, Logger } from './logger.js';

/** Structured error details logged when a task fails. */
interface TaskErrorDetails extends LogFields {
  aid: string;
  taskId: string;
  error: string;
  stack?: string;
  cause?: string;
  stderr?: string;
  stdout?: string;
  exitCode?: number;
}

/** Shape of extra properties the Claude Agent SDK may attach to errors. */
interface SDKError extends Error {
  stderr?: string;
  stdout?: string;
  exitCode?: number;
}

function isSDKError(err: unknown): err is SDKError {
  return err instanceof Error;
}

/**
 * Built-in system prompt for the main assistant.
 * Appended to the Claude Code default prompt so the assistant retains
 * all standard coding capabilities while knowing its role in OpenHive.
 * Tool documentation lives in skills (main-assistant/.claude/skills/).
 */
export const MAIN_ASSISTANT_PROMPT = `You are the OpenHive Assistant — the primary AI interface for the OpenHive platform.
You manage teams of AI agents, dispatch tasks, and handle configuration through SDK tools.
Your tool documentation is in skills — use load_skill to load detailed docs when needed.
Be concise and direct. If a task is ambiguous, ask for clarification.
For team creation, always use the two-step pattern: create_agent first, then create_team.
`;

export const TEAM_LEADER_PROMPT = `You are a team leader in the OpenHive platform.
Your job is to delegate work to team members, NOT do it yourself.
When you receive a task:
1. If workers don't exist yet, create them with create_agent
2. Dispatch sub-tasks with dispatch_task_and_wait
3. Collect and synthesize results
4. Your synthesized answer becomes the task result
You have the same SDK tools as the main assistant. You can create sub-teams
if your workers need their own teams — this is a recursive design.
`;

export const TEAM_WORKER_PROMPT = `You are a specialist worker in the OpenHive platform.
Complete assigned tasks thoroughly and concisely.
Focus on your area of expertise as described in your agent definition.
If a task is too complex for you alone, you can create sub-teams using the
same SDK tools (create_agent, create_team, dispatch_task_and_wait).
`;

/**
 * Select the system prompt based on the agent's role.
 */
export function selectSystemPrompt(role?: string): string {
  switch (role) {
    case 'assistant': return MAIN_ASSISTANT_PROMPT;
    case 'leader':    return TEAM_LEADER_PROMPT;
    case 'worker':    return TEAM_WORKER_PROMPT;
    default:          return TEAM_WORKER_PROMPT;
  }
}

/** Secrets to strip from Bash tool subprocess environments */
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

/**
 * Claude Code session vars to strip so spawned instances don't think
 * they're nested inside the parent session and refuse to start.
 */
const CLAUDE_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
];

/** Default idle timeout in minutes */
const DEFAULT_IDLE_TIMEOUT_MINUTES = 10;

/** Message type emitted by the SDK query() stream */
export interface SDKStreamMessage {
  type: string;
  subtype?: string;
  result?: string;
  error?: string;
  session_id?: string;
  uuid?: string;
}

/** System prompt configuration for the SDK */
export interface SDKSystemPrompt {
  type: 'preset';
  preset: 'claude_code';
  append?: string;
}

/** Permission mode values matching the Claude Agent SDK. */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk';

/** Options passed to the SDK query function */
export interface SDKQueryOptions {
  cwd?: string;
  resume?: string;
  env?: Record<string, string | undefined>;
  permissionMode?: PermissionMode;
  allowDangerouslySkipPermissions?: boolean;
  systemPrompt?: SDKSystemPrompt;
  /** Capture stderr from the Claude Code process for debugging. */
  stderr?: (data: string) => void;
  /** MCP servers to register with the SDK (e.g., openhive-tools). */
  mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
}

/**
 * Interface for the SDK query function, allowing mock injection.
 */
export interface SDKQueryFn {
  (params: {
    prompt: string;
    options: SDKQueryOptions;
  }): AsyncIterable<SDKStreamMessage>;
}

export interface AgentExecutorOptions {
  config: AgentInitConfig;
  mcpBridge: MCPBridge;
  sendMessage: (msg: WSMessage) => void;
  queryFn: SDKQueryFn;
  workspaceRoot?: string;
  idleTimeoutMinutes?: number;
  /** System prompt appended to Claude Code defaults. */
  systemPrompt?: string;
  logger: Logger;
}

export class AgentExecutor {
  private readonly config: AgentInitConfig;
  private readonly mcpBridge: MCPBridge;
  private readonly sendMessage: (msg: WSMessage) => void;
  private readonly queryFn: SDKQueryFn;
  private readonly workspaceRoot: string;
  private readonly idleTimeoutMs: number;
  private readonly systemPrompt: string | undefined;
  private readonly logger: Logger;

  private _status: AgentStatusType = 'idle';
  private sessionId: string | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(options: AgentExecutorOptions) {
    this.config = options.config;
    this.mcpBridge = options.mcpBridge;
    this.sendMessage = options.sendMessage;
    this.queryFn = options.queryFn;
    this.workspaceRoot = options.workspaceRoot ?? '/workspace';
    this.idleTimeoutMs =
      (options.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES) * 60 * 1000;
    this.systemPrompt = options.systemPrompt;
    this.logger = options.logger;
  }

  get status(): AgentStatusType {
    return this._status;
  }

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * Get the MCP bridge for this agent (used for tool call routing).
   */
  get bridge(): MCPBridge {
    return this.mcpBridge;
  }

  /**
   * Start the agent. Transitions from idle/stopped to idle (ready for tasks).
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this._status = 'idle';
    this.resetIdleTimer();
  }

  /**
   * Stop the agent. Clears idle timer and marks as stopped.
   */
  stop(): void {
    this.clearIdleTimer();
    this.running = false;
    this._status = 'stopped';
  }

  /**
   * Execute a task. Starts the agent if not running, calls SDK query(),
   * and sends the result back via WebSocket.
   */
  async executeTask(task: TaskDispatchMsg): Promise<void> {
    if (!this.running) {
      this.start();
    }

    this.clearIdleTimer();
    this._status = 'busy';
    const startTime = Date.now();

    // Always use a fixed workspace so Claude Code sessions persist across tasks.
    // Claude Code stores session state relative to cwd — changing cwd between
    // calls breaks session resume.
    const workDir = this.workspaceRoot;
    const env = this.buildEnv();

    // Capture stderr from the Claude Code process for debugging.
    // The SDK suppresses stderr by default — without this callback
    // we get "exited with code 1" with zero context.
    const stderrChunks: string[] = [];

    try {
      mkdirSync(workDir, { recursive: true });
      let resultText: string | undefined;
      let newSessionId: string | undefined;

      // Build SDK options. Use preset-append form for system prompt so the
      // agent inherits Claude Code's built-in tool capabilities.
      // Register OpenHive SDK tools via in-process MCP server (CLAUDE.md Pattern #2).
      const toolsServer = createToolsMcpServer(this.mcpBridge);
      const sdkOptions: SDKQueryOptions = {
        cwd: workDir,
        resume: task.sessionId ?? this.sessionId,
        env,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        stderr: (data: string) => {
          stderrChunks.push(data);
          this.logger.debug('SDK stderr', { aid: this.config.aid, data });
        },
        mcpServers: { [toolsServer.name]: toolsServer },
      };
      if (this.systemPrompt) {
        sdkOptions.systemPrompt = {
          type: 'preset',
          preset: 'claude_code',
          append: this.systemPrompt,
        };
      }

      for await (const message of this.queryFn({
        prompt: task.prompt,
        options: sdkOptions,
      })) {
        if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
          newSessionId = message.session_id;
        }

        if (message.type === 'result') {
          resultText = message.result;
        }
      }

      if (newSessionId) {
        this.sessionId = newSessionId;
      }

      // Duration is in nanoseconds on the wire; Date.now() gives ms.
      const duration = (Date.now() - startTime) * 1_000_000;

      const taskResult: TaskResultMsg = {
        taskId: task.taskId,
        agentAid: this.config.aid,
        status: 'completed',
        result: resultText,
        duration,
      };

      this.sendMessage({
        type: MSG_TYPE_TASK_RESULT,
        data: taskResult,
      });

      this._status = 'idle';
      this.resetIdleTimer();
    } catch (err: unknown) {
      const duration = (Date.now() - startTime) * 1_000_000;
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Capture all available error details for debugging.
      // The SDK may attach stderr, stdout, cause, or exitCode to the error object.
      const errorDetails: TaskErrorDetails = {
        aid: this.config.aid,
        taskId: task.taskId,
        error: errorMessage,
      };
      if (err instanceof Error) {
        errorDetails.stack = err.stack;
        if (err.cause) errorDetails.cause = String(err.cause);
      }
      // The SDK error may carry extra properties beyond the standard Error interface.
      if (isSDKError(err)) {
        if (err.stderr) errorDetails.stderr = err.stderr;
        if (err.stdout) errorDetails.stdout = err.stdout;
        if (err.exitCode !== undefined) errorDetails.exitCode = err.exitCode;
      }
      // Include captured stderr if the SDK error didn't provide it.
      if (!errorDetails.stderr && stderrChunks.length > 0) {
        errorDetails.stderr = stderrChunks.join('');
      }

      const taskResult: TaskResultMsg = {
        taskId: task.taskId,
        agentAid: this.config.aid,
        status: 'failed',
        error: errorMessage,
        duration,
      };

      this.sendMessage({
        type: MSG_TYPE_TASK_RESULT,
        data: taskResult,
      });

      this._status = 'error';
      this.logger.error('Agent task failed', errorDetails);
    }
  }

  /**
   * Build environment variables for the SDK based on provider config.
   *
   * Starts from the current process env (so PATH, HOME, etc. are preserved),
   * strips known secret vars to prevent leaking into Bash subprocesses,
   * then overlays the provider-specific credentials for this agent.
   */
  buildEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };

    // Strip secrets inherited from the parent process before overlaying
    // agent-specific credentials. This prevents credential leakage when
    // the SDK spawns Bash subprocesses.
    for (const key of SECRET_ENV_VARS) {
      delete env[key];
    }

    // Strip Claude Code session vars so spawned instances start fresh
    // instead of refusing with "nested session" error.
    for (const key of CLAUDE_SESSION_VARS) {
      delete env[key];
    }

    // Provider-specific env vars
    if (this.config.provider.type === 'oauth') {
      if (this.config.provider.oauthToken) {
        env.CLAUDE_CODE_OAUTH_TOKEN = this.config.provider.oauthToken;
      }
    } else if (this.config.provider.type === 'anthropic_direct') {
      if (this.config.provider.apiKey) {
        env.ANTHROPIC_API_KEY = this.config.provider.apiKey;
      }
      if (this.config.provider.apiUrl) {
        env.ANTHROPIC_BASE_URL = this.config.provider.apiUrl;
      }
    }

    // Model tier env vars - set the specific tier for this agent
    // The SDK uses ANTHROPIC_DEFAULT_*_MODEL env vars to map tiers to models
    if (this.config.modelTier) {
      const tierUpper = this.config.modelTier.toUpperCase();
      env[`ANTHROPIC_DEFAULT_${tierUpper}_MODEL`] = this.config.modelTier;
    }

    return env;
  }

  /**
   * Returns the list of secret env var names that should be stripped
   * from Bash subprocess environments.
   */
  static getSecretEnvVars(): string[] {
    return [...SECRET_ENV_VARS];
  }

  /**
   * Get memory usage for this agent (reported in heartbeat).
   */
  getMemoryMB(): number {
    return process.memoryUsage().rss / (1024 * 1024);
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    if (this.idleTimeoutMs > 0 && this.running) {
      this.idleTimer = setTimeout(() => {
        this.logger.info('Agent idle timeout reached, stopping', { aid: this.config.aid });
        this.stop();
      }, this.idleTimeoutMs);
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
