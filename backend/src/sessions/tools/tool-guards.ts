/**
 * Tool guards — pure functions extracted from hook logic.
 *
 * These enforce workspace boundary, governance, and credential safety
 * without any dependency on @anthropic-ai/claude-agent-sdk types.
 * They throw plain Errors on policy violations instead of returning
 * hook-specific deny objects.
 */

import { resolve, dirname } from 'node:path';
import { realpathSync } from 'node:fs';

// ── Workspace Boundary ─────────────────────────────────────────────────────

/**
 * Resolve a path to its real absolute location, handling symlinks.
 *
 * When the target file doesn't exist (e.g. writing a new file), we walk
 * up the directory tree until we find an existing ancestor, resolve THAT
 * with realpathSync, then re-append the remaining segments. This prevents
 * symlink-escape attacks where a symlinked directory makes the unresolved
 * path appear to be within boundaries.
 */
function resolvePath(cwd: string, raw: string): string {
  const abs = resolve(cwd, raw);
  try {
    return realpathSync(abs);
  } catch {
    // File doesn't exist yet. Walk up to the nearest existing ancestor.
    let current = abs;
    const trailing: string[] = [];
    let parent = dirname(current);
    while (parent !== current) {
      trailing.unshift(current.slice(parent.length + 1));
      current = parent;
      try {
        const resolvedAncestor = realpathSync(current);
        return resolve(resolvedAncestor, ...trailing);
      } catch {
        // This ancestor doesn't exist either — keep walking up.
      }
      parent = dirname(current);
    }
    // Reached filesystem root without finding an existing dir.
    // Fall back to the absolute path (will likely fail boundary check).
    return abs;
  }
}

/**
 * Assert that `filePath` resolves to a location inside `cwd` or one of
 * `additionalDirs`. Throws if the resolved path escapes the boundary.
 *
 * Resolves symlinks via realpathSync to block symlink-escape attacks.
 */
export function assertInsideBoundary(
  filePath: string,
  cwd: string,
  additionalDirs: string[],
): void {
  const resolved = resolvePath(cwd, filePath);
  const allowed = [cwd, ...additionalDirs];
  const inside = allowed.some(
    (dir) => resolved === dir || resolved.startsWith(dir + '/'),
  );
  if (!inside) {
    throw new Error(
      `Access denied: ${resolved} is outside workspace boundaries`,
    );
  }
}

// ── Governance ──────────────────────────────────────────────────────────────

/** Classification of a target file for governance purposes. */
export type FileClass =
  | 'system-rules'
  | 'admin-org-rules'
  | 'other-team'
  | 'own-org-rules'
  | 'own-team-rules'
  | 'own-skills'
  | 'own-subagents'
  | 'own-memory'
  | 'own-config'
  | 'other';

/** Map of sub-path prefixes to FileClass for own-team directories. */
const OWN_TEAM_PREFIXES: ReadonlyArray<[string, FileClass]> = [
  ['org-rules', 'own-org-rules'],
  ['team-rules', 'own-team-rules'],
  ['skills', 'own-skills'],
  ['subagents', 'own-subagents'],
  ['memory', 'own-memory'],
];

/** Classify a sub-path within the owning team's directory. */
function classifyOwnTeamPath(subPath: string): FileClass {
  if (subPath === 'config.yaml') return 'own-config';
  for (const [prefix, cls] of OWN_TEAM_PREFIXES) {
    if (subPath.startsWith(prefix + '/') || subPath === prefix) {
      return cls;
    }
  }
  return 'other';
}

export interface GovernancePaths {
  readonly systemRulesDir: string;
  readonly dataDir: string;
  readonly runDir: string;
}

/** Determine the governance class of a resolved absolute path. */
export function classifyPath(
  resolved: string,
  teamName: string,
  paths: GovernancePaths,
): FileClass {
  // Check system rules (immutable, baked into image)
  const sysDir = paths.systemRulesDir;
  if (resolved.startsWith(sysDir + '/') || resolved === sysDir) {
    return 'system-rules';
  }

  // Check admin org rules (/data/rules/)
  const adminRulesDir = resolve(paths.dataDir, 'rules');
  if (resolved.startsWith(adminRulesDir + '/') || resolved === adminRulesDir) {
    return 'admin-org-rules';
  }

  // Check team files under .run/teams/
  const teamsDir = resolve(paths.runDir, 'teams');
  if (!resolved.startsWith(teamsDir + '/')) {
    return 'other';
  }

  const afterTeams = resolved.slice(teamsDir.length + 1);
  const slashIdx = afterTeams.indexOf('/');
  const targetTeam = slashIdx === -1 ? afterTeams : afterTeams.slice(0, slashIdx);

  if (targetTeam !== teamName) {
    return 'other-team';
  }

  const subPath = slashIdx === -1 ? '' : afterTeams.slice(slashIdx + 1);
  return classifyOwnTeamPath(subPath);
}

/** Blocked file classes for governance writes. */
const BLOCKED_CLASSES: ReadonlySet<FileClass> = new Set([
  'system-rules',
  'admin-org-rules',
  'other-team',
  'own-config',
]);

/**
 * Assert that a write to `filePath` is allowed by governance rules.
 *
 * Resolves symlinks on the parent directory so that a symlinked path
 * cannot bypass governance (e.g. memory/link -> config.yaml).
 *
 * Throws for writes to:
 *  - system-rules (immutable)
 *  - admin org-rules (admin-managed)
 *  - other team dirs (cross-team isolation)
 *  - own config.yaml (managed by admin)
 *
 * Allows: own org-rules, own team-rules, own skills, own subagents,
 * own memory, other (workspace) paths.
 */
export function assertGovernanceAllowed(
  filePath: string,
  teamName: string,
  paths: GovernancePaths,
): void {
  // Resolve symlinks to prevent bypass (e.g. memory/link -> config.yaml)
  const resolved = resolve(filePath);
  let real: string;
  try {
    // Resolve parent dir + basename so it works even if file doesn't exist yet
    const dir = dirname(resolved);
    real = resolve(realpathSync(dir), resolved.slice(dir.length + 1));
  } catch {
    real = resolved;
  }

  const cls = classifyPath(real, teamName, paths);
  if (BLOCKED_CLASSES.has(cls)) {
    throw new Error(`Governance: write blocked for ${cls} path: ${real}`);
  }
}

// ── Credential Guards ───────────────────────────────────────────────────────

/**
 * Replace credential values in `content` with `[CREDENTIAL:key]` placeholders.
 * Only credentials with values >= 8 characters are scrubbed (short values
 * produce too many false positives).
 *
 * Returns the (possibly modified) content string.
 */
export function scrubCredentialsFromContent(
  content: string,
  credentials: Record<string, string>,
): string {
  const entries = Object.entries(credentials).filter(([, v]) => v.length >= 8);
  if (entries.length === 0) return content;

  let scrubbed = content;
  for (const [key, value] of entries) {
    scrubbed = scrubbed.replaceAll(value, `[CREDENTIAL:${key}]`);
  }
  return scrubbed;
}

/** File-write shell patterns that indicate a credential is being persisted to disk. */
const FILE_WRITE_PATTERNS = /[>]{1,2}\s|tee\s|cat\s.*>\s|printf\s.*>\s/;

/**
 * Assert that a Bash command does not write credential values to files.
 *
 * Only blocks commands that contain BOTH a credential value (>= 8 chars)
 * AND a file-write pattern (>, >>, tee, etc.). Non-file-write commands
 * (curl, wget, etc.) are allowed even if they contain credentials.
 *
 * Throws if the command would exfiltrate credentials to disk.
 */
export function assertBashSafe(
  command: string,
  credentials: Record<string, string>,
): void {
  const entries = Object.entries(credentials).filter(([, v]) => v.length >= 8);
  if (entries.length === 0) return;

  const hasCredential = entries.some(([, value]) => command.includes(value));
  if (!hasCredential) return;

  const hasFileWrite = FILE_WRITE_PATTERNS.test(command);
  if (!hasFileWrite) return;

  const matchedKeys = entries
    .filter(([, v]) => command.includes(v))
    .map(([k]) => k);
  throw new Error(
    `Credential guard: Bash command writes credential value(s) [${matchedKeys.join(', ')}] to file. Use get_credential at point of use instead.`,
  );
}
