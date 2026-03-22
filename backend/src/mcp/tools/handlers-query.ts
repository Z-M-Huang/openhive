/**
 * Query, event, and trigger tool handlers.
 *
 * @module mcp/tools/handlers-query
 */

import crypto from 'node:crypto';
import { AgentStatus, ContainerHealth } from '../../domain/index.js';
import { NotFoundError, ValidationError } from '../../domain/errors.js';
import { GetTeamSchema, GetTaskSchema, GetHealthSchema, InspectTopologySchema, RegisterWebhookSchema, TOOL_SCHEMAS } from './schemas.js';
import type { ToolContext, ToolHandler } from './types.js';

export function createQueryHandlers(ctx: ToolContext): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  handlers.set('get_team', async (args) => {
    const parsed = GetTeamSchema.parse(args);

    const team = ctx.orgChart.getTeamBySlug(parsed.slug);
    if (!team) {
      throw new NotFoundError(`Team '${parsed.slug}' not found`);
    }

    return {
      slug: team.slug,
      tid: team.tid,
      ...(team.coordinatorAid ? { coordinator_aid: team.coordinatorAid } : {}),
      agent_aids: team.agentAids,
      health: team.health,
    };
  });

  handlers.set('get_task', async (args) => {
    const parsed = GetTaskSchema.parse(args);

    const task = await ctx.taskStore.get(parsed.task_id);

    if (parsed.status && task.status !== parsed.status) {
      throw new NotFoundError(
        `Task '${parsed.task_id}' found but status is '${task.status}', not '${parsed.status}'`
      );
    }

    return {
      task_id: task.id,
      status: task.status,
      agent_aid: task.agent_aid,
      prompt: task.prompt,
      result: task.result,
      error: task.error,
      created_at: task.created_at,
      completed_at: task.completed_at,
    };
  });

  handlers.set('get_health', async (args) => {
    const parsed = GetHealthSchema.parse(args);

    if (parsed.scope) {
      const team = ctx.orgChart.getTeamBySlug(parsed.scope);
      if (team) {
        const health = ctx.healthMonitor.getHealth(team.tid);
        const agents = ctx.orgChart.getAgentsByTeam(parsed.scope);
        const entries = [
          { id: team.tid, type: 'container' as const, status: health, detail: `Team '${parsed.scope}'` },
          ...agents.map((a) => ({
            id: a.aid,
            type: 'agent' as const,
            status: ctx.healthMonitor.getAgentHealth(a.aid) ?? AgentStatus.Idle,
            detail: a.name,
          })),
        ];
        return { entries };
      }

      const agentHealth = ctx.healthMonitor.getAgentHealth(parsed.scope);
      if (agentHealth) {
        return {
          entries: [{ id: parsed.scope, type: 'agent' as const, status: agentHealth, detail: parsed.scope }],
        };
      }

      throw new NotFoundError(`Scope '${parsed.scope}' not found`);
    }

    const allHealth = ctx.healthMonitor.getAllHealth();
    const entries: Array<{ id: string; type: 'agent' | 'container'; status: AgentStatus | ContainerHealth; detail: string }> = [];

    for (const [tid, health] of allHealth) {
      const team = ctx.orgChart.getTeam(tid);
      entries.push({
        id: tid,
        type: 'container',
        status: health,
        detail: team?.slug ?? tid,
      });
    }

    return { entries };
  });

  handlers.set('inspect_topology', async (args) => {
    const parsed = InspectTopologySchema.parse(args);
    const tree = ctx.orgChart.getTopology(parsed.depth);
    return { tree };
  });

  handlers.set('register_webhook', async (args, _agentAid, teamSlug) => {
    const parsed = RegisterWebhookSchema.parse(args);

    const reservedPrefixes = ['api', 'health', 'ws', 'hooks', 'static', 'admin'];
    if (reservedPrefixes.some(prefix => parsed.path.toLowerCase().startsWith(prefix))) {
      throw new ValidationError(`Webhook path '${parsed.path}' uses reserved prefix`);
    }

    const registrationId = crypto.randomUUID();
    const webhookUrl = `/api/v1/hooks/${parsed.path}`;

    ctx.eventBus.publish({
      type: 'webhook.registered',
      data: {
        registration_id: registrationId,
        path: parsed.path,
        target_team: parsed.target_team,
        event_type: parsed.event_type,
        registered_by: teamSlug,
      },
      timestamp: Date.now(),
    });

    // Import registerWebhook dynamically to avoid circular dependency
    const { registerWebhook } = await import('../../api/routes/index.js');
    registerWebhook(registrationId, parsed.path, parsed.target_team);

    return { webhook_url: webhookUrl, registration_id: registrationId };
  });

  handlers.set('register_trigger', async (args, agentAid, teamSlug) => {
    const parsed = TOOL_SCHEMAS['register_trigger'].parse(args) as {
      name: string; schedule: string; target_team: string; prompt: string; reply_to?: string;
    };

    const callerAgent = ctx.orgChart.getAgent(agentAid);
    const isMainAssistant = callerAgent?.role === 'main_assistant';
    if (!isMainAssistant && teamSlug !== parsed.target_team) {
      throw new Error(`Unauthorized: agent in team '${teamSlug}' cannot register triggers for team '${parsed.target_team}'`);
    }

    const cron = await import('node-cron');
    if (!cron.validate(parsed.schedule)) {
      throw new Error(`Invalid cron expression: '${parsed.schedule}'`);
    }

    const existingTriggers = ctx.triggerScheduler.listTriggers();
    const teamTriggerCount = existingTriggers.filter(t => t.targetTeam === parsed.target_team).length;
    if (teamTriggerCount >= 10) {
      throw new Error(`Trigger limit reached: team '${parsed.target_team}' already has ${teamTriggerCount} triggers (max 10)`);
    }

    // Use explicit reply_to if provided; fall back to current task's channel
    let replyTo: string | undefined = parsed.reply_to;
    if (!replyTo) {
      const teamTasks = await ctx.taskStore.listByTeam(teamSlug);
      const sorted = teamTasks.sort((a, b) => b.created_at - a.created_at);
      replyTo = sorted.find(t => t.origin_chat_jid)?.origin_chat_jid ?? undefined;
    }

    ctx.triggerScheduler.addCronTrigger(parsed.name, parsed.schedule, parsed.target_team, parsed.prompt, undefined, replyTo);

    ctx.logger.info('Cron trigger registered via tool', {
      name: parsed.name,
      schedule: parsed.schedule,
      target_team: parsed.target_team,
      registered_by: agentAid,
    });

    return { trigger_name: parsed.name, schedule: parsed.schedule, status: 'registered' };
  });

  return handlers;
}
