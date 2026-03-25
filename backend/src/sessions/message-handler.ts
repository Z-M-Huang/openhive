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
import type { QueryFn, SdkMessage } from './spawner.js';
import { spawnSession } from './spawner.js';
import type { ChannelMessage } from '../domain/interfaces.js';
import type { ProvidersOutput } from '../config/validation.js';
import type { TeamConfig } from '../domain/types.js';
// OrgMcpServer no longer needed — org-MCP is a separate HTTP server on :3001

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
  try { return loadTeamConfig(path); } catch { return undefined; }
}

/**
 * Extract text from SDK messages (v2 pattern).
 * Handles 'assistant' messages with content blocks and 'result' messages.
 */
function extractText(messages: readonly SdkMessage[]): string {
  let output = '';
  for (const msg of messages) {
    if (msg.type === 'assistant' && msg.content) {
      const message = msg.content as { content?: Array<{ type: string; text?: string }> };
      if (message.content) {
        for (const block of message.content) {
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

    for (const [k, v] of Object.entries(opts.env)) { process.env[k] = v; }
    // Pass only SDK-compatible options (strip functions that can't serialize to child process)
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
    };
    const qFn = queryFn ?? await createSdkQueryFn();
    const result = await spawnSession(msg.content, sdkOpts, qFn);
    const text = extractText(result.messages);
    return text || undefined;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    deps.logger.info(`Message handler error: ${errMsg}`);
    return `Error processing message: ${errMsg}`;
  }
}
