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
import type { OrgToolContext } from './tools/org-tool-context.js';
import { buildSubagentTools } from './subagent-factory.js';
import { loadSubagents } from './skill-loader.js';
import type { buildSessionContext } from './context-builder.js';
import type { buildProviderRegistry } from './provider-registry.js';
import type { SecretString } from '../secrets/secret-string.js';
import type { TeamConfig } from '../domain/types.js';
import type { MessageHandlerDeps } from './message-handler.js';

/** Build all tools (builtin + inline org/trigger/browser/web_fetch + subagent). */
export function assembleTools(
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
  };

  // Inline tool partitions (alphabetical within each)
  const orgTools = buildOrgTools(orgToolCtx);
  const triggerTools = buildTriggerTools(orgToolCtx);
  const browserTools = buildBrowserTools(orgToolCtx);
  const webFetchTools = buildWebFetchTool(orgToolCtx);
  const skillRepoTools = buildSkillRepoTools(orgToolCtx);

  // Wrap inline tools with audit logging, then merge all tools
  const auditOpts: AuditWrapperOpts = {
    logger: deps.logger, knownSecrets: providerSecrets, rawSecrets: credValues, callerId: teamName,
  };
  const inlineTools = { ...orgTools, ...triggerTools, ...browserTools, ...webFetchTools, ...skillRepoTools };
  for (const [name, t] of Object.entries(inlineTools)) {
    const asTool = t as { execute?: (...args: unknown[]) => Promise<unknown> };
    if (asTool.execute) inlineTools[name] = { ...t, execute: withAudit(name, asTool.execute, auditOpts) };
  }
  const baseTools = { ...builtinTools, ...inlineTools };
  const allowedNames = resolveActiveTools(Object.keys(baseTools), teamConfig.allowed_tools);
  const allowedSet = new Set(allowedNames);
  const filteredTools: typeof builtinTools = {} as typeof builtinTools;
  for (const [k, v] of Object.entries(baseTools)) {
    if (allowedSet.has(k)) (filteredTools as Record<string, unknown>)[k] = v;
  }

  const subagentDefs = loadSubagents(deps.runDir, teamName);
  const subagentTools = buildSubagentTools({
    registry, profileName, modelId, subagentDefs,
    tools: filteredTools,
  });

  const allTools = { ...baseTools, ...subagentTools };
  const activeTools = [...allowedNames, ...Object.keys(subagentTools)];

  return { allTools, activeTools };
}
