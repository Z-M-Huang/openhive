/**
 * Task, messaging, and orchestration tool handlers.
 *
 * @module mcp/tools/handlers-task
 */

import crypto from 'node:crypto';
import { TaskStatus } from '../../domain/index.js';
import { NotFoundError } from '../../domain/errors.js';
import { assertValidTransition, validateAID } from '../../domain/domain.js';
import { CreateTaskSchema, DispatchSubtaskSchema, UpdateTaskStatusSchema, SendMessageSchema, EscalateSchema } from './schemas.js';
import type { ToolContext, ToolHandler } from './types.js';

export function createTaskHandlers(ctx: ToolContext): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  handlers.set('create_task', async (args, agentAid) => {
    const parsed = CreateTaskSchema.parse(args);
    validateAID(parsed.agent_aid);

    const taskId = crypto.randomUUID();

    if (parsed.blocked_by && parsed.blocked_by.length > 0) {
      await ctx.taskStore.validateDependencies(taskId, parsed.blocked_by);
    }

    const callerAgent = ctx.orgChart.getAgent(agentAid);

    await ctx.taskStore.create({
      id: taskId,
      parent_id: '',
      team_slug: callerAgent?.teamSlug ?? '',
      agent_aid: parsed.agent_aid,
      title: parsed.prompt.slice(0, 120),
      status: TaskStatus.Pending,
      prompt: parsed.prompt,
      result: '',
      error: '',
      blocked_by: parsed.blocked_by ?? null,
      priority: parsed.priority ?? 0,
      retry_count: 0,
      max_retries: parsed.max_retries ?? 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      completed_at: null,
      origin_chat_jid: parsed.origin_chat_jid ?? null,
    });

    return { task_id: taskId };
  });

  handlers.set('dispatch_subtask', async (args, agentAid) => {
    const parsed = DispatchSubtaskSchema.parse(args);
    validateAID(parsed.agent_aid);

    const taskId = crypto.randomUUID();

    // Validate parent exists
    await ctx.taskStore.get(parsed.parent_task_id);

    if (parsed.blocked_by && parsed.blocked_by.length > 0) {
      await ctx.taskStore.validateDependencies(taskId, parsed.blocked_by);
    }

    const callerAgent = ctx.orgChart.getAgent(agentAid);

    await ctx.taskStore.create({
      id: taskId,
      parent_id: parsed.parent_task_id,
      team_slug: callerAgent?.teamSlug ?? '',
      agent_aid: parsed.agent_aid,
      title: parsed.prompt.slice(0, 120),
      status: TaskStatus.Pending,
      prompt: parsed.prompt,
      result: '',
      error: '',
      blocked_by: parsed.blocked_by ?? null,
      priority: parsed.priority ?? 0,
      retry_count: 0,
      max_retries: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      completed_at: null,
    });

    // Dispatch via WebSocket to target container
    const targetAgent = ctx.orgChart.getAgent(parsed.agent_aid);
    if (targetAgent) {
      const targetTeam = ctx.orgChart.getTeamBySlug(targetAgent.teamSlug);
      if (targetTeam && targetTeam.containerId) {
        ctx.wsHub.send(targetTeam.tid, {
          type: 'task_dispatch',
          data: {
            task_id: taskId,
            agent_aid: parsed.agent_aid,
            prompt: parsed.prompt,
            blocked_by: parsed.blocked_by ?? [],
          },
        });
      }
    }

    return { task_id: taskId };
  });

  handlers.set('update_task_status', async (args) => {
    const parsed = UpdateTaskStatusSchema.parse(args);
    const task = await ctx.taskStore.get(parsed.task_id);

    assertValidTransition(task.status, parsed.status);

    const now = Date.now();
    const isTerminal = parsed.status === TaskStatus.Completed || parsed.status === TaskStatus.Cancelled;

    await ctx.taskStore.update({
      ...task,
      status: parsed.status,
      result: parsed.result ?? task.result,
      error: parsed.error ?? task.error,
      updated_at: now,
      completed_at: isTerminal ? now : task.completed_at,
    });

    return { status: parsed.status };
  });

  handlers.set('send_message', async (args, agentAid) => {
    const parsed = SendMessageSchema.parse(args);

    const targetAgent = ctx.orgChart.getAgent(parsed.target_aid);
    if (!targetAgent) {
      throw new NotFoundError(`Target agent '${parsed.target_aid}' not found`);
    }

    const correlationId = parsed.correlation_id ?? crypto.randomUUID();

    await ctx.messageStore.create({
      id: correlationId,
      chat_jid: `${agentAid}:${parsed.target_aid}`,
      role: 'agent',
      content: parsed.content,
      type: 'text',
      timestamp: Date.now(),
    });

    const targetTeam = ctx.orgChart.getTeamBySlug(targetAgent.teamSlug);
    if (targetTeam) {
      ctx.wsHub.send(targetTeam.tid, {
        type: 'agent_message',
        data: {
          correlation_id: correlationId,
          source_aid: agentAid,
          target_aid: parsed.target_aid,
          content: parsed.content,
        },
      });
    }

    return { delivered: true };
  });

  handlers.set('escalate', async (args, agentAid) => {
    const parsed = EscalateSchema.parse(args);

    const agent = ctx.orgChart.getAgent(agentAid);
    if (!agent) {
      throw new NotFoundError(`Agent '${agentAid}' not found`);
    }

    const team = ctx.orgChart.getTeamBySlug(agent.teamSlug);
    if (!team) {
      throw new NotFoundError(`Team '${agent.teamSlug}' not found`);
    }

    const correlationId = crypto.randomUUID();

    const task = await ctx.taskStore.get(parsed.task_id);
    assertValidTransition(task.status, TaskStatus.Escalated);
    await ctx.taskStore.update({
      ...task,
      status: TaskStatus.Escalated,
      updated_at: Date.now(),
    });

    ctx.eventBus.publish({
      type: 'task.escalated',
      data: {
        task_id: parsed.task_id,
        agent_aid: agentAid,
        reason: parsed.reason,
        context: parsed.context,
        correlation_id: correlationId,
      },
      timestamp: Date.now(),
      source: agentAid,
    });

    return {
      message: `Escalated from team '${team.slug}'`,
      correlation_id: correlationId,
    };
  });

  return handlers;
}
