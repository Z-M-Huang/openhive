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
import type { buildSessionContext } from './context-builder.js';
import type { buildProviderRegistry } from './provider-registry.js';
import type { SecretString } from '../secrets/secret-string.js';
import type { TeamConfig } from '../domain/types.js';
import type { IPluginToolStore, IConcurrencyManager } from '../domain/interfaces.js';
import type { MessageHandlerDeps } from './message-handler.js';

// ── ADR-41: Tool concurrency classification ───────────────────────────────────

/**
 * Whether a tool is a high-volume daily operation or a low-frequency structural
 * org operation.  See ADR-41 for the full classification rationale.
 */
export type ToolClass = 'daily' | 'org';

/**
 * Authoritative classification table (ADR-41, AC-56, AC-57).
 *
 * Disputed tools resolved:
 *  - query_teams       → daily  (read-only query; charged to caller pool)
 *  - enqueue_parent_task → daily (runtime dispatch; not a structural org change)
 *  - create_trigger    → org   (structural config creation)
 *  - update_trigger    → org   (structural config modification)
 *  - disable_trigger   → org   (structural config change; symmetric with enable_trigger)
 *  - enable_trigger    → org   (structural config change; consistent with disable_trigger)
 */
export const TOOL_CLASSIFICATION: Record<string, ToolClass> = {
  // ── Daily ops — high-volume runtime operations (AC-56) ───────────────────
  delegate_task: 'daily',
  enqueue_parent_task: 'daily',  // ADR-41: runtime dispatch; not structural org change
  escalate: 'daily',
  get_status: 'daily',
  list_completed_tasks: 'daily',
  list_teams: 'daily',
  list_trusted_senders: 'daily',
  query_team: 'daily',
  query_teams: 'daily',          // ADR-41: read-only query; charges to caller pool
  search_skill_repository: 'daily',
  send_message: 'daily',
  web_fetch: 'daily',
  // Memory tools
  memory_delete: 'daily',
  memory_list: 'daily',
  memory_save: 'daily',
  memory_search: 'daily',
  // Vault tools
  vault_delete: 'daily',
  vault_get: 'daily',
  vault_list: 'daily',
  vault_set: 'daily',
  // Browser tools
  browser_click: 'daily',
  browser_close: 'daily',
  browser_go_back: 'daily',
  browser_go_forward: 'daily',
  browser_navigate: 'daily',
  browser_screenshot: 'daily',
  browser_snapshot: 'daily',
  browser_type: 'daily',
  // Trigger read/test ops (non-structural)
  list_triggers: 'daily',
  test_trigger: 'daily',

  // ── Org ops — structural, low-frequency configuration changes (AC-57) ────
  add_trusted_sender: 'org',
  register_plugin_tool: 'org',
  revoke_sender_trust: 'org',
  shutdown_team: 'org',
  spawn_team: 'org',
  update_team: 'org',
  // Trigger structural ops: creation/modification of trigger config is an org-level change
  create_trigger: 'org',   // ADR-41: structural config creation
  disable_trigger: 'org',  // ADR-41: structural config change
  enable_trigger: 'org',   // ADR-41: consistent with disable_trigger
  update_trigger: 'org',   // ADR-41: structural config modification
};

/**
 * Wrap a tool's `execute` function with concurrency admission control (ADR-41).
 *
 * The wrapper:
 * 1. Classifies the tool via TOOL_CLASSIFICATION.
 * 2. Calls acquireDaily / acquireOrg on the manager before execution.
 * 3. On slot denial, returns `{ success: false, retry_after_ms }` immediately.
 * 4. On slot grant, executes the original tool and releases the slot in `finally`.
 *
 * Saturation policy (AC-58): reject + retry_after_ms — no queuing.
 * Pool ownership: determined by `resolveOwner(input, callerId)`.
 *
 * Tools not present in TOOL_CLASSIFICATION bypass admission (no slot charged).
 */
export function withConcurrencyAdmission<T extends object>(
  toolName: string,
  tool: T,
  mgr: IConcurrencyManager,
  resolveOwner: (input: unknown, callerId: string) => string,
): T {
  const a = tool as Record<string, unknown> & { execute?: (...args: unknown[]) => Promise<unknown> };
  if (!a.execute) return tool;

  const cls = TOOL_CLASSIFICATION[toolName];
  if (!cls) return tool; // unclassified tools are not subject to admission

  const originalExecute = a.execute;

  const wrappedExecute = async (...args: unknown[]): Promise<unknown> => {
    const [input] = args;
    // callerId '' is a sentinel; resolveOwner closures capture the real teamName
    const ownerId = resolveOwner(input, '');

    if (cls === 'daily') {
      const slot = mgr.acquireDaily(ownerId);
      if (!slot.ok) {
        return { success: false, retry_after_ms: (slot as { ok: false; retry_after_ms: number }).retry_after_ms };
      }
      try {
        return await originalExecute(...args);
      } finally {
        mgr.releaseDaily(ownerId);
      }
    } else {
      const slot = mgr.acquireOrg(ownerId);
      if (!slot.ok) {
        return { success: false, retry_after_ms: (slot as { ok: false; retry_after_ms: number }).retry_after_ms };
      }
      try {
        return await originalExecute(...args);
      } finally {
        mgr.releaseOrg(ownerId);
      }
    }
  };

  return { ...a, execute: wrappedExecute } as unknown as T;
}

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

  // Inline tool partitions (alphabetical within each)
  const orgTools = buildOrgTools(orgToolCtx);
  const triggerTools = buildTriggerTools(orgToolCtx);
  const browserTools = buildBrowserTools(orgToolCtx);
  const webFetchTools = buildWebFetchTool({
    rateLimiter: buildWebFetchRateLimiter(teamConfig.rate_limit_buckets),
  });
  const skillRepoTools = buildSkillRepoTools();

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

  const allTools = { ...baseTools, ...subagentTools, ...memoryTools, ...vaultTools };
  const activeTools = [...allowedNames, ...Object.keys(subagentTools), ...Object.keys(memoryTools), ...Object.keys(vaultTools)];
  return { allTools, activeTools };
}
