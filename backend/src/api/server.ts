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

import type { WSHub } from '../domain/index.js';

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

  constructor(config: APIServerConfig) {
    this._config = config;
    // Prevent unused variable lint error
    void this._config;
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
  start(): Promise<void> {
    throw new Error('Not implemented');
  }

  /**
   * Gracefully stop the Fastify server.
   *
   * Closes all active connections, stops accepting new requests,
   * and releases the listening socket. Safe to call multiple times.
   */
  stop(): Promise<void> {
    throw new Error('Not implemented');
  }

  /**
   * Register all REST API route handlers on the Fastify instance.
   *
   * Mounts route modules under their respective prefixes:
   * - `/api/teams` - Team CRUD and listing
   * - `/api/agents` - Agent management
   * - `/api/tasks` - Task lifecycle and queries
   * - `/api/logs` - Log querying and streaming
   * - `/api/config` - Configuration read/write
   * - `/api/topology` - Org chart / topology inspection
   * - `/api/health` - Health check endpoint
   *
   * Also registers a catch-all route that serves `index.html` for
   * client-side routing (SPA fallback).
   */
  registerRoutes(): void {
    throw new Error('Not implemented');
  }
}
