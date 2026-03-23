/**
 * Message handler — routes inbound channel messages to SDK sessions.
 *
 * V1 contract: ALL inbound messages go to the `main` team.
 * No scope routing for inbound messages (main delegates via MCP tools).
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { loadTeamConfig } from '../config/loader.js';
import { buildQueryOptions } from './query-options.js';
import { spawnSession } from './spawner.js';
import type { QueryFn, SdkMessage } from './spawner.js';
import type { ChannelMessage } from '../domain/interfaces.js';
import type { ProvidersOutput } from '../config/validation.js';
import type { TeamConfig } from '../domain/types.js';
import type { OrgMcpServer } from '../org-mcp/server.js';

export interface MessageHandlerDeps {
  readonly providers: ProvidersOutput;
  readonly orgMcpServer: OrgMcpServer;
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

/** Extract text from SDK messages. */
function extractText(messages: readonly SdkMessage[]): string {
  return messages
    .filter(m => m.type === 'text' && typeof m.content === 'string')
    .map(m => m.content as string)
    .join('\n')
    .trim();
}

/** Load team config from disk, or return undefined. */
function loadConfig(runDir: string, teamName: string): TeamConfig | undefined {
  const path = join(runDir, 'teams', teamName, 'config.yaml');
  if (!existsSync(path)) return undefined;
  try {
    return loadTeamConfig(path);
  } catch {
    return undefined;
  }
}

/**
 * Handle an inbound message by spawning an SDK session for the main team.
 *
 * @param msg       The channel message.
 * @param deps      Shared dependencies.
 * @param queryFn   Injectable query function (for testing).
 */
export async function handleMessage(
  msg: ChannelMessage,
  deps: MessageHandlerDeps,
  queryFn?: QueryFn,
  teamName: string = 'main',
): Promise<string | void> {

  const teamConfig = loadConfig(deps.runDir, teamName);
  if (!teamConfig) {
    deps.logger.info('No main team config found, cannot process message');
    return 'OpenHive is not configured yet. Please set up providers.yaml and restart.';
  }

  try {
    const opts = buildQueryOptions({
      teamName,
      teamConfig,
      runDir: deps.runDir,
      dataDir: deps.dataDir,
      systemRulesDir: deps.systemRulesDir,
      providers: deps.providers,
      orgMcpServer: deps.orgMcpServer,
      availableMcpServers: deps.availableMcpServers,
      ancestors: deps.orgAncestors,
      logger: deps.logger,
    });

    // Use injected queryFn for testing, or the real SDK query
    const qFn = queryFn ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
    const result = await spawnSession(msg.content, opts, qFn as QueryFn);
    const text = extractText(result.messages);
    return text || undefined;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    deps.logger.info('Message handler error', { error: errMsg, channelId: msg.channelId });
    return `Error processing message: ${errMsg}`;
  }
}
