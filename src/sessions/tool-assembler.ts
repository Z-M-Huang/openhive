/**
 * Tool assembler — builds the complete tool set for an AI SDK session.
 *
 * Extracted from message-handler.ts to keep both files under the 300-line gate.
 */

import { getTeamConfig } from '../config/loader.js';
import { buildBuiltinTools } from './tools/index.js';
import { withAudit } from './tools/tool-audit.js';
import type { AuditWrapperOpts } from './tools/tool-audit.js';
import { resolveActiveTools } from './tools/active-tools.js';
import { buildOrgTools } from './tools/org-tools.js';
import { buildTriggerTools } from './tools/trigger-tools.js';
import { buildBrowserTools } from './tools/browser-tools.js';
import { buildWebFetchTool } from './tools/web-fetch-tool.js';
import { buildWebFetchRateLimiter } from './tools/web-fetch-rate-limiter.js';
import { buildSkillRepoTools } from './tools/skill-repo-tool.js';
import { buildMemoryTools } from './tools/memory-tools.js';
import { buildVaultTools } from './tools/vault-tools.js';
import type { OrgToolContext } from './tools/org-tool-context.js';
import { buildSubagentTools } from './subagent-factory.js';
import { loadSubagents } from './skill-loader.js';
import type { SubagentDefinition } from './skill-loader.js';
import { loadPluginTools, type LoadedPluginInfo } from './tools/plugin-loader.js';
import { buildUseSkillTool } from './tools/skill-tools.js';
import type { buildSessionContext } from './context-builder.js';
import type { buildProviderRegistry } from './provider-registry.js';
import type { SecretString } from '../secrets/secret-string.js';
import type { TeamConfig } from '../domain/types.js';
import type { IPluginToolStore } from '../domain/interfaces.js';
import type { MessageHandlerDeps } from './message-handler.js';
// Re-export ADR-41 concurrency surfaces so existing imports from this module
// (notably `tool-assembler.test.ts`) keep working without code change.
export { TOOL_CLASSIFICATION, withConcurrencyAdmission, type ToolClass } from './tool-concurrency.js';
import { withConcurrencyAdmission } from './tool-concurrency.js';

/**
 * Build the OrgToolContext from MessageHandlerDeps + team metadata.
 * Extracted to keep assembleTools under the 100-line function-length gate.
 */
function buildOrgToolCtx(
  deps: MessageHandlerDeps,
  teamName: string,
  sourceChannelId: string | undefined,
  pluginToolStore: IPluginToolStore | undefined,
): OrgToolContext {
  return {
    teamName,
    sourceChannelId,
    orgTree: deps.orgTree as import('../domain/org-tree.js').OrgTree,
    spawner: deps.spawner ?? { spawn: () => Promise.resolve('') },
    sessionManager: deps.sessionManager ?? { getSession: () => Promise.resolve(null), terminateSession: () => Promise.resolve() },
    taskQueue: deps.taskQueue as import('../domain/interfaces.js').ITaskQueueStore,
    escalationStore: deps.escalationStore as import('../domain/interfaces.js').IEscalationStore,
    runDir: deps.runDir,
    loadConfig: deps.loadConfig ?? ((name: string) => getTeamConfig(deps.runDir, name) as TeamConfig),
    getTeamConfig: (deps.getTeamConfigFn ?? ((name: string) => getTeamConfig(deps.runDir, name))) as (name: string) => TeamConfig,
    log: (msg, meta) => deps.logger.info(msg, meta),
    queryRunner: deps.queryRunner,
    triggerEngine: deps.triggerEngine,
    triggerConfigStore: deps.triggerConfigStore,
    interactionStore: deps.interactionStore,
    browserRelay: deps.browserRelay,
    memoryStore: deps.memoryStore,
    senderTrustStore: deps.senderTrustStore,
    vaultStore: deps.vaultStore,
    pluginToolStore,
    // Runtime concurrency manager — applied at assembly time (ADR-41, R11a).
    // Declared on MessageHandlerDeps; production bootstrap instantiates one in
    // src/index.ts. Absent in many tests — admission silently skips when undefined.
    concurrencyManager: deps.concurrencyManager,
  };
}

/**
 * Build the built-in tool set (Read/Write/Edit/Glob/Grep/Bash) wired up with
 * vault credentials, governance paths, and audit wiring. Extracted to keep
 * `assembleTools` under the 100-line gate.
 */
function buildBuiltinToolSet(
  teamName: string,
  ctx: ReturnType<typeof buildSessionContext>,
  deps: MessageHandlerDeps,
  providerSecrets: readonly SecretString[],
  credValues: readonly string[],
): ReturnType<typeof buildBuiltinTools> {
  const teamCreds: Record<string, string> = {};
  for (const entry of deps.vaultStore?.getSecrets(teamName) ?? []) {
    teamCreds[entry.key] = entry.value;
  }
  return buildBuiltinTools({
    cwd: ctx.cwd,
    additionalDirs: ctx.additionalDirectories,
    credentials: teamCreds,
    governancePaths: { systemRulesDir: deps.systemRulesDir, dataDir: deps.dataDir, runDir: deps.runDir },
    teamName,
    audit: { logger: deps.logger, knownSecrets: providerSecrets, rawSecrets: credValues, callerId: teamName },
  });
}

/**
 * Build the inline tool partitions (org/trigger/browser/web_fetch/skill_repo)
 * that vary only with the org tool context + team rate-limit buckets. Kept
 * separate so `assembleTools` stays under the 100-line gate; the caller still
 * owns admission/audit wrapping because those wrappers need the per-call
 * `concurrencyManager` and `auditOpts` closures.
 */
function buildInlineToolSet(
  orgToolCtx: OrgToolContext,
  teamConfig: TeamConfig,
): Record<string, unknown> {
  return {
    ...buildOrgTools(orgToolCtx),
    ...buildTriggerTools(orgToolCtx),
    ...buildBrowserTools(orgToolCtx),
    ...buildWebFetchTool({
      rateLimiter: buildWebFetchRateLimiter(teamConfig.rate_limit_buckets),
    }),
    ...buildSkillRepoTools(),
  };
}

/**
 * Load plugin tools from a subagent's resolvedSkills, deduplicate descriptors,
 * and append `use_skill` when the subagent has at least one declared skill
 * (Fix 4 / 4.5 / 6). Returns the tool set + `pluginInfos` for the prompt
 * builder. Caller wraps the returned set with admission + audit.
 */
async function loadSubagentSkillTools(
  teamName: string,
  teamAllowedTools: readonly string[],
  pluginToolStore: IPluginToolStore,
  runDir: string,
  subagentDef: SubagentDefinition,
): Promise<{ tools: Record<string, unknown>; pluginInfos: LoadedPluginInfo[] }> {
  const tools: Record<string, unknown> = {};
  const pluginInfos: LoadedPluginInfo[] = [];
  for (const s of subagentDef.resolvedSkills ?? []) {
    const loaded = await loadPluginTools(
      teamName, s.requiredTools as string[], teamAllowedTools, pluginToolStore, runDir,
    );
    Object.assign(tools, loaded.tools);
    for (const info of loaded.infos) {
      if (!pluginInfos.some((p) => p.name === info.name)) pluginInfos.push(info);
    }
  }
  if ((subagentDef.resolvedSkills ?? []).length >= 1) {
    Object.assign(tools, buildUseSkillTool(subagentDef, teamName));
  }
  return { tools, pluginInfos };
}

/** Build all tools (builtin + inline org/trigger/browser/web_fetch + subagent + plugin).
 *
 * Fix 4: when `subagentDef` is provided, also load plugin tools from the
 * subagent's resolvedSkills and merge them into the active toolset so the
 * subagent can call them directly (no orchestrator hop).
 */
export async function assembleTools(
  teamConfig: TeamConfig,
  teamName: string,
  deps: MessageHandlerDeps,
  registry: ReturnType<typeof buildProviderRegistry>,
  profileName: string,
  modelId: string,
  ctx: ReturnType<typeof buildSessionContext>,
  providerSecrets: readonly SecretString[],
  credValues: readonly string[],
  sourceChannelId?: string,
  pluginToolStore?: IPluginToolStore,
  subagentDef?: SubagentDefinition,
) {
  // Vault is the sole authoritative runtime credential source (AC-10).
  const builtinTools = buildBuiltinToolSet(teamName, ctx, deps, providerSecrets, credValues);
  const orgToolCtx = buildOrgToolCtx(deps, teamName, sourceChannelId, pluginToolStore);

  // ── Concurrency admission helper (ADR-41) ──────────────────────────────────
  // Applied BEFORE audit so that audit remains the outermost wrapper; this keeps
  // the existing audit-wrap tests (which inspect String(execute)) intact.
  const concurrencyManager = orgToolCtx.concurrencyManager;
  // ADR-41: register this team's per-team cap override so TeamConfig.max_concurrent_daily_ops
  // actually takes effect at the admission layer (otherwise the manager's global default wins).
  if (concurrencyManager && typeof teamConfig.max_concurrent_daily_ops === 'number') {
    concurrencyManager.setTeamCap(teamName, teamConfig.max_concurrent_daily_ops);
  }
  const wrapAdmission = (set: Record<string, unknown>) => {
    if (!concurrencyManager) return;
    for (const [n, t] of Object.entries(set)) {
      // Charge all ops (daily and org) to the caller's pool.
      // resolveOwner ignores the callerId sentinel and uses the teamName closure.
      set[n] = withConcurrencyAdmission(n, t as object, concurrencyManager, () => teamName);
    }
  };

  const auditOpts: AuditWrapperOpts = {
    logger: deps.logger, knownSecrets: providerSecrets, rawSecrets: credValues, callerId: teamName,
  };
  const wrapAudit = (set: Record<string, unknown>) => {
    for (const [n, t] of Object.entries(set)) {
      const a = t as Record<string, unknown> & { execute?: (...args: unknown[]) => Promise<unknown> };
      if (a.execute) set[n] = { ...a, execute: withAudit(n, a.execute, auditOpts) };
    }
  };
  const inlineTools = buildInlineToolSet(orgToolCtx, teamConfig);
  wrapAdmission(inlineTools); // admission before audit so audit wraps the admission layer
  wrapAudit(inlineTools);
  const baseTools = { ...builtinTools, ...inlineTools };
  const allowedNames = resolveActiveTools(Object.keys(baseTools), teamConfig.allowed_tools);
  const allowedSet = new Set(allowedNames);
  const filteredTools: typeof builtinTools = {} as typeof builtinTools;
  for (const [k, v] of Object.entries(baseTools)) {
    if (allowedSet.has(k)) (filteredTools as Record<string, unknown>)[k] = v;
  }
  const subagentTools = await buildSubagentTools({
    registry, profileName, modelId,
    subagentDefs: loadSubagents(deps.runDir, teamName), tools: filteredTools,
    teamName, allowedTools: teamConfig.allowed_tools ?? [],
    pluginToolStore, runDir: deps.runDir,
  });
  const memoryTools = buildMemoryTools(orgToolCtx);
  wrapAdmission(memoryTools);
  wrapAudit(memoryTools);
  const vaultTools = buildVaultTools(orgToolCtx);
  wrapAdmission(vaultTools);
  wrapAudit(vaultTools);

  // Fix 4 / 4.5 / 6: per-subagent skill plugins + `use_skill` + plugin infos.
  let subagentSkillTools: Record<string, unknown> = {};
  let pluginInfos: LoadedPluginInfo[] = [];
  if (subagentDef && pluginToolStore && subagentDef.resolvedSkills) {
    const loaded = await loadSubagentSkillTools(
      teamName, teamConfig.allowed_tools ?? [], pluginToolStore, deps.runDir, subagentDef,
    );
    subagentSkillTools = loaded.tools;
    pluginInfos = loaded.pluginInfos;
    wrapAdmission(subagentSkillTools);
    wrapAudit(subagentSkillTools);
  }

  const allTools = { ...baseTools, ...subagentTools, ...memoryTools, ...vaultTools, ...subagentSkillTools };
  const activeTools = [
    ...allowedNames,
    ...Object.keys(subagentTools),
    ...Object.keys(memoryTools),
    ...Object.keys(vaultTools),
    ...Object.keys(subagentSkillTools),
  ];
  return { allTools, activeTools, pluginInfos };
}
