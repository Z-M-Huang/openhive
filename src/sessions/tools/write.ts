/**
 * Built-in Write tool — writes content to a file, creating parent dirs.
 *
 * Guards: assertInsideBoundary, assertGovernanceAllowed, scrubCredentialsFromContent (credential-scrubber).
 */

import { tool } from 'ai';
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  assertInsideBoundary,
  assertGovernanceAllowed,
} from './tool-guards.js';
import { scrubCredentialsFromContent } from '../../logging/credential-scrubber.js';

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
      // Resolve relative paths against team cwd, not process.cwd()
      const resolved = resolve(cwd, file_path);
      assertInsideBoundary(resolved, cwd, additionalDirs);
      assertGovernanceAllowed(resolved, teamName, governancePaths);
      const scrubbed = scrubCredentialsFromContent(content, credentials);
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, scrubbed, 'utf-8');
      return `Wrote ${scrubbed.length} bytes to ${file_path}`;
    },
  });
}
