/**
 * Built-in Write tool — writes content to a file, creating parent dirs.
 *
 * Guards: assertInsideBoundary, assertGovernanceAllowed, scrubCredentialsFromContent.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  assertInsideBoundary,
  assertGovernanceAllowed,
  scrubCredentialsFromContent,
} from './tool-guards.js';

export function createWriteTool(
  cwd: string,
  additionalDirs: string[],
  credentials: Record<string, string>,
  governancePaths: { systemRulesDir: string; dataDir: string; runDir: string },
  teamName: string,
) {
  return tool({
    description: 'Write content to a file. Creates parent directories if needed.',
    inputSchema: z.object({
      file_path: z.string().describe('Absolute path to write to'),
      content: z.string().describe('Content to write'),
    }),
    execute: async ({ file_path, content }) => {
      assertInsideBoundary(file_path, cwd, additionalDirs);
      assertGovernanceAllowed(file_path, teamName, governancePaths);
      const scrubbed = scrubCredentialsFromContent(content, credentials);
      await mkdir(dirname(file_path), { recursive: true });
      await writeFile(file_path, scrubbed, 'utf-8');
      return `Wrote ${scrubbed.length} bytes to ${file_path}`;
    },
  });
}
