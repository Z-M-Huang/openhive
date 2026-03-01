/**
 * Container Orchestrator - Manages agent lifecycle and message routing.
 *
 * Receives container_init from Go backend, initializes agent configs,
 * routes task_dispatch to agents via AgentExecutor, forwards tool calls
 * via WebSocket, and sends heartbeat every 30s.
 */

import type {
  WSMessage,
  ContainerInitMsg,
  TaskDispatchMsg,
  ShutdownMsg,
  ToolResultMsg,
  AgentInitConfig,
  AgentStatusType,
  HeartbeatMsg,
  AgentStatus,
} from './types.js';
import {
  MSG_TYPE_CONTAINER_INIT,
  MSG_TYPE_TASK_DISPATCH,
  MSG_TYPE_SHUTDOWN,
  MSG_TYPE_TOOL_RESULT,
  MSG_TYPE_HEARTBEAT,
  MSG_TYPE_READY,
} from './types.js';
import type { WSClient } from './ws-client.js';
import { MCPBridge } from './mcp-bridge.js';
import { AgentExecutor, type SDKQueryFn } from './agent-executor.js';

const HEARTBEAT_INTERVAL_MS = 30_000;

export interface AgentState {
  config: AgentInitConfig;
  status: AgentStatusType;
  mcpBridge: MCPBridge;
  executor: AgentExecutor;
  idleTimer: ReturnType<typeof setTimeout> | null;
  elapsedSeconds: number;
  taskStartTime: number | null;
}

/**
 * Factory function type for creating SDK query functions.
 * In production, this creates a real Claude Agent SDK query function.
 * In tests, this returns a mock.
 */
export type SDKQueryFactory = (config: AgentInitConfig) => SDKQueryFn;

export class Orchestrator {
  private readonly wsClient: WSClient;
  private readonly agents = new Map<string, AgentState>();
  private readonly callIdToAid = new Map<string, string>();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private teamId = '';
  private mainAssistant = false;
  private sdkQueryFactory: SDKQueryFactory | null = null;

  constructor(wsClient: WSClient) {
    this.wsClient = wsClient;
  }

  /**
   * Set the factory function for creating SDK query functions per agent.
   * Must be called before container_init if task execution is needed.
   */
  setSDKQueryFactory(factory: SDKQueryFactory): void {
    this.sdkQueryFactory = factory;
  }

  /**
   * Handle an incoming WebSocket message from the Go backend.
   */
  handleMessage(msg: WSMessage): void {
    switch (msg.type) {
      case MSG_TYPE_CONTAINER_INIT:
        this.onContainerInit(msg.data as ContainerInitMsg);
        break;
      case MSG_TYPE_TASK_DISPATCH:
        this.onTaskDispatch(msg.data as TaskDispatchMsg);
        break;
      case MSG_TYPE_SHUTDOWN:
        this.onShutdown(msg.data as ShutdownMsg);
        break;
      case MSG_TYPE_TOOL_RESULT:
        this.onToolResult(msg.data as ToolResultMsg);
        break;
      default:
        console.warn(`Unknown message type: ${msg.type}`);
    }
  }

  private onContainerInit(msg: ContainerInitMsg): void {
    this.mainAssistant = msg.isMainAssistant;

    // Create agent state with MCP bridge and AgentExecutor for each agent.
    // Agents are NOT started yet (on-demand per AC20).
    for (const agentConfig of msg.agents) {
      // Track tool call IDs when the bridge sends them via WS
      const mcpBridge = new MCPBridge(agentConfig.aid, (wsMsg) => {
        // Intercept tool_call messages to track callId -> AID mapping
        if (wsMsg.type === 'tool_call') {
          const toolCall = wsMsg.data as { callId: string };
          if (toolCall.callId) {
            this.callIdToAid.set(toolCall.callId, agentConfig.aid);
          }
        }
        this.wsClient.send(wsMsg);
      });

      // Create the SDK query function if a factory is available.
      // In tests without a factory, we use a function that throws immediately.
      const queryFn: SDKQueryFn = this.sdkQueryFactory
        ? this.sdkQueryFactory(agentConfig)
        : (() => {
            throw new Error('No SDK query factory configured');
          }) as unknown as SDKQueryFn;

      const executor = new AgentExecutor({
        config: agentConfig,
        mcpBridge,
        sendMessage: (wsMsg) => this.wsClient.send(wsMsg),
        queryFn,
      });

      this.agents.set(agentConfig.aid, {
        config: agentConfig,
        status: 'idle',
        mcpBridge,
        executor,
        idleTimer: null,
        elapsedSeconds: 0,
        taskStartTime: null,
      });
    }

    // Start heartbeat
    this.startHeartbeat();

    // Send ready message
    const readyAgents = [...this.agents.keys()];
    this.wsClient.send({
      type: MSG_TYPE_READY,
      data: {
        teamId: this.teamId,
        agentCount: readyAgents.length,
      },
    });

    console.log(
      `Container initialized: ${msg.agents.length} agents configured, main=${msg.isMainAssistant}`,
    );
  }

  private onTaskDispatch(msg: TaskDispatchMsg): void {
    const agent = this.agents.get(msg.agentAid);
    if (!agent) {
      console.error(`Agent not found: ${msg.agentAid}`);
      return;
    }

    // Reset idle timer
    if (agent.idleTimer) {
      clearTimeout(agent.idleTimer);
      agent.idleTimer = null;
    }

    // Mark agent as busy
    agent.status = 'busy';
    agent.taskStartTime = Date.now();

    console.log(`Task ${msg.taskId} dispatched to agent ${msg.agentAid}`);

    // Execute the task via AgentExecutor (handles SDK query, sends task_result)
    agent.executor.executeTask(msg).then(() => {
      // Update orchestrator state from executor status
      agent.status = agent.executor.status;
      agent.taskStartTime = null;
    }).catch((err) => {
      console.error(`Agent ${msg.agentAid} task execution error: ${err}`);
      agent.status = 'error';
      agent.taskStartTime = null;
    });
  }

  private onShutdown(msg: ShutdownMsg): void {
    console.log(`Shutdown requested: ${msg.reason}, timeout: ${msg.timeout}s`);

    // Stop heartbeat
    this.stopHeartbeat();

    // Stop all agents and their executors
    for (const [aid, agent] of this.agents) {
      if (agent.idleTimer) {
        clearTimeout(agent.idleTimer);
      }
      agent.executor.stop();
      agent.status = 'stopped';
      agent.mcpBridge.rejectAll('Container shutting down');
      console.log(`Agent ${aid} stopped`);
    }

    // Clear callId tracking
    this.callIdToAid.clear();

    // Close WebSocket
    this.wsClient.close();
  }

  private onToolResult(msg: ToolResultMsg): void {
    // Route tool result to the correct agent using callId -> AID lookup
    const aid = this.callIdToAid.get(msg.callId);
    if (aid) {
      const agent = this.agents.get(aid);
      if (agent) {
        agent.mcpBridge.handleToolResult(msg);
        this.callIdToAid.delete(msg.callId);
        return;
      }
    }

    // Fallback: try all agents (for backwards compatibility or if mapping missed)
    for (const agent of this.agents.values()) {
      if (agent.mcpBridge.pendingCount() > 0) {
        agent.mcpBridge.handleToolResult(msg);
        return;
      }
    }
    console.warn(`No agent found with pending tool call for call_id: ${msg.callId}`);
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private sendHeartbeat(): void {
    const agents: AgentStatus[] = [];

    for (const [aid, state] of this.agents) {
      let elapsed = state.elapsedSeconds;
      if (state.taskStartTime) {
        elapsed = (Date.now() - state.taskStartTime) / 1000;
      }

      const memUsage = process.memoryUsage();

      agents.push({
        aid,
        status: state.executor.status,
        detail: state.executor.status === 'busy' ? 'processing task' : '',
        elapsedSeconds: elapsed,
        memoryMB: memUsage.rss / (1024 * 1024),
      });
    }

    const heartbeat: HeartbeatMsg = {
      teamId: this.teamId,
      agents,
    };

    try {
      this.wsClient.send({
        type: MSG_TYPE_HEARTBEAT,
        data: heartbeat,
      });
    } catch {
      // WS may be disconnected during shutdown
    }
  }

  /**
   * Returns whether this orchestrator manages the main assistant container.
   */
  isMain(): boolean {
    return this.mainAssistant;
  }

  /**
   * Set the team ID for this orchestrator.
   */
  setTeamId(teamId: string): void {
    this.teamId = teamId;
  }

  /**
   * Get an agent state by AID.
   */
  getAgent(aid: string): AgentState | undefined {
    return this.agents.get(aid);
  }

  /**
   * Get all agent states.
   */
  getAgents(): Map<string, AgentState> {
    return this.agents;
  }

  /**
   * Handle WebSocket disconnect - reject all pending tool calls.
   */
  onDisconnect(): void {
    for (const agent of this.agents.values()) {
      agent.mcpBridge.rejectAll('WebSocket disconnected');
    }
    this.callIdToAid.clear();
  }
}
