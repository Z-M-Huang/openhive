/**
 * API routes index for OpenHive REST API.
 *
 * Barrel file that re-exports all route groups, middleware, and webhook utilities.
 *
 * @module api/routes
 */

import type { FastifyInstance } from 'fastify';

// Re-export types
export type { RouteContext } from './types.js';

// Re-export middleware
export { registerMiddleware } from './middleware.js';

// Re-export webhook utilities (used by MCP tools)
export { registerWebhook, unregisterWebhook, listWebhooks } from './webhook-routes.js';

// Re-export SSE state reset (used by tests)
export { resetSseStateForTest } from './log-routes.js';

// Import route registration functions
import { registerHealthRoutes } from './health-routes.js';
import { registerTeamRoutes } from './team-routes.js';
import { registerTaskRoutes } from './task-routes.js';
import { registerAgentRoutes } from './agent-routes.js';
import { registerContainerRoutes } from './container-routes.js';
import { registerLogRoutes } from './log-routes.js';
import { registerIntegrationRoutes } from './integration-routes.js';
import { registerSettingsRoutes } from './settings-routes.js';
import { registerWebhookRoutes } from './webhook-routes.js';
import type { RouteContext } from './types.js';

/**
 * Register all REST API route handlers on the Fastify instance.
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
