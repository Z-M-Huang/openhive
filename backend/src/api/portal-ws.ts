/**
 * Portal WebSocket relay for OpenHive (root-only).
 *
 * Provides a secondary WebSocket connection from the REST API server for the
 * web portal. Unlike the container-facing WSHub (which uses the internal
 * hub-and-spoke protocol), this relay bridges internal {@link EventBus} events
 * to browser clients over standard WebSocket frames.
 *
 * **Relayed event types:**
 * - `heartbeat` — container/agent health status updates
 * - `task` — task lifecycle state transitions (created, started, completed, failed, escalated)
 * - `org-chart` — team/agent topology changes (team created/removed, agent added/removed)
 *
 * **Connection lifecycle:**
 * 1. Browser opens a WebSocket to `/ws/portal` on the API server
 * 2. The relay subscribes to relevant EventBus topics
 * 3. Events are serialized as JSON and broadcast to all connected portal clients
 * 4. On disconnect, per-client subscriptions are cleaned up
 *
 * **Root-only module:** This relay is only started when `OPENHIVE_IS_ROOT=true`.
 * Non-root containers do not serve portal WebSocket connections.
 *
 * @example
 * ```ts
 * const relay = new PortalWSRelay({ eventBus, server });
 * await relay.start();
 * // Browser clients can now connect to ws://host:port/ws/portal
 * relay.broadcast({ type: 'task', data: { taskId: '123', status: 'completed' } });
 * await relay.stop();
 * ```
 */

import type { BusEvent, EventBus } from '../domain/index.js';

/**
 * Configuration options for the portal WebSocket relay.
 */
export interface PortalWSRelayConfig {
  /**
   * The EventBus instance to subscribe to for internal system events.
   * The relay listens for heartbeat, task, and org-chart events and
   * forwards them to connected browser clients.
   */
  eventBus: EventBus;

  /**
   * Optional WebSocket path for portal connections.
   * @default '/ws/portal'
   */
  path?: string;
}

/**
 * Portal WebSocket relay that bridges internal EventBus events to browser clients.
 *
 * Responsibilities:
 * - Accepts WebSocket connections from the web portal SPA
 * - Subscribes to the internal {@link EventBus} for heartbeat, task, and org-chart events
 * - Serializes and broadcasts matching events to all connected portal clients
 * - Manages per-client connection lifecycle (connect, disconnect, cleanup)
 *
 * This is distinct from the {@link WSHub} which handles the internal
 * hub-and-spoke protocol between root and team containers. The PortalWSRelay
 * is a read-only fan-out to browser clients for real-time UI updates.
 */
export class PortalWSRelay {
  private readonly _config: PortalWSRelayConfig;

  constructor(config: PortalWSRelayConfig) {
    this._config = config;
    // Prevent unused variable lint error
    void this._config;
  }

  /**
   * Start the portal WebSocket relay.
   *
   * Initialization sequence:
   * 1. Set up WebSocket server or attach to existing HTTP server upgrade path
   * 2. Subscribe to EventBus for heartbeat, task, and org-chart event types
   * 3. Register connection handler for incoming browser WebSocket connections
   * 4. Begin relaying matching events to all connected clients
   *
   * @throws Error if the relay fails to initialize or subscribe to the EventBus
   */
  start(): Promise<void> {
    throw new Error('Not implemented');
  }

  /**
   * Gracefully stop the portal WebSocket relay.
   *
   * Shutdown sequence:
   * 1. Unsubscribe from all EventBus subscriptions
   * 2. Send close frames to all connected portal clients
   * 3. Close the WebSocket server and release resources
   *
   * Safe to call multiple times. After stopping, no further events
   * are relayed and new connections are rejected.
   */
  stop(): Promise<void> {
    throw new Error('Not implemented');
  }

  /**
   * Broadcast an event to all connected portal WebSocket clients.
   *
   * The event is serialized as a JSON string and sent to every currently
   * connected browser client. Clients that have disconnected or whose
   * send buffers are full are skipped (with a warning logged).
   *
   * @param event - The bus event to broadcast. Must include `type` and `data` fields.
   *                Typically one of: heartbeat, task, or org-chart event types.
   *
   * @throws Error if the relay has not been started
   */
  broadcast(_event: BusEvent): void {
    throw new Error('Not implemented');
  }
}
