/**
 * OpenHive Backend - ConfigLoader
 *
 * The main config management class that coordinates file I/O, file watching,
 * and channel token encryption.
 *
 * Responsibilities:
 *   - Load/save openhive.yaml (master config)
 *   - Auto-encrypt plaintext channel tokens when a KeyManager is available
 *   - Warn about plaintext tokens when KeyManager is locked
 *   - Load/save providers.yaml
 *   - Load/save per-team team.yaml files
 *   - Create and delete team directory structures
 *   - List team slugs from the filesystem
 *   - Watch config files for live-reload via FileWatcher
 *   - Decrypt enc:-prefixed channel tokens for runtime use
 */

import { readdirSync, rmSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

import type { MasterConfig, Provider, Team, ChannelsConfig } from '../domain/types.js';
import type { ConfigLoader, KeyManager } from '../domain/interfaces.js';
import { validateSlug } from '../domain/validation.js';
import { loadMasterFromFile, saveMasterToFile } from './master.js';
import { loadProvidersFromFile, saveProvidersToFile } from './providers.js';
import { validateTeamPath, loadTeamFromFile, saveTeamToFile, createTeamDirectory } from './team.js';
import { validateMasterConfig } from './validation.js';
import { FileWatcher } from './watcher.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENC_TOKEN_PREFIX = 'enc:';
const DEFAULT_DEBOUNCE_MS = 200;

// ---------------------------------------------------------------------------
// ConfigLoaderImpl
// ---------------------------------------------------------------------------

/**
 * Implements the ConfigLoader interface. Coordinates config file I/O,
 * file watching, and channel token encryption.
 *
 * Constructor parameters:
 *   - dataDir:  path to the global config directory (openhive.yaml, providers.yaml)
 *   - teamsDir: path to the workspace root containing teams/ subdirectory
 *               (e.g. .run/workspace/). Defaults to dataDir if not provided.
 */
export class ConfigLoaderImpl implements ConfigLoader {
  private readonly dataDir: string;
  private readonly teamsDir: string;
  private masterCfg: MasterConfig | null = null;
  private watcher: FileWatcher | null = null;
  private keyManager: KeyManager | null = null;

  constructor(dataDir: string = 'data', teamsDir: string = '') {
    this.dataDir = dataDir !== '' ? dataDir : 'data';
    this.teamsDir = teamsDir !== '' ? teamsDir : this.dataDir;
  }

  // -------------------------------------------------------------------------
  // setKeyManager
  // -------------------------------------------------------------------------

  /**
   * Attaches a KeyManager for auto-encryption of channel tokens.
   * Must be called before loadMaster() for auto-encryption to take effect.
   */
  setKeyManager(km: KeyManager): void {
    this.keyManager = km;
  }

  // -------------------------------------------------------------------------
  // loadMaster
  // -------------------------------------------------------------------------

  /**
   * Reads and parses openhive.yaml from dataDir.
   *
   * If a KeyManager is set and unlocked, plaintext channel tokens are encrypted
   * and the file is written back to disk automatically.
   *
   * If a KeyManager is set but locked, a warning is logged for each plaintext
   * token (tokens remain functional, just unencrypted at rest).
   *
   * Updates the internal cache on success.
   */
  async loadMaster(): Promise<MasterConfig> {
    const path = join(this.dataDir, 'openhive.yaml');
    const cfg = loadMasterFromFile(path);

    if (this.keyManager !== null && !this.keyManager.isLocked()) {
      // KeyManager is unlocked — auto-encrypt any plaintext tokens.
      let changed = false;

      if (
        cfg.channels.discord.token !== undefined &&
        cfg.channels.discord.token !== '' &&
        !cfg.channels.discord.token.startsWith(ENC_TOKEN_PREFIX)
      ) {
        try {
          const encrypted = await this.keyManager.encrypt(cfg.channels.discord.token);
          cfg.channels.discord.token = encrypted;
          changed = true;
        } catch (err) {
          // Log warning but do not fail — token remains plaintext.
          console.warn('failed to encrypt discord token:', err instanceof Error ? err.message : String(err));
        }
      }

      if (
        cfg.channels.whatsapp.token !== undefined &&
        cfg.channels.whatsapp.token !== '' &&
        !cfg.channels.whatsapp.token.startsWith(ENC_TOKEN_PREFIX)
      ) {
        try {
          const encrypted = await this.keyManager.encrypt(cfg.channels.whatsapp.token);
          cfg.channels.whatsapp.token = encrypted;
          changed = true;
        } catch (err) {
          console.warn('failed to encrypt whatsapp token:', err instanceof Error ? err.message : String(err));
        }
      }

      if (changed) {
        try {
          saveMasterToFile(path, cfg);
        } catch (err) {
          // Non-fatal — encryption succeeded but persistence failed.
          console.warn('failed to persist encrypted tokens:', err instanceof Error ? err.message : String(err));
        }
      }
    } else if (this.keyManager !== null && this.keyManager.isLocked()) {
      // KeyManager present but locked: warn about any plaintext tokens.
      if (
        cfg.channels.discord.token !== undefined &&
        cfg.channels.discord.token !== '' &&
        !cfg.channels.discord.token.startsWith(ENC_TOKEN_PREFIX)
      ) {
        console.warn(
          'STARTUP WARNING: discord channel token is stored in plaintext; ' +
          'unlock the key manager to encrypt it at rest',
          { channel: 'discord', action_required: 'POST /api/v1/auth/unlock' },
        );
      }

      if (
        cfg.channels.whatsapp.token !== undefined &&
        cfg.channels.whatsapp.token !== '' &&
        !cfg.channels.whatsapp.token.startsWith(ENC_TOKEN_PREFIX)
      ) {
        console.warn(
          'STARTUP WARNING: whatsapp channel token is stored in plaintext; ' +
          'unlock the key manager to encrypt it at rest',
          { channel: 'whatsapp', action_required: 'POST /api/v1/auth/unlock' },
        );
      }
    }

    this.masterCfg = cfg;
    return cfg;
  }

  // -------------------------------------------------------------------------
  // saveMaster
  // -------------------------------------------------------------------------

  /**
   * Validates and writes the master config to openhive.yaml atomically.
   * Updates the internal cache on success.
   *
   * Throws ValidationError if the config is invalid.
   * Throws Error if the file cannot be written.
   */
  async saveMaster(cfg: MasterConfig): Promise<void> {
    validateMasterConfig(cfg);

    const path = join(this.dataDir, 'openhive.yaml');
    saveMasterToFile(path, cfg);

    this.masterCfg = cfg;
  }

  // -------------------------------------------------------------------------
  // getMaster
  // -------------------------------------------------------------------------

  /**
   * Returns the currently cached master config.
   *
   * Throws Error if loadMaster() has not been called yet.
   */
  getMaster(): MasterConfig {
    if (this.masterCfg === null) {
      throw new Error('master config not loaded; call loadMaster() first');
    }
    return this.masterCfg;
  }

  // -------------------------------------------------------------------------
  // loadProviders
  // -------------------------------------------------------------------------

  /**
   * Reads and parses providers.yaml from dataDir.
   *
   * Throws Error if the file cannot be read or parsed.
   * Throws ValidationError if the providers map is empty or any entry is invalid.
   */
  async loadProviders(): Promise<Record<string, Provider>> {
    const path = join(this.dataDir, 'providers.yaml');
    return loadProvidersFromFile(path);
  }

  // -------------------------------------------------------------------------
  // saveProviders
  // -------------------------------------------------------------------------

  /**
   * Writes providers.yaml to dataDir atomically.
   *
   * Throws Error if the file cannot be written.
   */
  async saveProviders(providers: Record<string, Provider>): Promise<void> {
    const path = join(this.dataDir, 'providers.yaml');
    saveProvidersToFile(path, providers);
  }

  // -------------------------------------------------------------------------
  // loadTeam
  // -------------------------------------------------------------------------

  /**
   * Reads and parses <teamsDir>/teams/<slug>/team.yaml.
   *
   * Validates the path via validateTeamPath before reading.
   *
   * Throws ValidationError if the slug is invalid or the path fails security checks.
   * Throws Error if the file cannot be read or parsed.
   */
  async loadTeam(slug: string): Promise<Team> {
    const teamDir = validateTeamPath(this.teamsDir, slug);
    const path = join(teamDir, 'team.yaml');
    return loadTeamFromFile(path, slug);
  }

  // -------------------------------------------------------------------------
  // saveTeam
  // -------------------------------------------------------------------------

  /**
   * Writes <teamsDir>/teams/<slug>/team.yaml atomically.
   *
   * Validates the path via validateTeamPath before writing.
   *
   * Throws ValidationError if the slug is invalid or the path fails security checks.
   * Throws Error if the file cannot be written.
   */
  async saveTeam(slug: string, team: Team): Promise<void> {
    const teamDir = validateTeamPath(this.teamsDir, slug);
    const path = join(teamDir, 'team.yaml');
    saveTeamToFile(path, team);
  }

  // -------------------------------------------------------------------------
  // createTeamDir
  // -------------------------------------------------------------------------

  /**
   * Creates the team directory and minimal team.yaml under teamsDir
   * (the workspace root).
   *
   * Delegates to createTeamDirectory which creates:
   *   <teamsDir>/teams/<slug>/
   *   <teamsDir>/teams/<slug>/team.yaml  (minimal, if absent)
   *
   * Workspace files (CLAUDE.md, .claude/agents/, .claude/skills/) are
   * created separately by scaffoldTeamWorkspace().
   */
  async createTeamDir(slug: string): Promise<void> {
    createTeamDirectory(this.teamsDir, slug);
  }

  // -------------------------------------------------------------------------
  // deleteTeamDir
  // -------------------------------------------------------------------------

  /**
   * Removes the team directory at <teamsDir>/teams/<slug>.
   *
   * Validates the path via validateTeamPath before deleting to prevent
   * directory traversal attacks.
   *
   * Throws ValidationError if the slug is invalid or the path fails security checks.
   * Throws Error if the directory cannot be removed.
   */
  async deleteTeamDir(slug: string): Promise<void> {
    const teamDir = validateTeamPath(this.teamsDir, slug);
    try {
      rmSync(teamDir, { recursive: true, force: true });
    } catch (err) {
      throw new Error(
        `failed to remove team directory ${teamDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // listTeams
  // -------------------------------------------------------------------------

  /**
   * Returns all team slugs found in <teamsDir>/teams/.
   *
   * Filters entries to only include:
   *   - directories (not files or symlinks)
   *   - slugs that pass validateSlug
   *   - slugs that have a team.yaml file present
   *
   * Returns an empty array if the teams/ directory does not exist.
   */
  async listTeams(): Promise<string[]> {
    const teamsDir = join(this.teamsDir, 'teams');

    let entryNames: string[];
    try {
      // Read as plain strings (not Dirent) to avoid Buffer vs string type confusion
      // in different @types/node versions.
      entryNames = readdirSync(teamsDir, { encoding: 'utf8' });
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        return [];
      }
      throw new Error(
        `failed to list teams: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const slugs: string[] = [];

    for (const name of entryNames) {
      // Only consider valid slugs — filters out entries with invalid names
      // (e.g. uppercase, path traversal, etc.).
      try {
        validateSlug(name);
      } catch {
        continue;
      }

      // Verify it is a directory (not a file or symlink at the top level).
      const entryPath = join(teamsDir, name);
      try {
        const stat = lstatSync(entryPath);
        if (!stat.isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }

      // Only include slugs that have a team.yaml file present.
      const teamFile = join(teamsDir, name, 'team.yaml');
      try {
        lstatSync(teamFile);
        slugs.push(name);
      } catch {
        // No team.yaml — skip this entry.
      }
    }

    return slugs;
  }

  // -------------------------------------------------------------------------
  // watchMaster
  // -------------------------------------------------------------------------

  /**
   * Watches openhive.yaml for changes and calls the callback (debounced 200ms)
   * with the reloaded config. Also updates the internal cache on reload.
   *
   * Creates a FileWatcher if one does not already exist.
   */
  async watchMaster(callback: (cfg: MasterConfig) => void): Promise<void> {
    this.ensureWatcher();

    const path = join(this.dataDir, 'openhive.yaml');
    this.watcher!.watch(path, () => {
      let cfg: MasterConfig;
      try {
        cfg = loadMasterFromFile(path);
      } catch (err) {
        console.error('failed to reload master config:', err instanceof Error ? err.message : String(err));
        return;
      }
      this.masterCfg = cfg;
      callback(cfg);
    });
  }

  // -------------------------------------------------------------------------
  // watchProviders
  // -------------------------------------------------------------------------

  /**
   * Watches providers.yaml for changes and calls the callback (debounced 200ms)
   * with the reloaded providers map.
   *
   * Creates a FileWatcher if one does not already exist.
   */
  async watchProviders(callback: (providers: Record<string, Provider>) => void): Promise<void> {
    this.ensureWatcher();

    const path = join(this.dataDir, 'providers.yaml');
    this.watcher!.watch(path, () => {
      let providers: Record<string, Provider>;
      try {
        providers = loadProvidersFromFile(path);
      } catch (err) {
        console.error('failed to reload providers config:', err instanceof Error ? err.message : String(err));
        return;
      }
      callback(providers);
    });
  }

  // -------------------------------------------------------------------------
  // watchTeam
  // -------------------------------------------------------------------------

  /**
   * Watches <teamsDir>/teams/<slug>/team.yaml for changes and calls the
   * callback (debounced 200ms) with the reloaded team config.
   *
   * Creates a FileWatcher if one does not already exist.
   */
  async watchTeam(slug: string, callback: (team: Team) => void): Promise<void> {
    this.ensureWatcher();

    const path = join(this.teamsDir, 'teams', slug, 'team.yaml');
    this.watcher!.watch(path, () => {
      let team: Team;
      try {
        team = loadTeamFromFile(path, slug);
      } catch (err) {
        console.error(
          `failed to reload team config for slug "${slug}":`,
          err instanceof Error ? err.message : String(err),
        );
        return;
      }
      callback(team);
    });
  }

  // -------------------------------------------------------------------------
  // stopWatching
  // -------------------------------------------------------------------------

  /**
   * Stops all file watchers and cancels pending debounce timers.
   */
  stopWatching(): void {
    if (this.watcher !== null) {
      // stop() is async (chokidar close). Fire-and-forget — we don't await
      // here because the interface declares stopWatching() as void. Callers who need clean shutdown
      // should await stopWatchingAsync() if added in the future.
      void this.watcher.stop();
      this.watcher = null;
    }
  }

  // -------------------------------------------------------------------------
  // decryptChannelTokens
  // -------------------------------------------------------------------------

  /**
   * Returns a copy of ChannelsConfig with all enc:-prefixed tokens decrypted
   * for runtime use.
   *
   * If the KeyManager is null or locked, tokens are returned as-is. Callers
   * must not use enc:-prefixed values as real credentials.
   *
   * Throws Error if decryption fails for any token.
   */
  async decryptChannelTokens(channels: ChannelsConfig): Promise<ChannelsConfig> {
    // Deep copy the channels config to avoid mutating the original.
    const result: ChannelsConfig = {
      discord: { ...channels.discord },
      whatsapp: { ...channels.whatsapp },
    };

    if (this.keyManager === null || this.keyManager.isLocked()) {
      return result;
    }

    if (
      result.discord.token !== undefined &&
      result.discord.token.startsWith(ENC_TOKEN_PREFIX)
    ) {
      try {
        result.discord.token = await this.keyManager.decrypt(result.discord.token);
      } catch (err) {
        throw new Error(
          `failed to decrypt discord token: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (
      result.whatsapp.token !== undefined &&
      result.whatsapp.token.startsWith(ENC_TOKEN_PREFIX)
    ) {
      try {
        result.whatsapp.token = await this.keyManager.decrypt(result.whatsapp.token);
      } catch (err) {
        throw new Error(
          `failed to decrypt whatsapp token: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Ensures a FileWatcher instance exists, creating one if needed.
   */
  private ensureWatcher(): void {
    if (this.watcher === null) {
      this.watcher = new FileWatcher(DEFAULT_DEBOUNCE_MS);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a new ConfigLoaderImpl instance.
 *
 *   - dataDir:  global config files (openhive.yaml, providers.yaml).
 *               Defaults to "data" if empty.
 *   - teamsDir: workspace root containing teams/ (e.g. .run/workspace/).
 *              Defaults to dataDir if empty.
 */
export function newConfigLoader(dataDir: string = 'data', teamsDir: string = ''): ConfigLoaderImpl {
  return new ConfigLoaderImpl(dataDir, teamsDir);
}
