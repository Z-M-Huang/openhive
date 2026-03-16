/**
 * REST API server for OpenHive (root-only).
 *
 * Provides the HTTP layer for the OpenHive web portal and REST API endpoints.
 * Built on Fastify with CORS support, static file serving for the React SPA,
 * and WebSocket integration for the container hub.
 *
 * **Bind address (NFR06 / AC20):**
 * By default, the server binds to `127.0.0.1` (loopback only) for security.
 * Advanced users can override the listen address by setting the
 * `OPENHIVE_SYSTEM_LISTEN_ADDRESS` environment variable (e.g., `0.0.0.0`
 * to listen on all interfaces when running behind a reverse proxy).
 *
 * **Root-only module:** This server is only started when
 * `OPENHIVE_IS_ROOT=true`. Non-root containers do not run an HTTP server.
 *
 * **Static file serving:** The compiled React SPA is served from the
 * `web/dist` directory. All unmatched routes fall through to `index.html`
 * for client-side routing.
 *
 * **WebSocket integration:** The HTTP server's `upgrade` event is forwarded
 * to the WSHub for container WebSocket connections on the `/ws/container` path.
 *
 * @example
 * ```ts
 * const server = new APIServer({ port: 3000 });
 * await server.start();
 * // Server listening on http://127.0.0.1:3000
 * await server.stop();
 * ```
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WSHub, EventBus, OrgChart, ContainerManager, HealthMonitor, TriggerScheduler, Orchestrator, TaskStore, LogStore, TaskEventStore, IntegrationStore, CredentialStore, ConfigLoader, Logger, MessageRouter } from '../domain/index.js';
import { registerRoutes, registerMiddleware, type RouteContext } from './routes/index.js';
import { PortalWSRelay } from './portal-ws.js';
import { CLIWSRelay } from './cli-ws.js';

/**
 * Configuration options for the API server.
 */
export interface APIServerConfig {
  /**
   * TCP port to listen on.
   * @default 3000
   */
  port: number;

  /**
   * Bind address for the HTTP server.
   *
   * Defaults to `127.0.0.1` (loopback only) per NFR06.
   * Set to `0.0.0.0` to listen on all interfaces (e.g., behind a reverse proxy).
   * Can be overridden via the `OPENHIVE_SYSTEM_LISTEN_ADDRESS` environment variable.
   *
   * @default '127.0.0.1'
   */
  listenAddress?: string;

  /**
   * Optional WSHub instance for WebSocket upgrade handling.
   * When provided, HTTP upgrade requests on `/ws/container` are forwarded
   * to the hub.
   */
  wsHub?: WSHub;

  /**
   * Path to the static SPA assets directory (compiled React app).
   * Defaults to the `web/dist` directory relative to the project root.
   */
  staticDir?: string;

  /**
   * EventBus for portal WebSocket relay.
   */
  eventBus?: EventBus;

  /**
   * OrgChart for team/agent queries.
   */
  orgChart?: OrgChart;

  /**
   * ContainerManager for container operations.
   */
  containerManager?: ContainerManager;

  /**
   * HealthMonitor for health status.
   */
  healthMonitor?: HealthMonitor;

  /**
   * TriggerScheduler for trigger management.
   */
  triggerScheduler?: TriggerScheduler;

  /**
   * Orchestrator for task dispatch.
   */
  orchestrator?: Orchestrator;

  /**
   * TaskStore for task persistence.
   */
  taskStore?: TaskStore;

  /**
   * LogStore for log persistence.
   */
  logStore?: LogStore;

  /**
   * TaskEventStore for task events.
   */
  taskEventStore?: TaskEventStore;

  /**
   * IntegrationStore for integration configuration queries.
   */
  integrationStore?: IntegrationStore;

  /**
   * CredentialStore for credential queries (passed through to route context).
   */
  credentialStore?: CredentialStore;

  /**
   * ConfigLoader for settings read/write endpoints.
   */
  configLoader?: ConfigLoader;

  /**
   * Logger for audit logging from route handlers.
   */
  logger?: Logger;

  /**
   * MessageRouter for CLI WebSocket endpoint.
   * When provided, the `/ws/cli` endpoint is enabled for remote CLI clients.
   * Can be set after construction via {@link APIServer.setMessageRouter}.
   */
  messageRouter?: MessageRouter;
}

/**
 * REST API server implementing the Fastify-based HTTP layer (root-only).
 *
 * Responsibilities:
 * - Serves the REST API endpoints (teams, agents, tasks, logs, config)
 * - Serves the React SPA as static files with fallback to index.html
 * - Enables CORS for development and cross-origin access
 * - Forwards HTTP upgrade requests to the WSHub for WebSocket connections
 *
 * **Default bind address:** `127.0.0.1` (loopback only, per NFR06 / AC20).
 * Override with `OPENHIVE_SYSTEM_LISTEN_ADDRESS` environment variable or
 * the `listenAddress` config option for advanced deployments.
 */
export class APIServer {
  private readonly _config: APIServerConfig;
  private app: ReturnType<typeof Fastify> | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private portalRelay: PortalWSRelay | null = null;
  private cliRelay: CLIWSRelay | null = null;
  private startTime = 0;

  constructor(config: APIServerConfig) {
    this._config = config;
  }

  /**
   * Resolve the listen address from config or environment.
   * Priority: env var > config > default (127.0.0.1)
   */
  private resolveListenAddress(): string {
    const envAddress = process.env.OPENHIVE_SYSTEM_LISTEN_ADDRESS;
    if (envAddress) {
      return envAddress;
    }
    return this._config.listenAddress ?? '127.0.0.1';
  }

  /**
   * Resolve the static files directory.
   * Falls back to ../web/dist relative to this module.
   */
  private resolveStaticDir(): string {
    if (this._config.staticDir) {
      return this._config.staticDir;
    }
    // Default to web/dist relative to this module
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    return resolve(moduleDir, '../../../web/dist');
  }

  /**
   * Start the Fastify server.
   *
   * Initialization sequence:
   * 1. Create Fastify instance with logging
   * 2. Register `@fastify/cors` plugin for cross-origin requests
   * 3. Register `@fastify/static` plugin for SPA static file serving
   * 4. Call {@link registerRoutes} to mount all API route handlers
   * 5. Set up HTTP upgrade handler to forward `/ws/container` to WSHub
   * 6. Listen on the configured port and address
   *
   * The listen address is resolved in this order:
   * 1. `OPENHIVE_SYSTEM_LISTEN_ADDRESS` environment variable (highest priority)
   * 2. `listenAddress` from {@link APIServerConfig}
   * 3. `127.0.0.1` (default, loopback only per NFR06)
   *
   * @throws Error if the server fails to bind to the configured address/port
   */
  async start(): Promise<void> {
    this.startTime = Date.now();

    // Create Fastify instance
    this.app = Fastify({
      logger: false, // We use Pino separately
    });

    // Global error handler: convert known errors to appropriate HTTP status codes
    this.app.setErrorHandler((error: { statusCode?: number; code?: string; message?: string }, _request: FastifyRequest, reply: FastifyReply) => {
      // JSON parse errors from malformed request bodies
      if (error.statusCode === 400 || error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ||
          (error.message && error.message.includes('is not valid JSON'))) {
        reply.code(400).send({ error: 'Bad Request', message: error.message });
        return;
      }
      // Unhandled domain errors
      if (error.message && (error.message.includes('Invalid task state transition') ||
          error.message.includes('Reserved slug') ||
          error.message.includes('Invalid slug'))) {
        reply.code(400).send({ error: error.message });
        return;
      }
      // Default: 500 — log for debugging
      console.error('[API Error]', error.message ?? error);
      reply.code(500).send({ error: 'Internal Server Error', message: error.message });
    });

    // Register CORS plugin
    await this.app.register(cors, {
      origin: ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000', 'http://127.0.0.1:5173'],
      credentials: true,
    });

    // Register static file serving for SPA
    const staticDir = this.resolveStaticDir();
    if (existsSync(staticDir)) {
      await this.app.register(staticPlugin, {
        root: staticDir,
        prefix: '/',
        decorateReply: true,
      });

      // SPA fallback - serve index.html for unmatched routes (except /api/* and /ws/*)
      this.app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
        if (request.url.startsWith('/api') || request.url.startsWith('/ws')) {
          reply.code(404).send({ error: 'Not found' });
          return;
        }
        reply.sendFile('index.html');
      });
    }

    // Build route context
    const routeContext: RouteContext = {
      orgChart: this._config.orgChart,
      containerManager: this._config.containerManager,
      healthMonitor: this._config.healthMonitor,
      triggerScheduler: this._config.triggerScheduler,
      orchestrator: this._config.orchestrator,
      taskStore: this._config.taskStore,
      logStore: this._config.logStore,
      taskEventStore: this._config.taskEventStore,
      integrationStore: this._config.integrationStore,
      credentialStore: this._config.credentialStore,
      configLoader: this._config.configLoader,
      logger: this._config.logger,
      eventBus: this._config.eventBus,
    };

    // Register middleware (body limit, 5xx error handler)
    registerMiddleware(this.app, routeContext);

    // Register API routes
    registerRoutes(this.app, routeContext);

    // Get underlying HTTP server for WebSocket upgrade handling
    this.httpServer = this.app.server;

    // Set up WebSocket upgrade handler for container connections
    if (this._config.wsHub && this.httpServer) {
      this.httpServer.on('upgrade', (request, socket, head) => {
        const url = request.url ?? '';

        // Route container WebSocket connections to WSHub
        if (url.startsWith('/ws/container')) {
          this._config.wsHub!.handleUpgrade(request, socket, head);
          return;
        }

        // Route portal WebSocket connections
        if (url.startsWith('/ws/portal')) {
          // PortalWSRelay handles this via its own WebSocketServer
          // We just need to not destroy the socket here
          return;
        }

        // Route CLI WebSocket connections
        if (url.startsWith('/ws/cli')) {
          // CLIWSRelay handles this via its own WebSocketServer
          // We just need to not destroy the socket here
          return;
        }

        // Reject other upgrade requests
        socket.destroy();
      });
    }

    // Start portal WebSocket relay
    if (this._config.eventBus) {
      this.portalRelay = new PortalWSRelay({
        eventBus: this._config.eventBus,
        path: '/ws/portal',
      });
    }

    // Listen on configured port and address
    const listenAddress = this.resolveListenAddress();
    await this.app.listen({
      port: this._config.port,
      host: listenAddress,
    });

    // Start portal relay after server is listening
    if (this.portalRelay && this.httpServer) {
      await this.portalRelay.start(this.httpServer);
    }

    // Start CLI WebSocket relay if messageRouter was provided at construction
    if (this._config.messageRouter && this.httpServer) {
      this.cliRelay = new CLIWSRelay({
        messageRouter: this._config.messageRouter,
        path: '/ws/cli',
      });
      await this.cliRelay.start(this.httpServer);
    }
  }

  /**
   * Set the MessageRouter for the CLI WebSocket endpoint.
   *
   * Can be called after `start()` when the MessageRouter is created later
   * in the initialization sequence. Starts the CLI WebSocket relay
   * immediately if the HTTP server is already running.
   */
  async setMessageRouter(messageRouter: MessageRouter): Promise<void> {
    if (this.cliRelay) {
      return; // Already initialized
    }

    if (this.httpServer) {
      this.cliRelay = new CLIWSRelay({
        messageRouter,
        path: '/ws/cli',
      });
      await this.cliRelay.start(this.httpServer);
    }
  }

  /**
   * Gracefully stop the Fastify server.
   *
   * Closes all active connections, stops accepting new requests,
   * and releases the listening socket. Safe to call multiple times.
   */
  async stop(): Promise<void> {
    // Stop CLI relay
    if (this.cliRelay) {
      await this.cliRelay.stop();
      this.cliRelay = null;
    }

    // Stop portal relay
    if (this.portalRelay) {
      await this.portalRelay.stop();
      this.portalRelay = null;
    }

    // Close Fastify server
    if (this.app) {
      await this.app.close();
      this.app = null;
      this.httpServer = null;
    }
  }

  /**
   * Get the Fastify instance.
   * Returns null if server has not been started.
   */
  getApp(): ReturnType<typeof Fastify> | null {
    return this.app;
  }

  /**
   * Get the underlying HTTP server.
   * Returns null if server has not been started.
   */
  getServer(): ReturnType<typeof createServer> | null {
    return this.httpServer;
  }

  /**
   * Get the server start time (epoch ms).
   * Returns 0 if server has not been started.
   */
  getStartTime(): number {
    return this.startTime;
  }

  /**
   * Get the port the server is listening on.
   */
  getPort(): number {
    return this._config.port;
  }

  /**
   * Get the resolved listen address.
   */
  getListenAddress(): string {
    return this.resolveListenAddress();
  }
}