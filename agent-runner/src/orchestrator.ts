/**
 * Container Orchestrator - Manages agent lifecycle and message routing.
 *
 * Receives container_init from Go backend, initializes agent configs,
 * routes task_dispatch to agents, forwards tool calls via WebSocket,
 * and sends heartbeat every 30s.
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

const HEARTBEAT_INTERVAL_MS = 30_000;

export interface AgentState {
  config: AgentInitConfig;
  status: AgentStatusType;
  mcpBridge: MCPBridge;
  idleTimer: ReturnType<typeof setTimeout> | null;
  elapsedSeconds: number;
  taskStartTime: number | null;
}

export class Orchestrator {
  private readonly wsClient: WSClient;
  private readonly agents = new Map<string, AgentState>();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private teamId = '';
  private mainAssistant = false;

  constructor(wsClient: WSClient) {
    this.wsClient = wsClient;
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

    // Store agent configs (do NOT start agents yet - on-demand per AC20)
    for (const agentConfig of msg.agents) {
      const mcpBridge = new MCPBridge(agentConfig.aid, (wsMsg) => {
        this.wsClient.send(wsMsg);
      });

      this.agents.set(agentConfig.aid, {
        config: agentConfig,
        status: 'idle',
        mcpBridge,
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

    // Task execution will be handled by the AgentExecutor (Issue #13)
    // For now, we just update state
  }

  private onShutdown(msg: ShutdownMsg): void {
    console.log(`Shutdown requested: ${msg.reason}, timeout: ${msg.timeout}s`);

    // Stop heartbeat
    this.stopHeartbeat();

    // Stop all agents
    for (const [aid, agent] of this.agents) {
      if (agent.idleTimer) {
        clearTimeout(agent.idleTimer);
      }
      agent.status = 'stopped';
      agent.mcpBridge.rejectAll('Container shutting down');
      console.log(`Agent ${aid} stopped`);
    }

    // Close WebSocket
    this.wsClient.close();
  }

  private onToolResult(msg: ToolResultMsg): void {
    // Route tool result to the correct agent's MCP bridge
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
        status: state.status,
        detail: state.status === 'busy' ? 'processing task' : '',
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
  }
}
