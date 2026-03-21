/**
 * Non-root (container) mode initialization.
 *
 * Creates bridged tool handlers via MCPBridge so that agents in team containers
 * use SDK mode (not legacy child-process mode). Tool calls are forwarded to root
 * over WebSocket and responses correlated back via the event bus.
 *
 * @module init/non-root-mode
 */

import { ConfigLoaderImpl } from '../config/loader.js';
import { EventBusImpl } from '../control-plane/event-bus.js';
import { OrgChartImpl } from '../control-plane/org-chart.js';
import { OrchestratorImpl } from '../control-plane/orchestrator.js';
import { AgentExecutorImpl } from '../executor/executor.js';
import { MCPBridgeImpl } from '../mcp/bridge.js';
import { MCPRegistryImpl } from '../mcp/registry.js';
import { WSConnectionImpl } from '../websocket/connection.js';
import type { Logger } from '../domain/interfaces.js';
import type { ToolHandler } from '../mcp/tools/index.js';
import type { ShutdownState } from './types.js';

/**
 * Initializes non-root (container) mode.
 */
export async function initializeNonRootMode(
  logger: Logger,
  shutdownState: ShutdownState,
): Promise<void> {
  logger.info('Initializing non-root mode services');

  // 1. Get connection parameters from environment
  const tid = process.env['OPENHIVE_TEAM_TID'];
  const token = process.env['OPENHIVE_WS_TOKEN'];
  const rootHost = process.env['OPENHIVE_ROOT_HOST'] || 'openhive';
  const hubUrl = `ws://${rootHost}:8080`;

  if (!tid || !token) {
    throw new Error('OPENHIVE_TEAM_TID and OPENHIVE_WS_TOKEN are required in non-root mode');
  }

  // 2. Initialize event bus
  const eventBus = new EventBusImpl();
  shutdownState.eventBus = eventBus;

  // 3. Initialize MCP registry
  const mcpRegistry = new MCPRegistryImpl();

  // 4. Initialize org chart (will be populated from container_init)
  const orgChart = new OrgChartImpl();

  // 5. Connect to root WebSocket hub
  const wsConnection = new WSConnectionImpl({
    tid,
    token,
    hubUrl,
  });

  wsConnection.onClose((code, reason) => {
    logger.warn('WebSocket connection closed', { code, reason });
  });

  await wsConnection.connect();
  shutdownState.wsConnection = wsConnection;

  logger.info('Connected to root hub', { tid, hubUrl });

  // 6. Create MCPBridge for forwarding tool calls to root via WebSocket
  const mcpBridge = new MCPBridgeImpl(
    (message: Record<string, unknown>) => {
      wsConnection.send(message as unknown as import('../domain/interfaces.js').WSMessage);
    },
    logger,
  );

  // 7. Wire event bus tool.result events to MCPBridge
  // When root responds to a tool call, the orchestrator publishes tool.result
  // on the event bus. We route those to the bridge to resolve pending promises.
  eventBus.filteredSubscribe(
    (e) => e.type === 'tool.result',
    (e) => {
      const { call_id, result, error_code, error_message } = e.data as {
        call_id: string;
        result?: Record<string, unknown>;
        error_code?: string;
        error_message?: string;
      };
      if (error_code) {
        mcpBridge.handleError(call_id, error_code, error_message ?? 'Unknown error');
      } else {
        mcpBridge.handleResult(call_id, (result ?? {}) as Record<string, unknown>);
      }
    },
  );

  // 8. Create bridged tool handlers -- one per known tool name.
  // Each handler forwards the call to root via MCPBridge and returns the result.
  // This enables SDK mode in AgentExecutorImpl (agents get in-process MCP server).
  const TOOL_NAMES = [
    'spawn_container', 'stop_container', 'list_containers',
    'create_team', 'create_agent',
    'create_task', 'dispatch_subtask', 'update_task_status',
    'send_message', 'escalate',
    'save_memory', 'recall_memory',
    'create_integration', 'test_integration', 'activate_integration',
    'get_credential', 'set_credential',
    'get_team', 'get_task', 'get_health', 'inspect_topology',
    'register_webhook', 'register_trigger',
    'search_skill', 'install_skill',
    'invoke_integration',
    'browse_web',
  ];

  const bridgedHandlers = new Map<string, ToolHandler>();
  for (const toolName of TOOL_NAMES) {
    bridgedHandlers.set(toolName, async (args, agentAid, _teamSlug) => {
      return mcpBridge.callTool(toolName, args, agentAid);
    });
  }

  // 9. Initialize agent executor with bridged tool handlers (SDK mode)
  const agentExecutor = new AgentExecutorImpl(eventBus, logger);
  agentExecutor.setToolHandlers(bridgedHandlers);

  logger.info('Bridged tool handlers injected into agent executor', {
    handlerCount: bridgedHandlers.size,
  });

  // 10. Initialize orchestrator (non-root)
  const orchestrator = new OrchestratorImpl({
    configLoader: new ConfigLoaderImpl(),
    logger,
    eventBus,
    orgChart,
    wsConnection,
    agentExecutor,
    mcpRegistry,
  }, false);

  await orchestrator.start();
  shutdownState.orchestrator = orchestrator;

  logger.info('Non-root mode initialization complete');
}
