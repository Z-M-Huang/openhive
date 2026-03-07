/**
 * OpenHive Backend - SPA Handler
 *
 * Serves the compiled React SPA from disk. Static assets that exist on disk
 * are served directly; any unmatched path that is not an API route falls back
 * to index.html for client-side routing (React Router deep links).
 *
 */

import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// SPAPluginOptions
// ---------------------------------------------------------------------------

export interface SPAPluginOptions {
  /** Absolute path to the compiled React SPA dist directory. */
  root: string;
}

// ---------------------------------------------------------------------------
// spaPlugin
// ---------------------------------------------------------------------------

/**
 * Fastify plugin that serves the React SPA.
 * Register all API routes BEFORE this plugin — they take priority.
 * Static files are served when they exist; all other non-API paths fall back
 * to index.html (client-side routing).
 *
 */
export async function spaPlugin(
  fastify: FastifyInstance,
  opts: SPAPluginOptions,
): Promise<void> {
  // wildcard:false → only files that exist get routes; unknown paths fall
  // through to notFoundHandler instead of being handled internally.
  await fastify.register(fastifyStatic, {
    root: opts.root,
    wildcard: false,
    index: false,
  });

  // Client-side routing fallback.
  // API paths that don't match a registered route return 404 JSON, not the SPA.
  fastify.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    }
    return reply.sendFile('index.html');
  });
}
