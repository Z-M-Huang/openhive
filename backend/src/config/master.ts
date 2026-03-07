/**
 * OpenHive Backend - Master Config File I/O
 *
 * Implements read/write operations for openhive.yaml (MasterConfig).
 *
 * Load order:
 *   1. defaultMasterConfig()   — compiled-in defaults
 *   2. YAML file overrides     — deep-merged onto defaults
 *   3. OPENHIVE_* env vars     — applied last
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type {
  MasterConfig,
  SystemConfig,
  AssistantConfig,
  ChannelsConfig,
  Agent,
} from '../domain/types.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';
import { defaultMasterConfig } from './defaults.js';
import { validateMasterConfig } from './validation.js';

// ---------------------------------------------------------------------------
// Section name union — closed set of valid section names
// ---------------------------------------------------------------------------

/** All valid top-level section names in MasterConfig. */
export type ConfigSectionName = 'system' | 'assistant' | 'agents' | 'channels';

/** Mapping from section name to its TypeScript type. */
export type ConfigSectionType<S extends ConfigSectionName> = S extends 'system'
  ? SystemConfig
  : S extends 'assistant'
    ? AssistantConfig
    : S extends 'agents'
      ? Agent[]
      : S extends 'channels'
        ? ChannelsConfig
        : never;

// ---------------------------------------------------------------------------
// loadMasterFromFile
// ---------------------------------------------------------------------------

/**
 * Reads and parses openhive.yaml from the given path.
 *
 * Applies compiled defaults first, then merges YAML file overrides, then
 * applies OPENHIVE_* environment variable overrides. Validates the final
 * config and throws on any error.
 *
 * Throws:
 *   - Error if the file cannot be read or parsed
 *   - ValidationError if the resulting config is invalid
 */
export function loadMasterFromFile(path: string): MasterConfig {
  const cfg = defaultMasterConfig();

  let data: string;
  try {
    data = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `failed to read config file ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(data);
  } catch (err) {
    throw new Error(
      `failed to parse config file ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Merge parsed YAML onto defaults. Parsed may be null for empty files.
  // Cast cfg through unknown to satisfy deepMerge's Record<string, unknown>
  // parameter — safe because MasterConfig's structure matches the recursive
  // plain-object traversal performed by deepMerge.
  if (parsed !== null && parsed !== undefined) {
    deepMerge(cfg as unknown as Record<string, unknown>, parsed);
  }

  applyEnvOverrides(cfg);
  validateMasterConfig(cfg);

  return cfg;
}

// ---------------------------------------------------------------------------
// saveMasterToFile
// ---------------------------------------------------------------------------

/**
 * Writes a MasterConfig to the given path atomically (write to .tmp,
 * then rename to target).
 *
 * Throws:
 *   - Error if the file cannot be written or renamed
 */
export function saveMasterToFile(path: string, cfg: MasterConfig): void {
  let data: string;
  try {
    data = stringifyYaml(cfg);
  } catch (err) {
    throw new Error(
      `failed to marshal config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const tmpPath = path + '.tmp';
  try {
    writeFileSync(tmpPath, data, { encoding: 'utf8', mode: 0o644 });
  } catch (err) {
    throw new Error(
      `failed to write temp config file: ${err instanceof Error ? err.message : String(err)}`,
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
      `failed to rename temp config file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// getConfigSection
// ---------------------------------------------------------------------------

/**
 * Retrieves a named top-level section from MasterConfig.
 *
 * Returns the section value typed appropriately for the section name.
 * Throws NotFoundError for unknown section names.
 */
export function getConfigSection<S extends ConfigSectionName>(
  cfg: MasterConfig,
  section: S,
): ConfigSectionType<S> {
  switch (section) {
    case 'system':
      return cfg.system as ConfigSectionType<S>;
    case 'assistant':
      return cfg.assistant as ConfigSectionType<S>;
    case 'agents':
      return (cfg.agents ?? []) as ConfigSectionType<S>;
    case 'channels':
      return cfg.channels as ConfigSectionType<S>;
    default: {
      // Exhaustiveness: section is `never` here. Cast to string for the error.
      const sectionStr = section as string;
      throw new NotFoundError('config section', sectionStr);
    }
  }
}

/**
 * Overload that accepts an arbitrary string section name and returns the
 * section as a typed union or throws NotFoundError.
 *
 * This overload exists so callers that receive a runtime string (e.g. from
 * an HTTP request parameter) can use getConfigSection without a cast.
 */
export function getConfigSectionByName(
  cfg: MasterConfig,
  section: string,
): SystemConfig | AssistantConfig | Agent[] | ChannelsConfig {
  switch (section) {
    case 'system':
      return cfg.system;
    case 'assistant':
      return cfg.assistant;
    case 'agents':
      return cfg.agents ?? [];
    case 'channels':
      return cfg.channels;
    default:
      throw new NotFoundError('config section', section);
  }
}

// ---------------------------------------------------------------------------
// updateConfigField
// ---------------------------------------------------------------------------

/**
 * Updates a specific field in the config by section + dot-separated path.
 *
 * Example: updateConfigField(cfg, 'system', 'log_level', 'debug')
 *
 * Path traversal uses the object's own enumerable properties. Only string
 * and number values are accepted (matching the primitive field types in
 * MasterConfig).
 *
 * Throws:
 *   - ValidationError if the section is unknown
 *   - ValidationError if the path is empty
 *   - ValidationError if any path component does not exist
 *   - ValidationError if the final value type does not match the existing field type
 */
export function updateConfigField(
  cfg: MasterConfig,
  section: string,
  path: string,
  value: string | number | boolean,
): void {
  if (path === '') {
    throw new ValidationError('path', 'cannot be empty');
  }

  // Resolve the top-level section object.
  let sectionObj: Record<string, unknown>;
  switch (section) {
    case 'system':
      sectionObj = cfg.system as unknown as Record<string, unknown>;
      break;
    case 'assistant':
      sectionObj = cfg.assistant as unknown as Record<string, unknown>;
      break;
    case 'channels':
      sectionObj = cfg.channels as unknown as Record<string, unknown>;
      break;
    default:
      throw new ValidationError(section, 'unknown config section');
  }

  const parts = path.split('.');
  const lastKey = parts[parts.length - 1]!;

  // Traverse all but the last component to reach the parent object.
  let current: Record<string, unknown> = sectionObj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (!Object.prototype.hasOwnProperty.call(current, part)) {
      throw new ValidationError(path, `unknown config field: ${part}`);
    }
    const next = current[part];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      throw new ValidationError(path, `cannot traverse non-struct field: ${part}`);
    }
    current = next as Record<string, unknown>;
  }

  // Validate that the final key exists.
  if (!Object.prototype.hasOwnProperty.call(current, lastKey)) {
    throw new ValidationError(path, `unknown config field: ${lastKey}`);
  }

  // Type-check: the new value must be the same primitive type as the existing one.
  const existing = current[lastKey];
  if (existing !== null && existing !== undefined) {
    const existingType = typeof existing;
    const valueType = typeof value;
    if (existingType !== valueType) {
      throw new ValidationError(
        path,
        `type mismatch: expected ${existingType}, got ${valueType}`,
      );
    }
  }

  current[lastKey] = value;
}

// ---------------------------------------------------------------------------
// applyEnvOverrides
// ---------------------------------------------------------------------------

/**
 * Applies OPENHIVE_* environment variable overrides to the config.
 *
 * Supported env vars:
 *   OPENHIVE_SYSTEM_LISTEN_ADDRESS  → system.listen_address
 *   OPENHIVE_SYSTEM_DATA_DIR        → system.data_dir
 *   OPENHIVE_SYSTEM_WORKSPACE_ROOT  → system.workspace_root
 *   OPENHIVE_SYSTEM_LOG_LEVEL       → system.log_level
 *   OPENHIVE_ASSISTANT_NAME         → assistant.name
 *   OPENHIVE_ASSISTANT_AID          → assistant.aid
 *   OPENHIVE_ASSISTANT_PROVIDER     → assistant.provider
 *   OPENHIVE_ASSISTANT_MODEL_TIER   → assistant.model_tier
 */
export function applyEnvOverrides(cfg: MasterConfig): void {
  const setIfDefined = (envKey: string, setter: (val: string) => void): void => {
    const val = process.env[envKey];
    if (val !== undefined && val !== '') {
      setter(val);
    }
  };

  setIfDefined('OPENHIVE_SYSTEM_LISTEN_ADDRESS', (v) => {
    cfg.system.listen_address = v;
  });
  setIfDefined('OPENHIVE_SYSTEM_DATA_DIR', (v) => {
    cfg.system.data_dir = v;
  });
  setIfDefined('OPENHIVE_SYSTEM_WORKSPACE_ROOT', (v) => {
    cfg.system.workspace_root = v;
  });
  setIfDefined('OPENHIVE_SYSTEM_LOG_LEVEL', (v) => {
    cfg.system.log_level = v;
  });
  setIfDefined('OPENHIVE_ASSISTANT_NAME', (v) => {
    cfg.assistant.name = v;
  });
  setIfDefined('OPENHIVE_ASSISTANT_AID', (v) => {
    cfg.assistant.aid = v;
  });
  setIfDefined('OPENHIVE_ASSISTANT_PROVIDER', (v) => {
    cfg.assistant.provider = v;
  });
  setIfDefined('OPENHIVE_ASSISTANT_MODEL_TIER', (v) => {
    cfg.assistant.model_tier = v;
  });
}

// ---------------------------------------------------------------------------
// deepMerge (internal)
// ---------------------------------------------------------------------------

/**
 * Deep-merges `source` into `target` in place.
 *
 * Rules:
 *   - Primitive values in source overwrite target.
 *   - For objects, recurse (only own enumerable keys from source are merged).
 *   - Arrays and null in source overwrite target entirely.
 *
 * Only plain objects trigger recursion; anything else (arrays, null,
 * primitives) simply overwrites the corresponding key in target.
 *
 * This ensures that loading a partial YAML file (with missing fields) falls
 * back gracefully to defaults for the missing parts.
 */
function deepMerge(target: Record<string, unknown>, source: unknown): void {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    // source is not a plain object — nothing to merge at this level.
    return;
  }

  const sourceObj = source as Record<string, unknown>;
  for (const key of Object.keys(sourceObj)) {
    const srcVal = sourceObj[key];
    const tgtVal = target[key];

    if (
      srcVal !== null &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === 'object' &&
      !Array.isArray(tgtVal)
    ) {
      // Both sides are plain objects — recurse.
      deepMerge(tgtVal as Record<string, unknown>, srcVal);
    } else {
      // Primitive, array, or null — overwrite.
      target[key] = srcVal;
    }
  }
}
