/**
 * POST /api/message — accepts { content }, routes through ChannelRouter.
 *
 * Gated behind OPENHIVE_ENABLE_API_MESSAGE=true (off by default).
 * Used for E2E testing against a running Docker container.
 */

import type { FastifyInstance } from 'fastify';
import type { ChannelRouter } from '../channels/router.js';

export interface MessageEndpointDeps {
  readonly channelRouter: ChannelRouter;
}

interface MessageBody {
  readonly content: string;
}

export function registerMessageEndpoint(
  fastify: FastifyInstance,
  deps: MessageEndpointDeps,
): void {
  const enabled = process.env['OPENHIVE_ENABLE_API_MESSAGE'] === 'true';
  if (!enabled) return;

  fastify.post<{ Body: MessageBody }>('/api/message', async (request, reply) => {
    const body = request.body as MessageBody | undefined;
    if (!body?.content || typeof body.content !== 'string') {
      await reply.code(400).send({ error: 'missing or invalid "content" field' });
      return;
    }

    const content = body.content.trim();
    if (content.length === 0) {
      await reply.code(400).send({ error: 'content must not be empty' });
      return;
    }

    // Route through channel router as an API message
    const response = await deps.channelRouter.routeMessage({
      channelId: 'api',
      userId: 'api-client',
      content,
      timestamp: Date.now(),
    });

    await reply.code(200).send({
      success: true,
      response: response ?? null,
    });
  });
}
