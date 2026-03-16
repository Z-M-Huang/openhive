/**
 * Agent executor — SDK process lifecycle management.
 *
 * Implements the {@link AgentExecutor} interface for managing Claude Agent SDK
 * instances. Supports two execution modes:
 *
 * 1. **SDK programmatic API** (preferred): Uses `query()` + `createSdkMcpServer()`
 *    from the SDK. Tool calls are handled in-process via the MCP server.
 *    Enabled when `toolHandlers` are provided to the constructor.
 *
 * 2. **Child process** (legacy fallback): Spawns `agent-entry.ts` as a subprocess.
 *    Used when `toolHandlers` are not provided (non-root containers that
 *    bridge tools via WebSocket).
 *
 * @module executor/executor
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { AgentExecutor, AgentInitConfig, EventBus, Logger } from '../domain/index.js';
import { AgentStatus, ProviderType } from '../domain/index.js';
import { ConflictError, NotFoundError } from '../domain/errors.js';
import type { ToolHandler } from '../mcp/tools/index.js';
import {
  createOpenHiveMcpServer,
  runAgentQuery,
  type AgentQueryResult,
} from './sdk-runner.js';

// ---------------------------------------------------------------------------
// Tracked agent state
// ---------------------------------------------------------------------------

interface TrackedAgent {
  aid: string;
  status: AgentStatus;
  config: AgentInitConfig;
  workspacePath: string;

  /** Child process (legacy mode only). */
  process?: ChildProcess;

  /** MCP server instance for SDK queries. */
  mcpServer?: unknown;

  /** Abort controller for the current SDK query. */
  abortController?: AbortController;

  /** Session ID for resuming conversations. */
  sessionId?: string;

  /** Whether a query is currently in progress. */
  queryActive: boolean;
}

// ---------------------------------------------------------------------------
// Executor implementation
// ---------------------------------------------------------------------------

/**
 * Manages Claude Agent SDK lifecycle for agents within a container.
 *
 * When `toolHandlers` are provided, agents run via the SDK programmatic API
 * with OpenHive tools injected as an in-process MCP server. Otherwise falls
 * back to the child-process approach.
 */
export class AgentExecutorImpl implements AgentExecutor {
  private readonly agents = new Map<string, TrackedAgent>();
  private readonly eventBus: EventBus;
  private readonly logger: Logger;
  private toolHandlers?: Map<string, ToolHandler>;

  constructor(eventBus: EventBus, logger: Logger, toolHandlers?: Map<string, ToolHandler>) {
    this.eventBus = eventBus;
    this.logger = logger;
    this.toolHandlers = toolHandlers;
  }

  /**
   * Sets the tool handlers map, enabling SDK mode for subsequently started agents.
   * This is an alternative injection path to the constructor parameter, used when
   * handlers are not available at construction time (e.g., created later in
   * OrchestratorImpl.initCollaborators()).
   */
  setToolHandlers(handlers: Map<string, ToolHandler>): void {
    this.toolHandlers = handlers;
  }

  /**
   * Registers an agent and prepares it for task dispatch.
   *
   * In SDK mode: creates the MCP server with tool handlers.
   * In legacy mode: spawns the agent-entry.ts child process.
   */
  async start(
    agent: AgentInitConfig,
    workspacePath: string,
    _taskId?: string,
  ): Promise<void> {
    if (this.agents.has(agent.aid)) {
      throw new ConflictError(`Agent ${agent.aid} is already running`);
    }

    if (this.toolHandlers) {
      // SDK mode: create MCP server, agent is ready for dispatchTask()
      const mcpServer = await createOpenHiveMcpServer({
        handlers: this.toolHandlers,
        agentAid: agent.aid,
        teamSlug: this._resolveTeamSlug(agent),
        allowedTools: agent.tools.length > 0 ? agent.tools : undefined,
      });

      // Set provider env vars so the SDK subprocess can authenticate
      this._setProviderEnv(agent);

      const tracked: TrackedAgent = {
        aid: agent.aid,
        status: AgentStatus.Idle,
        config: agent,
        workspacePath,
        mcpServer,
        queryActive: false,
      };

      this.agents.set(agent.aid, tracked);

      this.logger.info('Agent registered (SDK mode)', {
        aid: agent.aid,
        model: agent.model,
        tools: agent.tools.length,
        workspacePath,
      });
    } else {
      // Legacy mode: spawn child process
      await this._startChildProcess(agent, workspacePath);
    }
  }

  /**
   * Dispatches a task prompt to a running agent.
   *
   * In SDK mode: runs `query()` with the MCP server and prompt.
   * Returns when the agent finishes processing.
   */
  async dispatchTask(
    agentAid: string,
    prompt: string,
    taskId: string,
  ): Promise<{ output: string; sessionId?: string }> {
    const tracked = this.agents.get(agentAid);
    if (!tracked) {
      throw new NotFoundError(`Agent ${agentAid} is not running`);
    }

    if (!tracked.mcpServer) {
      throw new Error(`Agent ${agentAid} does not support dispatchTask (legacy mode)`);
    }

    if (tracked.queryActive) {
      throw new ConflictError(`Agent ${agentAid} is already processing a task`);
    }

    tracked.status = AgentStatus.Busy;
    tracked.queryActive = true;
    tracked.abortController = new AbortController();

    this.logger.info('Dispatching task to agent', {
      aid: agentAid,
      taskId,
      promptLength: prompt.length,
    });

    try {
      // Use model tier alias ('sonnet') so the SDK resolves via ANTHROPIC_DEFAULT_*_MODEL
      // env vars. This works for both Anthropic-native and proxy providers.
      const modelAlias = tracked.config.modelTier ?? 'sonnet';

      // Build explicit env for the SDK subprocess — ensures credentials and model
      // mappings are always passed, regardless of process.env mutation timing.
      const sdkEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) sdkEnv[k] = v;
      }
      const provider = tracked.config.provider;
      if (provider.type === 'oauth' && provider.oauthToken) {
        sdkEnv['CLAUDE_CODE_OAUTH_TOKEN'] = provider.oauthToken;
        delete sdkEnv['ANTHROPIC_API_KEY'];
      } else if (provider.type === 'anthropic_direct' && provider.apiKey) {
        sdkEnv['ANTHROPIC_API_KEY'] = provider.apiKey;
        if (provider.baseUrl) sdkEnv['ANTHROPIC_BASE_URL'] = provider.baseUrl;
        delete sdkEnv['CLAUDE_CODE_OAUTH_TOKEN'];
      }
      if (provider.models) {
        if (provider.models.haiku) sdkEnv['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = provider.models.haiku;
        if (provider.models.sonnet) sdkEnv['ANTHROPIC_DEFAULT_SONNET_MODEL'] = provider.models.sonnet;
        if (provider.models.opus) sdkEnv['ANTHROPIC_DEFAULT_OPUS_MODEL'] = provider.models.opus;
      }
      sdkEnv['CLAUDE_CODE_SUBAGENT_MODEL'] = modelAlias;

      const result: AgentQueryResult = await runAgentQuery({
        prompt,
        mcpServer: tracked.mcpServer,
        model: modelAlias,
        cwd: tracked.workspacePath,
        systemPrompt: tracked.config.systemPrompt,
        // Don't resume sessions — each query starts fresh to avoid conflicts
        // with non-Anthropic providers that may not support session continuation.
        sessionId: undefined,
        maxTurns: 200,
        abortController: tracked.abortController,
        env: sdkEnv,
      });

      // Store session ID for future conversation resumption
      if (result.sessionId) {
        tracked.sessionId = result.sessionId;
      }

      tracked.status = AgentStatus.Idle;
      tracked.queryActive = false;
      tracked.abortController = undefined;

      if (!result.success) {
        this.logger.error(`Agent query failed: ${result.error ?? 'unknown error'}`, {
          aid: agentAid,
          taskId,
          error: String(result.error ?? 'unknown'),
        });
        // Also log to stderr for immediate visibility
        console.error(`[AgentExecutor] Query failed for ${agentAid}: ${result.error}`);

        this.eventBus.publish({
          type: 'task_result',
          data: {
            task_id: taskId,
            agent_aid: agentAid,
            status: 'failed',
            error: result.error ?? 'Agent query failed',
          },
          timestamp: Date.now(),
          source: 'executor',
        });
      } else {
        this.eventBus.publish({
          type: 'task_result',
          data: {
            task_id: taskId,
            agent_aid: agentAid,
            status: 'completed',
            result: result.output,
          },
          timestamp: Date.now(),
          source: 'executor',
        });
      }

      return { output: result.output, sessionId: result.sessionId };
    } catch (err) {
      tracked.status = AgentStatus.Error;
      tracked.queryActive = false;
      tracked.abortController = undefined;

      this.logger.error('Agent dispatch error', {
        aid: agentAid,
        taskId,
        error: String(err),
      });

      this.eventBus.publish({
        type: 'agent.crashed',
        data: { aid: agentAid, error: String(err) },
        timestamp: Date.now(),
        source: 'executor',
      });

      throw err;
    }
  }

  /**
   * Gracefully stops an agent.
   * In SDK mode: aborts the current query.
   * In legacy mode: sends SIGTERM, waits, then SIGKILL.
   */
  async stop(agentAid: string, timeoutMs: number = 30000): Promise<void> {
    const tracked = this.agents.get(agentAid);
    if (!tracked) {
      throw new NotFoundError(`Agent ${agentAid} is not running`);
    }

    this.agents.delete(agentAid);

    // SDK mode: abort any active query
    if (tracked.abortController) {
      tracked.abortController.abort();
      this.logger.info('Aborted agent query', { aid: agentAid });
      return;
    }

    // Legacy mode: stop child process
    if (tracked.process) {
      return this._stopChildProcess(tracked, timeoutMs);
    }
  }

  /** Immediately terminates an agent. */
  kill(agentAid: string): void {
    const tracked = this.agents.get(agentAid);
    if (!tracked) {
      throw new NotFoundError(`Agent ${agentAid} is not running`);
    }

    this.agents.delete(agentAid);

    if (tracked.abortController) {
      tracked.abortController.abort();
    }
    if (tracked.process) {
      tracked.process.kill('SIGKILL');
    }

    this.logger.info('Killed agent', { aid: agentAid });
  }

  /** Checks whether an agent is currently registered and running. */
  isRunning(agentAid: string): boolean {
    return this.agents.has(agentAid);
  }

  /** Returns the current status of an agent. */
  getStatus(agentAid: string): AgentStatus | undefined {
    return this.agents.get(agentAid)?.status;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Extracts team slug from agent config or defaults to 'main'. */
  private _resolveTeamSlug(_agent: AgentInitConfig): string {
    // Agent's team slug is typically set in the init config
    // For root agents, use 'main' as the default
    return 'main';
  }

  /** Sets provider environment variables for SDK subprocess authentication. */
  private _setProviderEnv(agent: AgentInitConfig): void {
    if (agent.provider.type === ProviderType.OAuth && agent.provider.oauthToken) {
      process.env['CLAUDE_CODE_OAUTH_TOKEN'] = agent.provider.oauthToken;
      delete process.env['ANTHROPIC_API_KEY'];
      delete process.env['ANTHROPIC_BASE_URL'];
    } else if (agent.provider.type === ProviderType.AnthropicDirect) {
      if (agent.provider.apiKey) {
        process.env['ANTHROPIC_API_KEY'] = agent.provider.apiKey;
      }
      if (agent.provider.baseUrl) {
        process.env['ANTHROPIC_BASE_URL'] = agent.provider.baseUrl;
      }
      delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    }

    // Set model tier mappings so the SDK resolves tier aliases (haiku/sonnet/opus)
    // to the provider's actual model names. This is required for non-Anthropic
    // providers like MiniMax that use custom model identifiers.
    if (agent.provider.models) {
      const models = agent.provider.models;
      if (models.haiku) process.env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = models.haiku;
      if (models.sonnet) process.env['ANTHROPIC_DEFAULT_SONNET_MODEL'] = models.sonnet;
      if (models.opus) process.env['ANTHROPIC_DEFAULT_OPUS_MODEL'] = models.opus;
    } else {
      // Fallback: map all tiers to the agent's configured model
      process.env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = agent.model;
      process.env['ANTHROPIC_DEFAULT_SONNET_MODEL'] = agent.model;
      process.env['ANTHROPIC_DEFAULT_OPUS_MODEL'] = agent.model;
    }
    // Tell the SDK to use 'sonnet' as the default subagent model alias
    process.env['CLAUDE_CODE_SUBAGENT_MODEL'] = 'sonnet';
  }

  /** Legacy: spawns agent-entry.ts as a child process. */
  private async _startChildProcess(
    agent: AgentInitConfig,
    workspacePath: string,
  ): Promise<void> {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      OPENHIVE_AGENT_AID: agent.aid,
      OPENHIVE_AGENT_NAME: agent.name,
      OPENHIVE_AGENT_MODEL: agent.model,
    };

    if (agent.provider.type === ProviderType.OAuth && agent.provider.oauthToken) {
      env['CLAUDE_CODE_OAUTH_TOKEN'] = agent.provider.oauthToken;
      delete env['ANTHROPIC_API_KEY'];
      delete env['ANTHROPIC_BASE_URL'];
    } else if (agent.provider.type === ProviderType.AnthropicDirect) {
      if (agent.provider.apiKey) {
        env['ANTHROPIC_API_KEY'] = agent.provider.apiKey;
      }
      if (agent.provider.baseUrl) {
        env['ANTHROPIC_BASE_URL'] = agent.provider.baseUrl;
      }
      delete env['CLAUDE_CODE_OAUTH_TOKEN'];
    }

    const child = spawn('node', ['/app/backend/dist/agent-entry.js'], {
      cwd: workspacePath,
      env,
      stdio: 'pipe',
    });

    const tracked: TrackedAgent = {
      aid: agent.aid,
      status: AgentStatus.Starting,
      config: agent,
      workspacePath,
      process: child,
      queryActive: false,
    };

    this.agents.set(agent.aid, tracked);

    this.logger.info('Agent process spawned (legacy mode)', {
      aid: agent.aid,
      pid: child.pid,
      workspacePath,
    });

    child.on('exit', (code, signal) => {
      const entry = this.agents.get(agent.aid);
      if (!entry) return;

      entry.status = AgentStatus.Error;
      this.agents.delete(agent.aid);

      this.logger.error('Agent process crashed', {
        aid: agent.aid,
        exitCode: code,
        signal,
      });

      this.eventBus.publish({
        type: 'agent.crashed',
        data: { aid: agent.aid, exitCode: code, signal },
        timestamp: Date.now(),
        source: 'executor',
      });
    });
  }

  /** Legacy: stops a child process with SIGTERM then SIGKILL. */
  private _stopChildProcess(tracked: TrackedAgent, timeoutMs: number): Promise<void> {
    const child = tracked.process!;

    return new Promise<void>((resolve) => {
      let resolved = false;
      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve();
      };

      child.on('exit', cleanup);
      child.kill('SIGTERM');

      this.logger.info('Sent SIGTERM to agent', { aid: tracked.aid });

      const timer = setTimeout(() => {
        if (resolved) return;
        this.logger.warn('Agent did not exit within timeout, sending SIGKILL', {
          aid: tracked.aid,
          timeoutMs,
        });
        child.kill('SIGKILL');
      }, timeoutMs);
    });
  }
}
