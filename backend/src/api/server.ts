/**
 * OpenHive Backend - API Server
 *
 * Wires all middleware, API routes, WebSocket endpoints, and SPA together
 * into a Fastify server instance.
 *
 * createServer(listenAddr, logger, km, spaDir, wsHandler, chatHandler, allowedOrigins, deps)
 * Returns ServerInstance: { start(), shutdown(), address(), app }
 *
 */

import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';

import type {
  ConfigLoader,
  FastifyUpgradeHandler,
  GoOrchestrator,
  HeartbeatMonitor,
  KeyManager,
  LogStore,
  OrgChart,
  TaskStore,
} from '../domain/interfaces.js';
import type { DBLogger, MiddlewareLogger } from './middleware.js';
import {
  corsPlugin,
  panicRecoveryPlugin,
  requestIdPlugin,
  securityHeadersPlugin,
  structuredLoggingPlugin,
  timingPlugin,
} from './middleware.js';
import type { DroppedLogCounter } from './handlers.js';
import { healthHandler, notFoundHandler, unlockHandler } from './handlers.js';
import { registerConfigRoutes } from './handlers-config.js';
import { registerLogRoutes } from './handlers-logs.js';
import {
  getTeamsHandler,
  getTeamHandler,
  createTeamHandler,
  deleteTeamHandler,
  SLUG_PARAM_SCHEMA,
  CREATE_TEAM_SCHEMA,
} from './handlers-teams.js';
import {
  getTasksHandler,
  getTaskHandler,
  cancelTaskHandler,
  TASK_ID_PARAM_SCHEMA,
  GET_TASKS_QUERY_SCHEMA,
} from './handlers-tasks.js';
import type { PortalWSHandler } from './portal-ws.js';
import { registerPortalWSRoutes } from './portal-ws.js';
import { spaPlugin } from './spa.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Route handler type for POST /api/v1/chat. */
export type ChatHandler = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;

/** Optional server dependencies. All fields are optional. */
export interface ServerDeps {
  logStore?: LogStore;
  taskStore?: TaskStore;
  configLoader?: ConfigLoader;
  orgChart?: OrgChart;
  goOrchestrator?: GoOrchestrator;
  heartbeatMonitor?: HeartbeatMonitor;
  portalWS?: PortalWSHandler;
  dbLogger?: DroppedLogCounter;
  logWriter?: DBLogger;
}

/** API server instance returned by createServer. */
export interface ServerInstance {
  /** Start listening for connections. */
  start(): Promise<void>;
  /** Gracefully close the server and release the port. */
  shutdown(): Promise<void>;
  /**
   * Returns the bound address as "host:port" after start(),
   * or the configured listenAddr before start().
   */
  address(): string;
  /** Underlying Fastify instance (for inject-based testing). */
  app: FastifyInstance;
}

// ---------------------------------------------------------------------------
// createServer
// ---------------------------------------------------------------------------

/**
 * Creates and configures the Fastify API server.
 */
export function createServer(
  listenAddr: string,
  logger: MiddlewareLogger,
  km: KeyManager,
  spaDir: string | null,
  wsHandler: FastifyUpgradeHandler | null,
  chatHandler: ChatHandler | null,
  allowedOrigins: string[],
  deps: ServerDeps = {},
): ServerInstance {
  const startTime = new Date();
  const fastify = Fastify({ logger: false, disableRequestLogging: true });

  // ── WebSocket plugin + routes (must be registered in the same scope) ──────
  // @fastify/websocket's onRoute hook only intercepts routes within its scope.
  // Routes with { websocket: true } MUST be inside this register() callback.
  if (wsHandler !== null || deps.portalWS !== undefined) {
    void fastify.register(async (instance) => {
      await instance.register(fastifyWebsocket);

      if (wsHandler !== null) {
        instance.get(
          '/ws/container',
          { websocket: true },
          wsHandler as (socket: WebSocket, request: FastifyRequest) => void,
        );
      }

      if (deps.portalWS !== undefined) {
        registerPortalWSRoutes(instance, deps.portalWS);
      }
    });
  }

  // ── Middleware stack ─────────────────────────────────────────────────────
  void fastify.register(requestIdPlugin);
  void fastify.register(securityHeadersPlugin);
  void fastify.register(panicRecoveryPlugin(logger));
  void fastify.register(corsPlugin(allowedOrigins));
  void fastify.register(timingPlugin);
  void fastify.register(structuredLoggingPlugin(logger, deps.logWriter));

  // ── Core routes ───────────────────────────────────────────────────────────
  fastify.get('/api/v1/health', healthHandler(startTime, deps.dbLogger));
  fastify.post('/api/v1/auth/unlock', unlockHandler(km));

  if (chatHandler !== null) {
    fastify.post('/api/v1/chat', chatHandler);
  }

  // Config + provider management (conditional on configLoader)
  if (deps.configLoader !== undefined) {
    registerConfigRoutes(fastify, deps.configLoader, km, logger);
  }

  // Log viewer (conditional on logStore)
  if (deps.logStore !== undefined) {
    registerLogRoutes(fastify, deps.logStore, logger);
  }

  // Team management: GET routes require orgChart; write routes require orch
  if (deps.orgChart !== undefined) {
    const hbm = deps.heartbeatMonitor ?? null;
    fastify.get('/api/v1/teams', getTeamsHandler(deps.orgChart, hbm, logger));
    fastify.get(
      '/api/v1/teams/:slug',
      { schema: SLUG_PARAM_SCHEMA },
      getTeamHandler(deps.orgChart, hbm, logger),
    );
  }
  if (deps.goOrchestrator !== undefined) {
    fastify.post(
      '/api/v1/teams',
      { schema: CREATE_TEAM_SCHEMA },
      createTeamHandler(deps.goOrchestrator, logger),
    );
    fastify.delete(
      '/api/v1/teams/:slug',
      { schema: SLUG_PARAM_SCHEMA },
      deleteTeamHandler(deps.goOrchestrator, logger),
    );
  }

  // Task monitoring: GET routes require taskStore; cancel requires both
  if (deps.taskStore !== undefined) {
    fastify.get(
      '/api/v1/tasks',
      { schema: GET_TASKS_QUERY_SCHEMA },
      getTasksHandler(deps.taskStore, logger),
    );
    fastify.get(
      '/api/v1/tasks/:id',
      { schema: TASK_ID_PARAM_SCHEMA },
      getTaskHandler(deps.taskStore, logger),
    );
  }
  if (deps.taskStore !== undefined && deps.goOrchestrator !== undefined) {
    fastify.post(
      '/api/v1/tasks/:id/cancel',
      { schema: TASK_ID_PARAM_SCHEMA },
      cancelTaskHandler(deps.goOrchestrator, deps.taskStore, logger),
    );
  }

  // NOTE: WebSocket routes (/ws/container and /api/v1/portal/ws) are registered
  // inside the @fastify/websocket plugin scope at the top of this function.

  // SPA catch-all or JSON 404 (must be last)
  if (spaDir !== null) {
    void fastify.register(spaPlugin, { root: spaDir });
  } else {
    fastify.setNotFoundHandler(notFoundHandler());
  }

  // ── Listen address parsing ────────────────────────────────────────────────
  const lastColon = listenAddr.lastIndexOf(':');
  const host = lastColon > 0 ? listenAddr.slice(0, lastColon) : '0.0.0.0';
  const port = parseInt(listenAddr.slice(lastColon + 1), 10);

  // ── ServerInstance ────────────────────────────────────────────────────────
  return {
    app: fastify,

    async start(): Promise<void> {
      await fastify.listen({ host, port });
    },

    async shutdown(): Promise<void> {
      await fastify.close();
    },

    address(): string {
      const addr = fastify.server.address();
      if (addr === null || typeof addr === 'string') {
        return listenAddr;
      }
      const { address, port: boundPort } = addr;
      return address.includes(':') ? `[${address}]:${boundPort}` : `${address}:${boundPort}`;
    },
  };
}
