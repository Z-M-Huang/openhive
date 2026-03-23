/**
 * POST /api/message — accepts { content }, routes through ChannelRouter.
 *
 * Always enabled. Used for E2E testing and programmatic interaction.
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
