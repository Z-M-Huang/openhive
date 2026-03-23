/**
 * Secret resolver — loads KEY=VALUE .env files from the secrets directory.
 *
 * Supports per-team and global secret files with path traversal protection.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { SecretString } from './secret-string.js';
import { ConfigError, ValidationError } from '../domain/errors.js';

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DEFAULT_BASE_DIR = '/data/secrets';

/** Parse KEY=VALUE lines from text, skipping blanks and # comments. */
function parseEnvContent(content: string): Map<string, SecretString> {
  const result = new Map<string, SecretString>();
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    if (key) result.set(key, new SecretString(value));
  }
  return result;
}

/** Load a .env file if it exists, returning an empty map if missing. */
function loadEnvFile(filePath: string): Map<string, SecretString> {
  if (!existsSync(filePath)) return new Map();
  try {
    return parseEnvContent(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Failed to read secrets file ${filePath}: ${msg}`);
  }
}

/**
 * Resolve secrets for a team by merging global.env (lower precedence)
 * with {team}.env (higher precedence).
 */
export function resolveSecrets(
  teamSlug: string,
  baseDir: string = DEFAULT_BASE_DIR,
): Map<string, SecretString> {
  if (!SLUG_RE.test(teamSlug)) {
    throw new ValidationError(
      `Invalid team slug: "${teamSlug}" — must match ${SLUG_RE.source}`,
    );
  }

  const resolvedBase = resolve(baseDir);
  const teamFile = resolve(resolvedBase, `${teamSlug}.env`);

  // Path traversal protection
  if (!teamFile.startsWith(resolvedBase + sep) && teamFile !== resolvedBase) {
    throw new ValidationError(
      `Path traversal detected for team slug: "${teamSlug}"`,
    );
  }

  const globalSecrets = loadEnvFile(resolve(resolvedBase, 'global.env'));
  const teamSecrets = loadEnvFile(teamFile);

  // Team secrets override global
  const merged = new Map(globalSecrets);
  for (const [k, v] of teamSecrets) {
    merged.set(k, v);
  }
  return merged;
}
