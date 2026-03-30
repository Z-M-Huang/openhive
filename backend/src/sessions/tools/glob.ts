/**
 * Built-in Glob tool — find files matching a glob pattern.
 *
 * Guards: assertInsideBoundary on the search directory.
 */

import { tool } from 'ai';
import { z } from 'zod';
import fg from 'fast-glob';
import { assertInsideBoundary } from './tool-guards.js';

export function createGlobTool(cwd: string, additionalDirs: string[]) {
  return tool({
    description:
      'Find files matching a glob pattern. Returns matching file paths sorted by modification time.',
    inputSchema: z.object({
      pattern: z.string().describe('Glob pattern to match (e.g. "**/*.ts")'),
      path: z
        .string()
        .optional()
        .describe('Directory to search in (defaults to workspace root)'),
    }),
    execute: async ({ pattern, path }) => {
      const searchDir = path ?? cwd;
      assertInsideBoundary(searchDir, cwd, additionalDirs);

      const entries = await fg(pattern, {
        cwd: searchDir,
        absolute: true,
        dot: false,
        stats: true,
        onlyFiles: true,
      });

      // Sort by modification time (most recent first)
      entries.sort((a, b) => {
        const aTime = a.stats?.mtimeMs ?? 0;
        const bTime = b.stats?.mtimeMs ?? 0;
        return bTime - aTime;
      });

      const paths = entries.map((e) => e.path);
      if (paths.length === 0) return 'No files matched the pattern.';
      return paths.join('\n');
    },
  });
}
