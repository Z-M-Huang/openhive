/**
 * Task management routes.
 *
 * @module api/routes/task-routes
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Task } from '../../domain/index.js';
import { NotFoundError, ValidationError, InvalidTransitionError } from '../../domain/errors.js';
import { taskListQuerySchema, createTaskBodySchema, patchTaskBodySchema } from './types.js';
import type { RouteContext } from './types.js';

export function registerTaskRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/tasks', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.taskStore) {
      reply.code(503).send({ error: 'TaskStore not available' });
      return;
    }

    const queryParseResult = taskListQuerySchema.safeParse(request.query);
    if (!queryParseResult.success) {
      reply.code(400).send({ error: 'Invalid query parameters', details: queryParseResult.error.issues });
      return;
    }
    const query = queryParseResult.data;

    let tasks: Task[] = [];

    if (query.team) {
      tasks = await ctx.taskStore.listByTeam(query.team);
    } else if (query.status) {
      tasks = await ctx.taskStore.listByStatus(query.status as Task['status']);
    } else {
      if (ctx.orgChart) {
        const teams = ctx.orgChart.listTeams();
        for (const team of teams) {
          const teamTasks = await ctx.taskStore.listByTeam(team.slug);
          tasks.push(...teamTasks);
        }
      }
    }

    const paginated = tasks.slice(query.offset, query.offset + query.limit);

    reply.send({
      tasks: paginated,
      total: tasks.length,
      offset: query.offset,
      limit: query.limit,
    });
  });

  app.get('/api/tasks/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.taskStore) {
      reply.code(503).send({ error: 'TaskStore not available' });
      return;
    }

    const { id } = request.params as { id: string };

    try {
      const task = await ctx.taskStore.get(id);
      reply.send(task);
    } catch (err) {
      if (err instanceof NotFoundError) {
        reply.code(404).send({ error: `Task not found: ${id}` });
        return;
      }
      throw err;
    }
  });

  app.get('/api/tasks/:id/events', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.taskEventStore) {
      reply.code(503).send({ error: 'TaskEventStore not available' });
      return;
    }

    const { id } = request.params as { id: string };
    const events = await ctx.taskEventStore.getByTask(id);
    reply.send({ events });
  });

  app.post('/api/tasks', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.taskStore || !ctx.orchestrator) {
      reply.code(503).send({ error: 'TaskStore or Orchestrator not available' });
      return;
    }

    const parseResult = createTaskBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.code(400).send({ error: 'Invalid request body', details: parseResult.error.issues });
      return;
    }
    const body = parseResult.data;

    const task: Task = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      parent_id: '',
      team_slug: body.team_slug,
      agent_aid: body.agent_aid ?? '',
      title: body.title,
      status: 'pending',
      prompt: body.prompt,
      result: '',
      error: '',
      blocked_by: body.blocked_by ?? null,
      priority: body.priority ?? 0,
      retry_count: 0,
      max_retries: 3,
      created_at: Date.now(),
      updated_at: Date.now(),
      completed_at: null,
    };

    await ctx.taskStore.create(task);
    await ctx.orchestrator.dispatchTask(task);

    reply.code(201).send(task);
  });

  app.patch('/api/tasks/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.taskStore) {
      reply.code(503).send({ error: 'TaskStore not available' });
      return;
    }

    const { id } = request.params as { id: string };

    const parseResult = patchTaskBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.code(400).send({ error: 'Invalid request body', details: parseResult.error.issues });
      return;
    }
    const body = parseResult.data;

    try {
      const task = await ctx.taskStore.get(id);

      if (body.status) {
        task.status = body.status as Task['status'];
      }
      if (body.result !== undefined) {
        task.result = body.result;
      }
      if (body.error !== undefined) {
        task.error = body.error;
      }
      task.updated_at = Date.now();

      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        task.completed_at = Date.now();
      }

      await ctx.taskStore.update(task);
      reply.send(task);
    } catch (err) {
      if (err instanceof NotFoundError) {
        reply.code(404).send({ error: `Task not found: ${id}` });
        return;
      }
      if (err instanceof InvalidTransitionError || err instanceof ValidationError) {
        reply.code(400).send({ error: (err as Error).message });
        return;
      }
      throw err;
    }
  });
}
