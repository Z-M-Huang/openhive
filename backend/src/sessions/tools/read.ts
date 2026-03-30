/**
 * Built-in Read tool — reads a file and returns numbered lines.
 *
 * Guards: assertInsideBoundary (workspace boundary check).
 */

import { tool } from 'ai';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { assertInsideBoundary } from './tool-guards.js';

export function createReadTool(cwd: string, additionalDirs: string[]) {
  return tool({
    description: 'Read a file from the filesystem. Returns content with line numbers.',
    inputSchema: z.object({
      file_path: z.string().describe('Absolute path to the file to read'),
      offset: z
        .number()
        .int()
        .optional()
        .describe('Line number to start from (1-based)'),
      limit: z
        .number()
        .int()
        .optional()
        .describe('Number of lines to read'),
    }),
    execute: async ({ file_path, offset, limit }) => {
      assertInsideBoundary(file_path, cwd, additionalDirs);
      const content = await readFile(file_path, 'utf-8');
      const lines = content.split('\n');
      const start = (offset ?? 1) - 1;
      const end = limit ? start + limit : lines.length;
      const slice = lines.slice(start, end);
      return slice
        .map((line, i) => `${String(start + i + 1).padStart(6)}\u2502${line}`)
        .join('\n');
    },
  });
}
