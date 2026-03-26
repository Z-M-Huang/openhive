/**
 * Message handler — routes inbound channel messages to SDK sessions.
 *
 * V1 contract: ALL inbound messages go to the `main` team.
 * Uses the Claude Agent SDK query() to spawn sessions.
 * Pattern follows v2's executor/sdk-runner.ts.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { loadTeamConfig } from '../config/loader.js';
import { buildQueryOptions } from './query-options.js';
import type { QueryFn, SdkMessage, ProgressCallback } from './spawner.js';
import { spawnSession, getAssistantContentBlocks } from './spawner.js';
import type { ChannelMessage } from '../domain/interfaces.js';
import type { ProvidersOutput } from '../config/validation.js';
import type { TeamConfig } from '../domain/types.js';
import { scrubSecrets } from '../logging/credential-scrubber.js';


export interface MessageHandlerDeps {
  readonly providers: ProvidersOutput;
  readonly orgMcpPort?: number;
  readonly availableMcpServers: Record<string, unknown>;
  readonly runDir: string;
  readonly dataDir: string;
  readonly systemRulesDir: string;
  readonly orgAncestors: string[];
  readonly logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn?(msg: string, meta?: Record<string, unknown>): void;
  };
}

/** Load team config from disk, or return undefined. */
function loadConfig(runDir: string, teamName: string): TeamConfig | undefined {
  const path = join(runDir, 'teams', teamName, 'config.yaml');
  if (!existsSync(path)) return undefined;
  try {
    const config = loadTeamConfig(path);
    // Safeguard: 'org' MCP server must always be present (mirrors spawn-team.ts:125-127)
    if (!config.mcp_servers.includes('org')) {
      return { ...config, mcp_servers: ['org', ...config.mcp_servers] };
    }
    return config;
  } catch { return undefined; }
}

/**
 * Extract text from SDK messages (v2 pattern).
 * Handles 'assistant' messages with content blocks and 'result' messages.
 */
function extractText(messages: readonly SdkMessage[]): string {
  let output = '';
  for (const msg of messages) {
    if (msg.type === 'assistant') {
      const blocks = getAssistantContentBlocks(msg);
      if (blocks) {
        for (const block of blocks) {
          if (block.type === 'text' && block.text) output += block.text;
        }
      }
    }
    if (msg.type === 'result') {
      const result = msg as unknown as { result?: string };
      if (result.result) output = result.result;
    }
    // Simple text content fallback
    if (msg.type === 'text' && typeof msg.content === 'string') {
      output += msg.content;
    }
  }
  return output.trim();
}

/**
 * Create an SDK-compatible queryFn that wraps the real SDK query().
 * Matches v2's runAgentQuery pattern: sdk.query({ prompt, options }).
 */
async function createSdkQueryFn(): Promise<QueryFn> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return (prompt: string, options: Record<string, unknown>) =>
    sdk.query({ prompt, options }) as AsyncIterable<SdkMessage>;
}

/**
 * Handle an inbound message by spawning an SDK session.
 */
export async function handleMessage(
  msg: ChannelMessage,
  deps: MessageHandlerDeps,
  queryFn?: QueryFn,
  teamName: string = 'main',
  onProgress?: ProgressCallback,
): Promise<string | void> {
  const teamConfig = loadConfig(deps.runDir, teamName);
  if (!teamConfig) {
    return 'OpenHive is not configured yet. Please set up providers.yaml and restart.';
  }

  try {
    const opts = buildQueryOptions({
      teamName, teamConfig,
      runDir: deps.runDir, dataDir: deps.dataDir, systemRulesDir: deps.systemRulesDir,
      providers: deps.providers, orgMcpPort: deps.orgMcpPort,
      availableMcpServers: deps.availableMcpServers,
      ancestors: deps.orgAncestors, logger: deps.logger,
    });

    const sdkOpts: Record<string, unknown> = {
      model: opts.model,
      permissionMode: opts.permissionMode,
      allowDangerouslySkipPermissions: opts.allowDangerouslySkipPermissions,
      pathToClaudeCodeExecutable: opts.pathToClaudeCodeExecutable,
      maxTurns: opts.maxTurns,
      cwd: opts.cwd,
      additionalDirectories: opts.additionalDirectories,
      systemPrompt: opts.systemPrompt,
      tools: opts.tools,
      env: opts.env,
      mcpServers: opts.mcpServers,
      hooks: opts.hooks,
      agents: opts.agents,
      canUseTool: opts.canUseTool,
      stderr: opts.stderr,
    };
    const qFn = queryFn ?? await createSdkQueryFn();
    const result = await spawnSession(msg.content, sdkOpts, qFn, onProgress);
    const text = extractText(result.messages);
    if (!text) return undefined;

    // Scrub team credential values from response (defense in depth)
    const teamCreds = teamConfig.credentials ?? {};
    const credValues = Object.values(teamCreds).filter(
      (v): v is string => typeof v === 'string' && v.length >= 8,
    );
    return credValues.length > 0 ? scrubSecrets(text, [], credValues) : text;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    deps.logger.info(`Message handler error: ${errMsg}`);
    return `Error processing message: ${errMsg}`;
  }
}
