/**
 * Config loader implementing ConfigLoader interface.
 *
 * Responsibilities:
 * - Loads and parses YAML configuration files using the `yaml` library
 * - Three-layer priority chain: compiled defaults -> YAML files -> env var overlay (OPENHIVE_* prefix)
 * - Persists config changes back to YAML files
 * - Hot-reload via chokidar file watcher with 500ms debounce (CON-04)
 * - Team directory lifecycle (create, delete, list)
 *
 * Config files managed:
 * - data/openhive.yaml — master config (merged with compiled defaults)
 * - data/providers.yaml — global AI provider presets
 * - .run/workspace/teams/<slug>/team.yaml — per-team config
 */

import { readFile, writeFile, mkdir, rm, readdir, stat, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import * as YAML from 'yaml';
import { watch, type FSWatcher } from 'chokidar';

import type { ConfigLoader, Logger } from '../domain/index.js';
import type { MasterConfig } from './defaults.js';
import type { Provider, Team } from '../domain/index.js';
import type { TeamConfig } from './defaults.js';
import { defaultMasterConfig } from './defaults.js';
import { validateMasterConfig, validateProviders, validateTeam } from './validation.js';
import { validateSlug, RESERVED_SLUGS } from '../domain/domain.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ConfigLoaderOptions {
  dataDir?: string;
  runDir?: string;
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Deep Merge Utility
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursive deep merge. For each key in source:
 * - If both values are plain objects, recurse.
 * - If source value is array, replace (not merge).
 * - If source value is undefined, skip.
 * - Otherwise, source wins.
 */
export function deepMerge<T extends Record<string, unknown>>(target: T, source: Record<string, unknown>): T {
  const result = { ...target } as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    if (srcVal === undefined) continue;
    const tgtVal = result[key];
    if (isPlainObject(tgtVal) && isPlainObject(srcVal)) {
      result[key] = deepMerge(tgtVal as Record<string, unknown>, srcVal);
    } else {
      result[key] = srcVal;
    }
  }
  return result as T;
}

// ---------------------------------------------------------------------------
// Content Hash
// ---------------------------------------------------------------------------

function contentHash(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// ConfigLoaderImpl
// ---------------------------------------------------------------------------

export class ConfigLoaderImpl implements ConfigLoader {
  private readonly dataDir: string;
  private readonly runDir: string;
  private readonly logger?: Logger;
  private cachedMaster: MasterConfig | undefined;
  private watchers: FSWatcher[] = [];
  private debounceTimers: ReturnType<typeof setTimeout>[] = [];
  private hashes = new Map<string, string>();

  constructor(opts?: ConfigLoaderOptions) {
    this.dataDir = resolve(opts?.dataDir ?? process.env['OPENHIVE_DATA_DIR'] ?? 'data');
    this.runDir = resolve(opts?.runDir ?? process.env['OPENHIVE_RUN_DIR'] ?? '.run');
    this.logger = opts?.logger;
  }

  // -----------------------------------------------------------------------
  // Master config
  // -----------------------------------------------------------------------

  async loadMaster(): Promise<MasterConfig> {
    // Step 1: compiled defaults
    const defaults = defaultMasterConfig();

    // Step 2: read YAML file (optional)
    let yamlData: Record<string, unknown> = {};
    const yamlPath = join(this.dataDir, 'openhive.yaml');
    try {
      const raw = await readFile(yamlPath, 'utf-8');
      const parsed: unknown = YAML.parse(raw);
      if (isPlainObject(parsed)) {
        yamlData = parsed;
      }
    } catch (err: unknown) {
      // File missing is fine — use defaults only
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    // Step 3: deep merge
    let merged = deepMerge(defaults as unknown as Record<string, unknown>, yamlData) as unknown as MasterConfig;

    // Step 4: env var overlay
    merged = this.applyEnvOverlay(merged);

    // Step 5: validate
    const validated = validateMasterConfig(merged);

    // Step 6: cache
    this.cachedMaster = validated;
    return validated;
  }

  async saveMaster(config: MasterConfig): Promise<void> {
    validateMasterConfig(config);
    const defaults = defaultMasterConfig();
    const diff = this.diffConfig(
      defaults as unknown as Record<string, unknown>,
      config as unknown as Record<string, unknown>,
    );
    const yamlStr = YAML.stringify(diff);
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(join(this.dataDir, 'openhive.yaml'), yamlStr, 'utf-8');
    this.cachedMaster = config;
  }

  getMaster(): MasterConfig {
    if (!this.cachedMaster) {
      throw new Error('ConfigLoader: loadMaster() must be called before getMaster()');
    }
    return this.cachedMaster;
  }

  // -----------------------------------------------------------------------
  // Providers
  // -----------------------------------------------------------------------

  async loadProviders(): Promise<Record<string, Provider>> {
    const yamlPath = join(this.dataDir, 'providers.yaml');
    const raw = await readFile(yamlPath, 'utf-8');
    const parsed: unknown = YAML.parse(raw);
    const validated = validateProviders(parsed);
    // Map to Provider objects (add name from key)
    const result: Record<string, Provider> = {};
    for (const [key, value] of Object.entries(validated)) {
      const entry = value as Record<string, unknown>;
      result[key] = {
        name: key,
        type: entry['type'] as Provider['type'],
        ...(entry['base_url'] !== undefined ? { base_url: entry['base_url'] as string } : {}),
        ...(entry['api_key'] !== undefined ? { api_key: entry['api_key'] as string } : {}),
        ...(entry['oauth_token'] !== undefined ? { oauth_token: entry['oauth_token'] as string } : {}),
        ...(entry['models'] !== undefined ? { models: entry['models'] as Record<string, string> } : {}),
      };
    }
    return result;
  }

  async saveProviders(providers: Record<string, Provider>): Promise<void> {
    // Strip name field (it's the map key, not persisted in YAML)
    const toWrite: Record<string, Record<string, unknown>> = {};
    for (const [key, provider] of Object.entries(providers)) {
      const { name: _name, ...rest } = provider;
      toWrite[key] = rest;
    }
    validateProviders(toWrite);
    const yamlStr = YAML.stringify(toWrite);
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(join(this.dataDir, 'providers.yaml'), yamlStr, 'utf-8');
  }

  // -----------------------------------------------------------------------
  // Team config
  // -----------------------------------------------------------------------

  async loadTeam(workspacePath: string): Promise<Team> {
    const yamlPath = join(workspacePath, 'team.yaml');
    const raw = await readFile(yamlPath, 'utf-8');
    const parsed: unknown = YAML.parse(raw);
    const validated = validateTeam(parsed);
    return this.teamConfigToTeam(validated, workspacePath);
  }

  async saveTeam(workspacePath: string, team: Team): Promise<void> {
    const teamConfig = this.teamToTeamConfig(team);
    validateTeam(teamConfig);
    const yamlStr = YAML.stringify(teamConfig);
    await writeFile(join(workspacePath, 'team.yaml'), yamlStr, 'utf-8');
  }

  // -----------------------------------------------------------------------
  // Team directory lifecycle
  // -----------------------------------------------------------------------

  async createTeamDir(slug: string): Promise<void> {
    validateSlug(slug);
    if (RESERVED_SLUGS.has(slug)) {
      throw new Error(`Reserved slug: "${slug}"`);
    }

    const teamPath = join(this.runDir, 'workspace', 'teams', slug);

    // Check if already exists
    try {
      await access(teamPath);
      throw new Error(`Team directory already exists: ${teamPath}`);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    // Scaffold directory tree
    await mkdir(join(teamPath, '.claude', 'agents'), { recursive: true });
    await mkdir(join(teamPath, '.claude', 'skills'), { recursive: true });
    await mkdir(join(teamPath, 'memory'), { recursive: true });
    await mkdir(join(teamPath, 'work'), { recursive: true });
    await mkdir(join(teamPath, 'integrations'), { recursive: true });
    await mkdir(join(teamPath, 'teams'), { recursive: true });

    // Write default settings.json
    await writeFile(
      join(teamPath, '.claude', 'settings.json'),
      JSON.stringify({ allowedTools: [] }, null, 2),
      'utf-8',
    );
  }

  async deleteTeamDir(slug: string): Promise<void> {
    const teamPath = join(this.runDir, 'workspace', 'teams', slug);

    // Validate path is within expected workspace root
    const resolved = resolve(teamPath);
    const expectedRoot = resolve(join(this.runDir, 'workspace', 'teams'));
    if (!resolved.startsWith(expectedRoot)) {
      throw new Error(`Path traversal detected: ${teamPath}`);
    }

    await rm(teamPath, { recursive: true, force: false });
  }

  async listTeams(): Promise<string[]> {
    const teamsDir = join(this.runDir, 'workspace', 'teams');
    let entries: string[];
    try {
      entries = await readdir(teamsDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const result: string[] = [];
    for (const entry of entries) {
      const entryPath = join(teamsDir, entry);
      try {
        const info = await stat(entryPath);
        if (!info.isDirectory()) continue;
        // Check for team.yaml
        await access(join(entryPath, 'team.yaml'));
        result.push(entry);
      } catch {
        // Not a valid team dir
      }
    }
    return result.sort();
  }

  // -----------------------------------------------------------------------
  // File watching
  // -----------------------------------------------------------------------

  watchMaster(callback: (cfg: MasterConfig) => void): void {
    const filePath = join(this.dataDir, 'openhive.yaml');
    this.watchFile(filePath, async () => {
      try {
        const config = await this.loadMaster();
        callback(config);
      } catch (err) {
        this.logger?.warn('Failed to reload master config', { error: String(err) });
      }
    });
  }

  watchProviders(callback: (providers: Record<string, Provider>) => void): void {
    const filePath = join(this.dataDir, 'providers.yaml');
    this.watchFile(filePath, async () => {
      try {
        const providers = await this.loadProviders();
        callback(providers);
      } catch (err) {
        this.logger?.warn('Failed to reload providers config', { error: String(err) });
      }
    });
  }

  watchTeam(workspacePath: string, callback: (team: Team) => void): void {
    const filePath = join(workspacePath, 'team.yaml');
    this.watchFile(filePath, async () => {
      try {
        const team = await this.loadTeam(workspacePath);
        callback(team);
      } catch (err) {
        this.logger?.warn('Failed to reload team config', { error: String(err) });
      }
    });
  }

  stopWatching(): void {
    for (const timer of this.debounceTimers) {
      clearTimeout(timer);
    }
    this.debounceTimers = [];
    for (const watcher of this.watchers) {
      void watcher.close();
    }
    this.watchers = [];
    this.hashes.clear();
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private applyEnvOverlay(config: MasterConfig): MasterConfig {
    const result = { ...config, server: { ...config.server } };
    const logLevel = process.env['OPENHIVE_LOG_LEVEL'];
    if (logLevel !== undefined) {
      result.server.log_level = logLevel;
    }
    const listenAddr = process.env['OPENHIVE_SYSTEM_LISTEN_ADDRESS'];
    if (listenAddr !== undefined) {
      result.server.listen_address = listenAddr;
    }
    const dataDir = process.env['OPENHIVE_DATA_DIR'];
    if (dataDir !== undefined) {
      result.server.data_dir = dataDir;
    }
    return result;
  }

  /**
   * Computes the diff between defaults and current config.
   * Returns only fields that differ from defaults.
   */
  private diffConfig(defaults: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(current)) {
      const defVal = defaults[key];
      const curVal = current[key];
      if (isPlainObject(defVal) && isPlainObject(curVal)) {
        const nested = this.diffConfig(defVal, curVal);
        if (Object.keys(nested).length > 0) {
          result[key] = nested;
        }
      } else if (JSON.stringify(defVal) !== JSON.stringify(curVal)) {
        result[key] = curVal;
      }
    }
    return result;
  }

  private watchFile(filePath: string, onChange: () => Promise<void>): void {
    const watcher = watch(filePath, {
      persistent: true,
      ignoreInitial: true,
    });

    let timer: ReturnType<typeof setTimeout> | undefined;

    watcher.on('change', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        // Content-hash check
        try {
          const raw = await readFile(filePath, 'utf-8');
          const hash = contentHash(raw);
          const prevHash = this.hashes.get(filePath);
          if (prevHash === hash) return; // No-op: content unchanged
          this.hashes.set(filePath, hash);
          await onChange();
        } catch {
          // File may have been deleted
        }
      }, 500); // CON-04: 500ms debounce

      if (timer) this.debounceTimers.push(timer);
    });

    this.watchers.push(watcher);
  }

  private teamConfigToTeam(config: TeamConfig, workspacePath: string): Team {
    return {
      tid: config.tid ?? '',
      slug: config.slug,
      leader_aid: config.leader_aid,
      parent_tid: config.parent_slug ?? '',
      depth: 0,
      container_id: '',
      health: 'unknown',
      agent_aids: (config.agents ?? []).map((a) => a.aid),
      workspace_path: workspacePath,
      created_at: Date.now(),
    };
  }

  private teamToTeamConfig(team: Team): TeamConfig {
    return {
      slug: team.slug,
      leader_aid: team.leader_aid,
      ...(team.tid ? { tid: team.tid } : {}),
      ...(team.parent_tid ? { parent_slug: team.parent_tid } : {}),
    };
  }

  // -----------------------------------------------------------------------
  // Config with sources (full implementation — step 16)
  // -----------------------------------------------------------------------

  /**
   * Returns the resolved config annotated with provenance information.
   *
   * Each leaf field is annotated with its source:
   * - 'env'     — value comes from an OPENHIVE_* environment variable
   * - 'yaml'    — key is explicitly present in data/openhive.yaml (even if equal to default)
   * - 'default' — value comes from compiled defaults only
   *
   * Secret fields (matching /key|token|secret|password|oauth/i) have their
   * value replaced with '********' and carry isSecret: true.
   *
   * The returned Record uses dot-separated key paths (e.g. "limits.max_depth").
   */
  async getConfigWithSources(): Promise<Record<string, { value: unknown; source: 'default' | 'yaml' | 'env'; isSecret?: boolean }>> {
    const config = this.cachedMaster ?? (await this.loadMaster());

    // Read raw YAML object so we can check which keys are explicitly present,
    // even when the YAML value equals the compiled default.
    let rawYaml: Record<string, unknown> = {};
    const yamlPath = join(this.dataDir, 'openhive.yaml');
    try {
      const raw = await readFile(yamlPath, 'utf-8');
      const parsed: unknown = YAML.parse(raw);
      if (isPlainObject(parsed)) {
        rawYaml = parsed;
      }
    } catch (err: unknown) {
      // File missing is fine — rawYaml stays empty (all fields from defaults)
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    // Env-var mappings: env var name -> dot-path in MasterConfig
    const envMappings: Record<string, string> = {
      'OPENHIVE_LOG_LEVEL': 'server.log_level',
      'OPENHIVE_SYSTEM_LISTEN_ADDRESS': 'server.listen_address',
      'OPENHIVE_DATA_DIR': 'server.data_dir',
    };
    // Invert to get path -> source mapping for env-overridden fields
    const envPaths = new Set<string>();
    for (const [envVar, dotPath] of Object.entries(envMappings)) {
      if (process.env[envVar] !== undefined) {
        envPaths.add(dotPath);
      }
    }

    const result: Record<string, { value: unknown; source: 'default' | 'yaml' | 'env'; isSecret?: boolean }> = {};
    this.flattenWithSources(config as unknown as Record<string, unknown>, '', result, rawYaml, envPaths);
    return result;
  }

  /** Regex for identifying secret fields by key name. */
  private static readonly SECRET_PATTERN = /key|token|secret|password|oauth/i;

  /**
   * Recursively flattens a config object into dot-separated key paths,
   * determining provenance (env > yaml > default) for each leaf field.
   *
   * @param obj        - The resolved config object subtree
   * @param prefix     - Dot-separated path prefix for this subtree
   * @param result     - Accumulator written in-place
   * @param rawYaml    - Raw parsed YAML object (NOT merged) — used for key-path existence check
   * @param envPaths   - Set of dot-paths whose values came from env vars
   */
  private flattenWithSources(
    obj: Record<string, unknown>,
    prefix: string,
    result: Record<string, { value: unknown; source: 'default' | 'yaml' | 'env'; isSecret?: boolean }>,
    rawYaml: Record<string, unknown>,
    envPaths: Set<string>,
  ): void {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      // Navigate rawYaml to the same depth as this key
      const rawYamlChild = isPlainObject(rawYaml[key]) ? rawYaml[key] as Record<string, unknown> : {};

      if (isPlainObject(value)) {
        this.flattenWithSources(value, path, result, rawYamlChild, envPaths);
      } else {
        // Determine source
        let source: 'default' | 'yaml' | 'env';
        if (envPaths.has(path)) {
          source = 'env';
        } else if (key in rawYaml) {
          // Key explicitly present in the raw YAML object at this level
          source = 'yaml';
        } else {
          source = 'default';
        }

        // Determine if this field is a secret
        const isSecret = ConfigLoaderImpl.SECRET_PATTERN.test(key);
        const displayValue = isSecret ? '********' : value;

        if (isSecret) {
          result[path] = { value: displayValue, source, isSecret: true };
        } else {
          result[path] = { value: displayValue, source };
        }
      }
    }
  }
}
