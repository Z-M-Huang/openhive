/**
 * Built-in Bash tool — execute shell commands with safety guards.
 *
 * Guards: assertBashSafe (prevents writing credentials to files),
 *         scrubCredentialsFromContent (credential-scrubber — scrubs output).
 */

import { tool } from 'ai';
import { z } from 'zod';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { assertBashSafe } from './tool-guards.js';
import { scrubCredentialsFromContent } from '../../logging/credential-scrubber.js';

const execFile = promisify(execFileCb);

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/** Only these env vars are forwarded to child processes — keeps secrets out. */
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'TERM',
  'SHELL',
  'TMPDIR',
] as const;

function buildSanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  return env;
}

export function createBashTool(cwd: string, credentials: Record<string, string>) {
  return tool({
    description:
      'Execute a bash command. Returns stdout on success, or combined stdout+stderr on failure.',
    inputSchema: z.object({
      command: z.string().describe('The bash command to execute'),
      timeout: z
        .number()
        .int()
        .optional()
        .describe('Timeout in milliseconds (default 120000, max 600000)'),
    }),
    execute: async ({ command, timeout }) => {
      assertBashSafe(command, credentials);

      const timeoutMs = Math.min(timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

      try {
        const { stdout } = await execFile(
          '/bin/bash',
          ['-c', command],
          {
            cwd,
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            env: buildSanitizedEnv(),
          },
        );
        return scrubCredentialsFromContent(stdout, credentials);
      } catch (err: unknown) {
        // Non-zero exit — include both stdout and stderr
        if (
          err !== null &&
          typeof err === 'object' &&
          'stdout' in err &&
          'stderr' in err
        ) {
          const { stdout, stderr } = err as { stdout: string; stderr: string };
          const combined = [stdout, stderr].filter(Boolean).join('\n');
          return scrubCredentialsFromContent(
            combined || 'Command failed with no output.',
            credentials,
          );
        }
        throw err;
      }
    },
  });
}
