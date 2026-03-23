/**
 * Health endpoint for OpenHive v3.
 *
 * GET /health returns JSON with component status.
 * Returns 200 if storage is OK, 503 otherwise.
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { SessionManager } from './sessions/manager.js';
import type { TriggerEngine } from './triggers/engine.js';
import type { ChannelRouter } from './channels/router.js';

export interface HealthDeps {
  readonly raw: Database.Database;
  readonly sessionManager: SessionManager;
  readonly triggerEngine: TriggerEngine;
  readonly channelRouter: ChannelRouter;
}

export function registerHealthEndpoint(fastify: FastifyInstance, deps: HealthDeps): void {
  fastify.get('/health', async (_request, reply) => {
    let storageOk = false;
    try {
      deps.raw.prepare('SELECT 1').get();
      storageOk = true;
    } catch {
      // storage check failed
    }

    const body = {
      storage: { ok: storageOk },
      sessions: { active: deps.sessionManager.getActive().length },
      triggers: { registered: deps.triggerEngine.getRegisteredCount() },
      channels: { connected: deps.channelRouter.getConnectedCount() },
    };

    const statusCode = storageOk ? 200 : 503;
    await reply.code(statusCode).send(body);
  });
}
