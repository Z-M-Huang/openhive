/**
 * Provider resolver — maps a provider profile name to concrete
 * model string and environment variables for the SDK.
 */

import { SecretString } from '../secrets/secret-string.js';
import { ConfigError } from '../domain/errors.js';
import type { ProvidersOutput } from '../config/validation.js';

export interface ResolvedProvider {
  readonly model: string;
  readonly env: Record<string, string>;
  readonly secrets: readonly SecretString[];
}

/**
 * Resolve a named provider profile to a model + env vars.
 * API keys are read directly from the profile (inline in providers.yaml).
 *
 * @param profileName  Profile key in providers.yaml (e.g. 'default').
 * @param providers    Parsed providers config.
 */
export function resolveProvider(
  profileName: string,
  providers: ProvidersOutput,
): ResolvedProvider {
  const profile = providers.profiles[profileName];
  if (!profile) {
    throw new ConfigError(
      `Provider profile "${profileName}" not found in providers config`,
    );
  }

  if (profile.type === 'api') {
    const apiKey = profile.api_key;
    if (!apiKey) {
      throw new ConfigError(
        `Provider profile "${profileName}" (api) missing api_key`,
      );
    }

    const resolvedModel = profile.model ?? 'claude-sonnet-4-20250514';
    const env: Record<string, string> = {
      ANTHROPIC_API_KEY: apiKey,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: resolvedModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: resolvedModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: resolvedModel,
    };
    if (profile.api_url) {
      env['ANTHROPIC_BASE_URL'] = profile.api_url;
    }

    return {
      model: resolvedModel,
      env,
      secrets: [new SecretString(apiKey)],
    };
  }

  if (profile.type === 'oauth') {
    const envVar = profile.oauth_token_env;
    if (!envVar) {
      throw new ConfigError(
        `Provider profile "${profileName}" (oauth) missing oauth_token_env`,
      );
    }
    const token = process.env[envVar];
    if (!token) {
      throw new ConfigError(
        `Environment variable "${envVar}" not set for oauth profile "${profileName}"`,
      );
    }

    const resolvedModel = profile.model ?? 'claude-sonnet-4-20250514';
    return {
      model: resolvedModel,
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: token,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: resolvedModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: resolvedModel,
        ANTHROPIC_DEFAULT_OPUS_MODEL: resolvedModel,
      },
      secrets: [new SecretString(token)],
    };
  }

  // Exhaustive check — should never reach here with valid Zod parsing
  throw new ConfigError(
    `Unknown provider type for profile "${profileName}"`,
  );
}
