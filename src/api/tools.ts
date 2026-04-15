/**
 * Plugin tools API endpoints (AC-29).
 *
 * CRITICAL: /audit route MUST be registered before /:team/:name
 * to prevent "audit" from matching as the :team parameter.
 *
 * Lifecycle workflow:
 *   POST /deprecate — requires body `{ reason: string, by?: string }`.
 *     Missing/blank reason returns 400. Calls PluginToolStore.deprecate().
 *   POST /remove — active tools are rejected with 409.
 *     Only tools with status 'deprecated' (or 'failed_verification') may be removed.
 *     Calls PluginToolStore.markRemoved() to preserve audit data; the source file
 *     is unlinked, but the DB row is retained with status='removed'.
 */

import { readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { IPluginToolStore } from '../domain/interfaces.js';
import { errorMessage } from '../domain/errors.js';

export function registerToolRoutes(
  fastify: FastifyInstance,
  pluginToolStore: IPluginToolStore,
): void {
  // GET /api/v1/tools/audit — list all plugin tools with audit metadata
  // Registered BEFORE /:team/:name to avoid "audit" matching as :team
  fastify.get('/api/v1/tools/audit', async (_request, reply) => {
    try {
      const tools = pluginToolStore.getAll();
      return reply.code(200).send(tools);
    } catch (err) {
      return reply.code(500).send({ error: errorMessage(err) });
    }
  });

  // GET /api/v1/tools — list all plugin tools (optional ?team= filter)
  fastify.get<{
    Querystring: { team?: string };
  }>('/api/v1/tools', async (request, reply) => {
    try {
      const { team } = request.query;
      const tools = team
        ? pluginToolStore.getByTeam(team)
        : pluginToolStore.getAll();
      return reply.code(200).send(tools);
    } catch (err) {
      return reply.code(500).send({ error: errorMessage(err) });
    }
  });

  // GET /api/v1/tools/:team/:name — tool detail with source code
  fastify.get<{
    Params: { team: string; name: string };
  }>('/api/v1/tools/:team/:name', async (request, reply) => {
    try {
      const { team, name } = request.params;
      const tool = pluginToolStore.get(team, name);
      if (!tool) return reply.code(404).send({ error: 'Tool not found' });

      // Guard: only read source if path is within the expected plugins directory
      let source: string | null = null;
      const resolved = resolve(tool.sourcePath);
      if (resolved.includes(`/teams/${team}/plugins/`)) {
        try { source = readFileSync(resolved, 'utf-8'); } catch { /* file may not exist */ }
      }

      return reply.code(200).send({ ...tool, source });
    } catch (err) {
      return reply.code(500).send({ error: errorMessage(err) });
    }
  });

  // POST /api/v1/tools/:team/:name/deprecate — transition active → deprecated
  // Body: { reason: string (required, non-blank), by?: string }
  fastify.post<{
    Params: { team: string; name: string };
    Body: { reason?: unknown; by?: unknown };
  }>('/api/v1/tools/:team/:name/deprecate', async (request, reply) => {
    try {
      const { team, name } = request.params;
      const body = request.body ?? {};
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      const by = typeof body.by === 'string' && body.by.trim().length > 0
        ? body.by.trim()
        : 'unknown';

      if (reason.length === 0) {
        return reply.code(400).send({ error: 'reason is required' });
      }

      const tool = pluginToolStore.get(team, name);
      if (!tool) return reply.code(404).send({ error: 'Tool not found' });

      pluginToolStore.deprecate(team, name, reason, by);
      return reply.code(200).send({ success: true });
    } catch (err) {
      return reply.code(500).send({ error: errorMessage(err) });
    }
  });

  // POST /api/v1/tools/:team/:name/remove — transition deprecated → removed
  // Active tools are rejected with 409; audit record is preserved.
  // Body: { by?: string }
  fastify.post<{
    Params: { team: string; name: string };
    Body: { by?: unknown };
  }>('/api/v1/tools/:team/:name/remove', async (request, reply) => {
    try {
      const { team, name } = request.params;
      const body = request.body ?? {};
      const by = typeof body.by === 'string' && body.by.trim().length > 0
        ? body.by.trim()
        : 'unknown';

      const tool = pluginToolStore.get(team, name);
      if (!tool) return reply.code(404).send({ error: 'Tool not found' });

      if (tool.status === 'active') {
        return reply.code(409).send({
          error: 'Tool must be deprecated before removal',
        });
      }
      if (tool.status === 'removed') {
        return reply.code(409).send({ error: 'Tool is already removed' });
      }

      // Delete source file from disk if it exists within the expected path
      const resolved = resolve(tool.sourcePath);
      if (resolved.includes(`/teams/${team}/plugins/`)) {
        try { unlinkSync(resolved); } catch { /* file may already be gone */ }
      }
      pluginToolStore.markRemoved(team, name, by);
      return reply.code(200).send({ success: true, archived: true });
    } catch (err) {
      return reply.code(500).send({ error: errorMessage(err) });
    }
  });
}
