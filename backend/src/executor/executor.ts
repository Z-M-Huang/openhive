/**
 * Agent executor — SDK process lifecycle management.
 *
 * Implements the {@link AgentExecutor} interface for managing Claude Agent SDK
 * instances as standalone processes. Each agent runs as its own process,
 * ensuring isolation and independent lifecycle management.
 *
 * // INV-06: Same image everywhere
 * This module runs the same compiled TypeScript codebase in every container.
 * The unified `openhive` Docker image is used for root and non-root containers
 * alike. The executor spawns SDK processes within the current container, never
 * across container boundaries.
 *
 * @module executor/executor
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { AgentExecutor, AgentInitConfig, EventBus, Logger } from '../domain/index.js';
import { AgentStatus, ProviderType } from '../domain/index.js';
import { ConflictError, NotFoundError } from '../domain/errors.js';

// INV-06: Same image everywhere

interface TrackedProcess {
  process: ChildProcess;
  aid: string;
  status: AgentStatus;
}

/**
 * Manages Claude Agent SDK process lifecycle for agents within a container.
 *
 * Each agent is spawned as a standalone child process. The executor tracks
 * running state, handles graceful/forced shutdown, and publishes crash events.
 */
export class AgentExecutorImpl implements AgentExecutor {
  private readonly processes = new Map<string, TrackedProcess>();
  private readonly eventBus: EventBus;
  private readonly logger: Logger;

  constructor(eventBus: EventBus, logger: Logger) {
    this.eventBus = eventBus;
    this.logger = logger;
  }

  /**
   * Spawns a new Claude Agent SDK process for the given agent.
   *
   * @param agent - Agent initialization config with resolved provider, tools, and prompt
   * @param workspacePath - Absolute path to the agent's workspace directory
   * @param _taskId - Optional task ID to associate with this SDK session
   * @throws {ConflictError} If the agent is already running
   */
  async start(
    agent: AgentInitConfig,
    workspacePath: string,
    _taskId?: string,
  ): Promise<void> {
    if (this.processes.has(agent.aid)) {
      throw new ConflictError(`Agent ${agent.aid} is already running`);
    }

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      OPENHIVE_AGENT_AID: agent.aid,
      OPENHIVE_AGENT_NAME: agent.name,
      OPENHIVE_AGENT_MODEL: agent.model,
    };

    // Map provider type to environment variables
    if (agent.provider.type === ProviderType.OAuth && agent.provider.oauthToken) {
      env['CLAUDE_CODE_OAUTH_TOKEN'] = agent.provider.oauthToken;
    } else if (agent.provider.type === ProviderType.AnthropicDirect) {
      if (agent.provider.apiKey) {
        env['ANTHROPIC_API_KEY'] = agent.provider.apiKey;
      }
      if (agent.provider.baseUrl) {
        env['ANTHROPIC_BASE_URL'] = agent.provider.baseUrl;
      }
    }

    const child = spawn('node', ['dist/agent-entry.js'], {
      cwd: workspacePath,
      env,
      stdio: 'pipe',
    });

    const tracked: TrackedProcess = {
      process: child,
      aid: agent.aid,
      status: AgentStatus.Starting,
    };

    this.processes.set(agent.aid, tracked);

    this.logger.info('Agent process spawned', {
      aid: agent.aid,
      pid: child.pid,
      workspacePath,
    });

    // Register crash handler for unexpected exit
    child.on('exit', (code, signal) => {
      const entry = this.processes.get(agent.aid);
      if (!entry) return;

      // If still tracked (not removed by stop/kill), it's a crash
      entry.status = AgentStatus.Error;
      this.processes.delete(agent.aid);

      this.logger.error('Agent process crashed', {
        aid: agent.aid,
        exitCode: code,
        signal,
      });

      this.eventBus.publish({
        type: 'agent.crashed',
        data: {
          aid: agent.aid,
          exitCode: code,
          signal,
        },
        timestamp: Date.now(),
        source: 'executor',
      });
    });
  }

  /**
   * Gracefully stops an agent's SDK process.
   * Sends SIGTERM, waits up to timeoutMs, then SIGKILL if still alive.
   *
   * @param agentAid - Agent ID identifying which process to stop
   * @param timeoutMs - Maximum time in milliseconds to wait for graceful shutdown
   * @throws {NotFoundError} If the agent is not running
   */
  async stop(agentAid: string, timeoutMs: number = 30000): Promise<void> {
    const tracked = this.processes.get(agentAid);
    if (!tracked) {
      throw new NotFoundError(`Agent ${agentAid} is not running`);
    }

    const child = tracked.process;

    // Remove from tracking immediately so the exit handler doesn't fire as a crash
    this.processes.delete(agentAid);

    return new Promise<void>((resolve) => {
      let resolved = false;

      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve();
      };

      child.on('exit', cleanup);

      // Send SIGTERM for graceful shutdown
      child.kill('SIGTERM');

      this.logger.info('Sent SIGTERM to agent', { aid: agentAid });

      // After timeout, force kill
      const timer = setTimeout(() => {
        if (resolved) return;
        this.logger.warn('Agent did not exit within timeout, sending SIGKILL', {
          aid: agentAid,
          timeoutMs,
        });
        child.kill('SIGKILL');
      }, timeoutMs);
    });
  }

  /**
   * Immediately terminates an agent's SDK process with SIGKILL.
   *
   * @param agentAid - Agent ID identifying which process to kill
   * @throws {NotFoundError} If the agent is not running
   */
  kill(agentAid: string): void {
    const tracked = this.processes.get(agentAid);
    if (!tracked) {
      throw new NotFoundError(`Agent ${agentAid} is not running`);
    }

    // Remove from tracking before kill so exit handler doesn't fire as crash
    this.processes.delete(agentAid);

    tracked.process.kill('SIGKILL');

    this.logger.info('Sent SIGKILL to agent', { aid: agentAid });
  }

  /**
   * Checks whether an agent's SDK process is currently running.
   *
   * @param agentAid - Agent ID to check
   * @returns true if the agent's process is tracked, false otherwise
   */
  isRunning(agentAid: string): boolean {
    return this.processes.has(agentAid);
  }

  /**
   * Returns the current runtime status of an agent's SDK process.
   *
   * @param agentAid - Agent ID to query
   * @returns The agent's current status, or undefined if not tracked
   */
  getStatus(agentAid: string): AgentStatus | undefined {
    const tracked = this.processes.get(agentAid);
    return tracked?.status;
  }
}
