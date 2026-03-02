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

/**
 * Built-in system prompt for the main assistant.
 * Appended to the Claude Code default prompt so the assistant retains
 * all standard coding capabilities while knowing its role in OpenHive.
 */
export const MAIN_ASSISTANT_PROMPT = `You are the OpenHive Assistant — the primary AI interface for the OpenHive platform.

## Your Role
You are the user's personal AI assistant. Users reach you through messaging channels (Discord, WhatsApp, REST API, etc.). You handle requests directly when you can, and in the future you will be able to create and manage teams of specialized AI agents for complex tasks.

## Current Capabilities
- Answer questions, write code, analyze data, and assist with any task a skilled developer or analyst could handle
- Read and modify files in the workspace
- Run shell commands and scripts
- Search codebases and documentation

## Guidelines
- Be concise and direct. Avoid unnecessary preamble.
- When working with code, show your work — read before modifying, explain what you're changing and why.
- If a task is ambiguous, ask for clarification rather than guessing.
- If you cannot do something, say so clearly.
`;

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

/**
 * Interface for the SDK query function, allowing mock injection.
 */
export interface SDKQueryFn {
  (params: {
    prompt: string | AsyncIterable<unknown>;
    options: Record<string, unknown>;
  }): AsyncIterable<{ type: string; subtype?: string; result?: string; error?: string; session_id?: string; uuid?: string }>;
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
}

export class AgentExecutor {
  private readonly config: AgentInitConfig;
  private readonly mcpBridge: MCPBridge;
  private readonly sendMessage: (msg: WSMessage) => void;
  private readonly queryFn: SDKQueryFn;
  private readonly workspaceRoot: string;
  private readonly idleTimeoutMs: number;
  private readonly systemPrompt: string | undefined;

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

    try {
      mkdirSync(workDir, { recursive: true });
      let resultText: string | undefined;
      let newSessionId: string | undefined;

      // Build SDK options. Use preset-append form for system prompt so the
      // agent inherits Claude Code's built-in tool capabilities.
      const sdkOptions: Record<string, unknown> = {
        cwd: workDir,
        resume: task.sessionId ?? this.sessionId,
        env,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
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

      // Go's time.Duration is int64 nanoseconds; Date.now() gives ms.
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
    } catch (err) {
      const duration = (Date.now() - startTime) * 1_000_000;
      const errorMessage = err instanceof Error ? err.message : String(err);

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
      console.error(`Agent ${this.config.aid} task ${task.taskId} failed: ${errorMessage}`);
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
        console.log(`Agent ${this.config.aid} idle timeout reached, stopping`);
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
