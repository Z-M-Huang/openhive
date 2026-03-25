/**
 * Hook composer -- builds the full SDK hooks configuration.
 */

import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

import { createWorkspaceBoundaryHook } from './workspace-boundary.js';
import { createGovernanceHook } from './governance.js';
import { createAuditPreHook, createAuditPostHook } from './audit-logger.js';

import type { SecretString } from '../secrets/secret-string.js';
import type { GovernancePaths } from './governance.js';

/**
 * Hook configuration — required fields (subtype of SDK's Partial<Record<HookEvent, ...>>).
 * buildHookConfig() always provides both, keeping downstream test assertions simple.
 */
export interface HookConfig {
  readonly PreToolUse: HookCallbackMatcher[];
  readonly PostToolUse: HookCallbackMatcher[];
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
