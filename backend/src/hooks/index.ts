/**
 * Hook composer -- builds the full SDK hooks configuration.
 */

import { createWorkspaceBoundaryHook } from './workspace-boundary.js';
import { createGovernanceHook } from './governance.js';
import { createAuditPreHook, createAuditPostHook } from './audit-logger.js';

import type { SecretString } from '../secrets/secret-string.js';
import type { PreToolUseHook } from './workspace-boundary.js';
import type { PostToolUseHook } from './audit-logger.js';
import type { GovernancePaths } from './governance.js';

export interface HookMatcherEntry<T> {
  readonly matcher: string;
  readonly hooks: T[];
}

export interface HookConfig {
  readonly PreToolUse: HookMatcherEntry<PreToolUseHook>[];
  readonly PostToolUse: HookMatcherEntry<PostToolUseHook>[];
}

export interface BuildHookConfigOpts {
  readonly teamName: string;
  readonly cwd: string;
  readonly additionalDirs: string[];
  readonly paths: GovernancePaths;
  readonly logger: { info: (msg: string, meta?: Record<string, unknown>) => void };
  readonly knownSecrets?: readonly SecretString[];
}

export function buildHookConfig(opts: BuildHookConfigOpts): HookConfig {
  const workspaceBoundaryHook = createWorkspaceBoundaryHook(opts.cwd, opts.additionalDirs);
  const governanceHook = createGovernanceHook(opts.teamName, opts.paths, opts.logger);
  const { hook: auditPreHook, startTimes } = createAuditPreHook(opts.logger, opts.knownSecrets);
  const auditPostHook = createAuditPostHook(opts.logger, startTimes, opts.knownSecrets);

  return {
    PreToolUse: [
      { matcher: 'Read|Write|Edit|Glob|Grep', hooks: [workspaceBoundaryHook] },
      { matcher: 'Write|Edit', hooks: [governanceHook] },
      { matcher: '.*', hooks: [auditPreHook] },
    ],
    PostToolUse: [
      { matcher: '.*', hooks: [auditPostHook] },
    ],
  };
}
