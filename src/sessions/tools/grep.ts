/**
 * Built-in Grep tool — search file contents using ripgrep.
 *
 * Guards: assertInsideBoundary on the search path.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { assertInsideBoundary } from './tool-guards.js';

const execFile = promisify(execFileCb);

export function createGrepTool(cwd: string, additionalDirs: string[]) {
  return tool({
    description:
      'Search file contents using ripgrep. Returns matching lines in file:line:content format.',
    inputSchema: z.object({
      pattern: z.string().describe('Regex pattern to search for'),
      path: z
        .string()
        .optional()
        .describe('File or directory to search in (defaults to workspace root)'),
      type: z
        .string()
        .optional()
        .describe('File type filter (e.g. "ts", "py", "js")'),
      glob: z
        .string()
        .optional()
        .describe('Glob pattern to filter files (e.g. "*.ts")'),
    }),
    execute: async ({ pattern, path, type, glob: globFilter }) => {
      const searchPath = path ?? cwd;
      assertInsideBoundary(searchPath, cwd, additionalDirs);

      const args = [
        '--no-heading',
        '--line-number',
        '--color=never',
        '--max-count=200',
      ];
      if (type) {
        args.push('--type', type);
      }
      if (globFilter) {
        args.push('--glob', globFilter);
      }
      args.push(pattern, searchPath);

      try {
        const { stdout } = await execFile('rg', args, {
          timeout: 30_000,
          maxBuffer: 2 * 1024 * 1024,
        });
        return stdout.trimEnd() || 'No matches found.';
      } catch (err: unknown) {
        // rg exits with code 1 when no matches — that's not an error.
        if (
          err !== null &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code: number }).code === 1
        ) {
          return 'No matches found.';
        }
        throw err;
      }
    },
  });
}
