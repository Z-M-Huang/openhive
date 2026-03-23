/**
 * Query options assembler — builds the full SDK query() options object
 * by composing provider-resolver, context-builder, mcp-builder,
 * can-use-tool, hooks, and credential-scrubber.
 */

import type { TeamConfig } from '../domain/types.js';
import type { ProvidersOutput } from '../config/validation.js';
import type { HookConfig, BuildHookConfigOpts } from '../hooks/index.js';

import { resolveProvider } from './provider-resolver.js';
import { buildSessionContext } from './context-builder.js';
import { buildMcpServers } from './mcp-builder.js';
import { createCanUseTool } from './can-use-tool.js';
import { buildRuleCascade } from '../rules/cascade.js';
import { buildHookConfig } from '../hooks/index.js';
import { createStderrScrubber } from '../logging/credential-scrubber.js';
import { loadSubagents, loadSkillsContent } from './skill-loader.js';
import type { SubagentDef } from './skill-loader.js';

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
  readonly agents: SubagentDef[];
}

export interface BuildQueryOptionsInput {
  readonly teamName: string;
  readonly teamConfig: TeamConfig;
  readonly runDir: string;
  readonly dataDir: string;
  readonly systemRulesDir: string;
  readonly providers: ProvidersOutput;
  readonly orgMcpServer: unknown;
  readonly availableMcpServers: Record<string, unknown>;
  readonly ancestors: string[];
  readonly logger: Logger;
}

/**
 * Assemble the complete SDK query() options for a team session.
 */
export function buildQueryOptions(opts: BuildQueryOptionsInput): QueryOptions {
  const { model, env: providerEnv, secrets: providerSecrets } = resolveProvider(
    opts.teamConfig.provider_profile,
    opts.providers,
  );

  const ctx = buildSessionContext(opts.teamName, opts.runDir);

  const mcpServers = buildMcpServers(
    opts.teamConfig.mcp_servers,
    { ...opts.availableMcpServers, org: opts.orgMcpServer },
  );

  const canUseTool = createCanUseTool(
    opts.teamConfig.allowed_tools,
    opts.logger,
  );

  const cascadeLogger = {
    info: (msg: string, meta?: Record<string, unknown>) => opts.logger.info(msg, meta),
    warn: (msg: string, meta?: Record<string, unknown>) => (opts.logger.warn ?? opts.logger.info)(msg, meta),
  };

  const ruleCascade = buildRuleCascade({
    teamName: opts.teamName,
    ancestors: opts.ancestors,
    runDir: opts.runDir,
    dataDir: opts.dataDir,
    systemRulesDir: opts.systemRulesDir,
    logger: cascadeLogger,
  });

  const hookOpts: BuildHookConfigOpts = {
    teamName: opts.teamName,
    cwd: ctx.cwd,
    additionalDirs: ctx.additionalDirectories,
    paths: {
      systemRulesDir: opts.systemRulesDir,
      dataDir: opts.dataDir,
      runDir: opts.runDir,
    },
    logger: opts.logger,
    knownSecrets: providerSecrets,
  };
  const hooks = buildHookConfig(hookOpts);
  const stderr = createStderrScrubber(providerSecrets);

  // Load skills content and append to rule cascade
  const skillsContent = loadSkillsContent(opts.runDir, opts.teamName);
  const fullAppend = skillsContent ? `${ruleCascade}\n${skillsContent}` : ruleCascade;

  // Load subagent definitions for the SDK agents option
  const agents = loadSubagents(opts.runDir, opts.teamName);

  return {
    systemPrompt: { type: 'preset', preset: 'claude_code', append: fullAppend },
    tools: { type: 'preset', preset: 'claude_code' },
    model,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    maxTurns: opts.teamConfig.maxTurns,
    mcpServers,
    canUseTool,
    hooks,
    stderr,
    env: providerEnv,
    cwd: ctx.cwd,
    additionalDirectories: ctx.additionalDirectories,
    agents,
  };
}
