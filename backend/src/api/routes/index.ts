/**
 * API routes index for OpenHive REST API.
 *
 * Exports route registration functions for all REST API endpoint groups.
 * Each handler is a stub that throws until implemented in later layers.
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
 * registerRoutes(fastify);
 * ```
 *
 * @module api/routes
 */

import type {
  Task,
  Team,
  LogEntry,
} from '../../domain/index.js';

// ---------------------------------------------------------------------------
// Route context type (Fastify instance placeholder)
// ---------------------------------------------------------------------------

/**
 * Placeholder type for the Fastify instance passed to route registration.
 *
 * Will be replaced with the actual Fastify type once the framework dependency
 * is wired in during implementation layers.
 */
type FastifyInstance = unknown;

// ---------------------------------------------------------------------------
// Health Routes
// ---------------------------------------------------------------------------

/**
 * Register health check routes on the Fastify instance.
 *
 * Endpoints:
 * - `GET /api/health` - Returns system health status including uptime,
 *   container count, connected teams, and database connectivity.
 *
 * @param _app - Fastify instance to register routes on
 * @throws Error - Not yet implemented
 */
export function registerHealthRoutes(_app: FastifyInstance): void {
  void _app;
  throw new Error('Not implemented');
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
 *
 * All responses use {@link Team} domain types serialized as JSON.
 *
 * @param _app - Fastify instance to register routes on
 * @throws Error - Not yet implemented
 */
export function registerTeamRoutes(_app: FastifyInstance): void {
  void _app;
  throw new Error('Not implemented');
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
 *
 * All responses use {@link Task} domain types serialized as JSON.
 *
 * @param _app - Fastify instance to register routes on
 * @throws Error - Not yet implemented
 */
export function registerTaskRoutes(_app: FastifyInstance): void {
  void _app;
  throw new Error('Not implemented');
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
 *
 * All responses use {@link LogEntry} domain types serialized as JSON.
 *
 * @param _app - Fastify instance to register routes on
 * @throws Error - Not yet implemented
 */
export function registerLogRoutes(_app: FastifyInstance): void {
  void _app;
  throw new Error('Not implemented');
}

// ---------------------------------------------------------------------------
// Webhook Routes
// ---------------------------------------------------------------------------

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
 *
 * @param _app - Fastify instance to register routes on
 * @throws Error - Not yet implemented
 */
export function registerWebhookRoutes(_app: FastifyInstance): void {
  void _app;
  throw new Error('Not implemented');
}

// ---------------------------------------------------------------------------
// Main Registration
// ---------------------------------------------------------------------------

/**
 * Register all REST API route handlers on the Fastify instance.
 *
 * Called by {@link APIServer.start} during server initialization.
 * Delegates to individual route group registration functions:
 * - {@link registerHealthRoutes} - Health check
 * - {@link registerTeamRoutes} - Team management
 * - {@link registerTaskRoutes} - Task lifecycle
 * - {@link registerLogRoutes} - Log querying
 * - {@link registerWebhookRoutes} - Dynamic webhook endpoints
 *
 * @param _app - Fastify instance to register routes on
 * @throws Error - Not yet implemented
 */
export function registerRoutes(_app: FastifyInstance): void {
  void _app;
  throw new Error('Not implemented');
}

// Suppress unused import warnings — types are referenced in JSDoc only
void (0 as unknown as Task);
void (0 as unknown as Team);
void (0 as unknown as LogEntry);
