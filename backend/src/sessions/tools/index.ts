/**
 * Built-in tool set — barrel export.
 *
 * Constructs all six built-in tools (Read, Write, Edit, Glob, Grep, Bash)
 * with shared workspace boundary, governance, and credential guards.
 * Optionally wraps each tool's execute with audit logging.
 */

import { createReadTool } from './read.js';
import { createWriteTool } from './write.js';
import { createEditTool } from './edit.js';
import { createGlobTool } from './glob.js';
import { createGrepTool } from './grep.js';
import { createBashTool } from './bash.js';
import { withAudit } from './tool-audit.js';
import type { AuditWrapperOpts } from './tool-audit.js';

export { createReadTool } from './read.js';
export { createWriteTool } from './write.js';
export { createEditTool } from './edit.js';
export { createGlobTool } from './glob.js';
export { createGrepTool } from './grep.js';
export { createBashTool } from './bash.js';

export interface BuiltinToolOpts {
  readonly cwd: string;
  readonly additionalDirs: string[];
  readonly credentials: Record<string, string>;
  readonly governancePaths: {
    systemRulesDir: string;
    dataDir: string;
    runDir: string;
  };
  readonly teamName: string;
  /** If provided, each tool's execute is wrapped with audit logging. */
  readonly audit?: AuditWrapperOpts;
}

export function buildBuiltinTools(opts: BuiltinToolOpts) {
  const tools = {
    Read: createReadTool(opts.cwd, opts.additionalDirs),
    Write: createWriteTool(
      opts.cwd,
      opts.additionalDirs,
      opts.credentials,
      opts.governancePaths,
      opts.teamName,
    ),
    Edit: createEditTool(
      opts.cwd,
      opts.additionalDirs,
      opts.credentials,
      opts.governancePaths,
      opts.teamName,
    ),
    Glob: createGlobTool(opts.cwd, opts.additionalDirs),
    Grep: createGrepTool(opts.cwd, opts.additionalDirs),
    Bash: createBashTool(opts.cwd, opts.credentials),
  };

  if (!opts.audit) return tools;

  // Wrap each tool's execute with audit logging
  const wrapped: Record<string, unknown> = {};
  for (const [name, t] of Object.entries(tools)) {
    const orig = (t as { execute?: (...args: unknown[]) => Promise<unknown> }).execute;
    if (orig) {
      wrapped[name] = { ...t, execute: withAudit(name, orig, opts.audit) };
    } else {
      wrapped[name] = t;
    }
  }
  return wrapped as typeof tools;
}
