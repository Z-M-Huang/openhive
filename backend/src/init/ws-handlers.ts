/**
 * WebSocket handler factories for root-mode container connections.
 *
 * Each factory takes injected dependencies as parameters (no module-level globals)
 * and returns a handler function matching the WSServerCallbacks interface.
 *
 * @module init/ws-handlers
 */

import { resolve } from 'node:path';

import { LogLevel } from '../domain/enums.js';
import { DomainError, mapDomainErrorToWSError } from '../domain/errors.js';
import type { Logger, OrgChart, CredentialStore, MCPServerConfig, ResolvedProvider, WSMessage } from '../domain/interfaces.js';
import { resolveSecretsTemplatesInObject } from '../mcp/tools/index.js';
import type { WSServer } from '../websocket/server.js';
import type { TokenManagerImpl } from '../websocket/token-manager.js';
import type { ShutdownState } from './types.js';

// ---------------------------------------------------------------------------
// Dependencies context
// ---------------------------------------------------------------------------

export interface WSHandlerDeps {
  logger: Logger;
  shutdownState: ShutdownState;
  orgChart: OrgChart;
  wsServer: WSServer;
  tokenManager: TokenManagerImpl;
  credentialStore: CredentialStore;
  resolveProviderPreset: (presetName: string) => ResolvedProvider;
  resolveModel: (tier: string, provider: ResolvedProvider) => string;
}

// ---------------------------------------------------------------------------
// onMessage handler
// ---------------------------------------------------------------------------

export function createOnMessageHandler(
  deps: WSHandlerDeps,
): (tid: string, message: WSMessage) => void {
  const { logger, shutdownState, orgChart, wsServer } = deps;

  return async (tid: string, message: { type: string; data: Record<string, unknown> }) => {
    logger.debug('WS message received', { tid, type: message.type });

    switch (message.type) {
      case 'heartbeat': {
        const agents = message.data['agents'] as Array<{ aid: string; status: string; detail: string }>;
        if (agents) {
          shutdownState.healthMonitor?.recordHeartbeat(tid, agents.map(a => ({
            aid: a.aid,
            status: a.status as 'idle' | 'busy' | 'error' | 'starting',
            detail: a.detail,
          })));
        }
        break;
      }

      case 'tool_call': {
        // Forward tool calls from containers to orchestrator
        const { call_id, tool_name, arguments: args, agent_aid } = message.data as {
          call_id: string;
          tool_name: string;
          arguments: Record<string, unknown>;
          agent_aid: string;
        };
        if (shutdownState.orchestrator) {
          shutdownState.orchestrator.handleToolCall(agent_aid, tool_name, args, call_id).then((result) => {
            wsServer.send(tid, { type: 'tool_result', data: { call_id, result } });
          }).catch((err) => {
            const isDomainError = err instanceof DomainError;
            const errorCode = isDomainError ? mapDomainErrorToWSError(err) : 'INTERNAL_ERROR';
            const errorMessage = isDomainError ? err.message : 'Internal error processing tool call';
            wsServer.send(tid, { type: 'tool_result', data: { call_id, error_code: errorCode, error_message: errorMessage } });
            logger.error('tool_call handler failed', { call_id, error: String(err) });
          });
        }
        break;
      }

      case 'task_result': {
        // Forward task results to orchestrator
        const { task_id, agent_aid, status, result, error } = message.data as {
          task_id: string;
          agent_aid: string;
          status: 'completed' | 'failed' | 'pending';
          result?: string;
          error?: string;
        };
        // Map wire status to TaskStatus. 'pending' = agent was busy, re-queue task.
        const taskStatus = status === 'completed' ? 'completed'
          : status === 'pending' ? 'pending'
          : 'failed';
        if (shutdownState.orchestrator) {
          shutdownState.orchestrator.handleTaskResult(task_id, agent_aid, taskStatus, result, error).catch((err) => {
            logger.error('task_result handler failed', { task_id, error: String(err) });
          });
        }
        break;
      }

      case 'escalation': {
        // Forward escalations to orchestrator
        const { task_id, agent_aid, reason, context } = message.data as {
          task_id: string;
          agent_aid: string;
          reason: string;
          context: Record<string, unknown>;
        };
        if (shutdownState.orchestrator) {
          shutdownState.orchestrator.handleEscalation(agent_aid, task_id, reason as any, context).catch((err) => {
            logger.error('escalation handler failed', { task_id, error: String(err) });
          });
        }
        break;
      }

      case 'ready': {
        // Container ready notification - validate protocol and update state
        const { team_id, agent_count, protocol_version } = message.data as {
          team_id: string;
          agent_count: number;
          protocol_version: string;
        };

        // Validate protocol version (major version must match)
        // Wiki: "Root validates protocol_version -- major mismatch causes rejection"
        const expectedMajor = '1';
        const receivedMajor = protocol_version.split('.')[0];
        if (receivedMajor !== expectedMajor) {
          logger.error('Protocol version mismatch - disconnecting container', {
            tid,
            expected: expectedMajor,
            received: protocol_version,
          });
          // Disconnect the container with protocol error (1002)
          if (shutdownState.wsServer) {
            shutdownState.wsServer.disconnect(tid, 1002, `Protocol version mismatch: expected ${expectedMajor}.x, got ${protocol_version}`);
          }
          break;
        }

        // Update health monitor to mark container as running
        if (shutdownState.healthMonitor) {
          shutdownState.healthMonitor.recordHeartbeat(tid, []);
        }

        // Mark the team as ready (for create_team polling)
        if (shutdownState.wsServer) {
          shutdownState.wsServer.setReady(tid);
        }

        logger.info('Container ready', { tid, team_id, agent_count, protocol_version });

        // State replay (AC-B5): re-dispatch any tasks that were in-flight when
        // the container disconnected. Query unacknowledged task IDs for this TID,
        // fetch their data from the task store, and re-send task_dispatch messages
        // with a 'retried: true' flag.
        if (shutdownState.dispatchTracker && shutdownState.stores?.taskStore && shutdownState.wsServer) {
          const unacknowledged = shutdownState.dispatchTracker.getUnacknowledged(tid);
          if (unacknowledged.length > 0) {
            logger.info('Replaying in-flight dispatches after reconnect', {
              tid,
              count: unacknowledged.length,
            });
            for (const taskId of unacknowledged) {
              try {
                const task = await shutdownState.stores.taskStore.get(taskId);
                shutdownState.wsServer.send(tid, {
                  type: 'task_dispatch',
                  data: {
                    task_id: task.id,
                    agent_aid: task.agent_aid,
                    prompt: task.prompt,
                    blocked_by: task.blocked_by ?? [],
                    retried: true,
                  },
                });
                logger.info('Replayed task dispatch after reconnect', { tid, task_id: taskId });
              } catch (err) {
                logger.error('Failed to replay task dispatch', {
                  tid,
                  task_id: taskId,
                  error: String(err),
                });
              }
            }
          }
        }

        break;
      }

      case 'log_event': {
        // Write log events from containers to the log store
        // Protocol: { level: 'debug'|'info'|'warn'|'error', source_aid, message, metadata, timestamp }
        const { level, source_aid, message: logMessage, metadata, timestamp } = message.data as {
          level: 'debug' | 'info' | 'warn' | 'error';
          source_aid: string;
          message: string;
          metadata?: Record<string, unknown>;
          timestamp: string;
        };
        if (shutdownState.stores?.logStore) {
          const team = orgChart.getTeam(tid);
          // Map string level to numeric
          const levelMap: Record<string, number> = { debug: 0, info: 10, warn: 30, error: 40 };
          await shutdownState.stores.logStore.create([{
            id: 0,
            level: (levelMap[level] ?? 10) as LogLevel,
            event_type: 'log_event',
            component: '',
            action: '',
            message: logMessage,
            params: metadata ? JSON.stringify(metadata) : '',
            team_slug: team?.slug ?? '',
            task_id: '',
            agent_aid: source_aid,
            request_id: '',
            correlation_id: '',
            error: '',
            duration_ms: 0,
            created_at: new Date(timestamp).getTime() || Date.now(),
          }]);
        }
        break;
      }

      case 'status_update': {
        // Update agent status in org chart
        const { agent_aid, status, detail } = message.data as {
          agent_aid: string;
          status: string;
          detail?: string;
        };
        logger.info('Agent status update', { agent_aid, status, detail });

        // Update the agent's status in the org chart
        const agent = orgChart.getAgent(agent_aid);
        if (agent) {
          const validStatuses = ['idle', 'busy', 'error', 'starting'] as const;
          const newStatus = validStatuses.includes(status as typeof validStatuses[number])
            ? (status as typeof validStatuses[number])
            : agent.status;
          orgChart.updateAgent({
            ...agent,
            status: newStatus,
          });
        }
        break;
      }

      case 'agent_ready': {
        // Hot-reload acknowledgment for dynamic agent addition
        // Protocol: { aid: string }
        const { aid } = message.data as { aid: string };
        logger.info('Agent ready (hot-reload)', { aid, tid });

        // Update agent status to idle in org chart
        const agent = orgChart.getAgent(aid);
        if (agent) {
          orgChart.updateAgent({
            ...agent,
            status: 'idle',
          });
        }
        break;
      }

      case 'org_chart_update': {
        // Handle topology changes from containers (e.g., sub-team creation, agent addition)
        const { action: updateAction, team_slug, agent_aid } = message.data as {
          action: string;
          team_slug?: string;
          agent_aid?: string;
        };
        logger.info('Org chart update notification', { tid, action: updateAction, team_slug, agent_aid });

        // Handle specific actions
        switch (updateAction) {
          case 'agent_added':
            // Agent was added in container; already handled via agent_added message
            break;
          case 'team_created':
            // Sub-team was created; update org chart if we have team info
            if (team_slug) {
              const childTeam = orgChart.getTeamBySlug(team_slug);
              if (!childTeam) {
                logger.warn('org_chart_update: team not found for creation', { team_slug });
              }
            }
            break;
          case 'agent_removed':
            // Agent was explicitly removed from a container.
            // Acknowledge its in-flight dispatches so grace-period timers are cleared
            // and the tasks are not replayed to the new container (the agent is gone).
            if (agent_aid) {
              const dt = shutdownState.dispatchTracker;
              if (dt) {
                const agentTaskIds = dt.getUnacknowledgedByAgent(agent_aid);
                for (const taskId of agentTaskIds) {
                  dt.acknowledgeDispatch(taskId);
                }
                if (agentTaskIds.length > 0) {
                  logger.info('dispatch.clear_on_agent_removed', { agent_aid, cleared: agentTaskIds.length });
                }
              }
              orgChart.removeAgent(agent_aid);
            }
            break;
          default:
            logger.debug('org_chart_update: unhandled action', { action: updateAction });
        }
        break;
      }

      default:
        logger.debug('Unhandled WS message type', { type: message.type });
    }
  };
}

// ---------------------------------------------------------------------------
// onConnect handler
// ---------------------------------------------------------------------------

export function createOnConnectHandler(
  deps: WSHandlerDeps,
): (tid: string, isReconnect: boolean) => void {
  // NOTE: Do NOT destructure wsServer here — it's a forward reference (null at construction,
  // patched later in phase-coordination.ts). Access via deps.wsServer at call time.
  const { logger, orgChart, tokenManager, credentialStore } = deps;
  const { resolveProviderPreset, resolveModel } = deps;

  return async (tid: string, isReconnect: boolean) => {
    logger.info('Container connected', { tid, isReconnect });

    // Reconnecting containers already have their configuration -- skip container_init
    // so they don't reset their in-progress agent state (AC-A3).
    if (isReconnect) {
      logger.info('Skipping container_init for reconnecting container', { tid });
      return;
    }

    // Send container_init with resolved secrets templates (AC-L6-11)
    let team = orgChart.getTeam(tid);
    if (!team) {
      // Fallback: container may have been restarted with a new TID.
      // Extract slug from TID format tid-<slug>-<hexsuffix> and look up by slug.
      const slugMatch = tid.match(/^tid-(.+)-[0-9a-f]{6,}$/);
      if (slugMatch) {
        const slug = slugMatch[1];
        team = orgChart.getTeamBySlug(slug);
        if (team && team.tid !== tid) {
          orgChart.updateTeamTid(slug, tid);
          logger.info('Reconciled team TID on connect', { tid, slug, old_tid: team.tid });
          // Persist new TID to team.yaml (best-effort)
          try {
            const fs = await import('node:fs/promises');
            const yaml = await import('yaml');
            const teamYamlPath = resolve(team.workspacePath, 'team.yaml');
            const raw = await fs.readFile(teamYamlPath, 'utf-8');
            const content = yaml.parse(raw) as Record<string, unknown>;
            content.tid = tid;
            await fs.writeFile(teamYamlPath, yaml.stringify(content), 'utf-8');
          } catch { /* best-effort */ }
          // Re-fetch after TID update
          team = orgChart.getTeam(tid);
        }
      }
    }
    if (!team) {
      logger.warn('Connected team not found in org chart', { tid });
      return;
    }

    try {
      // Load raw team.yaml content for agents and mcp_servers
      const teamYamlPath = resolve(team.workspacePath, 'team.yaml');
      let rawTeamConfig: Record<string, unknown> = {};
      try {
        const yaml = await import('yaml');
        const fs = await import('node:fs/promises');
        const raw = await fs.readFile(teamYamlPath, 'utf-8');
        rawTeamConfig = yaml.parse(raw) as Record<string, unknown>;
      } catch (yamlError) {
        logger.warn('Failed to load team.yaml', { path: teamYamlPath, error: String(yamlError) });
      }

      // Load credentials for this team
      const credentials = await credentialStore.listByTeam(team.slug);
      const secrets: Record<string, string> = {};

      // FileCredentialStore returns plaintext directly -- no decryption needed
      for (const cred of credentials) {
        secrets[cred.name] = cred.encrypted_value;
      }

      // Resolve {secrets.XXX} templates in MCP servers
      let mcpServers: MCPServerConfig[] | undefined;
      const rawMcpServers = rawTeamConfig['mcp_servers'];
      if (rawMcpServers && Array.isArray(rawMcpServers)) {
        mcpServers = rawMcpServers.map((server: Record<string, unknown>) => ({
          name: String(server['name'] || ''),
          command: String(server['command'] || ''),
          args: (server['args'] as string[]) || [],
          env: resolveSecretsTemplatesInObject(
            (server['env'] as Record<string, string>) || {},
            secrets
          ),
        }));
      }

      // Build agent configs from team config
      const rawAgents = rawTeamConfig['agents'];
      const agents = Array.isArray(rawAgents) ? rawAgents : [];

      // Generate a session token for reconnect authentication (AC-A2).
      // This is a long-lived token delivered via container_init so the container
      // can re-authenticate on reconnect without needing a new one-time token.
      const sessionToken = tokenManager.generateSession(tid);

      // Build container_init message
      const containerInitData = {
        protocol_version: '1.0',
        is_main_assistant: team.slug === 'main',
        coordinator_aid: team.coordinatorAid ?? null,
        team_config: rawTeamConfig as unknown,
        agents: agents.map((a: Record<string, unknown>) => {
          // Resolve the provider preset for this agent (fall back to 'default')
          const resolvedProvider = resolveProviderPreset(String(a['provider'] || 'default'));
          const isCoordinator = String(a['aid'] || '') === team.coordinatorAid;
          let systemPrompt = String(a['system_prompt'] ?? a['description'] ?? '');

          // Enrich coordinator's system prompt with team roster
          if (isCoordinator && agents.length > 1) {
            const roster = agents.map((m: Record<string, unknown>) =>
              `- ${String(m['name'] || '')} (${String(m['aid'] || '')}): ${String(m['description'] ?? '').slice(0, 100)}`
            ).join('\n');
            systemPrompt = `You are the team coordinator for "${team.slug}".\n\nTeam Members:\n${roster}\n\n${systemPrompt}`;
          }

          return {
            aid: String(a['aid'] || ''),
            name: String(a['name'] || ''),
            description: String(a['description'] || ''),
            role: String(a['role'] || 'member'),
            model: resolveModel(String(a['model_tier'] || 'sonnet'), resolvedProvider),
            tools: (a['tools'] as string[]) || [],
            provider: resolvedProvider,
            ...(systemPrompt ? { systemPrompt } : {}),
            ...(mcpServers?.length ? { mcpServers } : {}),
          };
        }),
        secrets,
        mcp_servers: mcpServers,
        session_token: sessionToken,
      };

      // Send container_init via hub
      // NOTE: Do NOT log containerInitData -- it contains API keys in each agent's provider field.
      // The log below intentionally omits the payload (AC16).
      const messageStr = JSON.stringify({ type: 'container_init', data: containerInitData });
      deps.wsServer.send(tid, JSON.parse(messageStr));
      logger.info('Sent container_init to team', { tid, team_slug: team.slug, agent_count: agents.length });
    } catch (initError) {
      logger.error('Failed to send container_init — disconnecting', { tid, error: String(initError) });
      deps.wsServer.disconnect(tid, 1011, 'container_init failed');
    }
  };
}

// ---------------------------------------------------------------------------
// onDisconnect handler
// ---------------------------------------------------------------------------

export function createOnDisconnectHandler(
  deps: Pick<WSHandlerDeps, 'logger'>,
): (tid: string) => void {
  const { logger } = deps;
  return (tid: string) => {
    logger.info('Container disconnected', { tid });
  };
}
