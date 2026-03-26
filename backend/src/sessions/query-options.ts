/**
 * Query options assembler — builds the full SDK query() options object
 * by composing provider-resolver, context-builder, mcp-builder,
 * can-use-tool, hooks, and credential-scrubber.
 */

import type { CanUseTool, AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { TeamConfig } from '../domain/types.js';
import type { ProvidersOutput } from '../config/validation.js';
import type { HookConfig, BuildHookConfigOpts } from '../hooks/index.js';

import { join } from 'node:path';
import { resolveProvider } from './provider-resolver.js';
import { buildSessionContext } from './context-builder.js';
import { buildMcpServers } from './mcp-builder.js';
import { createCanUseTool } from './can-use-tool.js';
import { buildRuleCascade } from '../rules/cascade.js';
import { buildHookConfig } from '../hooks/index.js';
import { createStderrScrubber } from '../logging/credential-scrubber.js';
import { loadSubagents, loadSkillsContent } from './skill-loader.js';
import { buildMemorySection } from './memory-loader.js';
import { MemoryStore } from '../storage/stores/memory-store.js';

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
  readonly canUseTool: CanUseTool;
  readonly hooks: HookConfig;
  readonly stderr: (data: string) => void;
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly additionalDirectories: string[];
  readonly agents: Record<string, AgentDefinition>;
  readonly pathToClaudeCodeExecutable: string;
}

export interface BuildQueryOptionsInput {
  readonly teamName: string;
  readonly teamConfig: TeamConfig;
  readonly runDir: string;
  readonly dataDir: string;
  readonly systemRulesDir: string;
  readonly providers: ProvidersOutput;
  readonly orgMcpPort?: number;
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

  // Org-MCP is a stateless HTTP server on localhost:3001.
  // Each sdk.query() creates its own connection — no shared transport.
  // callerId passed via X-Caller-Id header for authorization.
  const orgHttpConfig = {
    type: 'http' as const,
    url: `http://127.0.0.1:${opts.orgMcpPort ?? 3001}/mcp`,
    headers: { 'X-Caller-Id': opts.teamName },
  };
  const mcpServers = buildMcpServers(
    opts.teamConfig.mcp_servers,
    { ...opts.availableMcpServers, org: orgHttpConfig },
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

  // Extract team credentials from config for redaction and hook injection
  const teamCreds = opts.teamConfig.credentials ?? {};
  const teamCredentialValues = Object.values(teamCreds).filter(v => typeof v === 'string');

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
    teamCredentials: teamCreds,
  };

  const hooks = buildHookConfig(hookOpts);
  const stderr = createStderrScrubber(providerSecrets, teamCredentialValues);

  // Load skills and memory, then assemble the full systemPrompt append
  const skillsContent = loadSkillsContent(opts.runDir, opts.teamName);
  const teamMemoryStore = new MemoryStore(join(opts.runDir, 'teams'));
  const memorySection = buildMemorySection(teamMemoryStore, opts.teamName);

  if (memorySection.length > 12000) {
    opts.logger.info('Team memory exceeds 12000 chars — consider summarizing', {
      teamName: opts.teamName, length: memorySection.length,
    });
  }

  // Dynamic tool availability note — tells the agent what tools are actually enabled
  const toolsNote = buildToolAvailabilityNote(opts.teamConfig.allowed_tools);

  // Dynamic credential availability note — tells the agent what credential keys exist
  const credKeys = Object.keys(opts.teamConfig.credentials ?? {});
  const credNote = credKeys.length > 0
    ? `\n## Available Credentials\nThis team has credentials configured: ${credKeys.map(k => `\`${k}\``).join(', ')}. Use \`get_credential({ key: "KEY_NAME" })\` to retrieve each value at point of use. Never hardcode or store credential values.\n`
    : '';

  // Tool availability note goes FIRST so the agent sees it before any rules that might create doubt.
  const fullAppend = [toolsNote, credNote, ruleCascade, skillsContent, memorySection].filter(Boolean).join('\n');

  // Load subagent definitions for the SDK agents option
  const agents = loadSubagents(opts.runDir, opts.teamName);

  return {
    systemPrompt: { type: 'preset', preset: 'claude_code', append: fullAppend },
    tools: { type: 'preset', preset: 'claude_code' },
    model,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    pathToClaudeCodeExecutable: '/home/node/.local/bin/claude',
    maxTurns: opts.teamConfig.maxTurns,
    mcpServers,
    canUseTool,
    hooks,
    stderr,
    env: { ...providerEnv, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '1800000' },
    cwd: ctx.cwd,
    additionalDirectories: ctx.additionalDirectories,
    agents,
  };
}

/**
 * Build a dynamic tool availability note for the system prompt.
 * Tells the agent which tools are actually enabled for this team,
 * preventing the LLM from incorrectly believing tools like Bash are denied.
 */
function buildToolAvailabilityNote(allowedTools: readonly string[]): string {
  const allowAll = allowedTools.includes('*');
  const lines: string[] = ['--- Tool Availability for This Team ---'];
  if (allowAll) {
    lines.push('All tools are ENABLED for this team. You HAVE Bash and MUST use it when you need to run shell commands, make HTTP requests (curl), or execute scripts (python3, node).');
  } else {
    const builtins = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'] as const;
    for (const tool of builtins) {
      const enabled = allowedTools.includes(tool) ||
        allowedTools.some(e => e.endsWith('*') && tool.startsWith(e.slice(0, -1)));
      lines.push(`- **${tool}** — ${enabled ? 'ENABLED' : 'DISABLED'}`);
    }
  }
  lines.push('Use Bash for HTTP requests (curl), script execution, and system commands when enabled.');
  return lines.join('\n');
}
