/**
 * Zod validation schemas for OpenHive configuration files.
 *
 * Each schema validates and types one configuration surface:
 * team.yaml, providers.yaml, triggers, and logging.
 */

import { z } from 'zod';

// ── Team Config ─────────────────────────────────────────────────────────────

const TeamScopeSchema = z.object({
  accepts: z.array(z.string()).default([]),
  rejects: z.array(z.string()).default([]),
});

export const TeamConfigSchema = z.object({
  name: z.string().min(1),
  parent: z.string().nullable().optional().default(null),
  description: z.string().default(''),
  scope: TeamScopeSchema.optional(),
  allowed_tools: z.array(z.string()).default([]),
  mcp_servers: z.array(z.string()).default([]),
  provider_profile: z.string().min(1),
  maxTurns: z.number().int().positive().default(50),
  credentials: z.record(z.string(), z.string()).optional().default({}),
});

export type TeamConfigInput = z.input<typeof TeamConfigSchema>;
export type TeamConfigOutput = z.output<typeof TeamConfigSchema>;

// ── Providers ───────────────────────────────────────────────────────────────

const ProviderProfileSchema = z.object({
  type: z.enum(['api', 'oauth']),
  api_url: z.string().optional(),
  api_key: z.string().optional(),
  model: z.string().optional(),
  oauth_token_env: z.string().optional(),
});

export const ProvidersSchema = z.object({
  profiles: z.record(z.string(), ProviderProfileSchema),
});

export type ProvidersInput = z.input<typeof ProvidersSchema>;
export type ProvidersOutput = z.output<typeof ProvidersSchema>;

// ── Triggers ────────────────────────────────────────────────────────────────

const TriggerEntrySchema = z.object({
  name: z.string().min(1),
  type: z.enum(['schedule', 'keyword', 'message']),
  config: z.record(z.string(), z.unknown()).default({}),
  team: z.string().min(1),
  task: z.string().min(1),
  skill: z.string().optional(),
});

export const TriggersSchema = z.object({
  triggers: z.array(TriggerEntrySchema).default([]),
});

export type TriggersInput = z.input<typeof TriggersSchema>;
export type TriggersOutput = z.output<typeof TriggersSchema>;

// ── Channels ────────────────────────────────────────────────────────────────

const DiscordChannelSchema = z.object({
  token: z.string().min(1),
  watched_channels: z.array(z.string()).default([]),
});

const CliChannelSchema = z.object({
  enabled: z.boolean().default(true),
});

export const ChannelsSchema = z.object({
  discord: DiscordChannelSchema.optional(),
  cli: CliChannelSchema.default({ enabled: true }),
});

export type ChannelsInput = z.input<typeof ChannelsSchema>;
export type ChannelsOutput = z.output<typeof ChannelsSchema>;

// ── System Config ───────────────────────────────────────────────────────────

export const SystemConfigSchema = z.object({
  log_level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

export type SystemConfigInput = z.input<typeof SystemConfigSchema>;
export type SystemConfigOutput = z.output<typeof SystemConfigSchema>;

// ── Logging ─────────────────────────────────────────────────────────────────

export const LoggingSchema = z.object({
  level: z
    .enum(['trace', 'debug', 'info', 'warn', 'error'])
    .default('info'),
  retention: z.number().int().positive().optional(),
});

export type LoggingInput = z.input<typeof LoggingSchema>;
export type LoggingOutput = z.output<typeof LoggingSchema>;
