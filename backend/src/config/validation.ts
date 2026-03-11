/**
 * Config validation stubs using Zod schemas.
 *
 * Validation rules derived from Configuration-Schemas.md:
 *
 * ### masterConfigSchema (validateMasterConfig)
 * - server.listen_address: Required, non-empty
 * - server.data_dir: Required, non-empty
 * - server.log_level: Must be a valid LogLevel (debug, info, warn, error)
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
import type { MasterConfig } from './defaults.js';

// ---------------------------------------------------------------------------
// Zod Schema Stubs
// ---------------------------------------------------------------------------

/**
 * Zod schema for the root config (data/openhive.yaml).
 * Validates all fields per Configuration-Schemas.md § "Validation Rules (validateMasterConfig)".
 */
export const masterConfigSchema: z.ZodType<MasterConfig> = z.any() as z.ZodType<MasterConfig>;

/**
 * Zod schema for provider presets (data/providers.yaml).
 * Validates provider type, required credentials per type, and model tier mappings.
 * See Configuration-Schemas.md § "Validation Rules (validateProviders)".
 */
export const providerConfigSchema: z.ZodType<Record<string, unknown>> = z.any() as z.ZodType<Record<string, unknown>>;

/**
 * Zod schema for per-team config (team.yaml).
 * Validates slug format, leader_aid, tid, and agent entries.
 * See Configuration-Schemas.md § "Validation Rules (validateTeam)".
 */
export const teamConfigSchema: z.ZodType<Record<string, unknown>> = z.any() as z.ZodType<Record<string, unknown>>;

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
export function validateMasterConfig(_config: Record<string, unknown>): MasterConfig {
  throw new Error('Not implemented');
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
export function validateProviders(_providers: Record<string, unknown>): Record<string, unknown> {
  throw new Error('Not implemented');
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
export function validateTeam(_team: Record<string, unknown>): Record<string, unknown> {
  throw new Error('Not implemented');
}
