/**
 * Bootstrap helper functions — extracted from index.ts for size limit.
 */

import { existsSync, mkdirSync, cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    delegateTask: (team, task, priority, triggerName, sourceChannelId) => {
      // Unique correlationId per task: trigger:{name}:{timestamp}
      const correlationId = triggerName ? `trigger:${triggerName}:${Date.now()}` : undefined;
      // Snapshot max_turns from trigger config
      let options: import('./domain/types.js').TaskOptions | undefined;
      if (triggerName) {
        const entry = triggerConfigStore.get(team, triggerName);
        if (entry?.maxTurns) options = { maxTurns: entry.maxTurns };
      }
      taskQueueStore.enqueue(team, task, (priority ?? 'normal') as import('./domain/types.js').TaskPriority, 'trigger', sourceChannelId, correlationId, options);
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

/**
 * Migrate legacy `mcp__org__*` patterns in allowed_tools to bare tool names.
 *
 * Scans all team config files under `{runDir}/teams/` and rewrites any
 * `allowed_tools` entries that use the `mcp__org__` prefix (which referred to
 * the now-removed org MCP transport) to bare names.
 *
 * Examples:
 *   - `mcp__org__spawn_team` → `spawn_team`
 *   - `mcp__org__*` → `*`
 *
 * External MCP patterns like `mcp__loggly-mcp__*` are left untouched.
 */
export function migrateAllowedTools(runDir: string): void {
  const teamsDir = join(runDir, 'teams');
  if (!existsSync(teamsDir)) return;

  let teamDirs: string[];
  try {
    teamDirs = readdirSync(teamsDir);
  } catch {
    return;
  }

  for (const teamName of teamDirs) {
    const configPath = join(teamsDir, teamName, 'config.yaml');
    if (!existsSync(configPath)) continue;

    let raw: string;
    try {
      raw = readFileSync(configPath, 'utf-8');
    } catch {
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = yamlParse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }

    const allowedTools = parsed['allowed_tools'];
    if (!Array.isArray(allowedTools)) continue;

    let changed = false;
    const migrated = allowedTools.map((tool: unknown) => {
      if (typeof tool !== 'string') return tool;
      if (!tool.startsWith('mcp__org__')) return tool;
      changed = true;
      // mcp__org__* (glob) → * (all tools)
      if (tool === 'mcp__org__*') return '*';
      // mcp__org__spawn_team → spawn_team
      return tool.slice('mcp__org__'.length);
    });

    if (!changed) continue;

    // Deduplicate (e.g. if both '*' and 'mcp__org__*' existed)
    const deduped = [...new Set(migrated as string[])];
    parsed['allowed_tools'] = deduped;

    // Also strip 'org' from mcp_servers if present
    const mcpServers = parsed['mcp_servers'];
    if (Array.isArray(mcpServers)) {
      const filtered = mcpServers.filter((s: unknown) => s !== 'org');
      if (filtered.length !== mcpServers.length) {
        parsed['mcp_servers'] = filtered;
      }
    }

    try {
      writeFileSync(configPath, yamlStringify(parsed), 'utf-8');
    } catch {
      // Best effort — don't crash on write failure
    }
  }
}

export async function initBrowserRelay(
  logger: AppLogger,
): Promise<import('./sessions/tools/browser-proxy.js').BrowserRelay | undefined> {
  try {
    const { createBrowserRelay } = await import('./sessions/tools/browser-proxy.js');
    const relay = await createBrowserRelay({ logger });
    logger.info('Browser relay initialized', { tools: relay.getToolNames().length });
    return relay;
  } catch (err) {
    const msg = errorMessage(err);
    const isModuleError = msg.includes('Cannot find module') || msg.includes('MODULE_NOT_FOUND');
    const logMsg = isModuleError
      ? 'Browser relay failed to initialize — @playwright/mcp not found, please update to the latest OpenHive version'
      : `Browser relay failed to initialize: ${msg}`;
    logger.error(logMsg, { error: msg });
    return undefined;
  }
}
