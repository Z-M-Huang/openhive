/**
 * OpenHive Backend - Config and Provider API Handlers
 *
 * Implements GET/PUT /api/v1/config (with secret masking) and
 * GET/PUT /api/v1/providers (with optional encryption when key manager is unlocked).
 * Partial updates for config fields. No-cache headers on all config responses.
 *
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ConfigLoader, KeyManager } from '../domain/interfaces.js';
import type { ChannelConfig, MasterConfig, Provider, SystemConfig } from '../domain/types.js';
import type { MiddlewareLogger } from './middleware.js';
import { maskSecret, sendError, sendJSON } from './response.js';
import type { FastifyReplyShim } from './response.js';

// ---------------------------------------------------------------------------
// Masked output types
// ---------------------------------------------------------------------------

/** Channel config safe for API output (tokens masked). */
export interface MaskedChannelConfig {
  enabled: boolean;
  token?: string;
  channel_id?: string;
  store_path?: string;
}

export interface MaskedChannelsConfig {
  discord: MaskedChannelConfig;
  whatsapp: MaskedChannelConfig;
}

/** MasterConfig safe for API output (channel tokens masked). */
export interface MaskedMasterConfig {
  system: SystemConfig;
  channels: MaskedChannelsConfig;
}

/** Provider safe for API output (api_key and oauth_token masked). */
export interface MaskedProvider {
  name: string;
  type: string;
  base_url?: string;
  api_key?: string;
  oauth_token?: string;
  models?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Request body types (internal)
// ---------------------------------------------------------------------------

interface ChannelConfigUpdate {
  enabled?: boolean;
  token?: string;
  channel_id?: string;
  store_path?: string;
}

interface ChannelsConfigUpdate {
  discord?: ChannelConfigUpdate;
  whatsapp?: ChannelConfigUpdate;
}

interface SystemConfigUpdate {
  log_level?: string;
  data_dir?: string;
}

interface PutConfigRequest {
  system?: SystemConfigUpdate;
  channels?: ChannelsConfigUpdate;
}

// ---------------------------------------------------------------------------
// JSON schemas for Fastify body validation
// ---------------------------------------------------------------------------

const CHANNEL_UPDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' },
    token: { type: 'string' },
    channel_id: { type: 'string' },
    store_path: { type: 'string' },
  },
};

/** JSON schema for PUT /api/v1/config request body. */
export const CONFIG_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    system: {
      type: 'object',
      additionalProperties: false,
      properties: {
        log_level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
        data_dir: { type: 'string', maxLength: 500 },
      },
    },
    channels: {
      type: 'object',
      additionalProperties: false,
      properties: {
        discord: CHANNEL_UPDATE_SCHEMA,
        whatsapp: CHANNEL_UPDATE_SCHEMA,
      },
    },
  },
};

/** JSON schema for PUT /api/v1/providers request body. */
export const PROVIDERS_BODY_SCHEMA = {
  type: 'object',
  maxProperties: 50,
  additionalProperties: false,
  patternProperties: {
    '^[a-zA-Z0-9_-]+$': {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        type: { type: 'string' },
        base_url: { type: 'string' },
        api_key: { type: 'string' },
        oauth_token: { type: 'string' },
        models: { type: 'object', additionalProperties: { type: 'string' } },
      },
    },
  },
};

const BODY_LIMIT_1MB = 1 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/** Sets Cache-Control: no-store to prevent caching of sensitive config data. */
export function setNoCacheHeaders(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store');
}

/**
 * Returns a copy of MasterConfig with channel tokens masked.
 */
export function maskMasterConfig(cfg: MasterConfig): MaskedMasterConfig {
  const maskChannel = (ch: ChannelConfig): MaskedChannelConfig => ({
    enabled: ch.enabled,
    token: ch.token !== undefined ? maskSecret(ch.token) : undefined,
    channel_id: ch.channel_id,
    store_path: ch.store_path,
  });

  return {
    system: cfg.system,
    channels: {
      discord: maskChannel(cfg.channels.discord),
      whatsapp: maskChannel(cfg.channels.whatsapp),
    },
  };
}

/**
 * Returns a copy of Provider with api_key and oauth_token masked.
 */
export function maskProvider(p: Provider): MaskedProvider {
  return {
    name: p.name,
    type: p.type,
    base_url: p.base_url,
    api_key: p.api_key !== undefined ? maskSecret(p.api_key) : undefined,
    oauth_token: p.oauth_token !== undefined ? maskSecret(p.oauth_token) : undefined,
    models: p.models,
  };
}

/**
 * Applies non-empty fields from src to dst in place.
 */
export function applyChannelUpdate(dst: ChannelConfig, src: ChannelConfigUpdate): void {
  if (src.enabled !== undefined) {
    dst.enabled = src.enabled;
  }
  if (src.token !== undefined && src.token !== '') {
    dst.token = src.token;
  }
  if (src.channel_id !== undefined && src.channel_id !== '') {
    dst.channel_id = src.channel_id;
  }
  if (src.store_path !== undefined && src.store_path !== '') {
    dst.store_path = src.store_path;
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * Handler factory for GET /api/v1/config.
 * Loads master config, masks channel tokens, sets no-cache headers.
 */
export function getConfigHandler(
  cfgLoader: ConfigLoader,
  _km: KeyManager,
  logger: MiddlewareLogger,
) {
  return async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    let cfg: MasterConfig;
    try {
      cfg = await cfgLoader.loadMaster();
    } catch (err) {
      logger.error('failed to load master config', err);
      sendError(reply as FastifyReplyShim, 500, 'INTERNAL_ERROR', 'failed to load configuration');
      return;
    }
    setNoCacheHeaders(reply);
    sendJSON(reply as FastifyReplyShim, 200, maskMasterConfig(cfg));
  };
}

/**
 * Handler factory for PUT /api/v1/config.
 * Applies partial updates (system.log_level, system.data_dir, channels.*),
 * saves, and returns masked config.
 * Body schema is validated by Fastify before this handler is invoked.
 */
export function putConfigHandler(cfgLoader: ConfigLoader, logger: MiddlewareLogger) {
  return async (
    request: FastifyRequest<{ Body: PutConfigRequest }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const body = request.body;

    let cfg: MasterConfig;
    try {
      cfg = await cfgLoader.loadMaster();
    } catch (err) {
      logger.error('failed to load master config', err);
      sendError(reply as FastifyReplyShim, 500, 'INTERNAL_ERROR', 'failed to load configuration');
      return;
    }

    if (body.system !== undefined) {
      if (body.system.log_level !== undefined && body.system.log_level !== '') {
        cfg.system.log_level = body.system.log_level;
      }
      if (body.system.data_dir !== undefined && body.system.data_dir !== '') {
        cfg.system.data_dir = body.system.data_dir;
      }
    }

    if (body.channels !== undefined) {
      if (body.channels.discord !== undefined) {
        applyChannelUpdate(cfg.channels.discord, body.channels.discord);
      }
      if (body.channels.whatsapp !== undefined) {
        applyChannelUpdate(cfg.channels.whatsapp, body.channels.whatsapp);
      }
    }

    try {
      await cfgLoader.saveMaster(cfg);
    } catch (err) {
      logger.error('failed to save master config', err);
      sendError(reply as FastifyReplyShim, 500, 'INTERNAL_ERROR', 'failed to save configuration');
      return;
    }

    setNoCacheHeaders(reply);
    sendJSON(reply as FastifyReplyShim, 200, maskMasterConfig(cfg));
  };
}

/**
 * Handler factory for GET /api/v1/providers.
 * Loads providers, masks api_key and oauth_token fields, sets no-cache headers.
 */
export function getProvidersHandler(
  cfgLoader: ConfigLoader,
  _km: KeyManager,
  logger: MiddlewareLogger,
) {
  return async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    let providers: Record<string, Provider>;
    try {
      providers = await cfgLoader.loadProviders();
    } catch (err) {
      logger.error('failed to load providers', err);
      sendError(reply as FastifyReplyShim, 500, 'INTERNAL_ERROR', 'failed to load providers');
      return;
    }

    const masked: Record<string, MaskedProvider> = {};
    for (const [name, p] of Object.entries(providers)) {
      masked[name] = maskProvider(p);
    }

    setNoCacheHeaders(reply);
    sendJSON(reply as FastifyReplyShim, 200, masked);
  };
}

/**
 * Handler factory for PUT /api/v1/providers.
 * Encrypts api_key and oauth_token when key manager is unlocked, then saves.
 * Body schema is validated by Fastify before this handler is invoked.
 */
export function putProvidersHandler(
  cfgLoader: ConfigLoader,
  km: KeyManager,
  logger: MiddlewareLogger,
) {
  return async (
    request: FastifyRequest<{ Body: Record<string, Provider> }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const providers: Record<string, Provider> = { ...request.body };

    if (!km.isLocked()) {
      for (const [name, p] of Object.entries(providers)) {
        const updated: Provider = { ...p };
        if (p.api_key !== undefined && p.api_key !== '') {
          try {
            updated.api_key = await km.encrypt(p.api_key);
          } catch (err) {
            logger.error('failed to encrypt API key', { provider: name, error: err });
            sendError(reply as FastifyReplyShim, 500, 'INTERNAL_ERROR', 'failed to encrypt provider secrets');
            return;
          }
        }
        if (p.oauth_token !== undefined && p.oauth_token !== '') {
          try {
            updated.oauth_token = await km.encrypt(p.oauth_token);
          } catch (err) {
            logger.error('failed to encrypt OAuth token', { provider: name, error: err });
            sendError(reply as FastifyReplyShim, 500, 'INTERNAL_ERROR', 'failed to encrypt provider secrets');
            return;
          }
        }
        providers[name] = updated;
      }
    }

    try {
      await cfgLoader.saveProviders(providers);
    } catch (err) {
      logger.error('failed to save providers', err);
      sendError(reply as FastifyReplyShim, 500, 'INTERNAL_ERROR', 'failed to save providers');
      return;
    }

    const masked: Record<string, MaskedProvider> = {};
    for (const [name, p] of Object.entries(providers)) {
      masked[name] = maskProvider(p);
    }

    setNoCacheHeaders(reply);
    sendJSON(reply as FastifyReplyShim, 200, masked);
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers all config and provider routes on the Fastify instance.
 * Attaches JSON schemas and 1MB bodyLimit to PUT routes.
 */
export function registerConfigRoutes(
  fastify: FastifyInstance,
  cfgLoader: ConfigLoader,
  km: KeyManager,
  logger: MiddlewareLogger,
): void {
  fastify.get('/api/v1/config', getConfigHandler(cfgLoader, km, logger));
  fastify.put(
    '/api/v1/config',
    { schema: { body: CONFIG_BODY_SCHEMA }, bodyLimit: BODY_LIMIT_1MB },
    putConfigHandler(cfgLoader, logger),
  );
  fastify.get('/api/v1/providers', getProvidersHandler(cfgLoader, km, logger));
  fastify.put(
    '/api/v1/providers',
    { schema: { body: PROVIDERS_BODY_SCHEMA }, bodyLimit: BODY_LIMIT_1MB },
    putProvidersHandler(cfgLoader, km, logger),
  );
}
