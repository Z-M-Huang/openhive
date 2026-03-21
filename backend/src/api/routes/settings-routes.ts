/**
 * Settings management routes.
 *
 * @module api/routes/settings-routes
 */

import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ValidationError } from '../../domain/errors.js';
import type { MasterConfig } from '../../config/defaults.js';
import type { RouteContext } from './types.js';

/** Leaf field descriptor returned by getConfigWithSources(). */
interface FieldMeta {
  value: unknown;
  source: 'default' | 'yaml' | 'env';
  isSecret?: boolean;
}

const settingsUpdateBodySchema = z.record(z.unknown());

function nestFlatSettings(
  flat: Record<string, FieldMeta>,
): Record<string, Record<string, FieldMeta>> {
  const nested: Record<string, Record<string, FieldMeta>> = {};
  for (const [dotPath, meta] of Object.entries(flat)) {
    const dotIdx = dotPath.indexOf('.');
    if (dotIdx === -1) {
      nested[dotPath] ??= {};
      nested[dotPath][dotPath] = meta;
    } else {
      const section = dotPath.slice(0, dotIdx);
      const key = dotPath.slice(dotIdx + 1);
      nested[section] ??= {};
      nested[section][key] = meta;
    }
  }
  return nested;
}

function deepMergeConfig(base: MasterConfig, override: Partial<MasterConfig>): MasterConfig {
  const result: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  const overrideRaw = override as unknown as Record<string, unknown>;
  for (const key of Object.keys(overrideRaw)) {
    const overrideVal = overrideRaw[key];
    const baseVal = result[key];
    if (
      overrideVal !== undefined &&
      typeof baseVal === 'object' && baseVal !== null && !Array.isArray(baseVal) &&
      typeof overrideVal === 'object' && overrideVal !== null && !Array.isArray(overrideVal)
    ) {
      result[key] = deepMergeConfig(
        baseVal as unknown as MasterConfig,
        overrideVal as unknown as Partial<MasterConfig>,
      );
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal;
    }
  }
  return result as unknown as MasterConfig;
}

export function registerSettingsRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/settings', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.configLoader) {
      reply.code(503).send({ error: 'ConfigLoader not available' });
      return;
    }

    const flat = await ctx.configLoader.getConfigWithSources();
    reply.send(nestFlatSettings(flat as Record<string, FieldMeta>));
  });

  app.put('/api/settings', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.configLoader) {
      reply.code(503).send({ error: 'ConfigLoader not available' });
      return;
    }

    const parseResult = settingsUpdateBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.code(400).send({ error: 'Request body must be a JSON object' });
      return;
    }
    const body = parseResult.data as Partial<MasterConfig>;

    const current = ctx.configLoader.getMaster();
    const updated = deepMergeConfig(current, body);

    try {
      await ctx.configLoader.saveMaster(updated);
    } catch (err) {
      if (err instanceof ValidationError) {
        reply.code(400).send({ error: err.message });
        return;
      }
      throw err;
    }

    ctx.logger?.audit('Settings updated via API', {
      fields_changed: Object.keys(body),
    });

    const flat = await ctx.configLoader.getConfigWithSources();
    reply.send(nestFlatSettings(flat as Record<string, FieldMeta>));
  });

  app.post('/api/settings/reload', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.configLoader) {
      reply.code(503).send({ error: 'ConfigLoader not available' });
      return;
    }

    await ctx.configLoader.loadMaster();

    ctx.logger?.audit('Config reloaded via API');

    const flat = await ctx.configLoader.getConfigWithSources();
    reply.send(nestFlatSettings(flat as Record<string, FieldMeta>));
  });
}
