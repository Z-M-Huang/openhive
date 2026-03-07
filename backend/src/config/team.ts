/**
 * OpenHive Backend - Team Config File I/O
 *
 * Implements read/write operations for team.yaml files and the directory
 * structure expected by each team (team.yaml, agents/, skills/, CLAUDE.md).
 *
 * Security: validateTeamPath enforces path containment and symlink rejection
 * to prevent directory traversal attacks (NFR13).
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  lstatSync,
  existsSync,
} from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { Team } from '../domain/types.js';
import { ValidationError } from '../domain/errors.js';
import { validateSlug } from '../domain/validation.js';

// ---------------------------------------------------------------------------
// validateTeamPath
// ---------------------------------------------------------------------------

/**
 * Validates a team slug and returns a safe absolute path within the teams
 * directory. Enforces NFR13 path containment security:
 *
 *   1. Validates slug format via validateSlug
 *   2. Resolves dataDir to an absolute path
 *   3. Checks the teams/ directory itself for symlinks
 *   4. Constructs and resolves the candidate team path
 *   5. Verifies the resolved path starts with the expected teams/ prefix
 *   6. Checks for a symlink at the team directory level (if it exists)
 *
 * Returns the validated absolute team directory path.
 * Throws ValidationError for any security violation or invalid slug.
 */
export function validateTeamPath(dataDir: string, slug: string): string {
  validateSlug(slug);

  const absDataDir = resolve(dataDir);

  // Check the teams base directory for symlinks before constructing the full path.
  const teamsDir = join(absDataDir, 'teams');
  try {
    const teamsInfo = lstatSync(teamsDir);
    if (teamsInfo.isSymbolicLink()) {
      throw new ValidationError('teams_dir', 'teams directory is a symlink');
    }
  } catch (err) {
    // If the error is the ValidationError we just threw, re-throw it.
    if (err instanceof ValidationError) {
      throw err;
    }
    // lstatSync ENOENT means teams/ doesn't exist yet — that is acceptable
    // for creation operations. Any other error surfaces as-is.
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== 'ENOENT') {
      throw err;
    }
  }

  // Construct the expected prefix — teamsDir + path separator.
  const teamsPrefix = teamsDir + sep;

  // Resolve the candidate team path to an absolute path to eliminate any
  // '..' components that the slug regex might not have caught.
  const teamDir = resolve(join(absDataDir, 'teams', slug));

  // Verify the resolved path is strictly within the teams directory.
  // We add sep to both sides to ensure "teams/foo" doesn't match "teams/foobar".
  if (!(teamDir + sep).startsWith(teamsPrefix) || teamDir === teamsDir) {
    throw new ValidationError('slug', 'resolved path escapes teams directory');
  }

  // Check for a symlink at the team directory level (only if the path exists).
  try {
    const teamInfo = lstatSync(teamDir);
    if (teamInfo.isSymbolicLink()) {
      throw new ValidationError('slug', 'team directory is a symlink');
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      throw err;
    }
    // ENOENT — path does not yet exist, which is fine for creation operations.
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== 'ENOENT') {
      throw err;
    }
  }

  return teamDir;
}

// ---------------------------------------------------------------------------
// loadTeamFromFile
// ---------------------------------------------------------------------------

/**
 * Reads and parses a team.yaml file at the given absolute path.
 *
 * Sets team.slug from the provided slug argument (slug is not stored in the
 * YAML file — it is derived from the directory name at load time).
 *
 * Throws:
 *   - Error if the file cannot be read or parsed
 */
export function loadTeamFromFile(path: string, slug: string): Team {
  let data: string;
  try {
    data = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `failed to read team config ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(data);
  } catch (err) {
    throw new Error(
      `failed to parse team config ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // A minimal team.yaml may be nearly empty. Treat null/undefined as an empty object.
  const raw = parsed !== null && parsed !== undefined ? (parsed as Partial<Team>) : {};

  const team: Team = {
    tid: raw.tid ?? '',
    slug,
    leader_aid: raw.leader_aid ?? '',
    parent_slug: raw.parent_slug,
    children: raw.children,
    agents: raw.agents,
    skills: raw.skills,
    mcp_servers: raw.mcp_servers,
    env_vars: raw.env_vars,
    container_config: raw.container_config,
  };

  return team;
}

// ---------------------------------------------------------------------------
// saveTeamToFile
// ---------------------------------------------------------------------------

/**
 * Writes a team config atomically (write to .tmp, then rename to target).
 *
 * Throws:
 *   - Error if the file cannot be marshalled, written, or renamed
 */
export function saveTeamToFile(path: string, team: Team): void {
  let data: string;
  try {
    data = stringifyYaml(team);
  } catch (err) {
    throw new Error(
      `failed to marshal team config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const tmpPath = path + '.tmp';
  try {
    writeFileSync(tmpPath, data, { encoding: 'utf8', mode: 0o644 });
  } catch (err) {
    throw new Error(
      `failed to write temp team config: ${err instanceof Error ? err.message : String(err)}`,
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
      `failed to rename temp team config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// createTeamDirectory
// ---------------------------------------------------------------------------

/**
 * Creates the config directory for a new team:
 *   <teamsDir>/teams/<slug>/
 *   <teamsDir>/teams/<slug>/team.yaml  (minimal, if not already present)
 *
 * This function creates only the CONFIG directory (under data/teams/).
 * Workspace files (CLAUDE.md, .claude/agents/, .claude/skills/) belong
 * in .run/teams/<slug>/ and are created by scaffoldTeamWorkspace() in
 * the orchestrator module.
 *
 * Uses validateTeamPath to enforce security constraints before creating
 * anything on disk.
 *
 * Throws:
 *   - ValidationError if the slug is invalid or the path fails security checks
 *   - Error if the directory or file cannot be created
 */
export function createTeamDirectory(dataDir: string, slug: string): void {
  const teamDir = validateTeamPath(dataDir, slug);

  try {
    mkdirSync(teamDir, { recursive: true, mode: 0o755 });
  } catch (err) {
    throw new Error(
      `failed to create directory ${teamDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Create minimal team.yaml if it doesn't already exist.
  const teamFile = join(teamDir, 'team.yaml');
  if (!existsSync(teamFile)) {
    const minimalTeam: Partial<Team> = { slug };
    let data: string;
    try {
      data = stringifyYaml(minimalTeam);
    } catch (err) {
      throw new Error(
        `failed to marshal minimal team config: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      writeFileSync(teamFile, data, { encoding: 'utf8', mode: 0o644 });
    } catch (err) {
      throw new Error(
        `failed to write team.yaml: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
