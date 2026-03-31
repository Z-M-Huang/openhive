/**
 * Message handler — routes inbound channel messages to AI SDK sessions.
 *
 * Returns a structured MessageResult instead of raw strings, enabling
 * callers to distinguish success/failure without text matching.
 */

import { join } from 'node:path';
import { getTeamConfig } from '../config/loader.js';
import { errorMessage } from '../domain/errors.js';
import { extractStringCredentials } from '../domain/credential-utils.js';
import { resolveProvider } from './provider-resolver.js';
import { buildProviderRegistry, resolveModel, getContextWindow } from './provider-registry.js';
import { buildBuiltinTools } from './tools/index.js';
import { withAudit } from './tools/tool-audit.js';
import type { AuditWrapperOpts } from './tools/tool-audit.js';
import { connectMcpServers, resolveActiveTools } from './mcp-bridge.js';
import { buildSubagentTools } from './subagent-factory.js';
import { buildSystemPrompt, buildConversationHistorySection } from './prompt-builder.js';
import { runSession } from './ai-engine.js';
import type { ProgressCallback, ProgressUpdate } from './ai-engine.js';
import { buildSessionContext } from './context-builder.js';
import { buildRuleCascade } from '../rules/cascade.js';
import { loadSubagents, loadSkillsContent } from './skill-loader.js';
import { buildMemorySection } from './memory-loader.js';
import { MemoryStore } from '../storage/stores/memory-store.js';
import { scrubSecrets } from '../logging/credential-scrubber.js';
import type { ChannelMessage, IInteractionStore } from '../domain/interfaces.js';
import type { ProvidersOutput } from '../config/validation.js';
import type { TeamConfig } from '../domain/types.js';

// ── Public types ──────────────────────────────────────────────────────────

export interface MessageResult {
  readonly ok: boolean;
  readonly content?: string;
  readonly error?: string;
  readonly durationMs: number;
}

export interface HandleMessageOpts {
  runSessionFn?: typeof runSession;
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
  readonly interactionStore?: IInteractionStore;
  readonly orgTree?: {
    getChildren(parentId: string): { teamId: string }[];
  };
}

// ── Tool assembly ────────────────────────────────────────────────────────

/** Build all tools (builtin + MCP + subagent) and return cleanup fn. */
async function assembleTools(
  teamConfig: TeamConfig,
  teamName: string,
  deps: MessageHandlerDeps,
  registry: ReturnType<typeof buildProviderRegistry>,
  profileName: string,
  modelId: string,
  ctx: ReturnType<typeof buildSessionContext>,
  providerSecrets: readonly import('../secrets/secret-string.js').SecretString[],
  credValues: readonly string[],
  sourceChannelId?: string,
) {
  const teamCreds = teamConfig.credentials ?? {};
  const builtinTools = buildBuiltinTools({
    cwd: ctx.cwd,
    additionalDirs: ctx.additionalDirectories,
    credentials: teamCreds,
    governancePaths: { systemRulesDir: deps.systemRulesDir, dataDir: deps.dataDir, runDir: deps.runDir },
    teamName,
    audit: {
      logger: deps.logger,
      knownSecrets: providerSecrets,
      rawSecrets: credValues,
      callerId: teamName,
    },
  });

  const mcp = await connectMcpServers({
    configMcpServers: teamConfig.mcp_servers,
    orgMcpPort: deps.orgMcpPort ?? 3001,
    teamName,
    sourceChannelId,
  });

  // Wrap MCP tools with audit logging (same pattern as built-in tools)
  const auditOpts: AuditWrapperOpts = {
    logger: deps.logger,
    knownSecrets: providerSecrets,
    rawSecrets: credValues,
    callerId: teamName,
  };
  const auditedMcpTools: typeof mcp.tools = {};
  for (const [name, t] of Object.entries(mcp.tools)) {
    const tool = t as unknown as { execute?: (...args: unknown[]) => Promise<unknown> };
    if (tool.execute) {
      auditedMcpTools[name] = { ...t, execute: withAudit(name, tool.execute, auditOpts) } as typeof t;
    } else {
      auditedMcpTools[name] = t;
    }
  }

  // Resolve which built-in + MCP tools this team is allowed to use
  const baseTools = { ...builtinTools, ...auditedMcpTools };
  const allowedNames = resolveActiveTools(Object.keys(baseTools), teamConfig.allowed_tools);
  const allowedSet = new Set(allowedNames);
  const filteredTools: typeof baseTools = {} as typeof baseTools;
  for (const [k, v] of Object.entries(baseTools)) {
    if (allowedSet.has(k)) (filteredTools as Record<string, unknown>)[k] = v;
  }

  // Subagents receive only the filtered toolset — same activeTools restriction
  const subagentDefs = loadSubagents(deps.runDir, teamName);
  const subagentTools = buildSubagentTools({
    registry, profileName, modelId, subagentDefs,
    tools: filteredTools,
  });

  const allTools = { ...baseTools, ...subagentTools };
  const activeTools = [...allowedNames, ...Object.keys(subagentTools)];

  return { allTools, activeTools, mcpCleanup: mcp.cleanup };
}

/** Recursively collect a team's ID and all descendant team IDs from the org tree via BFS. */
function getTeamAndDescendantIds(
  orgTree: MessageHandlerDeps['orgTree'],
  teamId: string,
): string[] {
  if (!orgTree) return [teamId];
  const ids: string[] = [teamId];
  const queue = [teamId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of orgTree.getChildren(current)) {
      ids.push(child.teamId);
      queue.push(child.teamId);
    }
  }
  return ids;
}

/** Build the full system prompt from rule cascade, skills, and memory. */
function assembleSystemPrompt(
  teamConfig: TeamConfig,
  teamName: string,
  deps: MessageHandlerDeps,
  sourceChannelId?: string,
) {
  const cascadeLogger = {
    info: (m: string, meta?: Record<string, unknown>) => deps.logger.info(m, meta),
    warn: (m: string, meta?: Record<string, unknown>) => (deps.logger.warn ?? deps.logger.info)(m, meta),
  };
  const ruleCascade = buildRuleCascade({
    teamName, ancestors: deps.orgAncestors,
    runDir: deps.runDir, dataDir: deps.dataDir, systemRulesDir: deps.systemRulesDir,
    logger: cascadeLogger,
  });
  const skillsContent = loadSkillsContent(deps.runDir, teamName);
  const teamMemoryStore = new MemoryStore(join(deps.runDir, 'teams'));
  const memorySection = buildMemorySection(teamMemoryStore, teamName);

  if (memorySection.length > 12000) {
    deps.logger.info('Team memory exceeds 12000 chars — consider summarizing', {
      teamName, length: memorySection.length,
    });
  }

  // Build conversation history for this team (includes descendants)
  let conversationHistory = '';
  if (sourceChannelId && deps.interactionStore) {
    const teamIds = getTeamAndDescendantIds(deps.orgTree, teamName);
    const recent = deps.interactionStore.getRecentByChannel(sourceChannelId, teamIds, 10);
    if (recent.length > 0) {
      conversationHistory = buildConversationHistorySection(recent);
    }
  }

  return buildSystemPrompt({
    teamName,
    cwd: join(deps.runDir, 'teams', teamName),
    allowedTools: teamConfig.allowed_tools,
    credentialKeys: Object.keys(teamConfig.credentials ?? {}),
    ruleCascade, skillsContent, memorySection,
    conversationHistory,
  });
}

// ── Main entry point ──────────────────────────────────────────────────────

/**
 * Handle an inbound message by spawning an AI SDK session.
 */
export async function handleMessage(
  msg: ChannelMessage,
  deps: MessageHandlerDeps,
  opts?: HandleMessageOpts,
): Promise<MessageResult> {
  const startMs = Date.now();
  const teamName = opts?.teamName ?? 'main';

  const teamConfig = getTeamConfig(deps.runDir, teamName);
  if (!teamConfig) {
    return {
      ok: false,
      error: 'OpenHive is not configured yet. Please set up providers.yaml and restart.',
      durationMs: Date.now() - startMs,
    };
  }

  let mcpCleanup: (() => Promise<void>) | undefined;
  try {
    const { model: modelId, secrets: providerSecrets } = resolveProvider(teamConfig.provider_profile, deps.providers);
    const registry = buildProviderRegistry(deps.providers);
    const profileName = teamConfig.provider_profile;
    const model = resolveModel(registry, profileName, modelId);
    const contextWindow = getContextWindow(deps.providers, profileName);
    const ctx = buildSessionContext(teamName, deps.runDir);

    const teamCreds = teamConfig.credentials ?? {};
    const credValues = extractStringCredentials(teamCreds);

    const tools = await assembleTools(teamConfig, teamName, deps, registry, profileName, modelId, ctx, providerSecrets, credValues, opts?.sourceChannelId);
    mcpCleanup = tools.mcpCleanup;

    const system = assembleSystemPrompt(teamConfig, teamName, deps, opts?.sourceChannelId);
    const safeOnProgress = opts?.onProgress && credValues.length > 0
      ? (update: ProgressUpdate) => {
          opts.onProgress!({ ...update, content: scrubSecrets(update.content, [], credValues) });
        }
      : opts?.onProgress;

    const sessionFn = opts?.runSessionFn ?? runSession;
    const result = await sessionFn({
      model, system, prompt: msg.content,
      tools: tools.allTools, activeTools: tools.activeTools,
      maxTurns: opts?.maxTurns ?? teamConfig.maxTurns,
      contextWindow, knownSecrets: providerSecrets, rawSecrets: credValues,
      onProgress: safeOnProgress,
    });

    const durationMs = Date.now() - startMs;
    if (!result.text) {
      deps.logger.info('Session completed (empty response)', { teamName, durationMs });
      return { ok: true, durationMs };
    }

    const safeText = credValues.length > 0 ? scrubSecrets(result.text, [], credValues) : result.text;
    deps.logger.info('Session completed', { teamName, durationMs });
    return { ok: true, content: safeText, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const errMsg = errorMessage(err);
    deps.logger.info('Message handler error', { teamName, error: errMsg, durationMs });
    return { ok: false, error: errMsg, durationMs };
  } finally {
    await mcpCleanup?.();
  }
}
