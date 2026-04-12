/**
 * Bootstrap helper functions — extracted from index.ts for size limit.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { errorMessage } from './domain/errors.js';
import { loadChannels } from './config/loader.js';
import { createDatabase, createTables } from './storage/database.js';
import { OrgStore } from './storage/stores/org-store.js';
import { TaskQueueStore } from './storage/stores/task-queue-store.js';
import { TriggerStore } from './storage/stores/trigger-store.js';
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
import { migrateFilesystemMemory } from './storage/migration.js';
import { migrateCredentialsToVault } from './storage/migration-vault.js';
import { seedLearningTrigger, seedReflectionTrigger } from './handlers/tools/spawn-team.js';

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

/** @deprecated Skills now loaded from system-rules/skills/ via resolveActiveSkill() fallback. */
export function seedTeamSkills(_runDir: string, _seedSkillsDir: string): void {
  return;
}

export interface StorageResult extends DatabaseInstance {
  readonly orgStore: OrgStore;
  readonly taskQueueStore: TaskQueueStore;
  readonly triggerStore: TriggerStore;
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
  const triggerStore = new TriggerStore(db);
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

/** Run one-time filesystem → SQLite migration for memory data. */
export function runMemoryMigration(memoryStore: MemoryStore, orgTree: OrgTree, runDir: string, logger: AppLogger): void {
  try { migrateFilesystemMemory(memoryStore, orgTree, runDir, (msg, meta) => logger.info(msg, meta)); }
  catch (err) { logger.warn('Memory migration failed (non-fatal)', { error: errorMessage(err) }); }
}

/** Migrate config.yaml credentials into the vault (additive, idempotent). */
export function runVaultMigration(vaultStore: VaultStore, runDir: string, logger: AppLogger): void {
  try { migrateCredentialsToVault(vaultStore, runDir, (msg, meta) => logger.info(msg, meta)); }
  catch (err) { logger.warn('Vault credential migration failed (non-fatal)', { error: errorMessage(err) }); }
}

export function initTriggerEngine(
  triggerStore: TriggerStore,
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
    delegateTask: (team, task, priority, triggerName, sourceChannelId) => {
      // Unique correlationId per task: trigger:{name}:{timestamp}
      const correlationId = triggerName ? `trigger:${triggerName}:${Date.now()}` : undefined;
      // Snapshot max_turns and skill from trigger config
      let options: import('./domain/types.js').TaskOptions | undefined;
      if (triggerName) {
        const entry = triggerConfigStore.get(team, triggerName);
        if (entry?.maxTurns || entry?.skill) options = { maxTurns: entry?.maxTurns, skill: entry?.skill };
      }
      const taskId = taskQueueStore.enqueue(team, task, (priority ?? 'normal') as import('./domain/types.js').TaskPriority, 'trigger', sourceChannelId, correlationId, options);
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
      mcp_servers: [], provider_profile: 'default', maxTurns: 200,
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

/** Seed learning-cycle + reflection-cycle triggers for all existing teams (idempotent). */
export function seedLearningTriggers(runDir: string, triggerConfigStore: ITriggerConfigStore): void {
  const teamsDir = join(runDir, 'teams');
  if (!existsSync(teamsDir)) return;
  let teamDirs: string[];
  try { teamDirs = readdirSync(teamsDir); } catch { return; }
  for (const teamName of teamDirs) {
    seedLearningTrigger(teamName, triggerConfigStore);
    seedReflectionTrigger(teamName, triggerConfigStore);
  }
}


/** Migrate legacy `mcp__org__*` allowed_tools patterns to bare tool names. */
export function migrateAllowedTools(runDir: string): void {
  const teamsDir = join(runDir, 'teams');
  if (!existsSync(teamsDir)) return;
  let teamDirs: string[];
  try { teamDirs = readdirSync(teamsDir); } catch { return; }
  for (const teamName of teamDirs) {
    const configPath = join(teamsDir, teamName, 'config.yaml');
    if (!existsSync(configPath)) continue;
    let raw: string;
    try { raw = readFileSync(configPath, 'utf-8'); } catch { continue; }
    let parsed: Record<string, unknown>;
    try { parsed = yamlParse(raw) as Record<string, unknown>; } catch { continue; }
    const allowedTools = parsed['allowed_tools'];
    if (!Array.isArray(allowedTools)) continue;
    let changed = false;
    const migrated = allowedTools.map((tool: unknown) => {
      if (typeof tool !== 'string') return tool;
      if (!tool.startsWith('mcp__org__')) return tool;
      changed = true;
      if (tool === 'mcp__org__*') return '*';
      return tool.slice('mcp__org__'.length);
    });
    if (!changed) continue;
    parsed['allowed_tools'] = [...new Set(migrated as string[])];
    // Also strip 'org' from mcp_servers if present
    const mcpServers = parsed['mcp_servers'];
    if (Array.isArray(mcpServers)) {
      const filtered = mcpServers.filter((s: unknown) => s !== 'org');
      if (filtered.length !== mcpServers.length) parsed['mcp_servers'] = filtered;
    }
    try { writeFileSync(configPath, yamlStringify(parsed), 'utf-8'); } catch { /* best effort */ }
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
