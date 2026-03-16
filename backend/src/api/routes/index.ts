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

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type {
  Task,
  OrgChart,
  ContainerManager,
  ContainerProvisioner,
  HealthMonitor,
  TriggerScheduler,
  Orchestrator,
  TaskStore,
  LogStore,
  TaskEventStore,
  LogLevel,
  IntegrationStore,
  CredentialStore,
  ConfigLoader,
  Logger,
  EventBus,
  BusEvent,
} from '../../domain/index.js';
import { ContainerHealth } from '../../domain/enums.js';
import { NotFoundError, ValidationError, ConflictError, InvalidTransitionError } from '../../domain/errors.js';
import type { MasterConfig } from '../../config/defaults.js';

/** Slug regex: lowercase alphanumeric segments separated by hyphens, 3-63 chars. */
const SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Zod schema for slug-format path/query params (AC-G14).
 * Used wherever a team slug is accepted as a URL param or query string.
 */
const slugSchema = z.string().regex(SLUG_REGEX).min(3).max(63);

/**
 * Reusable schema for endpoints that accept an optional ?team=<slug> query param.
 * Applied in GET /api/agents, GET /api/integrations, GET /api/tasks.
 */
const teamFilterSchema = z.object({
  team: slugSchema.optional(),
});

/**
 * Reusable schema for route params that carry a container/team slug.
 * Applied in POST /api/containers/:slug/restart and DELETE /api/teams/:slug.
 */
const containerRestartParamsSchema = z.object({
  slug: slugSchema,
});

/** Valid task status values. */
const TASK_STATUSES = ['pending', 'active', 'completed', 'failed', 'escalated', 'cancelled'] as const;

/**
 * Schema for GET /api/tasks query params.
 */
const taskListQuerySchema = teamFilterSchema.extend({
  status: z.enum(TASK_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

/**
 * Schema for POST /api/tasks request body.
 */
const createTaskBodySchema = z.object({
  team_slug: slugSchema,
  agent_aid: z.string().optional(),
  title: z.string().min(1).max(500),
  prompt: z.string().min(1),
  priority: z.number().int().min(0).max(100).optional(),
  blocked_by: z.array(z.string()).optional(),
});

/**
 * Schema for PATCH /api/tasks/:id request body.
 */
const patchTaskBodySchema = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  result: z.string().optional(),
  error: z.string().optional(),
});

/**
 * Schema for POST /api/teams request body.
 */
const createTeamBodySchema = z.object({
  slug: slugSchema,
  leaderAid: z.string().optional(),
  purpose: z.string().optional(),
});

/**
 * Schema for GET /api/logs query params.
 */
const logQuerySchema = z.object({
  level: z.coerce.number().int().min(0).max(60).optional(),
  eventType: z.string().optional(),
  component: z.string().optional(),
  teamSlug: slugSchema.optional(),
  taskId: z.string().optional(),
  agentAid: z.string().optional(),
  since: z.coerce.number().int().min(0).optional(),
  until: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

/**
 * Duck-type helper: retrieve restart count from a container manager implementation
 * if it exposes the `getRestartCount` method (ContainerManagerImpl does).
 * Routes through `unknown` to avoid TS2352 overlap error.
 * Returns 0 if the method is not present.
 */
function getRestartCount(manager: ContainerManager, slug: string): number {
  const m = manager as unknown as { getRestartCount?: (slug: string) => number };
  if (typeof m.getRestartCount === 'function') {
    return m.getRestartCount(slug);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Route Context
// ---------------------------------------------------------------------------

/**
 * Context passed to route handlers providing access to domain services.
 */
export interface RouteContext {
  orgChart?: OrgChart;
  containerManager?: ContainerManager;
  provisioner?: ContainerProvisioner;
  healthMonitor?: HealthMonitor;
  triggerScheduler?: TriggerScheduler;
  orchestrator?: Orchestrator;
  taskStore?: TaskStore;
  logStore?: LogStore;
  taskEventStore?: TaskEventStore;
  integrationStore?: IntegrationStore;
  credentialStore?: CredentialStore;
  configLoader?: ConfigLoader;
  logger?: Logger;
  eventBus?: EventBus;
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
      // Resolve parentSlug for tree construction (AC-G10)
      let parentSlug: string | null = null;
      if (team.parentTid) {
        const parent = ctx.orgChart!.getParent(team.tid);
        parentSlug = parent?.slug ?? null;
      }
      return {
        tid: team.tid,
        slug: team.slug,
        leaderAid: team.leaderAid,
        health: team.health,
        agentCount: agents.length,
        depth: team.depth,
        parentSlug,
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

    // Validate body with Zod (AC-G14)
    const parseResult = createTeamBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.code(400).send({ error: 'Invalid request body', details: parseResult.error.issues });
      return;
    }
    const body = parseResult.data;

    try {
      // Scaffold workspace for the team
      if (ctx.provisioner) {
        const parentPath = '/app/workspace';
        await ctx.provisioner.scaffoldWorkspace(parentPath, body.slug);
      }

      const container = await ctx.containerManager.spawnTeamContainer(body.slug);

      // Register team in org chart so root recognizes the child container
      if (ctx.orgChart) {
        // Resolve leader: use provided leaderAid, or default to main assistant
        const leaderAid = body.leaderAid ?? ctx.orgChart.listTeams()[0]?.leaderAid ?? '';
        const parentTeam = ctx.orgChart.getTeamBySlug('main');
        ctx.orgChart.addTeam({
          tid: container.tid,
          slug: body.slug,
          leaderAid,
          parentTid: parentTeam?.tid ?? '',
          depth: (parentTeam?.depth ?? 0) + 1,
          containerId: container.id,
          health: container.health ?? 'starting',
          agentAids: [],
          workspacePath: `/app/workspace/teams/${body.slug}`,
        });
      }

      // Publish lifecycle event
      if (ctx.eventBus) {
        ctx.eventBus.publish({
          type: 'team.created',
          data: { tid: container.tid, slug: body.slug },
          timestamp: Date.now(),
          source: 'api',
        });
      }

      reply.code(201).send({
        slug: body.slug,
        tid: container.tid,
        containerId: container.id,
        status: 'created',
      });
    } catch (err) {
      // Catch validation/domain errors as 400, not 500
      if (err instanceof ValidationError || err instanceof ConflictError) {
        reply.code(400).send({ error: (err as Error).message });
        return;
      }
      // validateSlug throws plain Error for reserved slugs, format issues
      if (err instanceof Error && (
        err.message.includes('Reserved slug') ||
        err.message.includes('Invalid slug') ||
        err.message.includes('Slug too')
      )) {
        reply.code(400).send({ error: err.message });
        return;
      }
      throw err;
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

      // Remove team from org chart
      if (ctx.orgChart) {
        const team = ctx.orgChart.getTeamBySlug(slug);
        if (team) {
          ctx.orgChart.removeTeam(team.tid);
        }
      }

      reply.send({ slug, status: 'removed' });
    } catch (err) {
      if (err instanceof NotFoundError) {
        reply.code(404).send({ error: `Team not found: ${slug}` });
        return;
      }
      // Do not expose internal error details. Let the onError hook log and sanitize (AC-G15).
      throw err;
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

    // Validate query params with Zod (AC-G14)
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
      // List all - we'd need a listAll method, for now use team-based
      if (ctx.orgChart) {
        const teams = ctx.orgChart.listTeams();
        for (const team of teams) {
          const teamTasks = await ctx.taskStore.listByTeam(team.slug);
          tasks.push(...teamTasks);
        }
      }
    }

    // Apply pagination (bounded by Zod schema: limit 1-1000, offset >= 0)
    const paginated = tasks.slice(query.offset, query.offset + query.limit);

    reply.send({
      tasks: paginated,
      total: tasks.length,
      offset: query.offset,
      limit: query.limit,
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

    // Validate body with Zod (AC-G14)
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

  // PATCH /api/tasks/:id - Update task status
  app.patch('/api/tasks/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.taskStore) {
      reply.code(503).send({ error: 'TaskStore not available' });
      return;
    }

    const { id } = request.params as { id: string };

    // Validate body with Zod (AC-G14)
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

// ---------------------------------------------------------------------------
// Agent Routes
// ---------------------------------------------------------------------------

/**
 * Register agent listing routes on the Fastify instance.
 *
 * Endpoints:
 * - `GET /api/agents` - List all agents, optionally filtered by `?team=<slug>`.
 *   Returns `{ aid, name, teamSlug, role, status, leadsTeam }` per agent.
 *   Data sourced from OrgChart (no N+1 queries, validated query params).
 */
function registerAgentRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/agents', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.orgChart) {
      reply.code(503).send({ error: 'OrgChart not available' });
      return;
    }

    // Validate optional team query param with Zod (AC-G14)
    const queryParseResult = teamFilterSchema.safeParse(request.query);
    if (!queryParseResult.success) {
      reply.code(400).send({ error: 'Invalid query parameters', details: queryParseResult.error.issues });
      return;
    }
    const query = queryParseResult.data;

    let agents;
    if (query.team) {
      agents = ctx.orgChart.getAgentsByTeam(query.team);
    } else {
      // Collect agents across all teams
      const allTeams = ctx.orgChart.listTeams();
      agents = allTeams.flatMap((team) => ctx.orgChart!.getAgentsByTeam(team.slug));
    }

    reply.send({
      agents: agents.map((a) => ({
        aid: a.aid,
        name: a.name,
        teamSlug: a.teamSlug,
        role: a.role,
        status: a.status,
        leadsTeam: a.leadsTeam ?? null,
        // modelTier is stored on OrgChartAgent at create_agent time (from the tool's
        // `model` parameter). It is undefined for agents created before this field was
        // added, or for the main assistant (whose model comes from provider config).
        modelTier: a.modelTier ?? null,
      })),
    });
  });
}

// ---------------------------------------------------------------------------
// Container Routes
// ---------------------------------------------------------------------------

/**
 * Register container management routes on the Fastify instance.
 *
 * Endpoints:
 * - `GET /api/containers` - List all containers with health, agent count,
 *   uptime, restart count, active task count, and child teams.
 * - `POST /api/containers/:slug/restart` - Restart a team container.
 *   Returns 409 if a restart is already in progress.
 */
function registerContainerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  // GET /api/containers - List all containers with enriched data
  app.get('/api/containers', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.containerManager) {
      reply.code(503).send({ error: 'ContainerManager not available' });
      return;
    }

    const containers = await ctx.containerManager.listRunningContainers();
    const now = Date.now();

    const result = await Promise.all(
      containers.map(async (c) => {
        const slug = c.teamSlug;

        // Health from HealthMonitor (tid-based), fall back to ContainerInfo.health
        let health: ContainerHealth = c.health;
        if (ctx.healthMonitor) {
          health = ctx.healthMonitor.getHealth(c.tid);
        }

        // Agent count from OrgChart
        const agentCount = ctx.orgChart ? ctx.orgChart.getAgentsByTeam(slug).length : 0;

        // Uptime in seconds
        const uptimeSeconds = Math.floor((now - c.createdAt) / 1000);

        // Restart count from ContainerManagerImpl (duck-typed)
        const restartCount = getRestartCount(ctx.containerManager!, slug);

        // Active task count from TaskStore
        let activeTaskCount = 0;
        if (ctx.taskStore) {
          const teamTasks = await ctx.taskStore.listByTeam(slug);
          activeTaskCount = teamTasks.filter((t) => t.status === 'active').length;
        }

        // Child teams from OrgChart
        let childTeams: string[] = [];
        if (ctx.orgChart) {
          const team = ctx.orgChart.getTeamBySlug(slug);
          if (team) {
            childTeams = ctx.orgChart.getChildren(team.tid).map((child) => child.slug);
          }
        }

        return {
          slug,
          health,
          agentCount,
          uptime: uptimeSeconds,
          restartCount,
          activeTaskCount,
          childTeams,
        };
      }),
    );

    reply.send({ containers: result });
  });

  // POST /api/containers/:slug/restart - Restart a team container
  app.post('/api/containers/:slug/restart', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.containerManager) {
      reply.code(503).send({ error: 'ContainerManager not available' });
      return;
    }

    // Validate slug format via Zod (AC-G14)
    const paramsParseResult = containerRestartParamsSchema.safeParse(request.params);
    if (!paramsParseResult.success) {
      reply.code(400).send({ error: 'Invalid route parameter', details: paramsParseResult.error.issues });
      return;
    }
    const { slug } = paramsParseResult.data;

    try {
      await ctx.containerManager.restartTeamContainer(slug, 'api_restart');
      ctx.logger?.audit('container.restart.api', { slug, source: 'api' });
      reply.send({ slug, status: 'restarted' });
    } catch (err) {
      if (err instanceof ConflictError) {
        reply.code(409).send({ error: err.message });
        return;
      }
      if (err instanceof NotFoundError) {
        reply.code(404).send({ error: err.message });
        return;
      }
      if (err instanceof ValidationError) {
        reply.code(400).send({ error: err.message });
        return;
      }
      // Do not expose internal error details. Let the onError hook log and sanitize (AC-G15).
      throw err;
    }
  });
}

// ---------------------------------------------------------------------------
// SSE Log Stream state (module-level for fan-out, shared across requests)
// ---------------------------------------------------------------------------

/** Maximum number of concurrent SSE log stream connections. */
const SSE_MAX_CLIENTS = 50;

/** Log-related EventBus event types/prefixes to forward to SSE clients. */
const LOG_EVENT_PREFIXES = ['log.', 'log_event'] as const;

/** A writable SSE client — thin wrapper around the raw Node.js response stream. */
interface SseClient {
  raw: { writable: boolean; write: (data: string) => void };
}

/** Set of currently connected SSE log stream clients. */
const sseClients = new Set<SseClient>();

/** Single shared EventBus subscription ID for SSE log fan-out. */
let sseSubscriptionId: string | null = null;

/** EventBus reference held for cleanup when the last client disconnects. */
let sseEventBus: EventBus | null = null;

/**
 * Fan-out a BusEvent to all currently connected SSE log stream clients.
 * Skips clients whose underlying stream is no longer writable (backpressure).
 */
function fanOutToSseClients(event: BusEvent): void {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  const dead: SseClient[] = [];
  for (const client of sseClients) {
    if (!client.raw.writable) {
      dead.push(client);
      continue;
    }
    try {
      client.raw.write(frame);
    } catch {
      dead.push(client);
    }
  }
  for (const d of dead) {
    sseClients.delete(d);
  }
}

/**
 * Ensure the single shared EventBus subscription for SSE log fan-out is active.
 * Called whenever the first SSE client connects (or reconnects after all left).
 */
function ensureSseSubscription(eventBus: EventBus): void {
  if (sseSubscriptionId !== null) {
    return; // Already subscribed
  }
  sseEventBus = eventBus;
  sseSubscriptionId = eventBus.filteredSubscribe(
    (event: BusEvent) =>
      LOG_EVENT_PREFIXES.some((p) => event.type === p || event.type.startsWith(p)),
    fanOutToSseClients,
  );
}

/**
 * Tear down the shared EventBus subscription when no SSE clients remain.
 */
function maybeTearDownSseSubscription(): void {
  if (sseClients.size === 0 && sseSubscriptionId !== null && sseEventBus !== null) {
    sseEventBus.unsubscribe(sseSubscriptionId);
    sseSubscriptionId = null;
    sseEventBus = null;
  }
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

    // Validate query params with Zod (AC-G14)
    const queryParseResult = logQuerySchema.safeParse(request.query);
    if (!queryParseResult.success) {
      reply.code(400).send({ error: 'Invalid query parameters', details: queryParseResult.error.issues });
      return;
    }
    const query = queryParseResult.data;

    const entries = await ctx.logStore.query({
      level: query.level as LogLevel | undefined,
      eventType: query.eventType,
      component: query.component,
      teamSlug: query.teamSlug,
      taskId: query.taskId,
      agentAid: query.agentAid,
      since: query.since !== undefined ? new Date(query.since) : undefined,
      until: query.until !== undefined ? new Date(query.until) : undefined,
      limit: query.limit,
      offset: query.offset,
    });

    reply.send({ entries });
  });

  // GET /api/logs/stream - SSE stream for real-time logs
  app.get('/api/logs/stream', async (request: FastifyRequest, reply: FastifyReply) => {
    // Enforce max concurrent SSE connection limit (AC-G12)
    if (sseClients.size >= SSE_MAX_CLIENTS) {
      reply.code(503).send({ error: 'Too many SSE log stream connections' });
      return;
    }

    // Set SSE headers
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');

    // Send initial connection event
    reply.raw.write('data: {"type":"connected"}\n\n');

    // Register this client for fan-out
    const client: SseClient = { raw: reply.raw };
    sseClients.add(client);

    // Wire the single shared EventBus subscription if we have an EventBus
    if (ctx.eventBus) {
      ensureSseSubscription(ctx.eventBus);
    }

    // Heartbeat to keep the connection alive (every 30s)
    const heartbeat = setInterval(() => {
      if (reply.raw.writable) {
        reply.raw.write(': heartbeat\n\n');
      }
    }, 30000);

    // Cleanup on client disconnect (AC-G12)
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(client);
      maybeTearDownSseSubscription();
    });

    // Don't end the response — keep it open for SSE
    return reply;
  });
}

// ---------------------------------------------------------------------------
// Integration Routes
// ---------------------------------------------------------------------------

/**
 * Register integration query routes on the Fastify instance.
 *
 * Endpoints:
 * - `GET /api/integrations` - List integrations, optionally filtered by `?team=<slug>`.
 *   Iterates all teams from orgChart when no filter is provided.
 */
function registerIntegrationRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/integrations', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.integrationStore) {
      reply.code(503).send({ error: 'IntegrationStore not available' });
      return;
    }

    // Validate optional team query param with Zod (AC-G14)
    const queryParseResult = teamFilterSchema.safeParse(request.query);
    if (!queryParseResult.success) {
      reply.code(400).send({ error: 'Invalid query parameters', details: queryParseResult.error.issues });
      return;
    }
    const query = queryParseResult.data;

    const { integrations: rawIntegrations } = await (async () => {
      if (query.team) {
        // Single team filter
        const list = await ctx.integrationStore!.listByTeam(query.team);
        return { integrations: list };
      }

      // No filter — gather from all teams in org chart
      const teams = ctx.orgChart ? ctx.orgChart.listTeams() : [];
      const all = await Promise.all(teams.map((t) => ctx.integrationStore!.listByTeam(t.slug)));
      return { integrations: all.flat() };
    })();

    // Project only the Integration domain fields (no extra DB fields).
    // Resolve team_id (TID) to a slug via OrgChart so callers never have to
    // handle raw TIDs. Falls back to the raw team_id string when OrgChart is
    // unavailable or the team has been removed.
    const integrations = rawIntegrations.map((i) => {
      const teamSlug = ctx.orgChart?.getTeam(i.team_id)?.slug ?? i.team_id;
      return {
        id: i.id,
        name: i.name,
        teamSlug,
        config_path: i.config_path,
        status: i.status,
        error_message: i.error_message,
        created_at: i.created_at,
      };
    });

    reply.send({ integrations });
  });
}

// ---------------------------------------------------------------------------
// Settings Routes
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

/** Leaf field descriptor returned by getConfigWithSources(). */
interface FieldMeta {
  value: unknown;
  source: 'default' | 'yaml' | 'env';
  isSecret?: boolean;
}

/**
 * Zod schema for PUT /api/settings request body.
 * Accepts any plain JSON object (validated to be non-null object at runtime).
 */
const settingsUpdateBodySchema = z.record(z.unknown());

/**
 * Convert the flat dot-path map from getConfigWithSources() into a nested
 * section object that the Settings UI expects.
 *
 * Example:
 *   Input:  { "server.port": { value: 8080, source: "default" } }
 *   Output: { server: { port: { value: 8080, source: "default" } } }
 *
 * Keys with no dot (e.g. "foo") appear under a synthetic top-level key "foo".
 * Only the first dot is used as the section separator; sub-keys may contain
 * further dots (e.g. "limits.max_depth" → section "limits", key "max_depth").
 */
function nestFlatSettings(
  flat: Record<string, FieldMeta>,
): Record<string, Record<string, FieldMeta>> {
  const nested: Record<string, Record<string, FieldMeta>> = {};
  for (const [dotPath, meta] of Object.entries(flat)) {
    const dotIdx = dotPath.indexOf('.');
    if (dotIdx === -1) {
      // No section prefix — put at top-level under its own name
      nested[dotPath] ??= {};
      nested[dotPath][dotPath] = meta;
    } else {
      const section = dotPath.slice(0, dotIdx);
      const key = dotPath.slice(dotIdx + 1);
      nested[section] ??= {};
      nested[section][key] = meta;
    }
  }
  return nested;
}

/**
 * Register settings management routes on the Fastify instance.
 *
 * Endpoints:
 * - `GET /api/settings`        - Return current config with per-field source tracking (AC-G3, AC-G4)
 * - `PUT /api/settings`        - Update config, persist to YAML, return updated config (AC-G5)
 * - `POST /api/settings/reload` - Re-read config file, return updated config (AC-G9)
 */
function registerSettingsRoutes(app: FastifyInstance, ctx: RouteContext): void {
  // GET /api/settings — return config with provenance metadata
  app.get('/api/settings', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.configLoader) {
      reply.code(503).send({ error: 'ConfigLoader not available' });
      return;
    }

    const flat = await ctx.configLoader.getConfigWithSources();
    reply.send(nestFlatSettings(flat as Record<string, FieldMeta>));
  });

  // PUT /api/settings — validate and persist config changes
  app.put('/api/settings', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.configLoader) {
      reply.code(503).send({ error: 'ConfigLoader not available' });
      return;
    }

    // Zod validation (AC-G14): body must be a plain JSON object
    const parseResult = settingsUpdateBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.code(400).send({ error: 'Request body must be a JSON object' });
      return;
    }
    const body = parseResult.data as Partial<MasterConfig>;

    // Merge body on top of current config
    const current = ctx.configLoader.getMaster();
    const updated = deepMergeConfig(current, body);

    try {
      await ctx.configLoader.saveMaster(updated);
    } catch (err) {
      // Only map domain validation failures to 400. Re-throw everything else so
      // the shared onError hook logs the full error and returns a generic 5xx
      // with a correlation ID (AC-G15).
      if (err instanceof ValidationError) {
        reply.code(400).send({ error: err.message });
        return;
      }
      throw err;
    }

    // Audit log (AC-G5)
    ctx.logger?.audit('Settings updated via API', {
      fields_changed: Object.keys(body),
    });

    const flat = await ctx.configLoader.getConfigWithSources();
    reply.send(nestFlatSettings(flat as Record<string, FieldMeta>));
  });

  // POST /api/settings/reload — re-read config from disk
  app.post('/api/settings/reload', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.configLoader) {
      reply.code(503).send({ error: 'ConfigLoader not available' });
      return;
    }

    await ctx.configLoader.loadMaster();

    // Audit log (AC-G9)
    ctx.logger?.audit('Config reloaded via API');

    const flat = await ctx.configLoader.getConfigWithSources();
    reply.send(nestFlatSettings(flat as Record<string, FieldMeta>));
  });
}

/**
 * Deep merge two config objects.
 * Only plain-object values are recursively merged; primitives and arrays from
 * `override` replace those in `base`.
 */
function deepMergeConfig(base: MasterConfig, override: Partial<MasterConfig>): MasterConfig {
  const result: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  const overrideRaw = override as unknown as Record<string, unknown>;
  for (const key of Object.keys(overrideRaw)) {
    const overrideVal = overrideRaw[key];
    const baseVal = result[key];
    if (
      overrideVal !== undefined &&
      typeof baseVal === 'object' && baseVal !== null && !Array.isArray(baseVal) &&
      typeof overrideVal === 'object' && overrideVal !== null && !Array.isArray(overrideVal)
    ) {
      result[key] = deepMergeConfig(
        baseVal as unknown as MasterConfig,
        overrideVal as unknown as Partial<MasterConfig>,
      );
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal;
    }
  }
  return result as unknown as MasterConfig;
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
      // Do not expose internal error details. Let the onError hook log and sanitize (AC-G15).
      throw err;
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
 * Delegates to individual route group registration functions.
 *
 * @param app - Fastify instance to register routes on
 * @param ctx - Route context with domain services
 */
export function registerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  registerHealthRoutes(app, ctx);
  registerTeamRoutes(app, ctx);
  registerTaskRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  registerContainerRoutes(app, ctx);
  registerLogRoutes(app, ctx);
  registerIntegrationRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerWebhookRoutes(app, ctx);
}

/**
 * Register infrastructure-level middleware on the Fastify instance.
 *
 * Applies a 1 MB body limit for all regular endpoints and registers an
 * `onError` hook that sanitizes 5xx responses by logging full error details
 * server-side with a correlation ID, and returning only a generic message
 * to the caller (AC-G15).
 *
 * This is kept separate from {@link registerRoutes} so that the
 * mock-based unit tests can call `registerRoutes` without needing
 * a real Fastify instance.
 *
 * @param app - Real Fastify instance (not a mock)
 * @param ctx - Route context (for logger access)
 */
export function registerMiddleware(app: FastifyInstance, ctx: RouteContext): void {
  // 1 MB body limit for all endpoints (AC-G14)
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: 1_048_576 },
    (_req, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Sanitize 5xx error responses: log full error, return correlation ID (AC-G15)
  app.addHook('onError', async (_request: FastifyRequest, reply: FastifyReply, error: Error) => {
    const correlationId = randomUUID();
    ctx.logger?.error('Unhandled API error', {
      correlation_id: correlationId,
      error: error.message,
      stack: error.stack,
    });
    if (reply.statusCode >= 500) {
      reply.code(500).send({
        error: 'Internal server error',
        correlationId,
      });
    }
  });
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

/**
 * Reset SSE log stream state.
 * Exposed for test isolation only — do not call in production code.
 */
export function resetSseStateForTest(): void {
  sseClients.clear();
  sseSubscriptionId = null;
  sseEventBus = null;
}