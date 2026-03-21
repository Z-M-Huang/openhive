/**
 * WebSocket message handlers for the non-root orchestrator.
 *
 * Standalone functions extracted from OrchestratorImpl to reduce file size.
 * Each function takes explicit params instead of relying on class `this`.
 *
 * @module control-plane/orchestrator-ws-handlers
 */

import type {
  Logger,
  EventBus,
  OrgChart,
  WSConnection,
  AgentExecutor,
  AgentInitConfig,
  ResolvedProvider,
  DispatchTracker,
} from '../domain/interfaces.js';
import { ConflictError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Dependencies interface
// ---------------------------------------------------------------------------

/** Dependencies needed by the WS message handlers. */
export interface WSHandlerDeps {
  logger: Logger;
  eventBus: EventBus;
  orgChart: OrgChart;
  wsConnection?: WSConnection;
  agentExecutor: AgentExecutor;
  dispatchTracker?: DispatchTracker;
}

// ---------------------------------------------------------------------------
// handleWSMessage — dispatches by message type
// ---------------------------------------------------------------------------

/**
 * Handle WebSocket message (non-root).
 */
export function handleWSMessage(
  deps: WSHandlerDeps,
  _agentConfigs: AgentInitConfig[],
  initResolve: (() => void) | undefined,
  setAgentConfigs: (configs: AgentInitConfig[]) => void,
  message: { type: string; data: Record<string, unknown> },
): void {
  switch (message.type) {
    case 'container_init':
      handleContainerInit(
        deps,
        message.data as { agents: AgentInitConfig[] },
        setAgentConfigs,
        initResolve,
      );
      break;
    case 'task_dispatch':
      handleTaskDispatch(
        deps,
        message.data as { task_id: string; agent_aid: string; prompt: string },
      );
      break;
    case 'shutdown':
      handleShutdown(deps);
      break;
    case 'agent_added': {
      // Notification that a new agent was added to this team
      // Root sends this after create_agent tool; non-root should start the agent
      const { agent } = message.data as {
        agent: { aid: string; name: string; description: string; model: string; role?: string; tools?: string[]; provider?: unknown; systemPrompt?: string };
      };
      deps.logger.info('Agent added notification', { aid: agent.aid, name: agent.name });
      // Add to local org chart
      const team = deps.orgChart?.listTeams()[0];
      if (team) {
        deps.orgChart?.addAgent({
          aid: agent.aid,
          name: agent.name,
          teamSlug: team.slug,
          role: (agent.role as 'main_assistant' | 'member') || 'member',
          status: 'idle',
          // agent.model is the resolved model name (e.g. 'claude-haiku-4-...'). The
          // tier is unavailable here — root already stored the tier in the root-side
          // OrgChart at create_agent time. Non-root containers don't serve the
          // GET /api/agents endpoint, so modelTier is left undefined on the
          // non-root org chart.
        });
      }
      // Start the agent in this container
      if (deps.agentExecutor) {
        const agentConfig: AgentInitConfig = {
          aid: agent.aid,
          name: agent.name,
          description: agent.description,
          role: agent.role || 'member',
          model: agent.model,
          tools: agent.tools || [],
          provider: agent.provider as ResolvedProvider || { type: 'anthropic_direct', models: {} },
          systemPrompt: agent.systemPrompt,
        };
        deps.agentExecutor.start(agentConfig, '/app/workspace')
          .then(() => {
            deps.logger.info('agent.started from agent_added', { aid: agent.aid });
          })
          .catch((err: Error) => {
            deps.logger.error('agent.start.failed from agent_added', {
              aid: agent.aid,
              error: err.message,
            });
          });
      }
      break;
    }
    case 'escalation_response': {
      // Response to an escalation from this container
      const { correlation_id, task_id, agent_aid, resolution, context } = message.data as {
        correlation_id: string;
        task_id: string;
        agent_aid: string;
        resolution: string;
        context: Record<string, unknown>;
      };
      deps.logger.info('Received escalation_response', { correlation_id, task_id, agent_aid, resolution });
      // Publish to event bus for MCPBridge to handle
      deps.eventBus?.publish({
        type: 'escalation.response',
        data: { correlation_id, task_id, agent_aid, resolution, context },
        timestamp: Date.now(),
      });
      break;
    }
    case 'task_cancel': {
      // Cancel a running task
      const { task_id, cascade, reason } = message.data as {
        task_id: string;
        cascade: boolean;
        reason?: string;
      };
      deps.logger.info('Received task_cancel', { task_id, cascade, reason });
      // Acknowledge the dispatch so it is not replayed after a container restart (AC-B4)
      deps.dispatchTracker?.acknowledgeDispatch(task_id);
      // Publish to event bus for handling
      deps.eventBus?.publish({
        type: 'task.cancel',
        data: { task_id, cascade, reason },
        timestamp: Date.now(),
      });
      break;
    }
    case 'tool_result': {
      // Result of a tool call made by this container
      const { call_id, result, error_code, error_message } = message.data as {
        call_id: string;
        result?: unknown;
        error_code?: string;
        error_message?: string;
      };
      deps.logger.debug('Received tool_result', { call_id, hasResult: result !== undefined, error_code });
      // Publish to event bus for MCPBridge to handle
      deps.eventBus?.publish({
        type: 'tool.result',
        data: { call_id, result, error_code, error_message },
        timestamp: Date.now(),
      });
      break;
    }
    case 'agent_message': {
      // Inter-agent message routed through root, delivered to target agent via EventBus
      const { correlation_id, source_aid, target_aid, content } = message.data as {
        correlation_id: string;
        source_aid: string;
        target_aid: string;
        content: string;
      };
      deps.logger.debug('Received agent_message', { correlation_id, source_aid, target_aid });
      // Publish to event bus for MCPBridge / agent SDK to deliver to target agent
      deps.eventBus?.publish({
        type: 'agent.message',
        data: { correlation_id, source_aid, target_aid, content },
        timestamp: Date.now(),
      });
      break;
    }
    default:
      deps.logger.debug('ws.message.unhandled', { type: message.type });
  }
}

// ---------------------------------------------------------------------------
// handleContainerInit
// ---------------------------------------------------------------------------

/**
 * Handle container_init message (non-root).
 */
export function handleContainerInit(
  deps: WSHandlerDeps,
  data: { agents: AgentInitConfig[] },
  setAgentConfigs: (configs: AgentInitConfig[]) => void,
  initResolve: (() => void) | undefined,
): void {
  deps.logger.info('container_init received', { agent_count: data.agents?.length ?? 0 });
  setAgentConfigs(data.agents ?? []);
  initResolve?.();
}

// ---------------------------------------------------------------------------
// handleTaskDispatch
// ---------------------------------------------------------------------------

/**
 * Handle task_dispatch message (non-root).
 * Dispatches the task to the local agent executor and sends task_result back to root.
 */
export function handleTaskDispatch(
  deps: WSHandlerDeps,
  data: { task_id: string; agent_aid: string; prompt: string },
): void {
  const { task_id, agent_aid, prompt } = data;
  deps.logger.info('task_dispatch received', { task_id, agent_aid });

  // Dispatch to local agent executor (async, don't block message handler)
  void deps.agentExecutor.dispatchTask(agent_aid, prompt, task_id)
    .then(({ output }) => {
      // Send task_result back to root via WS
      if (deps.wsConnection) {
        deps.wsConnection.send({
          type: 'task_result',
          data: {
            task_id,
            agent_aid,
            status: 'completed',
            result: output,
            duration: 0,
          },
        });
      }
    })
    .catch((err) => {
      if (err instanceof ConflictError) {
        // Agent busy — tell root to re-queue
        deps.logger.info('Agent busy, requesting re-queue', { task_id, agent_aid });
        if (deps.wsConnection) {
          deps.wsConnection.send({
            type: 'task_result',
            data: { task_id, agent_aid, status: 'pending', error: 'agent_busy', duration: 0 },
          });
        }
        return;
      }
      deps.logger.error('task_dispatch failed', { task_id, agent_aid, error: String(err) });
      if (deps.wsConnection) {
        deps.wsConnection.send({
          type: 'task_result',
          data: {
            task_id,
            agent_aid,
            status: 'failed',
            error: String(err),
            duration: 0,
          },
        });
      }
    });
}

// ---------------------------------------------------------------------------
// handleShutdown
// ---------------------------------------------------------------------------

/**
 * Handle shutdown message (non-root).
 */
export function handleShutdown(
  deps: WSHandlerDeps,
  stopFn?: () => Promise<void>,
): void {
  deps.logger.info('shutdown received');
  if (stopFn) {
    stopFn().catch((err) => {
      deps.logger.error('shutdown failed', { error: String(err) });
    });
  }
}
