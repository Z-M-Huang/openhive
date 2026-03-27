/**
 * Bootstrap helper functions — extracted from index.ts for size limit.
 */

import { existsSync, mkdirSync, cpSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as yamlStringify } from 'yaml';
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
import { TriggerDedup } from './triggers/dedup.js';
import { TriggerRateLimiter } from './triggers/rate-limiter.js';
import { TriggerEngine } from './triggers/engine.js';
import { CLIAdapter } from './channels/cli-adapter.js';
import { DiscordAdapter } from './channels/discord-adapter.js';
import { SecretString } from './secrets/secret-string.js';
import type { IChannelAdapter } from './domain/interfaces.js';
// TriggerConfig import removed — trigger configs now managed via SQLite/TriggerConfigStore
import type { ChannelsOutput } from './config/validation.js';
import type { Readable, Writable } from 'node:stream';
import type { DatabaseInstance } from './storage/database.js';
import type { OrgTree } from './domain/org-tree.js';
import { TeamStatus } from './domain/types.js';
import type { AppLogger } from './logging/logger.js';

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
  readonly triggerConfigStore: TriggerConfigStore;
  readonly interactionStore: InteractionStore;
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
  const triggerConfigStore = new TriggerConfigStore(db);
  const interactionStore = new InteractionStore(db);

  return { db, raw, orgStore, taskQueueStore, triggerStore, logStore, escalationStore, memoryStore, triggerConfigStore, interactionStore };
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
    delegateTask: (team, task, priority, triggerName) => {
      // Unique correlationId per task: trigger:{name}:{timestamp}
      const correlationId = triggerName ? `trigger:${triggerName}:${Date.now()}` : undefined;
      // Snapshot max_turns from trigger config
      let options: string | undefined;
      if (triggerName) {
        const entry = triggerConfigStore.get(team, triggerName);
        if (entry?.maxTurns) options = JSON.stringify({ max_turns: entry.maxTurns });
      }
      taskQueueStore.enqueue(team, task, priority ?? 'normal', correlationId, options);
      return Promise.resolve();
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
): IChannelAdapter[] {
  if (!channelDeps) return [];
  const adapters: IChannelAdapter[] = [];

  // Load channels config
  let channelsConfig: ChannelsOutput | null = null;
  const channelsPath = join(channelDeps.dataDir, 'config', 'channels.yaml');
  if (existsSync(channelsPath)) {
    try { channelsConfig = loadChannels(channelsPath); }
    catch (err) { logger.warn('Failed to load channels.yaml', { err }); }
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

  // Seed memory/MEMORY.md if it doesn't exist
  const memoryPath = join(mainDir, 'memory', 'MEMORY.md');
  if (!existsSync(memoryPath)) {
    writeFileSync(memoryPath, '# Main Team Memory\n\n(No entries yet)\n', 'utf-8');
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
