/**
 * Configuration loaders — read YAML files, validate with Zod, return typed results.
 *
 * All loaders fail-fast with ConfigError including the file path and Zod error details.
 *
 * Team config loading is consolidated in getTeamConfig() and getOrCreateTeamConfig().
 * All callers should use these instead of inline loading logic.
 */

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import { ConfigError, errorMessage } from '../domain/errors.js';
import type { TeamConfig } from '../domain/types.js';
import {
  TeamConfigSchema,
  ProvidersSchema,
  TriggersSchema,

  ChannelsSchema,
  SystemConfigSchema,
  LoggingSchema,
  type TeamConfigOutput,
  type ProvidersOutput,
  type TriggersOutput,

  type ChannelsOutput,
  type SystemConfigOutput,
  type LoggingOutput,
} from './validation.js';

function loadAndValidate(
  filePath: string,
  schema: { parse: (data: unknown) => unknown },
): unknown {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    const msg = errorMessage(err);
    throw new ConfigError(`Failed to read config file ${filePath}: ${msg}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const msg = errorMessage(err);
    throw new ConfigError(`Invalid YAML in ${filePath}: ${msg}`);
  }

  try {
    return schema.parse(parsed);
  } catch (err) {
    if (err instanceof ZodError) {
      const details = err.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new ConfigError(
        `Validation failed for ${filePath}:\n${details}`,
      );
    }
    throw err;
  }
}

export function loadTeamConfig(path: string): TeamConfigOutput {
  return loadAndValidate(path, TeamConfigSchema) as TeamConfigOutput;
}

// ── Consolidated team config loaders ────────────────────────────────────────

/** Ensure 'org' is always present in mcp_servers. */
function ensureOrgMcp(config: TeamConfig): TeamConfig {
  if (config.mcp_servers.includes('org')) return config;
  return { ...config, mcp_servers: ['org', ...config.mcp_servers] };
}

/**
 * Safe team config loader — returns the validated config or undefined.
 *
 * Reads from `{runDir}/teams/{teamName}/config.yaml`, validates with Zod,
 * ensures 'org' is in mcp_servers, and swallows errors (returning undefined).
 */
export function getTeamConfig(runDir: string, teamName: string): TeamConfig | undefined {
  const path = join(runDir, 'teams', teamName, 'config.yaml');
  if (!existsSync(path)) return undefined;
  try {
    return ensureOrgMcp(loadTeamConfig(path));
  } catch {
    return undefined;
  }
}

/**
 * Load team config or generate a sensible default — always returns a config.
 *
 * Resolution order:
 * 1. Explicit configPath (if provided)
 * 2. Conventional path `{runDir}/teams/{name}/config.yaml`
 * 3. Inline default with the given hints
 *
 * Used by spawn_team to bootstrap new teams.
 */
export function getOrCreateTeamConfig(
  runDir: string,
  name: string,
  configPath?: string,
  hints?: { description?: string; scopeAccepts?: string[]; parent?: string },
): TeamConfig {
  if (configPath) return ensureOrgMcp(loadTeamConfig(configPath));
  const path = join(runDir, 'teams', name, 'config.yaml');
  if (existsSync(path)) return ensureOrgMcp(loadTeamConfig(path));
  return {
    name,
    parent: hints?.parent ?? null,
    description: hints?.description ?? '',
    allowed_tools: ['*'],
    mcp_servers: ['org'],
    provider_profile: 'default',
    maxTurns: 100,
  };
}

export function loadProviders(path: string): ProvidersOutput {
  return loadAndValidate(path, ProvidersSchema) as ProvidersOutput;
}

export function loadTriggers(path: string): TriggersOutput {
  return loadAndValidate(path, TriggersSchema) as TriggersOutput;
}

export function loadChannels(path: string): ChannelsOutput {
  return loadAndValidate(path, ChannelsSchema) as ChannelsOutput;
}

export function loadSystemConfig(path: string): SystemConfigOutput {
  return loadAndValidate(path, SystemConfigSchema) as SystemConfigOutput;
}

export function loadLogging(path: string): LoggingOutput {
  return loadAndValidate(path, LoggingSchema) as LoggingOutput;
}
