/**
 * Webhook routes and registry.
 *
 * @module api/routes/webhook-routes
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { RouteContext } from './types.js';

interface WebhookRegistration {
  id: string;
  path: string;
  teamSlug: string;
  createdAt: number;
}

// In-memory webhook registry (would be persisted in production)
const webhookRegistry = new Map<string, WebhookRegistration>();

/**
 * Register a webhook endpoint.
 * Called by MCP tool register_webhook.
 */
export function registerWebhook(id: string, path: string, teamSlug: string): void {
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

export function registerWebhookRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post('/api/v1/hooks/:path', async (request: FastifyRequest, reply: FastifyReply) => {
    const { path } = request.params as { path: string };
    const webhookPath = `/${path}`;

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

    let targetAid = '';
    if (ctx.orgChart) {
      try {
        targetAid = ctx.orgChart.getDispatchTarget(registration.teamSlug).aid;
      } catch {
        reply.code(404).send({ error: `No agents found in team: ${registration.teamSlug}` });
        return;
      }
    }

    const taskId = `webhook-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
    const payload = request.body as Record<string, unknown>;
    const prompt = `Webhook received at ${webhookPath}:\n\n${JSON.stringify(payload, null, 2)}`;

    const task = {
      id: taskId,
      parent_id: '',
      team_slug: registration.teamSlug,
      agent_aid: targetAid,
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
      if (ctx.taskStore) {
        await ctx.taskStore.create(task);
      }

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
      throw err;
    }
  });

  app.get('/api/v1/hooks', async (_request: FastifyRequest, reply: FastifyReply) => {
    const webhooks = [...webhookRegistry.values()];
    reply.send({ webhooks });
  });

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
