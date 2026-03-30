/**
 * AI session config assembler — builds the configuration needed for
 * a team AI session by composing provider-resolver, context-builder,
 * rule-cascade, skill-loader, and memory-loader.
 *
 * This replaces the old SDK-specific query-options assembler.
 */

import type { TeamConfig } from '../domain/types.js';
import type { ProvidersOutput } from '../config/validation.js';
import type { SecretString } from '../secrets/secret-string.js';

import { join } from 'node:path';
import { resolveProvider } from './provider-resolver.js';
import { buildSessionContext } from './context-builder.js';
import { buildRuleCascade } from '../rules/cascade.js';
import { loadSkillsContent } from './skill-loader.js';
import { buildMemorySection } from './memory-loader.js';
import { MemoryStore } from '../storage/stores/memory-store.js';

interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn?(msg: string, meta?: Record<string, unknown>): void;
}

export interface AiSessionConfig {
  readonly profileName: string;
  readonly modelId: string;
  readonly contextWindow: number;
  readonly teamName: string;
  readonly cwd: string;
  readonly additionalDirs: string[];
  readonly credentials: Record<string, string>;
  readonly governancePaths: { systemRulesDir: string; dataDir: string; runDir: string };
  readonly allowedTools: readonly string[];
  readonly maxTurns: number;
  readonly mcpServers: readonly string[];
  readonly ruleCascade: string;
  readonly skillsContent: string;
  readonly memorySection: string;
  readonly credentialKeys: readonly string[];
  readonly knownSecrets: readonly SecretString[];
  readonly rawSecretValues: readonly string[];
  readonly orgMcpPort: number;
  readonly sourceChannelId?: string;
}

export interface BuildAiSessionConfigInput {
  readonly teamName: string;
  readonly teamConfig: TeamConfig;
  readonly runDir: string;
  readonly dataDir: string;
  readonly systemRulesDir: string;
  readonly providers: ProvidersOutput;
  readonly orgMcpPort?: number;
  readonly ancestors: string[];
  readonly logger: Logger;
  readonly sourceChannelId?: string;
}

/**
 * Assemble the configuration needed for an AI SDK team session.
 */
export function buildAiSessionConfig(opts: BuildAiSessionConfigInput): AiSessionConfig {
  const { model: modelId, secrets: providerSecrets } = resolveProvider(
    opts.teamConfig.provider_profile,
    opts.providers,
  );

  const profileName = opts.teamConfig.provider_profile;
  const ctx = buildSessionContext(opts.teamName, opts.runDir);

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

  // Extract team credentials
  const teamCreds = opts.teamConfig.credentials ?? {};
  const teamCredentialValues = Object.values(teamCreds).filter(
    (v): v is string => typeof v === 'string' && v.length >= 8,
  );

  // Load skills and memory
  const skillsContent = loadSkillsContent(opts.runDir, opts.teamName);
  const teamMemoryStore = new MemoryStore(join(opts.runDir, 'teams'));
  const memorySection = buildMemorySection(teamMemoryStore, opts.teamName);

  if (memorySection.length > 12000) {
    opts.logger.info('Team memory exceeds 12000 chars — consider summarizing', {
      teamName: opts.teamName, length: memorySection.length,
    });
  }

  // Provider context window
  const profile = opts.providers.profiles[profileName];
  const contextWindow = profile?.context_window ?? 200_000;

  return {
    profileName,
    modelId,
    contextWindow,
    teamName: opts.teamName,
    cwd: ctx.cwd,
    additionalDirs: ctx.additionalDirectories,
    credentials: teamCreds,
    governancePaths: {
      systemRulesDir: opts.systemRulesDir,
      dataDir: opts.dataDir,
      runDir: opts.runDir,
    },
    allowedTools: opts.teamConfig.allowed_tools,
    maxTurns: opts.teamConfig.maxTurns,
    mcpServers: opts.teamConfig.mcp_servers,
    ruleCascade,
    skillsContent,
    memorySection,
    credentialKeys: Object.keys(teamCreds),
    knownSecrets: providerSecrets,
    rawSecretValues: teamCredentialValues,
    orgMcpPort: opts.orgMcpPort ?? 3001,
    sourceChannelId: opts.sourceChannelId,
  };
}
