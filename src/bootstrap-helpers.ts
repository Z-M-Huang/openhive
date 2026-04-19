/**
 * Bootstrap helper functions — extracted from index.ts for size limit.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import { errorMessage } from './domain/errors.js';
import { loadChannels } from './config/loader.js';
import { createDatabase, createTables } from './storage/database.js';
import { OrgStore } from './storage/stores/org-store.js';
import { TaskQueueStore } from './storage/stores/task-queue-store.js';
import { TriggerDedupStore } from './storage/stores/trigger-dedup-store.js';
import { LogStore } from './storage/stores/log-store.js';
import { EscalationStore } from './storage/stores/escalation-store.js';
import { MemoryStore } from './storage/stores/memory-store.js';
import { TriggerConfigStore } from './storage/stores/trigger-config-store.js';
import { InteractionStore } from './storage/stores/interaction-store.js';
import { TopicStore } from './storage/stores/topic-store.js';
import { SenderTrustStore } from './storage/stores/sender-trust-store.js';
import { TrustAuditStore } from './storage/stores/trust-audit-store.js';
import { VaultStore } from './storage/stores/vault-store.js';
import { PluginToolStore } from './storage/stores/plugin-tool-store.js';
import { TriggerDedup } from './triggers/dedup.js';
import { TriggerRateLimiter } from './triggers/rate-limiter.js';
import { TriggerEngine } from './triggers/engine.js';
import { DiscordAdapter } from './channels/discord-adapter.js';
import { SecretString } from './secrets/secret-string.js';
import type { IChannelAdapter, ITriggerConfigStore } from './domain/interfaces.js';
import type { ChannelsOutput } from './config/validation.js';
import type { DatabaseInstance } from './storage/database.js';
import type { OrgTree } from './domain/org-tree.js';
import { TaskStatus, TeamStatus } from './domain/types.js';
import type { AppLogger } from './logging/logger.js';
import { seedLearningTrigger, seedReflectionTrigger } from './handlers/tools/spawn-team.js';
import { loadSubagents } from './sessions/skill-loader.js';
import { buildTriggerTaskOptions } from './triggers/task-options.js';

export interface ChannelDeps { readonly dataDir: string }

/** Ensure .run/ directory structure exists. */
export function ensureRunDir(runDir: string): void {
  const subdirs = ['teams', 'shared', 'backups'];
  for (const sub of subdirs) {
    mkdirSync(join(runDir, sub), { recursive: true });
  }
}

/** Ensure /data/rules/ directory exists. Escalation content now lives in system-rules/agent-patterns.md. */
export function ensureRulesDir(dataDir: string): void {
  mkdirSync(join(dataDir, 'rules'), { recursive: true });
}

export interface StorageResult extends DatabaseInstance {
  readonly orgStore: OrgStore;
  readonly taskQueueStore: TaskQueueStore;
  readonly triggerStore: TriggerDedupStore;
  readonly logStore: LogStore;
  readonly escalationStore: EscalationStore;
  readonly memoryStore: MemoryStore;
  readonly triggerConfigStore: TriggerConfigStore;
  readonly interactionStore: InteractionStore;
  readonly topicStore: TopicStore;
  readonly senderTrustStore: SenderTrustStore;
  readonly trustAuditStore: TrustAuditStore;
  readonly vaultStore: VaultStore;
  readonly pluginToolStore: PluginToolStore;
}

export function initStorage(_dataDir: string, runDir: string): StorageResult {
  const dbPath = join(runDir, 'openhive.db');
  const { db, raw } = createDatabase(dbPath);
  createTables(raw);
  const orgStore = new OrgStore(db);
  const taskQueueStore = new TaskQueueStore(db);
  const triggerStore = new TriggerDedupStore(db);
  const logStore = new LogStore(db);
  const escalationStore = new EscalationStore(db);
  const memoryStore = new MemoryStore(db, raw);
  const triggerConfigStore = new TriggerConfigStore(db);
  const interactionStore = new InteractionStore(db);
  const topicStore = new TopicStore(db);
  const senderTrustStore = new SenderTrustStore(db);
  const trustAuditStore = new TrustAuditStore(db);
  const vaultStore = new VaultStore(db);
  const pluginToolStore = new PluginToolStore(db);
  return { db, raw, orgStore, taskQueueStore, triggerStore, logStore, escalationStore, memoryStore, triggerConfigStore, interactionStore, topicStore, senderTrustStore, trustAuditStore, vaultStore, pluginToolStore };
}

export function initTriggerEngine(
  triggerStore: TriggerDedupStore,
  taskQueueStore: TaskQueueStore,
  logger: AppLogger,
  triggerConfigStore: TriggerConfigStore,
  onTriggerDeactivated?: (team: string, triggerName: string, reason: string) => void,
): TriggerEngine {
  const dedup = new TriggerDedup(triggerStore);
  const rateLimiter = new TriggerRateLimiter(10, 60_000);
  const engine = new TriggerEngine({
    dedup,
    rateLimiter,
    configStore: triggerConfigStore,
    taskQueueStore,
    delegateTask: (team, task, priority, triggerName, sourceChannelId, options) => {
      // Unique correlationId per task: trigger:{name}:{timestamp}
      const correlationId = triggerName ? `trigger:${triggerName}:${Date.now()}` : undefined;
      // Options from the engine are authoritative — they are snapshotted from the live trigger
      // config (subagent, maxSteps). Fall back to the store only if the caller passed no options
      // (defensive, keeps backwards compatibility for any non-engine caller).
      let effectiveOptions: import('./domain/types.js').TaskOptions | undefined = options;
      if (!effectiveOptions && triggerName) {
        effectiveOptions = buildTriggerTaskOptions(triggerConfigStore.get(team, triggerName));
      }
      const taskId = taskQueueStore.enqueue(team, task, (priority ?? 'normal') as import('./domain/types.js').TaskPriority, 'trigger', sourceChannelId, correlationId, effectiveOptions);
      return Promise.resolve(taskId);
    },
    abortSession: (teamId, taskId) => {
      try { taskQueueStore.updateStatus(taskId, TaskStatus.Cancelled); } catch { /* best-effort */ }
    },
    onOverlapAlert: (team, triggerName, action, details) => {
      logger.warn(`Trigger overlap: ${action}`, { team, triggerName, oldTaskId: details.oldTaskId });
    },
    logger,
    onTriggerDeactivated,
  });
  engine.loadFromStore();
  return engine;
}

export function initChannels(
  channelDeps: ChannelDeps | undefined,
  logger: AppLogger,
): { adapters: IChannelAdapter[]; wsEnabled: boolean } {
  if (!channelDeps) return { adapters: [], wsEnabled: false };
  const adapters: IChannelAdapter[] = [];

  let channelsConfig: ChannelsOutput | null = null;
  const channelsPath = join(channelDeps.dataDir, 'config', 'channels.yaml');
  if (existsSync(channelsPath)) {
    try { channelsConfig = loadChannels(channelsPath); }
    catch (err) { logger.warn('Failed to load channels.yaml', { err }); }
  }

  // Discord adapter (from channels.yaml or env var fallback)
  const discordToken = channelsConfig?.discord?.token
    ?? process.env['DISCORD_BOT_TOKEN'];
  if (discordToken) {
    logger.info('Discord bot token found, wiring Discord adapter');
    adapters.push(new DiscordAdapter({
      token: new SecretString(discordToken),
      watchedChannelIds: channelsConfig?.discord?.watched_channels,
    }));
  }

  const wsEnabled = channelsConfig?.ws?.enabled ?? false;
  return { adapters, wsEnabled };
}

/** Scaffold the main team on first start. */
export function ensureMainTeam(runDir: string, orgTree: OrgTree): void {
  const mainDir = join(runDir, 'teams', 'main');
  const configPath = join(mainDir, 'config.yaml');

  const subdirs = ['org-rules', 'team-rules', 'skills', 'subagents', 'plugins'];
  for (const sub of subdirs) {
    mkdirSync(join(mainDir, sub), { recursive: true });
  }

  if (!existsSync(configPath)) {
    const config = {
      name: 'main', description: 'Main orchestrator',
      allowed_tools: ['*'],
      provider_profile: 'default', maxSteps: 200,
    };
    writeFileSync(configPath, yamlStringify(config), 'utf-8');
  }

  if (!orgTree.getTeam('main')) {
    orgTree.addTeam({
      teamId: 'main', name: 'main', parentId: null,
      status: TeamStatus.Active, agents: [], children: [],
    });
  }
}

/**
 * Remove any existing learning-cycle* / reflection-cycle* trigger rows owned
 * by the main team. AC-19: the main orchestrator is routing-only — it never
 * runs learning or reflection cycles. Called during bootstrap to clean up
 * legacy rows migrated from earlier versions.
 */
export function cleanMainTeamCycleTriggers(triggerConfigStore: ITriggerConfigStore): void {
  const rows = triggerConfigStore.getByTeam('main');
  for (const row of rows) {
    if (row.name.startsWith('learning-cycle') || row.name.startsWith('reflection-cycle')) {
      triggerConfigStore.remove('main', row.name);
    }
  }
}

/**
 * Seed learning- + reflection-cycle triggers for one team. Used both by the
 * startup bulk seeder (`seedLearningTriggers`) and by the post-bootstrap hook
 * in task-consumer, where subagents only become visible after the bootstrap
 * task writes `teams/{team}/subagents/*.md` to disk.
 *
 * The `main` team is always skipped (routing-only, AC-19). When a team has
 * zero subagents on disk, the generic `learning-cycle` / `reflection-cycle`
 * rows are seeded — that is the correct outcome for teams that never adopt
 * the subagent model. When subagents exist, one trigger per subagent is
 * seeded instead.
 */
export function seedLearningTriggersForTeam(
  runDir: string,
  teamName: string,
  triggerConfigStore: ITriggerConfigStore,
): void {
  if (teamName === 'main') return;
  const subagents = Object.keys(loadSubagents(runDir, teamName));
  if (subagents.length === 0) {
    seedLearningTrigger(teamName, undefined, triggerConfigStore);
    seedReflectionTrigger(teamName, undefined, triggerConfigStore);
    return;
  }
  for (const subagent of subagents) {
    seedLearningTrigger(teamName, subagent, triggerConfigStore);
    seedReflectionTrigger(teamName, subagent, triggerConfigStore);
  }
}

/**
 * Seed learning-cycle + reflection-cycle triggers for all existing teams
 * (idempotent). AC-19: the `main` team is skipped — main is routing-only.
 *
 * AC-17/AC-18: when a team has subagents defined under
 * `teams/{team}/subagents/*.md`, seed one `learning-cycle-{subagent}` and one
 * `reflection-cycle-{subagent}` trigger per subagent. The generic
 * `learning-cycle` / `reflection-cycle` triggers are only seeded when the
 * team has no subagents — this preserves the default behavior for teams that
 * never adopt the subagent model.
 */
export function seedLearningTriggers(runDir: string, triggerConfigStore: ITriggerConfigStore): void {
  cleanMainTeamCycleTriggers(triggerConfigStore);
  const teamsDir = join(runDir, 'teams');
  if (!existsSync(teamsDir)) return;
  let teamDirs: string[];
  try { teamDirs = readdirSync(teamsDir); } catch { return; }
  for (const teamName of teamDirs) {
    seedLearningTriggersForTeam(runDir, teamName, triggerConfigStore);
  }
}

export async function initBrowserRelay(logger: AppLogger): Promise<import('./sessions/tools/browser-proxy.js').BrowserRelay | undefined> {
  try {
    const { createBrowserRelay } = await import('./sessions/tools/browser-proxy.js');
    const relay = await createBrowserRelay({ logger });
    logger.info('Browser relay initialized', { tools: relay.getToolNames().length });
    return relay;
  } catch (err) {
    const msg = errorMessage(err);
    const isModule = msg.includes('Cannot find module') || msg.includes('MODULE_NOT_FOUND');
    logger.error(isModule
      ? 'Browser relay failed to initialize — @playwright/mcp not found, please update to the latest OpenHive version'
      : `Browser relay failed to initialize: ${msg}`, { error: msg });
    return undefined;
  }
}
