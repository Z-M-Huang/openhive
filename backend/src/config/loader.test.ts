/**
 * Tests for backend/src/config/loader.ts
 *
 * Covers the ConfigLoaderImpl class: loadMaster, saveMaster, getMaster,
 * loadProviders, loadTeam, listTeams, watchMaster, decryptChannelTokens,
 * and stopWatching.
 *
 * Strategy:
 *   - Real temp directories for file I/O tests (no mocking of fs).
 *   - Fake KeyManager objects for encryption/decryption tests.
 *   - vi.spyOn(console, 'warn') to assert startup warnings.
 *   - Real file writes + vitest real timers for the watcher test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';

import { ConfigLoaderImpl, newConfigLoader } from './loader.js';
import type { KeyManager } from '../domain/interfaces.js';
import type { MasterConfig, ChannelsConfig } from '../domain/types.js';
import { defaultMasterConfig } from './defaults.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a temp directory and returns path + cleanup function. */
function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'openhive-loader-test-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Writes a valid openhive.yaml file to dir.
 * Accepts partial overrides merged onto the compiled defaults.
 */
function writeOpenhiveYaml(dir: string, overrides: Partial<MasterConfig> = {}): string {
  const cfg: MasterConfig = {
    ...defaultMasterConfig(),
    ...overrides,
  };
  const path = join(dir, 'openhive.yaml');
  writeFileSync(path, stringifyYaml(cfg), 'utf8');
  return path;
}

/** Writes a minimal valid providers.yaml to dir. */
function writeProvidersYaml(dir: string): string {
  const content = `providers:\n  default:\n    name: default\n    type: oauth\n    oauth_token: test-token\n`;
  const path = join(dir, 'providers.yaml');
  writeFileSync(path, content, 'utf8');
  return path;
}

/** Creates a teams directory structure with a valid team.yaml for the given slug. */
function makeTeamDir(teamsDir: string, slug: string, tid = 'tid-abc-001'): void {
  const teamDir = join(teamsDir, 'teams', slug);
  mkdirSync(join(teamDir, 'agents'), { recursive: true });
  mkdirSync(join(teamDir, 'skills'), { recursive: true });
  writeFileSync(
    join(teamDir, 'team.yaml'),
    stringifyYaml({ tid, leader_aid: 'aid-lead-001' }),
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Fake KeyManager factory
// ---------------------------------------------------------------------------

/**
 * Creates a fake KeyManager for testing.
 *
 * @param locked      - whether the manager is locked
 * @param encryptImpl - optional custom encrypt() implementation
 * @param decryptImpl - optional custom decrypt() implementation
 */
function makeFakeKeyManager(
  locked: boolean,
  encryptImpl: (plain: string) => Promise<string> = async (p) => `enc:${Buffer.from(p).toString('base64')}`,
  decryptImpl: (cipher: string) => Promise<string> = async (c) =>
    Buffer.from(c.slice('enc:'.length), 'base64').toString('utf8'),
): KeyManager {
  return {
    isLocked: () => locked,
    encrypt: encryptImpl,
    decrypt: decryptImpl,
    unlock: async (_key: string) => {},
    lock: () => {},
  };
}

// ---------------------------------------------------------------------------
// loadMaster — reads and caches config
// ---------------------------------------------------------------------------

describe('ConfigLoaderImpl.loadMaster', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = makeTmpDir());
  });

  afterEach(() => cleanup());

  it('reads openhive.yaml and returns a MasterConfig', async () => {
    writeOpenhiveYaml(dir);
    const loader = newConfigLoader(dir);

    const cfg = await loader.loadMaster();

    expect(cfg).toBeDefined();
    expect(cfg.system).toBeDefined();
    expect(cfg.assistant).toBeDefined();
    expect(cfg.channels).toBeDefined();
  });

  it('caches the config after loading', async () => {
    writeOpenhiveYaml(dir);
    const loader = newConfigLoader(dir);

    const cfg1 = await loader.loadMaster();
    const cfg2 = loader.getMaster();

    expect(cfg2).toBe(cfg1);
  });

  it('throws when openhive.yaml does not exist', async () => {
    const loader = newConfigLoader(dir);

    await expect(loader.loadMaster()).rejects.toThrow(/failed to read config file/);
  });
});

// ---------------------------------------------------------------------------
// loadMaster — auto-encryption when keyManager is unlocked
// ---------------------------------------------------------------------------

describe('ConfigLoaderImpl.loadMaster — auto-encrypt plaintext tokens', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = makeTmpDir());
  });

  afterEach(() => cleanup());

  it('encrypts a plaintext discord token when keyManager is unlocked', async () => {
    const cfg = defaultMasterConfig();
    cfg.channels.discord.enabled = true;
    cfg.channels.discord.token = 'my-discord-token';
    writeFileSync(join(dir, 'openhive.yaml'), stringifyYaml(cfg), 'utf8');

    const encryptSpy = vi.fn(async (p: string) => `enc:${Buffer.from(p).toString('base64')}`);
    const km = makeFakeKeyManager(false, encryptSpy);

    const loader = newConfigLoader(dir);
    loader.setKeyManager(km);

    const loaded = await loader.loadMaster();

    expect(encryptSpy).toHaveBeenCalledWith('my-discord-token');
    expect(loaded.channels.discord.token).toMatch(/^enc:/);
  });

  it('encrypts a plaintext whatsapp token when keyManager is unlocked', async () => {
    const cfg = defaultMasterConfig();
    cfg.channels.whatsapp.enabled = true;
    cfg.channels.whatsapp.token = 'my-whatsapp-token';
    writeFileSync(join(dir, 'openhive.yaml'), stringifyYaml(cfg), 'utf8');

    const encryptSpy = vi.fn(async (p: string) => `enc:${Buffer.from(p).toString('base64')}`);
    const km = makeFakeKeyManager(false, encryptSpy);

    const loader = newConfigLoader(dir);
    loader.setKeyManager(km);

    const loaded = await loader.loadMaster();

    expect(encryptSpy).toHaveBeenCalledWith('my-whatsapp-token');
    expect(loaded.channels.whatsapp.token).toMatch(/^enc:/);
  });

  it('does not re-encrypt a token that already has the enc: prefix', async () => {
    const cfg = defaultMasterConfig();
    cfg.channels.discord.enabled = true;
    cfg.channels.discord.token = 'enc:alreadyencrypted';
    writeFileSync(join(dir, 'openhive.yaml'), stringifyYaml(cfg), 'utf8');

    const encryptSpy = vi.fn(async (p: string) => `enc:${Buffer.from(p).toString('base64')}`);
    const km = makeFakeKeyManager(false, encryptSpy);

    const loader = newConfigLoader(dir);
    loader.setKeyManager(km);

    const loaded = await loader.loadMaster();

    // encrypt should not have been called for the already-encrypted token.
    expect(encryptSpy).not.toHaveBeenCalled();
    expect(loaded.channels.discord.token).toBe('enc:alreadyencrypted');
  });

  it('does not encrypt when no token is present', async () => {
    writeOpenhiveYaml(dir); // no tokens set

    const encryptSpy = vi.fn(async (p: string) => `enc:${Buffer.from(p).toString('base64')}`);
    const km = makeFakeKeyManager(false, encryptSpy);

    const loader = newConfigLoader(dir);
    loader.setKeyManager(km);

    await loader.loadMaster();

    expect(encryptSpy).not.toHaveBeenCalled();
  });

  it('proceeds without failing even if encryption throws (warns instead)', async () => {
    const cfg = defaultMasterConfig();
    cfg.channels.discord.enabled = true;
    cfg.channels.discord.token = 'bad-token';
    writeFileSync(join(dir, 'openhive.yaml'), stringifyYaml(cfg), 'utf8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const km = makeFakeKeyManager(false, async () => {
      throw new Error('encrypt failed');
    });

    const loader = newConfigLoader(dir);
    loader.setKeyManager(km);

    // Should not throw — encryption failure is non-fatal.
    const loaded = await loader.loadMaster();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to encrypt discord token'),
      expect.any(String),
    );
    // Token remains plaintext since encryption failed.
    expect(loaded.channels.discord.token).toBe('bad-token');

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// loadMaster — warns about plaintext tokens when keyManager is locked
// ---------------------------------------------------------------------------

describe('ConfigLoaderImpl.loadMaster — plaintext warning when locked', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = makeTmpDir());
  });

  afterEach(() => cleanup());

  it('warns about plaintext discord token when keyManager is locked', async () => {
    const cfg = defaultMasterConfig();
    cfg.channels.discord.enabled = true;
    cfg.channels.discord.token = 'plaintext-discord-token';
    writeFileSync(join(dir, 'openhive.yaml'), stringifyYaml(cfg), 'utf8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const km = makeFakeKeyManager(true);

    const loader = newConfigLoader(dir);
    loader.setKeyManager(km);

    await loader.loadMaster();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('STARTUP WARNING'),
      expect.objectContaining({ channel: 'discord' }),
    );

    warnSpy.mockRestore();
  });

  it('warns about plaintext whatsapp token when keyManager is locked', async () => {
    const cfg = defaultMasterConfig();
    cfg.channels.whatsapp.enabled = true;
    cfg.channels.whatsapp.token = 'plaintext-whatsapp-token';
    writeFileSync(join(dir, 'openhive.yaml'), stringifyYaml(cfg), 'utf8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const km = makeFakeKeyManager(true);

    const loader = newConfigLoader(dir);
    loader.setKeyManager(km);

    await loader.loadMaster();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('STARTUP WARNING'),
      expect.objectContaining({ channel: 'whatsapp' }),
    );

    warnSpy.mockRestore();
  });

  it('does not warn for tokens already encrypted (enc: prefix)', async () => {
    const cfg = defaultMasterConfig();
    cfg.channels.discord.enabled = true;
    cfg.channels.discord.token = 'enc:alreadyencrypted';
    writeFileSync(join(dir, 'openhive.yaml'), stringifyYaml(cfg), 'utf8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const km = makeFakeKeyManager(true);

    const loader = newConfigLoader(dir);
    loader.setKeyManager(km);

    await loader.loadMaster();

    // No STARTUP WARNING should have been emitted.
    const startupWarnings = warnSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('STARTUP WARNING'),
    );
    expect(startupWarnings).toHaveLength(0);

    warnSpy.mockRestore();
  });

  it('does not warn when no tokens are configured', async () => {
    writeOpenhiveYaml(dir); // channels disabled, no tokens

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const km = makeFakeKeyManager(true);

    const loader = newConfigLoader(dir);
    loader.setKeyManager(km);

    await loader.loadMaster();

    const startupWarnings = warnSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('STARTUP WARNING'),
    );
    expect(startupWarnings).toHaveLength(0);

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// saveMaster — validates before writing
// ---------------------------------------------------------------------------

describe('ConfigLoaderImpl.saveMaster', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = makeTmpDir());
  });

  afterEach(() => cleanup());

  it('writes a valid config to openhive.yaml', async () => {
    writeOpenhiveYaml(dir);
    const loader = newConfigLoader(dir);
    await loader.loadMaster();

    const cfg = defaultMasterConfig();
    cfg.assistant.name = 'Test Assistant';

    await loader.saveMaster(cfg);

    // Reload and verify the change persisted.
    const reloaded = await loader.loadMaster();
    expect(reloaded.assistant.name).toBe('Test Assistant');
  });

  it('throws ValidationError for an invalid config (empty listen_address)', async () => {
    writeOpenhiveYaml(dir);
    const loader = newConfigLoader(dir);

    const badCfg = defaultMasterConfig();
    badCfg.system.listen_address = '';

    await expect(loader.saveMaster(badCfg)).rejects.toThrow(/listen_address/);
  });

  it('updates the internal cache after saving', async () => {
    writeOpenhiveYaml(dir);
    const loader = newConfigLoader(dir);
    await loader.loadMaster();

    const cfg = defaultMasterConfig();
    cfg.assistant.name = 'Cached Assistant';

    await loader.saveMaster(cfg);

    const cached = loader.getMaster();
    expect(cached.assistant.name).toBe('Cached Assistant');
  });
});

// ---------------------------------------------------------------------------
// getMaster — returns cached config
// ---------------------------------------------------------------------------

describe('ConfigLoaderImpl.getMaster', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = makeTmpDir());
  });

  afterEach(() => cleanup());

  it('returns the cached config after loadMaster', async () => {
    writeOpenhiveYaml(dir);
    const loader = newConfigLoader(dir);

    const loaded = await loader.loadMaster();
    const cached = loader.getMaster();

    expect(cached).toBe(loaded);
  });

  it('throws when called before loadMaster', () => {
    const loader = newConfigLoader(dir);

    expect(() => loader.getMaster()).toThrow(/not loaded/);
  });
});

// ---------------------------------------------------------------------------
// loadTeam — reads team config by slug
// ---------------------------------------------------------------------------

describe('ConfigLoaderImpl.loadTeam', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = makeTmpDir());
    mkdirSync(join(dir, 'teams'), { recursive: true });
  });

  afterEach(() => cleanup());

  it('reads a team config by slug', async () => {
    makeTeamDir(dir, 'my-team', 'tid-abc-001');
    const loader = newConfigLoader(dir);

    const team = await loader.loadTeam('my-team');

    expect(team.slug).toBe('my-team');
    expect(team.tid).toBe('tid-abc-001');
    expect(team.leader_aid).toBe('aid-lead-001');
  });

  it('throws for an invalid slug', async () => {
    const loader = newConfigLoader(dir);

    await expect(loader.loadTeam('..')).rejects.toThrow();
  });

  it('throws when team.yaml does not exist', async () => {
    // Create directory without team.yaml.
    mkdirSync(join(dir, 'teams', 'no-yaml-team'), { recursive: true });
    const loader = newConfigLoader(dir);

    await expect(loader.loadTeam('no-yaml-team')).rejects.toThrow(/failed to read team config/);
  });

  // ---------------------------------------------------------------------------
  // AC18 Criterion 1 — team starts with .claude/agents/ only, no role_file
  // ---------------------------------------------------------------------------

  it('AC18: loads a team whose agents have no role_file field (description-only agents)', async () => {
    // Create a team config with two agents that have NO role_file field.
    // This verifies that the .claude/agents/<name>.md format is the sole
    // source of agent identity — no role_file is needed in team.yaml.
    const teamData = {
      tid: 'tid-ac18-001',
      leader_aid: 'aid-lead-ac18',
      agents: [
        { aid: 'aid-worker-ac18a', name: 'Worker Alpha' },
        { aid: 'aid-worker-ac18b', name: 'Worker Beta', provider: 'default', model_tier: 'haiku' },
      ],
    };
    const teamDir = join(dir, 'teams', 'ac18-team');
    mkdirSync(join(teamDir, 'agents'), { recursive: true });
    mkdirSync(join(teamDir, 'skills'), { recursive: true });
    writeFileSync(join(teamDir, 'team.yaml'), stringifyYaml(teamData), 'utf8');

    // Write .claude/agents/*.md files in a simulated workspace directory.
    // These are the sole source of agent definitions in the new format.
    const workspaceAgentsDir = join(dir, 'workspace', 'teams', 'ac18-team', '.claude', 'agents');
    mkdirSync(workspaceAgentsDir, { recursive: true });
    writeFileSync(
      join(workspaceAgentsDir, 'worker-alpha.md'),
      `---\nname: Worker Alpha\ndescription: Handles general work tasks\n---\n\nWorker Alpha agent.\n`,
      'utf8',
    );
    writeFileSync(
      join(workspaceAgentsDir, 'worker-beta.md'),
      `---\nname: Worker Beta\ndescription: Handles analysis tasks\nmodel: haiku\n---\n\nWorker Beta agent.\n`,
      'utf8',
    );

    const loader = newConfigLoader(dir);
    const team = await loader.loadTeam('ac18-team');

    // Team loads correctly.
    expect(team.slug).toBe('ac18-team');
    expect(team.tid).toBe('tid-ac18-001');
    expect(team.leader_aid).toBe('aid-lead-ac18');

    // Agents in the team config have NO role_file field.
    expect(team.agents).toHaveLength(2);
    const alpha = team.agents!.find((a) => a.name === 'Worker Alpha');
    const beta = team.agents!.find((a) => a.name === 'Worker Beta');
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();

    // Critical AC18 assertion: no role_file in any agent.
    expect((alpha as Record<string, unknown>)['role_file']).toBeUndefined();
    expect((beta as Record<string, unknown>)['role_file']).toBeUndefined();

    // Agent fields are correct (description-less in config — .md file is the source).
    expect(alpha!.aid).toBe('aid-worker-ac18a');
    expect(beta!.aid).toBe('aid-worker-ac18b');
    expect(beta!.model_tier).toBe('haiku');
  });
});

// ---------------------------------------------------------------------------
// listTeams — returns slugs with valid team.yaml
// ---------------------------------------------------------------------------

describe('ConfigLoaderImpl.listTeams', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = makeTmpDir());
    mkdirSync(join(dir, 'teams'), { recursive: true });
  });

  afterEach(() => cleanup());

  it('returns slugs for team directories with team.yaml', async () => {
    makeTeamDir(dir, 'alpha');
    makeTeamDir(dir, 'beta');
    const loader = newConfigLoader(dir);

    const slugs = await loader.listTeams();

    expect(slugs).toContain('alpha');
    expect(slugs).toContain('beta');
    expect(slugs).toHaveLength(2);
  });

  it('excludes directories without team.yaml', async () => {
    makeTeamDir(dir, 'with-yaml');
    // Create a dir without team.yaml.
    mkdirSync(join(dir, 'teams', 'no-yaml'), { recursive: true });
    const loader = newConfigLoader(dir);

    const slugs = await loader.listTeams();

    expect(slugs).toContain('with-yaml');
    expect(slugs).not.toContain('no-yaml');
  });

  it('excludes entries that are not directories', async () => {
    makeTeamDir(dir, 'real-team');
    // Write a regular file in the teams/ dir.
    writeFileSync(join(dir, 'teams', 'a-file'), 'not a dir', 'utf8');
    const loader = newConfigLoader(dir);

    const slugs = await loader.listTeams();

    expect(slugs).toContain('real-team');
    expect(slugs).not.toContain('a-file');
  });

  it('excludes entries with invalid slug names', async () => {
    makeTeamDir(dir, 'valid-team');
    // Create a directory whose name fails validateSlug (uppercase).
    mkdirSync(join(dir, 'teams', 'INVALID'), { recursive: true });
    writeFileSync(join(dir, 'teams', 'INVALID', 'team.yaml'), 'tid: tid-x\n', 'utf8');
    const loader = newConfigLoader(dir);

    const slugs = await loader.listTeams();

    expect(slugs).toContain('valid-team');
    expect(slugs).not.toContain('INVALID');
  });

  it('returns empty array when teams/ directory does not exist', async () => {
    // Use a dataDir with no teams/ subdirectory.
    const emptyDir = mkdtempSync(join(tmpdir(), 'openhive-no-teams-'));
    try {
      const loader = newConfigLoader(emptyDir);
      const slugs = await loader.listTeams();
      expect(slugs).toEqual([]);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('returns empty array when teams/ directory is empty', async () => {
    const loader = newConfigLoader(dir);
    const slugs = await loader.listTeams();
    expect(slugs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// watchMaster — triggers callback on file change
// ---------------------------------------------------------------------------

describe('ConfigLoaderImpl.watchMaster', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = makeTmpDir());
  });

  afterEach(async () => {
    cleanup();
  });

  it('triggers the callback when openhive.yaml is modified', async () => {
    writeOpenhiveYaml(dir);

    const loader = newConfigLoader(dir);
    const callback = vi.fn();

    await loader.watchMaster(callback);

    // Give chokidar time to register the watch before modifying the file.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    // Modify the file to trigger the watcher.
    const cfg = defaultMasterConfig();
    cfg.assistant.name = 'Modified Assistant';
    writeFileSync(join(dir, 'openhive.yaml'), stringifyYaml(cfg), 'utf8');

    // Wait for chokidar event + debounce.
    await new Promise<void>((resolve) => setTimeout(resolve, 400));

    expect(callback).toHaveBeenCalledTimes(1);
    const calledWith = callback.mock.calls[0]![0] as MasterConfig;
    expect(calledWith.assistant.name).toBe('Modified Assistant');

    loader.stopWatching();
  });
});

// ---------------------------------------------------------------------------
// decryptChannelTokens — decrypts enc:-prefixed tokens
// ---------------------------------------------------------------------------

describe('ConfigLoaderImpl.decryptChannelTokens', () => {
  it('decrypts an enc:-prefixed discord token when keyManager is unlocked', async () => {
    const loader = newConfigLoader('/tmp');
    const km = makeFakeKeyManager(false);
    loader.setKeyManager(km);

    const original: ChannelsConfig = {
      discord: { enabled: true, token: 'enc:' + Buffer.from('real-token').toString('base64') },
      whatsapp: { enabled: false },
    };

    const decrypted = await loader.decryptChannelTokens(original);

    expect(decrypted.discord.token).toBe('real-token');
    expect(decrypted.whatsapp.token).toBeUndefined();
  });

  it('decrypts an enc:-prefixed whatsapp token when keyManager is unlocked', async () => {
    const loader = newConfigLoader('/tmp');
    const km = makeFakeKeyManager(false);
    loader.setKeyManager(km);

    const original: ChannelsConfig = {
      discord: { enabled: false },
      whatsapp: { enabled: true, token: 'enc:' + Buffer.from('wa-secret').toString('base64') },
    };

    const decrypted = await loader.decryptChannelTokens(original);

    expect(decrypted.whatsapp.token).toBe('wa-secret');
  });

  it('returns tokens as-is when keyManager is null', async () => {
    const loader = newConfigLoader('/tmp');
    // No keyManager set.

    const original: ChannelsConfig = {
      discord: { enabled: true, token: 'enc:shouldnotdecrypt' },
      whatsapp: { enabled: false },
    };

    const result = await loader.decryptChannelTokens(original);

    expect(result.discord.token).toBe('enc:shouldnotdecrypt');
  });

  it('returns tokens as-is when keyManager is locked', async () => {
    const loader = newConfigLoader('/tmp');
    const km = makeFakeKeyManager(true);
    loader.setKeyManager(km);

    const original: ChannelsConfig = {
      discord: { enabled: true, token: 'enc:stillencrypted' },
      whatsapp: { enabled: false },
    };

    const result = await loader.decryptChannelTokens(original);

    expect(result.discord.token).toBe('enc:stillencrypted');
  });

  it('does not decrypt tokens without enc: prefix', async () => {
    const loader = newConfigLoader('/tmp');
    const decryptSpy = vi.fn(async (c: string) => Buffer.from(c.slice(4), 'base64').toString());
    const km = makeFakeKeyManager(false, async (p) => `enc:${p}`, decryptSpy);
    loader.setKeyManager(km);

    const original: ChannelsConfig = {
      discord: { enabled: true, token: 'plaintext-token' },
      whatsapp: { enabled: false },
    };

    const result = await loader.decryptChannelTokens(original);

    expect(decryptSpy).not.toHaveBeenCalled();
    expect(result.discord.token).toBe('plaintext-token');
  });

  it('does not mutate the original ChannelsConfig', async () => {
    const loader = newConfigLoader('/tmp');
    const km = makeFakeKeyManager(false);
    loader.setKeyManager(km);

    const original: ChannelsConfig = {
      discord: { enabled: true, token: 'enc:' + Buffer.from('secret').toString('base64') },
      whatsapp: { enabled: false },
    };

    await loader.decryptChannelTokens(original);

    // Original must remain unchanged.
    expect(original.discord.token).toBe('enc:' + Buffer.from('secret').toString('base64'));
  });

  it('throws when decryption fails', async () => {
    const loader = newConfigLoader('/tmp');
    const km = makeFakeKeyManager(false, async (p) => `enc:${p}`, async () => {
      throw new Error('decryption auth tag mismatch');
    });
    loader.setKeyManager(km);

    const original: ChannelsConfig = {
      discord: { enabled: true, token: 'enc:corruptedtoken' },
      whatsapp: { enabled: false },
    };

    await expect(loader.decryptChannelTokens(original)).rejects.toThrow(
      /failed to decrypt discord token/,
    );
  });
});

// ---------------------------------------------------------------------------
// stopWatching — closes all watchers
// ---------------------------------------------------------------------------

describe('ConfigLoaderImpl.stopWatching', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = makeTmpDir());
  });

  afterEach(() => cleanup());

  it('does not throw when no watcher has been started', () => {
    const loader = newConfigLoader(dir);
    expect(() => loader.stopWatching()).not.toThrow();
  });

  it('sets the internal watcher to null after stopping', async () => {
    writeOpenhiveYaml(dir);
    const loader = newConfigLoader(dir);
    await loader.watchMaster(() => {});

    // Access private field to verify the watcher was created.
    const internal = loader as unknown as { watcher: unknown };
    expect(internal.watcher).not.toBeNull();

    loader.stopWatching();

    expect(internal.watcher).toBeNull();
  });

  it('is safe to call multiple times', async () => {
    writeOpenhiveYaml(dir);
    const loader = newConfigLoader(dir);
    await loader.watchMaster(() => {});

    loader.stopWatching();
    expect(() => loader.stopWatching()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// newConfigLoader factory
// ---------------------------------------------------------------------------

describe('newConfigLoader', () => {
  it('defaults dataDir to "data" when empty', () => {
    const loader = newConfigLoader('');
    const internal = loader as unknown as { dataDir: string };
    expect(internal.dataDir).toBe('data');
  });

  it('defaults teamsDir to dataDir when not provided', () => {
    const loader = newConfigLoader('/my/data');
    const internal = loader as unknown as { dataDir: string; teamsDir: string };
    expect(internal.teamsDir).toBe('/my/data');
  });

  it('uses the provided teamsDir when given', () => {
    const loader = newConfigLoader('/data', '/teams');
    const internal = loader as unknown as { teamsDir: string };
    expect(internal.teamsDir).toBe('/teams');
  });
});
