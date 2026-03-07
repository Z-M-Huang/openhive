/**
 * OpenHive Backend - Providers Config File I/O
 *
 * Implements read/write operations for providers.yaml (provider presets) and
 * environment variable resolution for container initialisation.
 *
 * File format:
 *   providers:
 *     default:
 *       type: oauth
 *       oauth_token: ...
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { Provider } from '../domain/types.js';
import { parseProviderType, validateModelTier } from '../domain/enums.js';
import { validateProviders } from './validation.js';

// ---------------------------------------------------------------------------
// Internal wrapper type
// ---------------------------------------------------------------------------

/** YAML file wrapper shape: { providers: { [name]: Provider } } */
interface ProvidersFile {
  providers: Record<string, Provider>;
}

// ---------------------------------------------------------------------------
// loadProvidersFromFile
// ---------------------------------------------------------------------------

/**
 * Reads and parses providers.yaml from the given path.
 *
 * The file must contain a `providers` key whose value is a map of provider
 * preset names to Provider objects. Validates the parsed map via
 * validateProviders and throws on any error.
 *
 * Throws:
 *   - Error if the file cannot be read or parsed
 *   - ValidationError if the providers map is empty or any provider is invalid
 */
export function loadProvidersFromFile(path: string): Record<string, Provider> {
  let data: string;
  try {
    data = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `failed to read providers file ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(data);
  } catch (err) {
    throw new Error(
      `failed to parse providers file ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Extract the providers map from the wrapper.
  let providers: Record<string, Provider>;
  if (
    parsed !== null &&
    parsed !== undefined &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed)
  ) {
    const wrapper = parsed as Partial<ProvidersFile>;
    providers = wrapper.providers ?? {};
  } else {
    providers = {};
  }

  validateProviders(providers);

  return providers;
}

// ---------------------------------------------------------------------------
// saveProvidersToFile
// ---------------------------------------------------------------------------

/**
 * Writes a providers map to the given path atomically (write to .tmp, then
 * rename to target). Uses file mode 0o600 because providers contain
 * sensitive credentials (API keys, OAuth tokens).
 *
 * Throws:
 *   - Error if the file cannot be marshalled, written, or renamed
 */
export function saveProvidersToFile(path: string, providers: Record<string, Provider>): void {
  const wrapper: ProvidersFile = { providers };

  let data: string;
  try {
    data = stringifyYaml(wrapper);
  } catch (err) {
    throw new Error(
      `failed to marshal providers: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const tmpPath = path + '.tmp';
  try {
    // 0o600 — owner read/write only (sensitive credentials)
    writeFileSync(tmpPath, data, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    throw new Error(
      `failed to write temp providers file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    renameSync(tmpPath, path);
  } catch (err) {
    // Best-effort cleanup of the temp file.
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup failure.
    }
    throw new Error(
      `failed to rename temp providers file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// resolveProviderEnv
// ---------------------------------------------------------------------------

/**
 * Resolves a provider preset to a map of environment variable names and
 * values for use in container initialisation.
 *
 * Provider type mapping:
 *   oauth            → CLAUDE_CODE_OAUTH_TOKEN
 *   anthropic_direct → ANTHROPIC_API_KEY (+ ANTHROPIC_BASE_URL if set)
 *
 * Model tier mapping (present in provider.models):
 *   haiku  → ANTHROPIC_DEFAULT_HAIKU_MODEL
 *   sonnet → ANTHROPIC_DEFAULT_SONNET_MODEL
 *   opus   → ANTHROPIC_DEFAULT_OPUS_MODEL
 *
 * Unknown provider types and unknown model tier keys are silently skipped.
 */
export function resolveProviderEnv(provider: Provider, _tier: string): Record<string, string> {
  const env: Record<string, string> = {};

  // Resolve credentials based on provider type.
  let pt: ReturnType<typeof parseProviderType> | null = null;
  try {
    pt = parseProviderType(provider.type);
  } catch {
    // Unknown provider type — skip credential env vars.
  }

  if (pt === 'oauth') {
    if (provider.oauth_token !== undefined && provider.oauth_token !== '') {
      env['CLAUDE_CODE_OAUTH_TOKEN'] = provider.oauth_token;
    }
  } else if (pt === 'anthropic_direct') {
    if (provider.api_key !== undefined && provider.api_key !== '') {
      env['ANTHROPIC_API_KEY'] = provider.api_key;
    }
    if (provider.base_url !== undefined && provider.base_url !== '') {
      env['ANTHROPIC_BASE_URL'] = provider.base_url;
    }
  }

  // Resolve model tier env vars.
  if (provider.models !== undefined) {
    for (const [tierKey, model] of Object.entries(provider.models)) {
      if (!validateModelTier(tierKey)) {
        continue;
      }
      switch (tierKey) {
        case 'haiku':
          env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = model;
          break;
        case 'sonnet':
          env['ANTHROPIC_DEFAULT_SONNET_MODEL'] = model;
          break;
        case 'opus':
          env['ANTHROPIC_DEFAULT_OPUS_MODEL'] = model;
          break;
      }
    }
  }

  return env;
}
