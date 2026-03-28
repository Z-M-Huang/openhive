/**
 * Message handler — routes inbound channel messages to SDK sessions.
 *
 * Returns a structured MessageResult instead of raw strings, enabling
 * callers to distinguish success/failure without text matching.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { loadTeamConfig } from '../config/loader.js';
import { buildQueryOptions } from './query-options.js';
import type { QueryFn, SdkMessage, ProgressCallback, ProgressUpdate } from './spawner.js';
import { spawnSession, getAssistantContentBlocks } from './spawner.js';
import type { ChannelMessage } from '../domain/interfaces.js';
import type { ProvidersOutput } from '../config/validation.js';
import type { TeamConfig } from '../domain/types.js';
import { scrubSecrets } from '../logging/credential-scrubber.js';

// ── Public types ──────────────────────────────────────────────────────────

export interface MessageResult {
  readonly ok: boolean;
  readonly content?: string;
  readonly error?: string;
  readonly durationMs: number;
}

export interface HandleMessageOpts {
  queryFn?: QueryFn;
  teamName?: string;
  onProgress?: ProgressCallback;
  maxTurns?: number;
  sourceChannelId?: string;
}

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

// ── Internal helpers ──────────────────────────────────────────────────────

/** Load team config from disk, or return undefined. */
function loadConfig(runDir: string, teamName: string): TeamConfig | undefined {
  const path = join(runDir, 'teams', teamName, 'config.yaml');
  if (!existsSync(path)) return undefined;
  try {
    const config = loadTeamConfig(path);
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
    if (msg.type === 'text' && typeof msg.content === 'string') {
      output += msg.content;
    }
  }
  return output.trim();
}

async function createSdkQueryFn(): Promise<QueryFn> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return (prompt: string, options: Record<string, unknown>) =>
    sdk.query({ prompt, options }) as AsyncIterable<SdkMessage>;
}

// ── Main entry point ──────────────────────────────────────────────────────

/**
 * Handle an inbound message by spawning an SDK session.
 */
export async function handleMessage(
  msg: ChannelMessage,
  deps: MessageHandlerDeps,
  opts?: HandleMessageOpts,
): Promise<MessageResult> {
  const startMs = Date.now();
  const teamName = opts?.teamName ?? 'main';

  const teamConfig = loadConfig(deps.runDir, teamName);
  if (!teamConfig) {
    return {
      ok: false,
      error: 'OpenHive is not configured yet. Please set up providers.yaml and restart.',
      durationMs: Date.now() - startMs,
    };
  }

  try {
    const queryOpts = buildQueryOptions({
      teamName, teamConfig,
      runDir: deps.runDir, dataDir: deps.dataDir, systemRulesDir: deps.systemRulesDir,
      providers: deps.providers, orgMcpPort: deps.orgMcpPort,
      availableMcpServers: deps.availableMcpServers,
      ancestors: deps.orgAncestors, logger: deps.logger,
      sourceChannelId: opts?.sourceChannelId,
    });

    const sdkOpts: Record<string, unknown> = {
      model: queryOpts.model,
      permissionMode: queryOpts.permissionMode,
      allowDangerouslySkipPermissions: queryOpts.allowDangerouslySkipPermissions,
      pathToClaudeCodeExecutable: queryOpts.pathToClaudeCodeExecutable,
      maxTurns: opts?.maxTurns ?? queryOpts.maxTurns,
      cwd: queryOpts.cwd,
      additionalDirectories: queryOpts.additionalDirectories,
      systemPrompt: queryOpts.systemPrompt,
      tools: queryOpts.tools,
      env: queryOpts.env,
      mcpServers: queryOpts.mcpServers,
      hooks: queryOpts.hooks,
      agents: queryOpts.agents,
      canUseTool: queryOpts.canUseTool,
      stderr: queryOpts.stderr,
    };
    // Wrap onProgress with credential scrubbing so ack/progress never leaks secrets
    const teamCreds = teamConfig.credentials ?? {};
    const credValues = Object.values(teamCreds).filter(
      (v): v is string => typeof v === 'string' && v.length >= 8,
    );
    const safeOnProgress = opts?.onProgress && credValues.length > 0
      ? (update: ProgressUpdate) => {
          opts.onProgress!({
            ...update,
            content: scrubSecrets(update.content, [], credValues),
          });
        }
      : opts?.onProgress;

    const qFn = opts?.queryFn ?? await createSdkQueryFn();
    const result = await spawnSession(msg.content, sdkOpts, qFn, safeOnProgress);
    const text = extractText(result.messages);
    const durationMs = Date.now() - startMs;

    if (!text) {
      deps.logger.info('Session completed (empty response)', { teamName, durationMs });
      return { ok: true, durationMs };
    }

    // Scrub team credential values from response (defense in depth)
    const safeText = credValues.length > 0 ? scrubSecrets(text, [], credValues) : text;
    deps.logger.info('Session completed', { teamName, durationMs });
    return { ok: true, content: safeText, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const errMsg = err instanceof Error ? err.message : String(err);
    deps.logger.info('Message handler error', { teamName, error: errMsg, durationMs });
    return { ok: false, error: errMsg, durationMs };
  }
}
