/**
 * Message handler — routes inbound channel messages to AI SDK sessions.
 *
 * Returns a structured MessageResult instead of raw strings, enabling
 * callers to distinguish success/failure without text matching.
 */
import { join } from 'node:path';
import { getTeamConfig } from '../config/loader.js';
import { errorMessage } from '../domain/errors.js';
import { resolveProvider } from './provider-resolver.js';
import { buildProviderRegistry, resolveModel, getContextWindow } from './provider-registry.js';
import type { TeamQueryRunner, IBrowserRelay, ITriggerEngine } from './tools/org-tool-context.js';
import { assembleTools } from './tool-assembler.js';
import { buildSystemPrompt, buildConversationHistorySection } from './prompt-builder.js';
import type { SystemPromptParts } from './prompt-builder.js';
import { runSession } from './ai-engine.js';
import type { ProgressCallback, ProgressUpdate } from './ai-engine.js';
import { buildSessionContext } from './context-builder.js';
import { buildRuleCascade } from '../rules/cascade.js';
import { resolveActiveSkill, loadActiveSkillContent } from './skill-loader.js';
import { buildMemorySection } from './memory-loader.js';
import { scrubSecrets } from '../logging/credential-scrubber.js';
import type { ChannelMessage, IInteractionStore, IMemoryStore, IVaultStore, ISenderTrustStore } from '../domain/interfaces.js';
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
  maxSteps?: number;
  sourceChannelId?: string;
  topicId?: string; topicName?: string;
  /**
   * Skill hint retained for legacy executor payloads.
   *
   * **Non-authoritative under ADR-40**: when `subagent` is set, any skill
   * injection path in message-handler is suppressed — the subagent owns skill
   * selection via its own runtime (Unit U24). Skill is still honored only for
   * the main-team exception path (Unit U31 will enforce that boundary).
   */
  skill?: string;
  /**
   * Authoritative subagent selector — when set the session executes under the
   * chosen subagent defined in `teams/<team>/subagents/`. The task consumer
   * validates the name exists before invoking handleMessage. Per ADR-40, setting
   * this disables any direct skill injection by message-handler, so the main /
   * orchestrator cannot bypass subagent routing by also passing a skill.
   */
  subagent?: string;
}

export interface MessageHandlerDeps {
  readonly providers: ProvidersOutput;
  readonly runDir: string;
  readonly dataDir: string;
  readonly systemRulesDir: string;
  readonly orgAncestors: string[];
  readonly logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    debug?(msg: string, meta?: Record<string, unknown>): void;
    trace?(msg: string, meta?: Record<string, unknown>): void;
    warn?(msg: string, meta?: Record<string, unknown>): void;
  };
  readonly interactionStore?: IInteractionStore;
  readonly orgTree?: {
    getChildren(parentId: string): { teamId: string }[];
  };
  // ── Org tool context deps (inline builders) ────────────────────────────
  readonly spawner?: import('../domain/interfaces.js').ISessionSpawner;
  readonly sessionManager?: import('../domain/interfaces.js').ISessionManager;
  readonly taskQueue?: import('../domain/interfaces.js').ITaskQueueStore;
  readonly escalationStore?: import('../domain/interfaces.js').IEscalationStore;
  readonly triggerConfigStore?: import('../domain/interfaces.js').ITriggerConfigStore;
  readonly triggerEngine?: ITriggerEngine;
  readonly browserRelay?: IBrowserRelay;
  readonly queryRunner?: TeamQueryRunner;
  readonly loadConfig?: (name: string) => TeamConfig;
  readonly getTeamConfigFn?: (name: string) => TeamConfig | undefined;
  readonly memoryStore?: IMemoryStore;
  readonly vaultStore?: IVaultStore;
  readonly senderTrustStore?: ISenderTrustStore;
  readonly pluginToolStore?: import('../domain/interfaces.js').IPluginToolStore;
}

/** Collect a team's ID and all descendant IDs from the org tree via BFS. */
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
  topicId?: string,
  topicName?: string,
  skillName?: string,
  subagent?: string,
): SystemPromptParts {
  const cascadeLogger = {
    info: (m: string, meta?: Record<string, unknown>) => deps.logger.info(m, meta),
    warn: (m: string, meta?: Record<string, unknown>) => (deps.logger.warn ?? deps.logger.info)(m, meta),
  };
  const ruleCascade = buildRuleCascade({
    teamName, ancestors: deps.orgAncestors,
    runDir: deps.runDir, dataDir: deps.dataDir, systemRulesDir: deps.systemRulesDir,
    logger: cascadeLogger,
  });
  // ADR-40: when a subagent is selected, message-handler MUST NOT inject skill
  // content into the prompt. Skill resolution is delegated to the subagent
  // runtime (U24), so the main agent / team orchestrator cannot bypass
  // subagent routing by also passing a skill.
  if (subagent && skillName) {
    (deps.logger.warn ?? deps.logger.info)(
      'Both skill and subagent provided — subagent wins, skill ignored (ADR-40)',
      { teamName, subagent, skill: skillName },
    );
  }
  const activeSkill = subagent
    ? null
    : resolveActiveSkill(deps.runDir, teamName, skillName, deps.systemRulesDir);

  // AC-20: active-only skill loading. Warn when a skill was explicitly
  // requested but could not be resolved — silent fallbacks mask missing-file
  // bugs. No warning when skillName is undefined (no active skill is valid).
  if (!subagent && skillName && !activeSkill) {
    (deps.logger.warn ?? deps.logger.info)('Active skill not found — no skill content injected', {
      teamName, skill: skillName,
    });
  }

  const skillsContent = subagent ? '' : loadActiveSkillContent(activeSkill);
  const memorySection = buildMemorySection(deps.memoryStore, teamName);

  if (memorySection.length > 12000) {
    deps.logger.info('Team memory exceeds 12000 chars — consider summarizing', {
      teamName, length: memorySection.length,
    });
  }

  // Build conversation history for this team (includes descendants)
  let conversationHistory = '';
  if (sourceChannelId && deps.interactionStore) {
    const teamIds = getTeamAndDescendantIds(deps.orgTree, teamName);
    const recent = deps.interactionStore.getRecentByChannel(sourceChannelId, teamIds, 10, topicId);
    if (recent.length > 0) {
      conversationHistory = buildConversationHistorySection(recent);
    }
  }

  return buildSystemPrompt({
    teamName,
    cwd: join(deps.runDir, 'teams', teamName),
    allowedTools: teamConfig.allowed_tools,
    ruleCascade, skillsContent, memorySection,
    conversationHistory, topicName,
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

  try {
    const { model: modelId, secrets: providerSecrets } = resolveProvider(teamConfig.provider_profile, deps.providers);
    const registry = buildProviderRegistry(deps.providers);
    const profileName = teamConfig.provider_profile;
    const model = resolveModel(registry, profileName, modelId);
    const contextWindow = getContextWindow(deps.providers, profileName);
    const ctx = buildSessionContext(teamName, deps.runDir);

    // Vault is the sole authoritative runtime credential source (AC-10)
    // Config credentials are never used at runtime — vault only.
    const vaultSecrets = deps.vaultStore?.getSecrets(teamName) ?? [];
    const credValues = vaultSecrets.map((entry) => entry.value).filter((v) => v.length >= 8);

    const tools = await assembleTools(teamConfig, teamName, deps, registry, profileName, modelId, ctx, providerSecrets, credValues, opts?.sourceChannelId, deps.pluginToolStore, opts?.skill, opts?.subagent);

    const system = assembleSystemPrompt(teamConfig, teamName, deps, opts?.sourceChannelId, opts?.topicId, opts?.topicName, opts?.skill, opts?.subagent);
    const safeOnProgress = opts?.onProgress && credValues.length > 0
      ? (update: ProgressUpdate) => {
          opts.onProgress!({ ...update, content: scrubSecrets(update.content, [], credValues) });
        }
      : opts?.onProgress;

    const sessionFn = opts?.runSessionFn ?? runSession;
    const result = await sessionFn({
      model, system, prompt: msg.content,
      tools: tools.allTools, activeTools: tools.activeTools,
      maxSteps: opts?.maxSteps ?? teamConfig.maxSteps,
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
  }
}
