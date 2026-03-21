/**
 * Log query and SSE streaming routes.
 *
 * @module api/routes/log-routes
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { LogLevel, EventBus, BusEvent } from '../../domain/index.js';
import { logQuerySchema } from './types.js';
import type { RouteContext } from './types.js';

// ---------------------------------------------------------------------------
// SSE Log Stream state (module-level for fan-out, shared across requests)
// ---------------------------------------------------------------------------

/** Maximum number of concurrent SSE log stream connections. */
const SSE_MAX_CLIENTS = 50;

/** Log-related EventBus event types/prefixes to forward to SSE clients. */
const LOG_EVENT_PREFIXES = ['log.', 'log_event'] as const;

/** A writable SSE client. */
interface SseClient {
  raw: { writable: boolean; write: (data: string) => void };
}

/** Set of currently connected SSE log stream clients. */
const sseClients = new Set<SseClient>();

/** Single shared EventBus subscription ID for SSE log fan-out. */
let sseSubscriptionId: string | null = null;

/** EventBus reference held for cleanup when the last client disconnects. */
let sseEventBus: EventBus | null = null;

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

function ensureSseSubscription(eventBus: EventBus): void {
  if (sseSubscriptionId !== null) {
    return;
  }
  sseEventBus = eventBus;
  sseSubscriptionId = eventBus.filteredSubscribe(
    (event: BusEvent) =>
      LOG_EVENT_PREFIXES.some((p) => event.type === p || event.type.startsWith(p)),
    fanOutToSseClients,
  );
}

function maybeTearDownSseSubscription(): void {
  if (sseClients.size === 0 && sseSubscriptionId !== null && sseEventBus !== null) {
    sseEventBus.unsubscribe(sseSubscriptionId);
    sseSubscriptionId = null;
    sseEventBus = null;
  }
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

export function registerLogRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/logs', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.logStore) {
      reply.code(503).send({ error: 'LogStore not available' });
      return;
    }

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

  app.get('/api/logs/stream', async (request: FastifyRequest, reply: FastifyReply) => {
    if (sseClients.size >= SSE_MAX_CLIENTS) {
      reply.code(503).send({ error: 'Too many SSE log stream connections' });
      return;
    }

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');

    reply.raw.write('data: {"type":"connected"}\n\n');

    const client: SseClient = { raw: reply.raw };
    sseClients.add(client);

    if (ctx.eventBus) {
      ensureSseSubscription(ctx.eventBus);
    }

    const heartbeat = setInterval(() => {
      if (reply.raw.writable) {
        reply.raw.write(': heartbeat\n\n');
      }
    }, 30000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(client);
      maybeTearDownSseSubscription();
    });

    return reply;
  });
}
