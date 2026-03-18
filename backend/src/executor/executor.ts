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

/** Default query timeout: 5 minutes. */
const DEFAULT_QUERY_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Personal info extraction (deterministic, no LLM needed)
// ---------------------------------------------------------------------------

/**
 * Extract personal facts from a user message for curated auto-save.
 * Returns a summary string if personal info is detected, null otherwise.
 * Uses lightweight regex patterns — not exhaustive but catches common patterns.
 */
function extractPersonalFacts(text: string): string | null {
  const facts: string[] = [];
  const lower = text.toLowerCase();

  // Name patterns: "I'm X", "my name is X", "I am X"
  const nameMatch = text.match(/(?:I'm|I am|my name is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (nameMatch) facts.push(`Name: ${nameMatch[1]}`);

  // Location: "in City, ST", "in City ST", "I live in X", "based in X"
  const locMatch = text.match(/(?:I (?:live|am|'m) in|located in|based in|in)\s+([A-Z][a-zA-Z\s]+,\s*[A-Z]{2})\b/);
  if (locMatch) facts.push(`Location: ${locMatch[1].trim()}`);

  // Company/org: "at X Inc/Corp/LLC/Co", "my company is X", "I work at X", "I run X", "called X"
  const compMatch = text.match(/(?:at|my company is|I (?:work|am) at|I run|called)\s+([A-Z][A-Za-z\s]+(?:Inc|Corp|LLC|Co|Ltd|Systems|Tech|Pro|Labs|Studio|Group)?)\b/);
  if (compMatch) facts.push(`Work: ${compMatch[1].trim()}`);

  // Role: "I'm a X at", "I am a X", "my role is X", "I'm the X"
  const roleMatch = text.match(/(?:I'm a|I am a|my role is|I'm the)\s+([a-z][^.!?]{2,40?})(?:\s+at\b|[.,])/i);
  if (roleMatch) facts.push(`Role: ${roleMatch[1].trim()}`);

  // API/URL: explicit URLs or tokens shared
  if (lower.includes('url') || lower.includes('token') || lower.includes('api key') || lower.includes('endpoint')) {
    const urlMatch = text.match(/https?:\/\/[^\s,]+/);
    if (urlMatch) facts.push(`URL: ${urlMatch[0]}`);
  }

  // Entity IDs: HomeAssistant, IoT, etc.
  const entityMatch = text.match(/(?:entity|entity_id|script)\.\w[\w.]+/i);
  if (entityMatch) facts.push(`Entity: ${entityMatch[0]}`);

  if (facts.length === 0) return null;
  return facts.join('. ') + '.';
}

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
      enrichedSystemPrompt += `\n\n## Your MCP Tools (MUST USE for system operations)

| Task | Tool to Use | Do NOT |
|------|-------------|--------|
| Remember facts | save_memory | Write to MEMORY.md directly |
| Search memories | recall_memory | Read MEMORY.md directly |
| Create an agent | create_agent | Write .claude/agents/*.md directly |
| Schedule recurring task | register_trigger | Suggest crontab or write YAML |
| Create a task | create_task | Describe tasks without creating them |
| Make HTTP calls | Bash with curl or /app/common/scripts/http-client.ts | Say you cannot make HTTP calls |

CRITICAL: Writing files directly does NOT register agents, triggers, or memories in the system. Only MCP tool calls update the database and org chart.

## Memory Management (MANDATORY)
- You MUST call save_memory with memory_type "curated" when the user shares: personal info, preferences, locations, credentials, project details, or any fact they would not want to repeat.
- Before asking the user for information, ALWAYS check your memory section above — they may have already told you.
- Do NOT skip memory saves because you are focused on a task. Memory is as important as task completion.
- Daily conversation logs are saved automatically — you do not need to save daily summaries.

## File Management
- NEVER write files to /tmp — they will be lost on restart.
- Save all generated files to your working directory or a subdirectory of it (e.g., ./work/<task-name>/).

## Agent-per-Task Pattern
- For recurring tasks, create a dedicated agent using create_agent with a DETAILED description (the description IS the agent's system prompt), then register a cron trigger using register_trigger.
- Do NOT suggest manual crontab edits or external scheduling. Use the built-in trigger system.
- Before creating an agent, check if one already exists using inspect_topology.
- A new team is only needed when the task requires multiple collaborating agents or isolated resources.`;

      // --- Fix 3A: 5-minute query timeout via AbortController ---
      const timeoutId = setTimeout(() => {
        tracked.abortController?.abort();
      }, DEFAULT_QUERY_TIMEOUT_MS);

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
   * Queries the last 10 user-originated completed tasks for this agent
   * and formats them as a "Recent Conversation History" section for the system prompt (Tier 3).
   * Filters by origin_chat_jid IS NOT NULL AND parent_id = '' to exclude subtasks and proactive tasks.
   */
  private async _getRecentHistory(agentAid: string): Promise<string | null> {
    if (!this.taskStore) return null;

    const agentTasks = await this.taskStore.getRecentUserTasks(agentAid, 10);

    if (agentTasks.length === 0) return null;

    const lines = ['## Recent Conversation History'];
    for (const task of agentTasks.reverse()) {
      const promptSnippet = task.prompt.length > 500 ? task.prompt.slice(0, 500) + '...' : task.prompt;
      const resultSnippet = (task.result ?? '').length > 1000 ? task.result!.slice(0, 1000) + '...' : (task.result ?? '');
      lines.push(`User: ${promptSnippet}`);
      lines.push(`Assistant: ${resultSnippet}`);
      lines.push('');
    }

    return lines.join('\n');
  }

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
