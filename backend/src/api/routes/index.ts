/**
 * API routes index for OpenHive REST API.
 *
 * Exports route registration functions for all REST API endpoint groups.
 * Each handler implements the API contract defined in Architecture.md.
 *
 * ## Route Groups
 *
 * | Prefix              | Description                                    |
 * |---------------------|------------------------------------------------|
 * | `/api/health`       | Health check endpoint                          |
 * | `/api/teams`        | Team CRUD and listing                          |
 * | `/api/tasks`        | Task lifecycle and queries                     |
 * | `/api/logs`         | Log querying and streaming                     |
 * | `/api/v1/hooks/*`   | Dynamic webhook endpoints registered at runtime|
 *
 * ## Usage
 *
 * The {@link registerRoutes} function is called by {@link APIServer.start} to
 * mount all route handlers on the Fastify instance. Each route group is
 * registered as a separate Fastify plugin for encapsulation.
 *
 * @example
 * ```ts
 * import { registerRoutes } from './routes/index.js';
 *
 * // Inside APIServer.start():
 * registerRoutes(fastify, context);
 * ```
 *
 * @module api/routes
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type {
  Task,
  OrgChart,
  ContainerManager,
  HealthMonitor,
  TriggerScheduler,
  Orchestrator,
  TaskStore,
  LogStore,
  TaskEventStore,
  LogLevel,
} from '../../domain/index.js';
import { ContainerHealth } from '../../domain/enums.js';
import { NotFoundError, ValidationError } from '../../domain/errors.js';

// ---------------------------------------------------------------------------
// Route Context
// ---------------------------------------------------------------------------

/**
 * Context passed to route handlers providing access to domain services.
 */
export interface RouteContext {
  orgChart?: OrgChart;
  containerManager?: ContainerManager;
  healthMonitor?: HealthMonitor;
  triggerScheduler?: TriggerScheduler;
  orchestrator?: Orchestrator;
  taskStore?: TaskStore;
  logStore?: LogStore;
  taskEventStore?: TaskEventStore;
}

// ---------------------------------------------------------------------------
// Health Routes
// ---------------------------------------------------------------------------

/**
 * Register health check routes on the Fastify instance.
 *
 * Endpoints:
 * - `GET /api/health` - Returns system health status including uptime,
 *   container count, connected teams, and database connectivity.
 */
function registerHealthRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    const uptime = process.uptime();
    const containers = ctx.containerManager
      ? (await ctx.containerManager.listRunningContainers()).length
      : 0;
    const connectedTeams = ctx.orgChart
      ? ctx.orgChart.listTeams().map((t) => t.slug)
      : [];

    // Determine overall status
    let status = 'healthy';
    if (ctx.healthMonitor) {
      const healthMap = ctx.healthMonitor.getAllHealth();
      for (const [, health] of healthMap) {
        if (health === ContainerHealth.Unhealthy || health === ContainerHealth.Unreachable) {
          status = 'degraded';
          break;
        }
      }
    }

    reply.send({
      status,
      uptime: Math.floor(uptime),
      containers,
      connectedTeams,
      dbStatus: 'connected', // Simplified - would check actual DB in production
    });
  });
}

// ---------------------------------------------------------------------------
// Team Routes
// ---------------------------------------------------------------------------

/**
 * Register team management routes on the Fastify instance.
 *
 * Endpoints:
 * - `GET /api/teams` - List all teams with health and agent counts
 * - `GET /api/teams/:slug` - Get team details by slug
 * - `POST /api/teams` - Create a new team (delegates to orchestrator)
 * - `DELETE /api/teams/:slug` - Remove a team and its container
 */
function registerTeamRoutes(app: FastifyInstance, ctx: RouteContext): void {
  // GET /api/teams - List all teams
  app.get('/api/teams', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.orgChart) {
      reply.code(503).send({ error: 'OrgChart not available' });
      return;
    }

    const teams = ctx.orgChart.listTeams();
    const result = teams.map((team) => {
      const agents = ctx.orgChart!.getAgentsByTeam(team.slug);
      return {
        tid: team.tid,
        slug: team.slug,
        leaderAid: team.leaderAid,
        health: team.health,
        agentCount: agents.length,
        depth: team.depth,
      };
    });

    reply.send({ teams: result });
  });

  // GET /api/teams/:slug - Get team details
  app.get('/api/teams/:slug', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.orgChart) {
      reply.code(503).send({ error: 'OrgChart not available' });
      return;
    }

    const { slug } = request.params as { slug: string };
    const team = ctx.orgChart.getTeamBySlug(slug);

    if (!team) {
      reply.code(404).send({ error: `Team not found: ${slug}` });
      return;
    }

    const agents = ctx.orgChart.getAgentsByTeam(slug);
    const children = ctx.orgChart.getChildren(team.tid);

    reply.send({
      tid: team.tid,
      slug: team.slug,
      leaderAid: team.leaderAid,
      health: team.health,
      depth: team.depth,
      containerId: team.containerId,
      workspacePath: team.workspacePath,
      agents: agents.map((a) => ({
        aid: a.aid,
        name: a.name,
        role: a.role,
        status: a.status,
      })),
      childTeams: children.map((c) => c.slug),
    });
  });

  // POST /api/teams - Create a new team
  app.post('/api/teams', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.containerManager) {
      reply.code(503).send({ error: 'ContainerManager not available' });
      return;
    }

    const body = request.body as {
      slug: string;
      leaderAid?: string;
      purpose?: string;
    };

    if (!body.slug) {
      reply.code(400).send({ error: 'slug is required' });
      return;
    }

    try {
      const container = await ctx.containerManager.spawnTeamContainer(body.slug);
      reply.code(201).send({
        slug: body.slug,
        containerId: container.id,
        status: 'created',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(500).send({ error: message });
    }
  });

  // DELETE /api/teams/:slug - Remove a team
  app.delete('/api/teams/:slug', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.containerManager) {
      reply.code(503).send({ error: 'ContainerManager not available' });
      return;
    }

    const { slug } = request.params as { slug: string };

    try {
      await ctx.containerManager.stopTeamContainer(slug, 'api_delete');
      reply.send({ slug, status: 'removed' });
    } catch (err) {
      if (err instanceof NotFoundError) {
        reply.code(404).send({ error: `Team not found: ${slug}` });
        return;
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(500).send({ error: message });
    }
  });
}

// ---------------------------------------------------------------------------
// Task Routes
// ---------------------------------------------------------------------------

/**
 * Register task management routes on the Fastify instance.
 *
 * Endpoints:
 * - `GET /api/tasks` - List tasks with optional status/team filters
 * - `GET /api/tasks/:id` - Get task details by ID
 * - `GET /api/tasks/:id/events` - Get task lifecycle events
 * - `POST /api/tasks` - Create a new task
 * - `PATCH /api/tasks/:id` - Update task status
 */
function registerTaskRoutes(app: FastifyInstance, ctx: RouteContext): void {
  // GET /api/tasks - List tasks with filters
  app.get('/api/tasks', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.taskStore) {
      reply.code(503).send({ error: 'TaskStore not available' });
      return;
    }

    const query = request.query as {
      status?: string;
      team?: string;
      limit?: string;
      offset?: string;
    };

    let tasks: Task[] = [];

    if (query.team) {
      tasks = await ctx.taskStore.listByTeam(query.team);
    } else if (query.status) {
      tasks = await ctx.taskStore.listByStatus(query.status as Task['status']);
    } else {
      // List all - we'd need a listAll method, for now use team-based
      if (ctx.orgChart) {
        const teams = ctx.orgChart.listTeams();
        for (const team of teams) {
          const teamTasks = await ctx.taskStore.listByTeam(team.slug);
          tasks.push(...teamTasks);
        }
      }
    }

    // Apply pagination
    const offset = query.offset ? parseInt(query.offset, 10) : 0;
    const limit = query.limit ? parseInt(query.limit, 10) : 100;
    const paginated = tasks.slice(offset, offset + limit);

    reply.send({
      tasks: paginated,
      total: tasks.length,
      offset,
      limit,
    });
  });

  // GET /api/tasks/:id - Get task details
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

  // GET /api/tasks/:id/events - Get task events
  app.get('/api/tasks/:id/events', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.taskEventStore) {
      reply.code(503).send({ error: 'TaskEventStore not available' });
      return;
    }

    const { id } = request.params as { id: string };
    const events = await ctx.taskEventStore.getByTask(id);
    reply.send({ events });
  });

  // POST /api/tasks - Create a new task
  app.post('/api/tasks', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.taskStore || !ctx.orchestrator) {
      reply.code(503).send({ error: 'TaskStore or Orchestrator not available' });
      return;
    }

    const body = request.body as {
      team_slug: string;
      agent_aid?: string;
      title: string;
      prompt: string;
      priority?: number;
      blocked_by?: string[];
    };

    if (!body.team_slug || !body.title || !body.prompt) {
      reply.code(400).send({ error: 'team_slug, title, and prompt are required' });
      return;
    }

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

  // PATCH /api/tasks/:id - Update task status
  app.patch('/api/tasks/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.taskStore) {
      reply.code(503).send({ error: 'TaskStore not available' });
      return;
    }

    const { id } = request.params as { id: string };
    const body = request.body as {
      status?: string;
      result?: string;
      error?: string;
    };

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
      if (err instanceof ValidationError) {
        reply.code(400).send({ error: err.message });
        return;
      }
      throw err;
    }
  });
}

// ---------------------------------------------------------------------------
// Log Routes
// ---------------------------------------------------------------------------

/**
 * Register log query routes on the Fastify instance.
 *
 * Endpoints:
 * - `GET /api/logs` - Query log entries with filters (level, component,
 *   team, agent, time range, pagination)
 * - `GET /api/logs/stream` - SSE stream for real-time log tailing
 */
function registerLogRoutes(app: FastifyInstance, ctx: RouteContext): void {
  // GET /api/logs - Query log entries
  app.get('/api/logs', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.logStore) {
      reply.code(503).send({ error: 'LogStore not available' });
      return;
    }

    const query = request.query as {
      level?: string;
      eventType?: string;
      component?: string;
      teamSlug?: string;
      taskId?: string;
      agentAid?: string;
      since?: string;
      until?: string;
      limit?: string;
      offset?: string;
    };

    const entries = await ctx.logStore.query({
      level: query.level ? parseInt(query.level, 10) as LogLevel : undefined,
      eventType: query.eventType,
      component: query.component,
      teamSlug: query.teamSlug,
      taskId: query.taskId,
      agentAid: query.agentAid,
      since: query.since ? new Date(parseInt(query.since, 10)) : undefined,
      until: query.until ? new Date(parseInt(query.until, 10)) : undefined,
      limit: query.limit ? parseInt(query.limit, 10) : 100,
      offset: query.offset ? parseInt(query.offset, 10) : 0,
    });

    reply.send({ entries });
  });

  // GET /api/logs/stream - SSE stream for real-time logs
  app.get('/api/logs/stream', async (request: FastifyRequest, reply: FastifyReply) => {
    // Set up SSE headers
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');

    // Send initial connection message
    reply.raw.write('data: {"type":"connected"}\n\n');

    // Keep connection alive - in production, this would subscribe to EventBus
    // For now, just send periodic heartbeats
    const heartbeat = setInterval(() => {
      reply.raw.write(': heartbeat\n\n');
    }, 30000);

    // Clean up on disconnect
    request.raw.on('close', () => {
      clearInterval(heartbeat);
    });

    // Don't end the response - keep it open for SSE
    return reply;
  });
}

// ---------------------------------------------------------------------------
// Webhook Routes
// ---------------------------------------------------------------------------

interface WebhookRegistration {
  id: string;
  path: string;
  teamSlug: string;
  createdAt: number;
}

// In-memory webhook registry (would be persisted in production)
const webhookRegistry = new Map<string, WebhookRegistration>();

/**
 * Register webhook routes on the Fastify instance.
 *
 * Provides a dynamic route prefix at `/api/v1/hooks/*` where webhook
 * endpoints are registered at runtime via the `register_webhook` MCP tool.
 * Incoming webhook payloads are routed to the target team specified during
 * registration.
 *
 * Endpoints:
 * - `POST /api/v1/hooks/:path` - Receive webhook payload and route to team
 * - `GET /api/v1/hooks` - List registered webhook endpoints
 * - `DELETE /api/v1/hooks/:registrationId` - Unregister a webhook endpoint
 */
function registerWebhookRoutes(app: FastifyInstance, ctx: RouteContext): void {
  // POST /api/v1/hooks/:path - Receive webhook
  app.post('/api/v1/hooks/:path', async (request: FastifyRequest, reply: FastifyReply) => {
    const { path } = request.params as { path: string };
    const webhookPath = `/${path}`;

    // Find webhook registration
    let registration: WebhookRegistration | undefined;
    for (const [, reg] of webhookRegistry) {
      if (reg.path === webhookPath) {
        registration = reg;
        break;
      }
    }

    if (!registration) {
      reply.code(404).send({ error: `Webhook not found: ${webhookPath}` });
      return;
    }

    // Get the team to find its lead
    const team = ctx.orgChart?.getTeamBySlug(registration.teamSlug);
    if (!team) {
      reply.code(404).send({ error: `Team not found: ${registration.teamSlug}` });
      return;
    }

    // Create task for the webhook payload
    const taskId = `webhook-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
    const payload = request.body as Record<string, unknown>;
    const prompt = `Webhook received at ${webhookPath}:\n\n${JSON.stringify(payload, null, 2)}`;

    const task = {
      id: taskId,
      parent_id: '',
      team_slug: registration.teamSlug,
      agent_aid: team.leaderAid,
      title: `Webhook: ${webhookPath}`,
      status: 'pending' as const,
      prompt,
      result: '',
      error: '',
      blocked_by: [],
      priority: 5,
      retry_count: 0,
      max_retries: 3,
      created_at: Date.now(),
      updated_at: Date.now(),
      completed_at: null,
    };

    try {
      // Create task in store
      if (ctx.taskStore) {
        await ctx.taskStore.create(task);
      }

      // Dispatch via orchestrator if available
      if (ctx.orchestrator) {
        await ctx.orchestrator.dispatchTask(task);
      }

      reply.send({
        received: true,
        path: webhookPath,
        teamSlug: registration.teamSlug,
        taskId,
        timestamp: Date.now(),
      });
    } catch (err) {
      reply.code(500).send({
        error: 'Failed to dispatch webhook task',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // GET /api/v1/hooks - List webhooks
  app.get('/api/v1/hooks', async (_request: FastifyRequest, reply: FastifyReply) => {
    const webhooks = [...webhookRegistry.values()];
    reply.send({ webhooks });
  });

  // DELETE /api/v1/hooks/:registrationId - Remove webhook
  app.delete('/api/v1/hooks/:registrationId', async (request: FastifyRequest, reply: FastifyReply) => {
    const { registrationId } = request.params as { registrationId: string };

    if (!webhookRegistry.has(registrationId)) {
      reply.code(404).send({ error: `Webhook registration not found: ${registrationId}` });
      return;
    }

    webhookRegistry.delete(registrationId);
    reply.send({ id: registrationId, status: 'removed' });
  });
}

// ---------------------------------------------------------------------------
// Main Registration
// ---------------------------------------------------------------------------

/**
 * Register all REST API route handlers on the Fastify instance.
 *
 * Called by {@link APIServer.start} during server initialization.
 * Delegates to individual route group registration functions:
 * - Health check
 * - Team management
 * - Task lifecycle
 * - Log querying
 * - Dynamic webhook endpoints
 *
 * @param app - Fastify instance to register routes on
 * @param ctx - Route context with domain services
 */
export function registerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  registerHealthRoutes(app, ctx);
  registerTeamRoutes(app, ctx);
  registerTaskRoutes(app, ctx);
  registerLogRoutes(app, ctx);
  registerWebhookRoutes(app, ctx);
}

/**
 * Register a webhook endpoint.
 * Called by MCP tool register_webhook.
 */
export function registerWebhook(id: string, path: string, teamSlug: string): void {
  // Normalize path to always have leading slash for consistent lookup
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  webhookRegistry.set(id, {
    id,
    path: normalizedPath,
    teamSlug,
    createdAt: Date.now(),
  });
}

/**
 * Unregister a webhook endpoint.
 */
export function unregisterWebhook(id: string): boolean {
  return webhookRegistry.delete(id);
}

/**
 * List all registered webhooks.
 */
export function listWebhooks(): WebhookRegistration[] {
  return [...webhookRegistry.values()];
}