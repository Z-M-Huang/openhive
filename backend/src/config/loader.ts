/**
 * Configuration loaders — read YAML files, validate with Zod, return typed results.
 *
 * All loaders fail-fast with ConfigError including the file path and Zod error details.
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import { ConfigError } from '../domain/errors.js';
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
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Failed to read config file ${filePath}: ${msg}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
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
