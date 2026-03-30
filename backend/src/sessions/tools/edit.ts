/**
 * Built-in Edit tool — find-and-replace within a file.
 *
 * Guards: assertInsideBoundary, assertGovernanceAllowed, scrubCredentialsFromContent.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { readFile, writeFile } from 'node:fs/promises';
import {
  assertInsideBoundary,
  assertGovernanceAllowed,
  scrubCredentialsFromContent,
} from './tool-guards.js';

export function createEditTool(
  cwd: string,
  additionalDirs: string[],
  credentials: Record<string, string>,
  governancePaths: { systemRulesDir: string; dataDir: string; runDir: string },
  teamName: string,
) {
  return tool({
    description:
      'Edit a file by replacing an exact string match. Reads the file, performs the replacement, and writes it back.',
    inputSchema: z.object({
      file_path: z.string().describe('Absolute path to the file to edit'),
      old_string: z.string().describe('The exact text to find'),
      new_string: z.string().describe('The text to replace it with'),
      replace_all: z
        .boolean()
        .optional()
        .describe('Replace all occurrences (default: false, first only)'),
    }),
    execute: async ({ file_path, old_string, new_string, replace_all = false }) => {
      assertInsideBoundary(file_path, cwd, additionalDirs);
      assertGovernanceAllowed(file_path, teamName, governancePaths);

      const content = await readFile(file_path, 'utf-8');
      if (!content.includes(old_string)) {
        throw new Error(
          `old_string not found in ${file_path}. Ensure the string matches exactly (including whitespace).`,
        );
      }

      let updated: string;
      if (replace_all) {
        updated = content.replaceAll(old_string, new_string);
      } else {
        updated = content.replace(old_string, new_string);
      }

      const scrubbed = scrubCredentialsFromContent(updated, credentials);
      await writeFile(file_path, scrubbed, 'utf-8');

      const count = replace_all
        ? content.split(old_string).length - 1
        : 1;
      return `Replaced ${count} occurrence(s) in ${file_path}`;
    },
  });
}
