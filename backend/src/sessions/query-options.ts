/**
 * Query options assembler — builds the full SDK query() options object
 * by composing provider-resolver, context-builder, mcp-builder,
 * can-use-tool, hooks, and credential-scrubber.
 */

import type { TeamConfig } from '../domain/types.js';
import type { ProvidersOutput } from '../config/validation.js';
import type { SecretString } from '../secrets/secret-string.js';
import type { HookConfig, BuildHookConfigOpts } from '../hooks/index.js';

import { resolveProvider } from './provider-resolver.js';
import { buildSessionContext } from './context-builder.js';
import { buildMcpServers } from './mcp-builder.js';
import { createCanUseTool } from './can-use-tool.js';
import { buildRuleCascade } from '../rules/cascade.js';
import { buildHookConfig } from '../hooks/index.js';
import { createStderrScrubber } from '../logging/credential-scrubber.js';

interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn?(msg: string, meta?: Record<string, unknown>): void;
}

export interface QueryOptions {
  readonly systemPrompt: { type: string; preset: string; append: string };
  readonly tools: { type: string; preset: string };
  readonly model: string;
  readonly permissionMode: string;
  readonly allowDangerouslySkipPermissions: boolean;
  readonly maxTurns: number;
  readonly mcpServers: Record<string, unknown>;
  readonly canUseTool: ReturnType<typeof createCanUseTool>;
  readonly hooks: HookConfig;
  readonly stderr: (data: string) => string;
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly additionalDirectories: string[];
}

export interface BuildQueryOptionsInput {
  readonly teamName: string;
  readonly teamConfig: TeamConfig;
  readonly dataDir: string;
  readonly providers: ProvidersOutput;
  readonly secrets: Map<string, SecretString>;
  readonly orgMcpServer: unknown;
  readonly availableMcpServers: Record<string, unknown>;
  readonly ancestors: string[];
  readonly logger: Logger;
}

/**
 * Assemble the complete SDK query() options for a team session.
 */
export function buildQueryOptions(opts: BuildQueryOptionsInput): QueryOptions {
  const { model, env: providerEnv } = resolveProvider(
    opts.teamConfig.provider_profile,
    opts.providers,
    opts.secrets,
  );

  const ctx = buildSessionContext(opts.teamName, opts.dataDir, opts.secrets, opts.teamConfig.secret_refs);

  const mcpServers = buildMcpServers(
    opts.teamConfig.mcp_servers,
    { ...opts.availableMcpServers, org: opts.orgMcpServer },
  );

  const canUseTool = createCanUseTool(
    opts.teamConfig.allowed_tools,
    opts.logger,
  );

  const cascadeLogger = opts.logger.warn
    ? { warn: (msg: string, meta?: Record<string, unknown>) => opts.logger.warn!(msg, meta) }
    : undefined;

  const ruleCascade = buildRuleCascade(
    opts.teamName,
    opts.ancestors,
    opts.dataDir,
    cascadeLogger,
  );

  const secretValues = [...opts.secrets.values()];

  const hookOpts: BuildHookConfigOpts = {
    teamName: opts.teamName,
    cwd: ctx.cwd,
    additionalDirs: ctx.additionalDirectories,
    dataDir: opts.dataDir,
    logger: opts.logger,
    knownSecrets: secretValues,
  };
  const hooks = buildHookConfig(hookOpts);
  const stderr = createStderrScrubber(secretValues);

  // Merge provider env (API keys) with context env (secrets)
  const mergedEnv = { ...ctx.env, ...providerEnv };

  return {
    systemPrompt: { type: 'preset', preset: 'claude_code', append: ruleCascade },
    tools: { type: 'preset', preset: 'claude_code' },
    model,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    maxTurns: opts.teamConfig.maxTurns,
    mcpServers,
    canUseTool,
    hooks,
    stderr,
    env: mergedEnv,
    cwd: ctx.cwd,
    additionalDirectories: ctx.additionalDirectories,
  };
}
