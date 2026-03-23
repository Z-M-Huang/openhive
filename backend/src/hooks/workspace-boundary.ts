/**
 * Workspace-boundary PreToolUse hook.
 *
 * Prevents file-access tools (Read, Write, Edit, Glob, Grep) from
 * reaching outside the allowed workspace directories. Resolves symlinks
 * via fs.realpathSync to block symlink-escape attacks.
 */

import { resolve, dirname } from 'node:path';
import { realpathSync } from 'node:fs';

import { WorkspaceBoundaryError } from '../domain/errors.js';

/** Extract the file/directory path from the tool's input object. */
function extractPath(
  toolName: string,
  toolInput: Record<string, unknown>,
): string | undefined {
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return typeof toolInput['file_path'] === 'string'
        ? toolInput['file_path']
        : undefined;
    case 'Glob':
      // Glob uses `path` for the directory; fall back to `pattern` for relative patterns
      return typeof toolInput['path'] === 'string'
        ? toolInput['path']
        : typeof toolInput['pattern'] === 'string'
          ? toolInput['pattern']
          : undefined;
    case 'Grep':
      return typeof toolInput['path'] === 'string'
        ? toolInput['path']
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Resolve a path to its real absolute location, handling symlinks.
 *
 * When the target file doesn't exist (e.g. Write to a new file), we walk
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

/** Check whether `target` is inside any of the `allowed` directories. */
function isInsideBoundary(target: string, allowed: string[]): boolean {
  return allowed.some(
    (dir) => target === dir || target.startsWith(dir + '/'),
  );
}

export type PreToolUseHook = (
  input: { tool_name: string; tool_input: Record<string, unknown> },
  toolUseId: string | undefined,
  context: { session_id?: string; [key: string]: unknown },
) => Promise<Record<string, unknown>>;

/**
 * Factory: create a workspace-boundary PreToolUse hook.
 *
 * @param cwd             The container's workspace root (absolute).
 * @param additionalDirs  Extra directories the agent may access.
 */
export function createWorkspaceBoundaryHook(
  cwd: string,
  additionalDirs: string[],
): PreToolUseHook {
  const allowed = [cwd, ...additionalDirs];

  return (input) => {
    const raw = extractPath(input.tool_name, input.tool_input);
    if (raw === undefined) {
      // No path to check -- allow (defensive: tool may have optional path).
      return Promise.resolve({});
    }

    const resolved = resolvePath(cwd, raw);

    if (!isInsideBoundary(resolved, allowed)) {
      const err = new WorkspaceBoundaryError(
        `Access denied: ${resolved} is outside workspace boundaries`,
      );
      return Promise.resolve({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: err.message,
        },
      });
    }

    return Promise.resolve({});
  };
}
