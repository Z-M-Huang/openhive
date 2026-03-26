/**
 * Bootstrap helper functions — extracted from index.ts for size limit.
 */

import { existsSync, mkdirSync, cpSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import { loadTriggers, loadTeamTriggers, loadChannels } from './config/loader.js';
import { createDatabase, createTables } from './storage/database.js';
import { OrgStore } from './storage/stores/org-store.js';
import { TaskQueueStore } from './storage/stores/task-queue-store.js';
import { TriggerStore } from './storage/stores/trigger-store.js';
import { LogStore } from './storage/stores/log-store.js';
import { EscalationStore } from './storage/stores/escalation-store.js';
import { MemoryStore } from './storage/stores/memory-store.js';
import { TriggerDedup } from './triggers/dedup.js';
import { TriggerRateLimiter } from './triggers/rate-limiter.js';
import { TriggerEngine } from './triggers/engine.js';
import { CLIAdapter } from './channels/cli-adapter.js';
import { DiscordAdapter } from './channels/discord-adapter.js';
import { SecretString } from './secrets/secret-string.js';
import type { IChannelAdapter } from './domain/interfaces.js';
import type { TriggerConfig } from './domain/types.js';
import type { ChannelsOutput } from './config/validation.js';
import type { Readable, Writable } from 'node:stream';
import type { DatabaseInstance } from './storage/database.js';
import type { OrgTree } from './domain/org-tree.js';
import { TeamStatus } from './domain/types.js';
import type pino from 'pino';

export interface ChannelDeps {
  readonly dataDir: string;
  readonly cliInput?: Readable;
  readonly cliOutput?: Writable;
  readonly skipCli?: boolean;
}

/** Ensure .run/ directory structure exists. */
export function ensureRunDir(runDir: string): void {
  const subdirs = ['teams', 'shared', 'backups'];
  for (const sub of subdirs) {
    mkdirSync(join(runDir, sub), { recursive: true });
  }
}

/** Seed /data/rules/ from seed-rules if empty on first start. */
export function seedOrgRules(dataDir: string, seedRulesDir: string): void {
  const rulesDir = join(dataDir, 'rules');
  mkdirSync(rulesDir, { recursive: true });

  if (!existsSync(seedRulesDir)) return;

  // Only seed if rules dir is empty (no .md files)
  const existing = existsSync(rulesDir)
    ? readdirSync(rulesDir).filter(f => f.endsWith('.md'))
    : [];
  if (existing.length > 0) return;

  cpSync(seedRulesDir, rulesDir, { recursive: true });
}

export interface StorageResult extends DatabaseInstance {
  readonly orgStore: OrgStore;
  readonly taskQueueStore: TaskQueueStore;
  readonly triggerStore: TriggerStore;
  readonly logStore: LogStore;
  readonly escalationStore: EscalationStore;
  readonly memoryStore: MemoryStore;
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
  const memoryDir = join(runDir, 'teams');
  const memoryStore = new MemoryStore(memoryDir);

  return { db, raw, orgStore, taskQueueStore, triggerStore, logStore, escalationStore, memoryStore };
}

export function loadTriggerConfigs(runDir: string, logger: pino.Logger): TriggerConfig[] {
  const triggersPath = join(runDir, 'triggers.yaml');
  if (!existsSync(triggersPath)) {
    logger.info('No triggers.yaml found in .run/, skipping trigger loading');
    return [];
  }
  try {
    const result = loadTriggers(triggersPath);
    return result.triggers as TriggerConfig[];
  } catch (err) {
    logger.warn({ err }, 'Failed to load triggers.yaml');
    return [];
  }
}

export function loadAllTeamTriggerConfigs(runDir: string, orgTree: OrgTree, logger: pino.Logger): TriggerConfig[] {
  const teamsDir = join(runDir, 'teams');
  if (!existsSync(teamsDir)) return [];

  const allConfigs: TriggerConfig[] = [];
  for (const entry of readdirSync(teamsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const teamName = entry.name;
    if (!orgTree.getTeam(teamName)) continue;

    const path = join(teamsDir, teamName, 'triggers.yaml');
    if (!existsSync(path)) continue;

    try {
      const result = loadTeamTriggers(path);
      for (const t of result.triggers) allConfigs.push({ ...t, team: teamName });
      logger.info({ team: teamName, count: result.triggers.length }, 'Loaded team triggers');
    } catch (err) {
      logger.warn({ err, team: teamName }, 'Failed to load team triggers.yaml, skipping');
    }
  }

  // Legacy fallback: .run/triggers.yaml (deprecated)
  const teamsWithTriggers = new Set(allConfigs.map(c => c.team));
  const legacyPath = join(runDir, 'triggers.yaml');
  if (existsSync(legacyPath)) {
    logger.warn('DEPRECATED: .run/triggers.yaml found — migrate to per-team triggers.yaml');
    try {
      const legacy = loadTriggers(legacyPath);
      for (const t of legacy.triggers as TriggerConfig[]) {
        if (!teamsWithTriggers.has(t.team)) allConfigs.push(t);
        else logger.info({ team: t.team, trigger: t.name }, 'Skipping legacy trigger (per-team file takes precedence)');
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load legacy triggers.yaml');
    }
  }

  return allConfigs;
}

export function initTriggerEngine(
  triggerStore: TriggerStore,
  taskQueueStore: TaskQueueStore,
  logger: pino.Logger,
  triggers: TriggerConfig[],
): TriggerEngine {
  const dedup = new TriggerDedup(triggerStore);
  const rateLimiter = new TriggerRateLimiter(10, 60_000);
  const engine = new TriggerEngine({
    triggers,
    dedup,
    rateLimiter,
    delegateTask: (team, task, priority) => {
      taskQueueStore.enqueue(team, task, priority ?? 'normal');
      return Promise.resolve();
    },
    logger: {
      info: (msg, meta) => logger.info(meta ?? {}, msg),
      warn: (msg, meta) => logger.warn(meta ?? {}, msg),
    },
  });
  engine.register();
  return engine;
}

export function initChannels(
  channelDeps: ChannelDeps | undefined,
  logger: pino.Logger,
): IChannelAdapter[] {
  if (!channelDeps) return [];
  const adapters: IChannelAdapter[] = [];

  // Load channels config
  let channelsConfig: ChannelsOutput | null = null;
  const channelsPath = join(channelDeps.dataDir, 'config', 'channels.yaml');
  if (existsSync(channelsPath)) {
    try { channelsConfig = loadChannels(channelsPath); }
    catch (err) { logger.warn({ err }, 'Failed to load channels.yaml'); }
  }

  // CLI adapter
  const cliEnabled = channelsConfig?.cli?.enabled ?? true;
  if (cliEnabled && !channelDeps.skipCli) {
    adapters.push(new CLIAdapter({
      input: channelDeps.cliInput,
      output: channelDeps.cliOutput,
    }));
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

  return adapters;
}

/** Scaffold the main team on first start. */
export function ensureMainTeam(runDir: string, orgTree: OrgTree): void {
  const mainDir = join(runDir, 'teams', 'main');
  const configPath = join(mainDir, 'config.yaml');

  const subdirs = ['memory', 'org-rules', 'team-rules', 'skills', 'subagents'];
  for (const sub of subdirs) {
    mkdirSync(join(mainDir, sub), { recursive: true });
  }

  if (!existsSync(configPath)) {
    const config = {
      name: 'main', description: 'Main orchestrator',
      allowed_tools: ['*'],
      mcp_servers: ['org'], provider_profile: 'default', maxTurns: 200,
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
