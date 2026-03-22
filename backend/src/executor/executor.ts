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
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentExecutor, AgentInitConfig, EventBus, Logger, TaskStore } from '../domain/index.js';
import { AgentStatus, ProviderType } from '../domain/index.js';
import { ConflictError, NotFoundError } from '../domain/errors.js';
import type { ToolHandler } from '../mcp/tools/index.js';
import {
  createOpenHiveMcpServer,
  runAgentQuery,
  type AgentQueryResult,
} from './sdk-runner.js';
import { createSDKHooks } from './hooks.js';
import { extractPersonalFacts, BEHAVIORAL_INSTRUCTIONS } from './executor-prompt.js';
import { DEFAULT_QUERY_TIMEOUT_MS, getRecentHistory, resolveTeamSlug } from './executor-helpers.js';

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
  private taskStore?: TaskStore;
  private memoryStore?: import('../domain/interfaces.js').MemoryStore;
  private memoryFileWriter?: (agentAid: string, teamSlug: string, entry: {
    id: number; content: string; memory_type: 'curated' | 'daily'; created_at: number;
  }) => Promise<void>;
  private logStoreForHooks?: import('../domain/interfaces.js').LogStore;
  private toolCallStoreForHooks?: import('../domain/interfaces.js').ToolCallStore;

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
   * Sets the task store for Tier 3 memory (recent history injection).
   * Called post-construction when stores are initialized after the executor.
   */
  setTaskStore(store: TaskStore): void {
    this.taskStore = store;
  }

  /** Sets the memory store for auto-extracted facts SQLite indexing (dual-write). */
  setMemoryStore(store: import('../domain/interfaces.js').MemoryStore): void {
    this.memoryStore = store;
  }

  /** Sets the log + tool call stores for tool_calls table logging via SDK hooks. */
  setToolCallStores(logStore: import('../domain/interfaces.js').LogStore, toolCallStore: import('../domain/interfaces.js').ToolCallStore): void {
    this.logStoreForHooks = logStore;
    this.toolCallStoreForHooks = toolCallStore;
  }

  /**
   * Sets the memory file writer for post-task auto-save to daily logs.
   * Routes through the same callback used by save_memory for consistent formatting.
   */
  setMemoryFileWriter(writer: (agentAid: string, teamSlug: string, entry: {
    id: number; content: string; memory_type: 'curated' | 'daily'; created_at: number;
  }) => Promise<void>): void {
    this.memoryFileWriter = writer;
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

      // Provider env vars are set per-dispatch in dispatchTask() via sdkEnv,
      // not at start() time, to support mixed providers in the same container.

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

      // Credential preflight — fail fast with clear error instead of silent empty output
      if (!sdkEnv['ANTHROPIC_API_KEY'] && !sdkEnv['CLAUDE_CODE_OAUTH_TOKEN']) {
        throw new Error(`No API credentials for agent ${agentAid}. Provider type: ${provider.type}. Check providers.yaml or CLAUDE_CODE_OAUTH_TOKEN env var.`);
      }

      // --- Tier 1: Session continuity (within same connection) ---
      // Reuse tracked.sessionId for subsequent queries from the same agent.
      // On first query (new WS connection), sessionId is undefined → fresh session.
      // DO NOT use `continue: true` — it resumes the LAST session file on disk,
      // which may be from a completely different conversation (stale session bleed).

      // --- Tier 2: MEMORY.md + daily logs auto-injection ---
      let enrichedSystemPrompt = tracked.config.systemPrompt ?? '';
      const memoryDir = join(tracked.workspacePath, 'memory', agentAid);
      const memoryPath = join(memoryDir, 'MEMORY.md');
      try {
        await mkdir(memoryDir, { recursive: true });
        let memoryBlock = '';

        // Load curated MEMORY.md
        try {
          const memoryContent = await readFile(memoryPath, 'utf-8');
          if (memoryContent.trim().length > 0) {
            memoryBlock += memoryContent;
          }
        } catch { /* optional */ }

        // Load today's + yesterday's daily logs
        const today = new Date();
        const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
        for (const date of [yesterday, today]) {
          const dateStr = date.toISOString().slice(0, 10);
          const dailyPath = join(memoryDir, `${dateStr}.md`);
          try {
            const dailyContent = await readFile(dailyPath, 'utf-8');
            if (dailyContent.trim().length > 0) {
              memoryBlock += `\n\n## Daily Log (${dateStr})\n${dailyContent}`;
            }
          } catch { /* optional */ }
        }

        if (memoryBlock.trim().length > 0) {
          enrichedSystemPrompt = `<agent-memory>\n${memoryBlock}\n</agent-memory>\n\n${enrichedSystemPrompt}`;
        }
      } catch {
        // Memory directory creation failed — skip memory injection
      }

      // --- Tier 3: Recent conversation history (ALWAYS inject) ---
      if (this.taskStore) {
        try {
          const recentHistory = await this._getRecentHistory(agentAid);
          if (recentHistory) {
            enrichedSystemPrompt = `${enrichedSystemPrompt}\n\n${recentHistory}`;
          }
        } catch (err) {
          this.logger.debug('Failed to load recent history for agent', {
            aid: agentAid,
            error: String(err),
          });
        }
      }

      // --- Behavioral instructions + tool catalog ---
      enrichedSystemPrompt += `\n\n${BEHAVIORAL_INSTRUCTIONS}`;

      // Track query start time for empty-output detection
      const queryStart = Date.now();

      // --- Fix 3A: 5-minute query timeout via AbortController ---
      const timeoutId = setTimeout(() => {
        tracked.abortController?.abort();
      }, DEFAULT_QUERY_TIMEOUT_MS);

      // Create SDK hooks for tool call audit logging (+ tool_calls table if stores available)
      const teamSlug = this._resolveTeamSlug(tracked.config);
      const sdkHooks = createSDKHooks(this.logger, agentAid, {
        toolCallStore: this.toolCallStoreForHooks,
        logStore: this.logStoreForHooks,
        teamSlug,
      });
      const hooksConfig: Record<string, Array<{ hooks: Array<(input: Record<string, unknown>) => Promise<Record<string, unknown>>> }>> = {
        PreToolUse: [{ hooks: sdkHooks.PreToolUse as Array<(input: Record<string, unknown>) => Promise<Record<string, unknown>>> }],
        PostToolUse: [{ hooks: sdkHooks.PostToolUse as Array<(input: Record<string, unknown>) => Promise<Record<string, unknown>>> }],
      };

      const result: AgentQueryResult = await runAgentQuery({
        prompt,
        mcpServer: tracked.mcpServer,
        model: modelAlias,
        cwd: tracked.workspacePath,
        systemPrompt: enrichedSystemPrompt,
        // Always start a fresh session. Cross-session context comes from
        // Tier 2 (MEMORY.md) and Tier 3 (task history), not SDK sessions.
        // Resuming sessions causes "Claude Code process exited with code 1"
        // because the SDK session state conflicts across sequential queries.
        sessionId: undefined,
        maxTurns: 200,
        abortController: tracked.abortController,
        env: sdkEnv,
        hooks: hooksConfig,
        externalMcpServers: tracked.config.mcpServers,
        onPartialMessage: (text: string) => {
          this.eventBus.publish({
            type: 'agent.partial_message',
            data: { aid: agentAid, taskId, text },
            timestamp: Date.now(),
          });
        },
      });

      clearTimeout(timeoutId);

      // Store session ID for future conversation resumption
      if (result.sessionId) {
        tracked.sessionId = result.sessionId;
      }

      tracked.status = AgentStatus.Idle;
      tracked.queryActive = false;
      tracked.abortController = undefined;

      if (!result.success) {
        const errorMsg = result.error ?? 'Agent query failed';
        this.logger.error(`Agent query failed: ${errorMsg}`, {
          aid: agentAid,
          taskId,
          error: String(errorMsg),
        });
        console.error(`[AgentExecutor] Query failed for ${agentAid}: ${errorMsg}`);

        this.eventBus.publish({
          type: 'task_result',
          data: {
            task_id: taskId,
            agent_aid: agentAid,
            status: 'failed',
            error: errorMsg,
          },
          timestamp: Date.now(),
          source: 'executor',
        });

        // Throw so non-root handleTaskDispatch sends failed status back to root
        throw new Error(errorMsg);
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

        // Post-task auto-save: daily log + curated personal info extraction (best-effort)
        if (this.memoryFileWriter && result.output) {
          const teamSlug = this._resolveTeamSlug(tracked.config);
          // 1. Daily log: conversation summary
          try {
            const promptSnippet = prompt.length > 100 ? prompt.slice(0, 100) + '...' : prompt;
            const resultSnippet = result.output.length > 200 ? result.output.slice(0, 200) + '...' : result.output;
            await this.memoryFileWriter(agentAid, teamSlug, {
              id: 0,
              content: `User: ${promptSnippet} → Assistant: ${resultSnippet}`,
              memory_type: 'daily',
              created_at: Date.now(),
            });
          } catch { /* best-effort */ }

          // 2. Curated auto-extract: detect personal info the LLM may not have saved
          try {
            const facts = extractPersonalFacts(prompt);
            if (facts) {
              const createdAt = Date.now();
              // Dual-write: file (source of truth) + SQLite (searchable index)
              await this.memoryFileWriter(agentAid, teamSlug, {
                id: 0,
                content: facts,
                memory_type: 'curated',
                created_at: createdAt,
              });
              // SQLite index for recall_memory search
              if (this.memoryStore) {
                await this.memoryStore.save({
                  id: 0,
                  agent_aid: agentAid,
                  team_slug: teamSlug,
                  content: facts,
                  memory_type: 'curated',
                  created_at: createdAt,
                  deleted_at: null,
                }).catch(() => {}); // best-effort
              }
            }
          } catch { /* best-effort */ }
        }
      }

      // Detect suspiciously fast empty output (SDK subprocess likely crashed silently)
      const queryDuration = Date.now() - queryStart;
      if (!result.output && queryDuration < 5000) {
        this.logger.error('Agent query returned empty output suspiciously fast', {
          aid: agentAid, taskId, duration_ms: queryDuration, success: result.success,
        });
        throw new Error(`Agent query returned empty output in ${queryDuration}ms — likely SDK subprocess failure. Check provider credentials and model configuration.`);
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

  /**
   * Queries recent history for system prompt enrichment. Delegates to standalone function.
   */
  private async _getRecentHistory(agentAid: string): Promise<string | null> {
    if (!this.taskStore) return null;
    return getRecentHistory(this.taskStore, agentAid);
  }

  /** Extracts team slug from agent config. Delegates to standalone function. */
  private _resolveTeamSlug(agent: AgentInitConfig): string {
    return resolveTeamSlug(agent);
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
