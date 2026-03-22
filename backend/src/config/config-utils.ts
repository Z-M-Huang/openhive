/**
 * Pure utility functions for config loading and management.
 *
 * @module config/config-utils
 */

import { createHash } from 'node:crypto';
import type { Team } from '../domain/index.js';
import type { TeamConfig } from './defaults.js';

// ---------------------------------------------------------------------------
// Deep Merge Utility
// ---------------------------------------------------------------------------

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursive deep merge. For each key in source:
 * - If both values are plain objects, recurse.
 * - If source value is array, replace (not merge).
 * - If source value is undefined, skip.
 * - Otherwise, source wins.
 */
export function deepMerge<T extends Record<string, unknown>>(target: T, source: Record<string, unknown>): T {
  const result = { ...target } as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    if (srcVal === undefined) continue;
    const tgtVal = result[key];
    if (isPlainObject(tgtVal) && isPlainObject(srcVal)) {
      result[key] = deepMerge(tgtVal as Record<string, unknown>, srcVal);
    } else {
      result[key] = srcVal;
    }
  }
  return result as T;
}

// ---------------------------------------------------------------------------
// Content Hash
// ---------------------------------------------------------------------------

export function contentHash(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// Diff Config
// ---------------------------------------------------------------------------

/**
 * Computes the diff between defaults and current config.
 * Returns only fields that differ from defaults.
 */
export function diffConfig(defaults: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(current)) {
    const defVal = defaults[key];
    const curVal = current[key];
    if (isPlainObject(defVal) && isPlainObject(curVal)) {
      const nested = diffConfig(defVal, curVal);
      if (Object.keys(nested).length > 0) {
        result[key] = nested;
      }
    } else if (JSON.stringify(defVal) !== JSON.stringify(curVal)) {
      result[key] = curVal;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Team <-> TeamConfig conversions
// ---------------------------------------------------------------------------

export function teamConfigToTeam(config: TeamConfig, workspacePath: string): Team {
  return {
    tid: config.tid ?? '',
    slug: config.slug,
    coordinator_aid: config.coordinator_aid ?? '',
    parent_tid: config.parent_slug ?? '',
    depth: 0,
    container_id: '',
    health: 'unknown',
    agent_aids: (config.agents ?? []).map((a) => a.aid),
    workspace_path: workspacePath,
    created_at: Date.now(),
  };
}

export function teamToTeamConfig(team: Team): TeamConfig {
  return {
    slug: team.slug,
    ...(team.coordinator_aid ? { coordinator_aid: team.coordinator_aid } : {}),
    ...(team.tid ? { tid: team.tid } : {}),
    ...(team.parent_tid ? { parent_slug: team.parent_tid } : {}),
  };
}
