/**
 * OpenHive Backend - Portal WebSocket Handler
 *
 * Implements GET /api/v1/portal/ws — real-time event streaming to web portal
 * clients. Localhost-only origin check, max connection limit, event filtering
 * by team/level, subscriptions to log, task, heartbeat, and container events.
 *
 */

// Activate @fastify/websocket TypeScript declaration merging for 'websocket: true'
import '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';

import type { EventBus } from '../domain/interfaces.js';
import type { Event } from '../domain/types.js';
import type { LogLevel } from '../domain/enums.js';
import { LOG_LEVELS, validateLogLevel } from '../domain/enums.js';
import type { MiddlewareLogger } from './middleware.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CONNECTIONS = 10;

/**
 * Log level priority order. Index position is used for numeric comparison
 * since LogLevel values are string literals.
 */
const LOG_LEVEL_ORDER: readonly LogLevel[] = LOG_LEVELS;

// ---------------------------------------------------------------------------
// PortalWSFilter
// ---------------------------------------------------------------------------

/**
 * Filtering criteria for a portal WebSocket connection.
 */
export interface PortalWSFilter {
  teamSlug: string;
  minLevel: LogLevel;
  excludeDebug: boolean;
}

// ---------------------------------------------------------------------------
// PortalSocket — minimal interface for testability
// ---------------------------------------------------------------------------

/**
 * Minimal WebSocket socket interface used by PortalWSHandler.
 * Concrete usage: ws.WebSocket cast at the registration boundary.
 * Test usage: mock socket objects.
 */
export interface PortalSocket {
  send(data: string): void;
  close(): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

// ---------------------------------------------------------------------------
// PortalRequest — minimal request interface for testability
// ---------------------------------------------------------------------------

/**
 * Minimal HTTP request interface used by PortalWSHandler.
 * Concrete usage: FastifyRequest adapter at registration boundary.
 * Test usage: plain object literals.
 */
export interface PortalRequest {
  headers: { origin?: string };
  url: string;
}

// ---------------------------------------------------------------------------
// checkPortalOrigin — pure function, exported for testing
// ---------------------------------------------------------------------------

/**
 * Validates that the origin is localhost-only.
 * Empty origin (direct connection) is always allowed.
 */
export function checkPortalOrigin(origin: string): boolean {
  if (origin === '') return true;
  let host = origin.toLowerCase();
  // Strip protocol
  const protoIdx = host.indexOf('://');
  if (protoIdx >= 0) host = host.slice(protoIdx + 3);
  // Strip path
  const pathIdx = host.indexOf('/');
  if (pathIdx >= 0) host = host.slice(0, pathIdx);
  // Strip port
  const portIdx = host.lastIndexOf(':');
  if (portIdx >= 0) host = host.slice(0, portIdx);
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

// ---------------------------------------------------------------------------
// parsePortalWSFilter — pure function, exported for testing
// ---------------------------------------------------------------------------

/**
 * Parses portal WebSocket filter from a URL query string.
 */
export function parsePortalWSFilter(search: string): PortalWSFilter {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const teamSlug = params.get('team') ?? '';
  const excludeDebug = params.get('include_debug') !== 'true';
  const levelStr = params.get('level');
  let minLevel: LogLevel;
  if (levelStr !== null && validateLogLevel(levelStr)) {
    minLevel = levelStr;
  } else {
    minLevel = excludeDebug ? 'info' : 'debug';
  }
  return { teamSlug, minLevel, excludeDebug };
}

// ---------------------------------------------------------------------------
// buildPortalFilter — pure function, exported for testing
// ---------------------------------------------------------------------------

/**
 * Builds an EventBus filter function from a PortalWSFilter.
 */
export function buildPortalFilter(filter: PortalWSFilter): (event: Event) => boolean {
  const minLevelIdx = LOG_LEVEL_ORDER.indexOf(filter.minLevel);
  return (event: Event): boolean => {
    if (event.type === 'log_entry' && event.payload.kind === 'log_entry') {
      const entry = event.payload.entry;
      const entryLevelIdx = LOG_LEVEL_ORDER.indexOf(entry.level);
      if (entryLevelIdx < minLevelIdx) return false;
      if (filter.excludeDebug && entry.level === 'debug') return false;
      if (filter.teamSlug !== '' && entry.team_name !== filter.teamSlug) return false;
    }
    return true;
  };
}

// ---------------------------------------------------------------------------
// PortalWSHandler
// ---------------------------------------------------------------------------

/**
 * Portal WebSocket handler — real-time event streaming endpoint.
 */
export class PortalWSHandler {
  private readonly eventBus: EventBus;
  private readonly logger: MiddlewareLogger;
  private readonly maxConnections: number;
  private _activeConnections = 0;

  constructor(
    eventBus: EventBus,
    logger: MiddlewareLogger,
    maxConnections = DEFAULT_MAX_CONNECTIONS,
  ) {
    this.eventBus = eventBus;
    this.logger = logger;
    this.maxConnections = maxConnections;
  }

  /**
   * Handles an upgraded WebSocket connection from the portal.
   */
  handleUpgrade(socket: PortalSocket, request: PortalRequest): void {
    // Rate limit: reject if at max connections
    if (this._activeConnections >= this.maxConnections) {
      socket.close();
      return;
    }

    // Validate origin
    const origin = request.headers.origin ?? '';
    if (!checkPortalOrigin(origin)) {
      socket.close();
      return;
    }

    // Parse filter from query string
    const qIdx = request.url.indexOf('?');
    const search = qIdx >= 0 ? request.url.slice(qIdx) : '';
    const filter = parsePortalWSFilter(search);
    const filterFn = buildPortalFilter(filter);

    this._activeConnections++;

    // Dispatch helper: serialize event and send (drop on error)
    const dispatch = (event: Event): void => {
      try {
        socket.send(JSON.stringify(event));
      } catch {
        // Drop the event if the socket is unavailable; cleanup handles disconnect
      }
    };

    // Subscribe to the 4 event types
    const subIds = [
      this.eventBus.filteredSubscribe('log_entry', filterFn, dispatch),
      this.eventBus.filteredSubscribe('task_updated', filterFn, dispatch),
      this.eventBus.filteredSubscribe('heartbeat_received', filterFn, dispatch),
      this.eventBus.filteredSubscribe('container_state_changed', filterFn, dispatch),
    ];

    // Cleanup on disconnect (guarded to avoid double-cleanup on error+close)
    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      for (const id of subIds) {
        this.eventBus.unsubscribe(id);
      }
      this._activeConnections--;
      this.logger.info('portal ws client disconnected');
    };

    socket.on('close', cleanup);
    socket.on('error', (err: Error) => {
      this.logger.warn('portal ws client error', err.message);
      cleanup();
    });

    this.logger.info('portal ws client connected', { teamFilter: filter.teamSlug });
  }

  /**
   * Returns the number of active portal WebSocket connections.
   */
  activeConnections(): number {
    return this._activeConnections;
  }
}

// ---------------------------------------------------------------------------
// registerPortalWSRoutes
// ---------------------------------------------------------------------------

/**
 * Registers the portal WebSocket route on the Fastify instance.
 * Requires @fastify/websocket to be registered on the instance.
 */
export function registerPortalWSRoutes(
  fastify: FastifyInstance,
  handler: PortalWSHandler,
): void {
  fastify.get(
    '/api/v1/portal/ws',
    { websocket: true },
    (socket: WebSocket, request: FastifyRequest) => {
      handler.handleUpgrade(socket as unknown as PortalSocket, {
        headers: { origin: request.headers.origin },
        url: request.url,
      });
    },
  );
}
