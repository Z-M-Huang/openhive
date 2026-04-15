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
import { buildSkillRepoTools } from './tools/skill-repo-tool.js';
import { buildMemoryTools } from './tools/memory-tools.js';
import { buildVaultTools } from './tools/vault-tools.js';
import type { OrgToolContext } from './tools/org-tool-context.js';
import { buildSubagentTools } from './subagent-factory.js';
import { loadSubagents, resolveActiveSkill, parseRequiredTools } from './skill-loader.js';
import { loadPluginTools } from './tools/plugin-loader.js';
import type { buildSessionContext } from './context-builder.js';
import type { buildProviderRegistry } from './provider-registry.js';
import type { SecretString } from '../secrets/secret-string.js';
import type { TeamConfig } from '../domain/types.js';
import type { IPluginToolStore } from '../domain/interfaces.js';
import type { MessageHandlerDeps } from './message-handler.js';

/** Build all tools (builtin + inline org/trigger/browser/web_fetch + subagent + plugin). */
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
  skillName?: string,
  subagent?: string,
) {
  // Vault is the sole authoritative runtime credential source (AC-10)
  const vaultSecrets = deps.vaultStore?.getSecrets(teamName) ?? [];
  const teamCreds: Record<string, string> = {};
  for (const entry of vaultSecrets) {
    teamCreds[entry.key] = entry.value;
  }
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

  const orgToolCtx: OrgToolContext = {
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
  };

  // Inline tool partitions (alphabetical within each)
  const orgTools = buildOrgTools(orgToolCtx);
  const triggerTools = buildTriggerTools(orgToolCtx);
  const browserTools = buildBrowserTools(orgToolCtx);
  const webFetchTools = buildWebFetchTool(orgToolCtx);
  const skillRepoTools = buildSkillRepoTools(orgToolCtx);

  const auditOpts: AuditWrapperOpts = {
    logger: deps.logger, knownSecrets: providerSecrets, rawSecrets: credValues, callerId: teamName,
  };
  const wrapAudit = (set: Record<string, unknown>) => {
    for (const [n, t] of Object.entries(set)) {
      const a = t as Record<string, unknown> & { execute?: (...args: unknown[]) => Promise<unknown> };
      if (a.execute) set[n] = { ...a, execute: withAudit(n, a.execute, auditOpts) };
    }
  };
  const inlineTools = { ...orgTools, ...triggerTools, ...browserTools, ...webFetchTools, ...skillRepoTools };
  wrapAudit(inlineTools);
  const baseTools = { ...builtinTools, ...inlineTools };
  const allowedNames = resolveActiveTools(Object.keys(baseTools), teamConfig.allowed_tools);
  const allowedSet = new Set(allowedNames);
  const filteredTools: typeof builtinTools = {} as typeof builtinTools;
  for (const [k, v] of Object.entries(baseTools)) {
    if (allowedSet.has(k)) (filteredTools as Record<string, unknown>)[k] = v;
  }
  const subagentTools = buildSubagentTools({
    registry, profileName, modelId, subagentDefs: loadSubagents(deps.runDir, teamName), tools: filteredTools,
  });
  const memoryTools = buildMemoryTools(orgToolCtx);
  wrapAudit(memoryTools);
  const vaultTools = buildVaultTools(orgToolCtx);
  wrapAudit(vaultTools);

  // Plugin tools from active skill's Required Tools section.
  // ADR-40: when a subagent is selected, message-handler must not directly
  // load plugin tools via a skill — that routing is owned by the subagent
  // runtime (U24). Skip skill-driven plugin loading whenever `subagent` is set.
  let pluginToolSet: Record<string, unknown> = {};
  if (pluginToolStore && !subagent) {
    const activeSkill = resolveActiveSkill(deps.runDir, teamName, skillName, deps.systemRulesDir);
    const required = activeSkill ? parseRequiredTools(activeSkill.content) : [];
    if (required.length > 0) pluginToolSet = await loadPluginTools(teamName, required, teamConfig.allowed_tools, pluginToolStore, deps.runDir);
  }
  const allTools = { ...baseTools, ...subagentTools, ...memoryTools, ...vaultTools, ...pluginToolSet };
  const activeTools = [...allowedNames, ...Object.keys(subagentTools), ...Object.keys(memoryTools), ...Object.keys(vaultTools), ...Object.keys(pluginToolSet)];
  return { allTools, activeTools };
}
