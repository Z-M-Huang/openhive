/**
 * Provider resolver — maps a provider profile name to concrete
 * model string and environment variables for the SDK.
 */

import type { SecretString } from '../secrets/secret-string.js';
import { ConfigError } from '../domain/errors.js';
import type { ProvidersOutput } from '../config/validation.js';

export interface ResolvedProvider {
  readonly model: string;
  readonly env: Record<string, string>;
}

/**
 * Resolve a named provider profile to a model + env vars.
 *
 * @param profileName  Profile key in providers.yaml (e.g. 'default').
 * @param providers    Parsed providers config.
 * @param secrets      Secret map (from resolveSecrets or test fixture).
 */
export function resolveProvider(
  profileName: string,
  providers: ProvidersOutput,
  secrets: Map<string, SecretString>,
): ResolvedProvider {
  const profile = providers.profiles[profileName];
  if (!profile) {
    throw new ConfigError(
      `Provider profile "${profileName}" not found in providers config`,
    );
  }

  if (profile.type === 'api') {
    const ref = profile.api_key_ref;
    if (!ref) {
      throw new ConfigError(
        `Provider profile "${profileName}" (api) missing api_key_ref`,
      );
    }
    const secret = secrets.get(ref);
    if (!secret) {
      throw new ConfigError(
        `Secret "${ref}" not found for provider profile "${profileName}"`,
      );
    }

    const env: Record<string, string> = {
      ANTHROPIC_API_KEY: secret.expose(),
    };
    if (profile.api_url) {
      env['ANTHROPIC_BASE_URL'] = profile.api_url;
    }

    return { model: profile.model ?? 'claude-sonnet-4-20250514', env };
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

    return {
      model: profile.model ?? 'claude-sonnet-4-20250514',
      env: { CLAUDE_CODE_OAUTH_TOKEN: token },
    };
  }

  // Exhaustive check — should never reach here with valid Zod parsing
  throw new ConfigError(
    `Unknown provider type for profile "${profileName}"`,
  );
}
