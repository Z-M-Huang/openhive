/**
 * Zod schema stubs for config validation.
 *
 * Validation rules derived from Configuration-Schemas.md:
 *
 * ### masterConfigSchema (validateMasterConfig)
 * - server.listen_address: Required, non-empty
 * - server.data_dir: Required, non-empty
 * - server.log_level: Must be a valid LogLevel (trace, debug, info, warn, error, audit)
 * - assistant.name: Required, non-empty
 * - assistant.aid: Must match aid-xxx-xxx format
 * - assistant.provider: Required, non-empty
 * - assistant.model_tier: Must be a valid ModelTier (haiku, sonnet, opus)
 * - limits.max_depth: Positive integer, max 10
 * - limits.max_teams: Positive integer
 * - limits.max_agents_per_team: Positive integer
 *
 * ### providerConfigSchema (validateProviders)
 * - At least one provider in the map
 * - name: Non-empty (set from map key)
 * - type: Must be "oauth" or "anthropic_direct"
 * - oauth requires oauth_token
 * - anthropic_direct requires api_key
 *
 * ### teamConfigSchema (validateTeam)
 * - slug: Must pass validateSlug (lowercase kebab-case, max 63 chars, not reserved)
 * - leader_aid: Required, must match aid-xxx-xxx format
 * - tid: Must match tid-xxx-xxx format (if set)
 * - agents[*].aid: Must match aid-xxx-xxx format
 * - agents[*].name: Must be non-empty
 */

import { z } from 'zod';
import type { MasterConfig, TeamConfig } from './defaults.js';
import type { TriggerConfig } from '../domain/triggers.js';
import { validateAID, validateTID, validateSlug } from '../domain/domain.js';

// ---------------------------------------------------------------------------
// Helper Schemas (nested object validation)
// ---------------------------------------------------------------------------

const logArchiveConfigSchema = z.object({
  enabled: z.boolean(),
  max_entries: z.number().int().nonnegative(),
  keep_copies: z.number().int().nonnegative(),
  archive_dir: z.string(),
}).passthrough();

const messageArchiveConfigSchema = z.object({
  enabled: z.boolean(),
  max_entries: z.number().int().nonnegative(),
  keep_copies: z.number().int().nonnegative(),
  archive_dir: z.string(),
}).passthrough();

const serverConfigSchema = z.object({
  listen_address: z.string().min(1),
  data_dir: z.string().min(1),
  log_level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'audit']),
  log_archive: logArchiveConfigSchema,
  max_message_length: z.number().int().nonnegative(),
  default_idle_timeout: z.string(),
  event_bus_workers: z.number().int().nonnegative(),
  portal_ws_max_connections: z.number().int().nonnegative(),
  message_archive: messageArchiveConfigSchema,
}).passthrough();

const databasePragmaSchema = z.object({
  journal_size_limit: z.number(),
  cache_size: z.number(),
  busy_timeout: z.number(),
}).passthrough();

const databaseConfigSchema = z.object({
  path: z.string().min(1),
  wal_mode: z.boolean(),
  pragma: databasePragmaSchema,
}).passthrough();

const resourceLimitsSchema = z.object({
  max_memory: z.string(),
  max_cpus: z.number(),
  max_old_space: z.number(),
}).passthrough();

const dockerConfigSchema = z.object({
  image: z.string().min(1),
  network: z.string().min(1),
  resource_limits: resourceLimitsSchema,
}).passthrough();

const securityConfigSchema = z.object({
  encryption_key_path: z.string().min(1),
  token_ttl: z.string(),
  allowed_origins: z.array(z.string()),
}).passthrough();

const limitsConfigSchema = z.object({
  max_depth: z.number().int().positive().max(10),
  max_teams: z.number().int().positive(),
  max_agents_per_team: z.number().int().positive(),
  max_concurrent_tasks: z.number().int().nonnegative(),
}).passthrough();

const assistantConfigSchema = z.object({
  name: z.string().min(1),
  aid: z.string().refine(
    (val) => {
      try {
        validateAID(val);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Invalid AID format: must match aid-xxx-xxx pattern' }
  ),
  provider: z.string().min(1),
  model_tier: z.enum(['haiku', 'sonnet', 'opus']),
  max_turns: z.number().int().positive(),
  timeout_minutes: z.number().int().positive(),
}).passthrough();

const channelConfigSchema = z.object({
  enabled: z.boolean(),
  token_env: z.string().optional(),
  prefix: z.string().optional(),
  channel_id: z.string().optional(),
}).passthrough();

const channelsConfigSchema = z.object({
  discord: channelConfigSchema,
  slack: channelConfigSchema,
}).passthrough();

const agentRefSchema = z.object({
  aid: z.string().refine(
    (val) => {
      try {
        validateAID(val);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Invalid AID format: must match aid-xxx-xxx pattern' }
  ),
  name: z.string().min(1),
  leads_team: z.string().optional(),
}).passthrough();

const teamAgentConfigSchema = z.object({
  aid: z.string().refine(
    (val) => {
      try {
        validateAID(val);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Invalid AID format: must match aid-xxx-xxx pattern' }
  ),
  name: z.string().min(1),
  provider: z.string().optional(),
  model_tier: z.string().optional(),
  skills: z.array(z.string()).optional(),
  max_turns: z.number().int().positive().optional(),
  timeout_minutes: z.number().int().positive().optional(),
  leads_team: z.string().optional(),
  proactive_interval_minutes: z.number().int().positive().optional(),
}).passthrough();

const mcpServerConfigSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string()),
}).passthrough();

const teamResourceLimitsSchema = z.object({
  max_memory: z.string().optional(),
  max_cpus: z.number().optional(),
  max_old_space: z.number().optional(),
  idle_timeout: z.string().optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Trigger backward-compat preprocessor
// ---------------------------------------------------------------------------

/**
 * Preprocesses trigger config objects to accept the legacy team_slug field as
 * an alias for target_team. Emits a deprecation warning when team_slug is used.
 * Strips team_slug from the output so strict schemas do not reject it.
 */
function normalizeTriggerTeamField(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  if ('team_slug' in obj && !('target_team' in obj)) {
    console.warn(
      `[config] Trigger '${String(obj['name'] ?? '<unknown>')}': ` +
        `'team_slug' is deprecated. Use 'target_team' instead.`,
    );
    const { team_slug, ...rest } = obj;
    return { ...rest, target_team: team_slug };
  }
  // If both are present, target_team wins; strip team_slug to pass strict schemas.
  if ('team_slug' in obj && 'target_team' in obj) {
    const { team_slug: _deprecated, ...rest } = obj;
    return rest;
  }
  return obj;
}

// Trigger action schema: structured action payload for cron triggers (AC-E2)
export const triggerActionSchema = z.object({
  title: z.string(),
  prompt: z.string(),
  priority: z.enum(['P0', 'P1', 'P2']),
});

// AID format validator for trigger agent field
const aidStringSchema = z.string().refine(
  (val) => {
    try {
      validateAID(val);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Invalid AID format: must match aid-xxx-xxx pattern' }
);

/**
 * Normalizes cron trigger input so the output always has an `action` field.
 * Accepts:
 *   - Legacy form: { ..., prompt: string } → normalized to action object
 *   - New form with string shorthand: { ..., action: string } → normalized to action object
 *   - New form with object: { ..., action: { title, prompt, priority } } → passed through
 * Also delegates team_slug → target_team normalization.
 */
function normalizeCronTrigger(raw: unknown): unknown {
  // First apply team_slug normalization
  const obj = normalizeTriggerTeamField(raw) as Record<string, unknown>;
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return obj;

  // Normalize action field: promote flat 'prompt' to 'action' if action is missing
  if (!('action' in obj) && 'prompt' in obj) {
    const { prompt, ...rest } = obj;
    return {
      ...rest,
      action: { title: 'Triggered task', prompt, priority: 'P2' },
    };
  }

  // If action is a string shorthand, normalize to object
  if (typeof obj['action'] === 'string') {
    return {
      ...obj,
      action: { title: 'Triggered task', prompt: obj['action'], priority: 'P2' },
    };
  }

  return obj;
}

// Trigger config schemas (discriminated union)
const cronTriggerSchema = z.preprocess(
  normalizeCronTrigger,
  z.object({
    name: z.string(),
    target_team: z.string(),
    agent: aidStringSchema.optional(),
    enabled: z.boolean().optional(),
    type: z.literal('cron'),
    schedule: z.string(),
    action: triggerActionSchema,
  }).strict(),
);

const webhookTriggerSchema = z.preprocess(
  normalizeTriggerTeamField,
  z.object({
    name: z.string(),
    target_team: z.string(),
    enabled: z.boolean().optional(),
    type: z.literal('webhook'),
    path: z.string(),
    method: z.string().optional(),
  }).strict(),
);

const channelEventTriggerSchema = z.preprocess(
  normalizeTriggerTeamField,
  z.object({
    name: z.string(),
    target_team: z.string(),
    enabled: z.boolean().optional(),
    type: z.literal('channel_event'),
    pattern: z.string(),
    channel_type: z.string().optional(),
  }).strict(),
);

const taskCompletionTriggerSchema = z.preprocess(
  normalizeTriggerTeamField,
  z.object({
    name: z.string(),
    target_team: z.string(),
    enabled: z.boolean().optional(),
    type: z.literal('task_completion'),
    source_team: z.string().optional(),
    status_filter: z.array(z.string()).optional(),
  }).strict(),
);

// Cannot use discriminatedUnion with z.preprocess wrappers directly — use a
// plain union that dispatches on the 'type' field after preprocessing.
const triggerConfigSchema: z.ZodType<TriggerConfig> = z.union([
  cronTriggerSchema,
  webhookTriggerSchema,
  channelEventTriggerSchema,
  taskCompletionTriggerSchema,
]) as z.ZodType<TriggerConfig>;

// ---------------------------------------------------------------------------
// Provider Config Schemas (A5-2)
// ---------------------------------------------------------------------------

const oauthSchema = z.object({
  type: z.literal('oauth'),
  oauth_token: z.string().min(1),
  models: z.record(z.string()).optional(),
}).passthrough();

const anthropicDirectSchema = z.object({
  type: z.literal('anthropic_direct'),
  api_key: z.string().min(1),
  base_url: z.string().optional(),
  models: z.record(z.string()).optional(),
}).passthrough();

const providerEntrySchema = z.discriminatedUnion('type', [
  oauthSchema,
  anthropicDirectSchema,
]);

// ---------------------------------------------------------------------------
// Zod Schema Stubs
// ---------------------------------------------------------------------------

/**
 * Zod schema for the root config (data/openhive.yaml).
 * Validates all fields per Configuration-Schemas.md § "Validation Rules (validateMasterConfig)".
 */
export const masterConfigSchema: z.ZodType<MasterConfig> = z.object({
  server: serverConfigSchema,
  database: databaseConfigSchema,
  docker: dockerConfigSchema,
  security: securityConfigSchema,
  limits: limitsConfigSchema,
  assistant: assistantConfigSchema,
  channels: channelsConfigSchema,
  // A6-expanded optional fields
  triggers: z.array(triggerConfigSchema).optional(),
  skill_registries: z.array(z.string()).optional(),
  agents: z.array(agentRefSchema).optional(),
  providers: z.string().optional(),
  embedding: z.object({
    provider: z.string().min(1),
  }).optional(),
}).passthrough();

/**
 * Zod schema for provider presets (data/providers.yaml).
 * Validates provider type, required credentials per type, and model tier mappings.
 * See Configuration-Schemas.md § "Validation Rules (validateProviders)".
 */
export const providerConfigSchema: z.ZodType<Record<string, unknown>> = z
  .record(z.string(), providerEntrySchema)
  .refine(
    (obj) => Object.keys(obj).length > 0,
    'At least one provider required'
  ) as z.ZodType<Record<string, unknown>>;

/**
 * Zod schema for per-team config (team.yaml).
 * Validates slug format, leader_aid, tid, and agent entries.
 * See Configuration-Schemas.md § "Validation Rules (validateTeam)".
 */
export const teamConfigSchema: z.ZodType<TeamConfig> = z.object({
  slug: z.string().refine(
    (val) => {
      try {
        validateSlug(val);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Invalid slug format' }
  ),
  parent_slug: z.string().optional(),
  leader_aid: z.string().refine(
    (val) => {
      try {
        validateAID(val);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Invalid AID format' }
  ),
  tid: z.string().refine(
    (val) => {
      try {
        validateTID(val);
        return true;
      } catch {
        return false;
      }
    }
  ).optional(),
  description: z.string().optional(),
  agents: z.array(teamAgentConfigSchema).optional(),
  mcp_servers: z.array(mcpServerConfigSchema).optional(),
  triggers: z.array(triggerConfigSchema).optional(),
  proactive_interval_minutes: z.number().int().positive().optional(),
  resource_limits: teamResourceLimitsSchema.optional(),
  children: z.array(z.string()).optional(),
  env_vars: z.record(z.string(), z.string()).optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Validation Functions
// ---------------------------------------------------------------------------

/**
 * Validates a parsed master config object against the masterConfigSchema.
 *
 * Called after the three-layer resolution chain (compiled defaults -> YAML -> env vars)
 * merges all sources into a final config object.
 *
 * @param config - The merged master config to validate
 * @returns The validated MasterConfig
 * @throws Error if validation fails with descriptive field-level messages
 */
export function validateMasterConfig(_config: unknown): MasterConfig {
  return masterConfigSchema.parse(_config) as MasterConfig;
}

/**
 * Validates a parsed providers config against the providerConfigSchema.
 *
 * Ensures at least one provider exists, each has a valid type,
 * and type-specific credential fields are present.
 *
 * @param providers - The parsed providers.yaml content
 * @returns The validated providers config
 * @throws Error if validation fails
 */
export function validateProviders(_providers: unknown): Record<string, unknown> {
  return providerConfigSchema.parse(_providers);
}

/**
 * Validates a parsed team config against the teamConfigSchema.
 *
 * Checks slug format (via domain validateSlug), leader_aid format,
 * optional tid format, and all agent entries.
 *
 * @param team - The parsed team.yaml content
 * @returns The validated team config
 * @throws Error if validation fails
 */
export function validateTeam(_team: unknown): TeamConfig {
  return teamConfigSchema.parse(_team) as TeamConfig;
}
